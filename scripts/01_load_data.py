"""
Частина 1.1 — завантаження Spotify Tracks Dataset у MongoDB (колекція tracks_raw).

Запуск (з кореня проєкту):
    python scripts/01_load_data.py

Якщо файл data/dataset.csv уже є — скачування з Kaggle пропускається.
Інакше потрібен ~/.kaggle/kaggle.json (або змінні KAGGLE_USERNAME / KAGGLE_KEY).
"""

import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from pymongo import MongoClient
from tqdm import tqdm

KAGGLE_DATASET = "maharshipandya/-spotify-tracks-dataset"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CSV_PATH = DATA_DIR / "dataset.csv"
DB_NAME = "spotify"
BATCH_SIZE = 5000


def download_dataset() -> None:
    """Скачує CSV з Kaggle, якщо локальної копії ще немає."""
    if CSV_PATH.exists():
        print(f"Використовую локальний файл {CSV_PATH}")
        return
    # імпорт усередині функції: kaggle автентифікується одразу при імпорті
    from kaggle.api.kaggle_api_extended import KaggleApi

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    api = KaggleApi()
    api.authenticate()
    print(f"Завантажую {KAGGLE_DATASET} з Kaggle...")
    api.dataset_download_files(KAGGLE_DATASET, path=str(DATA_DIR), unzip=True)


load_dotenv()
mongo_uri = os.getenv("MONGO_URI")
if not mongo_uri:
    raise SystemExit("MONGO_URI не задано — створіть .env за зразком .env.example")

client = MongoClient(mongo_uri)
db = client[DB_NAME]

download_dataset()
df = pd.read_csv(CSV_PATH)

# Перша колонка CSV — це збережений індекс pandas ("Unnamed: 0"), вона не потрібна
df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed")])

# Скрипт має бути ідемпотентним: при повторному запуску не дублюємо дані
db["tracks_raw"].drop()

# Булеві значення
df["explicit"] = df["explicit"].astype(bool)

# Цілі числа
int_cols = ["popularity", "duration_ms", "key", "mode", "time_signature"]
for col in int_cols:
    df[col] = df[col].astype(int)

# Числа з плаваючою точкою
float_cols = [
    "danceability", "energy", "loudness", "speechiness",
    "acousticness", "instrumentalness", "liveness",
    "valence", "tempo",
]
for col in float_cols:
    df[col] = df[col].astype(float)

# Прибираємо записи, в яких немає виконавця або назви треку
query = df["artists"].isna() | df["track_name"].isna()
print(f"Відкинуто записів без виконавця/назви: {int(query.sum())}")
records = df[~query].to_dict("records")

# Завантажуємо батчами — вставка 114k документів однією операцією може впасти по пам'яті
for i in tqdm(range(0, len(records), BATCH_SIZE)):
    db["tracks_raw"].insert_many(records[i : i + BATCH_SIZE])

print(f"Завантажено документів: {db['tracks_raw'].count_documents({})}")
print("Приклад документа:")
print(db["tracks_raw"].find_one())
