import { describe, expect, it } from "vitest";
import { isLoginUrl, isUserNotFoundPage } from "../src/profile";

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
    expect(isUserNotFoundPage("Welcome to Threads")).toBe(false);
  });
});
