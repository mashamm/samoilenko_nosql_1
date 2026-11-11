// part3_indexes.js
// Запуск: mongosh "ВАШ_URI" --file part3_indexes.js
//
// Скрипт ідемпотентний: на початку видаляє всі індекси tracks (крім _id),
// тож план "до" завжди знімається на колекції без індексів.

db = db.getSiblingDB("spotify");

function header(title) {
  print("\n" + "=".repeat(70));
  print(title);
  print("=".repeat(70));
}

// Ланцюжок стадій плану від кореня до листа: "FETCH <- IXSCAN"
function stageChain(stage) {
  const parts = [];
  while (stage) {
    let label = stage.stage;
    if (stage.indexName) label += `(${stage.indexName})`;
    parts.push(label);
    stage = stage.inputStage || (stage.inputStages && stage.inputStages[0]);
  }
  return parts.join(" <- ");
}

// Шукає в плані стадію IXSCAN і повертає її межі (indexBounds)
function findIxscan(stage) {
  while (stage) {
    if (stage.stage === "IXSCAN") return stage;
    stage = stage.inputStage || (stage.inputStages && stage.inputStages[0]);
  }
  return null;
}

// Ключові поля explain("executionStats") в одному блоці
function summarize(label, explainResult) {
  const plan = explainResult.queryPlanner.winningPlan;
  // у MongoDB 7+ з Slot Based Engine план лежить у queryPlan
  const root = plan.queryPlan || plan;
  const stats = explainResult.executionStats;
  const ix = findIxscan(root);
  print(`\n--- ${label} ---`);
  print("winningPlan:          " + stageChain(root));
  print("індекс:               " + (ix ? ix.indexName : "— (COLLSCAN)"));
  if (ix) print("indexBounds:          " + JSON.stringify(ix.indexBounds));
  print("nReturned:            " + stats.nReturned);
  print("totalKeysExamined:    " + stats.totalKeysExamined);
  print("totalDocsExamined:    " + stats.totalDocsExamined);
  print("executionTimeMillis:  " + stats.executionTimeMillis);
  print("rejectedPlans:        " + explainResult.queryPlanner.rejectedPlans.length);
}

db.tracks.dropIndexes();
print("Індекси перед стартом: " + JSON.stringify(db.tracks.getIndexes().map(i => i.name)));

// ======================================================================
// Завдання 1. Аналіз запиту та індексація
// ======================================================================
header("Завдання 1. pop + danceability >= 0.7, сортування за popularity");

const q1 = {
  track_genre: "pop",
  "audio_features.danceability": { $gte: 0.7 }
};
const sort1 = { popularity: -1 };

// 1) explain без індексу
summarize("ДО індексу", db.tracks.find(q1).sort(sort1).explain("executionStats"));

// 2) Індекс за правилом ESR (Equality → Sort → Range):
//    track_genre  — точний збіг (E)
//    popularity   — поле сортування (S), напрям як у sort
//    danceability — діапазон (R)
// Завдяки такому порядку MongoDB читає ключі вже відсортованими
// і не робить сортування в пам'яті (стадії SORT у плані немає).
db.tracks.createIndex(
  { track_genre: 1, popularity: -1, "audio_features.danceability": 1 },
  { name: "genre_popularity_danceability" }
);

// 3) explain після індексу
summarize("ПІСЛЯ індексу (ESR)", db.tracks.find(q1).sort(sort1).explain("executionStats"));

// Для порівняння: "інтуїтивний" порядок E → R → S. Індекс теж використовується,
// але з'являється стадія SORT у пам'яті. hint() змушує взяти саме цей індекс.
db.tracks.createIndex(
  { track_genre: 1, "audio_features.danceability": 1, popularity: -1 },
  { name: "genre_danceability_popularity" }
);
summarize(
  "Для порівняння: індекс E-R-S (hint)",
  db.tracks.find(q1).sort(sort1).hint("genre_danceability_popularity").explain("executionStats")
);
db.tracks.dropIndex("genre_danceability_popularity");

print("\nКількість результатів запиту: " + db.tracks.find(q1).sort(sort1).toArray().length);

// ======================================================================
// Завдання 2. Індекс для пошуку музики для роботи
// ======================================================================
header("Завдання 2. instrumentalness + speechiness + explicit");

const q2 = {
  "audio_features.instrumentalness": { $gt: 0.5 },
  "audio_features.speechiness": { $lt: 0.1 },
  explicit: false
};

summarize("ДО індексу", db.tracks.find(q2).explain("executionStats"));

// explicit — точний збіг, тому стоїть першим (E).
// Далі два діапазони (R). Першим ставимо більш селективний:
// instrumentalness > 0.5 відсікає значно більше документів, ніж speechiness < 0.1
// (кількості виводяться нижче), тож меж для сканування індексу менше.
print("\nСелективність: instrumentalness > 0.5 → " +
  db.tracks.countDocuments({ "audio_features.instrumentalness": { $gt: 0.5 } }) +
  " док., speechiness < 0.1 → " +
  db.tracks.countDocuments({ "audio_features.speechiness": { $lt: 0.1 } }) + " док.");

db.tracks.createIndex(
  { explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 },
  { name: "explicit_instrumentalness_speechiness" }
);

summarize("ПІСЛЯ індексу", db.tracks.find(q2).explain("executionStats"));

// Той самий індекс працює і для повного запиту із завдання 4 частини 2
// (loudness перевіряється вже після FETCH як фільтр)
summarize(
  "ПІСЛЯ індексу — запит із ч.2 завд.4 (+ loudness < -10)",
  db.tracks.find({ ...q2, "audio_features.loudness": { $lt: -10 } }).explain("executionStats")
);

// ======================================================================
// Завдання 3. Покривний запит (covered query)
// ======================================================================
header("Завдання 3. Чи є запит покривним?");

const q3 = { track_genre: "pop", popularity: { $gte: 70 } };

// Як дано в умові — без проєкції: повертаються цілі документи
summarize("Запит як в умові (без проєкції)", db.tracks.find(q3).explain("executionStats"));

// Варіант, який стає покривним: повертаємо лише поля з індексу і прибираємо _id
summarize(
  "З проєкцією { _id: 0, track_genre: 1, popularity: 1 }",
  db.tracks.find(q3, { _id: 0, track_genre: 1, popularity: 1 }).explain("executionStats")
);

print("\nІндекси наприкінці: " + JSON.stringify(db.tracks.getIndexes().map(i => i.name)));
