import { describe, expect, it } from "vitest";
import { cleanPostText, text } from "../src/i18n";

describe("i18n",()=>{
 it("formats placeholders",()=>expect(text("posts_found","en",{username:"zuck",count:3})).toContain("@zuck"));
 it("falls back for unknown language",()=>expect(text("no_posts","xx")).toBe(text("no_posts","ru")));
 it("removes Threads translation suffix",()=>expect(cleanPostText("Hello world\nSee translation")).toBe("Hello world"));
});
