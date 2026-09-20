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
