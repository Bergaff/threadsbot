export interface Env {
  DB: D1Database;
  BROWSER: import("@cloudflare/playwright").BrowserWorker;
  UPDATES: Queue<import("./telegram").TelegramUpdate>;
  TELEGRAM_TOKEN: string;
  CRYPTO_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS?: string;
  STATS_EXCLUDE_IDS?: string;
  BASE_URL?: string;
  VERSION?: string;
}

export const LIMITS = {
  priceStars: 150,
  priceCryptoUsd: 2.5,
  subscriptionDays: 30,
  freeMonthly: 10,
  freeDaily: 3,
  perMinute: 3,
  perHour: 15,
  perDay: 50,
  cacheMinutes: 15,
  accountHourly: 20,
  /** Как часто проверять cookies-файлы аккаунтов (в секундах) — 6ч */
  diagnoseIntervalSec: 21_600,
  /** За сколько дней до истечения cookies предупреждать */
  cookieWarnDays: 7,
} as const;

/** Ключевые cookies, без которых сессия Threads не работает */
export const KEY_COOKIES = new Set(["sessionid", "session_id", "ds_user_id", "ig_did"]);

export const adminIds = (env: Env): number[] =>
  (env.ADMIN_IDS || "369330135,657708753").split(",").map(Number).filter(Number.isFinite);
export const excludedIds = (env: Env): number[] =>
  (env.STATS_EXCLUDE_IDS || env.ADMIN_IDS || "").split(",").map(Number).filter(Number.isFinite);
export const isAdmin = (env: Env, uid: number): boolean => adminIds(env).includes(uid);