import type { Env } from "./config";

export interface CreatePaymentOptions {
  uid?: number;
  days: number;
  amount?: number;
  description?: string;
  shopId?: number;
}

export interface PaymentResult {
  ok: boolean;
  formUrl?: string;
  orderId?: number;
  error?: string;
  attempts?: Array<{ url: string; status: number; text: string }>;
}

export async function createJhpayPayment(
  env: Env,
  options: CreatePaymentOptions
): Promise<PaymentResult> {
  const token = (env as any).JHPAY_TOKEN || "940e2c5aec5bf97eab483ac86c07c0db";
  const days = options.days || 7;
  const amount = options.amount || (days === 30 ? 99 : 39);
  const uid = options.uid || 0;
  const orderNumber = uid > 0 ? `${uid}_${days}_${Date.now()}` : `web_${days}_${Date.now()}`;
  const description = options.description || `Threads Viewer Премиум ${days} дн.`;
  const shopId = options.shopId || 4063;

  // Кандидаты URL для API шлюза JHPay
  // Проверяем как основной домен jhpay.online, так и поддомены
  const candidateUrls = [
    "https://jhpay.online/api/pay/order/create",
    "https://jhpay.online/api/order/create",
    "https://pay.jhpay.online/api/pay/order/create",
    "https://api.jhpay.online/api/pay/order/create",
  ];

  const payload = {
    orderNumber,
    shopId,
    merchantId: shopId,
    amount,
    description,
    currency: 643,
    email: "customer@threadsviewer.online",
    phone: "79000000000",
  };

  const attempts: Array<{ url: string; status: number; text: string }> = [];

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-TOKEN": token,
          "Authorization": `Bearer ${token}`,
          "User-Agent": "ThreadsViewer/1.0",
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text().catch(() => "");
      attempts.push({ url, status: res.status, text: text.slice(0, 160) });

      if (res.ok) {
        try {
          const data = JSON.parse(text);
          if (data && (data.formUrl || data.url || data.payUrl || data.paymentUrl)) {
            return {
              ok: true,
              formUrl: data.formUrl || data.url || data.payUrl || data.paymentUrl,
              orderId: data.orderId || data.id,
              attempts,
            };
          }
          if (data && data.message) {
            return { ok: false, error: data.message, attempts };
          }
        } catch {
          // Ответ не JSON, пробуем следующий
        }
      }
    } catch (err: any) {
      attempts.push({ url, status: 0, text: String(err?.message || err) });
    }
  }

  // Если ни один кандидат не отдал ссылку на оплату
  const summary = attempts
    .map(a => `[${a.url.replace("https://", "")}: HTTP ${a.status}]`)
    .join(", ");

  return {
    ok: false,
    error: `Все шлюзы недоступны (${summary})`,
    attempts,
  };
}
