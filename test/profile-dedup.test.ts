import { beforeEach, describe, expect, it, vi } from "vitest";

// Скрапер замокан, ожидание - мгновенное
const threadsMock = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  fetchCommentsByCode: vi.fn(),
  fetchProfileWithPosts: vi.fn(),
  fetchPublicProfile: vi.fn(),
}));
vi.mock("../src/threads", async (orig) => ({ ...(await orig<any>()), ...threadsMock, logSystem: async () => {}, sleep: async () => {} }));

import worker from "../src/index";
import { Database } from "../src/db";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ctx: any = { waitUntil: (p: Promise<unknown>) => { p?.catch?.(() => {}); }, passThroughOnException() {} };

/**
 * Мок D1 с честным upsert блокировки (как в SQLite: обновление только если старая блокировка протухла)
 * и кешем, который «другой сервер» заполняет через cacheAfterPolls опросов.
 */
function makeEnv(opts: { lockHeldBy?: number; cacheAfterPolls?: number; cacheValue?: any; dropLockAfterPolls?: number } = {}) {
  const state = new Map<string, string>();
  if (opts.lockHeldBy) state.set("scrape:zuck|scrape_lock", String(opts.lockHeldBy));
  let cachePolls = 0;
  let lockPolls = 0;
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql) && /WHERE CAST\(bot_state.value AS INTEGER\) < \?/.test(sql)) {
            const k = `${args[0]}|${args[1]}`;
            const cur = state.get(k);
            if (cur == null || Number(cur) < Number(args[4])) { state.set(k, String(args[2])); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/DELETE FROM bot_state/.test(sql)) state.delete(`${args[0]}|${args[1]}`);
          return { meta: { changes: 1 } };
        },
        first: async () => {
          if (/FROM bot_state/.test(sql)) {
            if (String(args[1]) === "scrape_lock") {
              lockPolls++;
              if (opts.dropLockAfterPolls && lockPolls >= opts.dropLockAfterPolls) state.delete(`${args[0]}|${args[1]}`);
            }
            const v = state.get(`${args[0]}|${args[1]}`);
            return v == null ? null : { value: v };
          }
          if (/FROM cache/i.test(sql)) {
            cachePolls++;
            if (opts.cacheAfterPolls && cachePolls > opts.cacheAfterPolls) return { data: JSON.stringify(opts.cacheValue), cached_at: new Date().toISOString() };
            return null;
          }
          if (/FROM threads_accounts/.test(sql) && /SUM\(enabled/.test(sql)) return { total: 3, enabled: 3, alive: 3 };
          return null;
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  const env: any = { DB, BROWSER: {}, WEBHOOK_SECRET: "s", BOT_USERNAME: "threadsreaderbot" };
  return { env, state };
}

const req = () => new Request("https://threadsviewer.online/api/profile/zuck", { headers: { "user-agent": CHROME, "cf-connecting-ip": "1.2.3.4" } });
const profileData = { profile: { username: "zuck" }, posts: [{ id: "A1", text: "hi", author: "zuck" }] };

beforeEach(() => {
  for (const f of Object.values(threadsMock)) f.mockReset();
});

describe("межсерверная защита от двойной загрузки профиля", () => {
  it("D1-блокировка: берётся один раз, повторно - только когда протухла", async () => {
    const { env } = makeEnv();
    const db = new Database(env);
    expect(await db.tryLock("scrape:x", "scrape_lock", 90_000)).toBe(true);
    expect(await db.tryLock("scrape:x", "scrape_lock", 90_000)).toBe(false);
    expect(await db.tryLock("scrape:x", "scrape_lock", -1)).toBe(true);
  });

  it("свободно: качаем сами и снимаем блокировку", async () => {
    const { env, state } = makeEnv();
    threadsMock.fetchProfileWithPosts.mockResolvedValue({ status: "ok", data: profileData, account: "1" });
    const res = await worker.fetch(req(), env, ctx);
    expect(res.status).toBe(200);
    expect(threadsMock.fetchProfileWithPosts).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.has("scrape:zuck|scrape_lock")).toBe(false);
  });

  it("профиль уже качает другой сервер: ждём его результат, второй браузер не запускаем", async () => {
    const { env } = makeEnv({ lockHeldBy: Date.now(), cacheAfterPolls: 3, cacheValue: profileData });
    const res = await worker.fetch(req(), env, ctx);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.posts).toHaveLength(1);
    expect(threadsMock.fetchProfileWithPosts).not.toHaveBeenCalled();
  });

  it("у другого сервера не вышло (блокировка снята, кеша нет) - качаем сами", async () => {
    const { env } = makeEnv({ lockHeldBy: Date.now(), dropLockAfterPolls: 2 });
    threadsMock.fetchProfileWithPosts.mockResolvedValue({ status: "ok", data: profileData, account: "2" });
    const res = await worker.fetch(req(), env, ctx);
    expect(res.status).toBe(200);
    expect(threadsMock.fetchProfileWithPosts).toHaveBeenCalledTimes(1);
  });

  it("протухшая блокировка (упавший сервер) не мешает", async () => {
    const { env } = makeEnv({ lockHeldBy: Date.now() - 5 * 60_000 });
    threadsMock.fetchProfileWithPosts.mockResolvedValue({ status: "ok", data: profileData, account: "1" });
    expect((await worker.fetch(req(), env, ctx)).status).toBe(200);
    expect(threadsMock.fetchProfileWithPosts).toHaveBeenCalledTimes(1);
  });
});
