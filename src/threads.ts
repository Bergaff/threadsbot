import type { BrowserContext, Page } from "@cloudflare/playwright";
import { LIMITS, type Env } from "./config";
import { diagnoseAccountCookies, playwrightCookies, snapshotHasSession } from "./cookies";
import { FeedCollector, mergeDomWithFeed } from "./threadsFeed";
import { isAccountBlockedUrl, isLoginUrl, isProfileUrl, isThreadsHost, isUserNotFoundPage } from "./profile";
import { cleanPostText } from "./i18n";

export {
  diagnoseAccountCookies,
  earliestCookieExpiry,
  hasKeyCookies,
  normalizeCookiesJson,
  parseThreadsUsername,
  sessionCookieExpiry,
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
  /** Данные собраны из публичной HTML-разметки, а не через браузер. Постов может быть меньше. */
  partial?: boolean;
  /** Источник данных - для логов и отладки. */
  source?: "browser" | "http";
  /** Threads сам подтвердил (page_info.has_next_page=false), что лента автора закончилась. */
  endReached?: boolean;
}

export interface Comment { author: string; text: string; avatar?: string; top?: number }
export type ThreadsStatus = "ok" | "user_not_found" | "session_expired" | "no_posts" | "post_not_found" | "all_dead" | "browser_busy" | "service_error";
type Account = { name: string; cookies: string; hourly_requests: number; hourly_reset: string };
type Opened = { browser: any; context: BrowserContext; page: Page; startedAt: number };

const FREE_BROWSER_INTERVAL_MS = 3_000;
/** Эталонный публичный профиль для проверки живости сессии аккаунта-скрапера. */
const PROBE_USERNAME = "zuck";
const BASE = (env: Env) => env.BASE_URL || "https://www.threads.com";
const iso = () => new Date().toISOString();
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class BrowserBusyError extends Error {}

/** Детерминированный хеш FNV-1a. Нужен для стабильного фингерпринта аккаунта. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type Fingerprint = {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
};

const FP_OS = [
  "Windows NT 10.0; Win64; x64",
  "Windows NT 11.0; Win64; x64",
  "Macintosh; Intel Mac OS X 10_15_7",
  "Macintosh; Intel Mac OS X 13_5",
];
const FP_CHROME = [122, 124, 126, 128, 130];
/** Только те локали, для которых в детекторах есть и русские, и английские маркеры. */
const FP_LOCALE_TZ: Array<[string, string]> = [
  ["en-US", "America/New_York"],
  ["en-GB", "Europe/London"],
  ["ru-RU", "Europe/Moscow"],
  ["en-US", "Europe/Berlin"],
  ["en-US", "Asia/Singapore"],
];

/**
 * Стабильный фингерпринт на аккаунт.
 *
 * Одинаковый при каждом запуске для одного имени - иначе это выглядит как ферма ботов.
 * Разный между аккаунтами - иначе Meta связывает их в одну группу и после первого же
 * checkpoint банит пакетом. Раньше все аккаунты ходили с идентичным UA, viewport,
 * локалью и таймзоной, то есть совпадали по всем параметрам кроме куки.
 */
function fingerprintFor(name: string): Fingerprint {
  const h = fnv1a(name || "account");
  const os = FP_OS[h % FP_OS.length];
  const chrome = FP_CHROME[(h >>> 3) % FP_CHROME.length];
  const [locale, timezoneId] = FP_LOCALE_TZ[(h >>> 6) % FP_LOCALE_TZ.length];
  const width = 640 + ((h >>> 9) % 9) * 20;
  const height = 860 + ((h >>> 13) % 8) * 20;
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    viewport: { width, height },
    locale,
    timezoneId,
  };
}

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
    if (!env.DB?.prepare) return;
    const data = `[${level.toUpperCase()}][${category}] ${message}`;
    await env.DB.prepare(
      "INSERT INTO user_events(user_id, event_type, event_data, timestamp) VALUES(0, 'system_log', ?, ?)"
    ).bind(data, iso()).run();
  } catch (e) {
    console.error("Failed to write system log:", e);
  }
}

async function logBrowser(env: Env, type: string, data = "") {
  if (!env.DB?.prepare) return;
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
      const fp = fingerprintFor(account.name);
      const context = await browser.newContext({
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        locale: fp.locale,
        timezoneId: fp.timezoneId,
      });
      await addAccountCookies(context, account.cookies);
      const page = await context.newPage();
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

/** Прокрутка ленты: колесо мыши (на него реагирует IntersectionObserver ленты) + scroll как запасной путь. */
async function scrollFeed(page: Page, stall: number): Promise<void> {
  try { await (page as any).mouse.move(400, 500); } catch {}
  try { await (page as any).mouse.wheel(0, stall === 0 ? 1600 : 3200); } catch {}
  if (stall === 0) {
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  } else {
    // Небольшой откат вверх и снова вниз - «будит» подгрузку, если наблюдатель уже сработал
    await page.evaluate(() => window.scrollBy(0, -400)).catch(() => {});
    await sleep(250);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  }
}

/**
 * Подписывает страницу на сетевые ответы Threads (GraphQL), чтобы собирать посты
 * и page_info ленты автора. Вызывать ДО навигации на профиль.
 */
export function attachFeedCollector(page: Page, username: string): FeedCollector {
  const feed = new FeedCollector(username);
  page.on("response", (resp: any) => {
    try {
      const u: string = resp.url();
      if (!/\/(?:api\/)?graphql/i.test(u)) return;
      const ct = String(resp.headers()["content-type"] || "");
      if (ct && !/json|javascript|text/i.test(ct)) return;
      Promise.resolve(resp.text()).then((t: string) => { feed.ingestText(t); }).catch(() => {});
    } catch {}
  });
  return feed;
}

/** Предзагруженный JSON страницы (первая порция ленты и её page_info). */
async function ingestPreloadedJson(page: Page, feed: FeedCollector): Promise<void> {
  const blobs = await page.evaluate(() => {
    const out: string[] = [];
    let total = 0;
    document.querySelectorAll('script[type="application/json"]').forEach((el) => {
      const t = el.textContent || "";
      if (total > 6_000_000 || !t.includes("thread_items")) return;
      total += t.length;
      out.push(t);
    });
    return out;
  }).catch(() => [] as string[]);
  for (const b of blobs as string[]) feed.ingestText(b);
}

async function collectPosts(page: Page, target = 20, expectedUsername?: string, feed?: FeedCollector): Promise<Post[]> {
  const all: Post[] = [], seen = new Set<string>();
  let stall = 0;
  const cleanExpected = expectedUsername ? expectedUsername.toLowerCase().replace(/^@/, '') : '';
  if (feed) await ingestPreloadedJson(page, feed);
  const combined = () => (feed ? mergeDomWithFeed(all, feed.posts as Post[]) : all);
  let lastTotal = 0;
  // Чем больше постов нужно, тем больше раундов прокрутки (≈2-4 новых поста за раунд).
  const maxRounds = Math.min(60, Math.max(10, Math.ceil(target / 2) + 8));
  for (let i = 0; i < maxRounds; i++) {
    const evaluated = await page.evaluate((targetUname: string) => {
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
            if (m) author = m[1].toLowerCase();
          }
        } catch (e) {}

        // Если пост принадлежит другому автору и это не репост запрашиваемого автора,
        // то это блок рекомендаций / suggested posts / лента рекомендаций — пропускаем!
        if (targetUname && author && author !== targetUname) {
          const rootText = ((root as HTMLElement).innerText || "").toLowerCase();
          const isRepost = rootText.includes("repost") || rootText.includes("репост");
          if (!isRepost) {
            continue;
          }
        }

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
    }, cleanExpected) as unknown;
    if (!Array.isArray(evaluated)) throw new Error("Threads returned an invalid posts collection");
    const current = evaluated as Post[];
    let added = 0;
    for (const post of current) {
      if (!post || typeof post.text !== "string") continue;
      if (cleanExpected && post.author && post.author.toLowerCase() !== cleanExpected) {
        continue;
      }
      const value = { ...post, text: cleanPostText(post.text) };
      if (value.text.length < 3 && !value.has_image && !value.has_video) continue;
      const key = value.text.slice(0, 120) + (value.has_image ? "_img" : "") + (value.has_video ? "_vid" : "");
      if (!seen.has(key)) { seen.add(key); all.push(value); added++; }
    }
    void added;
    const total = combined().length;
    if (total >= target) break;
    stall = total > lastTotal ? 0 : stall + 1;
    lastTotal = total;
    // Threads сам сообщил, что дальше постов нет - крутить бессмысленно.
    if (feed && feed.hasNextPage === false && stall >= 1) break;
    // Без подтверждения от Threads сдаёмся только после 4 пустых раундов подряд
    // с нарастающим ожиданием: подгрузка порции может занимать несколько секунд.
    // Если Threads подтвердил, что посты ещё есть (has_next_page=true), ждём дольше:
    // по логам сбор сдавался на 10-14 постах при has_next_page=true.
    if (stall >= (feed && feed.hasNextPage === true ? 7 : 4)) break;
    await scrollFeed(page, stall);
    await sleep(stall === 0 ? 900 : 1200 + stall * 700);
  }
  return combined().slice(0, target);
}

/**
 * Вердикт проверки профиля.
 *
 * "ok"              - страница профиля отрендерилась
 * "session_expired" - сессия аккаунта мертва (редирект на /login или форма входа)
 * "user_not_found"  - ЕСТЬ положительное доказательство, что профиля не существует
 * "inconclusive"    - доказательств нет (таймаут навигации, about:blank, пустой DOM).
 *                     Это НЕ "профиль не найден" - нужно попробовать другой аккаунт.
 */
export type ProfileVerdict = "ok" | "user_not_found" | "session_expired" | "inconclusive";

const CONTENT_SELECTOR = 'div[data-pressable-container="true"],article,div[role="article"],header,div[role="banner"],main';

const LOGGED_OUT_MARKERS = [
  "log in with instagram",
  "log in to threads",
  "sign up with instagram",
  "войти через instagram",
  "войти с помощью instagram",
  "войти в threads",
  "зарегистрироваться через instagram",
];

function hasLoggedOutMarkers(text: string): boolean {
  const t = (text || "").toLowerCase();
  return LOGGED_OUT_MARKERS.some(m => t.includes(m));
}

async function checkProfile(page: Page, env: Env, username: string): Promise<ProfileVerdict> {
  const cleanUser = username.toLowerCase().replace(/^@/, "");
  const targetUrl = `${BASE(env)}/@${cleanUser}`;

  // Навигация с одной повторной попыткой. ВАЖНО: не глушим ошибку молча -
  // упавшая навигация оставляет about:blank, и раньше это превращалось в ложный user_not_found.
  let response: any = null;
  let navError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    navError = null;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: attempt === 0 ? 20_000 : 15_000,
      });
      break;
    } catch (e) {
      navError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  // Даем SPA React смонтироваться, но не дольше необходимого
  await page.waitForSelector(CONTENT_SELECTOR, { timeout: 5_000 }).catch(() => {});

  const currentUrl = page.url();
  let httpStatus = 0;
  try { httpStatus = response ? await response.status() : 0; } catch { httpStatus = 0; }

  // 1. Навигация не удалась и мы не на Threads -> доказательств нет
  if (!isThreadsHost(currentUrl)) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: навигация не завершилась (url=${currentUrl || "пусто"}, status=${httpStatus || "нет"}, ошибка=${navError || "нет"}) - вердикт не вынесен`);
    return "inconclusive";
  }

  // 2. Редирект на /login = мертвая сессия аккаунта-скрапера
  if (isLoginUrl(currentUrl)) {
    return "session_expired";
  }

  // 2a. Редирект на /accounts/suspended, /challenge, /checkpoint = Meta заблокировала
  //     САМ технический аккаунт. Раньше это уходило в "inconclusive": аккаунт оставался
  //     «Активен» и на каждом запросе сжигал ~8 секунд браузера перед ротацией.
  if (isAccountBlockedUrl(currentUrl)) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: Threads заблокировал технический аккаунт (редирект на ${currentUrl}) - аккаунт выводится из ротации`);
    return "session_expired";
  }

  // 3. Threads сам вернул 404 для URL профиля = сильное доказательство отсутствия
  if (httpStatus === 404) {
    return "user_not_found";
  }
  if (httpStatus >= 500 || httpStatus === 429) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: Threads вернул HTTP ${httpStatus} - вердикт не вынесен`);
    return "inconclusive";
  }

  // 4. Считываем DOM один раз
  const snapshot = await page.evaluate(() => {
    const body = document.body ? document.body.innerText : "";
    const q = (sel: string) => Boolean(document.querySelector(sel));
    return {
      body,
      title: document.title || "",
      url: location.href,
      hasContent: q('div[data-pressable-container="true"],article,div[role="article"],header,div[role="banner"],main'),
      // Признаки АВТОРИЗОВАННОЙ сессии: таких элементов у гостя нет вообще
      authedNav: q(
        '[aria-label="Your profile"],[aria-label="Ваш профиль"],' +
        'a[href="/settings"],[aria-label="Settings"],[aria-label="Настройки"],' +
        '[aria-label="Notifications"],[aria-label="Уведомления"],' +
        '[aria-label="Create post"],[aria-label="Новый пост"],' +
        '[aria-label="Search"],[aria-label="Поиск"]'
      ),
      // Признаки ГОСТЯ: ссылки на вход и регистрацию
      loginLink: q('a[href*="/login"],a[href*="accounts/login"],a[href*="instagram.com/accounts/login"]'),
      signupLink: q('a[href*="signup"],a[href*="/register"]'),
      // Профиль пользователя присутствует в DOM (h1/h2 с handle или ссылка на профиль)
      hasProfileHandle: Boolean(
        Array.from(document.querySelectorAll('a[href^="/@"]')).some((a) => (a.getAttribute("href") || "").length > 2)
      ),
    };
  }).catch(() => null);

  if (!snapshot) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: не удалось прочитать DOM - вердикт не вынесен`);
    return "inconclusive";
  }

  // 5. Структурная проверка авторизации. ВАЖНО: она идёт ПЕРЕД любыми выводами
  //    о существовании профиля, потому что гостю Threads показывает совсем другую страницу.
  const loggedOutText = hasLoggedOutMarkers(snapshot.body) || hasLoggedOutMarkers(snapshot.title);
  if (!snapshot.authedNav && (loggedOutText || snapshot.loginLink || snapshot.signupLink)) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: аккаунт фактически разлогинен (authedNav=false, loginLink=${snapshot.loginLink}, signupLink=${snapshot.signupLink}, текстВхода=${loggedOutText}) на ${currentUrl}`);
    return "session_expired";
  }

  // 6. Явный текст "страница недоступна / аккаунт не найден" = доказательство отсутствия
  if (isUserNotFoundPage(snapshot.title) || isUserNotFoundPage(snapshot.body)) {
    return "user_not_found";
  }

  // 7. Авторизованная сессия выброшена с URL профиля на ленту/главную.
  //    Именно так Threads ведёт себя с несуществующими профилями.
  const path = (() => {
    try { return new URL(currentUrl).pathname.toLowerCase().replace(/\/+$/, ""); } catch { return ""; }
  })();
  const FEED_PATHS = ["", "/", "/for_you", "/following", "/home", "/explore"];
  if (FEED_PATHS.includes(path)) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: Threads увёл сессию с профиля на ленту (${currentUrl})`);
    return "user_not_found";
  }

  // 8. Ушли куда-то ещё (checkpoint, интерстициал, чужой профиль) - доказательств нет
  if (!isProfileUrl(currentUrl, cleanUser)) {
    await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: Threads увёл сессию на ${currentUrl} - вердикт не вынесен`);
    return "inconclusive";
  }

  // 9. Контент отрендерился - профиль существует
  if (snapshot.hasContent) {
    return "ok";
  }

  // 10. Пустой DOM без единого маркера. Раньше здесь возвращался user_not_found -
  //     это и была причина ложных 404 на существующих профилях.
  await logSystem(env, "warn", "scraper", `Проверка @${cleanUser}: страница ${snapshot.url} не отдала контент (title="${(snapshot.title || "").slice(0, 60)}", body=${(snapshot.body || "").length} симв.: "${(snapshot.body || "").replace(/\s+/g, " ").trim().slice(0, 160)}") - вердикт не вынесен`);
  return "inconclusive";
}

/** Состояние голосования аккаунтов за вердикт "профиль не найден". */
type VerdictState = {
  notFoundVotes: string[];
  inconclusiveAccounts: string[];
  requiredVotes: number;
  /** Кеш независимой HTTP-проверки, чтобы не дёргать её на каждом аккаунте */
  httpCheck?: PublicProfileResult | null;
};

async function newVerdictState(env: Env): Promise<VerdictState> {
  let aliveCount = 0;
  try {
    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM threads_accounts WHERE enabled=1 AND is_alive=1")
      .first<{ c: number }>();
    aliveCount = Number(row?.c || 0);
  } catch {
    aliveCount = 0;
  }
  // Отсутствие профиля должны подтвердить минимум два независимых аккаунта,
  // иначе один глючный аккаунт отравляет кеш на всех пользователей.
  return { notFoundVotes: [], inconclusiveAccounts: [], requiredVotes: aliveCount >= 2 ? 2 : 1 };
}

type VerdictOutcome =
  | { action: "proceed" }
  | { action: "rotate" }
  | { action: "http_data"; data: ProfileData }
  | { action: "return"; status: ThreadsStatus; account?: string; error?: string };

/**
 * Единая точка принятия решения по вердикту checkProfile.
 * Ключевой принцип: user_not_found возвращается только при положительном
 * доказательстве, подтверждённом кворумом аккаунтов и не опровергнутом
 * независимой HTTP-проверкой публичной страницы профиля.
 */
async function resolveVerdict(
  env: Env,
  account: Account,
  username: string,
  verdict: ProfileVerdict,
  state: VerdictState
): Promise<VerdictOutcome> {
  if (verdict === "ok") return { action: "proceed" };

  if (verdict === "session_expired") {
    await logSystem(env, "warn", "scraper", `Сессия истекла у аккаунта [${account.name}] при запросе @${username}`);
    await markSessionExpired(env, account.name);
    return { action: "rotate" };
  }

  if (verdict === "inconclusive") {
    state.inconclusiveAccounts.push(account.name);
    await logSystem(env, "warn", "scraper", `Аккаунт [${account.name}] не смог достоверно проверить @${username} - пробуем следующий аккаунт`);
    await markTransientError(env, account.name, new Error("Проверка профиля не дала однозначного результата"));
    return { action: "rotate" };
  }

  // verdict === "user_not_found"
  // ВЕТО: независимая HTTP-проверка публичной страницы профиля без браузера и без куки.
  // Результат кешируется в state, чтобы не дёргать сеть на каждом аккаунте.
  const pub = state.httpCheck ?? (state.httpCheck = await fetchPublicProfile(username));
  const existsPublicly = pub.exists;
  if (existsPublicly === true) {
    state.inconclusiveAccounts.push(account.name);
    // Аккаунт не видит профиль, который заведомо существует. Значит сессия нерабочая -
    // помечаем её мёртвой, чтобы она больше не участвовала в ротации и не тратила время.
    await markSessionExpired(env, account.name);
    await logSystem(env, "warn", "scraper", `Аккаунт [${account.name}] сообщил, что @${username} не найден, но публичная страница Threads подтверждает существование профиля (${pub.detail || "данные получены"}). Аккаунт помечен мёртвым, вердикт отклонён`);

    // Если HTTP-источник уже дал посты - нет смысла жечь оставшиеся запуски браузера.
    if (pub.profile && (pub.posts?.length || 0) > 0) {
      await logSystem(env, "info", "scraper", `@${username}: отдаём данные из публичного HTTP-источника (${pub.posts!.length} постов), остальные аккаунты не опрашиваем`);
      return { action: "http_data", data: { profile: pub.profile, posts: pub.posts!, partial: true, source: "http" } };
    }
    return { action: "rotate" };
  }

  state.notFoundVotes.push(account.name);
  await logSystem(env, "warn", "scraper", `Аккаунт [${account.name}] сообщил, что @${username} не найден (голос ${state.notFoundVotes.length} из ${state.requiredVotes}, HTTP-проверка: ${existsPublicly === false ? "подтверждает 404" : "не дала ответа"})`);

  if (existsPublicly === false || state.notFoundVotes.length >= state.requiredVotes) {
    await logSystem(env, "warn", "scraper", `Отсутствие @${username} подтверждено (${state.notFoundVotes.join(", ")}). Возвращаем user_not_found`);
    return { action: "return", status: "user_not_found", account: state.notFoundVotes.join(", ") };
  }
  return { action: "rotate" };
}

/** Итог, когда доступные аккаунты закончились, а однозначного ответа нет. */
function verdictOnExhaustion(username: string, state: VerdictState, tried: string[]): VerdictOutcome & { action: "return" } {
  if (state.notFoundVotes.length > 0) {
    return { action: "return", status: "user_not_found", account: state.notFoundVotes.join(", ") };
  }
  if (state.inconclusiveAccounts.length > 0) {
    // Ни один аккаунт не дал достоверного ответа.
    // Это НЕ "профиль не найден" - отрицательный кеш писать нельзя.
    return {
      action: "return",
      status: "service_error",
      account: state.inconclusiveAccounts.join(", "),
      error: "Аккаунты-скраперы не смогли достоверно проверить профиль",
    };
  }
  return { action: "return", status: "all_dead", account: tried.join(", ") || undefined };
}

/**
 * Независимая HTTP-проверка существования профиля без браузера.
 * Используется ТОЛЬКО чтобы наложить вето на user_not_found:
 * если публичная страница профиля отвечает 200 и содержит username в title/og:title,
 * значит профиль существует и объявлять его отсутствующим нельзя.
 *
 * Возвращает: true - профиль точно существует, false - точно отсутствует (404), null - неизвестно.
 */
/** Результат независимого HTTP-запроса публичной страницы профиля. */
export type PublicProfileResult = {
  /** true - профиль существует, false - точно отсутствует (404), null - неизвестно */
  exists: boolean | null;
  profile?: ProfileMeta;
  posts?: Post[];
  /** Короткое описание того, что удалось достать - для логов */
  detail?: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    })
    .replace(/\\"/g, '"')
    .replace(/\\u00([0-9a-fA-F]{2})/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .trim();
}

export function metaContent(html: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`property=["']${escaped}["'][^>]*content=["']([\\s\\S]*?)["']`, "i"),
    new RegExp(`content=["']([\\s\\S]*?)["'][^>]*property=["']${escaped}["']`, "i"),
    new RegExp(`name=["']${escaped}["'][^>]*content=["']([\\s\\S]*?)["']`, "i"),
    new RegExp(`content=["']([\\s\\S]*?)["'][^>]*name=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return "";
}

export function jsonLdBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeEntities(m[1]).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      out.push(parsed);
    } catch {
      // Некоторые блоки содержат несколько объектов подряд - пробуем починить
      try { out.push(JSON.parse(`[${raw.replace(/}\s*{/g, "},{")}]`)); } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Вытаскивает JSON-объект, начинающийся в позиции start (должна указывать на "{").
 * Учитывает строки и экранирование, чтобы скобки внутри текста поста не ломали разбор.
 */
export function sliceBalancedJson(src: string, start: number, maxLen: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(src.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Все JSON-нагрузки, из которых можно достать посты.
 *
 * 1. Блоки <script type="application/json"> - основной канал Threads для предзагрузки.
 * 2. Обычные <script> без атрибута type: Meta Comet складывает предзагруженные ответы
 *    GraphQL в присваивания вида __bbox = {...} или RelayPrefetchedStreamCache = {...}.
 *    Раньше regex их не видел, из-за чего посты не парсились вообще.
 *    Разбор дорог, поэтому пробуем только кандидатов с маркерами постов и с лимитом размера.
 */
export function jsonScriptBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.length < 20) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip */ }
  }

  // Маркеры, по которым стоит вообще пытаться парсить объект: без них это пустая трата CPU.
  const MARKERS = ['"text_post_app_info"', '"thread_items"', '"edges"', '"shortcode"', '"pk"'];
  const scriptRe = /<script(?![^>]*type=["']application\/(?:ld\+)?json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let candidates = 0;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null && candidates < 40) {
    const body = sm[1];
    if (!body || body.length < 80) continue;
    if (!MARKERS.some((k) => body.includes(k))) continue;

    // Ищем каждое вхождение "{" и пробуем сбалансированно вырезать объект.
    let idx = body.indexOf("{");
    while (idx !== -1 && candidates < 40) {
      const slice = sliceBalancedJson(body, idx, 400_000);
      idx = body.indexOf("{", idx + 1);
      if (!slice || slice.length < 60) continue;
      if (!MARKERS.some((k) => slice.includes(k))) continue;
      candidates++;
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed === "object") out.push(parsed);
      } catch { /* skip */ }
    }
  }

  return out;
}

function flattenLdJson(blocks: any[]): any[] {
  const out: any[] = [];
  const walk = (node: any, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node === "object") {
      out.push(node);
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    }
  };
  for (const b of blocks) walk(b);
  return out;
}

function looksLikePost(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  const text = node.text || node.text_post_app_info?.headline;
  if (typeof text !== "string" || text.length < 1) return false;
  return Boolean(node.code || node.id || node.pk || node.caption);
}

export function normalizePost(node: any, ownerUsername: string): Post | null {
  if (!looksLikePost(node)) return null;
  const text = String(node.text || node.text_post_app_info?.headline || node.caption || "").trim();
  if (!text) return null;
  const code = String(node.code || node.shortcode || node.id || node.pk || "").trim();
  const author = String(node.user?.username || node.owner?.username || node.username || ownerUsername);
  // ВАЖНО: без явных типов здесь срабатывал приоритет операторов -
  // `a ?? b === false ? c : d` парсится как `(a ?? (b === false)) ? c : d`,
  // из-за чего счётчик лайков всегда выходил пустым.
  const likeRaw = node.like_count ?? node.text_post_app_info?.like_count ?? node.like_and_view_count;
  const likes = typeof likeRaw === "number" || typeof likeRaw === "string" ? String(likeRaw) : "";
  const replies = node.replies_count ?? node.comment_count ?? node.text_post_app_info?.direct_reply_count;
  const images: string[] = [];
  // URL из публичного HTML приходят уже с HTML-экранированием (&amp; вместо &).
  // Если их не раскодировать здесь, рендер экранирует их повторно, и тег <img>
  // уезжает в страницу как текст с &amp;amp;amp; в атрибутах.
  // Браузерный путь отдаёт чистые URL, поэтому на них это не влияло.
  const addImage = (v: any) => {
    if (!v) return;
    if (typeof v === "string") {
      const decoded = decodeEntities(v);
      if (decoded.startsWith("http")) images.push(decoded);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) addImage(x); return; }
    if (typeof v === "object") addImage(v.url || v.src || v.candidate_url || v.display_url);
  };
  addImage(node.image_url || node.thumbnail_url || node.carousel_media || node.display_url);

  const ts = node.taken_at || node.taken_at_timestamp || node.caption?.created_at;
  let date = "";
  if (typeof ts === "number") date = new Date(ts < 1e11 ? ts * 1000 : ts).toISOString();
  else if (typeof ts === "string") date = ts;

  return {
    id: code || undefined,
    text,
    has_image: images.length > 0,
    has_video: Boolean(node.video_url || node.video_versions?.length),
    videoUrl: node.video_url ? String(node.video_url) : undefined,
    imageUrl: images[0],
    images: images.length ? images : undefined,
    postUrl: code ? `https://www.threads.com/@${author}/post/${code}` : undefined,
    likes: String(likes || ""),
    replies: replies != null ? String(replies) : "",
    date: date || undefined,
    author: author.toLowerCase(),
  };
}

export function walkForPosts(root: any, ownerUsername: string, seen: Set<string>, out: Post[], depth = 0) {
  // Глубина 24: предзагруженные ответы Meta Comet вложены глубоко
  // (data -> user -> edge_owner_to_timeline_media -> edges -> node -> ...).
  // Прежний лимит 14 обрывал обход до того, как доходил до постов.
  if (!root || depth > 24 || out.length >= 40) return;
  if (Array.isArray(root)) {
    for (const item of root) walkForPosts(item, ownerUsername, seen, out, depth + 1);
    return;
  }
  if (typeof root !== "object") return;
  const post = normalizePost(root, ownerUsername);
  if (post) {
    const key = (post.id || post.text.slice(0, 80)).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(post);
    }
  }
  for (const key of Object.keys(root)) walkForPosts(root[key], ownerUsername, seen, out, depth + 1);
}

/**
 * Независимый HTTP-запрос публичной страницы профиля.
 * Работает БЕЗ браузера и БЕЗ куки технических аккаунтов - Threads отдаёт
 * публичные профили поисковым краулерам в виде готового HTML с метаданными.
 *
 * Используется и как вето на ложный user_not_found, и как фолбэк-источник данных,
 * когда все аккаунты-скраперы не дали достоверного ответа.
 */
async function fetchPublicProfile(username: string): Promise<PublicProfileResult> {
  const clean = username.toLowerCase().replace(/^@/, "");
  const hosts = ["https://www.threads.net", "https://www.threads.com"];
  const uas = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ];

  for (const host of hosts) {
    for (const ua of uas) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9_000);
      try {
        const res = await fetch(`${host}/@${clean}`, {
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "user-agent": ua,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
          },
        });
        if (res.status === 404) return { exists: false, detail: `${host}: HTTP 404` };
        if (!res.ok) continue;
        if (isLoginUrl(res.url || "")) continue;

        const html = await res.text();
        if (!html || html.length < 200) continue;

        const ogTitle = metaContent(html, "og:title");
        const ogDesc = metaContent(html, "og:description");
        const ogImage = metaContent(html, "og:image");
        const titleTag = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
        const haystack = `${titleTag} ${ogTitle}`.toLowerCase();

        const ldNodes = flattenLdJson(jsonLdBlocks(html));
        const ldProfile = ldNodes.find((n) => {
          const t = String(n["@type"] || "").toLowerCase();
          return t === "profilepage" || t === "person" || t.includes("profile");
        });

        const profileConfirmed = haystack.includes(clean) || Boolean(ldProfile);
        if (!profileConfirmed) {
          if (isUserNotFoundPage(html.slice(0, 30_000))) return { exists: false, detail: `${host}: маркер "не найдено" в HTML` };
          continue;
        }

        // Собираем метаданные профиля
        let displayName = clean;
        const fromOg = ogTitle.match(/^(.*?)\s*\(@/);
        if (fromOg && fromOg[1].trim()) displayName = fromOg[1].trim();
        else if (ldProfile?.name) displayName = String(ldProfile.name);
        else if (ogTitle && !ogTitle.toLowerCase().startsWith("threads")) displayName = ogTitle.split("•")[0].trim() || clean;

        let bio = "";
        if (ldProfile?.description) bio = String(ldProfile.description);
        else if (ogDesc && !ogDesc.toLowerCase().includes("threads")) bio = ogDesc;

        let followers = "";
        const stat = ldProfile?.interactionStatistic || ldProfile?.interaction_count;
        if (Array.isArray(stat)) {
          const follow = stat.find((s: any) => String(s?.interactionType || "").toLowerCase().includes("follow"));
          if (follow && follow.userInteractionCount != null) followers = String(follow.userInteractionCount);
        } else if (typeof stat === "number") {
          followers = String(stat);
        }
        if (!followers) {
          const fm = ogDesc.match(/([\d.,]+\s?[KMB]?)\s*(?:followers|подписчик)/i);
          if (fm) followers = fm[1];
        }

        const profile: ProfileMeta = {
          username: clean,
          displayName,
          bio,
          avatar: ogImage,
          followers,
          verified: /verified|подтверждён/i.test(ogTitle),
        };

        // Пробуем достать посты из встроенных JSON-блоков
        const posts: Post[] = [];
        const seen = new Set<string>();
        for (const block of jsonScriptBlocks(html)) walkForPosts(block, clean, seen, posts);
        for (const node of ldNodes) {
          if (node?.text && (node.code || node.id)) {
            const p = normalizePost(node, clean);
            if (p) {
              const key = (p.id || p.text.slice(0, 80)).toLowerCase();
              if (!seen.has(key)) { seen.add(key); posts.push(p); }
            }
          }
        }
        posts.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

        return {
          exists: true,
          profile,
          posts: posts.slice(0, 20),
          detail: `${host}: имя="${displayName}", bio=${bio.length} симв., avatar=${ogImage ? "есть" : "нет"}, постов=${posts.length}`,
        };
      } catch {
        // таймаут или блок - пробуем следующую комбинацию
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { exists: null, detail: "ни один хост не дал однозначного ответа" };
}

/**
 * Вето на user_not_found. Возвращает:
 * true - профиль точно существует, false - точно отсутствует (404), null - неизвестно.
 */
async function publicProfileExists(username: string): Promise<boolean | null> {
  const result = await fetchPublicProfile(username);
  return result.exists;
}

async function chooseAccount(env: Env, tried: string[]): Promise<Account | null> {
  const cutoff = new Date(Date.now() - 3_600_000).toISOString();
  await env.DB.prepare("UPDATE threads_accounts SET hourly_requests=0,hourly_reset=? WHERE hourly_reset<?").bind(iso(), cutoff).run();
  const marks = tried.map(() => "?").join(",");
  const query = `SELECT name,cookies,hourly_requests,hourly_reset FROM threads_accounts WHERE enabled=1 AND is_alive=1 AND hourly_requests<?${tried.length ? ` AND name NOT IN (${marks})` : ""} ORDER BY hourly_requests ASC,RANDOM() LIMIT 1`;
  return env.DB.prepare(query).bind(LIMITS.accountHourly, ...tried).first<Account>();
}

async function markSuccess(env: Env, name: string, posts = 0, updatedCookies?: string) {
  await logBrowser(env, "acct", `${name}|ok`);
  await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,requests_count=requests_count+1,posts_sent=posts_sent+?,hourly_requests=hourly_requests+1,last_used=?,updated_at=?,cookies=COALESCE(?,cookies) WHERE name=?").bind(posts, iso(), iso(), updatedCookies || null, name).run();
}
async function markSessionExpired(env: Env, name: string) {
  await logBrowser(env, "acct", `${name}|dead`);
  await env.DB.prepare("UPDATE threads_accounts SET is_alive=0,last_error='Session expired',errors_count=errors_count+1,updated_at=? WHERE name=?").bind(iso(), name).run();
}
async function markTransientError(env: Env, name: string, error: unknown) {
  await logBrowser(env, "acct", `${name}|err`);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await env.DB.prepare("UPDATE threads_accounts SET last_error=?,errors_count=errors_count+1,updated_at=? WHERE name=?").bind(message, iso(), name).run();
}

async function capturePosts(page: Page, posts: Post[]): Promise<Post[]> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('div[role="dialog"]').forEach(e => e.remove());
    document.querySelectorAll("nav,header").forEach((e: any) => e.style.display = "none");
  }).catch(() => {});
  const result: Post[] = [];
  const targetBatch = posts.slice(0, 5);
  for (const post of targetBatch) {
    try {
      const handle = await page.evaluateHandle((search: string) => {
        let nodes = Array.from(document.querySelectorAll('article,div[role="article"]'));
        if (!nodes.length) nodes = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
        return nodes.find(node => Array.from(node.querySelectorAll('span[dir="auto"],div[dir="auto"]')).some((b: any) => (b.innerText || "").trim().startsWith(search))) || null;
      }, post.text.slice(0, 50));
      const element = handle.asElement();
      if (element) {
        await element.scrollIntoViewIfNeeded().catch(() => {});
        const shot = await element.screenshot({ type: "png", timeout: 4000 }).catch(() => null);
        if (shot) {
          result.push({ ...post, image: new Uint8Array(shot) });
        } else {
          result.push(post);
        }
      } else {
        result.push(post);
      }
      await handle.dispose().catch(() => {});
    } catch {
      result.push(post);
    }
  }
  for (let i = result.length; i < posts.length; i++) {
    result.push(posts[i]);
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
      const imgs = document.querySelectorAll("header img, main img, img");
      for (let i = 0; i < imgs.length; i++) {
        const el = imgs[i] as HTMLImageElement;
        const alt = (el.getAttribute("alt") || "").toLowerCase();
        const src = el.currentSrc || el.src || "";
        if (src && !src.includes("data:") && (alt.includes("profile picture") || alt.includes("фото профиля") || alt.includes(uname.toLowerCase()) || el.closest('header, main header'))) {
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
  const state = await newVerdictState(env);

  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) {
      // Аккаунты закончились. Финальная консультация с независимым HTTP-источником.
      const outcome = verdictOnExhaustion(username, state, tried);
      await logSystem(
        env,
        outcome.status === "user_not_found" ? "warn" : "error",
        "scraper",
        `@${username}: аккаунты исчерпаны (проверено: ${tried.join(", ") || "нет доступных"}). ` +
        `Голосов за отсутствие: ${state.notFoundVotes.length}/${state.requiredVotes}, ` +
        `недостоверных: ${state.inconclusiveAccounts.length}. Предварительный итог: ${outcome.status}`
      );

      const pub = state.httpCheck ?? (state.httpCheck = await fetchPublicProfile(username));
      await logSystem(env, "info", "scraper", `@${username}: HTTP-фолбэк публичной страницы -> exists=${pub.exists === null ? "неизвестно" : pub.exists}${pub.detail ? `, ${pub.detail}` : ""}`);

      if (pub.exists === true && pub.profile) {
        // Профиль существует и данные получены без браузера. Возвращаем их,
        // а не ошибку: для пользователя это рабочий ответ.
        const posts = pub.posts || [];
        await logSystem(env, "info", "scraper", `@${username}: профиль собран через публичный HTTP-источник (${posts.length} постов) - браузерные аккаунты не понадобились`);
        return {
          data: { profile: pub.profile, posts, partial: true, source: "http" },
          status: "ok",
          account: "public-http",
        };
      }

      if (pub.exists === false) {
        await logSystem(env, "warn", "scraper", `@${username}: отсутствие профиля подтверждено независимым HTTP-запросом (404). Возвращаем user_not_found`);
        return { data: null, status: "user_not_found", account: outcome.account, error: outcome.error };
      }

      // HTTP тоже не дал ответа. Если браузерных голосов за отсутствие нет -
      // это временная проблема, отрицательный кеш писать нельзя.
      if (state.notFoundVotes.length === 0 && state.inconclusiveAccounts.length > 0) {
        return {
          data: null,
          status: "service_error",
          account: state.inconclusiveAccounts.join(", "),
          error: "Аккаунты-скраперы не смогли достоверно проверить профиль",
        };
      }
      return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
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

      const feed = attachFeedCollector(opened.page, username);
      const verdict = await checkProfile(opened.page, env, username);
      const outcome = await resolveVerdict(env, account, username, verdict, state);
      if (outcome.action === "rotate") continue;
      if (outcome.action === "http_data") {
        return { data: outcome.data, status: "ok", account: "public-http" };
      }
      if (outcome.action === "return") {
        return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
      }

      const profile = await collectProfileHeader(opened.page, username);
      const posts = await collectPosts(opened.page, amount, username, feed);
      const endReached = feed.hasNextPage === false && posts.length < amount;
      let vIdx = 0;
      for (const p of posts) {
        if (p.has_video && !p.videoUrl && vIdx < capturedVideos.length) {
          p.videoUrl = capturedVideos[vIdx++];
        }
      }
      let updated: string | null = null;
      try {
        const rawCookies = await opened.context.cookies();
        updated = keepSessionCookies(JSON.stringify(rawCookies));
      } catch {
        // Safe: never fail if browser or context closed right after scraping
      }
      await markSuccess(env, account.name, posts.length, updated || undefined);
      await logSystem(env, "info", "scraper", `Успешно загружен профиль @${username}: ${posts.length} постов через [${account.name}] (цель ${amount}; из сети ${feed.posts.length}, JSON-ответов ${feed.responses}, has_next_page=${feed.hasNextPage === null ? "нет данных" : feed.hasNextPage})`);
      return { data: { profile, posts, source: "browser", endReached }, status: "ok", account: account.name };
    } catch (error) {
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await logSystem(env, "error", "scraper", `Ошибка сбора @${username} (аккаунт: ${account.name}): ${errMsg}`);
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      if (/target page|context or browser has been closed|browser has been closed|session closed|ws connection closed/i.test(errMsg) && tried.length < 2) {
        continue;
      }
      return { data: null, status: "service_error", account: account.name, error: errMsg };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}

export async function fetchPosts(env: Env, username: string, mode: "text" | "img", amount = 20): Promise<{ data: Post[] | null; status: ThreadsStatus; account?: string; error?: string }> {
  const tried: string[] = [];
  const state = await newVerdictState(env);
  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) {
      const outcome = verdictOnExhaustion(username, state, tried);
      return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
    }
    tried.push(account.name);
    let opened: Opened | undefined;
    try {
      opened = await openBrowser(env, account);
      const verdict = await checkProfile(opened.page, env, username);
      const outcome = await resolveVerdict(env, account, username, verdict, state);
      if (outcome.action === "rotate") continue;
      if (outcome.action === "http_data") {
        return { data: outcome.data.posts, status: "ok", account: "public-http" };
      }
      if (outcome.action === "return") return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
      let data = await collectPosts(opened.page, amount, username);
      if (!data.length) return { data: null, status: "no_posts", account: account.name };
      if (mode === "img") data = await capturePosts(opened.page, data);
      let updated: string | null = null;
      try {
        const rawCookies = await opened.context.cookies();
        updated = keepSessionCookies(JSON.stringify(rawCookies));
      } catch {
        // Safe: never fail if browser or context closed right after scraping
      }
      await markSuccess(env, account.name, data.length, updated || undefined);
      return { data, status: "ok", account: account.name };
    } catch (error) {
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      if (/target page|context or browser has been closed|browser has been closed|session closed|ws connection closed/i.test(errMsg) && tried.length < 2) {
        continue;
      }
      return { data: null, status: "service_error", account: account.name, error: errMsg };
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
  const state = await newVerdictState(env);
  while (true) {
    const account = await chooseAccount(env, tried);
    if (!account) {
      const outcome = verdictOnExhaustion(username, state, tried);
      return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
    }
    tried.push(account.name);
    let opened: Opened | undefined;
    try {
      opened = await openBrowser(env, account);
      const verdict = await checkProfile(opened.page, env, username);
      const outcome = await resolveVerdict(env, account, username, verdict, state);
      // Комментарии доступны только через браузер: HTTP-фолбэк их не отдаёт,
      // поэтому просто пробуем следующий аккаунт.
      if (outcome.action === "rotate" || outcome.action === "http_data") continue;
      if (outcome.action === "return") return { data: null, status: outcome.status, account: outcome.account, error: outcome.error };
      const posts = await collectPosts(opened.page, index + 3, username);
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
      let updated: string | null = null;
      try {
        const rawCookies = await opened.context.cookies();
        updated = keepSessionCookies(JSON.stringify(rawCookies));
      } catch {
        // Safe: never fail if browser or context closed right after scraping
      }
      await markSuccess(env, account.name, data.length, updated || undefined);
      return { data, status: "ok", account: account.name };
    } catch (error) {
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await markTransientError(env, account.name, error);
      if (error instanceof BrowserBusyError || isBrowserRateLimit(error)) return { data: null, status: "browser_busy", account: account.name };
      if (/target page|context or browser has been closed|browser has been closed|session closed|ws connection closed/i.test(errMsg) && tried.length < 2) {
        continue;
      }
      return { data: null, status: "service_error", account: account.name, error: errMsg };
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

    // Тестируем на эталонном публичном профиле, который гарантированно существует.
    // Используем ту же логику вердиктов, что и боевой скрапер, чтобы тест не расходился с реальностью.
    const verdict = await checkProfile(opened.page, env, PROBE_USERNAME);

    if (verdict === "session_expired") {
      await markSessionExpired(env, name);
      await logSystem(env, "error", "probe", `Тест [${name}] провален: сессия истекла (требуется вход в аккаунт)`);
      return { name, ok: false, message: "Сессия истекла в Threads (требуется вход в аккаунт)" };
    }

    if (verdict === "inconclusive") {
      // Эталонный профиль не открылся, но и явных признаков мертвой сессии нет.
      // Не помечаем аккаунт живым - иначе тест будет врать, как раньше.
      await markTransientError(env, name, new Error("Probe: эталонный профиль не открылся"));
      await logSystem(env, "warn", "probe", `Тест [${name}] не дал однозначного результата: страница @${PROBE_USERNAME} не открылась (таймаут или пустой DOM)`);
      return { name, ok: false, message: `Не удалось открыть эталонный профиль @${PROBE_USERNAME} (таймаут или пустая страница)` };
    }

    if (verdict === "user_not_found") {
      // @zuck существует всегда и публично. Если аккаунт его "не видит" и Threads уводит
      // сессию на ленту, это значит ровно одно: аккаунт разлогинен. Формулировка
      // "профиль не найден" здесь сбивала с толку, потому что профиль найден прекрасно.
      await markSessionExpired(env, name);
      await logSystem(env, "error", "probe", `Тест [${name}] провален: Threads не показал эталонный профиль @${PROBE_USERNAME} и увёл на ленту. Значит аккаунт разлогинен, сессию нужно пересоздать вручную`);
      return { name, ok: false, message: "Аккаунт разлогинен в Threads. Нужен свежий экспорт cookies, автопродление не поможет" };
    }
    let updated: string | null = null;
    try {
      const rawCookies = await opened.context.cookies();
      updated = keepSessionCookies(JSON.stringify(rawCookies));
    } catch {}
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

    // Проверяем сессию тем же структурным способом, что и боевой скрапер.
    // Раньше здесь был только isLoginUrl(page.url()) после захода на главную, но
    // Threads НЕ редиректит гостя с главной на /login - он просто показывает ленту.
    // Из-за этого Keep-Alive рапортовал об успехе на полностью мёртвой сессии.
    const verdict = await checkProfile(opened.page, env, PROBE_USERNAME);

    if (verdict === "session_expired") {
      await markSessionExpired(env, name);
      await logSystem(env, "warn", "keepalive", `Keep-Alive [${name}]: сессия мертва, требуется свежий логин`);
      return { name, ok: false, message: "Сессия уже истекла в Threads, требуется свежий логин" };
    }

    if (verdict === "inconclusive" || verdict === "user_not_found") {
      // Эталонный профиль не открылся. Продлевать нечего, но и утверждать,
      // что сессия мертва, оснований нет - помечаем как временную ошибку.
      await markTransientError(env, name, new Error(`Keep-Alive: эталонный профиль недоступен (${verdict})`));
      await logSystem(env, "warn", "keepalive", `Keep-Alive [${name}]: не удалось открыть эталонный профиль @${PROBE_USERNAME} (${verdict}) - сессия не продлена`);
      return { name, ok: false, message: `Не удалось открыть эталонный профиль @${PROBE_USERNAME}, сессия не продлена` };
    }

    await opened.page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    await sleep(1000);

    let rawCookies: any[] = [];
    try {
      rawCookies = await opened.context.cookies();
    } catch {}
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
      message: "Сессия проверена и активна в Meta, куки синхронизированы в D1",
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
