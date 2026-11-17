import { describe, expect, it } from "vitest";
import { canonicalHostRedirect } from "../src/canonicalHost";

const env: any = { SITE_URL: "https://threadsviewer.online" };

describe("pr91: www -> основной домен", () => {
  it("GET на www даёт 301 на тот же путь без www", () => {
    const r = canonicalHostRedirect(new Request("https://www.threadsviewer.online/@zuck?lang=en"), env)!;
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://threadsviewer.online/@zuck?lang=en");
    const home = canonicalHostRedirect(new Request("https://WWW.threadsviewer.online/"), env)!;
    expect(home.headers.get("location")).toBe("https://threadsviewer.online/");
  });

  it("HEAD тоже перенаправляется", () => {
    const r = canonicalHostRedirect(new Request("https://www.threadsviewer.online/", { method: "HEAD" }), env);
    expect(r?.status).toBe(301);
  });

  it("POST (вебхуки Telegram/кассы) на www не трогаем", () => {
    const r = canonicalHostRedirect(new Request("https://www.threadsviewer.online/telegram/x", { method: "POST", body: "{}" }), env);
    expect(r).toBeNull();
  });

  it("основной домен и чужие хосты не перенаправляются", () => {
    expect(canonicalHostRedirect(new Request("https://threadsviewer.online/"), env)).toBeNull();
    expect(canonicalHostRedirect(new Request("https://threadsbot.example.workers.dev/"), env)).toBeNull();
    expect(canonicalHostRedirect(new Request("https://site.com/"), env)).toBeNull();
  });

  it("воркер целиком: www-главная уходит 301 до любой логики", async () => {
    const worker = (await import("../src/index")).default as any;
    const r: Response = await worker.fetch(new Request("https://www.threadsviewer.online/ru/"), { ...env, DB: {} }, { waitUntil() {}, passThroughOnException() {} });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://threadsviewer.online/ru/");
  });
});
