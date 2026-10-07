import { afterEach, describe, expect, it, vi } from "vitest";

const threadsMock = vi.hoisted(() => ({ fetchPosts: vi.fn() }));
vi.mock("../src/threads", async (orig) => ({ ...(await orig<any>()), ...threadsMock, logSystem: async () => {} }));

import { Bot } from "../src/bot";

function makeEnv() {
  const state = new Map<string, string>();
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/DELETE FROM bot_state/.test(sql)) state.delete(`${args[0]}|${args[1]}`);
          return { meta: { changes: 1 } };
        },
        first: async () => {
          if (/FROM bot_state/.test(sql)) { const v = state.get(`${args[0]}|${args[1]}`); return v == null ? null : { value: v }; }
          return null;
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  return { DB, WEBHOOK_SECRET: "s", TELEGRAM_TOKEN: "t", BOT_USERNAME: "threadsreaderbot" } as any;
}

function tgMock(failSendMessage = false) {
  const calls: Array<{ method: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() || "";
    const body = init?.body instanceof FormData ? Object.fromEntries((init.body as FormData).entries()) : JSON.parse(String(init?.body || "{}"));
    calls.push({ method, body });
    if (failSendMessage && method === "sendMessage" && /^(<b>)?\d+\./.test(String(body.text))) return Response.json({ ok: false, description: "Bad Request" });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  }));
  return calls;
}

const from = { id: 42, is_bot: false, first_name: "U", language_code: "ru" };
const posts = Array.from({ length: 20 }, (_, i) => ({ text: `post ${i + 1}`, has_image: false, has_video: false, postUrl: `/@zuck/post/CODE${i}xx` }));
const press = (bot: Bot, data: string) => bot.update({ update_id: 1, callback_query: { id: "cb", from, data, message: { message_id: 9, chat: { id: 42 } } } } as any);

afterEach(() => { vi.unstubAllGlobals(); threadsMock.fetchPosts.mockReset(); });

describe("bot: post pages", () => {
  it("screenshots page 2 (6–10) are taken for posts 6–10, not only for the first 5", async () => {
    const calls = tgMock();
    // скриншоты есть у 6 и 7, у 8–10 не получились
    threadsMock.fetchPosts.mockResolvedValue({ status: "ok", data: posts.map((p, i) => (i === 5 || i === 6 ? { ...p, image: new Uint8Array([1, 2, 3]) } : p)) });
    await press(new Bot(makeEnv()), "img:zuck:1");
    expect(threadsMock.fetchPosts).toHaveBeenCalledWith(expect.anything(), "zuck", "img", 20, 5);
    const photos = calls.filter((c) => c.method === "sendPhoto");
    expect(photos.map((c) => c.body.caption)).toEqual(["6. @zuck", "7. @zuck"]);
    // посты без скриншота НЕ пропадают молча - приходят текстом
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
    for (const n of [8, 9, 10]) expect(texts.some((t) => t.startsWith(`<b>${n}.</b>`) && t.includes(`post ${n}`) && t.includes("скриншот не получился"))).toBe(true);
    expect(texts.some((t) => t.includes("6–10"))).toBe(true);
  });

  it("text page 3 (11–15) sends posts 11–15 before the summary", async () => {
    const calls = tgMock();
    threadsMock.fetchPosts.mockResolvedValue({ status: "ok", data: posts });
    await press(new Bot(makeEnv()), "text:zuck:2");
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
    const idx = (s: string) => texts.findIndex((t) => t.includes(s));
    for (const n of [11, 12, 13, 14, 15]) expect(idx(`post ${n}`)).toBeGreaterThanOrEqual(0);
    expect(idx("11–15")).toBeGreaterThan(idx("post 15"));
  });

  it("never claims '6–10 of 20' when nothing could be delivered", async () => {
    const calls = tgMock(true);
    threadsMock.fetchPosts.mockResolvedValue({ status: "ok", data: posts });
    await press(new Bot(makeEnv()), "text:zuck:1");
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
    expect(texts.some((t) => t.includes("Не удалось показать посты 6–10"))).toBe(true);
    expect(texts.some((t) => t.includes("6–10 из"))).toBe(false);
  });

  it("very long posts are trimmed to fit Telegram's limit after HTML escaping", async () => {
    const calls = tgMock();
    threadsMock.fetchPosts.mockResolvedValue({ status: "ok", data: [{ text: "<&>".repeat(1500), has_image: false, has_video: false }] });
    await press(new Bot(makeEnv()), "text:longuser:0");
    const post = calls.find((c) => c.method === "sendMessage" && String(c.body.text).startsWith("<b>1.</b>"));
    expect(post).toBeTruthy();
    expect(String(post!.body.text).length).toBeLessThanOrEqual(4096);
  });
});
