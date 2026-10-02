import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANS, DONATIONS, parseBuyPayload, parseDonatePayload, planByDays, rubPerMonth, savingsPercent, botBuyLink, botDonateLink, donationByRub } from "../src/plans";
import { renderHomePage, renderProfilePage } from "../src/web";
import { Bot, starsPlanFor } from "../src/bot";
import worker from "../src/index";
import type { Env } from "../src/config";

/** Мок D1: bot_state в памяти + журнал activate() (INSERT INTO subscriptions). */
function makeEnv(extra: Record<string, unknown> = {}) {
  const state = new Map<string, string>();
  const activations: Array<{ uid: number; method: string; amount: number }> = [];
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/INSERT INTO subscriptions/.test(sql)) activations.push({ uid: Number(args[0]), method: String(args[2]), amount: Number(args[3]) });
          return { meta: {} };
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
  const env = { DB, WEBHOOK_SECRET: "test-secret", TELEGRAM_TOKEN: "t", BOT_USERNAME: "threadsreaderbot", BROWSER: undefined, ...extra } as unknown as Env;
  return { env, state, activations };
}
const ctx: any = { waitUntil() {}, passThroughOnException() {} };

afterEach(() => vi.unstubAllGlobals());

describe("plans", () => {
  it("has the agreed price grid: 3 days 39, month 129, quarter 299, year 890", () => {
    expect(PLANS.map((p) => [p.id, p.days, p.rub])).toEqual([
      ["trial", 3, 39], ["month", 30, 129], ["quarter", 90, 299], ["year", 365, 890],
    ]);
    // Длинные тарифы реально выгоднее помесячной оплаты, а Stars растут вместе с рублями
    expect(savingsPercent(planByDays(90)!)).toBe(23);
    expect(savingsPercent(planByDays(365)!)).toBe(43);
    expect(rubPerMonth(planByDays(365)!)).toBe(73);
    for (let i = 1; i < PLANS.length; i++) {
      expect(PLANS[i].stars).toBeGreaterThan(PLANS[i - 1].stars);
      expect(PLANS[i].usd).toBeGreaterThan(PLANS[i - 1].usd);
    }
  });

  it("parses bot deep links", () => {
    expect(parseBuyPayload("buy_year_crypto")).toMatchObject({ plan: { id: "year" }, method: "crypto" });
    expect(parseBuyPayload("buy_trial")).toMatchObject({ plan: { id: "trial" }, method: "stars" });
    expect(parseBuyPayload("buy_forever_stars")).toBeNull();
    expect(parseBuyPayload("track_zuck")).toBeNull();
    expect(botBuyLink("bot", planByDays(90)!, "stars")).toBe("https://t.me/bot?start=buy_quarter_stars");
  });

  it("parses donation deep links only for fixed amounts", () => {
    expect(parseDonatePayload("donate_100_crypto")).toMatchObject({ donation: { rub: 100, usd: 1 }, method: "crypto" });
    expect(parseDonatePayload("donate_300")).toMatchObject({ donation: { rub: 300 }, method: "stars" });
    expect(parseDonatePayload("donate_1_stars")).toBeNull();
    expect(botDonateLink("bot", donationByRub(50)!, "stars")).toBe("https://t.me/bot?start=donate_50_stars");
  });

  it("maps paid Stars invoices to the right term, including legacy 7-day invoices", () => {
    expect(starsPlanFor("sub_1_90", 175)).toEqual({ days: 90 });
    expect(starsPlanFor("sub_1_3", 25)).toEqual({ days: 3 });
    expect(starsPlanFor("sub_1_7", 49)).toEqual({ days: 7 });
    expect(starsPlanFor("sub_1_30", 149)).toEqual({ days: 30 });
    expect(starsPlanFor("weird", 80)).toEqual({ days: 30 });
    expect(starsPlanFor("sub_1_365", 10)).toBeUndefined();
  });
});

describe("site: no prices, ad placeholder, voluntary donations", () => {
  it("home has no prices; ad space is a placeholder with email and bot contacts", async () => {
    const html = await renderHomePage({ BOT_USERNAME: "threadsreaderbot" } as Env, "ru").text();
    expect(html).not.toContain('id="pricing"');
    expect(html).not.toMatch(/\b129 ₽|\b890 ₽|Тарифы Premium/);
    expect(html).toContain("Здесь может быть ваша реклама");
    expect(html).toContain("mailto:silviojurk70@gmail.com");
    expect(html).toContain("https://t.me/threadsreaderbot?start=ads");
    expect(html).not.toMatch(/VPN и приватный доступ|Отключить рекламу/);
    expect(html).toContain('href="/donate?lang=ru"');
    // FAQ честно говорит, что сайт бесплатный
    expect(html).toContain("Сайт полностью бесплатный");
  });

  it("profile/post pages show the placeholder and no premium promo", async () => {
    const html = await renderProfilePage({} as Env, "zuck", null, null, "en").text();
    expect(html).toContain("Your ad could be here");
    expect(html).not.toContain("premium-promo");
    expect(html).not.toContain("from $0.49");
  });

  it("donation page: amounts, methods, clear 'unlocks nothing' note", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request("https://threadsviewer.online/donate?amount=300&lang=ru"), env as any, ctx);
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const d of DONATIONS) expect(html).toContain(`/donate?amount=${d.rub}&amp;lang=ru`);
    expect(html).toContain("Поддержать · 300 ₽");
    expect(html).toContain("175 ⭐");
    expect(html).toContain("ничего не открывает");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    // произвольная сумма не принимается - подставляется сумма по умолчанию
    expect(await (await worker.fetch(new Request("https://threadsviewer.online/donate?amount=99999&lang=ru"), env as any, ctx)).text()).toContain("Поддержать · 100 ₽");
  });

  it("old pricing URLs redirect to /donate", async () => {
    const { env } = makeEnv();
    for (const path of ["/pricing?lang=en", "/pay?plan=year", "/buy", "/order", "/pay/confirm?method=stars"]) {
      const res = await worker.fetch(new Request("https://threadsviewer.online" + path), env as any, ctx);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toMatch(/^\/donate/);
    }
  });

  it("/donate/confirm: Stars/USDT go to the bot, card shows the stub", async () => {
    const { env } = makeEnv();
    const stars = await worker.fetch(new Request("https://threadsviewer.online/donate/confirm?amount=500&method=stars"), env as any, ctx);
    expect(stars.status).toBe(302);
    expect(stars.headers.get("location")).toBe("https://t.me/threadsreaderbot?start=donate_500_stars");
    const card = await (await worker.fetch(new Request("https://threadsviewer.online/donate/confirm?amount=50&method=card&lang=ru"), env as any, ctx)).text();
    expect(card).toContain("Оплата картой и СБП подключается");
    expect(card).toContain("start=donate_50_stars");
    expect(card).toContain("start=donate_50_crypto");
  });
});

describe("payment webhook /result.php", () => {
  const callback = (query = "", body: Record<string, unknown> = {}) =>
    new Request(`https://threadsviewer.online/result.php${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: 555, amount: 129, data: JSON.stringify({ uid: 42, days: 30 }), status: "PAID", ...body }),
    });

  it("never activates without the secret (forged callbacks are ignored)", async () => {
    const { env, activations } = makeEnv();
    expect((await worker.fetch(callback(), env as any, ctx)).status).toBe(200);
    const withSecretEnv = makeEnv({ PAYMENT_WEBHOOK_SECRET: "s".repeat(32) });
    await worker.fetch(callback("?key=wrong"), withSecretEnv.env as any, ctx);
    expect(activations).toHaveLength(0);
    expect(withSecretEnv.activations).toHaveLength(0);
  });

  it("activates once with a valid secret and rejects underpaid orders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: {} })));
    const secret = "k".repeat(32);
    const { env, activations } = makeEnv({ PAYMENT_WEBHOOK_SECRET: secret });
    await worker.fetch(callback(`?key=${secret}`), env as any, ctx);
    await worker.fetch(callback(`?key=${secret}`), env as any, ctx); // повтор того же заказа
    expect(activations).toEqual([{ uid: 42, method: "kassa", amount: 129 }]);
    await worker.fetch(callback(`?key=${secret}`, { order_id: 556, amount: 1, data: JSON.stringify({ uid: 42, days: 365 }) }), env as any, ctx);
    expect(activations).toHaveLength(1);
  });
});

describe("bot payments", () => {
  function tgMock(invoice?: Record<string, unknown>) {
    const calls: Array<{ method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("pay.crypt.bot/api/getInvoices")) return Response.json({ ok: true, result: { items: invoice ? [invoice] : [] } });
      if (u.includes("pay.crypt.bot/api/createInvoice")) {
        calls.push({ method: "createInvoice", body: JSON.parse(String(init?.body || "{}")) });
        return Response.json({ ok: true, result: { pay_url: "https://t.me/CryptoBot?start=x", invoice_id: 777 } });
      }
      const method = u.split("/").pop() || "";
      calls.push({ method, body: JSON.parse(String(init?.body || "{}")) });
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, username: "threadsreaderbot", is_bot: true, first_name: "b" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }));
    return calls;
  }
  const from = { id: 42, is_bot: false, first_name: "U", language_code: "ru" };

  it("deep link buy_quarter_stars sends a 175-star invoice for 90 days", async () => {
    const calls = tgMock();
    const { env } = makeEnv();
    await new Bot(env).update({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, from, text: "/start buy_quarter_stars" } } as any);
    const inv = calls.find((c) => c.method === "sendInvoice")!;
    expect(inv.body.payload).toBe("sub_42_90");
    expect(inv.body.prices[0].amount).toBe(175);
  });

  it("deep link buy_year_crypto creates a 9.99 USDT invoice", async () => {
    const calls = tgMock();
    const { env } = makeEnv();
    await new Bot(env).update({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, from, text: "/start buy_year_crypto" } } as any);
    const inv = calls.find((c) => c.method === "createInvoice")!;
    expect(inv.body.amount).toBe("9.99");
    expect(inv.body.payload).toBe("42:365");
  });

  it("a paid crypto invoice activates only once and only for its owner", async () => {
    tgMock({ status: "paid", payload: "42:90", amount: "3.49" });
    const { env, activations } = makeEnv();
    const press = (userId: number) => new Bot(env).update({
      update_id: 1,
      callback_query: { id: "cb", from: { ...from, id: userId }, data: "sub:check:777:365", message: { message_id: 5, chat: { id: userId } } },
    } as any);
    await press(42);
    await press(42); // повторное «Я оплатил»
    await press(43); // чужой счёт
    expect(activations).toHaveLength(1);
    expect(activations[0]).toMatchObject({ uid: 42, method: "crypto", amount: 3.49 });
  });

  it("a Stars donation thanks the user and does NOT activate a subscription", async () => {
    const calls = tgMock();
    const { env, activations } = makeEnv();
    const bot = new Bot(env);
    await bot.update({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, from, text: "/start donate_300_stars" } } as any);
    const inv = calls.find((c) => c.method === "sendInvoice")!;
    expect(inv.body.payload).toBe("don_42_300");
    expect(inv.body.prices[0].amount).toBe(175);
    await bot.update({ update_id: 2, message: { message_id: 2, chat: { id: 42 }, from, successful_payment: { total_amount: 175, invoice_payload: "don_42_300" } } } as any);
    expect(activations).toHaveLength(0);
    expect(calls.some((c) => c.method === "sendMessage" && String(c.body.text).includes("Спасибо, что поддержали проект"))).toBe(true);
  });

  it("a crypto donation is thanked once and never activates a subscription", async () => {
    const calls = tgMock({ status: "paid", payload: "don:42:100", amount: "1" });
    const { env, activations } = makeEnv();
    const press = () => new Bot(env).update({
      update_id: 1,
      callback_query: { id: "cb", from, data: "don:check:900", message: { message_id: 5, chat: { id: 42 } } },
    } as any);
    await press();
    await press();
    expect(activations).toHaveLength(0);
    expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(1);
  });

  it("a donation invoice cannot be redeemed as a subscription via sub:check", async () => {
    tgMock({ status: "paid", payload: "don:42:100", amount: "1" });
    const { env, activations } = makeEnv();
    await new Bot(env).update({
      update_id: 1,
      callback_query: { id: "cb", from, data: "sub:check:900", message: { message_id: 5, chat: { id: 42 } } },
    } as any);
    expect(activations).toHaveLength(0);
  });

  it("deep link start=ads asks for an advertising request", async () => {
    const calls = tgMock();
    const { env, state } = makeEnv();
    await new Bot(env).update({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, from, text: "/start ads" } } as any);
    expect(state.get("42|waiting_support")).toBe("ads");
    expect(calls.some((c) => String(c.body.text || "").includes("Реклама на threadsviewer.online"))).toBe(true);
  });
});
