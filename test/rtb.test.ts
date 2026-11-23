import { describe, expect, it } from "vitest";
import { rtbBlock, rtbConfig, rtbId, RTB_LOADER } from "../src/rtb";
import { renderHomePage, renderPrivacyPage, renderProfilePage } from "../src/web";

const base: any = { BOT_USERNAME: "threadsreaderbot", WEBHOOK_SECRET: "s", SITE_URL: "https://threadsviewer.online" };
const env = (extra: any = {}): any => ({ ...base, YANDEX_RTB_MAIN: "R-A-20435188-1", ...extra });
const count = (s: string, part: string) => s.split(part).length - 1;

describe("pr94: Рекламная сеть Яндекса", () => {
  it("ID блока только формата R-A-…; одинаковые ID на одной странице не повторяются", () => {
    expect(rtbId(" R-A-20435188-1 ")).toBe("R-A-20435188-1");
    expect(rtbId("R-A-1<script>")).toBe("");
    expect(rtbConfig(env({ YANDEX_RTB_LEFT: "R-A-20435188-1", YANDEX_RTB_RIGHT: "R-A-20435188-2" })))
      .toEqual({ main: "R-A-20435188-1", left: "", right: "R-A-20435188-2" });
  });

  it("код блока - как выдал кабинет РСЯ", () => {
    expect(rtbBlock("R-A-20435188-1")).toBe(`<!-- Yandex.RTB R-A-20435188-1 -->
<div id="yandex_rtb_R-A-20435188-1"></div>
<script>
window.yaContextCb.push(() => {
    Ya.Context.AdvManager.render({
        "blockId": "R-A-20435188-1",
        "renderTo": "yandex_rtb_R-A-20435188-1"
    })
})
</script>`);
  });

  it("главная и профиль: загрузчик один раз в <head>, блок на месте заглушки, ссылка для рекламодателей", async () => {
    const pages = [
      await renderHomePage(env(), "ru", false).text(),
      await renderProfilePage(env(), "zuck", null, null, "ru").text(),
    ];
    for (const html of pages) {
      expect(count(html, "yandex.ru/ads/system/context.js")).toBe(1);
      expect(html.indexOf(RTB_LOADER)).toBeLessThan(html.indexOf("</head>"));
      expect(html).toContain(rtbBlock("R-A-20435188-1"));
      expect(count(html, 'id="yandex_rtb_R-A-20435188-1"')).toBe(1);
      expect(html).not.toContain("Здесь может быть ваша реклама");
      expect(html).toContain('<a href="https://t.me/olekksiy" target="_blank" rel="noopener nofollow">Реклама на сайте</a>');
      expect(html).toContain("показа рекламы");
    }
  });

  it("подписчикам (режим без рекламы) - ни загрузчика, ни блока", async () => {
    const html = await renderHomePage(env(), "ru", true).text();
    expect(html).not.toContain("yandex.ru/ads/system/context.js");
    expect(html).not.toContain("yandex_rtb_");
  });

  it("без ID РСЯ - прежняя заглушка, без загрузчика", async () => {
    const html = await renderHomePage({ ...base }, "ru", false).text();
    expect(html).not.toContain("context.js");
    expect(html).toContain("Здесь может быть ваша реклама");
  });

  it("боковые колонки - только если заданы, и рендерятся только на широком экране", async () => {
    const html = await renderHomePage(env({ YANDEX_RTB_LEFT: "R-A-20435188-2", YANDEX_RTB_RIGHT: "R-A-20435188-3" }), "ru", false).text();
    expect(html).toContain('class="rtb-rail rtb-rail-left"');
    expect(html).toContain('id="yandex_rtb_R-A-20435188-2"');
    expect(html).toContain('id="yandex_rtb_R-A-20435188-3"');
    expect(html).toContain('matchMedia("(min-width: 1024px)")');
    expect(count(html, "context.js")).toBe(1);
    expect(await renderHomePage(env(), "ru", false).text()).not.toContain('class="rtb-rail rtb-rail-left"');
  });

  it("политика конфиденциальности упоминает РСЯ, когда реклама включена", async () => {
    const ru = await renderPrivacyPage("ru", "https://threadsviewer.online", true, true).text();
    expect(ru).toContain("Рекламную сеть Яндекса");
    expect(ru).not.toContain("пиксели рекламных сетей");
    const en = await renderPrivacyPage("en", "https://threadsviewer.online", true, true).text();
    expect(en).toContain("Yandex Advertising Network");
    expect(await renderPrivacyPage("ru", "https://threadsviewer.online", true, false).text()).not.toContain("Рекламную сеть Яндекса");
  });

  it("главная: блок 1 стоит прямо перед «Часто задаваемые вопросы», колонки 2 и 3 по бокам", async () => {
    const html = await renderHomePage(env({ YANDEX_RTB_LEFT: "R-A-20435188-2", YANDEX_RTB_RIGHT: "R-A-20435188-3" }), "ru", false).text();
    const b1 = html.indexOf('id="yandex_rtb_R-A-20435188-1"');
    const faq = html.indexOf('class="faq-card"');
    expect(b1).toBeGreaterThan(0);
    expect(faq).toBeGreaterThan(b1);
    expect(html.slice(b1, faq)).not.toContain("<section");
    expect(html).toMatch(/rtb-rail-left[\s\S]*yandex_rtb_R-A-20435188-2/);
    expect(html).toMatch(/rtb-rail-right[\s\S]*yandex_rtb_R-A-20435188-3/);
  });

  it("wrangler.toml: основной блок R-A-20435188-1", async () => {
    // @ts-ignore - в проекте нет типов Node
    const fs: any = await import("node:fs");
    const toml: string = fs.readFileSync("wrangler.toml", "utf8");
    expect(toml).toMatch(/^YANDEX_RTB_MAIN = "R-A-20435188-1"$/m);
    expect(toml).toMatch(/^YANDEX_RTB_LEFT = "R-A-20435188-2"$/m);
    expect(toml).toMatch(/^YANDEX_RTB_RIGHT = "R-A-20435188-3"$/m);
  });
});
