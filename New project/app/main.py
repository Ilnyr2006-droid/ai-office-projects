from __future__ import annotations

import json
import sqlite3
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.auth import is_admin
from app.config import settings
from app.db import get_db, init_db
from app.schemas import ValidationError, validate_car_payload, validate_inquiry_payload


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    if "is_available" in item:
        item["is_available"] = bool(item["is_available"])
    return item


def get_car_or_none(car_id: int) -> dict[str, Any] | None:
    with get_db() as connection:
        row = connection.execute("SELECT * FROM cars WHERE id = ?", (car_id,)).fetchone()
        return row_to_dict(row) if row else None


def json_response(handler: BaseHTTPRequestHandler, status_code: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status_code)
    _set_cors_headers(handler)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def empty_response(handler: BaseHTTPRequestHandler, status_code: int) -> None:
    handler.send_response(status_code)
    _set_cors_headers(handler)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def _set_cors_headers(handler: BaseHTTPRequestHandler) -> None:
    origin = handler.headers.get("Origin")
    if origin and origin in settings.cors_origins:
        handler.send_header("Access-Control-Allow-Origin", origin)
    handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Token")


class AppHandler(BaseHTTPRequestHandler):
    server_version = "CarStoreMVP/1.0"

    def do_OPTIONS(self) -> None:  # noqa: N802
        empty_response(self, HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            json_response(self, HTTPStatus.OK, {"status": "ok"})
            return

        if parsed.path == "/api/cars":
            self._handle_list_cars(parsed.query)
            return

        if parsed.path.startswith("/api/cars/"):
            self._handle_get_car(parsed.path)
            return

        if parsed.path == "/api/admin/inquiries":
            if not is_admin(dict(self.headers.items())):
                json_response(self, HTTPStatus.UNAUTHORIZED, {"detail": "Invalid admin API token"})
                return
            with get_db() as connection:
                rows = connection.execute(
                    "SELECT * FROM inquiries ORDER BY created_at DESC, id DESC"
                ).fetchall()
            json_response(self, HTTPStatus.OK, [row_to_dict(row) for row in rows])
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)

        if parsed.path.startswith("/api/cars/") and parsed.path.endswith("/inquiries"):
            self._handle_create_inquiry(parsed.path)
            return

        if parsed.path == "/api/admin/cars":
            if not is_admin(dict(self.headers.items())):
                json_response(self, HTTPStatus.UNAUTHORIZED, {"detail": "Invalid admin API token"})
                return
            self._handle_create_car()
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/admin/cars/"):
            if not is_admin(dict(self.headers.items())):
                json_response(self, HTTPStatus.UNAUTHORIZED, {"detail": "Invalid admin API token"})
                return
            self._handle_update_car(parsed.path)
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/admin/cars/"):
            if not is_admin(dict(self.headers.items())):
                json_response(self, HTTPStatus.UNAUTHORIZED, {"detail": "Invalid admin API token"})
                return
            self._handle_delete_car(parsed.path)
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValidationError(f"Invalid JSON: {exc.msg}") from exc
        if not isinstance(payload, dict):
            raise ValidationError("JSON body must be an object")
        return payload

    def _parse_car_id(self, path: str, *, allow_inquiries: bool = False) -> int:
        parts = [part for part in path.split("/") if part]
        expected_length = 4 if allow_inquiries else 3
        if len(parts) != expected_length:
            raise ValueError("Invalid car route")
        return int(parts[2])

    def _handle_list_cars(self, query_string: str) -> None:
        query = parse_qs(query_string)
        where_parts: list[str] = []
        params: list[Any] = []

        brand = query.get("brand", [None])[0]
        if brand:
            where_parts.append("LOWER(brand) = LOWER(?)")
            params.append(brand)

        model = query.get("model", [None])[0]
        if model:
            where_parts.append("LOWER(model) LIKE LOWER(?)")
            params.append(f"%{model}%")

        fuel_type = query.get("fuel_type", [None])[0]
        if fuel_type:
            where_parts.append("fuel_type = ?")
            params.append(fuel_type)

        transmission = query.get("transmission", [None])[0]
        if transmission:
            where_parts.append("transmission = ?")
            params.append(transmission)

        body_type = query.get("body_type", [None])[0]
        if body_type:
            where_parts.append("body_type = ?")
            params.append(body_type)

        for key, column in (
            ("min_price", "price >= ?"),
            ("max_price", "price <= ?"),
            ("min_year", "year >= ?"),
            ("max_mileage", "mileage <= ?"),
        ):
            value = query.get(key, [None])[0]
            if value is not None:
                try:
                    params.append(int(value))
                    where_parts.append(column)
                except ValueError:
                    json_response(self, HTTPStatus.BAD_REQUEST, {"detail": f"Query param '{key}' must be integer"})
                    return

        available_only = query.get("available_only", ["true"])[0].lower() != "false"
        if available_only:
            where_parts.append("is_available = 1")

        try:
            limit = int(query.get("limit", ["20"])[0])
            offset = int(query.get("offset", ["0"])[0])
        except ValueError:
            json_response(self, HTTPStatus.BAD_REQUEST, {"detail": "limit and offset must be integers"})
            return

        limit = min(max(limit, 1), 100)
        offset = max(offset, 0)
        where_clause = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""

        with get_db() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM cars {where_clause}", params).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT * FROM cars
                {where_clause}
                ORDER BY created_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()

        json_response(
            self,
            HTTPStatus.OK,
            {"items": [row_to_dict(row) for row in rows], "total": total},
        )

    def _handle_get_car(self, path: str) -> None:
        if path.endswith("/inquiries"):
            json_response(self, HTTPStatus.METHOD_NOT_ALLOWED, {"detail": "Use POST for inquiries"})
            return
        try:
            car_id = self._parse_car_id(path)
        except (ValueError, IndexError):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})
            return
        car = get_car_or_none(car_id)
        if not car:
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Car not found"})
            return
        json_response(self, HTTPStatus.OK, car)

    def _handle_create_inquiry(self, path: str) -> None:
        try:
            car_id = self._parse_car_id(path, allow_inquiries=True)
        except (ValueError, IndexError):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})
            return
        if not get_car_or_none(car_id):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Car not found"})
            return
        try:
            payload = validate_inquiry_payload(self._read_json())
        except ValidationError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"detail": str(exc)})
            return

        with get_db() as connection:
            cursor = connection.execute(
                """
                INSERT INTO inquiries (car_id, customer_name, phone, email, message, inquiry_type)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    car_id,
                    payload["customer_name"],
                    payload["phone"],
                    payload["email"],
                    payload["message"],
                    payload["inquiry_type"],
                ),
            )
            row = connection.execute(
                "SELECT * FROM inquiries WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
        json_response(self, HTTPStatus.CREATED, row_to_dict(row))

    def _handle_create_car(self) -> None:
        try:
            payload = validate_car_payload(self._read_json(), partial=False)
        except ValidationError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"detail": str(exc)})
            return
        with get_db() as connection:
            cursor = connection.execute(
                """
                INSERT INTO cars (
                    brand, model, year, price, mileage, fuel_type, transmission,
                    body_type, color, description, image_url, is_available
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["brand"],
                    payload["model"],
                    payload["year"],
                    payload["price"],
                    payload["mileage"],
                    payload["fuel_type"],
                    payload["transmission"],
                    payload["body_type"],
                    payload["color"],
                    payload["description"],
                    payload.get("image_url"),
                    int(payload.get("is_available", True)),
                ),
            )
            row = connection.execute("SELECT * FROM cars WHERE id = ?", (cursor.lastrowid,)).fetchone()
        json_response(self, HTTPStatus.CREATED, row_to_dict(row))

    def _handle_update_car(self, path: str) -> None:
        try:
            car_id = self._parse_car_id(path)
        except (ValueError, IndexError):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})
            return
        current = get_car_or_none(car_id)
        if not current:
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Car not found"})
            return
        try:
            updates = validate_car_payload(self._read_json(), partial=True)
        except ValidationError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"detail": str(exc)})
            return
        merged = {**current, **updates}
        with get_db() as connection:
            connection.execute(
                """
                UPDATE cars SET
                    brand = ?, model = ?, year = ?, price = ?, mileage = ?, fuel_type = ?,
                    transmission = ?, body_type = ?, color = ?, description = ?, image_url = ?,
                    is_available = ?
                WHERE id = ?
                """,
                (
                    merged["brand"],
                    merged["model"],
                    merged["year"],
                    merged["price"],
                    merged["mileage"],
                    merged["fuel_type"],
                    merged["transmission"],
                    merged["body_type"],
                    merged["color"],
                    merged["description"],
                    merged["image_url"],
                    int(merged["is_available"]),
                    car_id,
                ),
            )
            row = connection.execute("SELECT * FROM cars WHERE id = ?", (car_id,)).fetchone()
        json_response(self, HTTPStatus.OK, row_to_dict(row))

    def _handle_delete_car(self, path: str) -> None:
        try:
            car_id = self._parse_car_id(path)
        except (ValueError, IndexError):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Route not found"})
            return
        if not get_car_or_none(car_id):
            json_response(self, HTTPStatus.NOT_FOUND, {"detail": "Car not found"})
            return
        with get_db() as connection:
            connection.execute("DELETE FROM cars WHERE id = ?", (car_id,))
        empty_response(self, HTTPStatus.NO_CONTENT)


def create_server(*, bind_and_activate: bool = True) -> ThreadingHTTPServer:
    init_db()
    return ThreadingHTTPServer(
        (settings.app_host, settings.app_port),
        AppHandler,
        bind_and_activate=bind_and_activate,
    )
