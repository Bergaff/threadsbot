/**
 * pr94: Рекламная сеть Яндекса (РСЯ).
 *
 * Коды загрузчика и блока - в точности как выдал кабинет РСЯ (partner.yandex.ru).
 * Блоки задаются в wrangler.toml:
 *   YANDEX_RTB_MAIN  - блок на месте бывшей заглушки «Рекламное место» (главная и профиль, все экраны);
 *   YANDEX_RTB_LEFT  - длинная левая колонка у левого края окна, на уровне начала ленты (экраны от 1024 px);
 *                      стоит на месте в странице (не закреплена на экране) и не заходит на шапку и плашку бота;
 *   YANDEX_RTB_RIGHT - длинная правая колонка.
 * Колонки: ширина по свободному полю сбоку (160-300 px), высота до 600 px - контейнер с заданной высотой,
 * чтобы адаптивный блок мог выбрать вертикальный формат (160x600, 240x400, 300x600).
 * Один блок РСЯ можно показать на странице только один раз, поэтому у каждого места свой ID.
 * Пустое значение - места нет. Подписчикам бота (режим без рекламы) реклама не показывается.
 */
import type { Env } from "./config";

/** Ссылка «Реклама на сайте» под основным блоком */
export const ADS_CONTACT_URL = "https://t.me/olekksiy";

const RTB_ID_RE = /^R-A-\d{5,12}-\d{1,4}$/;

export function rtbId(value?: string | null): string {
  const v = String(value || "").trim();
  return RTB_ID_RE.test(v) ? v : "";
}

export type RtbConfig = { main: string; left: string; right: string };

export function rtbConfig(env: Env): RtbConfig {
  const main = rtbId(env.YANDEX_RTB_MAIN);
  const left = rtbId(env.YANDEX_RTB_LEFT);
  const right = rtbId(env.YANDEX_RTB_RIGHT);
  // Один и тот же блок дважды на странице РСЯ не разрешает
  return { main, left: left && left !== main ? left : "", right: right && right !== main && right !== left ? right : "" };
}

export function rtbEnabled(env: Env): boolean {
  const c = rtbConfig(env);
  return Boolean(c.main || c.left || c.right);
}

/** Код загрузчика РСЯ - один раз в <head> */
export const RTB_LOADER = `<!-- Yandex.RTB -->
<script>window.yaContextCb=window.yaContextCb||[]</script>
<script src="https://yandex.ru/ads/system/context.js" async></script>`;

export function rtbHead(env: Env, isPremium = false): string {
  return !isPremium && rtbEnabled(env) ? RTB_LOADER : "";
}

/** Код рекламного блока - как в кабинете РСЯ */
export function rtbBlock(id: string): string {
  return `<!-- Yandex.RTB ${id} -->
<div id="yandex_rtb_${id}"></div>
<script>
window.yaContextCb.push(() => {
    Ya.Context.AdvManager.render({
        "blockId": "${id}",
        "renderTo": "yandex_rtb_${id}"
    })
})
</script>`;
}

/** Боковой блок: рендерится только если колонка видна (широкий экран), скрытые блоки РСЯ запрещает */
function rtbRailBlock(id: string, side: "left" | "right"): string {
  return `<aside class="rtb-rail rtb-rail-${side}" aria-label="Реклама">
<!-- Yandex.RTB ${id} -->
<div id="yandex_rtb_${id}"></div>
<script>
(function () {
  // pr98: колонки стоят в начале страницы, но запрашиваются ПОСЛЕ основного блока
  // (после разбора всей страницы), чтобы основной блок перед FAQ не оставался без рекламы.
  function rtbRail() {
    if (!(window.matchMedia && window.matchMedia("(min-width: 1024px)").matches)) return;
    window.yaContextCb.push(() => {
        Ya.Context.AdvManager.render({
            "blockId": "${id}",
            "renderTo": "yandex_rtb_${id}"
        })
    })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", rtbRail); else rtbRail();
})();
</script>
</aside>`;
}

export const RTB_CSS = `
  .rtb-slot { margin: 18px 0; min-height: 50px; max-width: 100%; overflow: hidden; }
  .rtb-contact-mobile { display: none; }
  @media (max-width: 480px) { .rtb-contact-mobile { display: block; } }
  .rtb-contact { margin: -10px 0 18px; text-align: right; font-size: 0.72rem; }
  .rtb-contact a { color: #8a8a8a; text-decoration: none; }
  .rtb-contact a:hover { text-decoration: underline; }
  .rtb-rails, .rtb-rail { display: none; }
  @media (min-width: 1024px) {
    /* Якорь в начале ленты (под шапкой и плашкой бота). Колонки стоят на месте в странице
       и уезжают при прокрутке вместе с ней (не закреплены на экране), прижаты к краям окна. */
    .rtb-rails { display: block; position: relative; height: 0; }
    .rtb-rail { --rail-w: clamp(160px, calc((100vw - 100%) / 2 - 40px), 300px); display: block; position: absolute; top: 0; width: var(--rail-w); height: 600px; overflow: hidden; z-index: 5; }
    .rtb-rail > div { width: 100%; height: 100%; }
    .rtb-rail-left { left: calc(16px - (100vw - 100%) / 2); }
    .rtb-rail-right { right: calc(16px - (100vw - 100%) / 2); }
  }
`;

export function rtbRails(env: Env, isPremium = false): string {
  if (isPremium) return "";
  const c = rtbConfig(env);
  const rails = (c.left ? rtbRailBlock(c.left, "left") : "") + (c.right ? rtbRailBlock(c.right, "right") : "");
  return rails ? `<div class="rtb-rails">${rails}</div>` : "";
}

/** Основной блок на месте заглушки + маленькая ссылка для прямых рекламодателей */
export function rtbMainSlot(env: Env, contactHtml: string): string {
  const c = rtbConfig(env);
  if (!c.main) return "";
  return `<div class="rtb-slot">
${rtbBlock(c.main)}
</div>${contactHtml}`;
}
