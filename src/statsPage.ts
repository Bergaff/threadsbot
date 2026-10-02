/**
 * Страница статистики для рекламодателей / рекламных бирж: /stats
 *
 * - Отдельный логин и пароль (НЕ пароль админки). Задаются в админке, хранятся в D1
 *   как PBKDF2-SHA256 хеш с солью. Запасной вариант - переменные STATS_LOGIN / STATS_PASSWORD.
 * - Только агрегированные цифры о людях: никаких аккаунтов, логов, внутренностей скрапера.
 * - Защита от перебора, отзыв сессий при смене пароля, noindex.
 */
import type { Env } from "./config";
import { Database, type AdvertiserReport, type ShareRow } from "./db";

const SESSION_TTL_MS = 7 * 86_400_000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;
const PBKDF2_ITER = 100_000; // максимум, который поддерживает Workers runtime

type Lang = "ru" | "en";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const hex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/.{2}/g) || []).map((x) => parseInt(x, 16)));

async function pbkdf2(password: string, saltHex: string, iter = PBKDF2_ITER): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: iter }, key, 256);
  return hex(bits);
}

/** Сравнение без утечки по времени */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(24)));
}

interface StoredAccess { login: string; salt: string; hash: string; iter: number; updatedAt?: string }

async function loadAccess(db: Database): Promise<StoredAccess | null> {
  const raw = await db.state(0, "stats_access").catch(() => null);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StoredAccess;
    return p && p.login && p.salt && p.hash ? p : null;
  } catch {
    return null;
  }
}

/** Для админки: какой логин сейчас настроен и откуда. */
export async function statsAccessInfo(env: Env): Promise<{ login: string; source: "admin" | "env" } | null> {
  const db = new Database(env);
  const stored = await loadAccess(db);
  if (stored) return { login: stored.login, source: "admin" };
  if (env.STATS_LOGIN && env.STATS_PASSWORD) return { login: env.STATS_LOGIN, source: "env" };
  return null;
}

export async function setStatsAccess(env: Env, login: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const l = login.trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(l)) return { ok: false, error: "Логин: 3-64 символа, латиница, цифры, . _ @ -" };
  if (password.length < 8) return { ok: false, error: "Пароль должен быть не короче 8 символов" };
  const db = new Database(env);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(password, salt);
  await db.setState(0, "stats_access", JSON.stringify({ login: l, salt, hash, iter: PBKDF2_ITER, updatedAt: new Date().toISOString() }));
  // Смена пароля отзывает все открытые сессии
  await db.clearState(0, "stats_sessions").catch(() => {});
  await db.clearState(0, "stats_login_fails").catch(() => {});
  return { ok: true };
}

export async function clearStatsAccess(env: Env): Promise<void> {
  const db = new Database(env);
  await db.clearState(0, "stats_access").catch(() => {});
  await db.clearState(0, "stats_sessions").catch(() => {});
}

async function checkCredentials(env: Env, db: Database, login: string, password: string): Promise<boolean> {
  const stored = await loadAccess(db);
  if (stored) {
    const h = await pbkdf2(password, stored.salt, stored.iter || PBKDF2_ITER);
    return safeEqual(login.trim().toLowerCase(), stored.login.toLowerCase()) && safeEqual(h, stored.hash);
  }
  if (env.STATS_LOGIN && env.STATS_PASSWORD) {
    return safeEqual(login.trim().toLowerCase(), env.STATS_LOGIN.toLowerCase()) && safeEqual(password, env.STATS_PASSWORD);
  }
  return false;
}

async function loadSessions(db: Database): Promise<Record<string, string>> {
  const raw = await db.state(0, "stats_sessions").catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const now = Date.now();
    const out: Record<string, string> = {};
    for (const [t, exp] of Object.entries(parsed || {})) {
      if (t.length >= 32 && new Date(exp).getTime() > now) out[t] = exp;
    }
    return out;
  } catch {
    return {};
  }
}

function sessionToken(request: Request): string {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)stats_session=([^;]+)/);
  return m ? m[1].trim() : "";
}

export async function verifyStatsSession(request: Request, env: Env): Promise<boolean> {
  const token = sessionToken(request);
  if (token.length < 32) return false;
  const sessions = await loadSessions(new Database(env));
  return Boolean(sessions[token]);
}

async function lockoutLeft(db: Database): Promise<number> {
  const raw = await db.state(0, "stats_login_fails").catch(() => null);
  if (!raw) return 0;
  try {
    const { count, at } = JSON.parse(raw) as { count: number; at: number };
    if ((count || 0) < MAX_FAILS) return 0;
    const left = (at || 0) + LOCKOUT_MS - Date.now();
    return left > 0 ? left : 0;
  } catch {
    return 0;
  }
}

async function registerFail(db: Database): Promise<void> {
  let count = 0, at = 0;
  const raw = await db.state(0, "stats_login_fails").catch(() => null);
  if (raw) { try { ({ count, at } = JSON.parse(raw)); } catch {} }
  if (!at || Date.now() - at > LOCKOUT_MS) { count = 0; at = Date.now(); }
  await db.setState(0, "stats_login_fails", JSON.stringify({ count: (count || 0) + 1, at }));
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function pickLang(request: Request): Lang {
  const url = new URL(request.url);
  const q = url.searchParams.get("lang");
  if (q === "en" || q === "ru") return q;
  const c = (request.headers.get("cookie") || "").match(/(?:^|;\s*)stats_lang=(ru|en)/);
  if (c) return c[1] as Lang;
  return /^ru|^be|^uk|^kk/i.test(request.headers.get("accept-language") || "") ? "ru" : "en";
}

export async function handleStatsRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/stats";
  const db = new Database(env);
  const lang = pickLang(request);
  const langCookie = `stats_lang=${lang}; Path=/stats; Secure; SameSite=Lax; Max-Age=31536000`;

  if (path === "/stats/login" && request.method === "POST") {
    const left = await lockoutLeft(db);
    if (left > 0) return loginPage(lang, T[lang].locked(Math.ceil(left / 60_000)), 429);
    const form = await request.formData().catch(() => null);
    const login = String(form?.get("login") || "");
    const password = String(form?.get("password") || "");
    if (login && password && (await checkCredentials(env, db, login, password))) {
      const sessions = await loadSessions(db);
      const token = newToken();
      sessions[token] = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      await db.setState(0, "stats_sessions", JSON.stringify(sessions));
      await db.clearState(0, "stats_login_fails").catch(() => {});
      const headers = new Headers({ Location: `/stats?lang=${lang}`, ...SECURITY_HEADERS });
      headers.append("Set-Cookie", `stats_session=${token}; Path=/stats; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
      headers.append("Set-Cookie", langCookie);
      return new Response(null, { status: 302, headers });
    }
    await registerFail(db);
    return loginPage(lang, T[lang].badLogin, 401);
  }

  if (path === "/stats/logout") {
    const token = sessionToken(request);
    if (token) {
      const sessions = await loadSessions(db);
      if (delete sessions[token]) await db.setState(0, "stats_sessions", JSON.stringify(sessions)).catch(() => {});
    }
    const headers = new Headers({ Location: `/stats?lang=${lang}`, ...SECURITY_HEADERS });
    headers.append("Set-Cookie", "stats_session=; Path=/stats; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }

  if (!(await verifyStatsSession(request, env))) {
    const configured = Boolean((await loadAccess(db)) || (env.STATS_LOGIN && env.STATS_PASSWORD));
    return loginPage(lang, configured ? "" : T[lang].notConfigured, 200);
  }

  const daysParam = Number(url.searchParams.get("days") || "30");
  const days = [1, 7, 30].includes(daysParam) ? daysParam : 30;
  const report = await db.advertiserReport(days);

  if (path === "/stats/export.csv") {
    const rows = [["date", "unique_visitors", "pageviews", "js_confirmed_visitors", "robot_requests_filtered"]];
    for (const d of report.daily) rows.push([d.day, String(d.uv), String(d.pv), String(d.js), String(d.robots)]);
    return new Response(rows.map((r) => r.join(",")).join("\n") + "\n", {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="threadsviewer-stats-${days}d.csv"`,
      },
    });
  }

  if (path !== "/stats") return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
  const res = reportPage(env, lang, report, url.host);
  res.headers.append("Set-Cookie", langCookie);
  return res;
}

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

const T = {
  ru: {
    title: "Статистика аудитории",
    loginTitle: "Вход в статистику",
    loginHint: "Доступ для рекламодателей и рекламных площадок",
    login: "Логин",
    password: "Пароль",
    signIn: "Войти",
    badLogin: "Неверный логин или пароль",
    locked: (m: number) => `Слишком много попыток. Повторите через ${m} мин.`,
    notConfigured: "Доступ к статистике ещё не настроен владельцем сайта.",
    logout: "Выйти",
    period: "Период",
    p1: "24 часа",
    p7: "7 дней",
    p30: "30 дней",
    csv: "Скачать CSV",
    print: "Печать / PDF",
    generated: "Сформировано",
    avgDaily: "Посетителей в день (среднее)",
    avgDailyHint: "уникальные посетители в сутки",
    pageviews: "Просмотров страниц",
    visitorDays: "Сумма суточных посетителей",
    visitorDaysHint: "уникальные за каждый день, сложенные",
    ppv: "Страниц на посетителя",
    jsShare: "Подтверждены браузером",
    jsShareHint: "доля посетителей, выполнивших JavaScript",
    robots: "Отфильтровано роботов",
    robotsHint: "запросов поисковиков, ботов и скриптов исключено",
    tgTitle: "Telegram-бот",
    tgUsers: "пользователей всего",
    tgActive: "активных за период",
    dynamics: "Динамика по дням",
    legendUv: "Уникальные посетители",
    legendPv: "Просмотры страниц",
    geo: "География",
    country: "Страна",
    share: "Доля",
    views: "Просмотры",
    devices: "Устройства",
    os: "Операционные системы",
    sources: "Источники трафика",
    referrers: "Основные источники",
    noData: "Пока нет данных",
    dev: { mobile: "Смартфоны", desktop: "Компьютеры", tablet: "Планшеты" } as Record<string, string>,
    src: {
      direct: "Прямые заходы", search: "Поисковые системы", social: "Соцсети и мессенджеры",
      referral: "Другие сайты", hidden: "Другие сайты (реферер скрыт)",
    } as Record<string, string>,
    pages: "Страницы",
    pageKinds: { home: "Главная", profile: "Профили", post: "Посты" } as Record<string, string>,
    coverage: (since: string, a: number, d: number) => `Статистика по текущей методике собирается с ${since}. Период покрыт данными на ${a} из ${d} дн.`,
    noCoverage: "Статистика по текущей методике ещё не накоплена.",
    methodTitle: "Методика подсчёта",
    method: [
      "Учитываются только люди. Поисковые роботы, превью ссылок в мессенджерах, ИИ-краулеры, скрипты и сервисы мониторинга определяются по User-Agent и исключаются.",
      "Уникальный посетитель - обезличенный суточный идентификатор (хеш IP-адреса и браузера, сам IP не хранится). За период выводится сумма и среднее суточных значений.",
      "Просмотр страницы засчитывается при каждом открытии главной, профиля или поста, включая ответы из CDN-кэша.",
      "«Подтверждены браузером» - посетители, чей браузер выполнил JavaScript страницы. Это отсекает большинство автоматического трафика.",
      "География - по IP-адресу (Cloudflare). Посетители через VPN учитываются по стране VPN-сервера.",
      "Источник трафика определяется по заголовкам Referer и Sec-Fetch-Site при входе на сайт; переходы внутри сайта не считаются.",
      "Даты - по UTC.",
    ],
    vpn: (n: string) => `Из них через VPN / дата-центры: ${n} просмотров.`,
  },
  en: {
    title: "Audience statistics",
    loginTitle: "Statistics sign-in",
    loginHint: "Access for advertisers and ad networks",
    login: "Login",
    password: "Password",
    signIn: "Sign in",
    badLogin: "Wrong login or password",
    locked: (m: number) => `Too many attempts. Try again in ${m} min.`,
    notConfigured: "Statistics access has not been configured by the site owner yet.",
    logout: "Sign out",
    period: "Period",
    p1: "24 hours",
    p7: "7 days",
    p30: "30 days",
    csv: "Download CSV",
    print: "Print / PDF",
    generated: "Generated",
    avgDaily: "Daily visitors (average)",
    avgDailyHint: "unique visitors per day",
    pageviews: "Pageviews",
    visitorDays: "Sum of daily visitors",
    visitorDaysHint: "daily uniques added up",
    ppv: "Pages per visitor",
    jsShare: "Browser-verified",
    jsShareHint: "share of visitors that executed JavaScript",
    robots: "Robots filtered out",
    robotsHint: "requests from crawlers, bots and scripts excluded",
    tgTitle: "Telegram bot",
    tgUsers: "users in total",
    tgActive: "active in period",
    dynamics: "Daily dynamics",
    legendUv: "Unique visitors",
    legendPv: "Pageviews",
    geo: "Geography",
    country: "Country",
    share: "Share",
    views: "Views",
    devices: "Devices",
    os: "Operating systems",
    sources: "Traffic sources",
    referrers: "Top sources",
    noData: "No data yet",
    dev: { mobile: "Smartphones", desktop: "Desktop", tablet: "Tablets" } as Record<string, string>,
    src: {
      direct: "Direct", search: "Search engines", social: "Social & messengers",
      referral: "Other websites", hidden: "Other websites (referrer hidden)",
    } as Record<string, string>,
    pages: "Pages",
    pageKinds: { home: "Home", profile: "Profiles", post: "Posts" } as Record<string, string>,
    coverage: (since: string, a: number, d: number) => `Statistics under the current methodology are collected since ${since}. Data covers ${a} of ${d} days of the period.`,
    noCoverage: "Statistics under the current methodology have not been collected yet.",
    methodTitle: "Methodology",
    method: [
      "Only humans are counted. Search engine crawlers, messenger link previews, AI crawlers, scripts and uptime monitors are detected by User-Agent and excluded.",
      "A unique visitor is an anonymous daily identifier (hash of IP address and browser; the IP itself is not stored). For a period, the sum and the average of daily values are shown.",
      "A pageview is counted on every open of the home page, a profile or a post, including responses served from the CDN cache.",
      "“Browser-verified” visitors are those whose browser executed the page JavaScript. This filters out most automated traffic.",
      "Geography is based on IP address (Cloudflare). VPN users are attributed to the VPN server country.",
      "Traffic source is determined from the Referer and Sec-Fetch-Site headers on entry; navigation within the site is not counted.",
      "Dates are in UTC.",
    ],
    vpn: (n: string) => `Of these, via VPN / data centers: ${n} pageviews.`,
  },
};

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f6f9;color:#111827;font-size:15px;line-height:1.45}
a{color:#2563eb;text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:24px 18px 48px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.brand{font-weight:800;font-size:1.25rem}.brand small{display:block;font-weight:500;color:#6b7280;font-size:.85rem}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;border:1px solid #d1d5db;background:#fff;color:#111827;padding:7px 12px;border-radius:8px;font-size:.85rem;cursor:pointer}
.btn.on{background:#111827;color:#fff;border-color:#111827}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:1rem;margin:0 0 12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px}
.kpi .l{color:#6b7280;font-size:.8rem}.kpi .v{font-size:1.7rem;font-weight:800;margin:4px 0 2px}.kpi .h{color:#9ca3af;font-size:.74rem}
.note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:10px 14px;font-size:.85rem;margin-bottom:16px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
table{width:100%;border-collapse:collapse;font-size:.88rem}td,th{padding:7px 4px;border-bottom:1px solid #f0f1f3;text-align:left}th{color:#6b7280;font-weight:600;font-size:.78rem}
td.n,th.n{text-align:right;white-space:nowrap}
.bar{height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-top:4px}.bar i{display:block;height:100%;background:#2563eb}
.chart{display:flex;align-items:flex-end;gap:3px;height:200px;padding-top:8px;border-bottom:1px solid #e5e7eb}
.col{flex:1;display:flex;align-items:flex-end;justify-content:center;gap:1px;height:100%;min-width:0}
.col .pv{background:#bfdbfe;width:45%;border-radius:3px 3px 0 0}.col .uv{background:#2563eb;width:45%;border-radius:3px 3px 0 0}
.xl{display:flex;gap:3px;margin-top:4px}.xl span{flex:1;text-align:center;font-size:.66rem;color:#9ca3af;min-width:0;overflow:hidden}
.legend{display:flex;gap:14px;font-size:.8rem;color:#6b7280;margin-bottom:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.muted{color:#6b7280;font-size:.82rem}
ul.m{margin:0;padding-left:18px;color:#4b5563;font-size:.85rem}ul.m li{margin:4px 0}
.login{max-width:380px;margin:9vh auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:26px}
.login h1{font-size:1.2rem;margin:0 0 4px}.login p{color:#6b7280;margin:0 0 16px;font-size:.88rem}
.login label{display:block;font-size:.82rem;color:#374151;margin:10px 0 4px}.login input{width:100%;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font-size:.95rem}
.login button{width:100%;margin-top:16px;background:#111827;color:#fff;border:0;border-radius:8px;padding:10px;font-size:.95rem;cursor:pointer}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:8px 10px;font-size:.85rem;margin-bottom:8px}
@media print{body{background:#fff}.actions{display:none}.card,.kpi{break-inside:avoid}}
`;

function page(lang: Lang, title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}

function loginPage(lang: Lang, error: string, status: number): Response {
  const t = T[lang];
  const other: Lang = lang === "ru" ? "en" : "ru";
  return page(lang, t.loginTitle, `
<div class="login">
  <div style="display:flex;justify-content:space-between;align-items:center;"><h1>${esc(t.loginTitle)}</h1><a class="muted" href="/stats?lang=${other}">${other.toUpperCase()}</a></div>
  <p>Threads Viewer - ${esc(t.loginHint)}</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <form method="POST" action="/stats/login?lang=${lang}" autocomplete="on">
    <label for="login">${esc(t.login)}</label><input id="login" name="login" autocomplete="username" required autofocus>
    <label for="password">${esc(t.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">${esc(t.signIn)}</button>
  </form>
</div>`, status);
}

function countryName(code: string, lang: Lang): string {
  const c = (code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return lang === "ru" ? "Не определена" : "Unknown";
  try {
    const dn = new (Intl as any).DisplayNames([lang], { type: "region" });
    return dn.of(c) || c;
  } catch {
    return c;
  }
}
function flag(code: string): string {
  const c = (code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return "🌐";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function shareTable(rows: ShareRow[], label: (k: string) => string, nf: Intl.NumberFormat, t: (typeof T)["ru"], head: string): string {
  if (!rows.length) return `<div class="muted">${esc(t.noData)}</div>`;
  return `<table><thead><tr><th>${esc(head)}</th><th class="n">${esc(t.views)}</th><th class="n">${esc(t.share)}</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td>${label(r.key)}<div class="bar"><i style="width:${Math.max(1, Math.round(r.percent))}%"></i></div></td><td class="n">${nf.format(r.count)}</td><td class="n">${r.percent.toFixed(1)}%</td></tr>`).join("")
  }</tbody></table>`;
}

function reportPage(env: Env, lang: Lang, r: AdvertiserReport, host: string): Response {
  const t = T[lang];
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const nf = new Intl.NumberFormat(locale);
  const nf1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const site = env.SITE_DOMAIN || host;
  const other: Lang = lang === "ru" ? "en" : "ru";
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

  const coverage = !r.since
    ? `<div class="note">${esc(t.noCoverage)}</div>`
    : r.activeDays < r.days
      ? `<div class="note">${esc(t.coverage(fmtDate(r.since), r.activeDays, r.days))}</div>`
      : "";

  const jsPct = r.visitorDays ? (r.jsVisitorDays / r.visitorDays) * 100 : 0;
  const kpi = (l: string, v: string, h = "") => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div>${h ? `<div class="h">${esc(h)}</div>` : ""}</div>`;

  const maxV = Math.max(1, ...r.daily.map((d) => Math.max(d.pv, d.uv)));
  const step = r.daily.length > 14 ? 3 : 1;
  const chart = `
    <div class="legend"><span><i style="background:#2563eb"></i>${esc(t.legendUv)}</span><span><i style="background:#bfdbfe"></i>${esc(t.legendPv)}</span></div>
    <div class="chart">${r.daily.map((d) => `<div class="col" title="${esc(d.day)}: ${esc(t.legendUv)} ${d.uv}, ${esc(t.legendPv)} ${d.pv}"><div class="uv" style="height:${(d.uv / maxV) * 100}%"></div><div class="pv" style="height:${(d.pv / maxV) * 100}%"></div></div>`).join("")}</div>
    <div class="xl">${r.daily.map((d, i) => `<span>${i % step === 0 ? esc(d.day.slice(8, 10) + "." + d.day.slice(5, 7)) : ""}</span>`).join("")}</div>`;

  const dailyTable = `<table><thead><tr><th>${lang === "ru" ? "Дата" : "Date"}</th><th class="n">${esc(t.legendUv)}</th><th class="n">${esc(t.legendPv)}</th><th class="n">${esc(t.jsShare)}</th></tr></thead><tbody>${
    [...r.daily].reverse().map((d) => `<tr><td>${esc(d.day)}</td><td class="n">${nf.format(d.uv)}</td><td class="n">${nf.format(d.pv)}</td><td class="n">${nf.format(d.js)}</td></tr>`).join("")
  }</tbody></table>`;

  const pageKinds = Object.entries(r.pvKinds).sort((a, b) => b[1] - a[1])
    .map(([k, c]) => ({ key: k, count: c, percent: r.pageviews ? (c / r.pageviews) * 100 : 0 }));

  const refLabel = (k: string) => {
    const [g, ...rest] = k.split(":");
    const name = rest.join(":");
    return `${esc(name)} <span class="muted">${esc(t.src[g] || g)}</span>`;
  };

  const tabs = [1, 7, 30].map((d) => `<a class="btn${r.days === d ? " on" : ""}" href="/stats?days=${d}&lang=${lang}">${esc(d === 1 ? t.p1 : d === 7 ? t.p7 : t.p30)}</a>`).join("");

  const body = `
<div class="wrap">
  <div class="top">
    <div class="brand">${esc(site)} <small>${esc(t.title)} · ${esc(t.generated)} ${esc(new Date().toLocaleString(locale, { timeZone: "UTC" }))} UTC</small></div>
    <div class="actions">${tabs}
      <a class="btn" href="/stats/export.csv?days=${r.days}">${esc(t.csv)}</a>
      <button class="btn" onclick="window.print()">${esc(t.print)}</button>
      <a class="btn" href="/stats?days=${r.days}&lang=${other}">${other.toUpperCase()}</a>
      <a class="btn" href="/stats/logout">${esc(t.logout)}</a>
    </div>
  </div>
  ${coverage}
  <div class="kpis">
    ${kpi(t.avgDaily, nf.format(Math.round(r.avgDailyVisitors)), t.avgDailyHint)}
    ${kpi(t.pageviews, nf.format(r.pageviews))}
    ${kpi(t.visitorDays, nf.format(r.visitorDays), t.visitorDaysHint)}
    ${kpi(t.ppv, r.visitorDays ? nf1.format(r.pagesPerVisitor) : "-")}
    ${kpi(t.jsShare, r.visitorDays ? `${jsPct.toFixed(0)}%` : "-", t.jsShareHint)}
    ${kpi(t.robots, nf.format(r.robotsFiltered), t.robotsHint)}
  </div>
  <div class="card"><h2>${esc(t.dynamics)}</h2>${chart}</div>
  <div class="grid2">
    <div class="card"><h2>${esc(t.geo)}</h2>${shareTable(r.geo, (k) => `${flag(k)} ${esc(countryName(k, lang))}`, nf, t, t.country)}
      ${r.vpnViews ? `<div class="muted" style="margin-top:8px;">${esc(t.vpn(nf.format(r.vpnViews)))}</div>` : ""}</div>
    <div>
      <div class="card"><h2>${esc(t.devices)}</h2>${shareTable(r.devices, (k) => esc(t.dev[k] || k), nf, t, t.devices)}</div>
      <div class="card"><h2>${esc(t.os)}</h2>${shareTable(r.os, (k) => esc(k === "Другая" && lang === "en" ? "Other" : k), nf, t, t.os)}</div>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><h2>${esc(t.sources)}</h2>${shareTable(r.sources, (k) => esc(t.src[k] || k), nf, t, t.sources)}</div>
    <div class="card"><h2>${esc(t.referrers)}</h2>${shareTable(r.topReferrers, refLabel, nf, t, t.referrers)}</div>
  </div>
  <div class="grid2">
    <div class="card"><h2>${esc(t.pages)}</h2>${shareTable(pageKinds, (k) => esc(t.pageKinds[k] || k), nf, t, t.pages)}</div>
    <div class="card"><h2>${esc(t.tgTitle)} (@${esc(env.BOT_USERNAME || "threadsreaderbot")})</h2>
      <div class="kpis" style="margin:0;grid-template-columns:1fr 1fr;">
        ${kpi(t.tgUsers, nf.format(r.tgTotalUsers))}
        ${kpi(t.tgActive, nf.format(r.tgActiveUsers))}
      </div>
    </div>
  </div>
  <div class="card"><h2>${esc(t.dynamics)}</h2>${dailyTable}</div>
  <div class="card"><h2>${esc(t.methodTitle)}</h2><ul class="m">${t.method.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>
</div>`;
  return page(lang, `${t.title} - ${site}`, body);
}
