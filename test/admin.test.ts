import { describe, expect, it } from "vitest";
import { handleAdminRoute } from "../src/admin";
import type { Env } from "../src/config";

const sampleCookies = JSON.stringify([
  { name: "sessionid", value: "test12345", domain: ".threads.net", path: "/", expires: Date.now() / 1000 + 86400 * 30 },
]);

const mockD1 = {
  prepare: (query: string) => ({
    bind: (..._args: any[]) => ({
      first: async () => {
        if (query.includes("threads_accounts")) return { total: 1, enabled: 1, alive: 1 };
        return { total: 1 };
      },
      all: async () => {
        if (query.includes("system_log")) {
          return {
            results: [
              { id: 1, data: "[INFO][web] [BOT_CRAWL] Googlebot: главная страница", timestamp: new Date().toISOString() },
              { id: 2, data: "[INFO][web] [WEB_VIEW] Главная страница (человек, US)", timestamp: new Date().toISOString() },
            ],
          };
        }
        return {
          results: [
            {
              name: "acc_test",
              is_alive: 1,
              hourly_requests: 3,
              requests_count: 42,
              errors_count: 0,
              cookies: sampleCookies,
            },
          ],
        };
      },
      run: async () => ({ meta: { changes: 1 } }),
    }),
    first: async () => {
      if (query.includes("threads_accounts")) return { total: 1, enabled: 1, alive: 1 };
      return { total: 1 };
    },
    all: async () => {
      if (query.includes("system_log")) {
        return {
          results: [
            { id: 1, data: "[INFO][web] [BOT_CRAWL] Googlebot: главная страница", timestamp: new Date().toISOString() },
            { id: 2, data: "[INFO][web] [WEB_VIEW] Главная страница (человек, US)", timestamp: new Date().toISOString() },
          ],
        };
      }
      return {
        results: [
          {
            name: "acc_test",
            is_alive: 1,
            hourly_requests: 3,
            requests_count: 42,
            errors_count: 0,
            cookies: sampleCookies,
          },
        ],
      };
    },
    run: async () => ({ meta: { changes: 1 } }),
  }),
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

const mockEnv: Env = {
  DB: mockD1 as any,
  BROWSER: {} as any,
  UPDATES: {} as any,
  TELEGRAM_TOKEN: "123:ABC",
  CRYPTO_BOT_TOKEN: "crypto",
  WEBHOOK_SECRET: "sec",
  ADMIN_PASSWORD: "secret_admin_password",
  VERSION: "v2.1.0",
};

/**
 * Админские сессии теперь хранятся в D1, а не выводятся из пароля,
 * поэтому для тестов авторизации нужен мок с реальной памятью bot_state.
 */
function makeStatefulEnv(): Env {
  const botState = new Map<string, string>();

  const statefulD1 = {
    ...mockD1,
    prepare(query: string) {
      if (query.includes("bot_state")) {
        return {
          bind: (...args: any[]) => ({
            first: async () => {
              const key = String(args[1]);
              return botState.has(key) ? { value: botState.get(key) } : null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              const key = String(args[1]);
              if (/^\s*DELETE/i.test(query)) botState.delete(key);
              else botState.set(key, String(args[2] ?? ""));
              return { meta: { changes: 1 } };
            },
          }),
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      }
      return mockD1.prepare(query);
    },
  };

  return { ...mockEnv, DB: statefulD1 as any };
}

/** Логинится и достаёт выданный сессионный токен из Set-Cookie. */
async function loginAndGetToken(env: Env): Promise<string> {
  const body = new FormData();
  body.set("password", "secret_admin_password");
  const req = new Request("https://site.com/admin/login", { method: "POST", body });
  const res = await handleAdminRoute(req, env);
  const cookie = res.headers.get("Set-Cookie") || "";
  const match = cookie.match(/admin_session=([^;]+)/);
  return match ? match[1] : "";
}

describe("Admin Route & Authentication", () => {
  it("renders login form if unauthenticated", async () => {
    const req = new Request("https://site.com/admin");
    const res = await handleAdminRoute(req, mockEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Вход в панель администратора");
    expect(html).toContain('name="password"');
  });

  it("fails login with wrong password", async () => {
    const body = new FormData();
    body.set("password", "wrong_pass");
    const req = new Request("https://site.com/admin/login", { method: "POST", body });
    const res = await handleAdminRoute(req, mockEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Неверный пароль администратора");
  });

  it("succeeds login with correct password, returns 302 and sets cookie", async () => {
    const body = new FormData();
    body.set("password", "secret_admin_password");
    const req = new Request("https://site.com/admin/login", { method: "POST", body });
    const res = await handleAdminRoute(req, mockEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin");
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
  });

  it("renders dashboard when authenticated with logs and test indicators", async () => {
    const env = makeStatefulEnv();
    const token = await loginAndGetToken(env);
    const req = new Request("https://site.com/admin", {
      headers: { cookie: `admin_session=${token}` },
    });
    const res = await handleAdminRoute(req, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Threads Viewer - Админ панель");
    expect(html).toContain("acc_test");
    expect(html).toContain("test-res-acc_test");
    expect(html).toContain("Системный журнал событий и ошибок");
    expect(html).toContain("Автообновление всех куки");
    expect(html).toContain("Добавить аккаунт Threads (JSON)");
    expect(html).toContain("Запросы за неделю (7 дней) и посуточная динамика");
    expect(html).toContain("Скорость работы бота (Сколько думает бот перед ответом)");
    expect(html).toContain("Telegram бот");
    expect(html).toContain("Веб-сайт");
    expect(html).toContain("Поисковые роботы (SEO / Краулеры)");
    expect(html).toContain("География посетителей (Страны, что заходят)");
    expect(html).toContain("Поведение пользователей и повторные запросы (Ретеншн)");
    expect(html).toContain("log-badge-bot");
    expect(html).toContain("РОБОТ");
    expect(html).toContain("Googlebot: главная страница");
    expect(html).toContain("log-badge-user");
    expect(html).toContain("ЧЕЛОВЕК");
    expect(html).toContain("Главная страница (человек, US)");
  });

  it("verifyAdmin accepts only tokens issued by login, not the password itself", async () => {
    const { verifyAdmin } = await import("../src/admin");
    const env = makeStatefulEnv();

    const token = await loginAndGetToken(env);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const reqAuth = new Request("https://site.com/@zuck", {
      headers: { cookie: `admin_session=${token}` },
    });
    const reqUnauth = new Request("https://site.com/@zuck");
    const reqWrong = new Request("https://site.com/@zuck", {
      headers: { cookie: `admin_session=invalid` },
    });
    expect(await verifyAdmin(reqAuth, env)).toBe(true);
    expect(await verifyAdmin(reqUnauth, env)).toBe(false);
    expect(await verifyAdmin(reqWrong, env)).toBe(false);
  });

  it("no longer accepts btoa(password) as a session token", async () => {
    // РЕГРЕСС НА ДЫРУ: раньше кука была равна btoa(пароль), то есть перехвативший
    // её получал пароль в открытом виде. Такой токен больше не должен работать.
    const { verifyAdmin } = await import("../src/admin");
    const env = makeStatefulEnv();
    await loginAndGetToken(env); // чтобы в базе точно была хотя бы одна живая сессия

    const legacy = btoa("secret_admin_password");
    const req = new Request("https://site.com/@zuck", {
      headers: { cookie: `admin_session=${legacy}` },
    });
    expect(await verifyAdmin(req, env)).toBe(false);
  });

  it("issues an opaque token that does not encode the password", async () => {
    const env = makeStatefulEnv();
    const token = await loginAndGetToken(env);
    expect(token).not.toBe(btoa("secret_admin_password"));
    // Токен - это hex случайных байтов, из него нельзя восстановить пароль.
    expect(/^[0-9a-f]{48}$/.test(token)).toBe(true);
    // Даже если декодировать его как base64, пароль там не окажется.
    const decoded = (() => { try { return atob(token); } catch { return ""; } })();
    expect(decoded).not.toContain("secret_admin_password");
  });

  it("issues a different token on each login", async () => {
    const env = makeStatefulEnv();
    const a = await loginAndGetToken(env);
    const b = await loginAndGetToken(env);
    expect(a).not.toBe(b);
    expect(a.length).toBe(48);
    expect(b.length).toBe(48);
  });

  it("revokes the session on logout", async () => {
    const { verifyAdmin } = await import("../src/admin");
    const env = makeStatefulEnv();
    const token = await loginAndGetToken(env);

    const reqAuth = new Request("https://site.com/admin", {
      headers: { cookie: `admin_session=${token}` },
    });
    expect(await verifyAdmin(reqAuth, env)).toBe(true);

    const logoutReq = new Request("https://site.com/admin/logout", {
      headers: { cookie: `admin_session=${token}` },
    });
    const logoutRes = await handleAdminRoute(logoutReq, env);
    expect(logoutRes.status).toBe(302);

    // После выхода тот же токен больше не действителен.
    expect(await verifyAdmin(reqAuth, env)).toBe(false);
  });

  it("locks login after repeated wrong passwords", async () => {
    const env = makeStatefulEnv();
    for (let i = 0; i < 5; i++) {
      const body = new FormData();
      body.set("password", "wrong_pass");
      const req = new Request("https://site.com/admin/login", { method: "POST", body });
      await handleAdminRoute(req, env);
    }

    // Шестая попытка блокируется даже с ВЕРНЫМ паролем.
    const token = await loginAndGetToken(env);
    expect(token).toBe("");

    const body = new FormData();
    body.set("password", "secret_admin_password");
    const req = new Request("https://site.com/admin/login", { method: "POST", body });
    const res = await handleAdminRoute(req, env);
    const html = await res.text();
    expect(html).toContain("Слишком много неудачных попыток");
  });

  it("returns webhook status in admin API", async () => {
    const env = makeStatefulEnv();
    const token = await loginAndGetToken(env);
    const req = new Request("https://site.com/admin/api/webhook/status", {
      headers: { cookie: `admin_session=${token}` },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).includes("getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "https://old.workers.dev/telegram/sec", pending_update_count: 2 } }));
      }
      return origFetch(url, init);
    }) as any;
    try {
      const res = await handleAdminRoute(req, env);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.ok).toBe(true);
      expect(data.webhook.pending_update_count).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
