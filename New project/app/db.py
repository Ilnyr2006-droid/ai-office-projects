from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.config import settings


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER NOT NULL,
    price INTEGER NOT NULL,
    mileage INTEGER NOT NULL DEFAULT 0,
    fuel_type TEXT NOT NULL,
    transmission TEXT NOT NULL,
    body_type TEXT NOT NULL,
    color TEXT NOT NULL,
    description TEXT NOT NULL,
    image_url TEXT,
    is_available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    message TEXT,
    inquiry_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (car_id) REFERENCES cars(id)
);

CREATE TRIGGER IF NOT EXISTS cars_updated_at
AFTER UPDATE ON cars
FOR EACH ROW
BEGIN
    UPDATE cars SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
"""


SEED_CARS: tuple[tuple[object, ...], ...] = (
    (
        "Toyota",
        "Camry",
        2021,
        2490000,
        42000,
        "petrol",
        "automatic",
        "sedan",
        "white",
        "Надежный седан с прозрачной историей обслуживания и одним владельцем.",
        "https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=1200&q=80",
        1,
    ),
    (
        "BMW",
        "X5",
        2020,
        5190000,
        68000,
        "diesel",
        "automatic",
        "suv",
        "black",
        "Премиальный кроссовер с полным приводом, адаптивной подвеской и богатой комплектацией.",
        "https://images.unsplash.com/photo-1556189250-72ba954cfc2b?auto=format&fit=crop&w=1200&q=80",
        1,
    ),
    (
        "Kia",
        "Rio",
        2019,
        1390000,
        54000,
        "petrol",
        "automatic",
        "sedan",
        "gray",
        "Городской автомобиль для ежедневной эксплуатации с экономичным расходом топлива.",
        "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?auto=format&fit=crop&w=1200&q=80",
        1,
    ),
)


def _db_path() -> Path:
    path = Path(settings.database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def init_db() -> None:
    with sqlite3.connect(_db_path()) as connection:
        connection.executescript(SCHEMA_SQL)
        existing = connection.execute("SELECT COUNT(*) FROM cars").fetchone()[0]
        if existing == 0:
            connection.executemany(
                """
                INSERT INTO cars (
                    brand, model, year, price, mileage, fuel_type, transmission,
                    body_type, color, description, image_url, is_available
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                SEED_CARS,
            )
        connection.commit()


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()
