import { describe, expect, it } from "vitest";
import {
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

describe("Web Viewer SSR & Routing", () => {
  it("renders homepage with Russian copy and search elements", async () => {
    const res = renderHomePage(mockEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Threads Viewer");
    expect(html).toContain("Читайте Threads без VPN");
    expect(html).toContain("heroSearchInput");
    expect(html).toContain("@durov");
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

    const res = renderProfilePage(mockEnv, "testuser", initialData);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Check escaping
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("@testuser");
    expect(html).toContain("First post text &lt;alert&gt;");
    expect(html).toContain("https://scontent.cdninstagram.com/pic.jpg");
    expect(html).toContain("post-mention");
  });

  it("renders terms and privacy policy pages", async () => {
    const termsRes = renderTermsPage();
    expect(termsRes.status).toBe(200);
    expect(await termsRes.text()).toContain("Пользовательское соглашение");

    const privRes = renderPrivacyPage();
    expect(privRes.status).toBe(200);
    expect(await privRes.text()).toContain("Политика конфиденциальности");
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
      // It will attempt fetch; we test host validation
      const req = new Request("https://worker.dev/api/img?url=https://scontent.cdninstagram.com/notfound.jpg");
      const res = await handleImageProxy(req);
      // It is allowed host, so status won't be 403 or 400 (it may be upstream error or 502 in test)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(400);
    });
  });
});
