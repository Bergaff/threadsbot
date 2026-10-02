import { adminPassword, type Env } from "./config";
import { Database, type SiteTruth } from "./db";
import { diagnoseAccountCookies, normalizeCookiesJson } from "./cookies";
import { probeAccount, refreshAccountCookies, resetAccountStatuses } from "./threads";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * АДМИНСКАЯ АВТОРИЗАЦИЯ
 *
 * Раньше сессионная кука была равна btoa(пароль). Base64 - не шифрование: любой,
 * кто перехватил куку, декодировал её и получал пароль в открытом виде. Токен не
 * ротируется, отзыв невозможен, перебор пароля ничем не ограничен.
 *
 * Сейчас кука - это случайный непрозрачный токен, который живёт в D1 вместе со
 * сроком действия. Пароль из него не восстанавливается, выход действительно
 * отзывает сессию, а после нескольких неудачных попыток вход блокируется.
 */

/** Срок жизни одной админской сессии. */
const ADMIN_SESSION_TTL_MS = 12 * 3600_000;
/** Сколько неудачных попыток входа допустимо до блокировки. */
const ADMIN_MAX_LOGIN_FAILS = 5;
/** На сколько блокируем вход после превышения лимита попыток. */
const ADMIN_LOCKOUT_MS = 15 * 60_000;

type AdminSessionMap = Record<string, string>;

function newAdminToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Читает карту сессий и сразу выбрасывает протухшие записи. */
async function loadAdminSessions(db: Database): Promise<AdminSessionMap> {
  const raw = await db.state(0, "admin_sessions").catch(() => null);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const now = Date.now();
  const out: AdminSessionMap = {};
  for (const [token, exp] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== "string" || token.length < 32) continue;
    const expMs = new Date(String(exp)).getTime();
    if (Number.isFinite(expMs) && expMs > now) out[token] = String(exp);
  }
  return out;
}

async function saveAdminSessions(db: Database, sessions: AdminSessionMap): Promise<void> {
  await db.setState(0, "admin_sessions", JSON.stringify(sessions));
}

/** Проверка защиты от перебора. Возвращает число оставшихся миллисекунд блокировки. */
async function adminLockoutRemaining(db: Database): Promise<number> {
  const raw = await db.state(0, "admin_login_fails").catch(() => null);
  if (!raw) return 0;
  let count = 0;
  let at = 0;
  try {
    const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
    count = Number(parsed.count) || 0;
    at = Number(parsed.at) || 0;
  } catch {
    return 0;
  }
  if (count < ADMIN_MAX_LOGIN_FAILS) return 0;
  const left = at + ADMIN_LOCKOUT_MS - Date.now();
  return left > 0 ? left : 0;
}

async function registerAdminLoginFail(db: Database): Promise<void> {
  const raw = await db.state(0, "admin_login_fails").catch(() => null);
  let count = 0;
  let at = 0;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
      count = Number(parsed.count) || 0;
      at = Number(parsed.at) || 0;
    } catch {
      count = 0;
      at = 0;
    }
  }
  // Окно счётчика сбрасывается, если предыдущие попытки были давно.
  if (!at || Date.now() - at > ADMIN_LOCKOUT_MS) {
    count = 0;
    at = Date.now();
  }
  await db.setState(0, "admin_login_fails", JSON.stringify({ count: count + 1, at }));
}

/**
 * Проверяет админскую сессию по случайному токену из D1.
 * Асинхронная: токен хранится в базе, а не выводится из пароля.
 */
export async function verifyAdmin(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!match) return false;
  const token = match[1].trim();
  if (token.length < 32) return false;
  const db = new Database(env);
  const sessions = await loadAdminSessions(db);
  const exp = sessions[token];
  if (!exp) return false;
  return new Date(exp).getTime() > Date.now();
}

export async function handleAdminRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = new Database(env);

  // Login handler
  if (path === "/admin/login" && request.method === "POST") {
    const lockMs = await adminLockoutRemaining(db);
    if (lockMs > 0) {
      const mins = Math.ceil(lockMs / 60_000);
      return renderLoginPage(`Слишком много неудачных попыток. Повторите через ${mins} мин.`);
    }

    const formData = await request.formData().catch(() => null);
    const pwd = String(formData?.get("password") || "").trim();
    if (pwd && pwd === adminPassword(env)) {
      const sessions = await loadAdminSessions(db);
      const token = newAdminToken();
      sessions[token] = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
      await saveAdminSessions(db, sessions);
      // Успешный вход обнуляет счётчик неудачных попыток.
      await db.clearState(0, "admin_login_fails").catch(() => {});

      const headers = new Headers();
      headers.set("Location", "/admin");
      headers.set(
        "Set-Cookie",
        `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
      );
      return new Response(null, { status: 302, headers });
    }

    await registerAdminLoginFail(db);
    return renderLoginPage(true);
  }

  // Logout handler
  if (path === "/admin/logout") {
    // Реально отзываем сессию, а не только стираем куку на клиенте.
    const cookie = request.headers.get("cookie") || "";
    const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
    if (match) {
      const sessions = await loadAdminSessions(db);
      if (delete sessions[match[1].trim()]) {
        await saveAdminSessions(db, sessions).catch(() => {});
      }
    }
    const headers = new Headers();
    headers.set("Location", "/admin");
    headers.set("Set-Cookie", "admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }

  // Check auth
  if (!(await verifyAdmin(request, env))) {
    return renderLoginPage(false);
  }

  // Admin API Action: Add Account JSON
  if (path === "/admin/api/account/add" && request.method === "POST") {
    try {
      const formData = await request.formData();
      let name = String(formData.get("name") || "").trim();
      let jsonContent = String(formData.get("json") || "").trim();
      const file = formData.get("file");

      if (file && typeof file === "object" && "text" in file && (file as File).size > 0) {
        jsonContent = await (file as File).text();
        if (!name) {
          name = (file as File).name.replace(/\.json$/i, "").replace(/\s+/g, "_");
        }
      }

      if (!name) name = "acc_" + Date.now();
      name = name.replace(/[^\w.-]/g, "_").slice(0, 64);

      if (!jsonContent) {
        return Response.json({ ok: false, error: "Не переданы cookies (JSON пуст)" }, { status: 400 });
      }

      const normalized = normalizeCookiesJson(jsonContent);
      if (!normalized.ok) {
        return Response.json({ ok: false, error: normalized.error }, { status: 400 });
      }

      const diagnosis = diagnoseAccountCookies(name, true, normalized.json);
      const isAlive = !diagnosis.missingKeys.includes("sessionid");
      await db.accountUpsert(name, normalized.json, isAlive, isAlive ? null : "Нет sessionid");

      return Response.json({
        ok: true,
        name,
        isAlive,
        cookieCount: diagnosis.cookieCount,
        expiry: diagnosis.expiresAt || null,
        issues: diagnosis.issues,
      });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // Admin API Action: Bulk add accounts (массовая заливка куки, чтобы не заполнять форму на каждый аккаунт)
  if (path === "/admin/api/account/add-bulk" && request.method === "POST") {
    try {
      const formData = await request.formData();
      const raw = String(formData.get("bulk") || "").trim();
      if (!raw) return Response.json({ ok: false, error: "Пусто" }, { status: 400 });

      // Блоки разделяются строкой из трёх дефисов. Первая строка блока - имя, остальное - JSON.
      const chunks = raw.split(/^\s*---\s*$/m).map(c => c.trim()).filter(Boolean);
      const results: Array<{ name: string; ok: boolean; message: string; expiry?: number | null }> = [];

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let name = "";
        let jsonLines = lines;
        const first = (lines[0] || "").trim();
        if (first && !first.startsWith("[") && !first.startsWith("{")) {
          name = first.replace(/[^\w.-]/g, "_").slice(0, 64);
          jsonLines = lines.slice(1);
        }
        if (!name) name = "acc_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

        const jsonContent = jsonLines.join("\n").trim();
        if (!jsonContent) {
          results.push({ name, ok: false, message: "Нет JSON с cookies" });
          continue;
        }
        const normalized = normalizeCookiesJson(jsonContent);
        if (!normalized.ok) {
          results.push({ name, ok: false, message: normalized.error });
          continue;
        }
        const diagnosis = diagnoseAccountCookies(name, true, normalized.json);
        const isAlive = !diagnosis.missingKeys.includes("sessionid");
        await db.accountUpsert(name, normalized.json, isAlive, isAlive ? null : "Нет sessionid");
        results.push({
          name,
          ok: isAlive,
          message: isAlive
            ? `Сохранён, cookies: ${diagnosis.cookieCount}`
            : `Сохранён, но нет sessionid: ${diagnosis.issues.join("; ")}`,
          expiry: diagnosis.expiresAt,
        });
      }

      const okCount = results.filter(r => r.ok).length;
      return Response.json({ ok: okCount > 0, total: results.length, saved: okCount, results });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // Admin API Action: Delete Account
  if (path === "/admin/api/account/delete" && request.method === "POST") {
    const name = url.searchParams.get("name") || "";
    if (name) await db.accountDelete(name);
    return Response.json({ ok: true });
  }

  // Admin API Action: Reset all statuses
  if (path === "/admin/api/reset-statuses" && request.method === "POST") {
    const count = await resetAccountStatuses(env);
    return Response.json({ ok: true, resetCount: count });
  }

  // Admin API Action: Test / Probe Account
  if (path === "/admin/api/account/probe" && request.method === "POST") {
    const name = url.searchParams.get("name") || "";
    if (!name) return Response.json({ ok: false, error: "Не указано имя" }, { status: 400 });
    const res = await probeAccount(env, name);
    return Response.json(res);
  }

  // Admin API Action: Test / Probe ALL enabled accounts (реальная проверка сессий, а не флаг из базы)
  if (path === "/admin/api/account/probe-all" && request.method === "POST") {
    const names = await db.enabledAccountNames();
    if (!names.length) return Response.json({ ok: false, error: "Нет включённых аккаунтов" }, { status: 400 });
    const results: Array<{ name: string; ok: boolean; message: string }> = [];
    for (const name of names) {
      try {
        results.push(await probeAccount(env, name));
      } catch (err) {
        results.push({ name, ok: false, message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
      // Пауза между запусками браузера, чтобы не упереться в лимит Browser Rendering
      await new Promise(r => setTimeout(r, 2000));
    }
    const dead = results.filter(r => !r.ok).map(r => r.name);
    return Response.json({
      ok: dead.length === 0,
      total: results.length,
      alive: results.length - dead.length,
      dead,
      results,
    });
  }

  // Admin API Action: Refresh Account Cookies (Автопродление)
  if (path === "/admin/api/account/refresh" && request.method === "POST") {
    const name = url.searchParams.get("name") || "";
    if (!name) return Response.json({ ok: false, error: "Не указано имя" }, { status: 400 });
    const res = await refreshAccountCookies(env, name);
    return Response.json(res);
  }

  // Admin API Action: Refresh ALL alive accounts
  if (path === "/admin/api/account/refresh-all" && request.method === "POST") {
    const accounts = (await db.accountStats()) as any[];
    const alive = accounts.filter(a => a.is_alive);
    const results: any[] = [];
    for (const a of alive) {
      const res = await refreshAccountCookies(env, a.name);
      results.push(res);
    }
    return Response.json({ ok: true, results });
  }

  // Admin API Action: Export Account JSON
  if (path === "/admin/api/account/export") {
    const name = url.searchParams.get("name") || "";
    const acc = await db.accountCookie(name);
    if (!acc) return new Response("Account not found", { status: 404 });
    return new Response(acc.cookies, {
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "content-disposition": `attachment; filename="${name}.json"`,
      },
    });
  }

  // Admin API Action: Get System Logs
  if (path === "/admin/api/logs" && request.method === "GET") {
    const logs = await db.getSystemLogs(40);
    return Response.json({ ok: true, logs });
  }

  // Admin API Action: Clear System Logs
  if (path === "/admin/api/logs/clear" && request.method === "POST") {
    await db.clearSystemLogs();
    return Response.json({ ok: true });
  }

  // Admin API Action: Clear Profile Cache
  if (path === "/admin/api/cache/clear" && request.method === "POST") {
    const user = (url.searchParams.get("username") || "").replace(/^@/, "").toLowerCase();
    if (user) {
      await db.deleteCache(user, "web_profile");
      await db.deleteCache(user, "text");
      await db.deleteCache(user, "img");
      return Response.json({ ok: true, cleared: user });
    }
    return Response.json({ ok: false, error: "Не указан username" }, { status: 400 });
  }

  // Admin API Action: Get Telegram Webhook Status
  if (path === "/admin/api/webhook/status") {
    try {
      if (!env.TELEGRAM_TOKEN) {
        return Response.json({ ok: false, error: "TELEGRAM_TOKEN is not configured" }, { status: 400 });
      }
      const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getWebhookInfo`);
      const data = await tgRes.json<any>();
      const expectedUrl = `https://${env.SITE_DOMAIN || url.host}/telegram/${env.WEBHOOK_SECRET}`;
      return Response.json({
        ok: true,
        webhook: data.result,
        expectedUrl,
        matches: data.result?.url === expectedUrl,
      });
    } catch (err: any) {
      return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
    }
  }

  // Admin API Action: Sync Telegram Webhook to Current Domain
  if (path === "/admin/api/webhook/sync" && request.method === "POST") {
    try {
      if (!env.TELEGRAM_TOKEN || !env.WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "TELEGRAM_TOKEN or WEBHOOK_SECRET missing" }, { status: 400 });
      }
      const targetUrl = `https://${env.SITE_DOMAIN || url.host}/telegram/${env.WEBHOOK_SECRET}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query", "pre_checkout_query"],
          drop_pending_updates: false,
        }),
      });
      const data = await tgRes.json<any>();
      return Response.json({ ok: Boolean(data.ok), targetUrl, result: data });
    } catch (err: any) {
      return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
    }
  }

  // Render Admin Dashboard HTML
  return await renderDashboardPage(env, db);
}

const ADMIN_STYLES = `
  .truth-note { background: rgba(251,191,36,0.10); border: 1px solid rgba(251,191,36,0.45); color: #fbbf24; padding: 8px 12px; margin-bottom: 12px; font-size: 0.8rem; line-height: 1.45; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    --s: 180px;
    --c1: #161616;
    --c2: #242424;
    --c3: #1d1d1d;

    background: repeating-conic-gradient(
          from 30deg,
          #0000 0 120deg,
          var(--c3) 0 180deg
        )
        calc(0.5 * var(--s)) calc(0.5 * var(--s) * 0.577),
      repeating-conic-gradient(
        from 30deg,
        var(--c1) 0 60deg,
        var(--c2) 0 120deg,
        var(--c3) 0 180deg
      );
    background-size: var(--s) calc(var(--s) * 0.577);
    background-color: #161616;
    color: #e6e6e6;
    font-family: Arial, Helvetica, system-ui, sans-serif;
    line-height: 1.5;
    padding-bottom: 60px;
  }
  a { color: inherit; text-decoration: none; }

  .admin-header {
    background: #111111;
    border-bottom: 1px solid #2d2d2d;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    max-width: 980px;
    margin: 0 auto;
  }
  .admin-header-title {
    font-weight: 700;
    font-size: 1rem;
    color: #ffffff;
  }
  .admin-container {
    max-width: 980px;
    margin: 20px auto;
    padding: 0 12px;
  }

  .admin-card {
    background: #131313;
    border: 1px solid #2d2d2d;
    border-radius: 0;
    padding: 20px;
    margin-bottom: 16px;
  }
  .admin-card-title {
    font-size: 1.1rem;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 12px;
    border-bottom: 1px solid #242424;
    padding-bottom: 6px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  }
  .stat-item {
    background: #1a1a1a;
    border: 1px solid #2d2d2d;
    padding: 10px 12px;
  }
  .stat-label {
    font-size: 0.75rem;
    color: #888888;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .stat-value {
    font-size: 1.25rem;
    font-weight: 700;
    color: #ffffff;
    margin-top: 2px;
  }

  /* Table */
  .accounts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    margin-top: 10px;
  }
  .accounts-table th, .accounts-table td {
    padding: 8px 10px;
    border: 1px solid #262626;
    text-align: left;
  }
  .accounts-table th {
    background: #1c1c1c;
    color: #999999;
    font-size: 0.75rem;
    text-transform: uppercase;
  }
  .status-badge-ok {
    color: #4ade80;
    font-weight: 700;
  }
  .status-badge-err {
    color: #f87171;
    font-weight: 700;
  }

  .btn-admin {
    background: #242424;
    border: 1px solid #3d3d3d;
    border-radius: 0;
    color: #ffffff;
    padding: 6px 12px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-admin:hover {
    background: #2d2d2d;
    border-color: #555555;
  }
  .btn-admin-danger {
    background: #331414;
    border-color: #552222;
    color: #fca5a5;
  }
  .btn-admin-danger:hover {
    background: #441a1a;
  }
  .btn-admin-primary {
    background: #1f3a24;
    border-color: #2b5433;
    color: #86efac;
  }
  .btn-admin-primary:hover {
    background: #284c2f;
  }

  .form-group {
    margin-bottom: 12px;
  }
  .form-group label {
    display: block;
    font-size: 0.82rem;
    color: #888888;
    margin-bottom: 4px;
  }
  .form-group input, .form-group textarea {
    width: 100%;
    background: #1c1c1c;
    border: 1px solid #333333;
    border-radius: 0;
    color: #ffffff;
    padding: 8px 10px;
    font-size: 0.88rem;
    font-family: inherit;
    outline: none;
  }
  .form-group input:focus, .form-group textarea:focus {
    border-color: #666666;
  }

  .toast-box {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: #1c1c1c;
    border: 1px solid #3d3d3d;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    border-radius: 0;
    color: #ffffff;
    font-size: 0.9rem;
    font-weight: 500;
    padding: 12px 22px;
    z-index: 10001;
    display: none;
    max-width: 90vw;
    text-align: center;
  }
  html[data-theme="light"] .toast-box {
    background: #e2dacd;
    border-color: #a89f91;
    color: #1a1a1a;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }

  .test-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 0;
    min-width: 26px;
    height: 22px;
    box-sizing: border-box;
    vertical-align: middle;
  }
  .test-indicator-ok {
    background: #14532d;
    color: #4ade80;
    border: 1px solid #16a34a;
  }
  .test-indicator-err {
    background: #7f1d1d;
    color: #fca5a5;
    border: 1px solid #dc2626;
  }
  .test-indicator-loading {
    background: #1e3a5f;
    color: #93c5fd;
    border: 1px solid #2563eb;
  }
  html[data-theme="light"] .test-indicator-ok {
    background: #dcfce7;
    color: #15803d;
    border-color: #86efac;
  }
  html[data-theme="light"] .test-indicator-err {
    background: #fee2e2;
    color: #b91c1c;
    border-color: #fca5a5;
  }
  html[data-theme="light"] .test-indicator-loading {
    background: #dbeafe;
    color: #1d4ed8;
    border-color: #93c5fd;
  }

  .log-line {
    padding: 3px 0;
    border-bottom: 1px solid #1c1c1c;
    word-break: break-word;
  }
  html[data-theme="light"] .log-line {
    border-bottom-color: #d8d0c2;
  }
  .log-badge {
    display: inline-block;
    padding: 1px 5px;
    font-size: 0.68rem;
    font-weight: 700;
    margin-right: 6px;
  }
  .log-badge-error { background: #7f1d1d; color: #fca5a5; }
  .log-badge-warn { background: #78350f; color: #fde68a; }
  .log-badge-info { background: #1e3a5f; color: #93c5fd; }
  .log-badge-bot { background: #581c87; color: #d8b4fe; }
  .log-badge-user { background: #065f46; color: #a7f3d0; }
  html[data-theme="light"] .log-badge-error { background: #fee2e2; color: #b91c1c; }
  html[data-theme="light"] .log-badge-warn { background: #fef3c7; color: #b45309; }
  html[data-theme="light"] .log-badge-info { background: #dbeafe; color: #1d4ed8; }
  html[data-theme="light"] .log-badge-bot { background: #f3e8ff; color: #7e22ce; }
  html[data-theme="light"] .log-badge-user { background: #dcfce7; color: #15803d; }

  /* Light Theme (Warm Matte Beige) */
  html[data-theme="light"] body {
    --s: 180px;
    --c1: #d3cbbe;
    --c2: #c6bdad;
    --c3: #ccc4b5;
    background: repeating-conic-gradient(
          from 30deg,
          #0000 0 120deg,
          var(--c3) 0 180deg
        )
        calc(0.5 * var(--s)) calc(0.5 * var(--s) * 0.577),
      repeating-conic-gradient(
        from 30deg,
        var(--c1) 0 60deg,
        var(--c2) 0 120deg,
        var(--c3) 0 180deg
      );
    background-size: var(--s) calc(var(--s) * 0.577);
    background-color: #d3cbbe;
    color: #24201a;
  }
  html[data-theme="light"] .admin-header {
    background: #dbd3c5;
    border-bottom: 1px solid #b5ab99;
  }
  html[data-theme="light"] .admin-header-title {
    color: #201c17;
  }
  html[data-theme="light"] .admin-card {
    background: #dbd3c5;
    border: 1px solid #b5ab99;
    color: #24201a;
  }
  html[data-theme="light"] .admin-card-title {
    color: #201c17;
    border-bottom: 1px solid #c7bead;
  }
  html[data-theme="light"] .stat-item {
    background: #d4ccbe;
    border: 1px solid #b5ab99;
  }
  html[data-theme="light"] .stat-value {
    color: #201c17;
  }
  html[data-theme="light"] .accounts-table th {
    background: #cec5b5;
    border-bottom: 1px solid #b5ab99;
    color: #3d372c;
  }
  html[data-theme="light"] .accounts-table td {
    border-bottom: 1px solid #c7bead;
    color: #26211a;
  }
  html[data-theme="light"] .accounts-table tr:hover {
    background: #d4ccbe;
  }
  html[data-theme="light"] .btn-admin {
    background: #cec5b5;
    border: 1px solid #aba08d;
    color: #24201a;
  }
  html[data-theme="light"] .btn-admin:hover {
    background: #c3b9a7;
    border-color: #8c826f;
  }
  html[data-theme="light"] .form-group input,
  html[data-theme="light"] .form-group textarea {
    background: #e6dfd2;
    border: 1px solid #b5ab99;
    color: #24201a;
  }
`;

function renderLoginPage(isError: boolean | string = false): Response {
  // Принимаем либо булев флаг (прежнее поведение), либо готовый текст сообщения.
  const errorText =
    typeof isError === "string" && isError.trim()
      ? isError.trim()
      : isError
        ? "Неверный пароль администратора"
        : "";
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Вход в панель администратора</title>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>${ADMIN_STYLES}</style>
</head>
<body>
  <div style="max-width: 360px; margin: 80px auto; padding: 24px; background: #131313; border: 1px solid #2d2d2d;">
    <h2 style="font-size: 1.2rem; color: #fff; margin-bottom: 14px;">Панель администратора</h2>
    ${errorText ? `<div style="background: #331515; border: 1px solid #552222; color: #fca5a5; padding: 8px; font-size: 0.82rem; margin-bottom: 12px;">${esc(errorText)}</div>` : ""}
    <form action="/admin/login" method="POST">
      <div class="form-group">
        <label for="password">Пароль (ADMIN_PASSWORD):</label>
        <input type="password" id="password" name="password" required autofocus />
      </div>
      <button type="submit" class="btn-admin" style="width: 100%; justify-content: center; padding: 8px;">Войти</button>
    </form>
    <div style="margin-top: 14px; text-align: center;">
      <a href="/" style="font-size: 0.78rem; color: #777;">Вернуться на сайт</a>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

const COUNTRY_INFO: Record<string, { name: string }> = {
  RU: { name: "Россия" },
  KG: { name: "Киргизия" },
  TW: { name: "Тайвань" },
  HK: { name: "Гонконг" },
  SG: { name: "Сингапур" },
  CN: { name: "Китай" },
  AZ: { name: "Азербайджан" },
  MD: { name: "Молдова" },
  LV: { name: "Латвия" },
  LT: { name: "Литва" },
  EE: { name: "Эстония" },
  TJ: { name: "Таджикистан" },
  AE: { name: "ОАЭ" },
  TH: { name: "Таиланд" },
  VN: { name: "Вьетнам" },
  ID: { name: "Индонезия" },
  MX: { name: "Мексика" },
  CZ: { name: "Чехия" },
  RS: { name: "Сербия" },
  CY: { name: "Кипр" },
  ME: { name: "Черногория" },
  PT: { name: "Португалия" },
  IE: { name: "Ирландия" },
  CH: { name: "Швейцария" },
  AT: { name: "Австрия" },
  XX: { name: "Не определена" },
  BY: { name: "Беларусь" },
  KZ: { name: "Казахстан" },
  UA: { name: "Украина" },
  US: { name: "США" },
  DE: { name: "Германия" },
  TR: { name: "Турция" },
  KR: { name: "Южная Корея" },
  CA: { name: "Канада" },
  NL: { name: "Нидерланды" },
  FR: { name: "Франция" },
  GB: { name: "Великобритания" },
  ES: { name: "Испания" },
  IT: { name: "Италия" },
  PL: { name: "Польша" },
  UZ: { name: "Узбекистан" },
  GE: { name: "Грузия" },
  AM: { name: "Армения" },
  IL: { name: "Израиль" },
  FI: { name: "Финляндия" },
  SE: { name: "Швеция" },
  BR: { name: "Бразилия" },
  IN: { name: "Индия" },
  JP: { name: "Япония" },
  AU: { name: "Австралия" },
};

function renderCountryList(list: Array<{ country: string; count: number; percent: number }>) {
  if (!list.length) return '<div style="color:#777;font-size:0.82rem;padding:8px 0;">Данные пока собираются...</div>';
  return list.map(item => {
    const info = COUNTRY_INFO[item.country] || { name: item.country === "XX" ? "Не определена" : item.country };
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #282828;font-size:0.84rem;">
        <span><b>${esc(info.name)}</b> <span style="color:#777;font-size:0.75rem;">(${esc(item.country)})</span></span>
        <span><b>${item.count}</b> <span style="color:#888;font-size:0.78rem;">(${item.percent}%)</span></span>
      </div>
    `;
  }).join('');
}

function renderBotList(list: Array<{ bot: string; count: number; percent: number }>) {
  if (!list.length) return '<div style="color:#777;font-size:0.82rem;padding:8px 0;">Пока нет зафиксированных обходов поисковиков...</div>';
  return list.map(item => {
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #282828;font-size:0.84rem;">
        <span><b style="color:#c084fc;">${esc(item.bot)}</b></span>
        <span><b>${item.count}</b> <span style="color:#888;font-size:0.78rem;">(${item.percent}%)</span></span>
      </div>
    `;
  }).join('');
}

const ROBOT_KIND_LABEL: Record<string, string> = {
  search: "Поисковики",
  preview: "Превью ссылок (мессенджеры)",
  ai: "ИИ-краулеры",
  script: "Скрипты / парсеры",
  monitor: "Мониторинг",
  other: "Прочие боты (не поисковики)",
};

/** Миллисекунды -> «1.2 сек». Нет данных -> прочерк (никаких подставных значений). */
function fmtMs(ms: number, count = 1): string {
  if (!count || !(ms > 0)) return "-";
  const sec = ms / 1000;
  return (sec < 1 ? sec.toFixed(2) : sec < 10 ? sec.toFixed(1) : Math.round(sec).toString()) + " сек";
}
function pct(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "-";
}
function statBox(label: string, value: string, hint = "", color = ""): string {
  return `<div class="stat-item"><div class="stat-label">${label}</div><div class="stat-value"${color ? ` style="color:${color};"` : ""}>${value}</div>${hint ? `<div style="font-size:0.72rem;color:#888;margin-top:4px;line-height:1.35;">${hint}</div>` : ""}</div>`;
}

function renderTruthSections(env: Env, t: SiteTruth, analytics: any, retention: any): string {
  const sinceStr = t.since ? new Date(t.since).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : null;
  const partialNote = (() => {
    if (!t.since) return `<div class="truth-note">Новая статистика начнёт копиться после деплоя pr65. Старые счётчики были неточными, поэтому здесь они не используются.</div>`;
    const hours = (Date.now() - new Date(t.since).getTime()) / 3_600_000;
    return hours < 24
      ? `<div class="truth-note">Новая статистика собирается с ${esc(sinceStr || "")} (МСК): прошло ${hours.toFixed(1)} ч. из 24, поэтому цифры «за 24ч» пока неполные.</div>`
      : "";
  })();

  const humans = t.pv.total;
  const scr = t.scrape.profile || { total: 0, ok: 0, notFound: 0, failed: 0, posts: 0, ms: { count: 0, median: 0, p95: 0, max: 0 } };
  const more = t.scrape.more || { total: 0, ok: 0, notFound: 0, failed: 0, posts: 0, ms: { count: 0, median: 0, p95: 0, max: 0 } };
  const cmt = t.scrape.comments || { total: 0, ok: 0, notFound: 0, failed: 0, posts: 0, ms: { count: 0, median: 0, p95: 0, max: 0 } };
  const apiFromCache = Math.max(0, t.api24h - scr.total);

  const robotsByKind = Object.entries(t.robots24h.byKind).sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `<div>- ${esc(ROBOT_KIND_LABEL[k] || k)}: <b>${c}</b></div>`).join("") || "<div>- нет</div>";
  const robotsTop = t.robots24h.top.length
    ? t.robots24h.top.map(r => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #282828;font-size:0.84rem;">
        <span><b style="color:#c084fc;">${esc(r.name)}</b> <span style="color:#777;font-size:0.72rem;">${esc(ROBOT_KIND_LABEL[r.kind] || r.kind)}</span></span>
        <span><b>${r.count}</b> <span style="color:#888;font-size:0.78rem;">(${pct(r.count, t.robots24h.total)})</span></span>
      </div>`).join("")
    : '<div style="color:#777;font-size:0.82rem;padding:8px 0;">Нет данных</div>';
  const dcTop = t.dcTop.length
    ? t.dcTop.map(d => `<div>- ${esc(d.name)}: ${d.count}</div>`).join("")
    : "<div>- нет</div>";

  const dailyRows = t.daily.length ? t.daily.map(d => {
    const noNew = d.pv === 0 && d.robots === 0 && d.uv === 0;
    const cell = (v: number) => noNew && d.legacyWeb > 0 ? '<span style="color:#666;">до pr65</span>' : String(v);
    return `<tr>
      <td><b>${esc(d.day)}</b></td>
      <td>${d.tgRequests} <span style="color:#777;font-size:0.75rem;">(${d.tgUsers} чел.)</span></td>
      <td>${cell(d.uv)}</td>
      <td>${cell(d.js)}</td>
      <td>${cell(d.pv)}</td>
      <td>${cell(d.robots)}</td>
      <td style="color:#666;">${d.legacyWeb || "-"}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="7" style="text-align:center;color:#777;padding:12px;">Пока нет данных за 7 дней</td></tr>';

  return `
    <section class="admin-card">
      <div class="admin-card-title">Сайт за 24ч: люди и роботы (честные цифры)</div>
      ${partialNote}
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));">
        <div class="stat-item" style="border-left: 3px solid #3b82f6;">
          <div class="stat-label" style="font-weight:700;color:#3b82f6;">Люди на сайте</div>
          <div class="stat-value">${t.uv24h} <span style="font-size:0.85rem;color:#888;">уник. посетителей</span></div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.5;">
            <div>- Подтвердили браузер (выполнили JS): <b style="color:#4ade80;">${t.js24h}</b> (${pct(t.js24h, t.uv24h)})</div>
            <div>- Просмотров страниц: <b>${humans}</b> (главная ${t.pv.home}, профили ${t.pv.profile}, посты ${t.pv.post})</div>
            <div>- Страниц на посетителя: ${t.uv24h ? (humans / t.uv24h).toFixed(1) : "-"}</div>
            <div>- Через VPN / дата-центры: ${t.dc24h} просмотров (${pct(t.dc24h, humans)})</div>
          </div>
        </div>
        <div class="stat-item" style="border-left: 3px solid #0ea5e9;">
          <div class="stat-label" style="font-weight:700;color:#38bdf8;">Что делали люди</div>
          <div class="stat-value">${t.api24h + t.more24h + t.comments24h} <span style="font-size:0.85rem;color:#888;">запросов данных</span></div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.5;">
            <div>- Лента профиля (API): ${t.api24h}, из них из кэша ≈${apiFromCache}, через браузер ${scr.total}</div>
            <div>- «Загрузить ещё посты»: ${t.more24h}</div>
            <div>- Открытий комментариев: ${t.comments24h}</div>
          </div>
        </div>
        <div class="stat-item" style="border-left: 3px solid #a855f7;">
          <div class="stat-label" style="font-weight:700;color:#c084fc;">Роботы (не люди)</div>
          <div class="stat-value">${t.robots24h.total} <span style="font-size:0.85rem;color:#888;">запросов</span></div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.5;">${robotsByKind}</div>
        </div>
        <div class="stat-item" style="border-left: 3px solid #22c55e;">
          <div class="stat-label" style="font-weight:700;color:#22c55e;">Telegram-бот (@${esc(env.BOT_USERNAME || "threadsreaderbot")})</div>
          <div class="stat-value">${analytics.botRequests} <span style="font-size:0.85rem;color:#888;">запросов</span></div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.5;">
            <div>- Активных пользователей: ${analytics.dau} (7 дней: ${analytics.active7d})</div>
            <div>- Новых (/start): ${analytics.newUsers}</div>
            <div>- Текст: ${analytics.text}, фото: ${analytics.img}, комментарии: ${analytics.comments}</div>
            <div>- Упёрлись в бесплатный лимит: ${analytics.exhausted}</div>
          </div>
        </div>
      </div>
      <div style="font-size:0.74rem;color:#777;margin-top:8px;line-height:1.5;">
        Уникальный посетитель - суточный обезличенный хеш IP+браузера (сам IP не хранится). Учитываются и ответы из Edge-кэша.
        «Подтвердили браузер» - страница выполнила JavaScript и отправила сигнал: так не делают превью мессенджеров и большинство парсеров.
        Посетители через VPN считаются людьми, но показаны отдельно.
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Скрапер Threads за 24ч: сколько работает и как часто ошибается</div>
      <div class="stats-grid">
        ${statBox("Первая загрузка профиля", `${scr.total}`, `успешно ${scr.ok} (${pct(scr.ok, scr.total)}), не найдено ${scr.notFound}, ошибок ${scr.failed}`, scr.failed > scr.ok ? "#f87171" : "")}
        ${statBox("Ожидание человека (медиана)", fmtMs(scr.ms.median, scr.ms.count), `p95: ${fmtMs(scr.ms.p95, scr.ms.count)}, макс: ${fmtMs(scr.ms.max, scr.ms.count)}`)}
        ${statBox("Постов за загрузку (в среднем)", scr.ok ? (scr.posts / scr.ok).toFixed(1) : "-", "цель - 20")}
        ${statBox("«Загрузить ещё» через браузер", `${more.total}`, `успешно ${more.ok}, ошибок ${more.failed}; медиана ${fmtMs(more.ms.median, more.ms.count)}`)}
        ${statBox("Комментарии через браузер", `${cmt.total}`, `успешно ${cmt.ok}, ошибок ${cmt.failed + cmt.notFound}; медиана ${fmtMs(cmt.ms.median, cmt.ms.count)}`)}
      </div>
      <div style="font-size:0.74rem;color:#777;margin-top:6px;line-height:1.5;">
        Считаются только запросы людей, которые реально запускали браузер. Ответы из кэша сюда не входят. Время - от запроса пользователя до ответа сервера.
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Скорость ответа</div>
      <div class="stats-grid">
        ${statBox("Сайт из кэша: медиана (24ч)", fmtMs(t.webMs.median, t.webMs.count), `p95: ${fmtMs(t.webMs.p95, t.webMs.count)}, макс: ${fmtMs(t.webMs.max, t.webMs.count)}, замеров: ${t.webMs.count}`, "#4ade80")}
        ${statBox("Сайт: первая загрузка через браузер", fmtMs(scr.ms.median, scr.ms.count), `p95: ${fmtMs(scr.ms.p95, scr.ms.count)}, замеров: ${scr.ms.count}`, "#fbbf24")}
        ${statBox("Telegram-бот: медиана (24ч)", fmtMs(t.botMs24h.median, t.botMs24h.count), `p95: ${fmtMs(t.botMs24h.p95, t.botMs24h.count)}, макс: ${fmtMs(t.botMs24h.max, t.botMs24h.count)}, замеров: ${t.botMs24h.count}`)}
        ${statBox("Telegram-бот: медиана (7д)", fmtMs(t.botMs7d.median, t.botMs7d.count), `p95: ${fmtMs(t.botMs7d.p95, t.botMs7d.count)}, замеров: ${t.botMs7d.count}`)}
      </div>
      <div style="font-size:0.74rem;color:#777;margin-top:6px;line-height:1.5;">
        Медиана - половина запросов быстрее этого значения; p95 - 95% запросов быстрее. В отличие от среднего, один долгий запрос эти цифры не искажает.
        Сайт: только люди, страницы и API без Edge-кэша (из Edge-кэша ответ почти мгновенный и не замеряется).
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">По дням (7 дней, даты по UTC)</div>
      <div style="overflow-x:auto;">
        <table class="accounts-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Telegram: запросов</th>
              <th>Сайт: уник. посетителей</th>
              <th>Подтвердили браузер</th>
              <th>Просмотров страниц</th>
              <th>Роботы</th>
              <th title="Старый счётчик до pr65: складывал страницы и API, не видел Edge-кэш">Старый счётчик</th>
            </tr>
          </thead>
          <tbody>${dailyRows}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">География и роботы</div>
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
        <div class="stat-item">
          <div class="stat-label" style="font-weight:700;color:#60a5fa;margin-bottom:8px;">Люди за 24ч (${t.geoTotal24h} просмотров страниц)</div>
          ${renderCountryList(t.geo24h)}
        </div>
        <div class="stat-item">
          <div class="stat-label" style="font-weight:700;color:#93c5fd;margin-bottom:8px;">Люди за 7 дней (${t.geoTotal7d} просмотров страниц)</div>
          ${renderCountryList(t.geo7d)}
        </div>
        <div class="stat-item">
          <div class="stat-label" style="font-weight:700;color:#c084fc;margin-bottom:8px;">Роботы за 24ч (${t.robots24h.total})</div>
          ${robotsTop}
          <div style="font-size:0.74rem;color:#888;margin-top:8px;">VPN / дата-центры у людей:</div>
          <div style="font-size:0.74rem;color:#888;line-height:1.5;">${dcTop}</div>
        </div>
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Повторные запросы в Telegram-боте (за всё время)</div>
      <div class="stats-grid">
        ${statBox("Пользователей с запросами", String(retention.totalUsers))}
        ${statBox("Вернулись (2+ запроса)", `${retention.repeatUsers} <span style="font-size:0.85rem;color:#888;">(${retention.repeatPercent}%)</span>`, "", "#22c55e")}
        ${statBox("Второй запрос в течение 2 мин", `${retention.immediate}`, "почти всегда та же сессия: листают того же автора")}
        ${statBox("Вернулись через 1-24 ч", `${retention.withinDay}`)}
        ${statBox("Вернулись через сутки и позже", `${retention.laterDays}`, "настоящий возврат аудитории", "#fbbf24")}
      </div>
      <div style="font-size:0.74rem;color:#777;margin-top:6px;">Только Telegram-бот: у сайта нет аккаунтов, поэтому возвраты посетителей сайта по-честному посчитать нельзя.</div>
    </section>
  `;
}

async function renderDashboardPage(env: Env, db: Database): Promise<Response> {
  const [counts, stats, system, analytics, retention, truth] = await Promise.all([
    db.accountCounts(),
    db.accountStats() as Promise<any[]>,
    db.systemStats(),
    db.analytics(),
    db.repeatRequestStats(),
    db.siteTruth(),
  ]);
  const workingAccounts24h = Object.values(truth.accounts).filter(a => a.ok > 0).length;

  const queueActive = Boolean(env.UPDATES);
  const browserActive = Boolean(env.BROWSER);

  const tableRows = stats.map(a => {
    const diag = diagnoseAccountCookies(a.name, Boolean(a.is_alive), String(a.cookies || ""));
    const days = diag.expiresAt ? Math.max(0, Math.round((diag.expiresAt - Date.now()) / 86_400_000)) : null;
    const expiryStr = diag.expiresAt
      ? `${days} дн. (${new Date(diag.expiresAt).toLocaleDateString("ru-RU")})`
      : "без срока";
    const issuesStr = diag.issues.length ? `<div style="color:#f87171;font-size:0.75rem;">${esc(diag.issues.join("; "))}</div>` : "";
    const errStr = a.last_error
      ? `<div style="color:#f87171;font-size:0.72rem;max-width:240px;word-break:break-word;margin-top:2px;">${esc(a.last_error)}</div>`
      : "";

    // Когда статус последний раз подтверждался реальным запросом к Threads.
    // Без этого зелёный бейдж невозможно отличить от протухшего флага в базе.
    const verifiedRaw = a.updated_at || a.last_used || "";
    const verifiedTs = verifiedRaw ? new Date(String(verifiedRaw)).getTime() : 0;
    let verifiedStr = "никогда";
    let verifiedStale = true;
    if (verifiedTs) {
      const mins = Math.round((Date.now() - verifiedTs) / 60_000);
      verifiedStr = mins < 1 ? "только что"
        : mins < 60 ? `${mins} мин. назад`
        : mins < 1440 ? `${Math.round(mins / 60)} ч. назад`
        : `${Math.round(mins / 1440)} дн. назад`;
      // Флаг старше суток считается непроверенным: сессию мог убить checkpoint в любой момент
      verifiedStale = mins >= 1440;
    }
    const verifiedColor = verifiedStale ? "#888" : "#4ade80";

    return `
      <tr>
        <td><b>${esc(a.name)}</b></td>
        <td>${a.is_alive ? `<span class="status-badge-ok">Активен</span>` : `<span class="status-badge-err">Ошибка</span>`}</td>
        <td style="color:${verifiedColor};font-size:0.75rem;white-space:nowrap;" title="Когда статус последний раз менялся реальным запросом к Threads">${esc(verifiedStr)}${verifiedStale ? `<div style="color:#888;font-size:0.68rem;">требует проверки</div>` : ""}</td>
        <td>${a.hourly_requests} / 20</td>
        <td>${a.requests_count}</td>
        <td>${a.errors_count}${errStr}</td>
        <td style="white-space:nowrap;">${(() => {
          const r = truth.accounts[a.name] || { ok: 0, err: 0, dead: 0 };
          const color = r.ok === 0 && (r.err + r.dead) > 0 ? "#f87171" : r.ok > 0 ? "#4ade80" : "#888";
          return `<span style="color:${color};"><b>${r.ok}</b> / ${r.err + r.dead}</span>` +
            (r.ok === 0 && (r.err + r.dead) > 0 && a.is_alive ? `<div style="color:#f87171;font-size:0.68rem;">статус «Активен», но ни одного успеха</div>` : "");
        })()}</td>
        <td>${esc(expiryStr)}${issuesStr}<div style="color:#888;font-size:0.68rem;margin-top:2px;">дата не гарантирует живую сессию</div></td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
            <button class="btn-admin" onclick="refreshAccount(this, '${esc(a.name)}')">Keep-Alive</button>
            <button class="btn-admin" onclick="probeAccount(this, '${esc(a.name)}')">Тест</button>
            <span id="test-res-${esc(a.name)}" class="test-indicator" style="display:none;"></span>
            <a href="/admin/api/account/export?name=${encodeURIComponent(a.name)}" class="btn-admin">JSON</a>
            <button class="btn-admin btn-admin-danger" onclick="deleteAccount('${esc(a.name)}')">Удалить</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  const logs = await db.getSystemLogs(40);
  const logsHtml = logs.length
    ? logs.map(l => {
        const rawData = String(l.data || (l as any).event_data || "");
        const isErr = rawData.includes("[ERROR]");
        const isWarn = rawData.includes("[WARN]");
        const isBot = rawData.includes("[BOT_CRAWL]");
        const isUser = rawData.includes("[WEB_VIEW]") || rawData.includes("[WEB_POST_VIEW]") || rawData.includes("[API_REQ]");
        let badgeClass = isErr ? "log-badge-error" : isWarn ? "log-badge-warn" : "log-badge-info";
        let badgeText = isErr ? "ERR" : isWarn ? "WARN" : "INFO";
        if (isBot) {
          badgeClass = "log-badge-bot";
          badgeText = "РОБОТ";
        } else if (isUser) {
          badgeClass = "log-badge-user";
          badgeText = "ЧЕЛОВЕК";
        }
        const cleanText = esc(
          rawData
            .replace(/^\[(ERROR|WARN|INFO)\](\[[^\]]+\])?\s*/, "")
            .replace(/\[(BOT_CRAWL|WEB_VIEW|WEB_POST_VIEW|API_REQ)\]\s*/, "")
            .trim() || "Событие"
        );
        const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
        return `<div class="log-line"><span style="color:#777;margin-right:8px;">${dateStr}</span><span class="log-badge ${badgeClass}">${badgeText}</span>${cleanText}</div>`;
      }).join("")
    : `<div style="color:#777;padding:8px 0;">Логов пока нет. События скрапера и тестов будут появляться здесь.</div>`;

  const deadAlert = (counts.total > 0 && !counts.alive)
    ? `<div style="background:rgba(239,68,68,0.12);border:1px solid #ef4444;color:#ef4444;padding:12px 16px;margin-bottom:14px;font-size:0.88rem;">
        <b>Внимание:</b> все технические аккаунты Threads помечены как нерабочие. Это значит, что Meta аннулировала их сессии.
        <div style="margin-top:6px;">Нужно зайти в Threads под каждым аккаунтом заново и залить свежий JSON через форму ниже.</div>
        <div style="margin-top:6px;color:#fca5a5;">Кнопка «Сбросить статусы в Alive» здесь не поможет: она только перерисует бейджи в зелёный, а сессии останутся мёртвыми, и сайт снова начнёт отдавать ошибки.</div>
      </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Управление ботом и сайтом - Admin</title>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>${ADMIN_STYLES}</style>
</head>
<body>
  <header class="admin-header">
    <div class="admin-header-title">Threads Viewer - Админ панель</div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button type="button" class="btn-admin" onclick="toggleTheme()" id="themeToggleBtn">Тема: Светлая</button>
      <a href="/" target="_blank" style="font-size:0.82rem;color:#888;">Открыть сайт</a>
      <a href="/admin/logout" class="btn-admin" style="font-size:0.78rem;">Выйти</a>
    </div>
  </header>

  <main class="admin-container">
    <section class="admin-card">
      <div class="admin-card-title">Системный статус и инфраструктура</div>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">Версия</div>
          <div class="stat-value" style="font-size:1rem;">${esc(env.VERSION || "unknown")}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Cloudflare Queue</div>
          <div class="stat-value">${queueActive ? '<span class="status-badge-ok">Активна</span>' : '<span class="status-badge-err">Нет</span>'}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Browser Run</div>
          <div class="stat-value">${browserActive ? '<span class="status-badge-ok">Активен</span>' : '<span class="status-badge-err">Нет</span>'}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Аккаунты Threads</div>
          <div class="stat-value">${counts.alive || 0} / ${counts.total} живых</div>
          <div style="font-size:0.72rem;color:${workingAccounts24h < (counts.alive || 0) ? "#fbbf24" : "#888"};margin-top:4px;">реально отдавали посты за 24ч: ${workingAccounts24h}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Всего пользователей (TG)</div>
          <div class="stat-value">${system.totalUsers}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Люди на сайте (24ч)</div>
          <div class="stat-value" style="color:#0084ff;">${truth.uv24h}</div>
          <div style="font-size:0.72rem;color:#888;margin-top:4px;">уник. посетителей; подтвердили браузер: ${truth.js24h}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Время браузера 24ч</div>
          <div class="stat-value">${(system.browserSeconds24h / 60).toFixed(1)} мин</div>
          <div style="font-size:0.72rem;color:#888;margin-top:4px;">запусков: ${system.browserLaunches24h}, отказов Cloudflare (429): ${system.browser42924h}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Подписки</div>
          <div class="stat-value">${analytics.newSubs} новых (24ч)</div>
          <div style="font-size:0.72rem;color:#888;margin-top:4px;">оплачено активными подписками: $${Number(analytics.revenue || 0).toFixed(2)}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Лимиты сайта</div>
          <div class="stat-value" style="font-size:0.95rem;">Безлимит (кэш Edge)</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Анти-спам скрапера</div>
          <div class="stat-value" style="font-size:0.95rem;">20 req / 5 мин (IP)</div>
        </div>
      </div>
    </section>

    <section class="admin-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242424;padding-bottom:6px;">
        <div class="admin-card-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">
          Подключение Telegram-бота (@${esc(env.BOT_USERNAME || 'threadsreaderbot')})
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-admin" onclick="checkWebhookStatus(this)">Проверить вебхук</button>
          <button class="btn-admin btn-admin-primary" onclick="syncWebhook(this, false)">Привязать к threadsviewer.online</button>
          <button class="btn-admin" onclick="syncWebhook(this, true)" title="Сбросить старые зависшие сообщения">Очистить очередь и привязать</button>
        </div>
      </div>
      <div id="webhookStatusBox" style="font-size:0.85rem;color:#aaa;line-height:1.6;background:#141414;padding:12px 14px;border:1px solid #282828;">
        Проверка статуса вебхука...
      </div>
    </section>

    ${renderTruthSections(env, truth, analytics, retention)}

    <section class="admin-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242424;padding-bottom:6px;">
        <div class="admin-card-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">
          Технические аккаунты Threads (${stats.length})
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-admin btn-admin-primary" onclick="probeAllAccounts(this)">Проверить все сессии</button>
          <button class="btn-admin" onclick="refreshAllAccounts(this)">Автообновление всех куки (Keep-Alive)</button>
          <button class="btn-admin" onclick="resetStatuses(this)">Сбросить статусы в Alive</button>
        </div>
      </div>

      ${deadAlert}

      <p style="font-size:0.78rem;color:#888;margin-bottom:10px;">
        <b>Проверить все сессии:</b> реально открывает Threads в браузере под каждым аккаунтом и смотрит, авторизована ли сессия. Это единственный способ узнать правду - колонка «Статус» хранит кешированный флаг, а колонка «Срок куки» проверяет только дату, которая не меняется, даже когда Meta уже аннулировала сессию на своей стороне.
      </p>
      <p style="font-size:0.78rem;color:#888;margin-bottom:10px;">
        <b>Keep-Alive:</b> открывает Threads в фоновом браузере, подтверждает активность сессии в Meta и синхронизирует новые токены. Срок действия сессии (Expires) задается Meta при входе. Когда срок сессии завершится, просто вставьте свежий JSON через форму ниже.
      </p>

      <div style="overflow-x:auto;">
        <table class="accounts-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Статус</th>
              <th>Проверен</th>
              <th>Лимит / час</th>
              <th>Запросов</th>
              <th>Ошибок</th>
              <th title="Успешных сборов / ошибок за последние 24 часа">24ч: успех / ошибки</th>
              <th>Срок куки</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="9" style="text-align:center;color:#777;padding:16px;">Аккаунтов нет. Добавьте первый JSON ниже.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Добавить аккаунт Threads (JSON)</div>
      <p style="font-size:0.82rem;color:#888;margin-bottom:12px;">
        Загрузите файл .json из Cookie-Editor или Playwright, либо вставьте его текст. Можно также вставить строку в Base64 - она распакуется автоматически. Аккаунт сразу сохранится в базе Cloudflare D1 и станет доступен как сайту, так и Telegram-боту.
      </p>

      <div style="border:1px solid #242424;padding:12px 14px;margin-bottom:16px;">
        <div style="font-size:0.88rem;color:#eee;margin-bottom:8px;">Как получить cookies: три шага, без git и без терминала</div>
        <ol style="margin:0 0 8px 18px;padding:0;font-size:0.8rem;color:#999;line-height:1.65;">
          <li>Поставьте в браузер расширение <b style="color:#ccc;">Cookie-Editor</b> (Chrome Web Store или Firefox Add-ons). Оно нужно потому, что главная кука <code style="color:#ccc;">sessionid</code> помечена HttpOnly, и обычными средствами страницы её не прочитать.</li>
          <li>Зайдите на <b style="color:#ccc;">threads.com</b> под нужным аккаунтом. Если аккаунт заходит через Instagram - войдите там, затем откройте threads.com: сессия подхватится.</li>
          <li>Нажмите Cookie-Editor, затем <b style="color:#ccc;">Export</b> и <b style="color:#ccc;">Export as JSON</b>. Вставьте скопированное в поле ниже. Галочка HttpOnly должна быть включена, иначе <code style="color:#ccc;">sessionid</code> не попадёт в экспорт и аккаунт сохранится нерабочим.</li>
        </ol>
        <div style="font-size:0.78rem;color:#777;line-height:1.6;border-top:1px solid #242424;padding-top:8px;">
          Несколько аккаунтов: экспортируйте их по очереди и вставьте всё разом в поле массовой заливки ниже, разделяя блоки строкой из трёх дефисов.
        </div>
      </div>

      <div style="border:1px solid #242424;padding:12px 14px;margin-bottom:16px;background:#161616;">
        <div style="font-size:0.88rem;color:#eee;margin-bottom:8px;">Почему здесь нет входа по логину и паролю</div>
        <p style="margin:0;font-size:0.78rem;color:#888;line-height:1.65;">
          Панель работает на Cloudflare, поэтому любой запущенный ею браузер выходит с датацентрового IP.
          Вход в Threads с такого адреса Meta почти всегда встречает проверкой с кодом на почту или телефон,
          а повторяющиеся автоматические попытки приводят к постоянной блокировке аккаунта, а не к рабочей сессии.
          Кроме того, хранение паролей и ключей 2FA на сервере означает, что при утечке базы скомпрометированы
          все аккаунты сразу, причём с обходом двухфакторной защиты.
          Поэтому панель принимает уже готовые cookies: авторизация происходит в вашем браузере, с вашего адреса,
          а сюда приезжает только результат.
        </p>
      </div>

      <form id="addAccountForm" onsubmit="submitAccount(event)">
        <div class="form-group">
          <label for="accName">Имя аккаунта (необязательно, можно оставить пустым):</label>
          <input type="text" id="accName" placeholder="например, account_01" />
        </div>
        <div class="form-group">
          <label for="accFile">Выберите .json файл с cookies:</label>
          <input type="file" id="accFile" accept=".json" />
        </div>
        <div class="form-group">
          <label for="accJson">Или вставьте текст cookies JSON сюда:</label>
          <textarea id="accJson" rows="4" placeholder="[{&quot;name&quot;:&quot;sessionid&quot;,...}]"></textarea>
        </div>
        <button type="submit" class="btn-admin btn-admin-primary" id="saveAccBtn">
          Сохранить в базу D1
        </button>
        <div id="accFormMsg" style="display:none;margin-top:12px;padding:10px 14px;border:1px solid transparent;font-size:0.85rem;line-height:1.4;"></div>
      </form>

      <div style="border-top:1px solid #242424;margin-top:18px;padding-top:14px;">
        <div class="admin-card-title" style="font-size:0.95rem;">Массовая заливка нескольких аккаунтов</div>
        <p style="font-size:0.78rem;color:#888;margin-bottom:10px;">
          Чтобы не заполнять форму на каждый аккаунт отдельно, вставьте все экспорты сразу.
          Блоки разделяются строкой из трёх дефисов. Первая строка блока - имя аккаунта, дальше JSON из Cookie-Editor.
        </p>
        <div class="form-group">
          <label for="accBulk">Аккаунты (имя + JSON, разделитель ---):</label>
          <textarea id="accBulk" rows="8" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.75rem;" placeholder="wolf.8385407&#10;[{&quot;name&quot;:&quot;sessionid&quot;,...}]&#10;---&#10;lion.2795153&#10;[{&quot;name&quot;:&quot;sessionid&quot;,...}]"></textarea>
        </div>
        <button type="button" class="btn-admin" id="bulkAccBtn" onclick="submitBulkAccounts(this)">Сохранить все аккаунты</button>
        <div id="bulkAccMsg" style="display:none;margin-top:12px;padding:10px 14px;border:1px solid #242424;font-size:0.82rem;line-height:1.5;"></div>
      </div>
    </section>

    <section class="admin-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242424;padding-bottom:6px;">
        <div class="admin-card-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">
          Системный журнал событий и ошибок (${logs.length})
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-admin" onclick="copyLogs(this)">Скопировать логи</button>
          <button class="btn-admin" onclick="refreshLogs(this)">Обновить логи</button>
          <button class="btn-admin btn-admin-danger" onclick="clearLogs(this)">Очистить</button>
        </div>
      </div>
      <div id="logsContainer" style="max-height:280px;overflow-y:auto;background:#0d0d0d;border:1px solid #222;padding:10px 14px;font-family:monospace;font-size:0.78rem;line-height:1.5;">
        ${logsHtml}
      </div>
    </section>
  </main>

  <div id="toast" class="toast-box"></div>

  <script>
    function checkWebhookStatus(btn) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Запрос...'; }
      var box = document.getElementById('webhookStatusBox');
      if (box && !btn) box.innerHTML = 'Запрос статуса вебхука в Telegram...';
      fetch('/admin/api/webhook/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (!box) return;
          if (!data.ok) {
            box.innerHTML = '<span style="color:#ef4444;font-weight:600;">Ошибка: ' + (data.error || 'не удалось получить статус') + '</span>';
            return;
          }
          var w = data.webhook || {};
          var isMatch = data.matches;
          var matchBadge = isMatch
            ? '<span style="color:#22c55e;font-weight:600;margin-left:6px;">[OK: привязан к этому сайту]</span>'
            : '<span style="color:#ef4444;font-weight:600;margin-left:6px;">[ВНИМАНИЕ: вебхук не совпадает с доменом!]</span>';
          var html = '<div><b>Зарегистрированный URL в Telegram:</b> <code style="color:#60a5fa;">' + (w.url || 'НЕ УСТАНОВЛЕН') + '</code> ' + matchBadge + '</div>';
          html += '<div style="margin-top:4px;"><b>Ожидаемый URL (threadsviewer.online):</b> <code style="color:#9ca3af;">' + data.expectedUrl + '</code></div>';
          html += '<div style="margin-top:4px;"><b>Сообщений в очереди доставки Telegram:</b> <span style="font-weight:700;color:' + (w.pending_update_count > 0 ? '#f59e0b' : '#22c55e') + '">' + (w.pending_update_count || 0) + '</span></div>';
          if (w.last_error_message) {
            var errDate = w.last_error_date ? new Date(w.last_error_date * 1000).toLocaleString() : '';
            html += '<div style="color:#ef4444;margin-top:6px;padding:6px 8px;background:#261212;border:1px solid #ef4444;"><b>Последняя ошибка Telegram:</b> ' + w.last_error_message + ' (' + errDate + ')</div>';
          } else {
            html += '<div style="color:#22c55e;margin-top:4px;">Ошибок доставки нет. Telegram успешно соединяется.</div>';
          }
          box.innerHTML = html;
        })
        .catch(function(e) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (box) box.innerHTML = '<span style="color:#ef4444;">Ошибка запроса: ' + e + '</span>';
        });
    }

    function syncWebhook(btn, dropPending) {
      var msg = dropPending
        ? 'Привязать Telegram Webhook к threadsviewer.online И сбросить все старые зависшие сообщения?'
        : 'Привязать Telegram Webhook к текущему домену threadsviewer.online?';
      if (!confirm(msg)) return;
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Привязка...'; }
      fetch('/admin/api/webhook/sync' + (dropPending ? '?drop=1' : ''), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (data && data.ok) {
            showToast('Webhook успешно перепривязан к threadsviewer.online!');
            checkWebhookStatus();
          } else {
            alert('Ошибка привязки: ' + JSON.stringify(data));
          }
        })
        .catch(function(e) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          alert('Ошибка сети: ' + e);
        });
    }

    document.addEventListener('DOMContentLoaded', function() {
      checkWebhookStatus();
    });
    setTimeout(checkWebhookStatus, 150);

    var toastTimer = null;
    function showToast(msg, duration) {
      if (duration === undefined) duration = 4000;
      var t = document.getElementById('toast');
      if (!t) return;
      t.innerText = msg;
      t.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      if (duration > 0) {
        toastTimer = setTimeout(function() { t.style.display = 'none'; }, duration);
      }
    }

    function copyLogs(btn) {
      var c = document.getElementById('logsContainer');
      if (!c) return;
      var text = c.innerText;
      if (!text || text.indexOf('Логов пока нет') !== -1) {
        showToast('Журнал пуст');
        return;
      }
      if (navigator.clipboard) {
        var orig = btn.innerText;
        navigator.clipboard.writeText(text).then(function() {
          showToast('Логи скопированы в буфер обмена');
          btn.innerText = 'Скопировано!';
          setTimeout(function() { btn.innerText = orig; }, 2000);
        }).catch(function() {
          showToast('Не удалось скопировать в буфер');
        });
      } else {
        showToast('Буфер обмена недоступен');
      }
    }

    function refreshLogs(btn) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Загрузка...'; }
      fetch('/admin/api/logs')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (data.ok && data.logs) {
            var c = document.getElementById('logsContainer');
            if (!c) return;
            if (!data.logs.length) {
              c.innerHTML = '<div style="color:#777;padding:8px 0;">Логов пока нет.</div>';
              return;
            }
            c.innerHTML = data.logs.map(function(l) {
              var isErr = l.data.indexOf('[ERROR]') !== -1;
              var isWarn = l.data.indexOf('[WARN]') !== -1;
              var badgeClass = isErr ? 'log-badge-error' : (isWarn ? 'log-badge-warn' : 'log-badge-info');
              var badgeText = isErr ? 'ERR' : (isWarn ? 'WARN' : 'INFO');
              var cleanText = l.data.replace(/^\[(ERROR|WARN|INFO)\]/, '').trim();
              var d = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
              return '<div class="log-line"><span style="color:#777;margin-right:8px;">' + d + '</span><span class="log-badge ' + badgeClass + '">' + badgeText + '</span>' + cleanText + '</div>';
            }).join('');
            showToast('Логи обновлены');
          }
        })
        .catch(function(e) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Ошибка загрузки логов: ' + e);
        });
    }

    function clearLogs(btn) {
      if (!confirm('Очистить системные логи?')) return;
      if (btn) { btn.disabled = true; }
      fetch('/admin/api/logs/clear', { method: 'POST' })
        .then(function() {
          if (btn) { btn.disabled = false; }
          var c = document.getElementById('logsContainer');
          if (c) c.innerHTML = '<div style="color:#777;padding:8px 0;">Логи очищены.</div>';
          showToast('Логи очищены');
        })
        .catch(function(e) {
          if (btn) { btn.disabled = false; }
          showToast('Ошибка очистки: ' + e);
        });
    }

    function refreshAccount(btn, name) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Keep-Alive...'; }
      showToast('Открываем Threads и подтверждаем активность для ' + name + '...', 0);
      fetch('/admin/api/account/refresh?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (data.ok) {
            showToast('Успешно: ' + data.message, 4000);
            setTimeout(function() { window.location.reload(); }, 1200);
          } else {
            showToast('Ошибка: ' + (data.message || data.error), 6000);
          }
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Сетевая ошибка: ' + err, 5000);
        });
    }

    function probeAccount(btn, name) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Тест...'; }
      var ind = document.getElementById('test-res-' + name);
      if (ind) {
        ind.style.display = 'inline-flex';
        ind.className = 'test-indicator test-indicator-loading';
        ind.innerText = '...';
        ind.title = 'Тестирование...';
      }
      showToast('Тестируем сессию ' + name + ' (запуск браузера Threads)...', 0);
      fetch('/admin/api/account/probe?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (data.ok) {
            if (ind) {
              ind.style.display = 'inline-flex';
              ind.className = 'test-indicator test-indicator-ok';
              ind.innerText = 'OK';
              ind.title = data.name + ': ' + (data.message || 'Сессия активна');
            }
            showToast(data.name + ': ' + data.message, 4000);
            setTimeout(function() { window.location.reload(); }, 1400);
          } else {
            if (ind) {
              ind.style.display = 'inline-flex';
              ind.className = 'test-indicator test-indicator-err';
              ind.innerText = '!';
              ind.title = data.name + ': ' + (data.message || 'Сессия недействительна');
            }
            showToast('Ошибка ' + data.name + ': ' + (data.message || 'Сессия недействительна'), 6000);
            setTimeout(function() { window.location.reload(); }, 2000);
          }
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (ind) {
            ind.style.display = 'inline-flex';
            ind.className = 'test-indicator test-indicator-err';
            ind.innerText = '!';
            ind.title = 'Ошибка сети: ' + err;
          }
          showToast('Сетевая ошибка при запуске теста: ' + err, 5000);
        });
    }

    function submitBulkAccounts(btn) {
      var ta = document.getElementById('accBulk');
      var box = document.getElementById('bulkAccMsg');
      var raw = ta ? ta.value.trim() : '';
      if (!raw) {
        if (box) {
          box.style.display = 'block';
          box.style.borderColor = '#ef4444';
          box.style.color = '#f87171';
          box.innerText = 'Поле пустое. Вставьте блоки "имя + JSON", разделённые строкой из трёх дефисов.';
        }
        return;
      }
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Сохранение...'; }
      var form = new FormData();
      form.append('bulk', raw);
      fetch('/admin/api/account/add-bulk', { method: 'POST', body: form })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (!box) return;
          box.style.display = 'block';
          if (data.error) {
            box.style.borderColor = '#ef4444';
            box.style.color = '#f87171';
            box.innerText = 'Ошибка: ' + data.error;
            return;
          }
          box.style.borderColor = '#242424';
          box.style.color = '#ccc';
          var lines = (data.results || []).map(function(res) {
            return (res.ok ? '[OK] ' : '[!!] ') + res.name + ': ' + (res.message || '');
          });
          box.innerHTML = '<b>Сохранено ' + data.saved + ' из ' + data.total + '</b><br>' + lines.join('<br>');
          showToast('Массовый импорт завершён: сохранено ' + data.saved + ' из ' + data.total, 6000);
          if (ta) ta.value = '';
          setTimeout(function() { window.location.reload(); }, 3000);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Сетевая ошибка импорта: ' + err, 6000);
        });
    }

    function probeAllAccounts(btn) {
      if (!confirm('Проверить сессии всех аккаунтов? Для каждого будет запущен браузер Threads, примерно по 10 секунд на аккаунт.')) return;
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Проверка сессий...'; }
      showToast('Проверяем сессии всех аккаунтов в браузере Threads...', 0);
      fetch('/admin/api/account/probe-all', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          if (data.error) { showToast('Ошибка: ' + data.error, 6000); return; }
          var dead = data.dead || [];
          if (dead.length === 0) {
            showToast('Все аккаунты (' + data.total + ') авторизованы и работают', 6000);
          } else {
            showToast('Мёртвые сессии (' + dead.length + ' из ' + data.total + '): ' + dead.join(', ') + '. Нужны свежие cookies.', 12000);
          }
          // Подсвечиваем результат прямо в таблице, не перезагружая страницу сразу
          (data.results || []).forEach(function(res) {
            var ind = document.getElementById('test-res-' + res.name);
            if (!ind) return;
            ind.style.display = 'inline-flex';
            ind.className = 'test-indicator ' + (res.ok ? 'test-indicator-ok' : 'test-indicator-err');
            ind.innerText = res.ok ? 'OK' : '!';
            ind.title = res.name + ': ' + (res.message || '');
          });
          setTimeout(function() { window.location.reload(); }, 2500);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Сетевая ошибка при проверке: ' + err, 6000);
        });
    }

    function refreshAllAccounts(btn) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Обновление...'; }
      showToast('Запущен процесс продления cookies для всех аккаунтов...', 0);
      fetch('/admin/api/account/refresh-all', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Готово. Обработано аккаунтов: ' + (data.results ? data.results.length : 0), 4000);
          setTimeout(function() { window.location.reload(); }, 1500);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Ошибка при обновлении: ' + err, 5000);
        });
    }

    function resetStatuses(btn) {
      var orig = btn ? btn.innerText : '';
      if (btn) { btn.disabled = true; btn.innerText = 'Сброс...'; }
      showToast('Сбрасываем статусы всех аккаунтов в Alive...', 0);
      fetch('/admin/api/reset-statuses', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Сброшено статусов: ' + data.resetCount + '. Страница перезагружается...', 3000);
          setTimeout(function() { window.location.reload(); }, 1000);
        })
        .catch(function(err) {
          if (btn) { btn.disabled = false; btn.innerText = orig; }
          showToast('Ошибка сброса: ' + err, 5000);
        });
    }

    function deleteAccount(name) {
      if (!confirm('Удалить аккаунт ' + name + '?')) return;
      fetch('/admin/api/account/delete?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function() {
          showToast('Удалено');
          setTimeout(function() { window.location.reload(); }, 800);
        });
    }

    function submitAccount(e) {
      e.preventDefault();
      var btn = document.getElementById('saveAccBtn');
      var msg = document.getElementById('accFormMsg');
      var nameVal = (document.getElementById('accName').value || '').trim();
      var jsonVal = (document.getElementById('accJson').value || '').trim();
      var file = document.getElementById('accFile').files[0];

      if (!jsonVal && !file) {
        if (msg) {
          msg.style.display = 'block';
          msg.style.borderColor = '#ef4444';
          msg.style.background = 'rgba(239, 68, 68, 0.12)';
          msg.style.color = '#ef4444';
          msg.innerText = 'Пожалуйста, выберите файл .json с cookies или вставьте текст cookies JSON в поле.';
        }
        showToast('Выберите файл или вставьте JSON');
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Сохранение в D1...';
      if (msg) {
        msg.style.display = 'block';
        msg.style.borderColor = '#0084ff';
        msg.style.background = 'rgba(0, 132, 255, 0.1)';
        msg.style.color = '#0084ff';
        msg.innerText = 'Проверка cookies и сохранение в базу данных Cloudflare D1...';
      }

      var form = new FormData();
      form.append('name', nameVal);
      form.append('json', jsonVal);
      if (file) form.append('file', file);

      fetch('/admin/api/account/add', { method: 'POST', body: form })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          btn.disabled = false;
          btn.innerText = 'Сохранить в базу D1';
          if (data.ok) {
            if (msg) {
              msg.style.display = 'block';
              msg.style.borderColor = '#10b981';
              msg.style.background = 'rgba(16, 185, 129, 0.12)';
              msg.style.color = '#10b981';
              msg.innerText = 'Аккаунт ' + data.name + ' успешно сохранен в D1 (' + (data.cookieCount || 0) + ' cookies). Обновление таблицы...';
            }
            showToast('Аккаунт ' + data.name + ' успешно добавлен в D1');
            setTimeout(function() { window.location.reload(); }, 1200);
          } else {
            if (msg) {
              msg.style.display = 'block';
              msg.style.borderColor = '#ef4444';
              msg.style.background = 'rgba(239, 68, 68, 0.12)';
              msg.style.color = '#ef4444';
              msg.innerText = 'Ошибка сохранения: ' + (data.error || 'Неверный формат JSON');
            }
            showToast('Ошибка: ' + (data.error || 'Неверный формат'));
          }
        })
        .catch(function(err) {
          btn.disabled = false;
          btn.innerText = 'Сохранить в базу D1';
          if (msg) {
            msg.style.display = 'block';
            msg.style.borderColor = '#ef4444';
            msg.style.background = 'rgba(239, 68, 68, 0.12)';
            msg.style.color = '#ef4444';
            msg.innerText = 'Сетевая ошибка при запросе к серверу: ' + err;
          }
          showToast('Ошибка запроса: ' + err);
        });
    }

    function toggleTheme() {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('threads_theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('threads_theme', 'light');
      }
      updateAdminThemeBtn();
    }

    function updateAdminThemeBtn() {
      var b = document.getElementById('themeToggleBtn');
      if (!b) return;
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      b.innerText = isLight ? 'Тема: Тёмная' : 'Тема: Светлая';
    }
    updateAdminThemeBtn();
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
}
