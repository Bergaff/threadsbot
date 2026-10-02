import { describe, expect, it } from "vitest";
import { classifySource, parseDevice } from "../src/analytics";
import { handleStatsRoute, setStatsAccess, statsAccessInfo } from "../src/statsPage";
import { renderStatsAccessSection } from "../src/admin";
import { Database } from "../src/db";
import type { Env } from "../src/config";
import worker from "../src/index";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const ANDROID_TAB = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const today = new Date().toISOString().slice(0, 10);

/** Мок D1: bot_state в памяти + заранее заданные ответы на агрегатные запросы отчёта. */
function makeEnv(extra: Partial<Env> = {}) {
  const state = new Map<string, string>();
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/DELETE FROM bot_state/.test(sql)) state.delete(`${args[0]}|${args[1]}`);
          return {};
        },
        first: async () => {
          if (/FROM bot_state/.test(sql)) { const v = state.get(`${args[0]}|${args[1]}`); return v == null ? null : { value: v }; }
          return null;
        },
        all: async () => {
          if (/substr\(timestamp,1,10\)/.test(sql)) return { results: [
            { day: today, t: "web_pv", c: 300, u: 3 },
            { day: today, t: "web_uv", c: 300, u: 120 },
            { day: today, t: "web_js", c: 100, u: 90 },
            { day: today, t: "web_robot", c: 500, u: 40 },
          ] };
          if (/'web_geo'/.test(sql)) return { results: [{ k: "RU", c: 200 }, { k: "BY", c: 80 }, { k: "XX", c: 20 }] };
          if (/'web_dev'/.test(sql)) return { results: [{ k: "mobile|Android", c: 150 }, { k: "mobile|iOS", c: 60 }, { k: "desktop|Windows", c: 90 }] };
          if (/'web_ref'/.test(sql)) return { results: [{ k: "internal", c: 150 }, { k: "search:Google", c: 60 }, { k: "search:Яндекс", c: 40 }, { k: "direct", c: 30 }, { k: "social:Telegram", c: 20 }] };
          if (/'web_pv'.*GROUP BY event_data/.test(sql)) return { results: [{ k: "profile", c: 200 }, { k: "post", c: 70 }, { k: "home", c: 30 }] };
          if (/'web_dc'/.test(sql)) return { results: [{ c: 12 }] };
          if (/event_type='request'/.test(sql)) return { results: [{ c: 33 }] };
          if (/FROM user_settings/.test(sql)) return { results: [{ c: 1500 }] };
          if (/MIN\(timestamp\)/.test(sql)) return { results: [{ ts: new Date(Date.now() - 3 * 3600_000).toISOString() }] };
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) { for (const s of stmts) await s.run(); return []; },
  };
  const env = { DB, WEBHOOK_SECRET: "s", TELEGRAM_TOKEN: "t", SITE_DOMAIN: "threadsviewer.online", ...extra } as unknown as Env;
  return { env, state };
}

const form = (data: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.set(k, v);
  return f;
};

async function login(env: Env, l: string, p: string) {
  return handleStatsRoute(new Request("https://threadsviewer.online/stats/login", { method: "POST", body: form({ login: l, password: p }) }), env);
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").match(/stats_session=([0-9a-f]+)/)?.[1] || "";

describe("device and source classification", () => {
  it("detects device type and OS", () => {
    expect(parseDevice(IPHONE)).toEqual({ device: "mobile", os: "iOS" });
    expect(parseDevice(ANDROID)).toEqual({ device: "mobile", os: "Android" });
    expect(parseDevice(ANDROID_TAB)).toEqual({ device: "tablet", os: "Android" });
    expect(parseDevice(MAC)).toEqual({ device: "desktop", os: "macOS" });
  });

  it("classifies entry sources, including internal clicks hidden by no-referrer", () => {
    const req = (h: Record<string, string>) => new Request("https://threadsviewer.online/@zuck", { headers: h });
    expect(classifySource(req({ "sec-fetch-site": "same-origin" }))).toBe("internal");
    expect(classifySource(req({ referer: "https://threadsviewer.online/" }))).toBe("internal");
    expect(classifySource(req({ "sec-fetch-site": "none" }))).toBe("direct");
    expect(classifySource(req({}))).toBe("direct");
    expect(classifySource(req({ referer: "https://www.google.com/", "sec-fetch-site": "cross-site" }))).toBe("search:Google");
    expect(classifySource(req({ referer: "https://yandex.ru/search/?text=x" }))).toBe("search:Яндекс");
    expect(classifySource(req({ referer: "https://t.me/" }))).toBe("social:Telegram");
    expect(classifySource(req({ referer: "android-app://org.telegram.messenger/" }))).toBe("social:Telegram");
    expect(classifySource(req({ referer: "https://example.org/page" }))).toBe("referral:example.org");
    expect(classifySource(req({ "sec-fetch-site": "cross-site" }))).toBe("hidden");
  });
});

describe("/stats access", () => {
  it("shows 'not configured' when no credentials exist and never shows data without login", async () => {
    const { env } = makeEnv();
    const res = await handleStatsRoute(new Request("https://threadsviewer.online/stats?lang=ru"), env);
    const html = await res.text();
    expect(html).toContain("ещё не настроен");
    expect(html).not.toContain("Посетителей в день");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("stores only a salted hash and validates login/password", async () => {
    const { env, state } = makeEnv();
    expect((await setStatsAccess(env, "ab", "longpassword")).ok).toBe(false);
    expect((await setStatsAccess(env, "adx_manager", "short")).ok).toBe(false);
    expect((await setStatsAccess(env, "adx_manager", "S3cret-pass!")).ok).toBe(true);
    const raw = state.get("0|stats_access")!;
    expect(raw).not.toContain("S3cret-pass!");
    expect(JSON.parse(raw)).toMatchObject({ login: "adx_manager", iter: 100000 });
    expect(await statsAccessInfo(env)).toEqual({ login: "adx_manager", source: "admin" });

    expect((await login(env, "adx_manager", "wrong-password")).status).toBe(401);
    const ok = await login(env, "ADX_manager", "S3cret-pass!");
    expect(ok.status).toBe(302);
    const token = cookieOf(ok);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await handleStatsRoute(new Request("https://threadsviewer.online/stats?days=7&lang=ru", { headers: { cookie: `stats_session=${token}` } }), env);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Посетителей в день");
    // Никаких внутренних данных
    expect(html).not.toMatch(/sessionid|cookies|Скрапер|аккаунт/i);

    // Смена пароля завершает старые сессии
    await setStatsAccess(env, "adx_manager", "another-pass-1");
    const after = await handleStatsRoute(new Request("https://threadsviewer.online/stats", { headers: { cookie: `stats_session=${token}` } }), env);
    expect(await after.text()).toContain('name="password"');
  });

  it("locks out after 5 wrong attempts", async () => {
    const { env } = makeEnv();
    await setStatsAccess(env, "adx", "correct-horse");
    for (let i = 0; i < 5; i++) expect((await login(env, "adx", "nope-nope")).status).toBe(401);
    expect((await login(env, "adx", "correct-horse")).status).toBe(429);
  });

  it("supports STATS_LOGIN / STATS_PASSWORD fallback", async () => {
    const { env } = makeEnv({ STATS_LOGIN: "env_user", STATS_PASSWORD: "env-password" } as any);
    expect(await statsAccessInfo(env)).toEqual({ login: "env_user", source: "env" });
    expect((await login(env, "env_user", "env-password")).status).toBe(302);
  });

  it("logout revokes the session", async () => {
    const { env } = makeEnv();
    await setStatsAccess(env, "adx", "correct-horse");
    const token = cookieOf(await login(env, "adx", "correct-horse"));
    await handleStatsRoute(new Request("https://threadsviewer.online/stats/logout", { headers: { cookie: `stats_session=${token}` } }), env);
    const res = await handleStatsRoute(new Request("https://threadsviewer.online/stats", { headers: { cookie: `stats_session=${token}` } }), env);
    expect(await res.text()).toContain('name="password"');
  });
});

describe("advertiser report", () => {
  it("aggregates humans only, excludes internal navigation from sources", async () => {
    const { env } = makeEnv();
    const r = await new Database(env).advertiserReport(7);
    expect(r.days).toBe(7);
    expect(r.daily).toHaveLength(7);
    expect(r.daily[6]).toEqual({ day: today, pv: 300, uv: 120, js: 90, robots: 500 });
    expect(r.pageviews).toBe(300);
    expect(r.visitorDays).toBe(120);
    expect(r.activeDays).toBe(1);
    expect(r.avgDailyVisitors).toBe(120);
    expect(r.pagesPerVisitor).toBeCloseTo(2.5);
    expect(r.robotsFiltered).toBe(500);
    expect(r.geo[0]).toMatchObject({ key: "RU", count: 200 });
    expect(r.geo[0].percent).toBeCloseTo(66.67, 1);
    expect(r.devices.map((d) => d.key)).toEqual(["mobile", "desktop"]);
    expect(r.devices[0].count).toBe(210);
    expect(r.sources.map((s) => s.key)).toEqual(["search", "direct", "social"]);
    expect(r.sources.find((s) => s.key === "search")!.count).toBe(100);
    expect(r.topReferrers[0].key).toBe("search:Google");
    expect(r.tgTotalUsers).toBe(1500);
    expect(r.tgActiveUsers).toBe(33);
  });

  it("renders English version, CSV export and coverage note", async () => {
    const { env } = makeEnv();
    await setStatsAccess(env, "adx", "correct-horse");
    const token = cookieOf(await login(env, "adx", "correct-horse"));
    const headers = { cookie: `stats_session=${token}` };
    const en = await (await handleStatsRoute(new Request("https://threadsviewer.online/stats?lang=en&days=30", { headers }), env)).text();
    expect(en).toContain("Daily visitors (average)");
    expect(en).toContain("Russia");
    expect(en).toContain("covers 1 of 30 days");
    const csv = await handleStatsRoute(new Request("https://threadsviewer.online/stats/export.csv?days=7", { headers }), env);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const lines = (await csv.text()).trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[7]).toBe(`${today},120,300,90,500`);
  });
});

describe("admin section", () => {
  it("shows the link and status", () => {
    const env = { SITE_DOMAIN: "threadsviewer.online" } as Env;
    expect(renderStatsAccessSection(env, null, "")).toContain("Не настроена");
    const html = renderStatsAccessSection(env, { login: "adx", source: "admin" }, "saved");
    expect(html).toContain("https://threadsviewer.online/stats");
    expect(html).toContain("Отключить доступ");
    expect(html).toContain("сохранены");
  });
});

describe("routing", () => {
  it("/stats is served by the stats page, not treated as a Threads username", async () => {
    const { env } = makeEnv();
    const ctx: any = { waitUntil() {}, passThroughOnException() {} };
    const res = await worker.fetch(new Request("https://threadsviewer.online/stats?lang=ru"), env as any, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Вход в статистику");
  });
});
