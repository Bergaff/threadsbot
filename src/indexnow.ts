/**
 * IndexNow - сайт сам сообщает поисковикам, что страница появилась или изменилась.
 * Поддерживают Яндекс, Bing, Seznam, Naver, Yep (Google - нет). Отправка в одного участника
 * передаётся остальным, поэтому шлём напрямую в Яндекс - основной поисковик аудитории.
 *
 * Ключ по протоколу публичный: он же лежит в файле https://<домен>/<ключ>.txt, по которому
 * поисковик проверяет, что уведомления шлёт владелец сайта. Можно переопределить через INDEXNOW_KEY.
 *
 * Когда отправляем:
 *  - профиль успешно загружен с постами -> его страница (не чаще раза в сутки на профиль);
 *  - первый запуск cron после деплоя новой версии -> главная, /en/, /terms, /privacy и /ru/
 *    (последняя теперь 301 на "/", так Яндекс быстрее узнает о переезде).
 */
import type { Env } from "./config";
import { Database } from "./db";

export const DEFAULT_INDEXNOW_KEY = "147b7b6aadeb3b23784b6b3904005e69";
export const INDEXNOW_ENDPOINT = "https://yandex.com/indexnow";
/** Профиль отправляем не чаще раза в сутки - уведомления о неизменившихся страницах протокол не одобряет */
export const INDEXNOW_PROFILE_TTL_MS = 24 * 3600_000;

export function indexNowKey(env: Env): string {
  const k = String((env as any).INDEXNOW_KEY || "").trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(k) ? k : DEFAULT_INDEXNOW_KEY;
}

/** Основной домен сайта (только с него можно отправлять: ключ лежит на нём же) */
export function siteHost(env: Env): string {
  const raw = String(env.SITE_DOMAIN || env.SITE_URL || "threadsviewer.online");
  return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

/** Ответ на /<ключ>.txt - ровно ключ, без перевода строки */
export function indexNowKeyFileResponse(env: Env, pathname: string): Response | null {
  const key = indexNowKey(env);
  if (pathname !== `/${key}.txt`) return null;
  return new Response(key, { headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "public, max-age=86400" } });
}

export type IndexNowResult = { at: string; ok: boolean; status: number; count: number; reason: string; sample: string[]; error?: string };

const STATUS_TEXT: Record<number, string> = {
  200: "принято",
  202: "принято, ключ проверяется",
  400: "неверный формат запроса",
  403: "ключ не подтверждён (файл ключа недоступен или не совпадает)",
  422: "адреса не относятся к домену или ключу",
  429: "слишком много запросов",
};

/** Отправить адреса (одного хоста). Результат последней отправки сохраняется для админки. */
export async function submitIndexNow(env: Env, paths: string[], reason: string): Promise<IndexNowResult> {
  const host = siteHost(env);
  const key = indexNowKey(env);
  const urlList = Array.from(new Set(paths.map((p) => (p.startsWith("http") ? p : `https://${host}${p.startsWith("/") ? "" : "/"}${p}`))))
    .filter((u) => { try { return new URL(u).hostname === host; } catch { return false; } })
    .slice(0, 10_000);
  const result: IndexNowResult = { at: new Date().toISOString(), ok: false, status: 0, count: urlList.length, reason, sample: urlList.slice(0, 5) };
  if (!urlList.length) {
    result.error = "нет адресов";
    return result;
  }
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
    });
    result.status = res.status;
    result.ok = res.status === 200 || res.status === 202;
    if (!result.ok) {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      result.error = `${STATUS_TEXT[res.status] || `HTTP ${res.status}`}${body ? `: ${body}` : ""}`;
    }
  } catch (e: any) {
    result.error = String(e?.message || e).slice(0, 200);
  }
  if (env.DB) await new Database(env).setState(0, "indexnow_last", JSON.stringify(result)).catch(() => {});
  return result;
}

/** Профиль загружен с постами - сообщить о его странице (раз в сутки на профиль, межсерверно через D1) */
export async function notifyProfileUpdated(env: Env, username: string, requestHost: string): Promise<IndexNowResult | null> {
  // Только с основного домена: запросы через *.workers.dev или превью не должны слать чужой хост
  if (requestHost.toLowerCase() !== siteHost(env) || !env.DB) return null;
  const db = new Database(env);
  if (!(await db.tryLock(`indexnow:${username}`, "indexnow_lock", INDEXNOW_PROFILE_TTL_MS))) return null;
  return submitIndexNow(env, [`/@${username}`], `профиль @${username}`);
}

/** Первый запуск cron после деплоя новой версии - главные страницы */
export async function notifyAfterDeploy(env: Env, version: string): Promise<IndexNowResult | null> {
  if (!env.DB) return null;
  const db = new Database(env);
  if ((await db.state(0, "indexnow_version").catch(() => null)) === version) return null;
  const r = await submitIndexNow(env, ["/", "/en/", "/ru/", "/terms", "/privacy"], `деплой ${version}`);
  if (r.ok) await db.setState(0, "indexnow_version", version).catch(() => {});
  return r;
}

export function parseIndexNowResult(raw: string | null): IndexNowResult | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as IndexNowResult; } catch { return null; }
}
