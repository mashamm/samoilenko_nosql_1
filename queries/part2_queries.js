// queries/part2_queries.js
// Запуск: mongosh "ВАШ_URI" --file queries/part2_queries.js

db = db.getSiblingDB("spotify");

function header(title) {
  print("\n" + "=".repeat(70));
  print(title);
  print("=".repeat(70));
}

// Топ-N унікальних треків за фільтром. Один трек (track_id) часто
// дублюється в кількох жанрах, тому групуємо і збираємо жанри в масив.
function topUniqueTracks(filter, featureFields, n) {
  const features = {};
  featureFields.forEach(f => (features[f] = { $first: "$audio_features." + f }));
  return db.tracks.aggregate([
    { $match: filter },
    {
      $group: {
        _id: "$track_id",
        track_name: { $first: "$track_name" },
        artists: { $first: "$artists" },
        popularity: { $max: "$popularity" },
        duration_sec: { $first: "$duration_sec" },
        explicit: { $first: "$explicit" },
        genres: { $addToSet: "$track_genre" },
        ...features
      }
    },
    { $sort: { popularity: -1, _id: 1 } },
    { $limit: n }
  ]).toArray();
}

// ======================================================================
// Завдання 1. Треки для вечірки
// danceability > 0.7, energy > 0.7, тривалість 3–5 хв (180000–300000 мс)
// ======================================================================
header("Завдання 1. Треки для вечірки");

const partyFilter = {
  "audio_features.danceability": { $gt: 0.7 },
  "audio_features.energy": { $gt: 0.7 },
  duration_ms: { $gte: 180000, $lte: 300000 }
};

print("Знайдено документів: " + db.tracks.countDocuments(partyFilter));
// Один і той самий трек (track_id) може стояти в кількох жанрах,
// тому окремо рахуємо унікальні треки
print("З них унікальних треків (track_id): " + db.tracks.distinct("track_id", partyFilter).length);
print("Топ-10 унікальних треків за популярністю:");

topUniqueTracks(partyFilter, ["danceability", "energy"], 10).forEach(d => printjson(d));

// ======================================================================
// Завдання 2. Виконавці, у яких усі треки популярні
// >= 3 треки і мінімальна популярність >= 60. Топ-20.
// ======================================================================
header("Завдання 2. Виконавці, у яких усі треки популярні");

db.tracks.aggregate([
  // кожен виконавець треку — окремий документ
  { $unwind: "$artists" },
  // прибираємо дублі: один трек у кількох жанрах рахуємо один раз
  {
    $group: {
      _id: { artist: "$artists", track_id: "$track_id" },
      popularity: { $max: "$popularity" }
    }
  },
  // статистика по виконавцю
  {
    $group: {
      _id: "$_id.artist",
      track_count: { $sum: 1 },
      min_popularity: { $min: "$popularity" },
      avg_popularity: { $avg: "$popularity" }
    }
  },
  { $match: { track_count: { $gte: 3 }, min_popularity: { $gte: 60 } } },
  { $sort: { avg_popularity: -1, track_count: -1 } },
  { $limit: 20 },
  {
    $project: {
      _id: 0,
      artist: "$_id",
      track_count: "$track_count",
      min_popularity: { $round: ["$min_popularity", 1] },
      avg_popularity: { $round: ["$avg_popularity", 1] }
    }
  }
]).forEach(printjson);

// ======================================================================
// Завдання 3. Нетипові треки
// tempo треку > avg(tempo жанру) + 2 * stdDevPop(tempo жанру)
// ======================================================================
header("Завдання 3. Нетипові треки (незвично високий темп для жанру)");

const outliers = db.tracks.aggregate([
  // 1) статистика темпу по жанру + список треків жанру
  {
    $group: {
      _id: "$track_genre",
      avg_tempo: { $avg: "$audio_features.tempo" },
      std_tempo: { $stdDevPop: "$audio_features.tempo" },
      tracks: {
        $push: {
          _id: "$_id",
          track_name: "$track_name",
          popularity: "$popularity",
          artists: "$artists",
          audio_features: { tempo: "$audio_features.tempo" }
        }
      }
    }
  },
  // 2) поріг для нетипових треків
  {
    $addFields: {
      outlier_threshold: { $add: ["$avg_tempo", { $multiply: [2, "$std_tempo"] }] }
    }
  },
  // 3) залишаємо лише треки з темпом вище порогу, найшвидші — першими
  {
    $project: {
      _id: 0,
      genre: "$_id",
      avg_tempo: { $round: ["$avg_tempo", 1] },
      outlier_threshold: { $round: ["$outlier_threshold", 1] },
      outlier_tracks: {
        $sortArray: {
          input: {
            $filter: {
              input: "$tracks",
              as: "t",
              cond: { $gt: ["$$t.audio_features.tempo", "$outlier_threshold"] }
            }
          },
          sortBy: { "audio_features.tempo": -1 }
        }
      }
    }
  },
  // жанри без нетипових треків не показуємо
  { $match: { "outlier_tracks.0": { $exists: true } } },
  { $sort: { genre: 1 } }
]).toArray();

const totalOutliers = outliers.reduce((s, g) => s + g.outlier_tracks.length, 0);
print("Жанрів з нетиповими треками: " + outliers.length);
print("Усього нетипових треків: " + totalOutliers);
print("Коротко по жанрах (genre: avg_tempo / threshold / кількість):");
outliers.forEach(g =>
  print(`  ${g.genre}: ${g.avg_tempo} / ${g.outlier_threshold} / ${g.outlier_tracks.length}`)
);
print("\nПовний документ для першого жанру:");
printjson(outliers[0]);

// ======================================================================
// Завдання 4. Треки для фонової роботи
// loudness < -10, speechiness < 0.1, instrumentalness > 0.5, без explicit
// ======================================================================
header("Завдання 4. Треки для фонової роботи");

const workFilter = {
  "audio_features.loudness": { $lt: -10 },
  "audio_features.speechiness": { $lt: 0.1 },
  "audio_features.instrumentalness": { $gt: 0.5 },
  explicit: false
};

print("Знайдено документів: " + db.tracks.countDocuments(workFilter));
print("З них унікальних треків (track_id): " + db.tracks.distinct("track_id", workFilter).length);
print("Топ-10 унікальних треків за популярністю:");

topUniqueTracks(workFilter, ["loudness", "speechiness", "instrumentalness"], 10).forEach(d => printjson(d));
