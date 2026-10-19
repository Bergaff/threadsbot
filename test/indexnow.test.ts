import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DEFAULT_INDEXNOW_KEY, INDEXNOW_ENDPOINT, notifyAfterDeploy, notifyProfileUpdated, submitIndexNow } from "../src/indexnow";
import { renderIndexNowSection } from "../src/admin";

const ctx: any = { waitUntil() {}, passThroughOnException() {} };

/** Мок D1: bot_state с честным tryLock (upsert с условием по возрасту) */
function makeEnv(extra: Record<string, unknown> = {}) {
  const state = new Map<string, { value: string; updated: number }>();
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        first: async () => {
          if (/FROM bot_state/.test(sql)) { const v = state.get(`${args[0]}|${args[1]}`); return v ? { value: v.value } : null; }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql) && /WHERE CAST\((bot_state\.)?value AS INTEGER\) < \?/.test(sql)) {
            const k = `${args[0]}|${args[1]}`; const cur = state.get(k);
            if (!cur || Number(cur.value) < Number(args[4])) { state.set(k, { value: String(args[2]), updated: Date.now() }); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, { value: String(args[2]), updated: Date.now() });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    batch: async (s: any[]) => s.map(() => ({ results: [] })),
  };
  return { env: { DB, SITE_DOMAIN: "threadsviewer.online", TELEGRAM_TOKEN: "t", WEBHOOK_SECRET: "s", ...extra } as any, state };
}

function mockFetch(status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(status === 200 ? "" : "bad key", { status });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("IndexNow key file", () => {
  it("/<key>.txt returns exactly the key as text/plain (not treated as a username)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(`https://threadsviewer.online/${DEFAULT_INDEXNOW_KEY}.txt`), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(DEFAULT_INDEXNOW_KEY);
  });
  it("custom INDEXNOW_KEY is served instead of the default", async () => {
    const { env } = makeEnv({ INDEXNOW_KEY: "abcdef1234567890" });
    const res = await worker.fetch(new Request("https://threadsviewer.online/abcdef1234567890.txt"), env, ctx);
    expect(await res.text()).toBe("abcdef1234567890");
  });
});

describe("submitIndexNow", () => {
  it("posts host/key/keyLocation/urlList to Yandex, drops foreign hosts and duplicates, stores the result", async () => {
    const calls = mockFetch(202);
    const { env, state } = makeEnv();
    const r = await submitIndexNow(env, ["/", "/@zuck", "/@zuck", "https://evil.example/x"], "test");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(INDEXNOW_ENDPOINT);
    expect(calls[0].body).toEqual({
      host: "threadsviewer.online",
      key: DEFAULT_INDEXNOW_KEY,
      keyLocation: `https://threadsviewer.online/${DEFAULT_INDEXNOW_KEY}.txt`,
      urlList: ["https://threadsviewer.online/", "https://threadsviewer.online/@zuck"],
    });
    expect(JSON.parse(state.get("0|indexnow_last")!.value).count).toBe(2);
  });
  it("explains 403 (key not confirmed)", async () => {
    mockFetch(403);
    const { env } = makeEnv();
    const r = await submitIndexNow(env, ["/"], "test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ключ не подтверждён");
  });
});

describe("automatic notifications", () => {
  it("profile: once per day, only from the main domain", async () => {
    const calls = mockFetch(200);
    const { env } = makeEnv();
    expect(await notifyProfileUpdated(env, "zuck", "threadsbot.workers.dev")).toBeNull();
    expect((await notifyProfileUpdated(env, "zuck", "threadsviewer.online"))?.ok).toBe(true);
    expect(await notifyProfileUpdated(env, "zuck", "threadsviewer.online")).toBeNull();
    expect((await notifyProfileUpdated(env, "durov", "threadsviewer.online"))?.ok).toBe(true);
    expect(calls.map((c) => c.body.urlList[0])).toEqual(["https://threadsviewer.online/@zuck", "https://threadsviewer.online/@durov"]);
  });
  it("after deploy: main pages once per version, retried if Yandex failed", async () => {
    let calls = mockFetch(500);
    const { env } = makeEnv();
    expect((await notifyAfterDeploy(env, "v1"))?.ok).toBe(false);
    vi.unstubAllGlobals();
    calls = mockFetch(200);
    const r = await notifyAfterDeploy(env, "v1");
    expect(r?.ok).toBe(true);
    expect(calls[0].body.urlList).toContain("https://threadsviewer.online/ru/");
    expect(await notifyAfterDeploy(env, "v1")).toBeNull();
    expect((await notifyAfterDeploy(env, "v2"))?.ok).toBe(true);
  });
});

describe("admin section", () => {
  it("shows last result and the key file link", () => {
    const { env } = makeEnv();
    const html = renderIndexNowSection(env, { at: new Date().toISOString(), ok: false, status: 403, count: 3, reason: "деплой v1", sample: ["https://threadsviewer.online/"], error: "ключ не подтверждён" });
    expect(html).toContain(`https://threadsviewer.online/${DEFAULT_INDEXNOW_KEY}.txt`);
    expect(html).toContain("HTTP 403");
    expect(html).toContain("/admin/api/indexnow/run");
    expect(renderIndexNowSection(env, null)).toContain("Отправок ещё не было");
  });
});
