# tools/telegram_session — `auth_key` + `dc_id` своими руками

Инструмент для тех случаев, когда сессии «сдулись» (tdata/Pyrogram/`.session`
больше не работают) и нужно **заново авторизоваться и получить новый
`auth_key` + `dc_id`** — и/или собрать из них session-строку для нужной
библиотеки.

Полное объяснение: [`GUIDE_TELEGRAM_SESSION.md`](../../GUIDE_TELEGRAM_SESSION.md).

## Быстрый старт

```bash
pip install -r tools/telegram_session/requirements.txt   # telethon

# логин по QR (на ПК удобнее всего) и выгрузка ключа
python tools/telegram_session/login_and_export.py --qr

# логин по номеру + код (+ пароль 2FA)
python tools/telegram_session/login_and_export.py --phone +79991234567

# ничего не логинить: вытащить auth_key/dc_id из уже живой session-строки
python tools/telegram_session/login_and_export.py --from-session-string "1BVtsOK..."

# оффлайн-проверка форматов, без сети и аккаунта
python tools/telegram_session/login_and_export.py --self-test
python tools/telegram_session/test_telegram_session_encoder.py
```

Экспорт печатается и сохраняется в `tools/telegram_session/out/*.json`
(каталог в `.gitignore`, права `600`). После успешной выгрузки локальный
`.session` удаляется — чтобы никто случайно не поднял два клиента с одним
`auth_key` (это гарантированная `AUTH_KEY_DUPLICATED`).

## Что в каталоге

| Файл | Что делает |
|---|---|
| `telegram_session_encoder.py` | `TelegramSessionEncoder` — сборка строки Telethon (`to_string()`), Pyrogram v2 (`to_pyrogram_string()`), разбор любых строк (`parse_session_string()`), `from_live_session()` (ключ прямо из живой сессии) |
| `login_and_export.py` | CLI: логин (QR/телефон), выгрузка `auth_key` (hex) + `dc_id` + готовых строк, режимы `--from-session-string`, `--from-json`, `--self-test`, прокси `--proxy` / `--mtproxy` |
| `test_telegram_session_encoder.py` | тесты форматов; при установленных `telethon`/`pyrogram` сверяет результат с ними |
| `requirements.txt` | зависимости инструмента |

## Подключение к своему коду

```python
from tools.telegram_session.telegram_session_encoder import (
    TelegramSessionEncoder,
    parse_session_string,
)

# собрать Telethon-строку из auth_key + dc_id
enc = TelegramSessionEncoder(auth_key=bytes.fromhex(AUTH_KEY_HEX), dc_id=DC_ID)
print(enc.to_string())

# собрать Pyrogram v2-строку (нужны api_id и user_id)
print(enc.to_pyrogram_string(api_id=API_ID, user_id=USER_ID))

# достать auth_key/dc_id из существующей строки (Telethon или Pyrogram)
parsed = parse_session_string("1BVtsOK...")
print(parsed.dc_id, parsed.auth_key_hex)
```

Форматы (big-endian):

| Клиент | Структура |
|---|---|
| Telethon | `"1" + base64url( dc_id:u8 \| ip:4\|16 \| port:u16 \| auth_key:256 )` |
| Pyrogram v2 | `base64url( dc_id:u8 \| api_id:u32 \| test:bool \| auth_key:256 \| user_id:u64 \| is_bot:bool )` |
| Pyrogram v1 | `base64url( dc_id:u8 \| test:bool \| auth_key:256 \| user_id:u32\|u64 \| is_bot:bool )` |

Строки Telethon и Pyrogram **несовместимы** — держите «источник истины» в виде
`auth_key` + `dc_id`.
