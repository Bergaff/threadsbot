import { KEY_COOKIES, LIMITS } from "./config";

export type CookieRecord = Record<string, unknown>;

export interface AccountDiagnosis {
  name: string;
  isAlive: boolean;
  issues: string[];
  missingKeys: string[];
  cookieCount: number;
  expiresAt: number | null;
}

export interface NormalizedCookies {
  ok: true;
  cookies: CookieRecord[];
  json: string;
  issues: string[];
}

const THREADS_DOMAINS = [".threads.com", ".threads.net"];
const MIRROR_DOMAIN = /(^|\.)(threads\.(com|net)|instagram\.com)$/i;
const USERNAME_RE = /^[A-Za-z0-9._]{2,30}$/;
const URL_USERNAME_RE = /threads\.(?:com|net)\/@([A-Za-z0-9._]+)/i;

function asCookiesArray(parsed: unknown): CookieRecord[] | null {
  if (Array.isArray(parsed)) return parsed as CookieRecord[];
  if (parsed && typeof parsed === "object") {
    const wrapped = (parsed as { cookies?: unknown }).cookies;
    if (Array.isArray(wrapped)) return wrapped as CookieRecord[];
  }
  return null;
}

function sameSiteOf(value: unknown): "Lax" | "Strict" | "None" {
  const raw = String(value ?? "Lax");
  const lower = raw.toLowerCase();
  if (["unspecified", "null", "", "undefined"].includes(lower)) return "Lax";
  if (["no_restriction", "none"].includes(lower)) return "None";
  if (lower === "strict") return "Strict";
  return "Lax";
}

/** Cookie-Editor отдаёт секунды, некоторые экспорты — миллисекунды. Playwright ждёт секунды. */
export function toUnixSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value > 1e12) return Math.floor(value / 1000);
  return Math.floor(value);
}

export function toExpiryMs(value: number): number {
  const seconds = toUnixSeconds(value);
  return seconds > 0 ? seconds * 1000 : 0;
}

export function validateCookiesJson(raw: string): { ok: true; cookies: CookieRecord[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `JSON повреждён: ${error}` };
  }
  const cookies = asCookiesArray(parsed);
  if (!cookies || cookies.length === 0) {
    return { ok: false, error: "Нужен массив cookies (Cookie-Editor или Playwright)" };
  }
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object" || !cookie.name || cookie.value === undefined) {
      return { ok: false, error: "Не все элементы имеют поля name/value" };
    }
  }
  return { ok: true, cookies };
}

export function earliestCookieExpiry(cookies: CookieRecord[]): number | null {
  const expiries: number[] = [];
  for (const cookie of cookies) {
    const value = cookie.expirationDate ?? cookie.expires;
    if (typeof value === "number" && value > 0) {
      const ms = toExpiryMs(value);
      if (ms > 0) expiries.push(ms);
    }
  }
  return expiries.length ? Math.min(...expiries) : null;
}

export function cookieNames(cookies: CookieRecord[]): Set<string> {
  return new Set(cookies.map(cookie => String(cookie.name)));
}

/** sessionid обязателен; ds_user_id и ig_did желательны. */
export function missingKeyCookies(cookies: CookieRecord[]): string[] {
  const names = cookieNames(cookies);
  const missing: string[] = [];
  if (!names.has("sessionid") && !names.has("session_id")) missing.push("sessionid");
  if (!names.has("ds_user_id")) missing.push("ds_user_id");
  if (!names.has("ig_did")) missing.push("ig_did");
  return missing;
}

export function hasKeyCookies(cookies: CookieRecord[]): boolean {
  return missingKeyCookies(cookies).length === 0 || cookieNames(cookies).has("sessionid") || cookieNames(cookies).has("session_id");
}

export function diagnoseAccountCookies(name: string, isAlive: boolean, cookiesJson: string): AccountDiagnosis {
  const issues: string[] = [];
  const validation = validateCookiesJson(cookiesJson);
  if (!validation.ok) {
    return { name, isAlive, issues: [validation.error], missingKeys: [...KEY_COOKIES], cookieCount: 0, expiresAt: null };
  }
  const missingKeys = missingKeyCookies(validation.cookies);
  if (missingKeys.includes("sessionid")) issues.push("нет sessionid — сессия не рабочая, нужен новый экспорт");
  else if (missingKeys.length) issues.push(`нет ${missingKeys.join(", ")}`);
  const expiresAt = earliestCookieExpiry(validation.cookies);
  const now = Date.now();
  if (expiresAt !== null) {
    const stamp = formatDay(expiresAt);
    if (expiresAt < now) issues.push(`cookies истекли ${stamp} — нужен новый экспорт`);
    else if (expiresAt < now + LIMITS.cookieWarnDays * 86_400_000) issues.push(`истекают ${stamp}`);
  }
  return { name, isAlive, issues, missingKeys, cookieCount: validation.cookies.length, expiresAt };
}

export function normalizeCookiesJson(raw: string): NormalizedCookies | { ok: false; error: string } {
  const validation = validateCookiesJson(raw);
  if (!validation.ok) return validation;
  const cookies: CookieRecord[] = [];
  const issues: string[] = [];
  for (const cookie of validation.cookies) {
    const sameSite = sameSiteOf(cookie.sameSite);
    const item: CookieRecord = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: cookie.domain || ".threads.com",
      path: cookie.path || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false || sameSite === "None",
      sameSite,
    };
    const expires = cookie.expirationDate ?? cookie.expires;
    if (typeof expires === "number" && expires > 0) item.expires = toUnixSeconds(expires);
    cookies.push(item);
  }
  const diagnosis = diagnoseAccountCookies("json", true, JSON.stringify(cookies));
  issues.push(...diagnosis.issues);
  return { ok: true, cookies, json: JSON.stringify(cookies), issues };
}

function shouldMirrorDomain(domain: string): boolean {
  if (!domain) return true;
  return MIRROR_DOMAIN.test(domain) || MIRROR_DOMAIN.test(`.${domain.replace(/^\./, "")}`);
}

/** Дублируем threads/instagram cookies на .threads.com и .threads.net — иначе сессия не доезжает до www.threads.com. */
export function expandCookieDomains(cookies: CookieRecord[]): CookieRecord[] {
  const result: CookieRecord[] = [];
  const seen = new Set<string>();
  for (const cookie of cookies) {
    const original = String(cookie.domain || ".threads.com");
    const domains = new Set<string>([original]);
    if (shouldMirrorDomain(original)) {
      for (const domain of THREADS_DOMAINS) domains.add(domain);
    }
    for (const domain of domains) {
      const key = `${cookie.name}|${domain}|${cookie.path || "/"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...cookie, domain });
    }
  }
  return result;
}

export function playwrightCookies(raw: string, now = Date.now()): CookieRecord[] {
  const normalized = normalizeCookiesJson(raw);
  if (!normalized.ok) throw new Error(normalized.error);
  const nowSec = now / 1000;
  return expandCookieDomains(normalized.cookies).filter(cookie => {
    const expires = cookie.expires;
    return typeof expires !== "number" || expires > nowSec;
  });
}

export function parseThreadsUsername(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fromUrl = trimmed.match(URL_USERNAME_RE);
  if (fromUrl) return USERNAME_RE.test(fromUrl[1]) ? fromUrl[1] : null;
  if (/\s/.test(trimmed)) return null;
  const username = trimmed.replace(/^@+/, "").split(/[/?#]/)[0] || "";
  if (!USERNAME_RE.test(username)) return null;
  return username;
}

function formatDay(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${date.getUTCFullYear()}`;
}
