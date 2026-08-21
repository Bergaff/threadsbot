import { describe, expect, it } from "vitest";
import {
  diagnoseAccountCookies,
  expandCookieDomains,
  earliestCookieExpiry,
  missingKeyCookies,
  normalizeCookiesJson,
  parseThreadsUsername,
  playwrightCookies,
  toUnixSeconds,
  validateCookiesJson,
} from "../src/cookies";

const future = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const past = Math.floor(Date.now() / 1000) - 24 * 3600;

const sample = [
  { name: "sessionid", value: "abc", domain: ".instagram.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: future },
  { name: "ds_user_id", value: "1", domain: ".instagram.com", expirationDate: future },
  { name: "ig_did", value: "xyz", domain: ".threads.net", expirationDate: future },
];

describe("parseThreadsUsername", () => {
  it("accepts bare and @ handles", () => {
    expect(parseThreadsUsername("zuck")).toBe("zuck");
    expect(parseThreadsUsername("@zuck")).toBe("zuck");
  });
  it("extracts from threads URLs", () => {
    expect(parseThreadsUsername("https://www.threads.net/@zuck")).toBe("zuck");
    expect(parseThreadsUsername("https://www.threads.com/@some.user/post/ABC")).toBe("some.user");
  });
  it("rejects junk", () => {
    expect(parseThreadsUsername("a")).toBeNull();
    expect(parseThreadsUsername("/start")).toBeNull();
    expect(parseThreadsUsername("https://example.com/zuck")).toBeNull();
    expect(parseThreadsUsername("hello world")).toBeNull();
  });
});

describe("cookies json", () => {
  it("accepts Cookie-Editor arrays and {cookies:[]} wrappers", () => {
    expect(validateCookiesJson(JSON.stringify(sample)).ok).toBe(true);
    expect(validateCookiesJson(JSON.stringify({ cookies: sample })).ok).toBe(true);
  });
  it("rejects empty/invalid", () => {
    expect(validateCookiesJson("{").ok).toBe(false);
    expect(validateCookiesJson("[]").ok).toBe(false);
    expect(validateCookiesJson(JSON.stringify([{ value: "x" }])).ok).toBe(false);
  });
  it("requires sessionid and lists other missing keys", () => {
    expect(missingKeyCookies(sample)).toEqual([]);
    expect(missingKeyCookies([{ name: "ig_did", value: "1" }])).toContain("sessionid");
  });
  it("handles seconds and milliseconds expiry", () => {
    expect(toUnixSeconds(future)).toBe(future);
    expect(toUnixSeconds(future * 1000)).toBe(future);
    const ms = earliestCookieExpiry(sample);
    expect(ms).toBeGreaterThan(Date.now());
  });
  it("mirrors instagram/threads cookies onto both threads domains", () => {
    const expanded = expandCookieDomains(sample);
    const domains = new Set(expanded.filter(c => c.name === "sessionid").map(c => c.domain));
    expect(domains.has(".instagram.com")).toBe(true);
    expect(domains.has(".threads.com")).toBe(true);
    expect(domains.has(".threads.net")).toBe(true);
  });
  it("drops already expired cookies before Playwright", () => {
    const raw = JSON.stringify([
      ...sample,
      { name: "dead", value: "1", domain: ".threads.com", expires: past },
    ]);
    const list = playwrightCookies(raw);
    expect(list.some(c => c.name === "dead")).toBe(false);
    expect(list.some(c => c.name === "sessionid")).toBe(true);
  });
  it("uses url not domain for Playwright addCookies", () => {
    const list = playwrightCookies(JSON.stringify(sample));
    const session = list.filter(c => c.name === "sessionid");
    expect(session.some(c => c.url === "https://www.threads.com/")).toBe(true);
    expect(session.some(c => c.url === "https://www.threads.net/")).toBe(true);
    expect(session.every(c => c.domain === undefined)).toBe(true);
  });
  it("normalizes sameSite and keeps JSON round-trip", () => {
    const result = normalizeCookiesJson(JSON.stringify(sample));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookies[0].sameSite).toBe("None");
    expect(JSON.parse(result.json)).toHaveLength(3);
  });
  it("diagnoses expired session", () => {
    const raw = JSON.stringify([{ name: "sessionid", value: "x", expires: past }]);
    const d = diagnoseAccountCookies("acc", true, raw);
    expect(d.issues.some(x => x.includes("истекли"))).toBe(true);
  });
  it("flags export without HttpOnly sessionid and lists names", () => {
    const raw = JSON.stringify([
      { name: "csrftoken", value: "a" },
      { name: "mid", value: "b" },
      { name: "ig_did", value: "c" },
    ]);
    const d = diagnoseAccountCookies("gecko", true, raw);
    expect(d.missingKeys).toContain("sessionid");
    expect(d.names).toEqual(["csrftoken", "mid", "ig_did"]);
    expect(d.issues.some(x => x.includes("HttpOnly"))).toBe(true);
  });
  it("accepts sessionid case-insensitively", () => {
    const raw = JSON.stringify([{ name: "SessionID", value: "x" }, { name: "ds_user_id", value: "1" }, { name: "ig_did", value: "z" }]);
    const d = diagnoseAccountCookies("acc", true, raw);
    expect(d.missingKeys).not.toContain("sessionid");
  });
});
