import { describe, expect, it } from "vitest";
import { handleAdminRoute } from "../src/admin";
import type { Env } from "../src/config";

/**
 * РЕГРЕСС-ТЕСТ НА МЁРТВЫЕ КНОПКИ.
 *
 * Симптом: в панели админа перестают работать ВСЕ кнопки (Тест, Keep-Alive,
 * Удалить, Очистить кеш), а обычные ссылки (например выгрузка JSON) продолжают
 * работать. Так выглядит синтаксическая ошибка в одном из встроенных <script>:
 * браузер не может разобрать скрипт, ни одна функция не определяется, и каждый
 * onclick падает молча. Ссылки при этом живы, потому что им JS не нужен.
 *
 * Тест рендерит страницу и прогоняет каждый инлайн-скрипт через парсер V8.
 */

const sampleCookies = JSON.stringify([
  { name: "sessionid", value: "test12345", domain: ".threads.net", path: "/", expires: Date.now() / 1000 + 86400 * 30 },
]);

function makeEnv(): Env {
  const botState = new Map<string, string>();

  const row = {
    name: "acc_test",
    is_alive: 0,
    last_error: "Probe: сессия мертва",
    requests_count: 546,
    posts_sent: 100,
    errors_count: 3,
    hourly_requests: 0,
    hourly_reset: new Date().toISOString(),
    last_used: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cookies: sampleCookies,
  };

  const db = {
    prepare(query: string) {
      if (query.includes("bot_state")) {
        return {
          bind: (...args: any[]) => ({
            first: async () => (botState.has(String(args[1])) ? { value: botState.get(String(args[1])) } : null),
            all: async () => ({ results: [] }),
            run: async () => {
              if (/^\s*DELETE/i.test(query)) botState.delete(String(args[1]));
              else botState.set(String(args[1]), String(args[2] ?? ""));
              return { meta: { changes: 1 } };
            },
          }),
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      }
      return {
        bind: () => ({
          first: async () => (query.includes("threads_accounts") ? { total: 1, enabled: 1, alive: 0 } : { total: 1 }),
          all: async () =>
            query.includes("system_log")
              ? { results: [{ id: 1, data: "[INFO][web] test", timestamp: new Date().toISOString() }] }
              : { results: [row] },
          run: async () => ({ meta: { changes: 1 } }),
        }),
        first: async () => (query.includes("threads_accounts") ? { total: 1, enabled: 1, alive: 0 } : { total: 1 }),
        all: async () =>
          query.includes("system_log")
            ? { results: [{ id: 1, data: "[INFO][web] test", timestamp: new Date().toISOString() }] }
            : { results: [row] },
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
    batch: async () => [
      { results: [{ c: 10 }] },
      { results: [{ c: 5 }] },
      { results: [{ c: 0 }] },
      { results: [{ c: 0 }] },
      { results: [{ c: 0 }] },
      { results: [{ requests: 10, posts: 5, errors: 0, hourly: 1 }] },
      { results: [{ c: 1 }] },
      { results: [{ c: 0 }] },
      { results: [{ c: 30 }] },
      { results: [{ c: 20 }] },
      { results: [{ c: 5 }] },
      { results: [{ c: 0 }] },
      { results: [{ c: 0 }] },
    ],
  };

  return {
    DB: db as any,
    BROWSER: {} as any,
    UPDATES: {} as any,
    TELEGRAM_TOKEN: "123:ABC",
    ADMIN_PASSWORD: "secret_admin_password",
    VERSION: "v2.1.0",
  } as Env;
}

async function renderDashboard(): Promise<string> {
  const env = makeEnv();

  const login = new FormData();
  login.set("password", "secret_admin_password");
  const loginRes = await handleAdminRoute(
    new Request("https://site.com/admin/login", { method: "POST", body: login }),
    env
  );
  const token = (loginRes.headers.get("Set-Cookie") || "").match(/admin_session=([^;]+)/)?.[1] || "";
  expect(token.length).toBeGreaterThan(0);

  const res = await handleAdminRoute(
    new Request("https://site.com/admin", { headers: { cookie: `admin_session=${token}` } }),
    env
  );
  expect(res.status).toBe(200);
  return res.text();
}

/** Достаёт содержимое всех инлайн-скриптов (пропуская внешние src=...). */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/application\/ld\+json/i.test(attrs)) continue;
    const body = m[2];
    if (body && body.trim()) out.push(body);
  }
  return out;
}

describe("Admin dashboard inline JavaScript", () => {
  it("renders a dashboard with a valid session token", async () => {
    const html = await renderDashboard();
    expect(html).toContain("Threads Viewer - Админ панель");
    expect(html).toContain("acc_test");
  });

  it("has no syntax errors in any inline script", async () => {
    const html = await renderDashboard();
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);

    for (const [i, code] of scripts.entries()) {
      let error: string | null = null;
      try {
        // new Function компилирует тело, но НЕ исполняет его:
        // нам нужен только синтаксический разбор. node:vm не используем,
        // чтобы не тянуть @types/node в проект воркера.
        new Function(code);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (error) {
        const firstLine = code.split("\n")[0]?.slice(0, 120) || "";
        throw new Error(
          `Синтаксическая ошибка во встроенном скрипте #${i} - из-за неё в панели не работает ни одна кнопка.\n` +
            `Ошибка: ${error}\n` +
            `Начало скрипта: ${firstLine}`
        );
      }
    }
  });

  it("defines every function referenced by an onclick handler", async () => {
    const html = await renderDashboard();
    const scripts = inlineScripts(html).join("\n");

    // Собираем имена функций из onclick/onsubmit в разметке.
    const handlers = new Set<string>();
    const re = /on(?:click|submit|change|input)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) handlers.add(m[1]);

    expect(handlers.size).toBeGreaterThan(0);

    const missing = [...handlers].filter((name) => {
      // Функция должна быть объявлена в инлайн-скриптах страницы.
      const declared = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`);
      return !declared.test(scripts);
    });

    expect(missing, `Не объявлены функции-обработчики: ${missing.join(", ")}`).toEqual([]);
  });

  it("exposes the account action handlers that the buttons rely on", async () => {
    const html = await renderDashboard();
    const scripts = inlineScripts(html).join("\n");
    // Реальные имена обработчиков кнопок в панели.
    for (const fn of [
      "probeAccount",        // кнопка Тест
      "refreshAccount",      // кнопка Keep-Alive
      "deleteAccount",       // кнопка Удалить
      "probeAllAccounts",    // кнопка Проверить все сессии
      "refreshAllAccounts",  // кнопка Автообновление всех куки
      "resetStatuses",       // кнопка Сбросить статусы
      "submitBulkAccounts",  // массовый импорт
      "submitAccount",       // добавление одного аккаунта
      "clearLogs",
      "refreshLogs",
      "toggleTheme",
    ]) {
      expect(scripts, `В скриптах страницы нет объявления ${fn}`).toContain(`function ${fn}`);
    }
  });
});
