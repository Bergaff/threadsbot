import { launch, type BrowserContext, type Page } from "@cloudflare/playwright";
import { LIMITS, type Env } from "./config";
import { playwrightCookies, snapshotHasSession } from "./cookies";
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

export interface Post { text: string; has_image: boolean; has_video: boolean; image?: Uint8Array }
export interface Comment { author: string; text: string; top?: number }
export type ThreadsStatus = "ok" | "user_not_found" | "session_expired" | "no_posts" | "post_not_found" | "all_dead" | "browser_busy" | "service_error";
type Account = { name: string; cookies: string; hourly_requests: number; hourly_reset: string };
type Opened = { browser: any; context: BrowserContext; page: Page; startedAt: number };

const FREE_BROWSER_INTERVAL_MS = 21_000;
const BASE = (env: Env) => env.BASE_URL || "https://www.threads.com";
const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class BrowserBusyError extends Error {}

// ============================
// BROWSER
// ============================

const COLLECT_POSTS = `() => {
 const posts=[],seen=new Set();
 const containers=document.querySelectorAll('div[data-pressable-container="true"],article,div[role="article"]');
 for(const container of containers){let bestText='',has_image=false,has_video=false;
  for(const img of container.querySelectorAll('img[src*="cdninstagram.com"],img[src*="fbcdn.net"]')){if((img.naturalWidth||img.width||0)>200){has_image=true;break}}
  has_video=container.querySelectorAll('video,div[role="button"] svg[aria-label*="video"],div[role="button"] svg[aria-label="Play"]').length>0;
  for(const el of container.querySelectorAll('span[dir="auto"],div[dir="auto"],span[class*="x1lliihq"]')){const text=(el.innerText||'').trim();if(text.length<20||/^(Follow|Подписаться|Translate|Перевести|See translation|See more|Like|Reply|Repost|Share|Verified|Автор|Ещё|Нравится|Поделиться)/i.test(text)||/^\d+$/.test(text)||/^\d{1,2}\s*[hчдms]$/i.test(text))continue;if(text.length>bestText.length)bestText=text}
  if(bestText.length>25||has_image||has_video){const key=bestText.substring(0,100)+(has_image?'_img':'')+(has_video?'_vid':'');if(!seen.has(key)){seen.add(key);posts.push({text:bestText,has_image,has_video})}}
 } return posts;
}`;

function cookieList(raw: string): any[] {
  return playwrightCookies(raw);
}

function keepSessionCookies(raw: string): string | null {
  return snapshotHasSession(raw) ? raw : null;
}

async function logBrowser(env: Env, type: string, data = "") {
  await env.DB.prepare("INSERT INTO user_events(user_id,event_type,event_data,timestamp) VALUES(0,?,?,?)").bind(type, data, iso()).run().catch(() => {});
}

async function waitForBrowserSlot(env: Env) {
  const row = await env.DB.prepare("SELECT value FROM bot_state WHERE scope='system' AND state_key='browser_next_launch'").first<{ value: string }>();
  const wait = Math.max(0, Number(row?.value || 0) - Date.now());
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
      browser = await launch(env.BROWSER);
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 680, height: 900 },
      });
      const page = await context.newPage();
      // Как в рабочей Python-версии: сначала открываем домен, потом ставим cookies, потом reload.
      // Иначе cookies с .threads.net / .instagram.com не прилипают к www.threads.com.
      await page.goto(`${BASE(env)}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(2000);
      await context.addCookies(cookieList(account.cookies));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(3000);
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
  for (let i = 0; i < 35; i++) {
    const evaluated = await page.evaluate(COLLECT_POSTS) as unknown;
    if (!Array.isArray(evaluated)) throw new Error("Threads returned an invalid posts collection");
    const current = evaluated as Post[];
    let added = 0;
    for (const post of current) {
      if (!post || typeof post.text !== "string") continue;
      const value = { ...post, text: cleanPostText(post.text) };
      if (value.text.length < 15 && !value.has_image && !value.has_video) continue;
      const key = value.text.slice(0, 120) + (value.has_image ? "_img" : "") + (value.has_video ? "_vid" : "");
      if (!seen.has(key)) { seen.add(key); all.push(value); added++; }
    }
    if (all.length >= target) break;
    stall = added ? 0 : stall + 1;
    if (stall >= 6) break;
    await page.evaluate(() => window.scrollBy(0, 1100));
    await sleep(2300);
  }
  return all.slice(0, target);
}

async function checkProfile(page: Page, env: Env, username: string): Promise<ThreadsStatus | null> {
  await page.goto(`${BASE(env)}/@${username}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(4000);
  const body = await page.locator("body").innerText().catch(() => "");
  if (["Page not found", "Страница не найдена", "isn't available", "недоступна"].some(x => body.includes(x))) return "user_not_found";
  if (page.url().includes("login")) return "session_expired";
  await page.waitForSelector("span[dir='auto'],div[dir='auto']", { timeout: 15_000 }).catch(() => {});
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

export async function fetchPosts(env: Env, username: string, mode: "text" | "img", amount = 20): Promise<{ data: Post[] | null; status: ThreadsStatus; account?: string }> {
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
      return { data: null, status: "service_error", account: account.name };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}

async function collectComments(page: Page, target = 20): Promise<Comment[]> {
  const result: Comment[] = [], seen = new Set<string>();
  let stall = 0;
  await sleep(3000);
  for (let attempt = 0; attempt < 20; attempt++) {
    const evaluated = await page.evaluate(() => {
      const out: any[] = [];
      for (const container of document.querySelectorAll('div[data-pressable-container="true"]')) {
        const top = (container as HTMLElement).getBoundingClientRect().top + window.scrollY;
        const link = container.querySelector('a[href^="/@"][role="link"]');
        const match = (link?.getAttribute("href") || "").match(/\/@([A-Za-z0-9._]+)/);
        const author = match ? "@" + match[1].toLowerCase() : "—";
        let text = "";
        for (const span of container.querySelectorAll('span[dir="auto"]')) {
          const value = ((span as HTMLElement).innerText || "").trim();
          if (!value || value.length < 3 || value.toLowerCase() === author.replace("@", "") || /^(Follow|Подписаться|Translate|Перевести|Reply|Ответ|Repost|Share|Send|Like|More|Verified|See translation|Автор|Author|Ещё|Нравится|Поделиться)$/i.test(value) || /^\d+$/.test(value) || /^\d+\s*[hHчмсmsdд]$/.test(value)) continue;
          if (value.length > text.length) text = value;
        }
        if (text && /[A-Za-zА-Яа-яÀ-ÿ\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff]/.test(text)) out.push({ author, text, top });
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
    if (stall >= 3) break;
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(2500);
  }
  return result.slice(0, target);
}

export async function fetchComments(env: Env, username: string, index: number, amount = 20): Promise<{ data: Comment[] | null; status: ThreadsStatus; account?: string }> {
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
      return { data: null, status: "service_error", account: account.name };
    } finally {
      await closeBrowser(env, opened);
    }
  }
}
/** Сброс всех аккаунтов в alive=1 */
export async function resetAccountStatuses(env: Env) {
  const result = await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,updated_at=? WHERE enabled=1").bind(iso()).run();
  return Number(result.meta.changes || 0);
}

/** Проверка одного аккаунта */
export async function probeAccount(env: Env, name: string): Promise<{ name: string; ok: boolean; message: string }> {
  const account = await env.DB.prepare("SELECT name,cookies,hourly_requests,hourly_reset FROM threads_accounts WHERE name=? AND enabled=1").bind(name).first<Account>();
  if (!account) return { name, ok: false, message: "Account is disabled or missing" };
  let opened: Opened | undefined;
  try {
    opened = await openBrowser(env, account);
    await opened.page.goto(`${BASE(env)}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(3000);
    if (opened.page.url().includes("login")) {
      await markSessionExpired(env, name);
      return { name, ok: false, message: "Session expired" };
    }
    const updated = keepSessionCookies(JSON.stringify(await opened.context.cookies()));
    if (updated) {
      await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,cookies=?,updated_at=? WHERE name=?").bind(updated, iso(), name).run();
    } else {
      await env.DB.prepare("UPDATE threads_accounts SET is_alive=1,last_error=NULL,updated_at=? WHERE name=?").bind(iso(), name).run();
    }
    return { name, ok: true, message: "Session is valid" };
  } catch (error) {
    await markTransientError(env, name, error);
    return { name, ok: false, message: error instanceof BrowserBusyError ? "Browser Run is busy; retry later" : (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  } finally {
    await closeBrowser(env, opened);
  }
}
