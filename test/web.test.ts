import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  handleImageProxy,
  renderHomePage,
  renderPrivacyPage,
  renderProfilePage,
  renderRobotsTxt,
  renderSitemap,
  renderTermsPage,
} from "../src/web";
import type { Env } from "../src/config";

const mockEnv: Env = {
  DB: {} as any,
  BROWSER: {} as any,
  UPDATES: {} as any,
  TELEGRAM_TOKEN: "123456:ABC-DEF",
  CRYPTO_BOT_TOKEN: "crypto_token",
  WEBHOOK_SECRET: "secret123",
  ADMIN_IDS: "123",
  BASE_URL: "https://www.threads.com",
};

describe("Language Detection", () => {
  it("detects language from query param", () => {
    expect(detectLanguage(new Request("https://site.com/?lang=en"))).toBe("en");
    expect(detectLanguage(new Request("https://site.com/?lang=ru"))).toBe("ru");
  });

  it("detects language from cookie", () => {
    const req = new Request("https://site.com/", {
      headers: { cookie: "lang=en; other=123" },
    });
    expect(detectLanguage(req)).toBe("en");
  });

  it("detects Russian from accept-language or CIS country", () => {
    const reqRu = new Request("https://site.com/", {
      headers: { "accept-language": "ru-RU,ru;q=0.9" },
    });
    expect(detectLanguage(reqRu)).toBe("ru");

    const reqBy = new Request("https://site.com/", {
      headers: { "cf-ipcountry": "BY" },
    });
    expect(detectLanguage(reqBy)).toBe("ru");
  });

  it("defaults to English for other locales", () => {
    const reqUs = new Request("https://site.com/", {
      headers: { "accept-language": "en-US,en;q=0.9", "cf-ipcountry": "US" },
    });
    expect(detectLanguage(reqUs)).toBe("en");
  });
});

describe("Web Viewer SSR & Routing", () => {
  it("renders Russian homepage with blue zuck example and search fill", async () => {
    const res = renderHomePage(mockEnv, "ru");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Threads Viewer");
    expect(html).toContain("Читайте Threads без VPN");
    expect(html).toContain("heroSearchInput");
    expect(html).toContain("exampleZuck");
    expect(html).toContain("fillSearch('zuck')");
    expect(html).toContain("blue-example-link");
    expect(html).toContain("zuck</span>");
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('--c1: #d3cbbe');
    expect(html).toContain('background: #dbd3c5');
    expect(html).toContain("themeToggleBtn");
    expect(html).toContain('content="no-referrer"');
    expect(html).toContain("https://t.me/threadsreaderbot");
  });

  it("renders English homepage when requested", async () => {
    const res = renderHomePage(mockEnv, "en");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Read Threads without VPN");
    expect(html).toContain("For example");
    expect(html).toContain("fillSearch('zuck')");
    expect(html).toContain("exampleZuck");
  });

  it("renders profile page with SSR data and escapes XSS", async () => {
    const initialData = {
      profile: {
        username: "testuser",
        displayName: "<script>alert(1)</script>Test",
        bio: "Bio with link https://example.com and @mention",
        avatar: "https://cdn.example.com/avatar.jpg",
        followers: "15K",
        verified: true,
      },
      posts: [
        {
          text: "First post text <alert>",
          has_image: true,
          has_video: false,
          imageUrl: "https://scontent.cdninstagram.com/pic.jpg",
          date: "2h",
          author: "testuser",
        },
      ],
    };

    const res = renderProfilePage(mockEnv, "testuser", initialData, null, "ru");
    expect(res.status).toBe(200);
    const html = await res.text();

    // Check escaping
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("@testuser");
    expect(html).toContain("First post text &lt;alert&gt;");
    expect(html).toContain("https://scontent.cdninstagram.com/pic.jpg");
    expect(html).toContain("post-mention");
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('post-metric');
    expect(html).toContain('comment-btn');
    expect(html).toContain('comments-loading');
    expect(html).toContain('status-card');
    expect(html).toContain('comment-author-avatar');
    expect(html).toContain('btn-nav-tg');
    expect(html).toContain('btn-lang-toggle');
    expect(html).toContain('btn-theme-toggle');
    expect(html).toContain('height: 32px');
    expect(html).toContain('min-height: 32px');
    expect(html).toContain('max-height: 32px');
  });

  it("renders video element when post has videoUrl", async () => {
    const dataWithVideo = {
      profile: {
        username: "testuser",
        displayName: "Test",
        bio: "Bio",
        avatar: "",
        followers: "100",
        verified: false,
      },
      posts: [
        {
          text: "Post with video",
          has_image: true,
          has_video: true,
          videoUrl: "https://scontent.cdninstagram.com/v/video.mp4",
          imageUrl: "https://scontent.cdninstagram.com/v/poster.jpg",
          date: "2026-09-15T23:01:39.000Z",
          author: "testuser",
          likes: "142",
          replies: "35",
        },
      ],
    };

    const res = renderProfilePage(mockEnv, "testuser", dataWithVideo, null, "ru");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<video");
    expect(html).toContain("/api/media?url=");
    expect(html).toContain("142");
    expect(html).toContain("(35)");
    expect(html).toContain("2026-09-15 23:01");
    expect(html).not.toContain("2026-09-15T23:01:39.000Z");
  });

  it("renders prominent error status card when profile is not found or error occurred", async () => {
    const res = renderProfilePage(mockEnv, "nonexistent_user", null, "Профиль не найден в Threads", "ru");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("status-card-error");
    expect(html).toContain("Профиль не найден в Threads");
    expect(html).toContain("loadingStatusAction");
  });

  it("renders terms and privacy policy pages", async () => {
    const termsRes = renderTermsPage("ru");
    expect(termsRes.status).toBe(200);
    expect(await termsRes.text()).toContain("Пользовательское соглашение");

    const privRes = renderPrivacyPage("ru");
    expect(privRes.status).toBe(200);
    expect(await privRes.text()).toContain("Политика конфиденциальности");

    const termsEn = renderTermsPage("en");
    expect(termsEn.status).toBe(200);
    expect(await termsEn.text()).toContain("Terms of Service");
  });

  it("renders robots.txt and sitemap.xml for SEO", async () => {
    const robotsRes = renderRobotsTxt("https://mythreads.workers.dev");
    expect(robotsRes.status).toBe(200);
    const robotsTxt = await robotsRes.text();
    expect(robotsTxt).toContain("Allow: /");
    expect(robotsTxt).toContain("Sitemap: https://mythreads.workers.dev/sitemap.xml");

    const sitemapRes = renderSitemap("https://mythreads.workers.dev", ["durov", "zuck"]);
    expect(sitemapRes.status).toBe(200);
    const xml = await sitemapRes.text();
    expect(xml).toContain("<loc>https://mythreads.workers.dev/@durov</loc>");
    expect(xml).toContain("<loc>https://mythreads.workers.dev/@zuck</loc>");
  });

  it("renders ad-free premium state when isPremium is true", async () => {
    const resHome = renderHomePage(mockEnv, "ru", true);
    const htmlHome = await resHome.text();
    expect(htmlHome).not.toContain('<div class="sponsor-card">');
    expect(htmlHome).toContain("Премиум активен");

    const resProfile = renderProfilePage(mockEnv, "zuck", null, null, "ru", true);
    const htmlProfile = await resProfile.text();
    expect(htmlProfile).not.toContain('<div class="sponsor-card">');
    expect(htmlProfile).toContain("Премиум активен");
  });

  it("renders geo-targeted sponsor ads for RU vs Global visitors", async () => {
    const resRu = renderHomePage(mockEnv, "ru", false, "RU");
    const htmlRu = await resRu.text();
    expect(htmlRu).toContain('<div class="sponsor-card">');
    expect(htmlRu).toContain("Партнерский блок");
    expect(htmlRu).toContain("Быстрый VPN и приватный доступ");

    const resUs = renderHomePage(mockEnv, "en", false, "US");
    const htmlUs = await resUs.text();
    expect(htmlUs).toContain('<div class="sponsor-card">');
    expect(htmlUs).toContain("Sponsored");
    expect(htmlUs).toContain("Anonymous Social Feed Proxy");
  });

  it("creates and verifies web auth tokens", async () => {
    const { createAuthToken, verifyAuthToken } = await import("../src/auth");
    const token = await createAuthToken(777, "secret_key_123");
    expect(token).toContain("777.");

    const verified = await verifyAuthToken(token, "secret_key_123");
    expect(verified).toBe(777);

    const wrongKey = await verifyAuthToken(token, "wrong_secret");
    expect(wrongKey).toBeNull();
  });

  it("renders support form on home and profile pages", async () => {
    const resHomeRu = renderHomePage(mockEnv, "ru");
    const htmlHomeRu = await resHomeRu.text();
    expect(htmlHomeRu).toContain('id="supportSection"');
    expect(htmlHomeRu).toContain("Остались вопросы? Напишите нам");
    expect(htmlHomeRu).toContain('id="supportContact"');
    expect(htmlHomeRu).toContain('id="supportMessage"');
    expect(htmlHomeRu).toContain('id="supportSubmitBtn"');

    const resHomeEn = renderHomePage(mockEnv, "en");
    const htmlHomeEn = await resHomeEn.text();
    expect(htmlHomeEn).toContain('id="supportSection"');
    expect(htmlHomeEn).toContain("Have questions? Contact us");
    expect(htmlHomeEn).toContain("Telegram @username or email (optional)");

    const resProfRu = renderProfilePage(mockEnv, "zuck", null, null, "ru");
    const htmlProfRu = await resProfRu.text();
    expect(htmlProfRu).toContain('id="supportSection"');
    expect(htmlProfRu).toContain("Остались вопросы? Напишите нам");
  });

  it("handles /api/support endpoint validations", async () => {
    const worker = (await import("../src/index")).default;
    const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;

    // Too short message
    const reqShort = new Request("https://site.com/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const resShort = await worker.fetch(reqShort, mockEnv, fakeCtx);
    expect(resShort.status).toBe(400);

    // Empty body
    const reqEmpty = new Request("https://site.com/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resEmpty = await worker.fetch(reqEmpty, mockEnv, fakeCtx);
    expect(resEmpty.status).toBe(400);
  });

  it("renders popular creators and favorites on home page", async () => {
    const res = renderHomePage(mockEnv, "ru");
    const html = await res.text();
    expect(html).toContain("Популярные авторы");
    expect(html).toContain("/@durov");
    expect(html).toContain("/@zuck");
    expect(html).toContain("/@mrbeast");
    expect(html).toContain('id="favoritesSection"');
    expect(html).toContain("Закладки");
  });

  it("renders single thread view with rich OpenGraph tags and post highlighting", async () => {
    const data = {
      profile: {
        username: "zuck",
        displayName: "Mark Zuckerberg",
        bio: "Building Meta",
        avatar: "https://scontent.cdninstagram.com/avatar.jpg",
        followers: "15M",
        verified: true,
      },
      posts: [
        {
          id: "post_101",
          text: "Excited to launch our newest AI model today across all platforms!",
          has_image: true,
          has_video: false,
          imageUrl: "https://scontent.cdninstagram.com/post_101.jpg",
          date: "1h",
          author: "zuck",
        },
      ],
    };

    const res = renderProfilePage(mockEnv, "zuck", data, null, "ru", false, "RU", "post_101", "https://threads-viewer.com");
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="@zuck: &quot;Excited to launch our newest AI model today across all platforms!&quot;">');
    expect(html).toContain('<meta property="og:description" content="Excited to launch our newest AI model today across all platforms!">');
    expect(html).toContain('content="https://threads-viewer.com/api/img?url=https%3A%2F%2Fscontent.cdninstagram.com%2Fpost_101.jpg"');
    expect(html).toContain('post-highlighted');
    expect(html).toContain('id="post-post_101"');
    expect(html).toContain('id="favToggleBtn"');
    expect(html).toContain('start=track_zuck');
  });

  it("contains syntactically valid JavaScript scripts on profile and home pages", async () => {
    const pages = [
      renderProfilePage(mockEnv, "zuck", null, null, "ru"),
      renderProfilePage(mockEnv, "zuck", { profile: { username: "zuck", displayName: "Mark", bio: "Bio", avatar: "https://example.com/a.jpg", followers: "10M", verified: true }, posts: [] }, null, "ru"),
      renderHomePage(mockEnv, "ru"),
      renderHomePage(mockEnv, "en"),
    ];

    for (const res of pages) {
      const html = await res.text();
      const matches = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
      expect(matches.length).toBeGreaterThan(0);
      for (const scriptTag of matches) {
        const code = scriptTag.replace(/<\/?script>/g, "");
        expect(() => new Function(code)).not.toThrow();
      }
    }
  });

  describe("Anonymous Creator Tracking", () => {
    it("enforces free vs premium limits for tracking", async () => {
      const { Database } = await import("../src/db");
      const fakeDb = {
        prepare: (q: string) => ({
          bind: (..._args: any[]) => ({
            first: async () => {
              if (q.includes("FROM subscriptions")) return null; // free user
              if (q.includes("COUNT(*) c FROM user_tracks")) return { c: 0 };
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
        batch: async () => [],
      };
      const db = new Database({ DB: fakeDb as any } as any);
      const freeRes = await db.addTrack(12345, "zuck");
      expect(freeRes.ok).toBe(false);
      expect(freeRes.error).toBe("free_limit");
    });
  });

  describe("Image Proxy Security", () => {
    it("rejects missing url parameter", async () => {
      const req = new Request("https://worker.dev/api/img");
      const res = await handleImageProxy(req);
      expect(res.status).toBe(400);
    });

    it("rejects forbidden SSRF hostnames", async () => {
      const req = new Request("https://worker.dev/api/img?url=https://internal-service.local/secret");
      const res = await handleImageProxy(req);
      expect(res.status).toBe(403);
    });

    it("accepts valid Instagram CDN hostnames", async () => {
      const req = new Request("https://worker.dev/api/img?url=https://scontent.cdninstagram.com/notfound.jpg");
      const res = await handleImageProxy(req);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(400);
    });
  });
});
