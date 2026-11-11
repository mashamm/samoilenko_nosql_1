# NoSQL HW 1 — Spotify Tracks у MongoDB Atlas

Дані: [Spotify Tracks Dataset](https://www.kaggle.com/datasets/maharshipandya/-spotify-tracks-dataset) (~114 тис. треків, 114 жанрів).

## Структура репозиторію

```text
.
├── scripts/
│   ├── 01_load_data.py      # Ч.1.1 — Kaggle → pandas → колекція tracks_raw
│   └── 02_transform.js      # Ч.1.2 — aggregation pipeline tracks_raw → tracks
├── queries/
│   └── part2_queries.js     # Ч.2 — чотири запити
├── part3_indexes.js         # Ч.3 — explain() до/після, індекси, covered query
├── screenshots/             # скріншоти Atlas / термінала
├── requirements.txt
├── .env.example
└── README.md
```

## 1. Налаштування оточення

**Вимоги:** Python 3.11+, [mongosh](https://www.mongodb.com/try/download/shell), кластер MongoDB Atlas (вистачить безкоштовного M0).

1. **Atlas:** створити кластер M0 (AWS, найближчий регіон) → *Database Access*: додати користувача з паролем → *Network Access*: додати свій IP → *Connect → Drivers*: скопіювати рядок `mongodb+srv://...`.
2. **Залежності:**
   ```bash
   python -m venv .venv
   source .venv/bin/activate          # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. **`.env`:**
   ```bash
   cp .env.example .env
   # вписати свій MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/
   ```
4. **Kaggle:** покласти `kaggle.json` у `~/.kaggle/` (`chmod 600 ~/.kaggle/kaggle.json`). Інший варіант: вручну покласти `dataset.csv` у `data/`, тоді скрипт нічого не скачує.
5. **Запуск по черзі:**
   ```bash
   python scripts/01_load_data.py                              # tracks_raw: 113 999 док.
   mongosh "$MONGO_URI" --file scripts/02_transform.js         # tracks:     113 999 док.
   mongosh "$MONGO_URI" --file queries/part2_queries.js
   mongosh "$MONGO_URI" --file part3_indexes.js
   ```
   (`$MONGO_URI` має бути в оточенні: `export $(cat .env | xargs)`; або просто вставити рядок у лапках.)

Усі скрипти можна запускати повторно. `01_load_data.py` і `02_transform.js` перед записом видаляють свою колекцію, а `part3_indexes.js` на початку видаляє індекси, тож план «до» завжди знімається без них.

## 2. Схема даних

### `tracks_raw` (сирі дані, пласка структура як у CSV)

На етапі завантаження я привела типи (`explicit` → bool, `popularity`/`duration_ms`/`key`/`mode`/`time_signature` → int, аудіохарактеристики → float), прибрала службову колонку індексу `Unnamed: 0` і відкинула **1 запис** без виконавця та назви. Лишилося 113 999 документів.

### `tracks` (після трансформації)

```json
{
  "_id": { "$oid": "..." },
  "track_id": "5SuOikwiRyPMVoIQDJUgSV",
  "track_name": "Comedy",
  "album_name": "Comedy",
  "artists": ["Gen Hoshino"],
  "explicit": false,
  "popularity": 73,
  "popularity_tier": "high",
  "duration_ms": 230666,
  "duration_sec": 230.7,
  "track_genre": "acoustic",
  "audio_features": {
    "danceability": 0.676, "energy": 0.461, "loudness": -6.746,
    "speechiness": 0.143, "acousticness": 0.0322, "instrumentalness": 0.00000101,
    "liveness": 0.358, "valence": 0.715, "tempo": 87.917,
    "key": 1, "mode": 0, "time_signature": 4
  }
}
```

| Поле | Тип | Опис |
|---|---|---|
| `track_id` | string | Spotify ID. **Не унікальний:** один трек може бути в кількох жанрах (113 999 документів, але лише 89 740 унікальних `track_id`) |
| `artists` | array<string> | виконавці (рядок `"A;B"` розбитий по `;`, пробіли обрізані) |
| `audio_features` | object | 12 аудіохарактеристик |
| `duration_sec` | double | `duration_ms / 1000`, округлено до 0.1 |
| `popularity_tier` | string | `high` (≥70): 5 472 · `medium` (40–69): 43 115 · `low` (<40): 65 412 |

### Теоретичні питання частини 1

**Чому аудіохарактеристики винесені в окремий об’єкт `audio_features`?**

Ці 12 полів описують звук треку, а не його метадані (назву, альбом, популярність). Коли вони лежать в одному об’єкті, документ легше читати: одразу видно, де «паспорт» треку, а де його аудіопрофіль. Практичні плюси:

- **Проєкція одним полем.** `{audio_features: 1}` повертає весь профіль, а `{audio_features: 0}` прибирає його зі списку треків. Без вкладення довелося б перелічувати 12 полів.
- **Об’єкт можна передати далі як є.** Наприклад, віддати `audio_features` у ML-модель або в API-відповідь без перекладання полів.
- **Схему простіше розширювати.** Нова характеристика додається всередину об’єкта, і коренева схема не змінюється.

Коли вкладення шкодить:

- Шляхи довшають: `"audio_features.danceability"` у кожному фільтрі та індексі (див. запити в ч.2 та індекси в ч.3).
- Порівнювати весь об’єкт на рівність (`{audio_features: {...}}`) ризиковано: збіг враховує порядок полів. Фільтрувати треба по окремих полях через крапку.
- Вкладення погано підходить, якщо вкладена частина росте без меж (наприклад, масив усіх прослуховувань), її оновлюють окремо від решти документа або вона потрібна іншим колекціям. Тоді краще винести її в окрему колекцію. Для `audio_features` це не так: 12 полів фіксованого розміру, які читаються разом із треком, тому вкладення тут доречне.

**Чому виконавці зберігаються як масив, а не як рядок?**

Рядок `"Drake;Future"` для MongoDB лише текст, а масив `["Drake", "Future"]` складається з окремих значень, з якими працюють оператори масивів. Приклад на наших даних:

- `db.tracks.find({artists: "Drake"})` знаходить **50** треків Drake, включно з колаборацями: для масиву збіг шукається серед будь-яких його елементів.
- На сирих даних точний збіг `{artists: "Drake"}` дає лише **1** документ (там, де Drake єдиний виконавець), а регулярний вираз `/Drake/` дає **66**, бо зачіпає ще й **Nick Drake** (12) та **Ashley Drake** (4). До того ж regex без префікса не може використати індекс.

Що стає простіше:

- пошук за одним виконавцем: `{artists: "X"}`, кількома: `{artists: {$in: [...]}}` або `{artists: {$all: [...]}}`;
- колаборації: `{"artists.1": {$exists: true}}` або `{artists: {$size: 2}}` (30 075 треків мають більше одного виконавця);
- агрегації по виконавцях через `$unwind: "$artists"` (на цьому побудоване завдання 2 ч.2);
- multikey-індекс `{artists: 1}`, в якому кожен виконавець — окремий ключ.

## 3. Частина 2 — запити

Файл: [`queries/part2_queries.js`](queries/part2_queries.js). Нижче цифри з мого запуску.

**Важливе спостереження про дані:** близько 24 тис. документів дублюють уже наявний `track_id` під іншим жанром (наприклад, *One Kiss* (Calvin Harris, Dua Lipa) записаний у 5 жанрах: `pop`, `dance`, `house`, `electro`, `progressive-house`). Для 720 таких треків `popularity` у різних жанрах навіть відрізняється. Тому там, де йдеться про «треки» (а не про «документи»), я групую за `track_id`.

### Завдання 1. Треки для вечірки

```js
{ "audio_features.danceability": { $gt: 0.7 },
  "audio_features.energy":       { $gt: 0.7 },
  duration_ms: { $gte: 180000, $lte: 300000 } }
```

- Документів: **7 311**, унікальних треків: **5 328**.
- Топ за популярністю: *Calm Down* (Rema, Selena Gomez) 92 · *LOKERA* (Rauw Alejandro, Lyanno, Brray) 91 · *Party* (Bad Bunny, Rauw Alejandro) 90 · *About Damn Time* (Lizzo) 89 · *One Kiss* (Calvin Harris, Dua Lipa) 89 …
- Межі 3 і 5 хв включні (`$gte`/`$lte`), умови «вище 0.7» строгі (`$gt`).
- Топ-10 виводжу через `$group` за `track_id` (жанри збираються в масив `genres`). Простий `find().sort().limit()` показував той самий трек 2–3 рази, по разу на кожен жанр.

### Завдання 2. Виконавці, у яких усі треки популярні

Пайплайн: `$unwind artists` → `$group {artist, track_id}` (прибираю дублі між жанрами) → `$group artist` (`$sum`, `$min`, `$avg`) → `$match {track_count ≥ 3, min_popularity ≥ 60}` → `$sort avg desc` → `$limit 20` → `$round 1`.

| # | artist | track_count | min_popularity | avg_popularity |
|---|---|---|---|---|
| 1 | Harry Styles | 3 | 89 | 92 |
| 2 | Olivia Rodrigo | 5 | 86 | 87.4 |
| 3 | IVE | 3 | 79 | 84 |
| 4 | Morgan Wallen | 3 | 81 | 83.3 |
| 5 | One Direction | 5 | 80 | 83 |
| 6 | Lil Nas X | 8 | 77 | 82.8 |
| 7 | Måneskin | 5 | 76 | 82.6 |
| … | | | | |

Без дедуплікації один трек у трьох жанрах рахувався б як три. Тоді виконавець з одним хітом формально проходив би умову «≥ 3 треки», і результат був би неправильний.

### Завдання 3. Нетипові треки (темп)

Пайплайн: `$group` за жанром (`$avg`, `$stdDevPop` темпу + `$push` треків) → `$addFields outlier_threshold = avg + 2·std` → `$filter` треків з `tempo > threshold` → прибираю жанри без нетипових треків.

- Нетипові треки є у **112 з 114** жанрів, усього **3 506**.
- Перевірка: для `acoustic` отримала `avg_tempo: 119`, `outlier_threshold: 178.5`, як у прикладі з умови.
- Спостереження: у датасеті 157 треків з `tempo = 0` (темп не визначено, часто це white noise чи аудіокниги). Вони занижують середнє й роздувають стандартне відхилення. Я їх не відкидала, бо умова задає алгоритм явно, але в реальному аналізі їх варто прибрати перед підрахунком.

### Завдання 4. Треки для фонової роботи

```js
{ "audio_features.loudness":         { $lt: -10 },
  "audio_features.speechiness":      { $lt: 0.1 },
  "audio_features.instrumentalness": { $gt: 0.5 },
  explicit: false }
```

- Документів: **9 324**, унікальних треків: **8 311**.
- Топ за популярністю: *everything i wanted* (Billie Eilish) 86, *Clean White Noise* 85 …

## 4. Частина 3 — індекси (факультативно)

Файл: [`part3_indexes.js`](part3_indexes.js). Скрипт сам друкує ключові поля `explain("executionStats")`. Нижче мій вивід.

> 📸 *Додайте скріншоти з Atlas (Collections → Explain Plan / Indexes) або термінала в `screenshots/`.*

### 3.1. `track_genre: "pop"` + `danceability ≥ 0.7`, сортування `popularity: -1`

Індекс за правилом **ESR** (Equality → Sort → Range):

```js
db.tracks.createIndex({ track_genre: 1, popularity: -1, "audio_features.danceability": 1 })
```

| explain() | до індексу | після (ESR) | для порівняння: E-R-S |
|---|---|---|---|
| winningPlan | `SORT ← COLLSCAN` | `FETCH ← IXSCAN` | `FETCH ← SORT ← IXSCAN` |
| індекс | — | `genre_popularity_danceability` | `genre_danceability_popularity` |
| nReturned | 354 | 354 | 354 |
| totalKeysExamined | 0 | 412 | 354 |
| totalDocsExamined | **113 999** | **354** | 354 |
| executionTimeMillis | 38 | 1 | 1 |

**Що змінилося:** без індексу MongoDB читає всі 113 999 документів (`COLLSCAN`), а потім сортує 354 знайдені в пам’яті (`SORT`). З індексом сервер одразу переходить до ключів `track_genre = "pop"`, читає їх уже в порядку `popularity` (стадії `SORT` немає) і перевіряє `danceability` прямо в ключі індексу. Документи підтягуються (`FETCH`) лише для тих 354, що підходять.

**Як зрозуміти, що індекс використовується:**
- у `winningPlan` є стадія `IXSCAN` з `indexName: "genre_popularity_danceability"`, а `COLLSCAN` зник;
- `indexBounds`: `track_genre: ["pop","pop"]`, `danceability: [0.7, inf]`;
- `totalDocsExamined` (354) дорівнює `nReturned` (354), тобто зайвих документів не читали;
- у плані немає стадії `SORT`, сортування дає сам індекс.

**Чому ESR, а не E-R-S:** індекс `{genre, danceability, popularity}` теж працює і навіть сканує менше ключів (354 проти 412), але повертає записи відсортованими за `danceability`, тож з’являється `SORT` у пам’яті. На 354 документах різниці не видно, але на великій вибірці сортування в пам’яті впирається в ліміт 100 МБ, а з `limit()` порядок ESR дозволяє зупинитися після перших N ключів.

### 3.2. Індекс для «музики для роботи»

```js
db.tracks.createIndex({ explicit: 1, "audio_features.instrumentalness": 1, "audio_features.speechiness": 1 })
```

Порядок полів: `explicit` перевіряється на точний збіг, тому стоїть першим. Далі йдуть два діапазони, і першим я поставила більш селективний: `instrumentalness > 0.5` лишає 18 850 документів, а `speechiness < 0.1` аж 90 814.

| explain() | до | після |
|---|---|---|
| winningPlan | `COLLSCAN` | `FETCH ← IXSCAN(explicit_instrumentalness_speechiness)` |
| indexBounds | — | `explicit: [false,false]`, `instrumentalness: (0.5, inf]`, `speechiness: [-inf, 0.1)` |
| nReturned | 16 141 | 16 141 |
| totalKeysExamined | 0 | 16 602 |
| totalDocsExamined | 113 999 | 16 141 |
| executionTimeMillis | 38 | 12 |

Той самий індекс використовується й для запиту із завдання 4 ч.2 (з `loudness < -10`): `IXSCAN` звужує вибірку до 16 141 документа, а `loudness` перевіряється як фільтр на стадії `FETCH` (повертається 9 324).

### 3.3. Чи є запит покривним (covered query)?

```js
db.tracks.find({ track_genre: "pop", popularity: { $gte: 70 } })
```

**Ні, не є.** Запит покривний, якщо всі поля фільтра **і всі поля, які повертаються,** є в індексі, і MongoDB взагалі не читає документи.

- Фільтр покривається: `track_genre` і `popularity` — це перші два поля індексу `{track_genre, popularity, danceability}` (префікс), тож пошук іде через `IXSCAN` з межами `genre: ["pop","pop"]`, `popularity: [inf, 70]`.
- **Але проєкції немає**, тому запит повертає документи повністю: `track_name`, `artists`, `audio_features` тощо, а ще `_id`, якого немає в індексі. Щоб їх віддати, MongoDB мусить прочитати кожен документ.

Це видно з explain(): `FETCH ← IXSCAN`, `totalDocsExamined: 317 = nReturned`.

Щоб запит став покривним, проєкція має містити лише поля індексу і явно виключати `_id`:

```js
db.tracks.find({ track_genre: "pop", popularity: { $gte: 70 } },
               { _id: 0, track_genre: 1, popularity: 1 })
```

explain() тоді показує `PROJECTION_COVERED ← IXSCAN` і **`totalDocsExamined: 0`**. Можна додати в проєкцію й `audio_features.danceability`: це поле теж в індексі і не є масивом. Для полів-масивів (наприклад, `artists`) покривний запит неможливий, бо такий індекс multikey.

## 5. Висновки

> ✏️ *Додайте 3–5 речень своїх висновків: що здивувало в даних, що було найскладніше, що б ви зробили інакше.*
