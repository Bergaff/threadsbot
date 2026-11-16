/**
 * Счётчик Яндекс Метрики (pr88).
 *
 * Рекламная сеть Яндекса считает «реальных посетителей» по своим данным - прежде всего по Метрике.
 * Без счётчика на сайте Яндекс видит лишь малую часть аудитории (заходы из Telegram, по прямым ссылкам
 * и из других поисковиков ему не видны) и отклоняет сайт: «Недостаточно реальных посетителей».
 *
 * Номер счётчика задаётся переменной YANDEX_METRIKA_ID в wrangler.toml. Пусто - счётчика нет.
 * Код вставляется перед </head> во все HTML-страницы сайта, кроме админки и /stats.
 * Вебвизор выключен (тяжёлый и записывает действия посетителей), остальное - стандартный набор.
 */
import type { Env } from "./config";

export function metrikaId(env: Pick<Env, "YANDEX_METRIKA_ID">): string {
  const id = String(env.YANDEX_METRIKA_ID || "").trim();
  return /^\d{5,12}$/.test(id) ? id : "";
}

export function metrikaTag(id: string): string {
  if (!id) return "";
  return `<!-- Yandex.Metrika counter -->
<script type="text/javascript">(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${id},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true});</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute;left:-9999px;" alt="" /></div></noscript>
<!-- /Yandex.Metrika counter -->`;
}

/** Страницы, куда счётчик не ставим: админка и закрытая статистика для рекламодателей */
export function skipMetrika(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("/admin") || p === "/stats" || p.startsWith("/stats/");
}

/** Вставляет счётчик в HTML-ответ (в том числе отданный из Edge-кэша). Остальные ответы не трогает. */
export async function withMetrika(request: Request, env: Env, res: Response): Promise<Response> {
  const id = metrikaId(env);
  if (!id || request.method !== "GET") return res;
  const type = res.headers.get("content-type") || "";
  if (!/text\/html/i.test(type) || !res.body) return res;
  if (skipMetrika(new URL(request.url).pathname)) return res;
  const html = await res.text();
  if (html.includes("mc.yandex.ru/metrika/tag.js")) return new Response(html, res);
  const i = html.search(/<\/head>/i);
  if (i < 0) return new Response(html, res);
  const out = html.slice(0, i) + metrikaTag(id) + "\n" + html.slice(i);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
