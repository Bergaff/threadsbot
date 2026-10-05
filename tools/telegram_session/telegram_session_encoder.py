"""Сборка и разбор session-строк Telegram из ``auth_key`` + ``dc_id``.

Модуль закрывает две задачи:

1. **Сборка** — из ``auth_key`` (256 байт) и ``dc_id`` собрать готовую
   session-строку для нужной библиотеки:

   * :meth:`TelegramSessionEncoder.to_string` — формат **Telethon**
     (`telethon.sessions.StringSession`);
   * :meth:`TelegramSessionEncoder.to_pyrogram_string` — формат **Pyrogram v2**
     (pyrogram 2.x / kurigram, `client.export_session_string()`).

2. **Разбор** — :func:`parse_session_string` достаёт ``auth_key``, ``dc_id``
   (а для Pyrogram ещё ``api_id`` / ``user_id`` / ``is_bot``) из уже
   существующей session-строки любого из известных форматов.

Форматы (все — big-endian, ключ 256 байт):

.. code-block:: text

   Telethon      "1" + urlsafe_b64( dc_id:u8 | ip:4|16 | port:u16 | auth_key:256 )
   Pyrogram v2   urlsafe_b64( dc_id:u8 | api_id:u32 | test:bool |
                              auth_key:256 | user_id:u64 | is_bot:bool )   # '=' срезаны
   Pyrogram v1   urlsafe_b64( dc_id:u8 | test:bool |
                              auth_key:256 | user_id:u32|u64 | is_bot:bool )

Важно: **строки Telethon и Pyrogram несовместимы** — это разные структуры.
Именно поэтому «источник истины» — пара ``auth_key`` + ``dc_id``, из которой
собирается строка под конкретную библиотеку.

Пример:

.. code-block:: python

    from telegram_session_encoder import TelegramSessionEncoder, parse_session_string

    enc = TelegramSessionEncoder(auth_key=b"...256 bytes...", dc_id=5)
    telethon_string = enc.to_string()
    pyrogram_string = enc.to_pyrogram_string(api_id=2040, user_id=123456789)

    parsed = parse_session_string(telethon_string)
    assert parsed.auth_key == enc.auth_key and parsed.dc_id == enc.dc_id
"""

from __future__ import annotations

import base64
import ipaddress
import struct
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, Mapping, Optional, Tuple, Union

__all__ = [
    "SessionFormatError",
    "ParsedSession",
    "TelegramSessionEncoder",
    "parse_session_string",
]

#: Значение ``auth_key`` при сборке строки (bytes / bytearray / memoryview / hex-строка).
AuthKeyLike = Union[bytes, bytearray, memoryview, str]

AUTH_KEY_LENGTH = 256

# --- Telethon ---------------------------------------------------------------------
_TELETHON_VERSION = "1"
_TELETHON_PAYLOAD_SIZES = {4: 263, 16: 275}  # ip:4|16 -> dc_id + ip + port + key

# --- Pyrogram v2 (2.x, kurigram) ---------------------------------------------------
_PYROGRAM_V2_STRUCT = ">BI?256sQ?"
_PYROGRAM_V2_PAYLOAD_SIZE = struct.calcsize(_PYROGRAM_V2_STRUCT)  # 274

# --- Pyrogram v1 (старые session-строки) -------------------------------------------
_PYROGRAM_V1_STRUCT_32 = ">B?256sI?"
_PYROGRAM_V1_STRUCT_64 = ">B?256sQ?"

_DEFAULT_PORT = 443


class SessionFormatError(ValueError):
    """Строка не похожа ни на один известный формат session-строки."""


def _b64decode(value: str) -> bytes:
    """base64url-decode, который сам дописывает срезанный padding."""
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, UnicodeEncodeError) as exc:
        raise SessionFormatError(f"payload не является base64url: {exc}") from exc


def _b64encode(value: bytes) -> str:
    """base64url-encode без опасных для URL символов, ASCII-строка."""
    return base64.urlsafe_b64encode(value).decode("ascii")


def _normalize_auth_key(auth_key: AuthKeyLike) -> bytes:
    if isinstance(auth_key, str):
        try:
            auth_key = bytes.fromhex(auth_key)
        except ValueError as exc:  # не hex -> скорее всего пользователь передал base64
            raise ValueError(
                "auth_key передан строкой, но это не hex (ожидались 512 hex-символов)"
            ) from exc
    if isinstance(auth_key, (bytearray, memoryview)):
        auth_key = bytes(auth_key)
    if not isinstance(auth_key, bytes):
        raise TypeError(f"auth_key должен быть bytes/hex-строкой, получено {type(auth_key)!r}")
    if len(auth_key) != AUTH_KEY_LENGTH:
        raise ValueError(
            f"auth_key должен быть ровно {AUTH_KEY_LENGTH} байт, получено {len(auth_key)}"
        )
    return auth_key


def _normalize_dc_id(dc_id: Any) -> int:
    if isinstance(dc_id, bool) or not isinstance(dc_id, int):
        try:
            dc_id = int(dc_id)
        except (TypeError, ValueError) as exc:
            raise TypeError(f"dc_id должен быть целым числом, получено {dc_id!r}") from exc
    if not 1 <= dc_id <= 0xFF:
        raise ValueError(f"dc_id вне допустимого диапазона 1..255: {dc_id}")
    return dc_id


@dataclass(frozen=True)
class ParsedSession:
    """Результат разбора готовой session-строки."""

    auth_key: bytes
    dc_id: int
    source_format: str
    server_address: Optional[str] = None
    port: Optional[int] = None
    # поля, которые есть только в Pyrogram-форматах
    api_id: Optional[int] = None
    user_id: Optional[int] = None
    is_bot: Optional[bool] = None
    test_mode: Optional[bool] = None

    @property
    def auth_key_hex(self) -> str:
        """``auth_key`` в hex — ровно то, что просят «через auth_key и dc_id»."""
        return self.auth_key.hex()

    def to_encoder(self, **overrides: Any) -> "TelegramSessionEncoder":
        """Превращает разобранную сессию обратно в энкодер."""
        params: Dict[str, Any] = {
            "auth_key": self.auth_key,
            "dc_id": self.dc_id,
            "server_address": self.server_address,
            "port": self.port or _DEFAULT_PORT,
        }
        params.update(overrides)
        return TelegramSessionEncoder(**params)

    def describe(self) -> str:
        """Человекочитаемое описание без утечки полного ключа."""
        lines = [
            f"формат:        {self.source_format}",
            f"dc_id:         {self.dc_id}",
            f"auth_key:      {self.auth_key.hex()[:16]}…{self.auth_key.hex()[-8:]} ({len(self.auth_key)} байт)",
        ]
        if self.server_address:
            lines.append(f"DC адрес:      {self.server_address}:{self.port}")
        if self.api_id is not None:
            lines.append(f"api_id:        {self.api_id}")
        if self.user_id is not None:
            lines.append(f"user_id:       {self.user_id}")
        if self.is_bot is not None:
            lines.append(f"is_bot:        {self.is_bot}")
        if self.test_mode is not None:
            lines.append(f"test_mode:     {self.test_mode}")
        return "\n".join(lines)

    def __str__(self) -> str:  # без секретов, чтобы случайно не попало в логи
        return f"<ParsedSession {self.source_format} dc_id={self.dc_id}>"


@dataclass(frozen=True)
class TelegramSessionEncoder:
    """Собирает session-строки Telegram из ``auth_key`` и ``dc_id``.

    :param auth_key: 256 байт (``bytes``) либо 512 hex-символов (``str``).
    :param dc_id: номер дата-центра, к которому привязан ключ (обычно 1..5).
    :param server_address: IP дата-центра. Если не задан — берётся из таблицы
        :data:`_DC_IP_MAP`. **Надёжнее всего подставить адрес, снятый с живой
        сессии** (``client.session.server_address``), потому что Telegram иногда
        меняет адреса DC.
    :param port: порт дата-центра (по умолчанию 443).
    """

    auth_key: bytes
    dc_id: int
    server_address: Optional[str] = None
    port: int = _DEFAULT_PORT

    _VERSION: ClassVar[str] = _TELETHON_VERSION
    _PORT: ClassVar[int] = _DEFAULT_PORT
    #: Публичные адреса DC (совпадают с таблицей Pyrogram ``DataCenter.PROD``),
    #: порт 443. Используй их только как fallback: точный адрес см. в живой сессии.
    _DC_IP_MAP: ClassVar[Mapping[int, str]] = {
        1: "149.154.175.53",
        2: "149.154.167.51",
        3: "149.154.175.100",
        4: "149.154.167.91",
        5: "91.108.56.130",
        203: "91.105.192.100",  # служебный DC
    }

    def __post_init__(self) -> None:
        object.__setattr__(self, "auth_key", _normalize_auth_key(self.auth_key))
        object.__setattr__(self, "dc_id", _normalize_dc_id(self.dc_id))

        port = int(self.port)
        if not 0 < port <= 0xFFFF:
            raise ValueError(f"port вне диапазона 1..65535: {port}")
        object.__setattr__(self, "port", port)

        address = self.server_address
        if address is None:
            address = self._DC_IP_MAP.get(self.dc_id)
            if address is None:
                raise ValueError(
                    f"для dc_id={self.dc_id} нет адреса в таблице — "
                    f"передай server_address явно (например, снятый с живой сессии)"
                )
            object.__setattr__(self, "server_address", address)
        else:
            # принимаем как IP, так и «IP:port»
            address = address.strip()
            if address.count(":") == 1 and not address.startswith("["):
                address, _, port_part = address.partition(":")
                if port_part.isdigit():
                    object.__setattr__(self, "port", int(port_part))
            ipaddress.ip_address(address)  # упадёт, если это не IP
            object.__setattr__(self, "server_address", address)

    # ------------------------------------------------------------------ свойства
    @property
    def auth_key_hex(self) -> str:
        """``auth_key`` в hex (512 символов)."""
        return self.auth_key.hex()

    @property
    def ip_bytes(self) -> bytes:
        """Упакованный IP дата-центра."""
        return ipaddress.ip_address(self.server_address).packed

    @property
    def session_string(self) -> str:
        """Синоним :meth:`to_string`."""
        return self.to_string()

    # ------------------------------------------------------------------ сборка
    def to_string(self) -> str:
        """Собирает строку для ``telethon.sessions.StringSession``.

        Формат: ``"1" + base64url(dc_id:u8 | ip:4|16 | port:u16 | auth_key:256)``.
        Результат побайтово совпадает с ``TelethonClient.session.save()``.
        """
        payload = struct.pack(
            f">B{len(self.ip_bytes)}sH{AUTH_KEY_LENGTH}s",
            self.dc_id,
            self.ip_bytes,
            self.port,
            self.auth_key,
        )
        return f"{self._VERSION}{_b64encode(payload)}"

    def to_pyrogram_string(
        self,
        api_id: int,
        user_id: int,
        *,
        is_bot: bool = False,
        test_mode: bool = False,
    ) -> str:
        """Собирает строку для Pyrogram v2 (``pyrogram`` 2.x / ``kurigram``).

        Pyrogram-сессия, в отличие от Telethon, хранит ещё ``api_id`` и
        ``user_id`` — их обязательно нужно указать (берутся из живой сессии:
        ``client.api_id`` / ``me.id``).

        Формат: ``base64url(dc_id:u8 | api_id:u32 | test:bool | auth_key:256 |
        user_id:u64 | is_bot:bool)`` без выравнивающих ``=`` (271 байт payload,
        362 символа).
        """
        payload = struct.pack(
            _PYROGRAM_V2_STRUCT,
            int(self.dc_id),
            int(api_id),
            bool(test_mode),
            self.auth_key,
            int(user_id),
            bool(is_bot),
        )
        # Pyrogram сам срезает padding при экспорте и восстанавливает при импорте
        return _b64encode(payload).rstrip("=")

    # ------------------------------------------------------------------ разбор
    @classmethod
    def from_string_session(cls, string: str, **overrides: Any) -> "TelegramSessionEncoder":
        """Создаёт энкодер из готовой session-строки (Telethon или Pyrogram)."""
        return parse_session_string(string).to_encoder(**overrides)

    @classmethod
    def from_live_session(cls, session: Any, **overrides: Any) -> "TelegramSessionEncoder":
        """Создаёт энкодер из живой сессии Telethon/Pyrogram.

        ``session`` — любой объект с атрибутами ``dc_id``, ``server_address``
        (или ``ipv4``), ``port`` и ``auth_key``; подходит и
        ``TelegramClient.session``.
        """
        auth_key = getattr(session, "auth_key", None)
        auth_key = getattr(auth_key, "key", auth_key)  # telethon.crypto.AuthKey
        if auth_key is None:
            raise ValueError("в сессии нет auth_key — клиент ещё не авторизован?")
        address = (
            getattr(session, "server_address", None)
            or getattr(session, "ipv4", None)
            or getattr(session, "server_address_ipv4", None)
        )
        params: Dict[str, Any] = {
            "auth_key": auth_key,
            "dc_id": getattr(session, "dc_id", None),
            "server_address": address,
            "port": getattr(session, "port", None) or _DEFAULT_PORT,
        }
        params = {k: v for k, v in params.items() if v is not None}
        params.update(overrides)
        return cls(**params)

    # ------------------------------------------------------------------ прочее
    def describe(self) -> str:
        """Краткое описание без полного ключа (безопасно для логов)."""
        return (
            f"dc_id={self.dc_id}, DC={self.server_address}:{self.port}, "
            f"auth_key={self.auth_key_hex[:16]}…{self.auth_key_hex[-8:]}"
        )

    def __repr__(self) -> str:  # чтобы ключ не улетал в трейсбеки/логи
        return f"TelegramSessionEncoder({self.describe()})"


# ------------------------------------------------------------------------------
# Разбор существующих session-строк
# ------------------------------------------------------------------------------
def _validate_parsed(dc_id: int, auth_key: bytes) -> None:
    """Отсекает «мусор», который случайно совпал по длине со session-строкой."""
    if not 1 <= int(dc_id) <= 0xFF:
        raise SessionFormatError(f"неправдоподобный dc_id: {dc_id}")
    if not any(auth_key):
        raise SessionFormatError("пустой auth_key")


def _parse_telethon(string: str) -> ParsedSession:
    if not string.startswith(_TELETHON_VERSION):
        raise SessionFormatError("нет версии '1' в начале — это не Telethon-строка")

    payload = _b64decode(string[1:])
    ip_len = next((n for n, size in _TELETHON_PAYLOAD_SIZES.items() if size == len(payload)), None)
    if ip_len is None:
        raise SessionFormatError(f"неожиданная длина payload Telethon: {len(payload)} байт")

    dc_id, ip, port, auth_key = struct.unpack(f">B{ip_len}sH{AUTH_KEY_LENGTH}s", payload)
    _validate_parsed(dc_id, auth_key)
    try:
        server_address = ipaddress.ip_address(ip).compressed
    except ValueError as exc:  # не IP -> точно не Telethon-строка
        raise SessionFormatError(f"в строке не IP-адрес: {exc}") from exc
    return ParsedSession(
        auth_key=auth_key,
        dc_id=dc_id,
        source_format="telethon",
        server_address=server_address,
        port=port,
    )


def _parse_pyrogram_v2(string: str) -> ParsedSession:
    payload = _b64decode(string)
    if len(payload) != _PYROGRAM_V2_PAYLOAD_SIZE:
        raise SessionFormatError(f"неожиданная длина payload Pyrogram v2: {len(payload)} байт")

    dc_id, api_id, test_mode, auth_key, user_id, is_bot = struct.unpack(
        _PYROGRAM_V2_STRUCT, payload
    )
    _validate_parsed(dc_id, auth_key)
    return ParsedSession(
        auth_key=auth_key,
        dc_id=int(dc_id),
        source_format="pyrogram_v2",
        api_id=int(api_id),
        user_id=int(user_id),
        is_bot=bool(is_bot),
        test_mode=bool(test_mode),
    )


def _parse_pyrogram_v1(string: str) -> ParsedSession:
    payload = _b64decode(string)
    if len(payload) == struct.calcsize(_PYROGRAM_V1_STRUCT_32):
        fmt = _PYROGRAM_V1_STRUCT_32
    elif len(payload) == struct.calcsize(_PYROGRAM_V1_STRUCT_64):
        fmt = _PYROGRAM_V1_STRUCT_64
    else:
        raise SessionFormatError(f"неожиданная длина payload Pyrogram v1: {len(payload)} байт")

    dc_id, test_mode, auth_key, user_id, is_bot = struct.unpack(fmt, payload)
    _validate_parsed(dc_id, auth_key)
    return ParsedSession(
        auth_key=auth_key,
        dc_id=int(dc_id),
        source_format="pyrogram_v1",
        user_id=int(user_id),
        is_bot=bool(is_bot),
        test_mode=bool(test_mode),
    )


#: (функция-парсер, ожидаемые длины строки) — порядок проверки важен:
#: Telethon идёт первым, т.к. его строка начинается с версии "1".
_PARSERS: Tuple[Tuple[Any, Tuple[int, ...]], ...] = (
    (_parse_telethon, (353, 368)),
    (_parse_pyrogram_v2, (362, 364)),  # со срезанным и с полным padding
    (_parse_pyrogram_v1, (351, 356)),
)


def parse_session_string(string: str) -> ParsedSession:
    """Разбирает session-строку и достаёт ``auth_key`` / ``dc_id``.

    Поддерживаются форматы Telethon, Pyrogram v2 и Pyrogram v1. Формат
    определяется по длине строки и структуре payload, а не по «на глаз».

    :raises SessionFormatError: если строка не подошла ни под один формат.
    """
    if not isinstance(string, str):
        raise TypeError(f"ожидалась строка, получено {type(string)!r}")
    value = string.strip().replace("\n", "").replace(" ", "")
    if not value:
        raise SessionFormatError("пустая строка")

    errors = []
    # сначала парсеры, подходящие по длине, затем — все остальные (на случай экзотики)
    ordered = sorted(_PARSERS, key=lambda item: len(value) not in item[1])
    for parser, _sizes in ordered:
        try:
            return parser(value)
        except (SessionFormatError, struct.error, ValueError) as exc:
            errors.append(f"{parser.__name__}: {exc}")

    raise SessionFormatError(
        "не удалось определить формат session-строки (длина "
        f"{len(value)} символов).\n" + "\n".join(f"  - {e}" for e in errors)
    )
