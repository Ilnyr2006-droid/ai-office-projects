from __future__ import annotations

import secrets

from app.config import settings


def is_admin(headers: dict[str, str]) -> bool:
    token = headers.get("X-API-Token") or headers.get("x-api-token")
    if not token:
        return False
    return secrets.compare_digest(token, settings.admin_api_token)
