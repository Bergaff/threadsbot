#!/usr/bin/env node
/**
 * Cookie Relay - локальный сборщик куки для Threads.
 *
 * ЗАЧЕМ
 * -----
 * Воркер на Cloudflare выходит из датацентровых IP, прокси Browser Rendering не
 * поддерживает. Логиниться в Threads оттуда опасно: Meta отвечает checkpoint, а
 * повторные автологины с датацентра ведут к вечному бану аккаунта.
 *
 * Поэтому авторизованные сессии живут ЗДЕСЬ, на вашей машине: residential-IP,
 * настоящий браузер, настоящий фингерпринт. Скрипт снимает свежие куки и пушит
 * их в воркер через существующий массовый импорт.
 *
 * ПАРОЛИ НЕ ПОКИДАЮТ ЭТУ МАШИНУ.
 * Скрипт ничего не отправляет на сервер, кроме самих куки и имени аккаунта.
 * Логины, пароли и TOTP-сиды читаются только из локального accounts.local.json,
 * который закрыт .gitignore и существует исключительно для автозаполнения формы.
 *
 * УСТАНОВКА
 * ---------
 *   npm i -D playwright
 *   npx playwright install chromium
 *   cp tools/accounts.example.json tools/accounts.local.json   # и заполнить
 *
 * ЗАПУСК
 * ------
 *   node tools/cookie-relay.mjs                 # один проход по всем аккаунтам
 *   node tools/cookie-relay.mjs --push          # снять куки и отправить в воркер
 *   node tools/cookie-relay.mjs --watch 6       # повторять каждые 6 часов
 *   node tools/cookie-relay.mjs --only wolf.8385407
 *
 * Первый вход по каждому аккаунту делается руками в открывшемся окне. Дальше
 * профиль браузера хранится в tools/profiles/<имя>, сессия остаётся живой, и
 * повторные запуски просто снимают обновлённые куки без всякого логина.
 */

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PROFILES_DIR = join(HERE, "profiles");
const OUT_DIR = join(HERE, "out");
const ACCOUNTS_FILE = join(HERE, "accounts.local.json");
const EXAMPLE_FILE = join(HERE, "accounts.example.json");

// Куки нужны только этих доменов: остальное - телеметрия и мусор.
const KEEP_DOMAINS = [".threads.net", ".threads.com", ".instagram.com"];

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const optValue = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SHOULD_PUSH = flag("push");
const WATCH_HOURS = optValue("watch") ? Number(optValue("watch")) : 0;
const ONLY = optValue("only");
const SITE_URL = optValue("site", process.env.RELAY_SITE_URL || "https://threadsviewer.online");
const ADMIN_PASSWORD = process.env.RELAY_ADMIN_PASSWORD || "";

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) - локально, сид никуда не отправляется
// ---------------------------------------------------------------------------
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, stepSeconds = 30, digits = 6) {
  const key = base32Decode(secret);
  if (key.length === 0) return null;
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(buf).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

// ---------------------------------------------------------------------------
// Конфиг аккаунтов
// ---------------------------------------------------------------------------
function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) {
    console.error(
      `\nНет файла ${EXAMPLE_FILE.replace(ROOT + "/", "")}.\n` +
        `Скопируйте пример и заполните:\n\n` +
        `  cp tools/accounts.example.json tools/accounts.local.json\n\n` +
        `Поля username/password/totpSecret НЕОБЯЗАТЕЛЬНЫ и нужны только для\n` +
        `автозаполнения формы. Можно оставить одно имя и войти руками.\n`
    );
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.accounts || [];
  return list
    .map((a) => (typeof a === "string" ? { name: a } : a))
    .filter((a) => a && a.name)
    .filter((a) => (ONLY ? a.name === ONLY : true));
}

// ---------------------------------------------------------------------------
// Работа с браузером
// ---------------------------------------------------------------------------
function keepOnlyThreadsCookies(cookies) {
  return cookies.filter((c) => KEEP_DOMAINS.some((d) => String(c.domain || "").endsWith(d)));
}

function hasSessionCookie(cookies) {
  return cookies.some((c) => c.name === "sessionid" && c.value && c.value.length > 8);
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question(prompt, () => { rl.close(); r(); }));
}

/**
 * Ждёт появления sessionid. Возвращает true, если дождались.
 * Параллельно следит за checkpoint: если Meta требует подтверждение,
 * сообщаем об этом сразу, а не по истечении таймаута.
 */
async function waitForSession(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let warnedCheckpoint = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    if (hasSessionCookie(keepOnlyThreadsCookies(cookies))) return true;

    const page = context.pages()[0];
    if (page && !warnedCheckpoint) {
      const url = page.url();
      if (/checkpoint|challenge|two_step|suspicious/i.test(url)) {
        log("  Meta запросила подтверждение (checkpoint). Пройдите её в окне браузера.");
        warnedCheckpoint = true;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function harvestAccount(chromium, account) {
  const name = String(account.name).replace(/[^\w.-]/g, "_").slice(0, 64);
  const profileDir = join(PROFILES_DIR, name);
  mkdirSync(profileDir, { recursive: true });

  log(`Аккаунт ${name}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1180, height: 900 },
    locale: account.locale || "en-US",
    timezoneId: account.timezone || "Europe/London",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://www.threads.net/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    let cookies = keepOnlyThreadsCookies(await context.cookies().catch(() => []));

    if (hasSessionCookie(cookies)) {
      log("  Сессия уже живая в локальном профиле - вход не требуется");
    } else {
      // Threads авторизуется инстаграм-учёткой, и sessionid ставится на домен
      // .instagram.com. Поэтому вход через Instagram даёт те же куки, что нужны
      // Threads, и иногда проходит мягче, чем форма входа на самом Threads.
      const via = String(account.loginVia || "threads").toLowerCase();
      const loginUrl =
        via === "instagram" || via === "ig"
          ? "https://www.instagram.com/accounts/login/"
          : "https://www.threads.net/login";
      log(`  Локальная сессия отсутствует, нужен вход через ${via === "instagram" || via === "ig" ? "Instagram" : "Threads"}`);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));

      // Автозаполнение - только если данные лежат в ЛОКАЛЬНОМ файле.
      if (account.username && account.password) {
        const filled = await autofill(page, account).catch((e) => {
          log(`  Автозаполнение не сработало (${e.message}) - введите данные вручную`);
          return false;
        });
        if (filled) log("  Поля заполнены из локального конфига, нажмите вход в окне браузера");
      }

      // Код 2FA считаем локально и показываем в консоли. Сид никуда не уходит.
      if (account.totpSecret) {
        const code = totp(account.totpSecret);
        if (code) log(`  Код 2FA сейчас: ${code} (обновится через ${30 - (Math.floor(Date.now() / 1000) % 30)} сек)`);
      }

      const ok = await waitForSession(context, 5 * 60_000);
      if (!ok) {
        await waitForEnter("  Не дождался sessionid. Завершите вход и нажмите Enter (или Ctrl+C для пропуска)... ");
      }

      // После входа через Instagram заходим на Threads, чтобы он подхватил
      // инстаграм-сессию и проставил собственные куки домена .threads.net.
      if (via === "instagram" || via === "ig") {
        log("  Переношу сессию на Threads...");
        await page.goto("https://www.threads.net/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 4000));
      }

      cookies = keepOnlyThreadsCookies(await context.cookies().catch(() => []));
    }

    if (!hasSessionCookie(cookies)) {
      log("  БЕЗРЕЗУЛЬТАТНО: sessionid не получен, куки не сохраняем");
      return null;
    }

    const outFile = join(OUT_DIR, `${name}.json`);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(outFile, JSON.stringify(cookies, null, 2), "utf8");
    log(`  Сохранено ${cookies.length} куки -> tools/out/${name}.json`);

    return { name, cookies, file: outFile };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Заполняет форму входа. Селекторы Meta меняются, поэтому пробуем несколько
 * вариантов и не падаем: если не вышло, пользователь введёт данные руками.
 */
async function autofill(page, account) {
  const userSelectors = ['input[name="username"]', 'input[type="text"][autocomplete="username"]', 'input[aria-label*="sername" i]'];
  const passSelectors = ['input[name="password"]', 'input[type="password"]'];

  const fillFirst = async (selectors, value) => {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await el.fill("").catch(() => {});
        await el.type(value, { delay: 35 }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  const okUser = await fillFirst(userSelectors, account.username);
  const okPass = await fillFirst(passSelectors, account.password);
  if (!okUser || !okPass) return false;

  await new Promise((r) => setTimeout(r, 600));
  const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Войти")'];
  for (const sel of submitSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      return true;
    }
  }
  return true; // поля заполнены, кнопку пользователь нажмёт сам
}

// ---------------------------------------------------------------------------
// Отправка в воркер
// ---------------------------------------------------------------------------
async function pushToWorker(results) {
  if (!ADMIN_PASSWORD) {
    log("RELAY_ADMIN_PASSWORD не задан - пропускаю отправку. Куки лежат в tools/out/");
    return false;
  }

  const bulk = results
    .map((r) => `${r.name}\n${JSON.stringify(r.cookies)}`)
    .join("\n---\n");

  // Логинимся один раз, чтобы получить сессионную куку админки.
  const loginForm = new FormData();
  loginForm.append("password", ADMIN_PASSWORD);
  const loginRes = await fetch(`${SITE_URL}/admin/login`, {
    method: "POST",
    body: loginForm,
    redirect: "manual",
  }).catch((e) => { log(`Не удалось достучаться до ${SITE_URL}: ${e.message}`); return null; });
  if (!loginRes) return false;

  const setCookie = loginRes.headers.getSetCookie?.() || [loginRes.headers.get("set-cookie")].filter(Boolean);
  const cookieHeader = setCookie.map((c) => String(c).split(";")[0]).join("; ");
  if (!cookieHeader.includes("admin_session")) {
    log("Админка не выдала сессионную куку - проверьте RELAY_ADMIN_PASSWORD");
    return false;
  }

  const form = new FormData();
  form.append("bulk", bulk);
  const res = await fetch(`${SITE_URL}/admin/api/account/add-bulk`, {
    method: "POST",
    body: form,
    headers: { cookie: cookieHeader },
  }).catch((e) => { log(`Ошибка отправки: ${e.message}`); return null; });
  if (!res) return false;

  const data = await res.json().catch(() => ({}));
  if (data.ok) log(`Отправлено в воркер: сохранено ${data.saved} из ${data.total}`);
  else log(`Воркер принял не всё: ${JSON.stringify(data).slice(0, 300)}`);
  return Boolean(data.ok);
}

// ---------------------------------------------------------------------------
// Главный цикл
// ---------------------------------------------------------------------------
async function runOnce() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("\nPlaywright не установлен. Выполните:\n\n  npm i -D playwright\n  npx playwright install chromium\n");
    process.exit(1);
  }

  const accounts = loadAccounts();
  if (!accounts.length) {
    log("Список аккаунтов пуст");
    return;
  }

  mkdirSync(PROFILES_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  log(`Аккаунтов к обработке: ${accounts.length}`);
  const results = [];
  for (const account of accounts) {
    try {
      const r = await harvestAccount(chromium, account);
      if (r) results.push(r);
    } catch (e) {
      log(`  Ошибка на ${account.name}: ${e.message}`);
    }
    // Не долбим Threads подряд: пауза между аккаунтами снижает риск checkpoint.
    await new Promise((r) => setTimeout(r, 4000));
  }

  log(`Итог: куки сняты с ${results.length} из ${accounts.length} аккаунтов`);
  if (results.length && SHOULD_PUSH) await pushToWorker(results);
}

if (WATCH_HOURS > 0) {
  log(`Режим наблюдения: повтор каждые ${WATCH_HOURS} ч. Ctrl+C для остановки.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce().catch((e) => log(`Сбой прохода: ${e.message}`));
    await new Promise((r) => setTimeout(r, WATCH_HOURS * 3600_000));
  }
} else {
  await runOnce();
}
