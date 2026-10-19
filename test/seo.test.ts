import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { matchEdgeCache, putEdgeCache } from "../src/cache";
import { Database, STALE_PROFILE_MS } from "../src/db";

const ctx: any = { waitUntil() {}, passThroughOnException() {} };
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/** Мок D1: таблица cache в памяти, остальное пусто. */
function makeEnv(rows: Record<string, { data: unknown; ageMs: number }> = {}) {
  const sqls: string[] = [];
  const DB: any = {
    prepare(sql: string) {
      sqls.push(sql);
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        first: async () => {
          if (/FROM cache WHERE username=\? AND mode=\? AND page=\?/.test(sql)) {
            const r = rows[`${args[0]}|${args[1]}`];
            return r ? { data: JSON.stringify(r.data), cached_at: new Date(Date.now() - r.ageMs).toISOString() } : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async (s: any[]) => s.map(() => ({ results: [] })),
  };
  const env: any = { DB, SITE_DOMAIN: "threadsviewer.online", WEBHOOK_SECRET: "s", TELEGRAM_TOKEN: "t" };
  return { env, sqls };
}

const get = async (path: string, headers: Record<string, string> = {}, env = makeEnv().env) => {
  const res = await worker.fetch(new Request(`https://threadsviewer.online${path}`, { headers }), env, ctx);
  return { res, html: await res.text() };
};
const canonical = (html: string) => html.match(/rel="canonical" href="([^"]+)"/)?.[1];
const robots = (html: string) => html.match(/name="robots" content="([^"]+)"/)?.[1];

describe("home page: one language per URL", () => {
  it("Googlebot (US, no Accept-Language) gets the Russian home with canonical /", async () => {
    const { html } = await get("/", { "user-agent": GOOGLEBOT, "cf-ipcountry": "US" });
    expect(html).toContain('<html lang="ru"');
    expect(canonical(html)).toBe("https://threadsviewer.online/");
    expect(html).toContain('hreflang="ru" href="https://threadsviewer.online/"');
    expect(html).toContain('hreflang="en" href="https://threadsviewer.online/en/"');
    expect(html).not.toContain("/ru/");
  });

  it("English lives on /en/ (also when chosen via ?lang=en)", async () => {
    for (const p of ["/en/", "/?lang=en"]) {
      const { html } = await get(p);
      expect(html).toContain('<html lang="en"');
      expect(canonical(html)).toBe("https://threadsviewer.online/en/");
    }
  });

  it("language toggle on /en/ (?lang=ru) switches to Russian", async () => {
    const { html } = await get("/en/?lang=ru");
    expect(html).toContain('<html lang="ru"');
    expect(canonical(html)).toBe("https://threadsviewer.online/");
  });
});

describe("profile page for search engines", () => {
  const data = {
    profile: { username: "durov", displayName: "Pavel Durov", bio: "bio text", avatar: "", followers: "1M", verified: true },
    posts: [{ text: "Saved post about Telegram privacy", has_image: false, has_video: false, author: "durov" }],
  };

  it("no fresh cache: renders the saved copy (up to 7 days) instead of an empty 'Loading' page", async () => {
    const { env } = makeEnv({ "durov|web_profile": { data, ageMs: 2 * 86_400_000 } });
    const { res, html } = await get("/@durov", { "user-agent": GOOGLEBOT }, env);
    expect(res.status).toBe(200);
    expect(html).toContain("Saved post about Telegram privacy");
    expect(html).toContain('id="staleNote"');
    expect(html).toContain("var isStale = true;");
    expect(robots(html)).toBeUndefined();
  });

  it("fresh cache: no saved-copy note", async () => {
    const { env } = makeEnv({ "durov|web_profile": { data, ageMs: 60_000 } });
    const { html } = await get("/@durov", {}, env);
    expect(html).toContain("Saved post about Telegram privacy");
    expect(html).not.toContain('id="staleNote"');
    expect(html).toContain("var isStale = false;");
  });

  it("copy older than 7 days or a 'not found' copy is not used; an empty page is noindex", async () => {
    for (const row of [{ data, ageMs: STALE_PROFILE_MS + 60_000 }, { data: { notFound: true }, ageMs: 3_600_000 }]) {
      const { env } = makeEnv({ "durov|web_profile": row });
      const { html } = await get("/@durov", {}, env);
      expect(html).not.toContain("Saved post about Telegram privacy");
      expect(robots(html)).toBe("noindex, follow");
    }
  });

  it("post page also falls back to the saved copy", async () => {
    const { env } = makeEnv({ "durov|web_profile": { data, ageMs: 86_400_000 } });
    const { html } = await get("/@durov/post/ABC123", {}, env);
    expect(html).toContain("Saved post about Telegram privacy");
  });

  it("cleanup keeps profile copies for 7 days, other cache for 15 minutes", async () => {
    const { env, sqls } = makeEnv();
    await new Database(env).cleanup();
    expect(sqls).toContain("DELETE FROM cache WHERE cached_at<? AND mode<>'web_profile'");
    expect(sqls).toContain("DELETE FROM cache WHERE mode='web_profile' AND cached_at<?");
  });
});

describe("edge cache key includes the language cookie", () => {
  const store = new Map<string, Response>();
  beforeAll(() => {
    (globalThis as any).caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone() ?? undefined,
        put: async (r: Request, res: Response) => { store.set(r.url, res); },
      },
    };
  });
  afterEach(() => store.clear());
  afterAll(() => { delete (globalThis as any).caches; });

  it("a page cached for lang=en is not served to a visitor without the cookie", async () => {
    const withEn = new Request("https://threadsviewer.online/@zuck", { headers: { cookie: "lang=en" } });
    putEdgeCache(withEn, new Response("EN page", { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(await matchEdgeCache(new Request("https://threadsviewer.online/@zuck"))).toBeNull();
    const hit = await matchEdgeCache(new Request("https://threadsviewer.online/@zuck", { headers: { cookie: "x=1; lang=en" } }));
    expect(await hit?.text()).toBe("EN page");
  });
});
