import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { isChatUnavailable } from "../src/telegram";

const ADMIN = 369330135;
const USER = 5550001;

describe("isChatUnavailable", () => {
  it("recognises 'blocked by the user' and similar Telegram 403s", () => {
    expect(isChatUnavailable(new Error("Telegram sendMessage: Forbidden: bot was blocked by the user"))).toBe(true);
    expect(isChatUnavailable("Error: Telegram sendPhoto: Forbidden: user is deactivated")).toBe(true);
    expect(isChatUnavailable(new Error("Telegram sendMessage: Bad Request: chat not found"))).toBe(true);
  });
  it("does not hide real failures", () => {
    expect(isChatUnavailable(new Error("Telegram sendMessage: Bad Request: can't parse entities"))).toBe(false);
    expect(isChatUnavailable(new Error("Browser crashed: Forbidden"))).toBe(false);
    expect(isChatUnavailable(new Error("D1_ERROR"))).toBe(false);
  });
});

describe("queue: user blocked the bot", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("acks without retry, no ALERT to admins, records bot_blocked", async () => {
    const sentTo: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (String(url).includes("api.telegram.org")) {
        if (body.chat_id) sentTo.push(Number(body.chat_id));
        if (Number(body.chat_id) === USER) {
          return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }));
      }
      return new Response("{}");
    }));

    const events: Array<[number, string, string]> = [];
    const status = new Map<number, string>();
    const DB: any = {
      prepare(sql: string) {
        let args: any[] = [];
        const stmt: any = {
          bind: (...a: any[]) => { args = a; return stmt; },
          first: async () => {
            if (/FROM processed_updates/.test(sql)) { const s = status.get(args[0]); return s ? { status: s } : null; }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (/INSERT INTO processed_updates/.test(sql)) status.set(args[0], "processing");
            if (/UPDATE processed_updates SET status='done'/.test(sql)) status.set(args[1], "done");
            if (/DELETE FROM processed_updates/.test(sql)) status.delete(args[0]);
            if (/INSERT INTO user_events/.test(sql)) events.push([Number(args[0]), String(args[1]), String(args[2] ?? "")]);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
      batch: async (s: any[]) => s.map(() => ({ results: [] })),
    };
    const env: any = { DB, TELEGRAM_TOKEN: "t", WEBHOOK_SECRET: "s", ADMIN_IDS: String(ADMIN), SITE_DOMAIN: "threadsviewer.online" };
    const msg = {
      body: { update_id: 77, message: { message_id: 5, from: { id: USER, first_name: "U" }, chat: { id: USER, type: "private" }, date: 0, text: "/start" } },
      ack: vi.fn(), retry: vi.fn(),
    };
    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.retry).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
    expect(sentTo).not.toContain(ADMIN);
    expect(status.get(77)).toBe("done");
    expect(events.some(([uid, type, data]) => uid === USER && type === "bot_blocked" && data === "blocked")).toBe(true);
  });
});
