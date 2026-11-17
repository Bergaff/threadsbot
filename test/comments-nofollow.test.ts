import { describe, expect, it } from "vitest";
import { renderProfilePage } from "../src/web";
import type { Env } from "../src/config";

const env: Env = {
  DB: {} as any,
  BROWSER: {} as any,
  UPDATES: {} as any,
  TELEGRAM_TOKEN: "1:A",
  CRYPTO_BOT_TOKEN: "x",
  WEBHOOK_SECRET: "s",
  ADMIN_IDS: "1",
  BASE_URL: "https://www.threads.com",
  SITE_URL: "https://threadsviewer.online",
  SITE_DOMAIN: "threadsviewer.online",
};

/** Достаёт из страницы клиентские escHtml + formatPostTextClient и исполняет их. */
async function clientFormatter(): Promise<(text: string, ugc?: boolean) => string> {
  const html = await renderProfilePage(env, "zuck", null, null, "ru").text();
  const start = html.indexOf("function escHtml(");
  const end = html.indexOf("function toggleComments(");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const src = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(src + "; return formatPostTextClient;")();
}

describe("pr90: ссылки из комментариев закрыты от обхода", () => {
  it("ссылка на автора комментария помечена rel=nofollow ugc", async () => {
    const html = await renderProfilePage(env, "zuck", null, null, "ru").text();
    expect(html).toMatch(/rel="nofollow ugc" class="comment-author-name"/);
    expect(html).toContain("formatPostTextClient(c.text || '', true)");
  });

  it("упоминания и ссылки в тексте комментария - nofollow ugc", async () => {
    const fmt = await clientFormatter();
    const out = fmt("привет @bob смотри https://example.com/x", true);
    expect(out).toContain('<a href="/@bob" rel="nofollow ugc" class="post-mention">@bob</a>');
    expect(out).toContain('rel="nofollow ugc noopener noreferrer" class="post-link"');
  });

  it("в тексте постов и био ссылки остаются обычными", async () => {
    const fmt = await clientFormatter();
    const out = fmt("привет @bob https://example.com/x");
    expect(out).toContain('<a href="/@bob" class="post-mention">@bob</a>');
    expect(out).not.toContain("nofollow");
  });
});
