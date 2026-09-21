import type { BrowserContext, Page } from "@cloudflare/playwright";
import { LIMITS, type Env } from "./config";
import { diagnoseAccountCookies, playwrightCookies, snapshotHasSession } from "./cookies";
import { isLoginUrl, isUserNotFoundPage } from "./profile";
import { cleanPostText } from "./i18n";

export {
  diagnoseAccountCookies,
  earliestCookieExpiry,
  hasKeyCookies,
  normalizeCookiesJson,
  parseThreadsUsername,
  validateCookiesJson,
} from "./cookies";
export type { AccountDiagnosis } from "./cookies";

export interface Post {
  id?: string;
  text: string;
  has_image: boolean;
  has_video: boolean;
  videoUrl?: string;
  image?: Uint8Array;
  imageUrl?: string;
  images?: string[];
  postUrl?: string;
  likes?: string;
  replies?: string;
  date?: string;
  author?: string;
  authorAvatar?: string;
}

export interface ProfileMeta {
  username: string;
  displayName: string;
  bio: string;
  avatar: string;
  followers: string;
  verified: boolean;
}

export interface ProfileData {
  profile: ProfileMeta;
  posts: Post[];
}

export interface Comment { author: string; text: string; avatar?: string; top?: number }
export type ThreadsStatus = "ok" | "user_not_found" | "session_expired" | "no_posts" | "post_not_found" | "all_dead" | "browser_busy" | "service_error";
type Account = { name: string; cookies: string; hourly_requests: number; hourly_reset: string };
type Opened = { browser: any; context: BrowserContext; page: Page; startedAt: number };

const FREE_BROWSER_INTERVAL_MS = 3_000;
const BASE = (env: Env) => env.BASE_URL || "https://www.threads.com";
const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class BrowserBusyError extends Error {}

// ============================
// BROWSER
// ============================

function cookieList(raw: string): any[] {
  return playwrightCookies(raw);
}

async function addAccountCookies(context: BrowserContext, raw: string) {
  const cookies = cookieList(raw) as Parameters<BrowserContext["addCookies"]>[0];
  try {
    await context.addCookies(cookies);
    return;
  } catch (first) {
    let added = 0;
    for (const cookie of cookies) {
      try { await context.addCookies([cookie]); added++; } catch { /* skip one bad cookie */ }
    }
    if (!added) throw first;
  }
}

function keepSessionCookies(raw: string): string | null {
  return snapshotHasSession(raw) ? raw : null;
}

export async function logSystem(env: Env, level: "info" | "warn" | "error", category: string, message: string) {
  try {
    const data = `[${level.toUpperCase()}][${category}] ${message}`;
    await env.DB.prepare(
      "INSERT INTO user_events(user_id, event_type, event_data, timestamp) VALUES(0, 'system_log', ?, ?)"
    ).bind(data, iso()).run();
  } catch (e) {
    console.error("Failed to write system log:", e);
  }
}

async function logBrowser(env: Env, type: string, data = "") {
  await env.DB.prepare("INSERT INTO user_events(user_id,event_type,event_data,timestamp) VALUES(0,?,?,?)").bind(type, data, iso()).run().catch(() => {});
}

async function waitForBrowserSlot(env: Env) {
  const row = await env.DB.prepare("SELECT value FROM bot_state WHERE scope='system' AND state_key='browser_next_launch'").first<{ value: string }>();
  const wait = Math.min(Math.max(0, Number(row?.value || 0) - Date.now()), 4_000);
  if (wait > 0) await sleep(wait);
  const next = String(Date.now() + FREE_BROWSER_INTERVAL_MS);
  await env.DB.prepare("INSERT INTO bot_state(scope,state_key,value,updated_at) VALUES('system','browser_next_launch',?,?) ON CONFLICT(scope,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(next, iso()).run();
}

function isBrowserRateLimit(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.includes("429") || /rate limit|too many requests/i.test(value);
}

async function openBrowser(env: Env, account: Account): Promise<Opened> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForBrowserSlot(env);
    await logBrowser(env, "browser_launch");
    let browser: any;
    try {
      const { launch } = await import("@cloudflare/playwright");
      browser = await launch(env.BROWSER);
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 680, height: 900 },
      });
      const page = await context.newPage();
      // Открываем домен, прикрепляем куки, перезагружаем для синхронизации сессии в Meta
      await page.goto(`${BASE(env)}/`, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await sleep(500);
      await addAccountCookies(context, account.cookies);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await sleep(800);
      return { browser, context, page, startedAt: Date.now() };
    } catch (error) {
      await browser?.close().catch(() => {});
      if (!isBrowserRateLimit(error)) throw error;
      await logBrowser(env, "browser_429");
      if (attempt === 1) throw new BrowserBusyError("Cloudflare Browser Run rate limit");
      await sleep(FREE_BROWSER_INTERVAL_MS);
    }
  }
  throw new BrowserBusyError("Cloudflare Browser Run is busy");
}

async function closeBrowser(env: Env, opened?: Opened) {
  if (!opened) return;
  await opened.browser.close().catch(() => {});
  await logBrowser(env, "browser_seconds", String((Date.now() - opened.startedAt) / 1000));
}

// ============================
// СБОР ПОСТОВ И КОММЕНТАРИЕВ
// ============================

async function collectPosts(page: Page, target = 20): Promise<Post[]> {
  const all: Post[] = [], seen = new Set<string>();
  let stall = 0;
  for (let i = 0; i < 10; i++) {
    const evaluated = await page.evaluate(() => {
      const posts: {
        text: string;
        has_image: boolean;
        has_video: boolean;
        videoUrl?: string;
        imageUrl?: string;
        images?: string[];
        postUrl?: string;
        likes?: string;
        replies?: string;
        date?: string;
        author?: string;
        authorAvatar?: string;
      }[] = [];
      const seen = new Set<string>();

      // Поиск предзагруженного Relay JSON в тегах script для точных метрик и видео
      const relayMap = new Map<string, { likes?: string; replies?: string; videoUrl?: string; imageUrl?: string }>();
      try {
        const jsonScripts = document.querySelectorAll('script[type="application/json"]');
        jsonScripts.forEach(script => {
          const raw = script.textContent || "";
          if (raw.includes("like_count") || raw.includes("video_versions") || raw.includes("direct_reply_count") || raw.includes("text_post_app_info")) {
            try {
              const parsed = JSON.parse(raw);
              function traverse(node: any) {
                if (!node || typeof node !== "object") return;
                if (node.caption && typeof node.caption.text === "string") {
                  const key = node.caption.text.trim().substring(0, 60);
                  const l = node.like_count !== undefined ? String(node.like_count) : "";
                  const r = (node.text_post_app_info && node.text_post_app_info.direct_reply_count !== undefined)
                    ? String(node.text_post_app_info.direct_reply_count)
                    : (node.comment_count !== undefined ? String(node.comment_count) : "");
                  const v = (node.video_versions && node.video_versions.length > 0) ? node.video_versions[0].url : "";
                  const img = node.image_versions2?.candidates?.[0]?.url || "";
                  if (key && !relayMap.has(key)) {
                    relayMap.set(key, { likes: l, replies: r, videoUrl: v, imageUrl: img });
                  }
                }
                if (Array.isArray(node)) {
                  for (let idx = 0; idx < node.length; idx++) traverse(node[idx]);
                } else {
                  for (const k of Object.keys(node)) {
                    if (typeof node[k] === "object") traverse(node[k]);
                  }
                }
              }
              traverse(parsed);
            } catch (e) {}
          }
        });
      } catch (e) {}

      const containers = document.querySelectorAll('div[data-pressable-container="true"],article,div[role="article"]');
      for (let cIdx = 0; cIdx < containers.length; cIdx++) {
        const container = containers[cIdx];

        // Находим родительскую карточку поста, чтобы захватить кнопки действий (лайки, ответы)
        let root: HTMLElement = container as HTMLElement;
        let parent = container.parentElement;
        for (let d = 0; d < 3 && parent; d++) {
          if (parent.querySelector('svg[aria-label*="Like" i], svg[aria-label*="Нравится" i], svg[aria-label*="Reply" i], svg[aria-label*="Ответить" i], svg[aria-label*="Repost" i]')) {
            root = parent;
            break;
          }
          parent = parent.parentElement;
        }

        let bestText = "";
        let has_image = false;
        let has_video = false;
        let videoUrl = "";
        const imgList: string[] = [];

        try {
          const imgs = root.querySelectorAll('img[src*="cdninstagram.com"],img[src*="fbcdn.net"]');
          for (let imgIdx = 0; imgIdx < imgs.length; imgIdx++) {
            const node = imgs[imgIdx] as HTMLImageElement;
            const src = node.currentSrc || node.src;
            if ((node.naturalWidth || node.width || 0) > 150 || (src && !src.includes("s150x150") && !src.includes("s50x50") && !node.alt?.includes("profile picture"))) {
              has_image = true;
              if (src && !imgList.includes(src)) imgList.push(src);
            }
          }
        } catch (e) {}

        try {
          const vid = (root.querySelector("video") || container.querySelector("video")) as HTMLVideoElement | null;
          if (vid) {
            has_video = true;
            const vSrc = vid.currentSrc || vid.src || vid.querySelector("source")?.src || vid.getAttribute("data-src") || "";
            if (vSrc && !vSrc.startsWith("blob:")) {
              videoUrl = vSrc;
            }
          }
          if (!has_video) {
            has_video = root.querySelectorAll('video,div[role="button"] svg[aria-label*="video" i],div[role="button"] svg[aria-label="Play" i],svg[aria-label*="видео" i]').length > 0;
          }
        } catch (e) {}

        let postUrl = "";
        try {
          const pLink = (root.querySelector('a[href*="/post/"]') || container.querySelector('a[href*="/post/"]')) as HTMLAnchorElement | null;
          if (pLink) postUrl = pLink.getAttribute("href") || "";
        } catch (e) {}

        let author = "";
        try {
          const authorLink = root.querySelector('a[href^="/@"][role="link"], a[href^="/@"]');
          if (authorLink) {
            const m = (authorLink.getAttribute("href") || "").match(/\/@([A-Za-z0-9._]+)/);
            if (m) author = m[1];
          }
        } catch (e) {}

        let authorAvatar = "";
        try {
          const imgs = root.querySelectorAll("img");
          for (let aIdx = 0; aIdx < imgs.length; aIdx++) {
            const alt = (imgs[aIdx].getAttribute("alt") || "").toLowerCase();
            const src = imgs[aIdx].currentSrc || imgs[aIdx].src || "";
            if (alt.includes("profile picture") || alt.includes("фото профиля")) {
              authorAvatar = src;
              break;
            }
          }
        } catch (e) {}

        let date = "";
        try {
          const timeEl = root.querySelector("time") || container.querySelector("time");
          if (timeEl) {
            const rawDt = (timeEl.getAttribute("datetime") || timeEl.innerText || "").trim();
            // Убираем букву T и секунды/Z: 2026-09-15T23:01:39.000Z -> 2026-09-15 23:01
            date = rawDt.replace(/T/g, " ").replace(/:\d{2}(?:\.\d+)?Z$/i, "").replace(/Z$/i, "").trim();
          }
        } catch (e) {}

        let likes = "";
        let replies = "";

        // Хелпер извлечения числовых показателей из элементов и спанов
        function extractCount(el: Element | null): string {
          if (!el) return "";
          const list: Element[] = [el, ...Array.from(el.querySelectorAll("span.x1o0tod, span, div"))];
          for (let idx = 0; idx < list.length; idx++) {
            const val = (list[idx].textContent || "").replace(/[\u00a0\s]/g, " ").trim();
            if (/^\d[\d.,\s]*(?:[kkmм]|тыс\.?|млн\.?)?$/i.test(val)) {
              return val;
            }
          }
          return "";
        }

        function findNear(svg: Element): string {
          const btn = svg.closest('div[role="button"], button') || svg.parentElement;
          if (btn) {
            const c = extractCount(btn);
            if (c) return c;
            if (btn.nextElementSibling) {
              const nc = extractCount(btn.nextElementSibling);
              if (nc) return nc;
            }
          }
          let sib = svg.nextElementSibling;
          for (let d = 0; d < 3 && sib; d++) {
            const sc = extractCount(sib);
            if (sc) return sc;
            sib = sib.nextElementSibling;
          }
          return "";
        }

        // Сканирование всех SVG карточки на предмет лайков и ответов (по title, <title>, aria-label и path)
        try {
          const allSvgs = root.querySelectorAll("svg");
          for (let s = 0; s < allSvgs.length; s++) {
            const svg = allSvgs[s];
            const title = (svg.getAttribute("title") || svg.querySelector("title")?.textContent || "").toLowerCase();
            const aria = (svg.getAttribute("aria-label") || "").toLowerCase();
            const pathD = svg.querySelector("path")?.getAttribute("d") || "";

            // Лайки: "Поставить "Нравится"", "Like", или путь сердечка Meta
            const isLike = title.includes("нравится") || title.includes("like") || aria.includes("нравится") || aria.includes("like") || pathD.includes("M16.5 2") || pathD.includes("10.811 13.272") || pathD.includes("12 20.876");
            if (isLike && !likes) {
              const found = findNear(svg);
              if (found) likes = found;
            }

            // Ответы/Комментарии: "Ответ", "Reply", "коммент", или путь реплики Meta
            const isReply = title.includes("ответ") || title.includes("reply") || aria.includes("ответ") || aria.includes("reply") || title.includes("коммент") || aria.includes("коммент") || pathD.includes("M12 3a9 9") || pathD.includes("4.206.752") || pathD.includes("5.312-.95");
            if (isReply && !replies) {
              const found = findNear(svg);
              if (found) replies = found;
            }
          }
        } catch (e) {}

        // 2. Строка активности под постом (например, "15 ответов · 342 отметки «Нравится»")
        const rootText = ((root as HTMLElement).innerText || root.textContent || "").replace(/[\u00a0\s]+/g, " ");

        if (!replies) {
          const rMatch = rootText.match(/(\d[\d.,\s]*(?:[kkmм]|тыс\.?|млн\.?)?)\s*(?:replies|reply|ответов|ответа|ответ\b)/i);
          if (rMatch) replies = rMatch[1].trim();
        }

        if (!likes) {
          const lMatch = rootText.match(/(\d[\d.,\s]*(?:[kkmм]|тыс\.?|млн\.?)?)\s*(?:likes|like|отметок|отметки|отметка|нравится)\b/i);
          if (lMatch) likes = lMatch[1].trim();
        }

        // 3. Ссылки на ветку поста
        if (!replies) {
          try {
            const links = root.querySelectorAll('a[href*="/post/"]');
            for (let l = 0; l < links.length; l++) {
              const txt = (links[l].textContent || "").replace(/[\u00a0\s]+/g, " ").trim();
              const m = txt.match(/(\d[\d.,\s]*(?:[kkmм]|тыс\.?|млн\.?)?)\s*(?:replies|reply|ответов|ответа)/i);
              if (m) { replies = m[1].trim(); break; }
            }
          } catch (e) {}
        }

        try {
          const spans = container.querySelectorAll('span[dir="auto"],div[dir="auto"],span[class*="x1lliihq"]');
          for (let sIdx = 0; sIdx < spans.length; sIdx++) {
            const text = ((spans[sIdx] as HTMLElement).innerText || "").trim();
            if (text.length < 5) continue;
            if (/^(Follow|Подписаться|Translate|Перевести|See translation|See more|Like|Reply|Repost|Share|Verified|Автор|Ещё|Нравится|Поделиться)/i.test(text)) continue;
            if (/^\d+$/.test(text) || /^\d{1,2}\s*[hчдms]$/i.test(text)) continue;
            if (text.length > bestText.length) bestText = text;
          }
        } catch (e) {}

        // Сопоставление с данными Relay
        if (bestText) {
          const rData = relayMap.get(bestText.substring(0, 60));
          if (rData) {
            if (!likes && rData.likes) likes = rData.likes;
            if (!replies && rData.replies) replies = rData.replies;
            if (!videoUrl && rData.videoUrl) { videoUrl = rData.videoUrl; has_video = true; }
            if (!imgList.length && rData.imageUrl) { imgList.push(rData.imageUrl); has_image = true; }
          }
        }

        if (bestText.length > 3 || has_image || has_video) {
          const key = bestText.substring(0, 100) + (has_image ? "_img" : "") + (has_video ? "_vid" : "");
          if (!seen.has(key)) {
            seen.add(key);
            posts.push({
              text: bestText,
              has_image,
              has_video,
              videoUrl: videoUrl || undefined,
              imageUrl: imgList[0],
              images: imgList,
              postUrl,
              author,
              authorAvatar,
              date,
              likes,
              replies,
            });
          }
        }
      }
      return posts;
    }) as unknown;
    if (!Array.isArray(evaluated)) throw new Error("Threads returned an invalid posts collection");
    const current = evaluated as Post[];
    let added = 0;
    for (const post of current) {
      if (!post || typeof post.text !== "string") continue;
      const value = { ...post, text: cleanPostText(post.text) };
      if (value.text.length < 3 && !value.has_image && !value.has_video) continue;
      const key = value.text.slice(0, 120) + (value.has_image ? "_img" : "") + (value.has_video ? "_vid" : "");
      if (!seen.has(key)) { seen.add(key); all.push(value); added++; }
    }
    if (all.length >= target) break;
    stall = added ? 0 : stall + 1;
    if (stall >= 1 && all.length > 0) break;
    if (stall >= 2) break;
    await page.evaluate(() => window.scrollBy(0, 1100));
    await sleep(700);
  }
  return all.slice(0, target);
}

async function checkProfile(page: Page, env: Env, username: string): Promise<ThreadsStatus | null> {
  const targetUrl = `${BASE(env)}/@${username}`;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await sleep(1800);
  const currentUrl = page.url();
  if (isLoginUrl(currentUrl)) {
    // Несуществующий @username часто редиректит на /login.
    // Проверяем главную — если там залогинены, профиль просто не существует.
    await page.goto(`${BASE(env)}/`, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    await sleep(1000);
    if (isLoginUrl(page.url())) return "session_expired";
    return "user_not_found";
  }

  const hasContent = await page.evaluate(() => {
    return Boolean(
      document.querySelector('div[data-pressable-container="true"],article,div[role="article"]') ||
      document.querySelector('header')
    );
  }).catch(() => false);

  if (!hasContent) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (isUserNotFoundPage(body)) return "user_not_found";
  }
  return null;
}

async function chooseAccount(env: Env, tried: string[]): Promise<Account | null> {
  const cutoff = new Date(Date.now() - 3_600_000).toISOString();
  await env.DB.prepare("UPDATE threads_accounts SET hourly_requests=0,hourly_reset=? WHERE hourly_reset<?").bind(iso(), cutoff).run();
  const marks = tried.map(() => "?").join(",");
  const query = `SELECT name,cookies,hourly_requests,hourly_reset FROM threads_accounts WHERE enabled=1 AND is_alive=1 AND hourly_requests<?${tried.length ? ` AND name NOT IN (${marks})` : ""} ORDER BY hourly_requests ASC,RANDOM() LIMIT 1`;
  return env.DB.prepare(query).bind(LIMITS.accountHourly, ...tried).first<Account>();
}

async function markSuccess(env: Env, name: string, posts = 0, updatedCookies?: string) {
  await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,requests_count=requests_count+1,posts_sent=posts_sent+?,hourly_requests=hourly_requests+1,last_used=?,updated_at=?,cookies=COALESCE(?,cookies) WHERE name=?").bind(posts, iso(), iso(), updatedCookies || null, name).run();
}
async function markSessionExpired(env: Env, name: string) {
  await env.DB.prepare("UPDATE threads_accounts SET is_alive=0,last_error='Session expired',errors_count=errors_count+1,updated_at=? WHERE name=?").bind(iso(), name).run();
}
async function markTransientError(env: Env, name: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await env.DB.prepare("UPDATE threads_accounts SET last_error=?,errors_count=errors_count+1,updated_at=? WHERE name=?").bind(message, iso(), name).run();
}

async function capturePosts(page: Page, posts: Post[]): Promise<Post[]> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('div[role="dialog"]').forEach(e => e.remove());
    document.querySelectorAll("nav,header").forEach((e: any) => e.style.display = "none");
  });
  const result: Post[] = [];
  for (const post of posts) {
    try {
      const handle = await page.evaluateHandle((search: string) => {
        let nodes = Array.from(document.querySelectorAll('article,div[role="article"]'));
        if (!nodes.length) nodes = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
        return nodes.find(node => Array.from(node.querySelectorAll('span[dir="auto"],div[dir="auto"]')).some((b: any) => (b.innerText || "").trim().startsWith(search))) || null;
      }, post.text.slice(0, 50));
      const element = handle.asElement();
      if (element) {
        await element.scrollIntoViewIfNeeded();
        const shot = await element.screenshot({ type: "png" });
        result.push({ ...post, image: new Uint8Array(shot) });
      }
      await handle.dispose();
    } catch { /* one failed screenshot must not fail the whole request */ }
  }
  return result;
}

async function collectProfileHeader(page: Page, fallbackUsername: string): Promise<ProfileMeta> {
  return await page.evaluate((uname) => {
    let displayName = uname;
    let bio = "";
    let avatar = "";
    let followers = "";
    let verified = false;

    // Avatar
    try {
      const imgs = document.querySelectorAll("header img, img");
      for (let i = 0; i < imgs.length; i++) {
        const el = imgs[i] as HTMLImageElement;
        const alt = (el.getAttribute("alt") || "").toLowerCase();
        const src = el.currentSrc || el.src || "";
        if (src && !src.includes("data:") && (alt.includes("profile picture") || alt.includes("фото профиля") || alt.includes(uname.toLowerCase()) || (el.naturalWidth || el.width || 0) > 30)) {
          if (!src.includes("s150x150") && !src.includes("s50x50")) {
            avatar = src;
            break;
          }
        }
      }
    } catch (e) {}

    // Display Name
    try {
      const h1 = document.querySelector('header h1, h1, header h2');
      if (h1 && (h1 as HTMLElement).innerText.trim()) {
        displayName = (h1 as HTMLElement).innerText.trim();
      }
    } catch (e) {}

    // Bio
    try {
      const bioCandidate = document.querySelector('header span[dir="auto"], header div[dir="auto"]');
      if (bioCandidate) {
        bio = (bioCandidate as HTMLElement).innerText.trim();
      }
    } catch (e) {}

    // Followers
    try {
      const headers = document.querySelectorAll('header span, header div');
      for (let i = 0; i < headers.length; i++) {
        const t = ((headers[i] as HTMLElement).innerText || "").trim();
        if (/(\d+[\d.,]*\s*(тыс\.|млн|k|m|followers|подписчик|seguidore))/i.test(t)) {
          followers = t;
          break;
        }
      }
    } catch (e) {}

    // Verified badge
    try {
      const svgs = document.querySelectorAll('header svg');
      for (let i = 0; i < svgs.length; i++) {
        const label = (svgs[i].getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("verified") || label.includes("подтверждено")) {
          verified = true;
          break;
        }
      }
    } catch (e) {}

    return {
      username: uname,
      displayName,
      bio,
      avatar,
      followers,
      verified,
    };
  }, fallbackUsername);
}

export async function fetchProfileWithPosts(
  env: Env,
  username: string,
  amount = 20
): Promise<{ data: ProfileData | null; status: ThreadsStatus; account?: string; error?: string }> {
  const tried: string[] = [];
  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) {
      await logSystem(env, "error", "scraper", `Все аккаунты недоступны (all_dead) для @${username}. Проверено: ${tried.join(", ") || "нет доступных"}`);
      return { data: null, status: "all_dead" };
    }
    tried.push(account.name);
    let opened: Opened | undefined;
    try {
      await logSystem(env, "info", "scraper", `Запуск сбора @${username} через аккаунт [${account.name}]`);
      opened = await openBrowser(env, account);

      const capturedVideos: string[] = [];
      opened.page.on("response", (resp) => {
        try {
          const u = resp.url();
          const ct = resp.headers()["content-type"] || "";
          if ((ct.startsWith("video/") || u.includes(".mp4")) && (u.includes("cdninstagram.com") || u.includes("fbcdn.net"))) {
            if (!capturedVideos.includes(u)) capturedVideos.push(u);
          }
        } catch {}
      });

      const invalid = await checkProfile(opened.page, env, username);
      if (invalid === "session_expired") {
        await logSystem(env, "warn", "scraper", `Сессия истекла у аккаунта [${account.name}] при запросе @${username}`);
        await markSessionExpired(env, account.name);
        continue;
      }
      if (invalid) {
        await logSystem(env, "warn", "scraper", `Проверка @${username} вернула статус: ${invalid} (аккаунт: ${account.name})`);
        return { data: null, status: invalid, account: account.name };
      }
      const profile = await collectProfileHeader(opened.page, username);
      const posts = await collectPosts(opened.page, amount);
      let vIdx = 0;
      for (const p of posts) {
        if (p.has_video && !p.videoUrl && vIdx < capturedVideos.length) {
          p.videoUrl = capturedVideos[vIdx++];
        }
      }
      const updated = keepSessionCookies(JSON.stringify(await opened.context.cookies()));
      await markSuccess(env, account.name, posts.length, updated || undefined);
      await logSystem(env, "info", "scraper", `Успешно загружен профиль @${username}: ${posts.length} постов через [${account.name}]`);
      return { data: { profile, posts }, status: "ok", account: account.name };
    } catch (error) {
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await logSystem(env, "error", "scraper", `Ошибка сбора @${username} (аккаунт: ${account.name}): ${errMsg}`);
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      return { data: null, status: "service_error", account: account.name, error: errMsg };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}

export async function fetchPosts(env: Env, username: string, mode: "text" | "img", amount = 20): Promise<{ data: Post[] | null; status: ThreadsStatus; account?: string; error?: string }> {
  const tried: string[] = [];
  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) return { data: null, status: "all_dead" };
    tried.push(account.name);
    let opened: Opened | undefined;
    try {
      opened = await openBrowser(env, account);
      const invalid = await checkProfile(opened.page, env, username);
      if (invalid === "session_expired") { await markSessionExpired(env, account.name); continue; }
      if (invalid) return { data: null, status: invalid, account: account.name };
      let data = await collectPosts(opened.page, amount);
      if (!data.length) return { data: null, status: "no_posts", account: account.name };
      if (mode === "img") data = await capturePosts(opened.page, data);
      const updated = keepSessionCookies(JSON.stringify(await opened.context.cookies()));
      await markSuccess(env, account.name, data.length, updated || undefined);
      return { data, status: "ok", account: account.name };
    } catch (error) {
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      return { data: null, status: "service_error", account: account.name, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}

async function collectComments(page: Page, target = 20): Promise<Comment[]> {
  const result: Comment[] = [], seen = new Set<string>();
  let stall = 0;
  await sleep(1500);
  for (let attempt = 0; attempt < 8; attempt++) {
    const evaluated = await page.evaluate(() => {
      const out: any[] = [];
      const containers = document.querySelectorAll('div[data-pressable-container="true"]');
      for (let cIdx = 0; cIdx < containers.length; cIdx++) {
        const container = containers[cIdx];
        const top = (container as HTMLElement).getBoundingClientRect().top + window.scrollY;
        let author = "—";
        try {
          const link = container.querySelector('a[href^="/@"]');
          const match = (link?.getAttribute("href") || "").match(/\/@([A-Za-z0-9._]+)/);
          if (match) author = "@" + match[1].toLowerCase();
        } catch (e) {}

        let avatar = "";
        try {
          const imgs = container.querySelectorAll("img");
          for (let i = 0; i < imgs.length; i++) {
            const alt = (imgs[i].getAttribute("alt") || "").toLowerCase();
            const src = imgs[i].currentSrc || imgs[i].src || "";
            if (alt.includes("profile picture") || alt.includes("фото профиля") || src.includes("cdninstagram.com")) {
              avatar = src;
              break;
            }
          }
        } catch (e) {}

        let text = "";
        try {
          const spans = container.querySelectorAll('span[dir="auto"]');
          for (let sIdx = 0; sIdx < spans.length; sIdx++) {
            const span = spans[sIdx];
            const value = ((span as HTMLElement).innerText || span.textContent || "").trim();
            if (!value || value.length < 3 || value.toLowerCase() === author.replace("@", "") || /^(Follow|Подписаться|Translate|Перевести|Reply|Ответ|Repost|Share|Send|Like|More|Verified|See translation|Автор|Author|Ещё|Нравится|Поделиться)$/i.test(value) || /^\d+$/.test(value) || /^\d+\s*[hHчмсmsdд]$/.test(value)) continue;
            if (value.length > text.length) text = value;
          }
        } catch (e) {}

        if (text && /[A-Za-zА-Яа-яÀ-ÿ\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff]/.test(text)) {
          out.push({ author, text, avatar, top });
        }
      }
      out.sort((a, b) => a.top - b.top);
      return out.slice(1);
    }) as unknown;
    if (!Array.isArray(evaluated)) throw new Error("Threads returned an invalid comments collection");
    let added = 0;
    for (const comment of evaluated as Comment[]) {
      if (!comment || typeof comment.text !== "string") continue;
      comment.text = cleanPostText(comment.text);
      const key = (comment.author + "|" + comment.text.slice(0, 120)).toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(comment); added++; }
    }
    result.sort((a, b) => (a.top || 0) - (b.top || 0));
    if (result.length >= target) break;
    stall = added ? 0 : stall + 1;
    if (stall >= 2) break;
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(1000);
  }
  return result.slice(0, target);
}

export async function fetchComments(env: Env, username: string, index: number, amount = 20): Promise<{ data: Comment[] | null; status: ThreadsStatus; account?: string; error?: string }> {
  const tried: string[] = [];
  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) return { data: null, status: "all_dead" };
    tried.push(account.name);
    let opened: Opened | undefined;
    try {
      opened = await openBrowser(env, account);
      const invalid = await checkProfile(opened.page, env, username);
      if (invalid === "session_expired") { await markSessionExpired(env, account.name); continue; }
      if (invalid) return { data: null, status: invalid, account: account.name };
      const posts = await collectPosts(opened.page, index + 3);
      if (index >= posts.length) return { data: null, status: "post_not_found", account: account.name };
      const search = posts[index].text.slice(0, 50);
      const href = await opened.page.evaluate((value: string) => {
        const nodes = Array.from(document.querySelectorAll('article,div[role="article"],div[data-pressable-container="true"]'));
        for (const post of nodes) {
          if (Array.from(post.querySelectorAll('span[dir="auto"],div[dir="auto"]')).some((b: any) => (b.innerText || "").trim().startsWith(value))) {
            return post.querySelector('a[href*="/post/"]')?.getAttribute("href") || null;
          }
        }
        return null;
      }, search);
      if (!href) return { data: null, status: "post_not_found", account: account.name };
      await opened.page.goto(href.startsWith("/") ? BASE(env) + href : href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(4000);
      await opened.page.evaluate(() => window.scrollBy(0, 800));
      const data = await collectComments(opened.page, amount);
      const updated = keepSessionCookies(JSON.stringify(await opened.context.cookies()));
      await markSuccess(env, account.name, data.length, updated || undefined);
      return { data, status: "ok", account: account.name };
    } catch (error) {
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      return { data: null, status: "service_error", account: account.name, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}
/** Сброс всех аккаунтов в alive=1 */
export async function resetAccountStatuses(env: Env) {
  const result = await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,updated_at=? WHERE enabled=1").bind(iso()).run();
  const count = Number(result.meta.changes || 0);
  await logSystem(env, "info", "admin", `Сброшены статусы всех аккаунтов в Alive. Обновлено аккаунтов: ${count}`);
  return count;
}

/** Проверка одного аккаунта */
export async function probeAccount(env: Env, name: string): Promise<{ name: string; ok: boolean; message: string }> {
  const account = await env.DB.prepare("SELECT name,cookies,hourly_requests,hourly_reset FROM threads_accounts WHERE name=? AND enabled=1").bind(name).first<Account>();
  if (!account) {
    await logSystem(env, "warn", "probe", `Тест [${name}]: аккаунт отключен или отсутствует в базе`);
    return { name, ok: false, message: "Аккаунт отключен или отсутствует в базе" };
  }
  let opened: Opened | undefined;
  try {
    await logSystem(env, "info", "probe", `Запуск теста сессии для [${name}] в браузере Threads...`);
    opened = await openBrowser(env, account);
    if (isLoginUrl(opened.page.url())) {
      await markSessionExpired(env, name);
      await logSystem(env, "error", "probe", `Тест [${name}] провален: сессия истекла (редирект на /login)`);
      return { name, ok: false, message: "Сессия истекла в Threads (редирект на /login)" };
    }
    const updated = keepSessionCookies(JSON.stringify(await opened.context.cookies()));
    if (updated) {
      await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,cookies=?,updated_at=? WHERE name=?").bind(updated, iso(), name).run();
    } else {
      await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,updated_at=? WHERE name=?").bind(iso(), name).run();
    }
    await logSystem(env, "info", "probe", `Тест [${name}] успешен: сессия действительна и активна`);
    return { name, ok: true, message: "Сессия валидна и активна" };
  } catch (error) {
    const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    await logSystem(env, "error", "probe", `Тест [${name}] ошибка: ${errMsg}`);
    await markTransientError(env, name, error);
    return { name, ok: false, message: error instanceof BrowserBusyError ? "Browser Run занят, повторите позже" : errMsg };
  } finally {
    await closeBrowser(env, opened);
  }
}

/** Автообновление cookies: открывает Threads, триггерит продление сессии в Meta и сохраняет свежие cookies в D1 */
export async function refreshAccountCookies(
  env: Env,
  name: string
): Promise<{ name: string; ok: boolean; message: string; expiry?: string; cookieCount?: number }> {
  const account = await env.DB.prepare(
    "SELECT name,cookies,hourly_requests,hourly_reset FROM threads_accounts WHERE name=? AND enabled=1"
  ).bind(name).first<Account>();
  if (!account) return { name, ok: false, message: "Аккаунт не найден или отключен" };

  let opened: Opened | undefined;
  try {
    opened = await openBrowser(env, account);
    if (isLoginUrl(opened.page.url())) {
      await markSessionExpired(env, name);
      return { name, ok: false, message: "Сессия уже истекла в Threads, требуется свежий логин" };
    }

    await opened.page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    await sleep(1000);

    const rawCookies = await opened.context.cookies();
    const updated = keepSessionCookies(JSON.stringify(rawCookies));
    if (!updated) {
      await markSessionExpired(env, name);
      return { name, ok: false, message: "Не удалось сохранить сессионные cookies" };
    }

    await env.DB.prepare(
      "UPDATE threads_accounts SET is_alive=1,last_error=NULL,cookies=?,updated_at=? WHERE name=?"
    ).bind(updated, iso(), name).run();

    const diagnosis = diagnoseAccountCookies(name, true, updated);
    return {
      name,
      ok: true,
      message: "Cookies успешно продлены в Meta и обновлены в D1",
      cookieCount: diagnosis.cookieCount,
      expiry: diagnosis.expiresAt ? new Date(diagnosis.expiresAt).toLocaleDateString("ru-RU") : undefined,
    };
  } catch (error) {
    await markTransientError(env, name, error);
    return {
      name,
      ok: false,
      message: error instanceof BrowserBusyError ? "Browser Run занят, повторите позже" : (error instanceof Error ? error.message : String(error)).slice(0, 200),
    };
  } finally {
    await closeBrowser(env, opened);
  }
}
