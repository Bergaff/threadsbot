import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/config";
import { createRollyPayment, parseOrderId, rollySignature, verifyRollySignature } from "../src/rollypay";
import { renderRollySection } from "../src/admin";

const SECRET = "test_signing_secret_123456";

/** Мок D1: bot_state, подписки и user_events в памяти. */
function makeEnv(extra: Record<string, unknown> = {}) {
  const state = new Map<string, string>();
  const activations: Array<{ uid: number; method: string; amount: number }> = [];
  const events: Array<{ uid: number; type: string; data: string }> = [];
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt: any = {
        bind: (...a: any[]) => { args = a; return stmt; },
        run: async () => {
          if (/INSERT INTO bot_state/.test(sql)) state.set(`${args[0]}|${args[1]}`, String(args[2]));
          if (/INSERT INTO subscriptions/.test(sql)) activations.push({ uid: Number(args[0]), method: String(args[2]), amount: Number(args[3]) });
          if (/INSERT INTO user_events/.test(sql) && args.length >= 3) events.push({ uid: Number(args[0]), type: String(args[1]), data: String(args[2]) });
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
  const env = {
    DB, WEBHOOK_SECRET: "test-secret", TELEGRAM_TOKEN: "t", BOT_USERNAME: "threadsreaderbot", BROWSER: undefined,
    ADMIN_IDS: "111", SITE_URL: "https://threadsviewer.online",
    ...extra,
  } as unknown as Env;
  return { env, state, activations, events };
}
const ctx: any = { waitUntil() {}, passThroughOnException() {} };

/** Перехват исходящих запросов: RollyPay API и Telegram. */
function stubFetch(rolly: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const tg: Array<{ method: string; body: any }> = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.telegram.org")) {
      tg.push({ method: url.split("/").pop() || "", body: init.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    calls.push({ url, init });
    return rolly(url, init);
  }));
  return { tg, calls };
}

async function signedWebhook(body: object, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  return new Request("https://threadsviewer.online/api/payment/rollypay", {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": await rollySignature(secret, ts, raw) },
    body: raw,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("RollyPay: подпись и заказы", () => {
  it("подпись = hex HMAC-SHA256(secret, timestamp.body) и сверяется с учётом времени", async () => {
    const ts = "1760000000";
    const sig = await rollySignature(SECRET, ts, '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const now = 1760000000 * 1000 + 5_000;
    expect(await verifyRollySignature(SECRET, ts, '{"a":1}', sig, now)).toBe(true);
    expect(await verifyRollySignature(SECRET, ts, '{"a":1}', "sha256=" + sig.toUpperCase(), now)).toBe(true);
    expect(await verifyRollySignature(SECRET, ts, '{"a":2}', sig, now)).toBe(false);
    expect(await verifyRollySignature("other", ts, '{"a":1}', sig, now)).toBe(false);
    expect(await verifyRollySignature(SECRET, ts, '{"a":1}', sig, now + 3 * 86_400_000)).toBe(false);
  });

  it("разбирает свои order_id", () => {
    expect(parseOrderId("don-300-abc-x1")).toEqual({ kind: "don", rub: 300 });
    expect(parseOrderId("sub-42-30-abc-x1")).toEqual({ kind: "sub", uid: 42, days: 30 });
    expect(parseOrderId("order-1")).toBeNull();
  });

  it("создаёт платёж: ключ и nonce в заголовках, сумма строкой, редиректы", async () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "rpk_live_x", ROLLYPAY_TERMINAL_ID: "term-1" });
    const { calls } = stubFetch(() => Response.json({ payment_id: "pay_1", status: "created", pay_url: "https://pay.rollypay.io/pay/tok_1" }));
    const r = await createRollyPayment(env, { amount: 100, orderId: "don-100-a-b", successUrl: "https://s/ok", failUrl: "https://s/fail" });
    expect(r).toMatchObject({ ok: true, payUrl: "https://pay.rollypay.io/pay/tok_1", paymentId: "pay_1" });
    expect(calls[0].url).toBe("https://api.rollypay.io/api/v1/payments");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["X-API-Key"]).toBe("rpk_live_x");
    expect(h["X-Nonce"]).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ amount: "100.00", payment_currency: "RUB", order_id: "don-100-a-b", terminal_id: "term-1", success_redirect_url: "https://s/ok", fail_redirect_url: "https://s/fail" });
    expect(body.test).toBeUndefined();
  });

  it("если api.rollypay.io не отвечает - пробует rollypay.io; ошибку API по существу не маскирует", async () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "k", ROLLYPAY_TEST: "1" });
    const { calls } = stubFetch((url) => {
      if (url.startsWith("https://api.rollypay.io")) throw new Error("dns fail");
      return Response.json({ payment_id: "pay_2", pay_url: "https://pay.rollypay.io/pay/tok_2" });
    });
    const r = await createRollyPayment(env, { amount: 50, orderId: "don-50-a-b" });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://api.rollypay.io/api/v1/payments", "https://rollypay.io/api/v1/payments"]);
    expect(JSON.parse(String(calls[1].init.body)).test).toBe(true);

    const { calls: c2 } = stubFetch(() => Response.json({ error: "Сумма слишком мала" }, { status: 400 }));
    const bad = await createRollyPayment(env, { amount: 1, orderId: "don-1-a-b" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Сумма слишком мала");
    expect(c2).toHaveLength(1);
  });
});

describe("RollyPay: пожертвование на сайте", () => {
  it("без ключа кассы - прежняя заглушка", async () => {
    const { env } = makeEnv();
    const html = await (await worker.fetch(new Request("https://threadsviewer.online/donate/confirm?amount=50&method=card&lang=ru"), env as any, ctx)).text();
    expect(html).toContain("Оплата картой и СБП подключается");
  });

  it("форма шлёт POST, карта ведёт на pay_url кассы с нашими адресами возврата", async () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "k" });
    const page = await (await worker.fetch(new Request("https://threadsviewer.online/donate?amount=300&lang=ru"), env as any, ctx)).text();
    expect(page).toContain('method="POST" action="/donate/confirm"');
    expect(page).toContain("RollyPay");

    const { calls } = stubFetch(() => Response.json({ payment_id: "pay_9", pay_url: "https://pay.rollypay.io/pay/tok_9" }));
    const res = await worker.fetch(new Request("https://threadsviewer.online/donate/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "lang=ru&amount=300&method=card",
    }), env as any, ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://pay.rollypay.io/pay/tok_9");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.amount).toBe("300.00");
    expect(body.order_id).toMatch(/^don-300-/);
    expect(body.success_redirect_url).toBe("https://threadsviewer.online/donate/thanks?amount=300&lang=ru");
    expect(body.fail_redirect_url).toBe("https://threadsviewer.online/donate/fail?amount=300&lang=ru");
  });

  it("GET-переход по ссылке платёж НЕ создаёт; Stars через POST по-прежнему ведут в бота", async () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "k" });
    const { calls } = stubFetch(() => Response.json({}));
    const get = await worker.fetch(new Request("https://threadsviewer.online/donate/confirm?amount=100&method=card&lang=ru"), env as any, ctx);
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/donate?amount=100&lang=ru");
    const stars = await worker.fetch(new Request("https://threadsviewer.online/donate/confirm", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "amount=500&method=stars",
    }), env as any, ctx);
    expect(stars.headers.get("location")).toBe("https://t.me/threadsreaderbot?start=donate_500_stars");
    expect(calls).toHaveLength(0);
  });

  it("ошибка кассы - понятная страница с альтернативами, а не белый экран", async () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "k" });
    stubFetch(() => Response.json({ error: "payment cap exceeded" }, { status: 400 }));
    const res = await worker.fetch(new Request("https://threadsviewer.online/donate/confirm", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "lang=ru&amount=100&method=card",
    }), env as any, ctx);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Оплата картой временно недоступна");
    expect(html).toContain("start=donate_100_stars");
  });

  it("страницы возврата: спасибо и не прошло", async () => {
    const { env } = makeEnv();
    const ok = await (await worker.fetch(new Request("https://threadsviewer.online/donate/thanks?amount=300&lang=ru"), env as any, ctx)).text();
    expect(ok).toContain("Спасибо за поддержку");
    expect(ok).toContain("300 ₽");
    const fail = await (await worker.fetch(new Request("https://threadsviewer.online/donate/fail?amount=300&lang=en"), env as any, ctx)).text();
    expect(fail).toContain("The payment did not go through");
  });
});

describe("RollyPay: вебхук", () => {
  it("без секрета - 503 (RollyPay повторит), с чужой подписью - 403", async () => {
    const { env, events } = makeEnv();
    expect((await worker.fetch(await signedWebhook({ payment_id: "p", status: "paid" }), env as any, ctx)).status).toBe(503);
    const { env: env2 } = makeEnv({ ROLLYPAY_SIGNING_SECRET: SECRET });
    expect((await worker.fetch(await signedWebhook({ payment_id: "p", status: "paid" }, "forged_secret_000000"), env2 as any, ctx)).status).toBe(403);
    expect(events.filter((e) => e.type === "rollypay")).toHaveLength(0);
  });

  it("оплаченное пожертвование: запись, уведомление админу, повтор игнорируется", async () => {
    const { env, events, activations } = makeEnv({ ROLLYPAY_SIGNING_SECRET: SECRET });
    const { tg } = stubFetch(() => Response.json({}));
    const ev = { event_type: "payment.paid", payment_id: "pay_d1", order_id: "don-300-x-y", status: "paid", amount: "300.00", currency: "RUB", test: false };
    const r1 = await worker.fetch(await signedWebhook(ev), env as any, ctx);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    const r2 = await worker.fetch(await signedWebhook(ev), env as any, ctx);
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect(events.filter((e) => e.type === "rollypay")).toHaveLength(1);
    expect(events.filter((e) => e.type === "donation").map((e) => e.data)).toEqual(["card:300"]);
    expect(activations).toHaveLength(0);
    const admin = tg.filter((m) => m.method === "sendMessage");
    expect(admin).toHaveLength(1);
    expect(admin[0].body.chat_id).toBe(111);
    expect(admin[0].body.text).toContain("пожертвование с сайта");
  });

  it("подписка по заказу sub-...: выдаётся один раз и только при полной сумме; тест - только в sandbox-режиме", async () => {
    const { env, activations } = makeEnv({ ROLLYPAY_SIGNING_SECRET: SECRET });
    stubFetch(() => Response.json({}));
    // недоплата
    await worker.fetch(await signedWebhook({ payment_id: "pay_s0", order_id: "sub-42-30-a-b", status: "paid", amount: "10.00", currency: "RUB" }), env as any, ctx);
    // тестовый платёж в боевом режиме
    await worker.fetch(await signedWebhook({ payment_id: "pay_s1", order_id: "sub-42-30-a-c", status: "paid", amount: "129.00", currency: "RUB", test: true }), env as any, ctx);
    expect(activations).toHaveLength(0);
    // поздняя оплата после expired + повтор доставки
    const base = { payment_id: "pay_s2", order_id: "sub-42-30-a-d", amount: "129.00", currency: "RUB" };
    await worker.fetch(await signedWebhook({ ...base, status: "expired" }), env as any, ctx);
    await worker.fetch(await signedWebhook({ ...base, status: "paid" }), env as any, ctx);
    await worker.fetch(await signedWebhook({ ...base, status: "paid" }), env as any, ctx);
    expect(activations).toEqual([{ uid: 42, method: "rollypay", amount: 129 }]);
    // возврат после выдачи: подписка повторно не выдаётся
    await worker.fetch(await signedWebhook({ ...base, status: "refunded" }), env as any, ctx);
    await worker.fetch(await signedWebhook({ ...base, status: "paid" }), env as any, ctx);
    expect(activations).toHaveLength(1);
  });

  it("блок в админке показывает настройку и платежи", () => {
    const { env } = makeEnv({ ROLLYPAY_API_KEY: "k" });
    const html = renderRollySection(env, [{ ts: "2026-10-08T10:00:00Z", data: JSON.stringify({ p: "pay_1", o: "don-100-a-b", s: "paid", a: 100, c: "RUB", t: 0, k: "don" }) }]);
    expect(html).toContain("API-ключ: <span style=\"color:#4ade80;\">✅ задан");
    expect(html).toContain("вебхуки отклоняются");
    expect(html).toContain("https://threadsviewer.online/api/payment/rollypay");
    expect(html).toContain("пожертвование");
    expect(html).toContain("100.00 ₽");
  });
});
