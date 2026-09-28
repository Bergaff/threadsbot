import { describe, expect, it } from "vitest";
import { isHomeRedirect, isLoginUrl, isUserNotFoundPage } from "../src/profile";

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
});
