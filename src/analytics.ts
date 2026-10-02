/**
 * Честная веб-аналитика (с pr65).
 *
 * Принципы:
 *  - Учитываем запрос ДО отдачи из Edge-кэша. Раньше всё, что отдавал кэш, в статистику не попадало.
 *  - Одно открытие страницы = одно событие просмотра и одна страна (раньше страница + API давали две).
 *  - Роботы делятся на поисковых, превью ссылок (Telegram/WhatsApp/...), ИИ-краулеров, скрипты и мониторинг.
 *  - Уникальные посетители считаются по суточному хешу IP+UA (сам IP не хранится).
 *  - «Подтверждённые люди» - браузеры, которые выполнили JS страницы и прислали beacon /api/hit.
 *  - Трафик из дата-центров (VPN, облака) не выкидывается, а показывается отдельно:
 *    для аудитории из РФ значимая часть людей ходит через VPN.
 */
import type { Env } from "./config";
import { detectBotType } from "./profile";

export type TrafficKind = "human" | "search" | "preview" | "ai" | "script" | "monitor" | "other";

export interface TrafficClass {
  kind: TrafficKind;
  /** Имя робота для разбивки в админке; для людей пусто */
  name: string;
}

const PREVIEW_BOTS: Array<[RegExp, string]> = [
  [/telegrambot/i, "Telegram (превью)"],
  [/whatsapp/i, "WhatsApp (превью)"],
  [/facebookexternalhit|meta-externalagent|meta-externalfetcher|facebookcatalog/i, "Meta (превью)"],
  [/twitterbot/i, "X/Twitter (превью)"],
  [/vkshare|vk\.com\/dev\/share/i, "VK (превью)"],
  [/slackbot|slack-imgproxy/i, "Slack (превью)"],
  [/discordbot/i, "Discord (превью)"],
  [/viber/i, "Viber (превью)"],
  [/skypeuripreview/i, "Skype (превью)"],
  [/linkedinbot/i, "LinkedIn (превью)"],
  [/pinterest/i, "Pinterest (превью)"],
  [/redditbot/i, "Reddit (превью)"],
  [/embedly|iframely|outbrain|quora link preview/i, "Превью ссылок"],
];

const AI_BOTS: Array<[RegExp, string]> = [
  [/gptbot|chatgpt-user|oai-searchbot/i, "OpenAI"],
  [/claudebot|claude-web|anthropic-ai/i, "Anthropic"],
  [/perplexitybot|perplexity-user/i, "Perplexity"],
  [/ccbot/i, "CommonCrawl"],
  [/amazonbot/i, "Amazonbot"],
  [/bytespider/i, "Bytespider"],
  [/applebot/i, "Applebot"],
  [/google-extended|googleother/i, "Google AI"],
  [/cohere-ai|diffbot|youbot|timpibot|imagesiftbot/i, "ИИ-краулер"],
];

const SCRIPT_UA = /\b(curl|wget|python-requests|python-urllib|python\/|aiohttp|httpx|go-http-client|axios|node-fetch|undici|okhttp|java\/|apache-httpclient|libwww-perl|scrapy|httpclient|postmanruntime|insomnia|phantomjs|headlesschrome|puppeteer|playwright|selenium|guzzlehttp|ruby|php\/|dart:io|reqwest|winhttp)\b/i;
const MONITOR_UA = /uptimerobot|pingdom|statuscake|betteruptime|better-uptime|site24x7|newrelicpinger|datadog|checkly|uptime-kuma|hetrixtools|freshping|cron-job\.org/i;

/** Классификация трафика ТОЛЬКО для статистики. Rate-limit по-прежнему опирается на detectBotType. */
export function classifyTraffic(ua: string): TrafficClass {
  const s = (ua || "").trim();
  if (!s) return { kind: "script", name: "Пустой User-Agent" };
  for (const [re, name] of PREVIEW_BOTS) if (re.test(s)) return { kind: "preview", name };
  for (const [re, name] of AI_BOTS) if (re.test(s)) return { kind: "ai", name };
  if (MONITOR_UA.test(s)) return { kind: "monitor", name: "Мониторинг аптайма" };
  const search = detectBotType(s);
  if (search && search !== "Bot") return { kind: "search", name: search };
  if (SCRIPT_UA.test(s)) {
    const m = s.match(SCRIPT_UA);
    return { kind: "script", name: `Скрипт (${(m?.[1] || "http").toLowerCase()})` };
  }
  if (search === "Bot") return { kind: "other", name: "Прочие боты" };
  // Настоящие браузеры всегда начинают UA с Mozilla/ (или Opera/ у совсем старых)
  if (!/^(mozilla|opera)\//i.test(s)) return { kind: "script", name: "Нестандартный клиент" };
  return { kind: "human", name: "" };
}

const DATACENTER_ORGS = [
  "amazon", "aws", "google cloud", "google llc", "microsoft", "azure", "digitalocean", "hetzner", "ovh",
  "linode", "akamai", "vultr", "choopa", "oracle", "alibaba", "tencent", "contabo", "scaleway", "online s.a.s",
  "leaseweb", "m247", "datacamp", "cdn77", "hostinger", "ionos", "selectel", "timeweb", "aeza", "servers.com",
  "psychz", "colocrossing", "quadranet", "g-core", "gcore", "zenlayer", "huawei cloud", "cloudflare", "hostkey",
  "firstbyte", "stark industries", "pq hosting", "ishosting", "frantech", "buyvm", "racknerd", "hostwinds",
  "kamatera", "upcloud", "netcup", "ihor", "melbicom", "clouvider", "packethub", "proton", "nordvpn", "mullvad",
  "surfshark", "expressvpn", "private internet access", "hide.me", "windscribe",
];

/** Провайдер IP похож на дата-центр/VPN (по полю cf.asOrganization). */
export function isDatacenterOrg(org: string | undefined | null): boolean {
  const o = String(org || "").toLowerCase();
  if (!o) return false;
  return DATACENTER_ORGS.some((k) => o.includes(k));
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Суточный обезличенный идентификатор посетителя: сам IP в базу не попадает. */
export async function visitorId(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0";
  const ua = request.headers.get("user-agent") || "";
  const day = new Date().toISOString().slice(0, 10);
  const salt = env.WEBHOOK_SECRET || env.TELEGRAM_TOKEN || "threadsviewer";
  return (await sha256Hex(`${ip}|${ua}|${day}|${salt}`)).slice(0, 16);
}

export type PageKind = "home" | "profile" | "post" | "api" | "comments" | "more";

async function insertEvents(env: Env, rows: Array<[string, string]>): Promise<void> {
  if (!env.DB?.prepare || !rows.length) return;
  const ts = new Date().toISOString();
  const stmts = rows.map(([type, data]) =>
    env.DB.prepare("INSERT INTO user_events(user_id,event_type,event_data,timestamp) VALUES(0,?,?,?)").bind(type, data, ts)
  );
  try {
    if (typeof (env.DB as any).batch === "function") await env.DB.batch(stmts);
    else for (const s of stmts) await s.run();
  } catch {
    // статистика никогда не должна ломать ответ пользователю
  }
}

/**
 * Учёт одного запроса к сайту. Возвращает класс трафика, чтобы вызывающий код
 * мог дальше вести себя как раньше (логи, исключения для поисковиков).
 *
 * События (только с pr65):
 *   web_pv      kind            - просмотр страницы человеком (home|profile|post)
 *   web_geo     country         - страна, ОДНА на просмотр страницы
 *   web_uv      visitorId       - для подсчёта уникальных посетителей (DISTINCT)
 *   web_dc      asOrganization  - просмотр человеком из дата-центра/VPN
 *   web_robot   kind:name:page  - любой не-человек
 * Старые события web_api / web_comments / web_bot_crawl продолжают писаться вызывающим кодом.
 */
export async function trackRequest(
  env: Env,
  request: Request,
  page: PageKind,
  country: string
): Promise<TrafficClass> {
  const ua = request.headers.get("user-agent") || "";
  const cls = classifyTraffic(ua);
  const rows: Array<[string, string]> = [];
  if (cls.kind !== "human") {
    rows.push(["web_robot", `${cls.kind}:${cls.name}:${page}`]);
  } else if (page === "home" || page === "profile" || page === "post") {
    rows.push(["web_pv", page]);
    rows.push(["web_geo", (country || "XX").toUpperCase()]);
    rows.push(["web_uv", await visitorId(request, env)]);
    const org = String((request as any).cf?.asOrganization || "");
    if (isDatacenterOrg(org)) rows.push(["web_dc", org.slice(0, 80)]);
  }
  await insertEvents(env, rows);
  return cls;
}

/** beacon /api/hit: браузер выполнил JS страницы - сильный признак живого человека. */
export async function trackJsBeacon(env: Env, request: Request): Promise<boolean> {
  const cls = classifyTraffic(request.headers.get("user-agent") || "");
  if (cls.kind !== "human") return false;
  await insertEvents(env, [["web_js", await visitorId(request, env)]]);
  return true;
}

/** Итог запуска скрапера: kind|status|posts|ms */
export async function trackScrape(env: Env, kind: "profile" | "more" | "comments", status: string, posts: number, ms: number): Promise<void> {
  await insertEvents(env, [["scrape", `${kind}|${status}|${Math.max(0, posts | 0)}|${Math.max(0, Math.round(ms))}`]]);
}

/** Медиана, p95 и т.п. по уже отсортированному массиву. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
