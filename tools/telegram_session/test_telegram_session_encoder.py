"""Тесты форматов session-строк.

Запуск без зависимостей (проверки только на стандартной библиотеке)::

    python tools/telegram_session/test_telegram_session_encoder.py

Запуск как pytest (дополнительно проверяет совместимость с telethon/pyrogram,
если они установлены)::

    pytest tools/telegram_session/test_telegram_session_encoder.py
"""

from __future__ import annotations

import base64
import ipaddress
import os
import random
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from telegram_session_encoder import (  # noqa: E402
    SessionFormatError,
    TelegramSessionEncoder,
    parse_session_string,
)


def random_auth_key(rng: random.Random) -> bytes:
    return bytes(rng.randrange(256) for _ in range(256))


def test_telethon_roundtrip_for_every_known_dc() -> None:
    rng = random.Random(1234)
    for dc_id, expected_ip in TelegramSessionEncoder._DC_IP_MAP.items():
        key = random_auth_key(rng)
        string = TelegramSessionEncoder(auth_key=key, dc_id=dc_id).to_string()

        assert string[0] == "1", "версия формата Telethon"
        parsed = parse_session_string(string)
        assert parsed.source_format == "telethon"
        assert parsed.auth_key == key
        assert parsed.dc_id == dc_id
        assert parsed.server_address == expected_ip
        assert parsed.port == 443

        payload = base64.urlsafe_b64decode(string[1:] + "=" * (-len(string[1:]) % 4))
        assert len(payload) == 263, "dc_id(1) + ip(4) + port(2) + key(256)"
        dc, ip, port, got_key = struct.unpack(">B4sH256s", payload)
        assert (dc, port, got_key) == (dc_id, 443, key)
        assert ipaddress.ip_address(ip).compressed == expected_ip


def test_telethon_ipv6_variant_is_accepted() -> None:
    """Строка с IPv6-адресом (275 байт payload) тоже должна разбираться."""
    key = bytes(range(256))
    payload = struct.pack(">B16sH256s", 2, ipaddress.ip_address("2001:67c:4e8:f002::a").packed, 443, key)
    string = "1" + base64.urlsafe_b64encode(payload).decode()
    parsed = parse_session_string(string)
    assert parsed.dc_id == 2 and parsed.auth_key == key
    assert parsed.server_address == "2001:67c:4e8:f002::a"


def test_pyrogram_v2_roundtrip() -> None:
    rng = random.Random(99)
    key = random_auth_key(rng)
    string = TelegramSessionEncoder(auth_key=key, dc_id=5).to_pyrogram_string(
        api_id=2040, user_id=777000, is_bot=False
    )
    assert len(string) == 362, "271 байт payload без padding"
    assert "=" not in string, "Pyrogram срезает padding"

    parsed = parse_session_string(string)
    assert parsed.source_format == "pyrogram_v2"
    assert (parsed.dc_id, parsed.api_id, parsed.user_id) == (5, 2040, 777000)
    assert parsed.auth_key == key and parsed.is_bot is False and parsed.test_mode is False


def test_pyrogram_v2_padded_string_is_accepted() -> None:
    """Некоторые экспортеры оставляют '=' — парсер обязан принимать оба вида."""
    key = bytes(range(256))
    padded = base64.urlsafe_b64encode(
        struct.pack(">BI?256sQ?", 3, 2040, False, key, 42, True)
    ).decode()
    assert padded.endswith("=")
    parsed = parse_session_string(padded)
    assert parsed.dc_id == 3 and parsed.auth_key == key and parsed.user_id == 42
    assert parsed.is_bot is True


def test_pyrogram_v1_legacy_formats() -> None:
    key = bytes(range(256))
    for fmt, size in ((">B?256sI?", 351), (">B?256sQ?", 356)):
        legacy = base64.urlsafe_b64encode(struct.pack(fmt, 4, False, key, 555, False)).decode().rstrip("=")
        assert len(legacy) == size
        parsed = parse_session_string(legacy)
        assert parsed.source_format == "pyrogram_v1"
        assert (parsed.dc_id, parsed.user_id, parsed.auth_key) == (4, 555, key)


def test_encoder_accepts_hex_and_ip_port() -> None:
    key = bytes(range(256))
    enc = TelegramSessionEncoder(auth_key=key.hex(), dc_id=4, server_address="149.154.167.91:443")
    assert enc.auth_key == key
    assert enc.auth_key_hex == key.hex()
    assert parse_session_string(enc.to_string()).auth_key == key


def test_from_string_session_and_live_session_like_object() -> None:
    key = bytes(range(256))
    string = TelegramSessionEncoder(auth_key=key, dc_id=1).to_string()
    assert TelegramSessionEncoder.from_string_session(string).auth_key == key

    class FakeLiveSession:  # как telethon-сессия после логина
        dc_id = 2
        server_address = "149.154.167.51"
        port = 443

        class auth_key:  # noqa: N801 - имитируем telethon.crypto.AuthKey
            pass

    FakeLiveSession.auth_key.key = key
    enc = TelegramSessionEncoder.from_live_session(FakeLiveSession)
    assert enc.dc_id == 2 and enc.auth_key == key and enc.server_address == "149.154.167.51"


def test_validation_errors() -> None:
    key = bytes(range(256))
    for bad_key, exc in ((b"short", ValueError), ("не-hex", ValueError), (42, TypeError)):
        try:
            TelegramSessionEncoder(auth_key=bad_key, dc_id=1)  # type: ignore[arg-type]
        except exc:
            pass
        else:  # pragma: no cover
            raise AssertionError(f"ожидалась ошибка для auth_key={bad_key!r}")

    try:
        TelegramSessionEncoder(auth_key=key, dc_id=42)
    except ValueError as error:
        assert "server_address" in str(error)
    else:  # pragma: no cover
        raise AssertionError("неизвестный dc_id без адреса должен падать")

    # 42 можно задать с явным адресом
    enc = TelegramSessionEncoder(auth_key=key, dc_id=42, server_address="127.0.0.1")
    assert parse_session_string(enc.to_string()).dc_id == 42


def test_garbage_is_rejected() -> None:
    for garbage in ("", "1", "не-сессия", "0" + "A" * 100, "A" * 351):
        try:
            parse_session_string(garbage)
        except SessionFormatError:
            continue
        raise AssertionError(f"мусор разобрался без ошибки: {garbage[:16]!r}")


def test_matches_telethon_if_installed() -> None:
    try:
        from telethon.crypto import AuthKey
        from telethon.sessions import StringSession
    except ImportError:
        return  # необязательная проверка

    key = bytes(range(256))
    reference = StringSession()
    reference.set_dc(5, "91.108.56.130", 443)
    reference.auth_key = AuthKey(key)

    ours = TelegramSessionEncoder(auth_key=key, dc_id=5).to_string()
    assert ours == reference.save(), "наша строка должна совпадать с save() Telethon"
    assert StringSession(ours).auth_key.key == key


def test_matches_pyrogram_if_installed() -> None:
    try:
        from pyrogram.storage.memory_storage import MemoryStorage
    except ImportError:
        return  # необязательная проверка

    import asyncio

    key = bytes(range(256))
    ours = TelegramSessionEncoder(auth_key=key, dc_id=5).to_pyrogram_string(api_id=2040, user_id=777000)

    async def check() -> None:
        storage = MemoryStorage(":memory:", session_string=ours)
        await storage.open()
        assert await storage.auth_key() == key
        assert await storage.dc_id() == 5
        assert await storage.api_id() == 2040
        assert await storage.user_id() == 777000
        assert await storage.export_session_string() == ours

    asyncio.run(check())


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    failed = 0
    for test in tests:
        try:
            test()
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {test.__name__}: {type(error).__name__}: {error}")
        else:
            print(f"ok    {test.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} тестов пройдено")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
