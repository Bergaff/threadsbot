import type { Env } from "./config";

export interface CreatePaymentOptions {
  uid?: number;
  days: number;
  amount?: number;
  currency?: "RUB" | "USD";
  description?: string;
  shopId?: number;
}

export interface PaymentResult {
  ok: boolean;
  formUrl?: string;
  orderId?: number | string;
  error?: string;
  raw?: any;
  attempts?: Array<{ url: string; status: number; text: string }>;
}

/**
 * Создание счёта на оплату в платёжной системе RuKassa (lk.rukassa.io)
 * Документация: https://lk.rukassa.io/api/v1
 */
export async function createJhpayPayment(
  env: Env,
  options: CreatePaymentOptions
): Promise<PaymentResult> {
  const token = (env as any).RUKASSA_TOKEN || (env as any).JHPAY_TOKEN || "940e2c5aec5bf97eab483ac86c07c0db";
  const days = options.days || 7;
  const currency = options.currency || "RUB";
  // Цены: 7 дн - 99 ₽ ($0.99), 30 дн - 129 ₽ ($1.49), 90 дн - 299 ₽ ($3.49), 365 дн - 890 ₽ ($9.99)
  let defaultAmount = 99;
  if (currency === "USD") {
    if (days >= 365) defaultAmount = 9.99;
    else if (days >= 90) defaultAmount = 3.49;
    else if (days >= 30) defaultAmount = 1.49;
    else defaultAmount = 0.99;
  } else {
    if (days >= 365) defaultAmount = 890;
    else if (days >= 90) defaultAmount = 299;
    else if (days >= 30) defaultAmount = 129;
    else defaultAmount = 99;
  }
  const amount = options.amount || defaultAmount;
  const uid = options.uid || 0;
  const shopId = options.shopId || 4063;

  // RuKassa требует целочисленный уникальный order_id
  const orderId = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 999);

  const customData = JSON.stringify({
    uid,
    days,
    created: Date.now(),
  });

  const bodyData = new URLSearchParams({
    shop_id: String(shopId),
    token,
    order_id: String(orderId),
    amount: String(amount),
    data: customData,
    currency,
    user_code: uid > 0 ? String(uid) : "guest",
  });

  const candidateUrls = [
    "https://lk.rukassa.io/api/v1/create",
    "https://api.rukassa.io/api/v1/create",
  ];

  const attempts: Array<{ url: string; status: number; text: string }> = [];

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ThreadsViewer/1.0",
        },
        body: bodyData.toString(),
      });

      const text = await res.text().catch(() => "");
      attempts.push({ url, status: res.status, text: text.slice(0, 160) });

      if (res.ok) {
        try {
          const data = JSON.parse(text);
          const payUrl = data.url || data.formUrl || data.paymentUrl;
          if (payUrl) {
            return {
              ok: true,
              formUrl: payUrl,
              orderId: data.id || orderId,
              raw: data,
              attempts,
            };
          }
          if (data.message || data.error) {
            return {
              ok: false,
              error: data.message || data.error,
              raw: data,
              attempts,
            };
          }
        } catch {
          // Ответ не JSON, продолжаем
        }
      }
    } catch (err: any) {
      attempts.push({ url, status: 0, text: String(err?.message || err) });
    }
  }

  // Запасная попытка через GET-запрос (RuKassa поддерживает и GET)
  try {
    const getUrl = `https://lk.rukassa.io/api/v1/create?${bodyData.toString()}`;
    const res = await fetch(getUrl, {
      method: "GET",
      headers: { "User-Agent": "ThreadsViewer/1.0" },
    });
    const text = await res.text().catch(() => "");
    attempts.push({ url: "https://lk.rukassa.io/api/v1/create?GET", status: res.status, text: text.slice(0, 160) });

    if (res.ok) {
      const data = JSON.parse(text);
      const payUrl = data.url || data.formUrl;
      if (payUrl) {
        return {
          ok: true,
          formUrl: payUrl,
          orderId: data.id || orderId,
          raw: data,
          attempts,
        };
      }
      if (data.message || data.error) {
        return {
          ok: false,
          error: data.message || data.error,
          raw: data,
          attempts,
        };
      }
    }
  } catch (err: any) {
    attempts.push({ url: "https://lk.rukassa.io/api/v1/create?GET", status: 0, text: String(err?.message || err) });
  }

  const summary = attempts.map(a => `[${a.url.replace("https://", "")}: HTTP ${a.status}]`).join(", ");
  return {
    ok: false,
    error: `Шлюз RuKassa недоступен (${summary})`,
    attempts,
  };
}
