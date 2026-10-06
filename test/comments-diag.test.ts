import { beforeEach, describe, expect, it, vi } from "vitest";

// Скрапер замокан: проверяем маршрутизацию, кэш, статусы и диагностику, а не живой Threads
const threadsMock = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  fetchCommentsByCode: vi.fn(),
  fetchProfileWithPosts: vi.fn(),
  fetchPublicProfile: vi.fn(),
}));
vi.mock("../src/threads", async (orig) => ({ ...(await orig<any>()), ...threadsMock, logSystem: async () => {} }));

import worker from "../src/index";
import { hasReplies, isPostCode, postCodeFromUrl, postCodeOf } from "../src/postCode";
import { diagDue, formatDiagTelegram, lastCronAt, parseCount, pickPostForComments, runDiagnostics } from "../src/diagnostics";
import { renderDiagSection, renderScrapeErrors } from "../src/admin";
import { Database } from "../src/db";

const ctx: any = { waitUntil: (p: Promise<unknown>) => { p?.catch?.(() => {}); }, passThroughOnException() {} };

function makeEnv(scrapeRows: Array<{ k: string; ts: string }> = [], alive = 2) {
  const events: Array<{ type: string; data: string }> = [];
  const state = new Map<string, string>();
  const cacheSets: string[] = [];
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO user_events/.test(sql)) events.push({ type: String(args[args.length - 3] ?? args[1]), data: String(args[args.length - 2] ?? args[2]) });
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/INTO cache/i.test(sql)) cacheSets.push(String(args[0]));
          return { meta: { changes: 0 } };
        },
        first: async () => {
          if (/SELECT 1 AS x/.test(sql)) return { x: 1 };
          if (/FROM bot_state/.test(sql)) { const v = state.get(`${args[0]}|${args[1]}`); return v == null ? null : { value: v }; }
          if (/FROM threads_accounts/.test(sql) && /SUM\(enabled/.test(sql)) return { total: 3, enabled: 3, alive };
          return null;
        },
        all: async () => {
          if (/event_type='scrape'/.test(sql)) return { results: scrapeRows };
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  const env: any = { DB, BROWSER: {}, WEBHOOK_SECRET: "s", BOT_USERNAME: "threadsreaderbot" };
  return { env, events, state, cacheSets };
}

beforeEach(() => {
  for (const f of Object.values(threadsMock)) f.mockReset();
});

describe("post code helpers", () => {
  it("extracts the post code from links and ids", () => {
    expect(postCodeFromUrl("https://www.threads.com/@zuck/post/DAbc_12-xY")).toBe("DAbc_12-xY");
    expect(postCodeFromUrl("/@zuck/post/DAbc_12-xY/media")).toBe("DAbc_12-xY");
    expect(postCodeFromUrl("https://www.threads.com/@zuck")).toBeNull();
    expect(postCodeOf({ id: "DPhoto123" })).toBe("DPhoto123");
    expect(postCodeOf({ id: "1" })).toBe("");
    expect(isPostCode("a/b")).toBe(false);
    expect(hasReplies("12")).toBe(true);
    expect(hasReplies("0")).toBe(false);
    expect(hasReplies("")).toBe(false);
  });
});

describe("/api/comments", () => {
  it("opens comments by post code directly, not by guessing the post number", async () => {
    const { env } = makeEnv();
    threadsMock.fetchCommentsByCode.mockResolvedValue({ status: "ok", data: [{ author: "@a", text: "привет" }], account: "1" });
    const res = await worker.fetch(new Request("https://threadsviewer.online/api/comments/zuck/3?code=DAbc_12-xY&r=1"), env, ctx);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.comments).toHaveLength(1);
    expect(threadsMock.fetchCommentsByCode).toHaveBeenCalledWith(env, "zuck", "DAbc_12-xY", 30);
    expect(threadsMock.fetchComments).not.toHaveBeenCalled();
  });

  it("a scraper failure is an error, not 'no comments', and is logged with details", async () => {
    const { env, events } = makeEnv();
    threadsMock.fetchCommentsByCode.mockResolvedValue({ status: "service_error", data: null, error: "[1] страница поста пустая" });
    const res = await worker.fetch(new Request("https://threadsviewer.online/api/comments/zuck/0?code=DAbc_12-xY"), env, ctx);
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("service_error");
    expect(body.comments).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    const scrape = events.find((e) => e.type === "scrape");
    expect(scrape?.data).toContain("comments|service_error|0|");
    expect(scrape?.data).toContain("@zuck/post/DAbc_12-xY");
    expect(scrape?.data).toContain("страница поста пустая");
  });

  it("an empty result is not cached and is flagged when the counter shows replies", async () => {
    const { env, events, cacheSets } = makeEnv();
    threadsMock.fetchCommentsByCode.mockResolvedValue({ status: "ok", data: [], account: "2" });
    const res = await worker.fetch(new Request("https://threadsviewer.online/api/comments/zuck/0?code=DAbc_12-xY&r=1"), env, ctx);
    const body: any = await res.json();
    expect(body).toMatchObject({ ok: true, comments: [], expected: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(cacheSets).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.find((e) => e.type === "scrape")?.data).toContain("comments|empty_but_replies|0|");
  });

  it("without a code falls back to the old index-based path", async () => {
    const { env } = makeEnv();
    threadsMock.fetchComments.mockResolvedValue({ status: "post_not_found", data: null });
    const res = await worker.fetch(new Request("https://threadsviewer.online/api/comments/zuck/5"), env, ctx);
    expect(res.status).toBe(404);
    expect(threadsMock.fetchComments).toHaveBeenCalledWith(env, "zuck", 5, 30);
  });
});

describe("admin: what the errors are", () => {
  it("groups 24h scraper errors by kind and keeps recent cases with details", async () => {
    const ts = new Date().toISOString();
    const { env } = makeEnv([
      { k: "comments|service_error|0|31000|@a/post/X1|[fer] страница поста пустая (body=172)", ts },
      { k: "comments|service_error|0|29000|@b/post/X2|[2] страница поста пустая (body=180)", ts },
      { k: "profile|browser_busy|0|500|@c|", ts },
      { k: "profile|ok|20|9000|@d|", ts },
      { k: "profile|user_not_found|0|9000", ts }, // старый формат без target/error
      { k: "diag|ok|10|9000|@zuck|", ts },
    ]);
    const t = await new Database(env).siteTruth();
    expect(t.scrape.profile).toMatchObject({ total: 3, ok: 1, failed: 1, notFound: 1 });
    expect(t.scrape.diag).toBeUndefined();
    expect(t.scrapeErrors).toHaveLength(4);
    expect(t.scrapeErrorGroups[0]).toMatchObject({ kind: "comments", status: "service_error", count: 2 });
    const html = renderScrapeErrors(t);
    expect(html).toContain("Что за ошибки (24ч)");
    expect(html).toContain("Сбой: аккаунты не смогли открыть страницу");
    expect(html).toContain("страница поста пустая");
    expect(html).toContain("Браузер Cloudflare занят");
    expect(html).toContain("@b/post/X2");
  });
});

describe("daily diagnostics", () => {
  it("helpers: counts, picking a post with replies, schedule", () => {
    expect(parseCount("1,2K")).toBe(1200);
    expect(parseCount("12")).toBe(12);
    const pick = pickPostForComments([
      { text: "a", has_image: false, has_video: false, postUrl: "/@zuck/post/AAAAA1", replies: "3" },
      { text: "b", has_image: false, has_video: false, postUrl: "/@zuck/post/BBBBB2", replies: "1,5K" },
      { text: "c", has_image: false, has_video: false, replies: "99" },
    ]);
    expect(pick?.code).toBe("BBBBB2");
    const six = Date.UTC(2026, 9, 6, 6, 0);
    expect(diagDue(six, null)).toBe(true);
    expect(diagDue(six, new Date(six - 3600_000).toISOString())).toBe(false);
    expect(diagDue(Date.UTC(2026, 9, 6, 12, 0), new Date(six - 3600_000 * 20).toISOString())).toBe(false);
    expect(diagDue(Date.UTC(2026, 9, 6, 12, 0), new Date(six - 3600_000 * 30).toISOString())).toBe(true);
    expect(lastCronAt([{ at: "m", ok: true, fails: [], trigger: "manual" }, { at: "c", ok: true, fails: [] }])).toBe("c");
  });

  it("runs posts + comments checks and reports a broken comments collector", async () => {
    const { env, state } = makeEnv();
    threadsMock.fetchProfileWithPosts.mockResolvedValue({
      status: "ok", account: "1",
      data: { profile: {}, posts: Array.from({ length: 10 }, (_, i) => ({ text: `p${i}`, has_image: false, has_video: false, postUrl: `/@zuck/post/CODE${i}x`, replies: String(i) })) },
    });
    threadsMock.fetchCommentsByCode.mockResolvedValue({ status: "ok", data: [], account: "2" });
    threadsMock.fetchPublicProfile.mockResolvedValue({ exists: true, profile: {}, posts: [] });
    const r = await runDiagnostics(env, "manual");
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.db.status).toBe("ok");
    expect(by.posts.status).toBe("ok");
    expect(threadsMock.fetchCommentsByCode).toHaveBeenCalledWith(env, "zuck", "CODE9x", 10);
    expect(by.comments.status).toBe("fail");
    expect(by.comments.detail).toContain("собрано 0");
    expect(r.ok).toBe(false);
    expect(state.get("0|diag_last")).toContain("comments");
    expect(JSON.parse(state.get("0|diag_history")!)[0]).toMatchObject({ ok: false, trigger: "manual", fails: ["Комментарии"] });

    const tg = formatDiagTelegram(r);
    expect(tg).toContain("Ежедневная диагностика");
    expect(tg).toContain("❌ <b>Комментарии</b>");
    expect(tg).toContain("✅ <b>Загрузка постов</b>");
    const html = renderDiagSection(r, [{ at: r.at, ok: false, fails: ["Комментарии"], trigger: "manual" }]);
    expect(html).toContain('id="diag"');
    expect(html).toContain("Запустить сейчас");
    expect(html).toContain("есть проблемы");
  });

  it("all green when posts and comments load", async () => {
    const { env } = makeEnv();
    threadsMock.fetchProfileWithPosts.mockResolvedValue({
      status: "ok", account: "1",
      data: { profile: {}, posts: [{ text: "x", has_image: false, has_video: false, postUrl: "/@zuck/post/ABCDE1", replies: "40" }, { text: "y", has_image: false, has_video: false }, { text: "z", has_image: false, has_video: false }] },
    });
    threadsMock.fetchCommentsByCode.mockResolvedValue({ status: "ok", data: [{ author: "@a", text: "hi" }], account: "2" });
    threadsMock.fetchPublicProfile.mockResolvedValue({ exists: true, profile: {}, posts: [] });
    const r = await runDiagnostics(env, "cron");
    expect(r.checks.find((c) => c.id === "comments")?.status).toBe("ok");
    expect(r.ok).toBe(true);
  });
});
