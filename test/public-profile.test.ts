import { describe, it, expect } from "vitest";
import {
  metaContent,
  jsonScriptBlocks,
  normalizePost,
  walkForPosts,
  sliceBalancedJson,
  jsonLdBlocks,
} from "../src/threads";

/**
 * Парсинг публичной страницы Threads БЕЗ браузера и БЕЗ куки.
 *
 * Это единственный источник данных, который работает, когда все технические
 * аккаунты мертвы, поэтому его поведение зафиксировано тестами. Проверить его
 * на живом HTML из песочницы нельзя (Threads блокирует запросы), поэтому
 * фикстуры ниже повторяют формы разметки, которые отдает Meta Comet.
 */
describe("Public profile parser (no cookies required)", () => {
  describe("metaContent", () => {
    it("reads og:title in either attribute order", () => {
      const a = '<meta property="og:title" content="Иван (@ivan) • Threads" />';
      const b = '<meta content="Иван (@ivan) • Threads" property="og:title" />';
      expect(metaContent(a, "og:title")).toBe("Иван (@ivan) • Threads");
      expect(metaContent(b, "og:title")).toBe("Иван (@ivan) • Threads");
    });

    it("decodes HTML entities instead of leaking them into the UI", () => {
      const html = '<meta property="og:title" content="Tom &amp; Jerry (@tj)" />';
      expect(metaContent(html, "og:title")).toBe("Tom & Jerry (@tj)");
    });

    it("returns empty string when the tag is absent", () => {
      expect(metaContent("<html></html>", "og:image")).toBe("");
    });
  });

  describe("sliceBalancedJson", () => {
    it("ignores braces inside string values", () => {
      const src = '{"text":"a { b } c"} tail';
      expect(sliceBalancedJson(src, 0, 1000)).toBe('{"text":"a { b } c"}');
    });

    it("ignores escaped quotes inside string values", () => {
      const src = '{"text":"say \\"hi\\" {x}"}';
      expect(sliceBalancedJson(src, 0, 1000)).toBe(src);
    });

    it("returns null for unterminated JSON rather than throwing", () => {
      expect(sliceBalancedJson('{"a":1', 0, 1000)).toBeNull();
    });
  });

  describe("jsonScriptBlocks", () => {
    it("parses explicit application/json blocks", () => {
      const html = '<script type="application/json">{"text_post_app_info":{"headline":"ok"}}</script>';
      const blocks = jsonScriptBlocks(html);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text_post_app_info.headline).toBe("ok");
    });

    it("mines Comet payloads from plain script tags without a type attribute", () => {
      // Именно этот случай раньше терялся: regex искал только type="application/json".
      const html = `<script>window.__bbox = {"data":{"text_post_app_info":{"headline":"из обычного script"}},"meta":1};</script>`;
      const blocks = jsonScriptBlocks(html);
      const found = blocks.some((b) => JSON.stringify(b).includes("из обычного script"));
      expect(found).toBe(true);
    });

    it("skips plain scripts that contain no post markers", () => {
      // Не маркерный код не должен парситься: это экономит CPU на воркере.
      const html = '<script>var a = {"foo": 1}; console.log(a);</script>';
      expect(jsonScriptBlocks(html)).toHaveLength(0);
    });

    it("does not treat ld+json as a Comet payload block", () => {
      const html = '<script type="application/ld+json">{"@type":"ProfilePage"}</script>';
      expect(jsonScriptBlocks(html)).toHaveLength(0);
      expect(jsonLdBlocks(html)).toHaveLength(1);
    });
  });

  describe("jsonLdBlocks", () => {
    it("parses a single ProfilePage node", () => {
      const html = '<script type="application/ld+json">{"@type":"ProfilePage","name":"Ivan","description":"bio"}</script>';
      const nodes = jsonLdBlocks(html);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe("Ivan");
    });

    it("repairs several objects concatenated without a wrapping array", () => {
      const html = '<script type="application/ld+json">{"@type":"ProfilePage","name":"A"}{"@type":"BreadcrumbList"}</script>';
      const nodes = jsonLdBlocks(html);
      expect(Array.isArray(nodes[0])).toBe(true);
      expect(nodes[0]).toHaveLength(2);
    });
  });

  describe("normalizePost", () => {
    it("maps a Threads post node into the internal Post shape", () => {
      const node = {
        code: "ABC123",
        text: "Привет",
        like_count: 42,
        replies_count: 7,
        taken_at: 1700000000,
        image_url: "https://cdn.example/a.jpg",
        user: { username: "ivan" },
      };
      const post = normalizePost(node, "ivan");
      expect(post).not.toBeNull();
      expect(post!.id).toBe("ABC123");
      expect(post!.text).toBe("Привет");
      expect(post!.likes).toBe("42");
      expect(post!.replies).toBe("7");
      expect(post!.has_image).toBe(true);
      expect(post!.postUrl).toBe("https://www.threads.com/@ivan/post/ABC123");
    });

    it("preserves a zero like count instead of dropping it", () => {
      // Регресс на баг приоритета операторов: `a ?? b === false ? c : d`.
      const post = normalizePost({ code: "X", text: "no likes yet", like_count: 0 }, "ivan");
      expect(post!.likes).toBe("0");
    });

    it("reads the headline from text_post_app_info when text is absent", () => {
      const post = normalizePost(
        { code: "Y", text_post_app_info: { headline: "через headline", direct_reply_count: 3 } },
        "ivan"
      );
      expect(post!.text).toBe("через headline");
      expect(post!.replies).toBe("3");
    });

    it("flags video posts and keeps the video url", () => {
      const post = normalizePost(
        { code: "V", text: "видео", video_url: "https://cdn.example/v.mp4" },
        "ivan"
      );
      expect(post!.has_video).toBe(true);
      expect(post!.videoUrl).toBe("https://cdn.example/v.mp4");
    });

    it("returns null for nodes that are not posts", () => {
      expect(normalizePost({ foo: "bar" }, "ivan")).toBeNull();
      expect(normalizePost({ text: "нет идентификатора" }, "ivan")).toBeNull();
      expect(normalizePost(null, "ivan")).toBeNull();
    });
  });

  describe("walkForPosts", () => {
    it("finds posts nested deep inside a Comet response", () => {
      // Реальная вложенность Threads глубже прежнего лимита в 14 уровней.
      const deep: any = { data: { user: { edge: { owner: { timeline: { media: { edges: [] as any[] } } } } } } };
      let cursor = deep.data.user.edge.owner.timeline.media.edges;
      cursor.push({
        node: { code: "DEEP1", text: "глубоко вложенный пост", like_count: 5 },
      });
      const out: any[] = [];
      walkForPosts(deep, "ivan", new Set(), out);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe("глубоко вложенный пост");
    });

    it("deduplicates the same post reached through different branches", () => {
      const node = { code: "DUP", text: "один и тот же пост" };
      const root = { a: { node }, b: { node }, c: [node] };
      const out: any[] = [];
      walkForPosts(root, "ivan", new Set(), out);
      expect(out).toHaveLength(1);
    });

    it("caps the result so a huge payload cannot blow the Worker memory", () => {
      const many = Array.from({ length: 200 }, (_, i) => ({ code: `P${i}`, text: `пост ${i}` }));
      const out: any[] = [];
      walkForPosts({ edges: many }, "ivan", new Set(), out);
      expect(out.length).toBeLessThanOrEqual(40);
    });
  });
});
