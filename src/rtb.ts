/**
 * pr94: Рекламная сеть Яндекса (РСЯ).
 *
 * Коды загрузчика и блока - в точности как выдал кабинет РСЯ (partner.yandex.ru).
 * Блоки задаются в wrangler.toml:
 *   YANDEX_RTB_MAIN  - блок на месте бывшей заглушки «Рекламное место» (главная и профиль, все экраны);
 *   YANDEX_RTB_LEFT  - длинная левая колонка в пустом поле сбоку от ленты (экраны от 1024 px);
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
if (window.matchMedia && window.matchMedia("(min-width: 1024px)").matches) {
window.yaContextCb.push(() => {
    Ya.Context.AdvManager.render({
        "blockId": "${id}",
        "renderTo": "yandex_rtb_${id}"
    })
})
}
</script>
</aside>`;
}

export const RTB_CSS = `
  .rtb-slot { margin: 18px 0; min-height: 50px; }
  .rtb-contact { margin: -10px 0 18px; text-align: right; font-size: 0.72rem; }
  .rtb-contact a { color: #8a8a8a; text-decoration: none; }
  .rtb-contact a:hover { text-decoration: underline; }
  .rtb-rail { display: none; }
  @media (min-width: 1024px) {
    /* ширина колонки = свободное поле сбоку от ленты (620 px) минус отступы: от 160 до 300 px */
    .rtb-rail { --rail-w: clamp(160px, calc((100vw - 620px) / 2 - 40px), 300px); display: block; position: fixed; top: 90px; width: var(--rail-w); height: min(600px, calc(100vh - 110px)); overflow: hidden; z-index: 5; }
    .rtb-rail > div[id^="yandex_rtb_"] { width: 100%; height: 100%; }
    .rtb-rail-left { left: calc(50% - 330px - var(--rail-w)); }
    .rtb-rail-right { right: calc(50% - 330px - var(--rail-w)); }
  }
`;

export function rtbRails(env: Env, isPremium = false): string {
  if (isPremium) return "";
  const c = rtbConfig(env);
  return (c.left ? rtbRailBlock(c.left, "left") : "") + (c.right ? rtbRailBlock(c.right, "right") : "");
}

/** Основной блок на месте заглушки + маленькая ссылка для прямых рекламодателей */
export function rtbMainSlot(env: Env, contactHtml: string): string {
  const c = rtbConfig(env);
  if (!c.main) return "";
  return `<div class="rtb-slot">
${rtbBlock(c.main)}
</div>${contactHtml}`;
}
