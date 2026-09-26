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
  ADMIN_PASSWORD?: string;
  BOT_USERNAME?: string;
  SITE_URL?: string;
  SITE_DOMAIN?: string;
  SPONSOR_RU_URL?: string;
  SPONSOR_RU_TITLE?: string;
  SPONSOR_RU_DESC?: string;
  SPONSOR_EN_URL?: string;
  SPONSOR_EN_TITLE?: string;
  SPONSOR_EN_DESC?: string;
}

export const LIMITS = {
  priceStarsMonth: 149,
  priceStarsWeek: 49,
  priceCryptoUsdMonth: 2.5,
  priceCryptoUsdWeek: 1.0,
  priceStars: 149,
  priceCryptoUsd: 2.5,
  subscriptionDays: 30,
  subscriptionDaysWeek: 7,
  subscriptionDaysQuarter: 90,
  subscriptionDaysYear: 365,
  priceRubWeek: 99,
  priceRubMonth: 129,
  priceRubQuarter: 299,
  priceRubYear: 890,
  priceUsdWeek: 0.99,
  priceUsdMonth: 1.49,
  priceUsdQuarter: 3.49,
  priceUsdYear: 9.99,
  freeMonthly: 60,
  freeDaily: 5,
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
export const adminPassword = (env: Env): string => env.ADMIN_PASSWORD || "admin";
export const botUsername = (env: Env): string => env.BOT_USERNAME || "threadsreaderbot";
export const siteUrl = (env: Env): string => env.SITE_URL || "https://threadsviewer.online";
export const siteDomain = (env: Env): string => env.SITE_DOMAIN || "threadsviewer.online";