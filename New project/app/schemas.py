from __future__ import annotations

from typing import Any

FuelTypes = {"petrol", "diesel", "hybrid", "electric"}
TransmissionTypes = {"manual", "automatic", "robot"}
BodyTypes = {"sedan", "suv", "hatchback", "wagon", "coupe", "pickup", "van"}
InquiryTypes = {"buy", "credit", "trade-in", "test-drive"}


class ValidationError(ValueError):
    pass


def _expect_string(data: dict[str, Any], key: str, *, min_length: int, max_length: int) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ValidationError(f"Field '{key}' must be a string")
    value = value.strip()
    if len(value) < min_length or len(value) > max_length:
        raise ValidationError(f"Field '{key}' must be {min_length}-{max_length} chars long")
    return value


def _expect_int(data: dict[str, Any], key: str, *, min_value: int, max_value: int) -> int:
    value = data.get(key)
    if not isinstance(value, int):
        raise ValidationError(f"Field '{key}' must be an integer")
    if value < min_value or value > max_value:
        raise ValidationError(f"Field '{key}' must be between {min_value} and {max_value}")
    return value


def _expect_bool(data: dict[str, Any], key: str, *, default: bool | None = None) -> bool:
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise ValidationError(f"Field '{key}' must be a boolean")
    return value


def _expect_enum(data: dict[str, Any], key: str, allowed: set[str]) -> str:
    value = _expect_string(data, key, min_length=2, max_length=30)
    if value not in allowed:
        raise ValidationError(f"Field '{key}' must be one of: {', '.join(sorted(allowed))}")
    return value


def _expect_optional_string(data: dict[str, Any], key: str, *, max_length: int) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(f"Field '{key}' must be a string")
    value = value.strip()
    if len(value) > max_length:
        raise ValidationError(f"Field '{key}' is too long")
    return value or None


def validate_car_payload(data: dict[str, Any], *, partial: bool = False) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("JSON body must be an object")

    result: dict[str, Any] = {}
    fields = {
        "brand": lambda d, k: _expect_string(d, k, min_length=2, max_length=50),
        "model": lambda d, k: _expect_string(d, k, min_length=1, max_length=50),
        "year": lambda d, k: _expect_int(d, k, min_value=1990, max_value=2100),
        "price": lambda d, k: _expect_int(d, k, min_value=1, max_value=1_000_000_000),
        "mileage": lambda d, k: _expect_int(d, k, min_value=0, max_value=1_000_000),
        "fuel_type": lambda d, k: _expect_enum(d, k, FuelTypes),
        "transmission": lambda d, k: _expect_enum(d, k, TransmissionTypes),
        "body_type": lambda d, k: _expect_enum(d, k, BodyTypes),
        "color": lambda d, k: _expect_string(d, k, min_length=2, max_length=30),
        "description": lambda d, k: _expect_string(d, k, min_length=10, max_length=2000),
        "image_url": lambda d, k: _expect_optional_string(d, k, max_length=1000),
        "is_available": lambda d, k: _expect_bool(d, k, default=True),
    }

    for key, validator in fields.items():
        if key not in data:
            if not partial and key != "image_url" and key != "is_available":
                raise ValidationError(f"Missing required field '{key}'")
            if not partial and key == "is_available":
                result[key] = True
            continue
        result[key] = validator(data, key)

    if partial and not result:
        raise ValidationError("No fields to update")
    return result


def validate_inquiry_payload(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("JSON body must be an object")

    result = {
        "customer_name": _expect_string(data, "customer_name", min_length=2, max_length=100),
        "phone": _expect_string(data, "phone", min_length=6, max_length=30),
        "email": _expect_optional_string(data, "email", max_length=255),
        "message": _expect_optional_string(data, "message", max_length=2000),
        "inquiry_type": _expect_enum(data, "inquiry_type", InquiryTypes),
    }
    return result
