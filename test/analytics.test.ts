import { describe, expect, it } from "vitest";
import { classifyTraffic, isDatacenterOrg, percentile, trackJsBeacon, trackRequest } from "../src/analytics";
import { Database } from "../src/db";
import type { Env } from "../src/config";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function captureEnv(extra: Partial<Env> = {}) {
  const rows: Array<{ type: string; data: string }> = [];
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => { if (/INSERT INTO user_events/i.test(sql)) rows.push({ type: String(args[0]), data: String(args[1]) }); return {}; },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  const env = { DB, WEBHOOK_SECRET: "s", TELEGRAM_TOKEN: "t", ...extra } as unknown as Env;
  return { env, rows };
}

describe("classifyTraffic", () => {
  it("separates humans, search, previews, AI, scripts and monitors", () => {
    expect(classifyTraffic(CHROME).kind).toBe("human");
    expect(classifyTraffic("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({ kind: "search", name: "Googlebot" });
    expect(classifyTraffic("TelegramBot (like TwitterBot)").kind).toBe("preview");
    expect(classifyTraffic("WhatsApp/2.23.20.0 A").kind).toBe("preview");
    expect(classifyTraffic("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)").kind).toBe("preview");
    expect(classifyTraffic("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)").kind).toBe("ai");
    expect(classifyTraffic("curl/8.4.0").kind).toBe("script");
    expect(classifyTraffic("python-requests/2.31.0").kind).toBe("script");
    expect(classifyTraffic("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36").kind).not.toBe("human");
    expect(classifyTraffic("").kind).toBe("script");
    expect(classifyTraffic("Mozilla/5.0 (compatible; SomeCrawler/1.0)").kind).toBe("other");
    expect(classifyTraffic("Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)").kind).toBe("monitor");
  });

  it("detects datacenter / VPN providers", () => {
    expect(isDatacenterOrg("Hetzner Online GmbH")).toBe(true);
    expect(isDatacenterOrg("DigitalOcean, LLC")).toBe(true);
    expect(isDatacenterOrg("PJSC Rostelecom")).toBe(false);
    expect(isDatacenterOrg("")).toBe(false);
  });

  it("percentile works on sorted arrays", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
  });
});

describe("trackRequest", () => {
  it("a human page view writes exactly one view, one country and one visitor id", async () => {
    const { env, rows } = captureEnv();
    const req = new Request("https://threadsviewer.online/@zuck", { headers: { "user-agent": CHROME, "cf-connecting-ip": "1.2.3.4" } });
    await trackRequest(env, req, "profile", "ru");
    expect(rows.map(r => r.type).sort()).toEqual(["web_geo", "web_pv", "web_uv"]);
    expect(rows.find(r => r.type === "web_geo")!.data).toBe("RU");
    const uv = rows.find(r => r.type === "web_uv")!.data;
    expect(uv).toMatch(/^[0-9a-f]{16}$/);
    expect(uv).not.toContain("1.2.3.4");
  });

  it("API calls of humans do not add page views or countries (no double counting)", async () => {
    const { env, rows } = captureEnv();
    await trackRequest(env, new Request("https://x/api/profile/zuck", { headers: { "user-agent": CHROME } }), "api", "RU");
    expect(rows).toEqual([]);
  });

  it("link previews are robots, not people", async () => {
    const { env, rows } = captureEnv();
    await trackRequest(env, new Request("https://x/@zuck", { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), "profile", "NL");
    expect(rows).toEqual([{ type: "web_robot", data: "preview:Telegram (превью):profile" }]);
  });

  it("JS beacon is counted only for browsers", async () => {
    const { env, rows } = captureEnv();
    expect(await trackJsBeacon(env, new Request("https://x/api/hit", { method: "POST", headers: { "user-agent": CHROME } }))).toBe(true);
    expect(await trackJsBeacon(env, new Request("https://x/api/hit", { method: "POST", headers: { "user-agent": "curl/8" } }))).toBe(false);
    expect(rows.map(r => r.type)).toEqual(["web_js"]);
  });
});

describe("worker counts views served from Edge cache too", () => {
  it("/@user writes web_pv before the edge-cache lookup, /api/hit returns 204", async () => {
    const worker = (await import("../src/index")).default;
    const { env, rows } = captureEnv({ BASE_URL: "https://www.threads.com", SITE_URL: "https://threadsviewer.online", ADMIN_IDS: "1" } as any);
    const ctxPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { ctxPromises.push(p); }, passThroughOnException: () => {} } as any;
    // Подменяем Edge-кэш: «попадание» должно отдаться, но просмотр всё равно учтён
    const g = globalThis as any;
    const prev = g.caches;
    g.caches = { default: { match: async () => new Response("cached page", { status: 200 }), put: async () => {} } };
    try {
      const res = await worker.fetch(new Request("https://threadsviewer.online/@zuck", { headers: { "user-agent": CHROME } }), env, ctx);
      expect(await res.text()).toBe("cached page");
      const hit = await worker.fetch(new Request("https://threadsviewer.online/api/hit", { method: "POST", headers: { "user-agent": CHROME } }), env, ctx);
      expect(hit.status).toBe(204);
      await Promise.all(ctxPromises);
    } finally {
      g.caches = prev;
    }
    const types = rows.map(r => r.type);
    expect(types).toContain("web_pv");
    expect(types).toContain("web_js");
  });
});

describe("Database.siteTruth aggregation", () => {
  it("builds numbers only from raw events", async () => {
    const answers: Array<[RegExp, any[]]> = [
      [/event_type='web_pv' AND timestamp>\? GROUP BY event_data/, [{ k: "home", c: 4 }, { k: "profile", c: 10 }, { k: "post", c: 1 }]],
      [/IN \('web_uv','web_js'\)/, [{ t: "web_uv", c: 6 }, { t: "web_js", c: 5 }]],
      [/IN \('web_dc','web_api','web_more','web_comments'\)/, [{ t: "web_api", c: 9 }, { t: "web_more", c: 2 }, { t: "web_dc", c: 3 }]],
      [/event_type='web_robot' AND timestamp>\? GROUP BY/, [{ k: "search:Googlebot:profile", c: 7 }, { k: "preview:Telegram (превью):profile", c: 2 }, { k: "search:Googlebot:home", c: 1 }]],
      [/event_type='scrape'/, [{ k: "profile|ok|20|12000" }, { k: "profile|ok|10|30000" }, { k: "profile|service_error|0|60000" }, { k: "more|ok|40|45000" }]],
      [/event_type='web_ms'/, [{ v: 30 }, { v: 40 }, { v: 50 }, { v: 900 }]],
      [/event_type='acct'/, [{ k: "fer|ok", c: 3 }, { k: "bodie|err", c: 4 }, { k: "bodie|dead", c: 1 }]],
    ];
    const DB: any = {
      prepare(sql: string) {
        const stmt: any = {
          bind: () => stmt,
          all: async () => ({ results: (answers.find(([re]) => re.test(sql))?.[1]) || [] }),
          first: async () => null,
          run: async () => ({}),
        };
        return stmt;
      },
    };
    const t = await new Database({ DB } as any).siteTruth();
    expect(t.pv).toEqual({ home: 4, profile: 10, post: 1, total: 15 });
    expect(t.uv24h).toBe(6);
    expect(t.js24h).toBe(5);
    expect(t.api24h).toBe(9);
    expect(t.dc24h).toBe(3);
    expect(t.robots24h.total).toBe(10);
    expect(t.robots24h.byKind).toEqual({ search: 8, preview: 2 });
    expect(t.robots24h.top[0]).toEqual({ kind: "search", name: "Googlebot", count: 8 });
    expect(t.scrape.profile.total).toBe(3);
    expect(t.scrape.profile.ok).toBe(2);
    expect(t.scrape.profile.failed).toBe(1);
    expect(t.scrape.profile.posts).toBe(30);
    expect(t.scrape.profile.ms.median).toBe(30000);
    expect(t.webMs.median).toBe(40);
    expect(t.webMs.max).toBe(900);
    expect(t.accounts.bodie).toEqual({ ok: 0, err: 4, dead: 1 });
    expect(t.accounts.fer.ok).toBe(3);
  });
});
