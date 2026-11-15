import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { decideMaintenance, getMaintenance, isMaintenanceGated, maintenanceMessage, syncMaintenance } from "../src/maintenance";
import { renderMaintenanceSection } from "../src/admin";

const ctx: any = { waitUntil: (p: Promise<unknown>) => { p?.catch?.(() => {}); }, passThroughOnException() {} };

/** Мок D1: таблица аккаунтов (enabled/alive) + bot_state с честным числом изменений */
function makeEnv(enabled: number, alive: number) {
  const state = new Map<string, string>();
  const acc = { enabled, alive };
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        first: async () => {
          if (/SUM\(enabled\) enabled, SUM\(enabled AND is_alive\) alive/.test(sql)) return { ...acc };
          if (/FROM bot_state/.test(sql)) { const v = state.get(`${args[0]}|${args[1]}`); return v == null ? null : { value: v }; }
          return null;
        },
        run: async () => {
          if (/^INSERT INTO bot_state/.test(sql)) { state.set(`${args[0]}|${args[1]}`, String(args[2])); return { meta: { changes: 1 } }; }
          if (/^UPDATE bot_state SET value=\?,updated_at=\? WHERE scope='system' AND state_key='maintenance_state' AND value=\?/.test(sql)) {
            const k = "system|maintenance_state";
            if (state.get(k) !== args[2]) return { meta: { changes: 0 } };
            state.set(k, String(args[0]));
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  const env: any = { DB, TELEGRAM_TOKEN: "t", ADMIN_IDS: "1", WEBHOOK_SECRET: "s", BOT_USERNAME: "threadsreaderbot" };
  return { env, state, acc };
}

function stubTelegram() {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      sent.push(JSON.parse(init?.body || "{}").text || "");
      return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }));
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("заглушка: решение и пути", () => {
  it("включается, только когда аккаунты есть и живых нет; ручной режим важнее", () => {
    expect(decideMaintenance("auto", 3, 0)).toBe(true);
    expect(decideMaintenance("auto", 3, 1)).toBe(false);
    expect(decideMaintenance("auto", 0, 0)).toBe(false);
    expect(decideMaintenance("on", 3, 3)).toBe(true);
    expect(decideMaintenance("off", 3, 0)).toBe(false);
  });

  it("закрывает главную, профили, посты и их API; не трогает админку и служебное", () => {
    for (const p of ["/", "/en/", "/@zuck", "/@zuck/post/DAbc_12", "/zuck/post/DAbc_12", "/api/profile/zuck", "/api/comments/zuck/0"]) expect(isMaintenanceGated(p)).toBe(true);
    for (const p of ["/admin", "/stats", "/donate", "/robots.txt", "/sitemap.xml", "/telegram/s", "/terms", "/api/img", "/favicon.svg", "/fallback.js"]) expect(isMaintenanceGated(p)).toBe(false);
  });
});

describe("заглушка: переходы и сообщения в Telegram", () => {
  it("все cookies умерли -> заглушка и одно сообщение; загрузили свежие -> сайт работает и сообщение", async () => {
    const sent = stubTelegram();
    const { env, acc, state } = makeEnv(3, 2);
    expect((await syncMaintenance(env)).on).toBe(false);
    expect(sent).toHaveLength(0); // первая запись после деплоя - молча
    acc.alive = 0;
    const on = await syncMaintenance(env);
    expect(on.on).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Сайт переведён на заглушку");
    expect(sent[0]).toContain("живых 0 из 3");
    expect(state.get("system|maintenance_state")).toMatch(/^on\|/);
    await syncMaintenance(env);
    expect(sent).toHaveLength(1); // повторно не пишем
    acc.alive = 1;
    expect((await syncMaintenance(env)).on).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Сайт снова работает");
    expect(sent[1]).toContain("Живых аккаунтов: 1 из 3");
  });

  it("состояние кэшируется на 30 с, fresh перечитывает", async () => {
    stubTelegram();
    const { env, acc } = makeEnv(2, 1);
    expect((await getMaintenance(env)).on).toBe(false);
    acc.alive = 0;
    expect((await getMaintenance(env)).on).toBe(false);
    expect((await getMaintenance(env, { fresh: true })).on).toBe(true);
  });

  it("текст выхода показывает, сколько висела заглушка", () => {
    const msg = maintenanceMessage({ on: false, mode: "auto", enabled: 3, alive: 2, since: null }, `on|${new Date(Date.now() - 15 * 60_000).toISOString()}`);
    expect(msg).toContain("(15 мин)");
  });

  it("блок в админке", () => {
    const html = renderMaintenanceSection({ on: true, mode: "auto", enabled: 4, alive: 0, since: new Date().toISOString() });
    expect(html).toContain("Сайт на заглушке");
    expect(html).toContain('value="auto"');
    expect(html).toContain("живых сейчас 0 из 4");
  });
});

describe("заглушка: ответы сайта", () => {
  it("профиль и главная - страница 503, API - JSON 503; админка и robots работают", async () => {
    stubTelegram();
    const { env } = makeEnv(3, 0);
    const prof = await worker.fetch(new Request("https://threadsviewer.online/@zuck"), env, ctx);
    expect(prof.status).toBe(503);
    expect(prof.headers.get("retry-after")).toBe("600");
    expect(prof.headers.get("cache-control")).toContain("no-store");
    const html = await prof.text();
    expect(html).toContain("Технические неполадки");
    expect(html).toContain("подождите");
    expect(html).not.toContain("в обход заглушки"); // не админ

    const home = await worker.fetch(new Request("https://threadsviewer.online/en/"), env, ctx);
    expect(home.status).toBe(503);
    expect(await home.text()).toContain("Technical difficulties");

    const api = await worker.fetch(new Request("https://threadsviewer.online/api/comments/zuck/0?code=DAbc_12-xY"), env, ctx);
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ ok: false, maintenance: true, status: "maintenance" });

    const st = await worker.fetch(new Request("https://threadsviewer.online/api/maintenance"), env, ctx);
    expect(await st.json()).toEqual({ ok: true, on: true });

    const robots = await worker.fetch(new Request("https://threadsviewer.online/robots.txt"), env, ctx);
    expect(robots.status).toBe(200);
    const admin = await worker.fetch(new Request("https://threadsviewer.online/admin"), env, ctx);
    expect(admin.status).not.toBe(503);
  });

  it("когда аккаунты живы, профиль отдаётся как обычно", async () => {
    stubTelegram();
    const { env } = makeEnv(3, 2);
    const prof = await worker.fetch(new Request("https://threadsviewer.online/@zuck"), env, ctx);
    expect(prof.status).toBe(200);
    const st = await worker.fetch(new Request("https://threadsviewer.online/api/maintenance"), env, ctx);
    expect(await st.json()).toEqual({ ok: true, on: false });
  });
});
