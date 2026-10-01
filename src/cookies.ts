import { KEY_COOKIES, LIMITS } from "./config";

export type CookieRecord = Record<string, unknown>;

export interface AccountDiagnosis {
  name: string;
  isAlive: boolean;
  issues: string[];
  missingKeys: string[];
  cookieCount: number;
  expiresAt: number | null;
  names: string[];
}

const SESSION_ALIASES = new Set(["sessionid", "session_id", "ig_sessionid"]);

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
    if (!cookie || typeof cookie !== "object") {
      return { ok: false, error: "Не все элементы имеют поля name/value" };
    }
    const rec = cookie as CookieRecord;
    const name = rec.name ?? rec.Name;
    const value = rec.value ?? rec.Value;
    if (!name || value === undefined) {
      return { ok: false, error: "Не все элементы имеют поля name/value" };
    }
    rec.name = String(name);
    rec.value = value;
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

/** Срок жизни сессии определяется именно sessionid, а не временными куками (wd, dpr и т.д.) */
export function sessionCookieExpiry(cookies: CookieRecord[]): number | null {
  for (const cookie of cookies) {
    const name = String(cookie.name ?? cookie.Name ?? "").toLowerCase();
    if (SESSION_ALIASES.has(name) || name === "sessionid") {
      const value = cookie.expirationDate ?? cookie.expires;
      if (typeof value === "number" && value > 0) {
        const ms = toExpiryMs(value);
        if (ms > 0) return ms;
      }
    }
  }
  return earliestCookieExpiry(cookies);
}

export function cookieNameList(cookies: CookieRecord[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const cookie of cookies) {
    const name = String(cookie.name ?? cookie.Name ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function cookieNames(cookies: CookieRecord[]): Set<string> {
  return new Set(cookieNameList(cookies));
}

/** sessionid обязателен (HttpOnly). Без него экспорт из Cookie-Editor бесполезен. */
export function missingKeyCookies(cookies: CookieRecord[]): string[] {
  const names = new Set(cookieNameList(cookies).map(name => name.toLowerCase()));
  const missing: string[] = [];
  if (![...SESSION_ALIASES].some(alias => names.has(alias))) missing.push("sessionid");
  if (!names.has("ds_user_id")) missing.push("ds_user_id");
  if (!names.has("ig_did")) missing.push("ig_did");
  return missing;
}

export function hasKeyCookies(cookies: CookieRecord[]): boolean {
  return !missingKeyCookies(cookies).includes("sessionid");
}

export function snapshotHasSession(raw: string): boolean {
  const validation = validateCookiesJson(raw);
  return validation.ok && !missingKeyCookies(validation.cookies).includes("sessionid");
}

export function diagnoseAccountCookies(name: string, isAlive: boolean, cookiesJson: string): AccountDiagnosis {
  const issues: string[] = [];
  const validation = validateCookiesJson(cookiesJson);
  if (!validation.ok) {
    return { name, isAlive, issues: [validation.error], missingKeys: [...KEY_COOKIES], cookieCount: 0, expiresAt: null, names: [] };
  }
  const names = cookieNameList(validation.cookies);
  const missingKeys = missingKeyCookies(validation.cookies);
  if (missingKeys.includes("sessionid")) {
    issues.push("нет sessionid (HttpOnly). В Cookie-Editor включи HttpOnly и экспортни JSON заново");
  } else if (missingKeys.length) issues.push(`нет ${missingKeys.join(", ")}`);
  const expiresAt = sessionCookieExpiry(validation.cookies);
  const now = Date.now();
  if (expiresAt !== null) {
    const stamp = formatDay(expiresAt);
    if (expiresAt < now) issues.push(`cookies истекли ${stamp} — нужен новый экспорт`);
    else if (expiresAt < now + LIMITS.cookieWarnDays * 86_400_000) issues.push(`истекают ${stamp}`);
  }
  return { name, isAlive, issues, missingKeys, cookieCount: validation.cookies.length, expiresAt, names };
}

/**
 * Пробует распаковать Base64 в JSON с куки.
 *
 * Base64 - частый формат выгрузки: его дают расширения-экспортёры, а при переносе
 * между машинами JSON удобнее передать одной строкой. Принимаем его прозрачно,
 * чтобы пользователю не пришлось декодировать вручную.
 *
 * Возвращает null, если это не Base64 или внутри не JSON - тогда строка
 * обрабатывается как есть, и обычный путь выдаст привычную ошибку.
 */
function tryDecodeBase64Cookies(raw: string): string | null {
  const compact = String(raw || "").replace(/\s+/g, "");
  if (compact.length < 16 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const binary = atob(compact);
    // atob отдаёт байты как latin1, поэтому декодируем в UTF-8 явно:
    // имена и значения куки могут содержать не-ASCII.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (!text.startsWith("[") && !text.startsWith("{")) return null;
    return text;
  } catch {
    return null;
  }
}

export function normalizeCookiesJson(raw: string): NormalizedCookies | { ok: false; error: string } {
  let input = String(raw || "").trim();
  // Если это не JSON напрямую, пробуем считать Base64.
  if (input && !input.startsWith("[") && !input.startsWith("{")) {
    const decoded = tryDecodeBase64Cookies(input);
    if (decoded) input = decoded;
  }
  const validation = validateCookiesJson(input);
  if (!validation.ok) return validation;
  const cookies: CookieRecord[] = [];
  const issues: string[] = [];
  const badDomains: string[] = [];
  for (const cookie of validation.cookies) {
    const sameSite = sameSiteOf(cookie.sameSite);
    // Домен проверяем явно: валидатор JSON его не смотрит, а мусорный домен
    // означает, что браузер никогда не пришлёт куку сайту. Раньше это принималось
    // молча, аккаунт сохранялся "рабочим" и умирал на первой же проверке.
    // Частая причина - копирование из чата, где ".threads.com" превращается
    // в markdown-ссылку ".[threads.com](http://threads.com)".
    const rawDomain = String(cookie.domain || "").trim();
    if (rawDomain && !/^\.[A-Za-z0-9.-]+$/.test(rawDomain)) {
      badDomains.push(`${String(cookie.name)} -> ${rawDomain}`);
      continue;
    }
    const item: CookieRecord = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: rawDomain || ".threads.com",
      path: cookie.path || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false || sameSite === "None",
      sameSite,
    };
    const expires = cookie.expirationDate ?? cookie.expires;
    if (typeof expires === "number" && expires > 0) item.expires = toUnixSeconds(expires);
    cookies.push(item);
  }

  if (badDomains.length) {
    return {
      ok: false,
      error:
        `Недопустимый домен у ${badDomains.length} куки: ${badDomains.slice(0, 5).join("; ")}. ` +
        `Домен должен выглядеть как ".threads.com". Скорее всего JSON скопирован из чата или документа, ` +
        `где адрес превратился в ссылку вида ".[threads.com](http://...)". Скопируйте экспорт заново из Cookie-Editor.`,
    };
  }

  if (!cookies.length) {
    return { ok: false, error: "После проверки доменов не осталось ни одной куки" };
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
  const out: CookieRecord[] = [];
  const seen = new Set<string>();
  // Cloudflare Playwright: либо url, либо domain+path. Вместе с url нельзя передавать path
  // (ошибка "Cookie should have either url or path"). Как в Python — domain + path, без url.
  for (const cookie of expandCookieDomains(normalized.cookies)) {
    const expires = cookie.expires;
    if (typeof expires === "number" && expires <= nowSec) continue;
    const domain = String(cookie.domain || ".threads.com");
    const path = String(cookie.path || "/");
    const key = `${cookie.name}|${domain}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: CookieRecord = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain,
      path,
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite || "Lax",
    };
    if (typeof expires === "number" && expires > 0) item.expires = expires;
    out.push(item);
  }
  return out;
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
