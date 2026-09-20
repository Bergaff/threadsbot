import { describe, expect, it } from "vitest";
import { cleanPostText, text } from "../src/i18n";

describe("i18n",()=>{
 it("formats placeholders",()=>expect(text("posts_found","en",{username:"zuck",count:3})).toContain("@zuck"));
 it("falls back for unknown language",()=>expect(text("no_posts","xx")).toBe(text("no_posts","ru")));
 it("removes Threads translation suffix",()=>expect(cleanPostText("Hello world\nSee translation")).toBe("Hello world"));
 it("has terms in all languages",()=>{
  for (const lang of ["ru","en","de","es","pt"] as const) {
    expect(text("help", lang)).toContain("/terms");
    expect(text("terms", lang).length).toBeGreaterThan(80);
  }
 });
});
