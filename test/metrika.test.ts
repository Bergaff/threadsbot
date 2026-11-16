import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { metrikaId, metrikaTag, withMetrika } from "../src/metrika";
import { renderPrivacyPage } from "../src/web";

const ctx: any = { waitUntil: (p: Promise<unknown>) => { p?.catch?.(() => {}); }, passThroughOnException() {} };
const DB: any = {
  prepare() {
    const stmt: any = { bind: () => stmt, first: async () => null, run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }) };
    return stmt;
  },
  async batch() { return []; },
};
const env = (id = "98765432"): any => ({ DB, YANDEX_METRIKA_ID: id, BOT_USERNAME: "threadsreaderbot", WEBHOOK_SECRET: "s" });

describe("Яндекс Метрика (pr88)", () => {
  it("номер счётчика только из цифр, пусто - нет счётчика", () => {
    expect(metrikaId({ YANDEX_METRIKA_ID: " 98765432 " })).toBe("98765432");
    expect(metrikaId({ YANDEX_METRIKA_ID: "" })).toBe("");
    expect(metrikaId({ YANDEX_METRIKA_ID: "abc<script>" })).toBe("");
    expect(metrikaTag("98765432")).toContain('ym(98765432,"init"');
    expect(metrikaTag("98765432")).not.toContain("webvisor:true");
  });

  it("счётчик в HTML-страницах сайта, один раз и внутри <head>", async () => {
    for (const path of ["/terms", "/privacy", "/no-such-page/x/y"]) {
      const res = await worker.fetch(new Request("https://threadsviewer.online" + path), env(), ctx);
      const html = await res.text();
      expect(html.split("mc.yandex.ru/metrika/tag.js").length - 1).toBe(1);
      expect(html.indexOf("ym(98765432")).toBeLessThan(html.indexOf("</head>"));
    }
  });

  it("не в админке, не в /stats, не в robots.txt и не без номера", async () => {
    for (const path of ["/admin", "/stats", "/robots.txt"]) {
      const res = await worker.fetch(new Request("https://threadsviewer.online" + path), env(), ctx);
      expect(await res.text()).not.toContain("mc.yandex.ru");
    }
    const res = await worker.fetch(new Request("https://threadsviewer.online/terms"), env(""), ctx);
    expect(await res.text()).not.toContain("mc.yandex.ru");
  });

  it("сохраняет статус и заголовки ответа", async () => {
    const orig = new Response("<html><head></head><body>x</body></html>", { status: 404, headers: { "content-type": "text/html; charset=UTF-8", "x-test": "1" } });
    const res = await withMetrika(new Request("https://threadsviewer.online/x"), env(), orig);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.text()).toContain("ym(98765432");
  });

  it("политика конфиденциальности упоминает Метрику, только если счётчик стоит", async () => {
    expect(await renderPrivacyPage("ru", undefined, true).text()).toContain("Яндекс Метрика");
    expect(await renderPrivacyPage("ru").text()).not.toContain("Яндекс Метрика");
    expect(await renderPrivacyPage("en", undefined, true).text()).toContain("Yandex Metrica");
  });
});
