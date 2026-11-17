/**
 * pr91: единый адрес сайта.
 *
 * Воркер привязан и к threadsviewer.online, и к www.threadsviewer.online. Раньше www
 * отдавал полную копию сайта со своими canonical/ссылками на www - Google видел два
 * одинаковых сайта и выбрал для главной "чужую" каноническую версию, а "/" выпала
 * из индекса ("Страница является копией. Канонические версии ... не совпадают").
 *
 * Теперь GET/HEAD на www.<домен> -> 301 на основной домен из SITE_URL с тем же путём
 * и параметрами. POST (вебхуки Telegram, кассы) не трогаем: они не следуют редиректам.
 */
import type { Env } from "./config";

export function canonicalHostRedirect(request: Request, env: Env): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let site: URL;
  try {
    site = new URL(env.SITE_URL || "https://threadsviewer.online");
  } catch {
    return null;
  }
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const main = site.hostname.toLowerCase();
  if (host !== `www.${main}`) return null;
  const target = `${site.origin}${url.pathname}${url.search}`;
  return new Response(null, {
    status: 301,
    headers: { location: target, "cache-control": "public, max-age=86400" },
  });
}
