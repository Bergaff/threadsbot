import type { Env } from "./config";

export interface CreatePaymentOptions {
  uid?: number;
  days: number;
  amount?: number;
  description?: string;
}

export interface PaymentResult {
  ok: boolean;
  formUrl?: string;
  orderId?: number;
  error?: string;
}

export async function createJhpayPayment(
  env: Env,
  options: CreatePaymentOptions
): Promise<PaymentResult> {
  const token = (env as any).JHPAY_TOKEN || "940e2c5aec5bf97eab483ac86c07c0db";
  const days = options.days || 7;
  const amount = options.amount || (days === 30 ? 149 : 49);
  const uid = options.uid || 0;
  const orderNumber = uid > 0 ? `${uid}_${days}_${Date.now()}` : `web_${days}_${Date.now()}`;
  const description = options.description || `Threads Viewer Премиум ${days} дн.`;

  try {
    const res = await fetch("https://pay.jhpay.online/api/pay/order/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-TOKEN": token,
      },
      body: JSON.stringify({
        orderNumber,
        amount,
        description,
        currency: 643,
        email: "customer@threadsviewer.online",
        phone: "79000000000",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: `Gateway HTTP ${res.status}: ${errText}` };
    }

    const data = await res.json<any>();
    if (data && data.formUrl) {
      return { ok: true, formUrl: data.formUrl, orderId: data.orderId };
    }
    return { ok: false, error: data?.message || "No formUrl returned from gateway" };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}
