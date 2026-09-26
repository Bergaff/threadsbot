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
      all: async () => ({
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
      }),
      run: async () => ({ meta: { changes: 1 } }),
    }),
    first: async () => {
      if (query.includes("threads_accounts")) return { total: 1, enabled: 1, alive: 1 };
      return { total: 1 };
    },
    all: async () => ({
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
    }),
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
    const token = btoa("secret_admin_password");
    const req = new Request("https://site.com/admin", {
      headers: { cookie: `admin_session=${token}` },
    });
    const res = await handleAdminRoute(req, mockEnv);
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
    expect(html).toContain("География посетителей (Страны, что заходят)");
    expect(html).toContain("Поведение пользователей и повторные запросы (Ретеншн)");
  });

  it("verifyAdmin returns true only for authenticated admin cookies", async () => {
    const { verifyAdmin } = await import("../src/admin");
    const validToken = btoa("secret_admin_password");
    const reqAuth = new Request("https://site.com/@zuck", {
      headers: { cookie: `admin_session=${validToken}` },
    });
    const reqUnauth = new Request("https://site.com/@zuck");
    const reqWrong = new Request("https://site.com/@zuck", {
      headers: { cookie: `admin_session=invalid` },
    });
    expect(verifyAdmin(reqAuth, mockEnv)).toBe(true);
    expect(verifyAdmin(reqUnauth, mockEnv)).toBe(false);
    expect(verifyAdmin(reqWrong, mockEnv)).toBe(false);
  });

  it("returns webhook status in admin API", async () => {
    const token = btoa("secret_admin_password");
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
      const res = await handleAdminRoute(req, mockEnv);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.ok).toBe(true);
      expect(data.webhook.pending_update_count).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
