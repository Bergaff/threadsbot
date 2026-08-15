# Threads Reader Bot — Cloudflare Workers

TypeScript-версия Telegram-бота для Cloudflare Workers. Функционал Python-версии сохранён:

- чтение постов Threads как текстом, так и скриншотами;
- загрузка комментариев ответом на сообщение с постом;
- ротация нескольких «технических» Threads-аккаунтов по cookies;
- бесплатные дневные/месячные лимиты, rate limit и кеш;
- Telegram Stars и Crypto Bot;
- RU/EN/DE/ES/PT, поддержка, тикеты, баны и админская аналитика;
- ежедневный отчёт администраторам.

## Архитектура

- **Worker webhook** вместо постоянно работающего Python polling-процесса;
- **Cloudflare D1** вместо локального SQLite и оперативных словарей;
- **Cloudflare Browser Rendering** (`@cloudflare/playwright`) вместо локального Chromium;
- cookies аккаунтов хранятся в D1, автоматически обновляются после успешного запроса.

> Browser Rendering должен быть включён в аккаунте Cloudflare. Его стоимость и лимиты зависят от тарифа Cloudflare — сам Worker не может запускать обычный серверный Chromium.

## Развёртывание

### Google Colab — установка по ячейкам

Откройте [`notebooks/threadsbot_cloudflare_deploy.ipynb`](notebooks/threadsbot_cloudflare_deploy.ipynb) в Google Colab. Это самостоятельный установщик: исходники создаются прямо в Colab отдельными `%%writefile`-ячейками, поэтому предварительно клонировать репозиторий не требуется. Ноутбук:

1. создаёт все файлы TypeScript-проекта из текущей версии кода;
2. скрыто принимает GitHub Personal Access Token, создаёт репозиторий и пушит код;
3. скрыто принимает Cloudflare API Token и Account ID;
4. создаёт или повторно использует D1 и Queue, подставляя D1 UUID в `wrangler.toml`;
5. загружает cookies только во временное приватное хранилище Colab;
6. импортирует cookies непосредственно в D1 и сразу удаляет локальные файлы;
7. при необходимости переносит старый `bot.db`;
8. добавляет секреты, развёртывает Worker и устанавливает webhook.

GitHub и Cloudflare токены вводятся через `getpass`, не записываются в проект и очищаются в финальной ячейке. Cookies не отправляются в GitHub. После импорта Worker автоматически обновляет их прямо в D1 после успешных запросов Threads.

### 1. Установить зависимости

```bash
npm install
npx wrangler login
```

### 2. Создать D1 и очередь обновлений

Очередь нужна, чтобы Telegram сразу получил `200 OK`, а чтение Threads могло безопасно продолжаться дольше 30 секунд без повторных webhook-запросов.

```bash
npx wrangler d1 create threadsbot
npx wrangler queues create threadsbot-updates
```

Скопируйте полученный `database_id` в `wrangler.toml` вместо `REPLACE_WITH_D1_DATABASE_ID`, затем:

```bash
npm run db:remote
```

### 3. Добавить секреты

```bash
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put CRYPTO_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`WEBHOOK_SECRET` — произвольная длинная случайная строка без пробелов. ID администраторов меняются в `wrangler.toml`.

### 4. Импортировать аккаунты Threads

Файлы остаются в прежнем формате: `accounts/name.json` (Cookie-Editor JSON или Playwright cookies). Они игнорируются Git и не попадут в репозиторий.

```bash
npm run accounts:import -- accounts --remote
```

Скрипт проверяет JSON, импортирует каждый файл в D1 и удаляет временный SQL-файл. Фейковые/технические аккаунты не убраны: бот выбирает живой аккаунт с наименьшей часовой нагрузкой, сохраняет обновлённые cookies и переключается на следующий при истёкшей сессии или ошибке.

Если нужно перенести также пользователей, подписки, лимиты, кеш, тикеты и аналитику из старого `data/bot.db`, вместо отдельного импорта выполните:

```bash
python3 scripts/migrate_legacy.py --db data/bot.db --accounts accounts
```

Скрипт переносит SQLite-таблицы и cookies в D1, не добавляя временный экспорт в Git.

### 5. Deploy и webhook

```bash
npm run deploy
curl -X POST "https://YOUR-WORKER.workers.dev/setup-webhook" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET"
```

Проверка состояния:

```bash
curl https://YOUR-WORKER.workers.dev/health
```

## Локальная проверка

```bash
npm run db:local
npm run typecheck
npm test
npm run dev
```

Локальная эмуляция Browser Rendering может отличаться от production. Полную проверку чтения Threads лучше делать после deploy с одним тестовым аккаунтом.

## Безопасность

- Не коммитьте `.dev.vars`, `.env`, `accounts/` и экспорт cookies.
- Cookies дают доступ к Threads-аккаунтам: используйте отдельные аккаунты с минимальными правами.
- Endpoint Telegram защищён и секретным URL, и заголовком `X-Telegram-Bot-Api-Secret-Token`.
- Пользовательский текст экранируется перед отправкой в Telegram HTML.

## Старый Python-код

`bot.py` и `threads_check.py` оставлены как референс для сверки поведения. Production entrypoint теперь `src/index.ts`.
