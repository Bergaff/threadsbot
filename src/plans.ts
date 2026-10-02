/**
 * Единый источник цен: подписка в Telegram-боте (Stars / USDT), суммы пожертвований на сайте (/donate),
 * оферта и проверка платежей берут цены ТОЛЬКО отсюда. На сайте подписка не продаётся.
 *
 * Звёзды пересчитаны примерно по цене покупки Stars в Telegram (~1,7 ₽ за звезду),
 * USDT - по рыночному курсу с округлением до «красивых» цен.
 */
export type PlanId = "trial" | "month" | "quarter" | "year";
export type PayMethod = "card" | "stars" | "crypto";

export interface Plan {
  id: PlanId;
  days: number;
  rub: number;
  usd: number;
  stars: number;
  /** Подсветка карточки: популярный / выгодный */
  badge?: "popular" | "best";
}

export const PLANS: readonly Plan[] = [
  { id: "trial", days: 3, rub: 39, usd: 0.49, stars: 25 },
  { id: "month", days: 30, rub: 129, usd: 1.49, stars: 75, badge: "popular" },
  { id: "quarter", days: 90, rub: 299, usd: 3.49, stars: 175 },
  { id: "year", days: 365, rub: 890, usd: 9.99, stars: 500, badge: "best" },
] as const;

export const DEFAULT_PLAN: PlanId = "month";

export function planById(id: string | null | undefined): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function planByDays(days: number): Plan | undefined {
  return PLANS.find((p) => p.days === days);
}

/** Месячный тариф - база для расчёта «выгоды» длинных тарифов. */
const MONTH = PLANS.find((p) => p.id === "month")!;

/** Цена за 30 дней внутри тарифа, ₽ (для подписи «≈ 100 ₽/мес»). */
export function rubPerMonth(p: Plan): number {
  return Math.round((p.rub / p.days) * 30);
}

/** Экономия против помесячной оплаты, % (0 для коротких тарифов). Считается в валюте показа. */
export function savingsPercent(p: Plan, currency: "rub" | "usd" = "rub"): number {
  if (p.days <= MONTH.days) return 0;
  const full = (MONTH[currency] / MONTH.days) * p.days;
  return Math.max(0, Math.round((1 - p[currency] / full) * 100));
}

export function planTitle(p: Plan, lang: "ru" | "en"): string {
  const ru: Record<PlanId, string> = { trial: "Пробный", month: "Месяц", quarter: "3 месяца", year: "Год" };
  const en: Record<PlanId, string> = { trial: "Trial", month: "Monthly", quarter: "3 months", year: "Yearly" };
  return (lang === "en" ? en : ru)[p.id];
}

export function planDuration(p: Plan, lang: "ru" | "en"): string {
  if (lang === "en") return `${p.days} days`;
  const n = p.days % 100;
  const n1 = p.days % 10;
  const word = n > 10 && n < 20 ? "дней" : n1 === 1 ? "день" : n1 >= 2 && n1 <= 4 ? "дня" : "дней";
  return `${p.days} ${word}`;
}

/** Основная цена для показа на сайте: рубли для RU, доллары для EN. */
export function planPrice(p: Plan, lang: "ru" | "en"): string {
  return lang === "en" ? `$${p.usd.toFixed(2)}` : `${p.rub} ₽`;
}

/** Deep-link в бота: бот сразу выставит счёт на выбранный тариф и способ оплаты. */
export function botBuyLink(botUsername: string, plan: Plan, method: Exclude<PayMethod, "card">): string {
  return `https://t.me/${botUsername}?start=buy_${plan.id}_${method}`;
}

/** Разбор payload `/start buy_<plan>_<method>`. */
export function parseBuyPayload(payload: string): { plan: Plan; method: "stars" | "crypto" } | null {
  const m = /^buy_(trial|month|quarter|year)(?:_(stars|crypto))?$/.exec(payload || "");
  if (!m) return null;
  const plan = planById(m[1]);
  if (!plan) return null;
  return { plan, method: (m[2] as "stars" | "crypto") || "stars" };
}

// ---------------------------------------------------------------------------
// Добровольные пожертвования (сайт). Ничего не открывают: сайт бесплатный для всех.
// Фиксированные суммы, чтобы ссылки в бота нельзя было подделать на произвольную сумму.
// ---------------------------------------------------------------------------
export interface Donation { rub: number; usd: number; stars: number }

export const DONATIONS: readonly Donation[] = [
  { rub: 50, usd: 0.5, stars: 30 },
  { rub: 100, usd: 1, stars: 60 },
  { rub: 300, usd: 3, stars: 175 },
  { rub: 500, usd: 5, stars: 300 },
] as const;

export const DEFAULT_DONATION = 100;

export function donationByRub(rub: number | string | null | undefined): Donation | undefined {
  return DONATIONS.find((d) => d.rub === Number(rub));
}

export function donationPrice(d: Donation, lang: "ru" | "en"): string {
  return lang === "en" ? `$${d.usd % 1 ? d.usd.toFixed(2) : d.usd}` : `${d.rub} ₽`;
}

/** Deep-link в бота на пожертвование: бот выставит счёт на эту сумму. */
export function botDonateLink(botUsername: string, d: Donation, method: Exclude<PayMethod, "card">): string {
  return `https://t.me/${botUsername}?start=donate_${d.rub}_${method}`;
}

/** Разбор payload `/start donate_<rub>_<method>`. */
export function parseDonatePayload(payload: string): { donation: Donation; method: "stars" | "crypto" } | null {
  const m = /^donate_(\d+)(?:_(stars|crypto))?$/.exec(payload || "");
  const donation = m ? donationByRub(m[1]) : undefined;
  if (!donation) return null;
  return { donation, method: (m![2] as "stars" | "crypto") || "stars" };
}
