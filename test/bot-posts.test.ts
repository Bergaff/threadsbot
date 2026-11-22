import { describe, expect, it } from "vitest";
import { authorPosts, mergeIntoWebProfile, pickBotPosts, postRefByNumber } from "../src/botPosts";

const post = (code: string, date: string, extra: any = {}) => ({
  text: `t ${code}`, has_image: false, has_video: false,
  postUrl: `https://www.threads.com/@ann/post/${code}`, date, ...extra,
});

describe("pr92: бот показывает столько же постов, сколько сайт", () => {
  it("берёт кеш сайта, если там постов больше, чем в кеше бота", () => {
    const own = [post("AAAAA1", "2026-11-20")];
    const web = { profile: { username: "ann" }, posts: [post("AAAAA1", "2026-11-20"), post("AAAAA2", "2026-11-19"), post("AAAAA3", "2026-11-18")] };
    expect(pickBotPosts(own, web, "ann")!.length).toBe(3);
    expect(pickBotPosts(web.posts, { posts: own }, "ann")!.length).toBe(3);
    expect(pickBotPosts(null, null, "ann")).toBeNull();
    expect(pickBotPosts(null, { notFound: true, posts: [post("AAAAA1", "x")] }, "ann")).toBeNull();
  });

  it("чужие посты (репосты, ответы) не учитываются", () => {
    const list = [post("AAAAA1", "x", { author: "ann" }), post("AAAAA2", "x", { author: "bob" }), post("AAAAA3", "x")];
    expect(authorPosts(list, "Ann").map((p) => p.postUrl!.slice(-6))).toEqual(["AAAAA1", "AAAAA3"]);
  });

  it("результат бота не затирает шапку профиля и догруженные на сайте посты", () => {
    const existing = {
      profile: { username: "ann", displayName: "Ann", bio: "био", avatar: "https://a/1.jpg", followers: "10K", verified: false },
      posts: [post("BBBBB1", "2026-11-20"), post("BBBBB2", "2026-11-10"), post("BBBBB3", "2026-11-01"), post("BBBBB4", "2026-10-20")],
    };
    const fresh = {
      profile: { username: "ann", displayName: "ann", bio: "", avatar: "", followers: "", verified: false },
      posts: [post("BBBBB0", "2026-11-21"), post("BBBBB1", "2026-11-20")],
    };
    const out = mergeIntoWebProfile(existing, fresh, "ann");
    expect(out.profile.avatar).toBe("https://a/1.jpg");
    expect(out.posts.map((p: any) => p.postUrl.slice(-6))).toEqual(["BBBBB0", "BBBBB1", "BBBBB2", "BBBBB3", "BBBBB4"]);
  });

  it("свежая шапка с аватаром заменяет старую", () => {
    const out = mergeIntoWebProfile({ profile: { avatar: "old" }, posts: [] }, { profile: { avatar: "new" }, posts: [post("CCCCC1", "x")] }, "ann");
    expect(out.profile.avatar).toBe("new");
    expect(out.posts.length).toBe(1);
  });

  it("номер поста в боте -> код поста и счётчик ответов (комментарии по коду, как на сайте)", () => {
    const list = [post("DDDDD1", "x", { replies: "12" }), post("DDDDD2", "x", { replies: "1,2K" }), { text: "", has_image: true, has_video: false } as any];
    expect(postRefByNumber(list, 1)).toEqual({ code: "DDDDD1", expected: 12 });
    expect(postRefByNumber(list, 2)).toEqual({ code: "DDDDD2", expected: 1200 });
    expect(postRefByNumber(list, 3)).toBeNull();
    expect(postRefByNumber(list, 4)).toBeNull();
    expect(postRefByNumber(null, 1)).toBeNull();
  });
});
