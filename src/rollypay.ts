/**
 * Касса RollyPay (https://docs.rollypay.io/) - приём рублёвых платежей (СБП, карты) с конвертацией в USDT.
 *
 * Сейчас используется для ДОБРОВОЛЬНЫХ пожертвований на сайте (/donate, способ «Карта / СБП»).
 * Модуль также умеет активировать подписку бота по заказу вида sub-<uid>-<days>-... - на будущее,
 * если решим продавать подписку картой; в боте такой кнопки пока нет.
 *
 * Секреты - ТОЛЬКО через `wrangler secret put` (не в код и не в wrangler.toml):
 *   ROLLYPAY_API_KEY         - API-ключ кассы (заголовок X-API-Key)
 *   ROLLYPAY_SIGNING_SECRET  - секрет подписи вебхуков (заголовок X-Signature)
 * Необязательные переменные:
 *   ROLLYPAY_TERMINAL_ID     - UUID кассы (при авторизации по ключу можно не передавать)
 *   ROLLYPAY_API_BASE        - адрес API, если отличается от стандартного
 *   ROLLYPAY_TEST = "1"      - создавать тестовые (sandbox) платежи без реальных денег
 *
 * Вебхук: POST /api/payment/rollypay. Подпись: hex(HMAC-SHA256(signing_secret, X-Timestamp + "." + сырое_тело)).
 */
import type { Env } from "./config";
import { planByDays } from "./plans";

/** В личном кабинете указан api.rollypay.io, в документации - rollypay.io. Пробуем по очереди. */
export const ROLLYPAY_BASES = ["https://api.rollypay.io", "https://rollypay.io"];

export type RollyStatus = "created" | "processing" | "paid" | "expired" | "canceled" | "chargeback" | "refunded";

export interface RollyCreateInput {
  amount: number;
  orderId: string;
  description?: string;
  customerId?: string;
  successUrl?: string;
  failUrl?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface RollyCreateResult {
  ok: boolean;
  payUrl?: string;
  paymentId?: string;
  error?: string;
  /** HTTP-статус последней попытки (для логов) */
  status?: number;
}

export interface RollyEvent {
  event_type?: string;
  payment_id?: string;
  order_id?: string;
  status?: string;
  amount?: string;
  currency?: string;
  test?: boolean;
  metadata?: Record<string, unknown>;
}

export function rollypayConfigured(env: Env): boolean {
  return Boolean(String(env.ROLLYPAY_API_KEY || "").trim());
}

export function rollypayTestMode(env: Env): boolean {
  return /^(1|true|yes)$/i.test(String(env.ROLLYPAY_TEST || ""));
}

function bases(env: Env): string[] {
  const custom = String(env.ROLLYPAY_API_BASE || "").trim().replace(/\/+$/, "");
  return custom ? [custom] : ROLLYPAY_BASES;
}

function nonce(): string {
  return crypto.randomUUID();
}

/** Уникальный order_id: тип-данные-время-случайный хвост (RollyPay требует уникальность). */
export function makeOrderId(kind: "don" | "sub", ...parts: Array<string | number>): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return [kind, ...parts, Date.now().toString(36), rnd].join("-");
}

/** Разбор нашего order_id. don-<rub>-..., sub-<uid>-<days>-... */
export function parseOrderId(orderId: string): { kind: "don"; rub: number } | { kind: "sub"; uid: number; days: number } | null {
  const don = /^don-(\d+)-/.exec(orderId || "");
  if (don) return { kind: "don", rub: Number(don[1]) };
  const sub = /^sub-(\d+)-(\d+)-/.exec(orderId || "");
  if (sub) return { kind: "sub", uid: Number(sub[1]), days: Number(sub[2]) };
  return null;
}

/** Создание платежа. Возвращает pay_url, куда нужно отправить покупателя. */
export async function createRollyPayment(env: Env, input: RollyCreateInput): Promise<RollyCreateResult> {
  const apiKey = String(env.ROLLYPAY_API_KEY || "").trim();
  if (!apiKey) return { ok: false, error: "Касса RollyPay не настроена (нет ROLLYPAY_API_KEY)" };
  const body: Record<string, unknown> = {
    amount: input.amount.toFixed(2),
    payment_currency: "RUB",
    order_id: input.orderId,
  };
  const terminal = String(env.ROLLYPAY_TERMINAL_ID || "").trim();
  if (terminal) body.terminal_id = terminal;
  if (input.description) body.description = input.description.slice(0, 200);
  if (input.customerId) body.customer_id = input.customerId;
  if (input.successUrl) body.success_redirect_url = input.successUrl;
  if (input.failUrl) body.fail_redirect_url = input.failUrl;
  if (input.metadata) body.metadata = input.metadata;
  if (rollypayTestMode(env)) body.test = true;

  let lastError = "нет ответа";
  let lastStatus = 0;
  for (const base of bases(env)) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": apiKey, "X-Nonce": nonce() },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      lastError = `${base}: ${String(e?.message || e).slice(0, 120)}`;
      continue;
    }
    lastStatus = res.status;
    const text = await res.text().catch(() => "");
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* не JSON */ }
    if (res.ok && data?.pay_url) {
      return { ok: true, payUrl: String(data.pay_url), paymentId: data.payment_id ? String(data.payment_id) : undefined, status: res.status };
    }
    const msg = data ? String(data.error || data.message || data.detail || JSON.stringify(data)).slice(0, 200) : text.replace(/\s+/g, " ").slice(0, 120);
    lastError = `${base.replace("https://", "")}: HTTP ${res.status} ${msg}`.trim();
    // Ответ по существу от настоящего API (ошибка ключа, суммы и т.п.) - другой адрес не поможет
    if (data && res.status !== 404 && res.status !== 405 && res.status < 500) break;
  }
  return { ok: false, error: lastError, status: lastStatus };
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function rollySignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Проверка подписи вебхука. Отметка времени не старше суток (повторы RollyPay идут до ~1 часа). */
export async function verifyRollySignature(secret: string, timestamp: string, rawBody: string, signature: string, nowMs = Date.now()): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(nowMs - tsMs) > 86_400_000) return false;
  const expected = await rollySignature(secret, timestamp, rawBody);
  const got = signature.trim().toLowerCase().replace(/^sha256=/, "");
  return safeEqual(expected, got);
}

/** Сохранённое состояние платежа (bot_state, scope rp:<payment_id>). */
export interface RollyRecord {
  payment_id: string;
  order_id: string;
  status: string;
  amount: number;
  currency: string;
  test: boolean;
  kind: "don" | "sub" | "other";
  /** Подписка уже выдана по этому платежу (защита от повторной выдачи) */
  granted?: boolean;
  first_at: string;
  updated_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  created: "создан",
  processing: "оплачивается",
  paid: "оплачен ✅",
  expired: "истёк",
  canceled: "отменён",
  chargeback: "чарджбек ⚠️",
  refunded: "возврат ↩️",
};

export function rollyStatusLabel(status: string): string {
  return STATUS_LABEL[status] || status;
}

export function isPlanAmountOk(days: number, amount: number): boolean {
  const plan = planByDays(days);
  return Boolean(plan && amount + 0.001 >= plan.rub);
}
