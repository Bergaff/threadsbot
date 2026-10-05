# Гайд: как заново авторизоваться в Telegram и получить **новый** `auth_key` + `dc_id`

Короткий ответ на вопрос «как мне на компьютере снова авторизоваться и получить
новые auth_key и dc_id, потому что tdata/Pyrogram сдулись»:

```bash
# 1. зависимости (нужен только Telethon)
pip install -r tools/telegram_session/requirements.txt

# 2. логин по QR и сразу выгрузка ключа
python tools/telegram_session/login_and_export.py --qr
```

На выходе — `dc_id`, `auth_key` (hex), готовая строка для Telethon и готовая
строка для Pyrogram v2. Всё дублируется в JSON:
`tools/telegram_session/out/session_<user_id>_<дата>.json` (права `600`, каталог в `.gitignore`).

Если аккаунт уже залогинен где-то в виде живой сессии — логиниться не нужно,
ключ можно просто вытащить:

```bash
python tools/telegram_session/login_and_export.py --from-session-string "1BVtsOK..."
python tools/telegram_session/login_and_export.py --from-json out/session_123_20261005-120000.json
python tools/telegram_session/login_and_export.py --self-test   # оффлайн-проверка форматов
```

Дальше — подробности: почему ключи «сдуваются», что именно делать по шагам, как
не убить новый ключ и что было не так в исходном коде `telegram_session_encoder.py`.

---

## 1. Почему `auth_key` нельзя «перевыпустить» и почему tdata/Pyrogram умерли

`auth_key` — это не токен, который можно перегенерировать запросом. Это
долговременный секрет (256 байт), который клиент и сервер вырабатывают
Diffie-Hellman-обменом **в момент первой авторизации**; на стороне Telegram он
привязан к конкретной сессии (устройству) в дата-центре `dc_id`. Поэтому:

* «получить новый ключ» = **авторизоваться заново** (QR/номер + код) и забрать
  ключ из живой сессии;
* `tdata`, JSON-куки, `.session`-файл, StringSession — это всё лишь **локальные
  копии одного и того же ключа**. Конвертация мёртвого ключа в другой формат
  ничего не даст: сервер его уже не принимает.

Типичные причины, по которым ключ «сдулся» (по частоте):

| Причина | Что видно | Лечение |
|---|---|---|
| **Дублирование ключа**: одна и та же сессия запущена из двух мест (tdata + pyrogram + бот, копия `.session` на двух ПК, «на всякий случай запущу параллельно») | `AUTH_KEY_DUPLICATED` (406). Telegram **уничтожает** ключ в течение ~минуты | Только новый логин. Больше не поднимать два клиента с одним ключом |
| **Авто-завершение по неактивности**: по умолчанию 180 дней; в Telegram настраивается 1 нед / 3 / 6 / 12 мес | `AuthKeyUnregistered`, сессия пропала из «Устройств» | Новый логин |
| **«Завершить все сессии»** в настройках (или выход с устройства), смена пароля с «выйти везде» | `AuthKeyUnregistered` / `AuthKeyInvalid` | Новый логин |
| **Публичный `api_id`** (2040, 4, 6 и прочие «tdesktop-хэши» из интернета) попал под фильтр | `API_ID_PUBLISHED_FLOOD` | Завести свой api_id на <https://my.telegram.org/apps> |
| **Спам-блок/бан аккаунта** (в т.ч. за автоматизацию, массовые рассылки) | `PhoneNumberBanned`, `UserDeactivatedBan` | Ключ тут не поможет — сначала разблокировка |
| Ключ просто не для этого DC / обрезан / скопирован с пробелом | `AuthKeyUnregistered`, рвётся соединение | Новый логин / починить строку |

В демонстрационном примере (`main.py` из вопроса) используется
**невалидный** `auth_key` — он синтаксически корректен (256 байт, правильная
структура), но на сервере не зарегистрирован, поэтому `get_me()` не сработает.
Это ожидаемо: рабочий ключ можно получить только логином (см. ниже).

---

## 2. Подготовка

1. Python 3.9+ (проверено на 3.11), `pip install -r tools/telegram_session/requirements.txt`
   (ставит `telethon`; для QR в терминале по желанию `pip install qrcode`).
2. **Свой `api_id`/`api_hash`** с <https://my.telegram.org/apps> — настоятельно
   рекомендуется. Значения по умолчанию в скрипте (2040 + tdesktop-хэш) оставлены
   для совместимости с примером, но это публичный api_id, за который Telegram
   периодически выдаёт ошибки и ограничения.
3. Аккаунт, к которому есть доступ: телефон под рукой либо уже авторизованный
   Telegram (для QR-логина).
4. 2FA-пароль, если он включён в аккаунте (скрипт спросит).

Скрипт сам ничего не пишет в git-каталог: экспорт кладётся в
`tools/telegram_session/out/` (игнорируется Git), session-файл после успешной
выгрузки удаляется, чтобы случайно не поднять второй клиент с тем же ключом.

---

## 3. Вариант A (рекомендую): логин по QR — самый быстрый на компьютере

```bash
python tools/telegram_session/login_and_export.py --qr
```

1. Скрипт печатает QR прямо в терминале (если установлен `qrcode`) и
   дополнительно ссылку вида `tg://login?token=…`.
2. На телефоне: **Telegram → Настройки → Устройства → Подключить устройство →
   «Сканировать QR»** — и навести камеру на QR в терминале.
3. Если QR не рисовался (нет пакета `qrcode`) — открой `tg://login?token=…`
   в уже авторизованном Telegram: на телефоне просто открой ссылку, на ПК —
   вставь её в «Избранное» и кликни по ней.
4. Если включён пароль 2FA — скрипт попросит его ввести (`SessionPasswordNeededError`
   обрабатывается автоматически). Пароль можно передать заранее через переменную
   окружения `TELEGRAM_2FA_PASSWORD`.
5. QR живёт ~30–60 секунд. Если истёк — скрипт предложит обновить (`recreate()`).

Нюанс: тот клиент, который сканирует QR, должен быть авторизован **в том же
аккаунте**, ключ которого вы хотите получить. Логиниться «в другой аккаунт» и
ждать нужный ключ бессмысленно.

## 4. Вариант B: логин по номеру телефона + код (и пароль 2FA)

```bash
python tools/telegram_session/login_and_export.py --phone +79991234567
# если код приходит только SMS: добавь --force-sms
```

* код приходит **в Telegram**, а не по SMS (обычно служебным сообщением);
  вводить его нужно «как показано» — если Telegram показывает код-обманку, не
  переписывай цифры;
* неверный код → скрипт попросит ещё раз (`PhoneCodeInvalid`), истёкший —
  запросит новый (`PhoneCodeExpired`);
* если у аккаунта есть пароль 2FA, будет запрошен ввод пароля
  (`TELEGRAM_2FA_PASSWORD` тоже подходит);
* `FloodWaitError` («подожди N секунд») — Telegram реально требует подождать,
  ускорять бесполезно.

## 5. Вариант C: аккаунт уже залогинен — просто разбери сессию

Логин не нужен, если есть живая session-строка (Telethon/Pyrogram) или
`.session`-файл:

```bash
# разобрать любую session-строку (Telethon / Pyrogram v2 / Pyrogram v1)
python tools/telegram_session/login_and_export.py --from-session-string "1BVtsOK..."

# остался SQLite-файл от Telethon/Pyrogram — запусти без флагов:
python tools/telegram_session/login_and_export.py --session-file ~/old/session.session

# есть сохранённый JSON от этого скрипта — пересобери строки (Telethon <-> Pyrogram)
python tools/telegram_session/login_and_export.py --from-json out/session_123_20261005-120000.json
```

---

## 6. Что именно выдаёт скрипт

```
── РЕЗУЛЬТАТ: auth_key + dc_id ─────────────────────────────────────────
dc_id          : 5
DC адрес       : 91.108.56.130:443
auth_key (hex) :
  5c1b…(512 hex-символов)…9f2a
user_id        : 123456789
username       : my_account
api_id         : 2040
── StringSession (Telethon) ────────────────────────────────────────────
1BVtsOK4Bu…            <- готовая строка, вставляй в StringSession("…")
── Session string (Pyrogram v2) ────────────────────────────────────────
BAAAAA…                <- готовая строка для pyrogram/kurigram
```

Использование:

```python
# Telethon
from telethon import TelegramClient
from telethon.sessions import StringSession

client = TelegramClient(StringSession("1BVtsOK…"), api_id=2040, api_hash="…")
```

```python
# Pyrogram v2 / kurigram
from pyrogram import Client

app = Client("my", api_id=2040, api_hash="…", session_string="BAAAAA…")
```

```python
# ваш собственный энкодер — теперь с рабочим ключом
from tools.telegram_session.telegram_session_encoder import TelegramSessionEncoder
from telethon import TelegramClient
from telethon.sessions import StringSession

enc = TelegramSessionEncoder(auth_key=bytes.fromhex(AUTH_KEY_HEX), dc_id=DC_ID)
client = TelegramClient(StringSession(enc.to_string()), api_id=2040, api_hash="…")
```

```ts
// gramjs (npm "telegram") читает тот же формат, что Telethon:
// dc_id(1) | ip(4) | port(2) | auth_key(256), с префиксом версии "1".
const client = new TelegramClient(new StringSession(telethonString), apiId, apiHash, {});
```

Что важно помнить про `api_id`: используйте тот же `api_id`/`api_hash`, которым
логинились. Ключ технически не «приклеен» к api_id, но Telegram привязывает
сессию к приложению — смена api_id даёт лишние проверки и ошибки.

---

## 7. Как не убить новый ключ (правила)

1. **Один ключ = один клиент одновременно.** Никогда не запускайте два процесса
   со одной сессией (второй запуск бэкапа `.session`, параллельный бот, «проверю
   ключ в другом скрипте, пока работает основной» → `AUTH_KEY_DUPLICATED`, ключ
   умирает в течение минуты).
2. **Нужно несколько процессов на один аккаунт — делайте несколько сессий**
   (несколько логинов), а не копию ключа. В Telegram они будут видны как
   отдельные устройства, и это нормально.
3. **Не передавайте ключ по чатам/в git.** Строка `1BVts…` = полный доступ к
   аккаунту (без 2FA — вместе с возможностью сменить аккаунт). Храните в
   секретах: Cloudflare Worker Secrets, `.env` (он в `.gitignore`), менеджер паролей.
4. **Держите аккаунт живым**: посещайте его хотя бы раз в 6 месяцев либо
   отключите авто-завершение неактивных сессий (Настройки → Приватность →
   Активные сессии → «Если неактивна»).
5. **Не устраивайте резких скачков** «одна сессия с 5 стран за час» — Telegram
   такое воспринимает как угон и может ограничить/завершить сессию.
6. **Храните бэкап `auth_key` + `dc_id`** (именно пара, а не только строку: строку
   под нужную библиотеку всегда можно собрать заново — см. §8).
7. 2FA обязателен: с ним украденный ключ/строка даёт гораздо меньше.

---

## 8. Форматы session-строк и правки к исходному коду

| Клиент | Формат (big-endian) | Длина |
|---|---|---|
| Telethon | `"1" + base64url( dc_id:u8 \| ip:4\|16 \| port:u16 \| auth_key:256 )` | 353 симв. (IPv4) |
| Pyrogram v2 / kurigram | `base64url( dc_id:u8 \| api_id:u32 \| test:bool \| auth_key:256 \| user_id:u64 \| is_bot:bool )` без `=` | 362 симв. |
| Pyrogram v1 (старые строки) | `base64url( dc_id:u8 \| test:bool \| auth_key:256 \| user_id:u32\|u64 \| is_bot:bool )` | 351 / 356 симв. |
| GramJS (`npm telegram`) | читает формат Telethon; свои строки сохраняет иначе | — |
| Telegram Desktop `tdata` | собственный формат (map + AES-шифрование ключа) | — |

Строки **Telethon и Pyrogram несовместимы** — это разные структуры, а не разные
обёртки. Поэтому «источник истины» — `auth_key` + `dc_id` (и `api_id`/`user_id`
для Pyrogram), из которых собирается строка под нужный клиент.

Исходный `telegram_session_encoder.py` из вопроса **в целом корректен** — формат
`>B{4|16}sH256s` совпадает с Telethon (проверено сравнением с
`StringSession.save()` байт-в-байт). Что стоит поправить:

1. **Утечка ключа в логи.** `@dataclass` автоматически генерирует `__repr__`,
   который печатает `auth_key` целиком: любое `print(encoder)` или трейсбек
   выльет ключ в консоль/лог. В исправленной версии `__repr__` переопределён.
2. **Адрес DC берётся из жёсткой таблицы.** Таблица актуальна (совпадает с
   `Pyrogram.DataCenter.PROD`), но Telegram меняет адреса. Надёжнее подставить
   `client.session.server_address` и `port` из живой сессии — в исправленной
   версии это делает `TelegramSessionEncoder.from_live_session(...)`.
3. **Нет обратной операции.** Главная задача «достать auth_key и dc_id» требовала
   ручного `struct.unpack` — добавлен `parse_session_string()` с авто-определением
   формата (Telethon / Pyrogram v2 / Pyrogram v1).
4. **Нет Pyrogram-строки.** Добавлен `to_pyrogram_string(api_id, user_id)`.
5. **Нет валидации** `dc_id`/`port` и молчаливое падение на неверном ключе —
   добавлены проверки и понятные сообщения (`auth_key` ровно 256 байт; `dc_id`
   без адреса в таблице → нужно передать `server_address` явно).
6. **Ключ принимается только `bytes`.** Теперь принимается и hex-строка
   (512 символов) — удобно копировать из таблицы/JSON.
7. `_VERSION`/`_PORT` как `ClassVar` и `Mapping` из `typing` — рабочая, но лишняя
   экзотика; в исправленной версии используются обычные константы модуля.

Исправленный модуль лежит в
[`tools/telegram_session/telegram_session_encoder.py`](tools/telegram_session/telegram_session_encoder.py),
тесты — в [`tools/telegram_session/test_telegram_session_encoder.py`](tools/telegram_session/test_telegram_session_encoder.py)
(11 тестов; часть из них сверяет результат с установленными `telethon`/`pyrogram`).

---

## 9. Прокси: если MTProto не проходит

Признак: `Server closed the connection: 0 bytes read…`, `IncompleteReadError`,
вечное «connecting». Это фильтрация MTProto у провайдера (DPI), а не проблема
ключа.

```bash
# SOCKS5/HTTP (нужен python-socks: pip install "telethon[socks]")
python tools/telegram_session/login_and_export.py --qr \
  --proxy socks5://user:pass@host:1080

# MTProto-прокси Telegram (secret в hex)
python tools/telegram_session/login_and_export.py --qr \
  --mtproxy 1.2.3.4:443:ee00000000000000000000000000000000
```

В коде это выглядит так:

```python
from telethon import TelegramClient
from telethon.network import ConnectionTcpMTProxyRandomizedIntermediate

client = TelegramClient(session, api_id, api_hash, proxy={
    "proxy_type": "socks5", "addr": "1.2.3.4", "port": 1080,
    "username": "user", "password": "pass", "rdns": True,
})
# либо MTProxy:
client = TelegramClient(session, api_id, api_hash,
                        connection=ConnectionTcpMTProxyRandomizedIntermediate,
                        proxy=("1.2.3.4", 443, "ee00000000000000000000000000000000"))
```

---

## 10. Частые ошибки и что делать

| Ошибка | Что значит | Что делать |
|---|---|---|
| `AUTH_KEY_DUPLICATED` | Ключ используется из двух мест; Telegram его уничтожил | Новый логин; больше не дублировать сессию |
| `AuthKeyUnregistered`, `AuthKeyInvalid` | Сессия завершена/ключ не зарегистрирован | Новый логин (`--from-session-string` покажет, что строка целая, но мёртвая) |
| `API_ID_PUBLISHED_FLOOD` | Публичный api_id под фильтром | Свой api_id на my.telegram.org |
| `SESSION_PASSWORD_NEEDED` | Включён 2FA | Скрипт сам спросит пароль; или `TELEGRAM_2FA_PASSWORD` |
| `PhoneCodeInvalid` / `PhoneCodeExpired` | Код неверный/истёк | Ввести заново; истёк → скрипт запросит новый |
| `FloodWaitError(seconds=N)` | Лимит попыток | Ждать N секунд (или больше) |
| `PhoneNumberBanned`, `UserDeactivatedBan` | Аккаунт заблокирован | Разблокировка через поддержку; ключи не помогут |
| `IncompleteReadError`, «Server closed the connection» | MTProto режет провайдер | `--proxy` / `--mtproxy` / VPN |
| `sqlite3.OperationalError: database is locked` | С тем же `.session` работает второй процесс | Остановить второй процесс; для параллельных нужд — отдельный логин |
| `proxy argument will be ignored because python-socks is not installed` | Нет зависимости для прокси | `pip install "telethon[socks]"` |
| QR «истёк» (`TimeoutError`) | Не успели просканировать | Скрипт предложит обновить QR |
| `You must be connected before invoking this` | `qr_login()` вызвали до `connect()` | В скрипте порядок уже правильный |

---

## 11. Безопасность и правила Telegram

* Используйте инструмент **только для своих аккаунтов**. `auth_key` = полный
  доступ к аккаунту; передача ключа третьим лицам — это передача аккаунта.
* Автоматизация (рассылки, массовые подписки, фарм) нарушает ToS Telegram и
  приводит к спам-блоку аккаунта и невозможности авторизоваться вовсе.
* Никогда не коммитьте `auth_key`, session-строки и `out/*.json` в git; для
  продакшена (например, Cloudflare Workers) — только Secrets.
* Включите 2FA и держите под контролем список «Активных сессий».

## 12. Файлы инструмента

| Файл | Назначение |
|---|---|
| [`tools/telegram_session/telegram_session_encoder.py`](tools/telegram_session/telegram_session_encoder.py) | сборка/разбор строк: Telethon, Pyrogram v1/v2; `from_live_session`, `parse_session_string` |
| [`tools/telegram_session/login_and_export.py`](tools/telegram_session/login_and_export.py) | CLI: логин (QR/телефон), выгрузка `auth_key` + `dc_id`, режимы `--from-session-string`, `--from-json`, `--self-test` |
| [`tools/telegram_session/test_telegram_session_encoder.py`](tools/telegram_session/test_telegram_session_encoder.py) | 11 тестов форматов (+ сверка с `telethon`/`pyrogram`, если установлены) |
| [`tools/telegram_session/requirements.txt`](tools/telegram_session/requirements.txt) | зависимости инструмента |
