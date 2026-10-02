import { describe, expect, it } from "vitest";
import { FeedCollector, type FeedPost, mergeDomWithFeed, normalizeThreadsPost, parseThreadsPayload } from "../src/threadsFeed";

const post = (code: string, user = "one.kazakhstan", extra: Record<string, unknown> = {}) => ({
  pk: code + "pk",
  code,
  user: { username: user, profile_pic_url: "https://cdn/av.jpg" },
  caption: { text: `text of ${code}` },
  taken_at: 1727800000,
  like_count: 12,
  text_post_app_info: { direct_reply_count: 3 },
  image_versions2: { candidates: [] },
  ...extra,
});

const page = (codes: string[], hasNext: boolean, user = "one.kazakhstan") => ({
  data: {
    mediaData: {
      edges: codes.map(c => ({ node: { thread_items: [{ post: post(c, user) }] } })),
      page_info: { has_next_page: hasNext, end_cursor: hasNext ? "CUR" : null },
    },
  },
});

describe("parseThreadsPayload", () => {
  it("strips for(;;); and parses streamed multi-document bodies", () => {
    expect(parseThreadsPayload('for (;;);{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseThreadsPayload('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseThreadsPayload("")).toEqual([]);
    expect(parseThreadsPayload("<html>")).toEqual([]);
  });
});

describe("normalizeThreadsPost", () => {
  it("maps a Threads post with carousel and video", () => {
    const p = normalizeThreadsPost(post("ABC", "one.kazakhstan", {
      carousel_media: [
        { image_versions2: { candidates: [{ url: "https://cdn/small.jpg", width: 100 }, { url: "https://cdn/big.jpg", width: 1080 }] } },
        { image_versions2: { candidates: [{ url: "https://cdn/2.jpg", width: 1080 }] }, video_versions: [{ url: "https://cdn/v.mp4" }] },
      ],
    }))!;
    expect(p.id).toBe("ABC");
    expect(p.postUrl).toBe("/@one.kazakhstan/post/ABC");
    expect(p.images).toEqual(["https://cdn/big.jpg", "https://cdn/2.jpg"]);
    expect(p.videoUrl).toBe("https://cdn/v.mp4");
    expect(p.likes).toBe("12");
    expect(p.replies).toBe("3");
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("skips empty posts", () => {
    expect(normalizeThreadsPost(post("E", "u", { caption: null }))).toBeNull();
  });
});

describe("FeedCollector", () => {
  it("collects posts across GraphQL pages and tracks has_next_page", () => {
    const f = new FeedCollector("@One.Kazakhstan");
    f.ingestText("for (;;);" + JSON.stringify(page(["A", "B", "C"], true)));
    expect(f.posts.map(p => p.id)).toEqual(["A", "B", "C"]);
    expect(f.hasNextPage).toBe(true);
    f.ingestJson(page(["C", "D"], true));
    expect(f.posts.map(p => p.id)).toEqual(["A", "B", "C", "D"]);
    f.ingestJson(page(["E"], false));
    expect(f.hasNextPage).toBe(false);
  });

  it("ignores page_info of other users' connections (suggestions, replies)", () => {
    const f = new FeedCollector("one.kazakhstan");
    f.ingestJson(page(["A"], true));
    f.ingestJson(page(["X", "Y"], false, "someone.else"));
    expect(f.posts.map(p => p.id)).toEqual(["A"]);
    expect(f.hasNextPage).toBe(true);
  });
});

describe("mergeDomWithFeed", () => {
  it("keeps DOM order, enriches from network, appends network-only posts", () => {
    const dom: FeedPost[] = [
      { text: "dom B", has_image: false, has_video: false, postUrl: "/@u/post/B" },
      { text: "dom A", has_image: false, has_video: false, postUrl: "/@u/post/A" },
      { text: "dom A dup", has_image: false, has_video: false, postUrl: "/@u/post/A" },
    ];
    const f = new FeedCollector("u");
    f.ingestJson(page(["A", "B", "C"], true, "u"));
    const merged = mergeDomWithFeed(dom, f.posts);
    expect(merged.map(p => p.postUrl)).toEqual(["/@u/post/B", "/@u/post/A", "/@u/post/C"]);
    expect(merged[0].likes).toBe("12");
    expect(merged[0].text).toBe("dom B");
  });
});
