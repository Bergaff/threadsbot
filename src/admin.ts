import { adminPassword, type Env } from "./config";
import { Database } from "./db";
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

function verifyAdmin(request: Request, env: Env): boolean {
  const pwd = adminPassword(env);
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!match) return false;
  // Simple token matching
  return match[1] === btoa(pwd);
}

export async function handleAdminRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Login handler
  if (path === "/admin/login" && request.method === "POST") {
    const formData = await request.formData().catch(() => null);
    const pwd = String(formData?.get("password") || "").trim();
    if (pwd && pwd === adminPassword(env)) {
      const headers = new Headers();
      headers.set("Location", "/admin");
      headers.set("Set-Cookie", `admin_session=${btoa(pwd)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      return new Response(null, { status: 302, headers });
    }
    return renderLoginPage(true);
  }

  // Logout handler
  if (path === "/admin/logout") {
    const headers = new Headers();
    headers.set("Location", "/admin");
    headers.set("Set-Cookie", "admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }

  // Check auth
  if (!verifyAdmin(request, env)) {
    return renderLoginPage(false);
  }

  const db = new Database(env);

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

  // Render Admin Dashboard HTML
  return await renderDashboardPage(env, db);
}

const ADMIN_STYLES = `
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
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #242424;
    border: 1px solid #444444;
    border-radius: 0;
    color: #ffffff;
    font-size: 0.85rem;
    padding: 8px 16px;
    z-index: 1001;
    display: none;
  }

  /* Light Theme */
  html[data-theme="light"] body {
    --s: 180px;
    --c1: #efefef;
    --c2: #e0e0e0;
    --c3: #e8e8e8;
    background-color: #efefef;
    color: #1a1a1a;
  }
  html[data-theme="light"] .admin-header {
    background: #ffffff;
    border-bottom: 1px solid #d5d5d5;
  }
  html[data-theme="light"] .admin-header-title {
    color: #111111;
  }
  html[data-theme="light"] .admin-card {
    background: #ffffff;
    border: 1px solid #d5d5d5;
    color: #1a1a1a;
  }
  html[data-theme="light"] .admin-card-title {
    color: #111111;
    border-bottom: 1px solid #e5e5e5;
  }
  html[data-theme="light"] .stat-item {
    background: #f8f8f8;
    border: 1px solid #dcdcdc;
  }
  html[data-theme="light"] .stat-value {
    color: #111111;
  }
  html[data-theme="light"] .accounts-table th {
    background: #f4f4f4;
    border-bottom: 1px solid #d5d5d5;
    color: #333333;
  }
  html[data-theme="light"] .accounts-table td {
    border-bottom: 1px solid #e8e8e8;
    color: #222222;
  }
  html[data-theme="light"] .accounts-table tr:hover {
    background: #f7f7f7;
  }
  html[data-theme="light"] .btn-admin {
    background: #f4f4f4;
    border: 1px solid #cccccc;
    color: #111111;
  }
  html[data-theme="light"] .btn-admin:hover {
    background: #eaeaea;
    border-color: #888888;
  }
  html[data-theme="light"] .form-group input,
  html[data-theme="light"] .form-group textarea {
    background: #ffffff;
    border: 1px solid #cccccc;
    color: #111111;
  }
`;

function renderLoginPage(isError = false): Response {
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
    ${isError ? `<div style="background: #331515; border: 1px solid #552222; color: #fca5a5; padding: 8px; font-size: 0.82rem; margin-bottom: 12px;">Неверный пароль администратора</div>` : ""}
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

async function renderDashboardPage(env: Env, db: Database): Promise<Response> {
  const [counts, stats, system, analytics] = await Promise.all([
    db.accountCounts(),
    db.accountStats() as Promise<any[]>,
    db.systemStats(),
    db.analytics(),
  ]);

  const queueActive = Boolean(env.UPDATES);
  const browserActive = Boolean(env.BROWSER);

  const tableRows = stats.map(a => {
    const diag = diagnoseAccountCookies(a.name, Boolean(a.is_alive), String(a.cookies || ""));
    const days = diag.expiresAt ? Math.max(0, Math.round((diag.expiresAt - Date.now()) / 86_400_000)) : null;
    const expiryStr = diag.expiresAt
      ? `${days} дн. (${new Date(diag.expiresAt).toLocaleDateString("ru-RU")})`
      : "без срока";
    const issuesStr = diag.issues.length ? `<div style="color:#f87171;font-size:0.75rem;">${esc(diag.issues.join("; "))}</div>` : "";

    return `
      <tr>
        <td><b>${esc(a.name)}</b></td>
        <td>${a.is_alive ? `<span class="status-badge-ok">Активен</span>` : `<span class="status-badge-err">Ошибка</span>`}</td>
        <td>${a.hourly_requests} / 20</td>
        <td>${a.requests_count}</td>
        <td>${a.errors_count}</td>
        <td>${esc(expiryStr)}${issuesStr}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-admin" onclick="refreshAccount('${esc(a.name)}')">Продлить куки</button>
            <button class="btn-admin" onclick="probeAccount('${esc(a.name)}')">Тест</button>
            <a href="/admin/api/account/export?name=${encodeURIComponent(a.name)}" class="btn-admin">JSON</a>
            <button class="btn-admin btn-admin-danger" onclick="deleteAccount('${esc(a.name)}')">Удалить</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

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
        </div>
        <div class="stat-item">
          <div class="stat-label">Всего пользователей (TG)</div>
          <div class="stat-value">${system.totalUsers}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Всего запросов (24ч)</div>
          <div class="stat-value" style="color:#0084ff;">${analytics.totalRequests}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Время браузера 24ч</div>
          <div class="stat-value">${(system.browserSeconds24h / 60).toFixed(1)} мин</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Платные подписки</div>
          <div class="stat-value">${analytics.newSubs} ($${analytics.revenue.toFixed(2)})</div>
        </div>
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Разделение источников запросов (Бот vs Сайт за 24ч)</div>
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));">
        <div class="stat-item" style="border-left: 3px solid #22c55e;">
          <div class="stat-label" style="font-weight:700;color:#22c55e;">Telegram-бот (@${esc(env.BOT_USERNAME || 'threadsreaderbot')})</div>
          <div class="stat-value">${analytics.botRequests} запросов</div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.4;">
            <div>- Текст: ${analytics.text}</div>
            <div>- Фото/скрины: ${analytics.img}</div>
            <div>- Комментарии: ${analytics.comments}</div>
            <div>- Активных (DAU): ${analytics.dau} (7 дней: ${analytics.active7d})</div>
          </div>
        </div>
        <div class="stat-item" style="border-left: 3px solid #3b82f6;">
          <div class="stat-label" style="font-weight:700;color:#3b82f6;">Веб-сайт (зеркало Threads)</div>
          <div class="stat-value">${analytics.webRequests} запросов</div>
          <div style="font-size:0.78rem;color:#888;margin-top:6px;line-height:1.4;">
            <div>- Просмотров страниц: ${analytics.webViews}</div>
            <div>- Запросов профилей (API): ${analytics.webApi}</div>
            <div>- Запросов комментариев: ${analytics.webComments}</div>
            <div>- Редиректов в бота: прямые ссылки</div>
          </div>
        </div>
      </div>
    </section>

    <section class="admin-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242424;padding-bottom:6px;">
        <div class="admin-card-title" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">
          Технические аккаунты Threads (${stats.length})
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-admin btn-admin-primary" onclick="refreshAllAccounts()">Автообновление всех куки</button>
          <button class="btn-admin" onclick="resetStatuses()">Сбросить статусы в Alive</button>
        </div>
      </div>

      <div style="overflow-x:auto;">
        <table class="accounts-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Статус</th>
              <th>Лимит / час</th>
              <th>Запросов</th>
              <th>Ошибок</th>
              <th>Срок куки</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="7" style="text-align:center;color:#777;padding:16px;">Аккаунтов нет. Добавьте первый JSON ниже.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <div class="admin-card-title">Добавить аккаунт Threads (JSON)</div>
      <p style="font-size:0.82rem;color:#888;margin-bottom:12px;">
        Загрузите файл .json из Cookie-Editor или Playwright, либо вставьте его текст. Аккаунт сразу сохранится в базе Cloudflare D1 и станет доступен как сайту, так и Telegram-боту.
      </p>

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
      </form>
    </section>
  </main>

  <div id="toast" class="toast-box"></div>

  <script>
    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 3000);
    }

    function refreshAccount(name) {
      showToast('Открываем Threads и обновляем сессию для ' + name + '...');
      fetch('/admin/api/account/refresh?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            showToast('Успешно: ' + data.message);
            setTimeout(function() { window.location.reload(); }, 1200);
          } else {
            showToast('Ошибка: ' + (data.message || data.error));
          }
        })
        .catch(function() { showToast('Сетевая ошибка'); });
    }

    function probeAccount(name) {
      showToast('Тестируем сессию ' + name + '...');
      fetch('/admin/api/account/probe?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          showToast(data.name + ': ' + data.message);
          setTimeout(function() { window.location.reload(); }, 1200);
        })
        .catch(function() { showToast('Сетевая ошибка'); });
    }

    function refreshAllAccounts() {
      showToast('Запущен процесс продления cookies для всех аккаунтов...');
      fetch('/admin/api/account/refresh-all', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          showToast('Готово. Обработано аккаунтов: ' + (data.results ? data.results.length : 0));
          setTimeout(function() { window.location.reload(); }, 1500);
        })
        .catch(function() { showToast('Ошибка при обновлении'); });
    }

    function resetStatuses() {
      fetch('/admin/api/reset-statuses', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          showToast('Сброшено статусов: ' + data.resetCount);
          setTimeout(function() { window.location.reload(); }, 1000);
        })
        .catch(function() { showToast('Ошибка сброса'); });
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
      btn.disabled = true;
      btn.innerText = 'Сохранение...';

      var form = new FormData();
      form.append('name', document.getElementById('accName').value);
      form.append('json', document.getElementById('accJson').value);
      var file = document.getElementById('accFile').files[0];
      if (file) form.append('file', file);

      fetch('/admin/api/account/add', { method: 'POST', body: form })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          btn.disabled = false;
          btn.innerText = 'Сохранить в базу D1';
          if (data.ok) {
            showToast('Аккаунт ' + data.name + ' успешно добавлен в D1');
            setTimeout(function() { window.location.reload(); }, 1000);
          } else {
            showToast('Ошибка: ' + (data.error || 'Неверный формат'));
          }
        })
        .catch(function(err) {
          btn.disabled = false;
          btn.innerText = 'Сохранить в базу D1';
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
