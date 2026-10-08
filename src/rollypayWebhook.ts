/**
 * Вебхук кассы RollyPay: POST /api/payment/rollypay
 *
 * - Подпись X-Signature проверяется ДО любой обработки (иначе колбэк можно подделать).
 * - Идемпотентно: повтор того же статуса (ретраи RollyPay) ничего не делает повторно.
 * - Опора на ПОСЛЕДНЕЕ событие по payment_id (поздняя оплата после expired, возвраты, чарджбеки).
 * - Пожертвование: запись + уведомление админам. Подписка (sub-...): выдаётся один раз при paid.
 * - Тестовые (sandbox) платежи выдают подписку только при ROLLYPAY_TEST=1.
 */
import { adminIds, type Env } from "./config";
import { Database } from "./db";
import { Telegram } from "./telegram";
import { planByDays } from "./plans";
import { isPlanAmountOk, parseOrderId, rollyStatusLabel, rollypayTestMode, verifyRollySignature, type RollyEvent, type RollyRecord } from "./rollypay";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" } });

async function notifyAdmins(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_TOKEN);
  await Promise.all(adminIds(env).map((id) => tg.sendMessage(id, text).catch(() => {})));
}

export async function handleRollyWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const secret = String(env.ROLLYPAY_SIGNING_SECRET || "").trim();
  if (!secret) {
    // 503 - RollyPay повторит доставку, когда секрет будет настроен
    console.error("[RollyPay] ROLLYPAY_SIGNING_SECRET не задан - вебхук не обработан");
    return json({ ok: false, error: "not configured" }, 503);
  }
  const raw = await request.text();
  const ok = await verifyRollySignature(secret, request.headers.get("x-timestamp") || "", raw, request.headers.get("x-signature") || "");
  if (!ok) {
    console.warn(`[RollyPay] Неверная подпись вебхука (ip=${request.headers.get("cf-connecting-ip") || ""})`);
    return json({ ok: false, error: "invalid signature" }, 403);
  }
  let ev: RollyEvent;
  try {
    ev = JSON.parse(raw) as RollyEvent;
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const paymentId = String(ev.payment_id || "");
  const status = String(ev.status || "").toLowerCase();
  // События выводов (payout.completed) и прочие без платежа просто подтверждаем
  if (!paymentId || !status) return json({ ok: true, ignored: true });

  const db = new Database(env);
  const orderId = String(ev.order_id || "");
  const parsed = parseOrderId(orderId);
  const amount = Number(ev.amount || 0);
  const currency = String(ev.currency || "RUB").toUpperCase();
  const test = ev.test === true || request.headers.get("x-test-mode") === "true";
  const scope = `rp:${paymentId}`;
  const prev = await db.state(scope, "rollypay_payment").then((v) => (v ? (JSON.parse(v) as RollyRecord) : null)).catch(() => null);
  const nowIso = new Date().toISOString();

  if (prev && prev.status === status) return json({ ok: true, duplicate: true });

  const rec: RollyRecord = {
    payment_id: paymentId,
    order_id: orderId,
    status,
    amount,
    currency,
    test,
    kind: parsed?.kind || "other",
    granted: prev?.granted || false,
    first_at: prev?.first_at || nowIso,
    updated_at: nowIso,
  };

  const uid = parsed?.kind === "sub" ? parsed.uid : 0;
  const testTag = test ? " [ТЕСТ]" : "";
  const what = parsed?.kind === "sub" ? `подписка ${parsed.days} дн. для ${parsed.uid}` : parsed?.kind === "don" ? "пожертвование с сайта" : `заказ ${orderId}`;

  // Выдача подписки (только для заказов sub-..., один раз на платёж)
  if (status === "paid" && parsed?.kind === "sub" && !rec.granted && (!test || rollypayTestMode(env))) {
    const plan = planByDays(parsed.days);
    if (plan && currency === "RUB" && isPlanAmountOk(parsed.days, amount)) {
      await db.activate(parsed.uid, "rollypay", amount, plan.days);
      rec.granted = true;
      if (env.TELEGRAM_TOKEN) {
        await new Telegram(env.TELEGRAM_TOKEN)
          .sendMessage(parsed.uid, `🎉 <b>Оплата получена!</b>\n\nПодписка активирована на ${plan.days} дн.`)
          .catch(() => {});
      }
    } else {
      console.warn(`[RollyPay] Подписка не выдана: сумма ${amount} ${currency} меньше тарифа ${parsed.days} дн.`);
    }
  }

  await db.setState(scope, "rollypay_payment", JSON.stringify(rec));
  await db.logEvent(uid, "rollypay", JSON.stringify({ p: paymentId, o: orderId, s: status, a: amount, c: currency, t: test ? 1 : 0, k: rec.kind })).catch(() => {});
  if (status === "paid" && rec.kind === "don" && !test) await db.logEvent(0, "donation", `card:${amount}`).catch(() => {});

  if (["paid", "refunded", "chargeback"].includes(status)) {
    await notifyAdmins(
      env,
      `💳 <b>RollyPay${testTag}</b>: ${rollyStatusLabel(status)}\n${what}\nСумма: <b>${amount} ${currency}</b>\nЗаказ: <code>${orderId}</code>${rec.granted && status !== "paid" ? "\n⚠️ Подписка по этому платежу уже была выдана - проверьте вручную." : ""}`,
    );
  }
  console.log(`[RollyPay] ${paymentId} ${prev?.status || "-"} -> ${status} ${amount} ${currency} order=${orderId}${testTag}`);
  return json({ ok: true });
}
