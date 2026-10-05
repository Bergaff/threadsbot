"""Инструменты для работы с Telegram-сессиями: сборка/разбор ``auth_key`` + ``dc_id``."""

from .telegram_session_encoder import (  # noqa: F401
    ParsedSession,
    SessionFormatError,
    TelegramSessionEncoder,
    parse_session_string,
)

__all__ = [
    "ParsedSession",
    "SessionFormatError",
    "TelegramSessionEncoder",
    "parse_session_string",
]
