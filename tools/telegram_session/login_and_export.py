#!/usr/bin/env python3
"""Логин в Telegram и экспорт ``auth_key`` + ``dc_id`` (и готовых session-строк).

Зачем: ``auth_key`` невозможно «перевыпустить» отдельно — новый ключ создаётся
только в момент авторизации на серверах Telegram. Поэтому скрипт сначала
логинится (QR-код или телефон + код + пароль 2FA), а потом забирает ключ прямо
из живой сессии и печатает:

* ``dc_id``;
* ``auth_key`` в hex (512 символов);
* готовую строку ``StringSession`` для Telethon;
* готовую session-строку для Pyrogram v2 (нужны ещё ``api_id`` и ``user_id`` —
  они тоже выводятся).

Режимы:

.. code-block:: bash

    # 0) оффлайн-проверка форматов, без сети и без аккаунта
    python tools/telegram_session/login_and_export.py --self-test

    # 1) разобрать уже существующую session-строку (Telethon/Pyrogram) в auth_key + dc_id
    python tools/telegram_session/login_and_export.py --from-session-string "1BVtsOK..."

    # 2) залогиниться по QR (удобнее всего на компьютере: телефоном сканируешь QR)
    python tools/telegram_session/login_and_export.py --qr

    # 3) залогиниться по номеру телефона + коду из Telegram (+ пароль 2FA, если включён)
    python tools/telegram_session/login_and_export.py --phone +79991234567

    # 4) повторно выгрузить ключ из session-файла, оставшегося от прошлого запуска
    python tools/telegram_session/login_and_export.py

    # 5) собрать строки под другую библиотеку из сохранённого JSON
    python tools/telegram_session/login_and_export.py --from-json out/session_123456_20261005.json

Зависимости: ``pip install -r tools/telegram_session/requirements.txt``
(для режимов 0, 1, 5 Telethon даже не нужен).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from .telegram_session_encoder import (
        ParsedSession,
        SessionFormatError,
        TelegramSessionEncoder,
        parse_session_string,
    )
except ImportError:  # запуск файлом, а не модулем: python tools/telegram_session/login_and_export.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from telegram_session_encoder import (  # type: ignore[no-redef]
        ParsedSession,
        SessionFormatError,
        TelegramSessionEncoder,
        parse_session_string,
    )

# Значения по умолчанию — как в примере пользователя (десктопный api_id).
# ЛУЧШЕ указать свой api_id/api_hash из https://my.telegram.org/apps:
# публичные api_id рано или поздно получают API_ID_PUBLISHED_FLOOD и блокировки.
DEFAULT_API_ID = 2040
DEFAULT_API_HASH = "b18441a1ff607e10a989891a5462e627"

DEFAULT_DEVICE_MODEL = "Desktop"
DEFAULT_SYSTEM_VERSION = "Windows 10"
DEFAULT_APP_VERSION = "3.4.3 x64"
DEFAULT_LANG_CODE = "en"
DEFAULT_SYSTEM_LANG_CODE = "en-US"

OUT_DIR = Path(__file__).resolve().parent / "out"
DEFAULT_SESSION_FILE = OUT_DIR / "login.session"


# ------------------------------------------------------------------------------
# Вспомогательный вывод
# ------------------------------------------------------------------------------
def log(message: str = "") -> None:
    print(message, flush=True)


def mask_secret(value: str, keep: int = 12) -> str:
    return value if len(value) <= keep * 2 else f"{value[:keep]}…{value[-keep:]}"


def hr(title: str = "") -> None:
    log("─" * 72 if not title else f"── {title} " + "─" * max(0, 68 - len(title)))


# ------------------------------------------------------------------------------
# Оффлайн-режимы (не требуют сети и Telethon)
# ------------------------------------------------------------------------------
def self_test() -> int:
    """Проверяет форматы: сборка -> разбор -> сверка с оригиналом."""
    import base64
    import ipaddress
    import struct

    log("Оффлайн-проверка форматов session-строк…")
    failures = 0

    for dc_id, expected_ip in TelegramSessionEncoder._DC_IP_MAP.items():
        key = bytes((i * 7 + dc_id) % 256 for i in range(256))
        enc = TelegramSessionEncoder(auth_key=key, dc_id=dc_id)
        string = enc.to_string()

        parsed = parse_session_string(string)
        assert parsed.auth_key == key, "auth_key не совпал после round-trip"
        assert parsed.dc_id == dc_id, "dc_id не совпал после round-trip"

        # структура Telethon: "1" + base64(dc_id:u8 | ip | port:H | key)
        payload = base64.urlsafe_b64decode(string[1:] + "=" * (-len(string[1:]) % 4))
        got_dc, got_ip, got_port, got_key = struct.unpack(
            f">B{len(ipaddress.ip_address(expected_ip).packed)}sH256s", payload
        )
        assert (got_dc, got_port, got_key) == (dc_id, 443, key)
        assert ipaddress.ip_address(got_ip).compressed == expected_ip
        log(f"  DC{dc_id}: {expected_ip} — ок ({len(string)} символов)")

    # Pyrogram v2 round-trip
    key = bytes(range(256))
    enc = TelegramSessionEncoder(auth_key=key, dc_id=5)
    pyro = enc.to_pyrogram_string(api_id=2040, user_id=777000, is_bot=False)
    parsed = parse_session_string(pyro)
    assert parsed.source_format == "pyrogram_v2" and parsed.auth_key == key
    assert (parsed.api_id, parsed.user_id, parsed.dc_id) == (2040, 777000, 5)
    log(f"  Pyrogram v2: {len(pyro)} символов, api_id/user_id читаются — ок")

    # старый формат Pyrogram v1 (351 симв.) должен распознаваться
    legacy = base64.urlsafe_b64encode(
        struct.pack(">B?256sI?", 2, False, key, 123456, False)
    ).decode().rstrip("=")
    parsed = parse_session_string(legacy)
    assert parsed.source_format == "pyrogram_v1" and parsed.dc_id == 2 and parsed.user_id == 123456
    log(f"  Pyrogram v1 (legacy): {len(legacy)} символов — ок")

    # мусор должен давать понятную ошибку
    try:
        parse_session_string("0" + "A" * 100)
        failures += 1
        log("  ОШИБКА: мусорная строка разобралась без ошибки")
    except SessionFormatError:
        log("  мусорная строка корректно отклонена — ок")

    # hex-вход и «IP:port» в server_address
    enc_hex = TelegramSessionEncoder(auth_key=key.hex(), dc_id=4, server_address="149.154.167.91:443")
    assert enc_hex.auth_key == key and enc_hex.auth_key_hex == key.hex()
    log("  hex-вход и server_address='IP:port' — ок")

    if failures:
        log(f"ПРОВАЛЕНО тестов: {failures}")
        return 1
    log("Все проверки пройдены.")
    return 0


def report_from_encoder(enc: TelegramSessionEncoder, extra: Dict[str, Any]) -> Dict[str, Any]:
    """Собирает итоговый словарь экспорта (то, что печатается и сохраняется)."""
    pyrogram_string = None
    if extra.get("api_id") and extra.get("user_id"):
        pyrogram_string = enc.to_pyrogram_string(
            api_id=int(extra["api_id"]),
            user_id=int(extra["user_id"]),
            is_bot=bool(extra.get("is_bot")),
            test_mode=bool(extra.get("test_mode")),
        )

    data: Dict[str, Any] = {
        "auth_key_hex": enc.auth_key_hex,
        "dc_id": enc.dc_id,
        "server_address": enc.server_address,
        "port": enc.port,
        "telethon_string_session": enc.to_string(),
        "pyrogram_session_string": pyrogram_string,
    }
    data.update({k: v for k, v in extra.items() if v is not None})
    return data


def print_report(data: Dict[str, Any], *, saved_to: Optional[Path] = None) -> None:
    hr("РЕЗУЛЬТАТ: auth_key + dc_id")
    log(f"dc_id          : {data['dc_id']}")
    log(f"DC адрес       : {data.get('server_address')}:{data.get('port')}")
    log(f"auth_key (hex) :")
    log(f"  {data['auth_key_hex']}")
    for field_name in ("user_id", "username", "first_name", "is_bot", "api_id", "test_mode"):
        if data.get(field_name) is not None:
            log(f"{field_name:<15}: {data[field_name]}")

    hr("StringSession (Telethon)")
    log(data["telethon_string_session"])

    if data.get("pyrogram_session_string"):
        hr("Session string (Pyrogram v2)")
        log(data["pyrogram_session_string"])
    else:
        hr()
        log("Pyrogram-строка не собрана: нет api_id/user_id (значит, ключ получен не "
            "из живого логина, а из разбора — возьми их из JSON/аккаунта).")

    if saved_to:
        hr()
        log(f"Сохранено: {saved_to}  (права 600 — это пароль от аккаунта, береги файл)")
    hr()
    log("ВНИМАНИЕ: один auth_key нельзя использовать одновременно из двух мест "
        "(телефон+ПК или два клиента) — Telegram пришлёт AUTH_KEY_DUPLICATED и "
        "УНИЧТОЖИТ ключ в течение минуты.")
    hr()


def save_export(data: Dict[str, Any], out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(out_path.parent, stat.S_IRWXU)  # 700
    except OSError:
        pass
    payload = {"exported_at": datetime.now(timezone.utc).isoformat(), **data}
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(out_path, stat.S_IRUSR | stat.S_IWUSR)  # 600
    return out_path


def parse_only(session_string: str, *, as_json: bool) -> int:
    """Режим --from-session-string: вытащить auth_key/dc_id из готовой строки."""
    parsed: ParsedSession = parse_session_string(session_string)
    enc = parsed.to_encoder()
    data = report_from_encoder(
        enc,
        {
            "api_id": parsed.api_id,
            "user_id": parsed.user_id,
            "is_bot": parsed.is_bot,
            "test_mode": parsed.test_mode,
            "source_format": parsed.source_format,
        },
    )
    if as_json:
        log(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        hr()
        log("Разобрана session-строка, формат: " + parsed.source_format)
        print_report(data)
    return 0


def reencode_from_json(path: Path, *, as_json: bool) -> int:
    """Режим --from-json: пересобрать строки (например, Telethon -> Pyrogram)."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    enc = TelegramSessionEncoder(
        auth_key=payload["auth_key_hex"],
        dc_id=payload["dc_id"],
        server_address=payload.get("server_address"),
        port=payload.get("port") or 443,
    )
    data = report_from_encoder(
        enc,
        {
            "api_id": payload.get("api_id"),
            "user_id": payload.get("user_id"),
            "is_bot": payload.get("is_bot"),
            "test_mode": payload.get("test_mode"),
            "username": payload.get("username"),
        },
    )
    if as_json:
        log(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print_report(data)
    return 0


# ------------------------------------------------------------------------------
# Онлайн-режим: логин и экспорт
# ------------------------------------------------------------------------------
def _print_qr(url: str) -> None:
    """Печатает QR в терминале, если установлен qrcode; иначе — ссылку."""
    try:
        import qrcode  # type: ignore

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except Exception:
        log("(для QR прямо в терминале: pip install qrcode)")
    log("QR-ссылка: " + url)
    log("Открой её в уже авторизованном Telegram: камера/«Устройства» -> "
        "«Подключить устройство» (на ПК ссылку нужно открыть внутри Telegram).")


def _build_proxy(args: argparse.Namespace) -> tuple[Any, Any]:
    """Возвращает (proxy, connection_cls) для TelegramClient.

    ``--proxy socks5://user:pass@host:1080`` — обычный SOCKS/HTTP-прокси
    (нужен пакет ``python-socks``: ``pip install "telethon[socks]"``).
    ``--mtproxy host:443:secret`` — MTProto-прокси Telegram (secret в hex).
    """
    if args.proxy and args.mtproxy:
        raise SystemExit("--proxy и --mtproxy одновременно указывать нельзя")

    if args.mtproxy:
        from telethon.network import ConnectionTcpMTProxyRandomizedIntermediate

        try:
            host, port, secret = args.mtproxy.rsplit(":", 2)
        except ValueError:
            raise SystemExit("--mtproxy ожидает формат HOST:PORT:SECRET")
        return (host, int(port), secret), ConnectionTcpMTProxyRandomizedIntermediate

    if not args.proxy:
        return None, None

    from urllib.parse import unquote, urlparse

    parsed = urlparse(args.proxy)
    scheme = parsed.scheme.lower()
    if scheme in ("socks5", "socks5h"):
        proxy_type, default_port = "socks5", 1080
    elif scheme in ("socks4", "socks4a"):
        proxy_type, default_port = "socks4", 1080
    elif scheme in ("http", "https"):
        proxy_type, default_port = "http", 8080
    else:
        raise SystemExit(f"неизвестная схема прокси: {scheme!r} (socks5/socks4/http)")
    if not parsed.hostname:
        raise SystemExit("в --proxy не указан хост")

    try:
        import python_socks  # noqa: F401
    except ImportError:
        log('Прокси требует пакета python-socks: pip install "telethon[socks]"')

    return (
        {
            "proxy_type": proxy_type,
            "addr": parsed.hostname,
            "port": parsed.port or default_port,
            "username": unquote(parsed.username) if parsed.username else None,
            "password": unquote(parsed.password) if parsed.password else None,
            "rdns": True,
        },
        None,
    )


async def _login_via_qr(client: Any, errors: Any) -> Any:
    """QR-логин. Возвращает Telethon-пользователя."""
    while True:
        qr = await client.qr_login()
        hr("QR-логин")
        _print_qr(qr.url)
        log("Жду сканирования (Ctrl+C — отмена)…")
        try:
            user = await qr.wait()
            return user
        except asyncio.TimeoutError:
            log("QR истёк.")
        except errors.SessionPasswordNeededError:
            import getpass

            password = os.environ.get("TELEGRAM_2FA_PASSWORD") or getpass.getpass("Пароль 2FA: ")
            return await client.sign_in(password=password)

        answer = input("Обновить QR и попробовать снова? [Y/n] ").strip().lower()
        if answer not in ("", "y", "yes", "д"):
            raise SystemExit("Логин отменён.")


async def _login_via_phone(client: Any, errors: Any, phone: str, *, force_sms: bool) -> Any:
    """Логин по номеру телефона: код из Telegram + пароль 2FA, если включён."""
    import getpass

    sent = await client.send_code_request(phone, force_sms=force_sms)
    hr("Логин по номеру")
    log(f"Код отправлен в Telegram (тип: {type(sent.type).__name__}).")
    log("Введи код так, как он показан в приложении — с пробелами можно, "
        "главное не символами-обманками (иначе код «сгорит»).")

    while True:
        code = os.environ.get("TELEGRAM_CODE") or getpass.getpass("Код из Telegram: ")
        try:
            return await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except errors.SessionPasswordNeededError:
            password = os.environ.get("TELEGRAM_2FA_PASSWORD") or getpass.getpass("Пароль 2FA: ")
            return await client.sign_in(password=password)
        except (errors.PhoneCodeInvalidError, errors.PhoneCodeEmptyError):
            log("Неверный код, попробуй ещё раз.")
        except errors.PhoneCodeExpiredError:
            log("Код истёк — запрашиваю новый.")
            sent = await client.send_code_request(phone, force_sms=force_sms)


async def login_and_export(args: argparse.Namespace) -> int:
    try:
        from telethon import TelegramClient, errors
    except ImportError:
        log("Не установлен Telethon. Выполни:")
        log("  pip install -r tools/telegram_session/requirements.txt")
        return 2

    session_file = Path(args.session_file).expanduser() if args.session_file else DEFAULT_SESSION_FILE
    if args.ephemeral:
        from telethon.sessions import StringSession

        session: Any = StringSession()
    else:
        session = str(session_file)

    proxy, connection_cls = _build_proxy(args)
    client_kwargs: Dict[str, Any] = {}
    if proxy is not None:
        client_kwargs["proxy"] = proxy
    if connection_cls is not None:
        client_kwargs["connection"] = connection_cls

    client = TelegramClient(
        session=session,
        api_id=args.api_id,
        api_hash=args.api_hash,
        device_model=args.device_model,
        system_version=args.system_version,
        app_version=args.app_version,
        lang_code=args.lang_code,
        system_lang_code=args.system_lang_code,
        **client_kwargs,
    )

    hr("Подключение")
    log(f"api_id={args.api_id}, dc по умолчанию — определяется Telegram")
    if args.api_id == DEFAULT_API_ID:
        log("Подсказка: лучше завести свой api_id на https://my.telegram.org/apps — "
            "публичные api_id иногда получают API_ID_PUBLISHED_FLOOD.")

    try:
        await client.connect()
    except Exception as exc:  # сеть, прокси, блокировки
        log(f"Не удалось подключиться: {type(exc).__name__}: {exc}")
        log("Проверь интернет. Если сеть фильтрует MTProto (частая история у "
            "российских провайдеров), повтори с прокси:")
        log("  --proxy socks5://user:pass@host:1080   (pip install \"telethon[socks]\")")
        log("  --mtproxy HOST:PORT:SECRET             (MTProto-прокси Telegram)")
        log("Подробности — GUIDE_TELEGRAM_SESSION.md, раздел «Прокси».")
        return 1

    try:
        if not await client.is_user_authorized():
            if args.phone:
                me = await _login_via_phone(client, errors, args.phone, force_sms=args.force_sms)
            else:
                if not args.qr:
                    log("Ни --qr, ни --phone не указаны — использую QR-логин "
                        "(самый надёжный вариант на компьютере).")
                me = await _login_via_qr(client, errors)
        else:
            me = await client.get_me()
            log("Использую уже авторизованный session-файл (повторный экспорт).")

        me = me or await client.get_me()
        session_obj = client.session
        if session_obj.auth_key is None:
            log("Сессия есть, но auth_key пуст — что-то не так с логином.")
            return 1

        extra: Dict[str, Any] = {
            "api_id": args.api_id,
            "user_id": getattr(me, "id", None),
            "username": getattr(me, "username", None),
            "first_name": getattr(me, "first_name", None),
            "is_bot": bool(getattr(me, "bot", False)),
            # Telethon не хранит test-флаг в сессии: живой логин всегда в прод-DC.
            "test_mode": False,
        }

        enc = TelegramSessionEncoder.from_live_session(session_obj)
        data = report_from_encoder(enc, extra)

        saved_to: Optional[Path] = None
        if not args.no_save:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            name = f"session_{extra.get('user_id') or 'unknown'}_{stamp}.json"
            saved_to = save_export(data, Path(args.out).expanduser() if args.out else OUT_DIR / name)

        if args.json:
            log(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            print_report(data, saved_to=saved_to)

        if not args.keep_session_file and not args.ephemeral:
            # Удаляем локальный session-файл, чтобы случайно не поднять ДВА клиента
            # с одним и тем же auth_key (это гарантированная AUTH_KEY_DUPLICATED).
            for suffix in ("", "-journal", "-wal", "-shm"):
                candidate = Path(str(session_file) + suffix)
                if candidate.exists():
                    candidate.unlink()
            hr()
            log(f"Локальный session-файл удалён ({session_file}).")
            log("Это нормально: ключ остался в строке/JSON выше. Если оставить файл и "
                "запустить клиент ещё раз — будет два клиента с одним ключом и Telegram "
                "его убьёт. Нужен повторный экспорт — просто залогинься заново.")
        return 0
    except errors.AuthKeyDuplicatedError:
        log("AUTH_KEY_DUPLICATED: этим ключом одновременно пользуются из другого места. "
            "Ключ уничтожен Telegram. Логинься заново и больше не запускай два клиента "
            "с одной сессией.")
        return 1
    except (errors.AuthKeyUnregisteredError, errors.AuthKeyInvalidError):
        log("AuthKeyUnregistered/AuthKeyInvalid: этот auth_key больше не работает "
            "(сессию завершили из Telegram, ключ уничтожен или истёк по неактивности). "
            "Спасти его нельзя — ключ нужно получить заново: запусти скрипт с --qr.")
        return 1
    except errors.PhoneNumberBannedError:
        log("PhoneNumberBanned: номер/аккаунт заблокирован Telegram — новый ключ не поможет.")
        return 1
    except errors.ApiIdPublishedFloodError:
        log("API_ID_PUBLISHED_FLOOD: этот api_id/api_hash публично скомпрометирован. "
            "Заведи свой на https://my.telegram.org/apps и повтори.")
        return 1
    except errors.FloodWaitError as exc:
        log(f"FloodWait: Telegram просит подождать {exc.seconds} с. Повтори позже.")
        return 1
    except Exception as exc:
        log(f"Ошибка: {type(exc).__name__}: {exc}")
        return 1
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


# ------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="login_and_export",
        description="Логин в Telegram и выгрузка auth_key + dc_id (+ session-строк Telethon/Pyrogram).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Примеры:\n"
            "  login_and_export.py --self-test\n"
            "  login_and_export.py --from-session-string '1BVtsOK...'\n"
            "  login_and_export.py --qr\n"
            "  login_and_export.py --phone +79991234567\n"
            "  login_and_export.py --from-json out/session_123_20261005-120000.json\n"
        ),
    )
    login = parser.add_argument_group("логин")
    login.add_argument("--qr", action="store_true", help="логин по QR-коду (удобно на компьютере)")
    login.add_argument("--phone", help="логин по номеру телефона, например +79991234567")
    login.add_argument("--force-sms", action="store_true", help="просить SMS вместо кода в Telegram")
    login.add_argument("--ephemeral", action="store_true",
                       help="ничего не писать на диск (session только в памяти)")
    login.add_argument("--session-file", help=f"файл сессии (по умолчанию {DEFAULT_SESSION_FILE})")
    login.add_argument("--keep-session-file", action="store_true",
                       help="НЕ удалять session-файл после экспорта (см. предупреждение о дублях)")
    login.add_argument("--proxy", help="socks5://user:pass@host:1080 или http://host:8080")
    login.add_argument("--mtproxy", help="MTProto-прокси: HOST:PORT:SECRET (secret в hex)")

    api = parser.add_argument_group("api_id / устройство")
    api.add_argument("--api-id", type=int, default=int(os.environ.get("TELEGRAM_API_ID", DEFAULT_API_ID)))
    api.add_argument("--api-hash", default=os.environ.get("TELEGRAM_API_HASH", DEFAULT_API_HASH))
    api.add_argument("--device-model", default=DEFAULT_DEVICE_MODEL)
    api.add_argument("--system-version", default=DEFAULT_SYSTEM_VERSION)
    api.add_argument("--app-version", default=DEFAULT_APP_VERSION)
    api.add_argument("--lang-code", default=DEFAULT_LANG_CODE)
    api.add_argument("--system-lang-code", default=DEFAULT_SYSTEM_LANG_CODE)

    out = parser.add_argument_group("вывод")
    out.add_argument("--out", help="путь JSON-файла с экспортом")
    out.add_argument("--no-save", action="store_true", help="не сохранять JSON, только напечатать")
    out.add_argument("--json", action="store_true", help="напечатать результат как JSON")

    offline = parser.add_argument_group("оффлайн-режимы")
    offline.add_argument("--self-test", action="store_true", help="проверка форматов без сети")
    offline.add_argument("--from-session-string", help="разобрать готовую session-строку")
    offline.add_argument("--from-json", help="пересобрать строки из сохранённого JSON")
    return parser


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)

    if args.self_test:
        return self_test()
    if args.from_session_string:
        try:
            return parse_only(args.from_session_string, as_json=args.json)
        except SessionFormatError as exc:
            log(f"Не получилось разобрать строку: {exc}")
            return 2
    if args.from_json:
        return reencode_from_json(Path(args.from_json).expanduser(), as_json=args.json)

    if args.ephemeral and args.session_file:
        log("--ephemeral и --session-file вместе не имеют смысла.")
        return 2

    try:
        return asyncio.run(login_and_export(args))
    except KeyboardInterrupt:
        log("\nПрервано пользователем. Если логин успел пройти, session-файл остался на "
            "диске — запусти скрипт снова без флагов, чтобы выгрузить ключ.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
