import { describe, expect, it } from "vitest";
import { detectBotType, isAccountBlockedUrl, isHomeRedirect, isLoginUrl, isProfileUrl, isThreadsHost, isUserNotFoundPage } from "../src/profile";

describe("detectBotType", () => {
  it("detects search bots and SEO crawlers correctly", () => {
    expect(detectBotType("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe("Googlebot");
    expect(detectBotType("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)")).toBe("YandexBot");
    expect(detectBotType("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe("Bingbot");
    expect(detectBotType("DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)")).toBe("DuckDuckBot");
    expect(detectBotType("Baiduspider+(+http://www.baidu.com/search/spider.htm)")).toBe("Baiduspider");
    expect(detectBotType("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)")).toBe("AhrefsBot");
    expect(detectBotType("Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)")).toBe("SemrushBot");
    expect(detectBotType("Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot...)")).toBe("SEO-Crawler");
  });

  it("returns null for ordinary user agents", () => {
    expect(detectBotType("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")).toBeNull();
    expect(detectBotType("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBeNull();
    expect(detectBotType("")).toBeNull();
  });
});

describe("isLoginUrl", () => {
  it("detects login paths only", () => {
    expect(isLoginUrl("https://www.threads.com/login")).toBe(true);
    expect(isLoginUrl("https://www.threads.com/login/?next=/")).toBe(true);
    expect(isLoginUrl("https://www.threads.net/accounts/login")).toBe(true);
    expect(isLoginUrl("https://www.threads.com/@zuck")).toBe(false);
    expect(isLoginUrl("https://www.threads.com/")).toBe(false);
  });
});

describe("isUserNotFoundPage", () => {
  it("catches Threads/Instagram missing-profile copy", () => {
    expect(isUserNotFoundPage("Sorry, this page isn't available.")).toBe(true);
    expect(isUserNotFoundPage("Страница не найдена")).toBe(true);
    expect(isUserNotFoundPage("The link you followed may be broken")).toBe(true);
    expect(isUserNotFoundPage("This account does not exist")).toBe(true);
    expect(isUserNotFoundPage("Не удалось найти этот аккаунт")).toBe(true);
    expect(isUserNotFoundPage("Welcome to Threads")).toBe(false);
  });

  it("recognizes the 2026 Threads 404 page (curly apostrophe too)", () => {
    const body = "Not all who wander are lost, but this page is The link’s not working or the page is gone. Go back to keep exploring. Back © 2026 Threads Terms Privacy Policy";
    expect(isUserNotFoundPage(body)).toBe(true);
    expect(isUserNotFoundPage("The link's not working or the page is gone.")).toBe(true);
    expect(isUserNotFoundPage("Sorry, this page isn’t available.")).toBe(true);
  });
});

describe("isHomeRedirect", () => {
  it("detects when Threads redirects away from the requested profile to home feed", () => {
    expect(isHomeRedirect("https://www.threads.com/", "4a.cev")).toBe(true);
    expect(isHomeRedirect("https://www.threads.com/?hl=ru", "4a.cev")).toBe(true);
    expect(isHomeRedirect("https://www.threads.net/for_you", "4a.cev")).toBe(true);
    expect(isHomeRedirect("https://www.threads.com/explore", "4a.cev")).toBe(true);
    expect(isHomeRedirect("https://www.threads.com/@4a.cev", "4a.cev")).toBe(false);
    expect(isHomeRedirect("https://www.threads.com/@4a.cev/post/123", "4a.cev")).toBe(false);
    expect(isHomeRedirect("https://www.threads.com/@zuck", "4a.cev")).toBe(true);
  });

  it("REGRESSION: never treats a failed navigation as a home redirect", () => {
    // about:blank даёт pathname "blank", который не содержит username.
    // Раньше из-за этого существующий профиль объявлялся несуществующим.
    expect(isHomeRedirect("about:blank", "xuxukit")).toBe(false);
    expect(isHomeRedirect("", "xuxukit")).toBe(false);
    expect(isHomeRedirect("https://example.com/@xuxukit", "xuxukit")).toBe(false);
    expect(isHomeRedirect("not a url", "xuxukit")).toBe(false);
  });
});

describe("isThreadsHost", () => {
  it("accepts only Threads origins", () => {
    expect(isThreadsHost("https://www.threads.com/@zuck")).toBe(true);
    expect(isThreadsHost("https://threads.com/@zuck")).toBe(true);
    expect(isThreadsHost("https://www.threads.net/@zuck")).toBe(true);
    expect(isThreadsHost("https://l.threads.com/")).toBe(true);
    expect(isThreadsHost("about:blank")).toBe(false);
    expect(isThreadsHost("")).toBe(false);
    expect(isThreadsHost("https://evil-threads.com/@zuck")).toBe(false);
    expect(isThreadsHost("https://threads.com.evil.test/@zuck")).toBe(false);
  });
});

describe("isProfileUrl", () => {
  it("matches only the requested profile page", () => {
    expect(isProfileUrl("https://www.threads.com/@xuxukit", "xuxukit")).toBe(true);
    expect(isProfileUrl("https://www.threads.com/@xuxukit/", "xuxukit")).toBe(true);
    expect(isProfileUrl("https://www.threads.com/@xuxukit/post/123", "xuxukit")).toBe(true);
    expect(isProfileUrl("https://www.threads.com/@XUXUKIT", "xuxukit")).toBe(true);
    expect(isProfileUrl("https://www.threads.com/@xuxukit", "@xuxukit")).toBe(true);
    expect(isProfileUrl("https://www.threads.com/", "xuxukit")).toBe(false);
    expect(isProfileUrl("https://www.threads.com/@other", "xuxukit")).toBe(false);
    expect(isProfileUrl("https://www.threads.com/checkpoint/", "xuxukit")).toBe(false);
    expect(isProfileUrl("about:blank", "xuxukit")).toBe(false);
    expect(isProfileUrl("", "xuxukit")).toBe(false);
  });
});

describe("isAccountBlockedUrl", () => {
  it("detects Meta suspension / checkpoint pages of the scraper account", () => {
    expect(isAccountBlockedUrl("https://www.threads.com/accounts/suspended/?next=https%3A%2F%2Fwww.threads.com%2F%40one.kazakhstan%3F__coig_ufac%3D1")).toBe(true);
    expect(isAccountBlockedUrl("https://www.threads.com/accounts/disabled/")).toBe(true);
    expect(isAccountBlockedUrl("https://www.threads.com/challenge/?next=/")).toBe(true);
    expect(isAccountBlockedUrl("https://www.threads.net/checkpoint/123")).toBe(true);
  });

  it("does not fire on profiles, feed or empty urls", () => {
    expect(isAccountBlockedUrl("https://www.threads.com/@one.kazakhstan")).toBe(false);
    expect(isAccountBlockedUrl("https://www.threads.com/@suspended")).toBe(false);
    expect(isAccountBlockedUrl("https://www.threads.com/")).toBe(false);
    expect(isAccountBlockedUrl("about:blank")).toBe(false);
    expect(isAccountBlockedUrl("")).toBe(false);
  });
});

describe("mergePostLists", () => {
  it("keeps already shown posts in order and appends only new ones", async () => {
    const { mergePostLists } = await import("../src/profile");
    const base = [
      { text: "a", postUrl: "https://www.threads.com/@u/post/AAA" },
      { text: "b", postUrl: "https://www.threads.com/@u/post/BBB" },
    ];
    const fresh = [
      { text: "new on top", postUrl: "https://www.threads.com/@u/post/NEW" },
      { text: "a (edited)", postUrl: "https://www.threads.com/@u/post/AAA" },
      { text: "b", postUrl: "https://www.threads.com/@u/post/BBB" },
      { text: "c without url" },
      { text: "c without url" },
    ];
    const merged = mergePostLists(base, fresh);
    expect(merged.map((p: any) => p.text)).toEqual(["a", "b", "new on top", "c without url"]);
    expect(base.length).toBe(2);
  });
});
