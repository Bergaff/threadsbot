import { handleAdminRoute, verifyAdmin } from "./admin";
import { handleStatsRoute } from "./statsPage";
import { FAVICON_SVG, FAVICON_ICO_BASE64, FAVICON_DATA_URL } from "./assets";
import { matchEdgeCache, putEdgeCache } from "./cache";
import { Bot } from "./bot";
import { adminIds, type Env } from "./config";
import { Database } from "./db";
import { diagnoseAccountCookies } from "./cookies";
import { Telegram, type TelegramUpdate } from "./telegram";
import { fetchComments, fetchProfileWithPosts, logSystem, probeAccount, refreshAccountCookies, sleep, type ProfileData, type Comment } from "./threads";

/** Сколько аккаунтов прогревать за один запуск cron, чтобы не выбирать лимит Browser Rendering. */
const KEEPALIVE_BATCH = 3;
import { verifyAuthToken } from "./auth";
import { detectBotType, mergePostLists } from "./profile";
import { classifyTraffic, trackJsBeacon, trackRequest, trackScrape, type PageKind, type TrafficClass } from "./analytics";
import {
  detectLanguage,
  esc,
  handleImageProxy,
  POPULAR_CREATORS,
  renderHomePage,
  renderNotFoundPage,
  renderPrivacyPage,
  renderProfilePage,
  renderRobotsTxt,
  renderSitemap,
  renderTermsPage,
  renderFallbackScript,
} from "./web";
import { createJhpayPayment } from "./payment";

/**
 * Быстрые апдейты обрабатываются прямо в fetch() (через ctx.waitUntil, чтобы Telegram
 * получил 200 моментально). Всё, что требует браузера (посты/скрины/комментарии),
 * уходит в Queue — там строгая последовательность (max_concurrency=1),
 * чтобы аккаунты не пересекались.
 */
function needsBrowser(update: TelegramUpdate): boolean {
  // Только реплай на сообщение бота = запрос комментариев (нужен браузер).
  if (update.message?.reply_to_message?.from?.is_bot) return true;

  // Кнопки: text:/img: (посты) и cmt: (комментарии) — браузерная работа.
  // adm:probe:<name> тоже вызывает браузер для проверки одного аккаунта.
  const data = update.callback_query?.data || "";
  if (!data) return false;
  if (data.startsWith("text:") || data.startsWith("img:")) return true;
  if (data.startsWith("cmt:")) return true;
  if (data.startsWith("adm:probe:")) return true;
  return false;
}

function chatIdOf(update: TelegramUpdate): number | undefined {
  return update.callback_query?.message?.chat.id ?? update.message?.chat.id;
}

const ipScraperLimits = new Map<string, { count: number; resetAt: number }>();
const inFlightProfileFetches = new Map<string, Promise<{ data: ProfileData | null; status: any; account?: string; error?: string }>>();

function isValidThreadsUsername(u: string): boolean {
  if (!u || u.length < 1 || u.length > 30) return false;
  if (!/^[A-Za-z0-9._]+$/.test(u)) return false;
  if (u.includes("..") || u.startsWith(".") || u.endsWith(".")) return false;
  if (/\.(php|html|xml|txt|json|env|asp|aspx|jsp|js|css)$/i.test(u)) return false;
  return true;
}

function checkScraperRateLimit(ip: string, limit = 20, windowMs = 300_000): { allowed: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  if (ipScraperLimits.size > 2000) {
    for (const [k, v] of ipScraperLimits.entries()) {
      if (now > v.resetAt) ipScraperLimits.delete(k);
    }
  }
  const entry = ipScraperLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipScraperLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
  entry.count++;
  return { allowed: true, remaining: limit - entry.count, retryAfter: 0 };
}

async function notifyError(env: Env, error: unknown) {
  console.error(error);
  const telegram = new Telegram(env.TELEGRAM_TOKEN);
  const value = `🚨 <b>ALERT</b>\n\nBot error: ${String(error).slice(0, 500)}`;
  await Promise.all(
    adminIds(env).map(id => telegram.sendMessage(id, value).catch(() => {})),
  );
}

const SEARCH_ENGINES_NO_LIMIT = new Set(["Googlebot", "YandexBot", "Bingbot", "DuckDuckBot", "Baiduspider"]);
const MORE_POSTS_STEP = 20;
const MORE_POSTS_MAX = 100;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const reqStart = Date.now();
    const url = new URL(request.url);
    const lowerPath = url.pathname.toLowerCase();

    // ==========================================
    // ВЕРИФИКАЦИЯ МЕРЧАНТА / КАССЫ / MITGO (ФАЙЛОВАЯ)
    // ==========================================
    if (
      lowerPath === "/7d97667a3e056acab9aaf653807b4a03" ||
      lowerPath === "/7d97667a3e056acab9aaf653807b4a03.txt" ||
      lowerPath === "/7d97667a3e056acab9aaf653807b4a03.html"
    ) {
      return new Response("7d97667a3e056acab9aaf653807b4a03", {
        status: 200,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      });
    }

    if (
      lowerPath === "/29cab922-c980-4a1e-befe-778cda341cad" ||
      lowerPath === "/29cab922-c980-4a1e-befe-778cda341cad.txt" ||
      lowerPath === "/29cab922-c980-4a1e-befe-778cda341cad.html"
    ) {
      return new Response("29cab922-c980-4a1e-befe-778cda341cad", {
        status: 200,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      });
    }

    // ==========================================
    // FALLBACK-СКРИПТ РЕКЛАМНОЙ СЕТИ
    // Сеть подгружает его, когда ей нечего показать. Отдаём безобидную заглушку.
    // Стоит в самом начале: до аналитики, антибот-фильтра и профильных роутов.
    // ==========================================
    if (lowerPath === "/fallback.js") {
      return renderFallbackScript(request);
    }

    // ==========================================
    // ПЛАТЕЖНЫЕ ОПОВЕЩЕНИЯ (Kassa / Webhook / result.php)
    // ==========================================
    if (lowerPath === "/result.php" || lowerPath === "/api/payment/callback") {
      try {
        const clientIp = request.headers.get("cf-connecting-ip") || "";
        const params: Record<string, any> = {};
        for (const [k, v] of url.searchParams.entries()) {
          params[k.toLowerCase()] = v;
        }

        if (request.method === "POST") {
          const contentType = request.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const json = await request.json<Record<string, any>>().catch(() => ({}));
            if (json && typeof json === "object") {
              for (const [k, v] of Object.entries(json)) {
                params[k.toLowerCase()] = v;
              }
            }
          } else if (
            contentType.includes("application/x-www-form-urlencoded") ||
            contentType.includes("multipart/form-data")
          ) {
            const formData = await request.formData().catch(() => null);
            if (formData) {
              for (const [k, v] of formData.entries()) {
                params[k.toLowerCase()] = typeof v === "string" ? v : v.name;
              }
            }
          } else {
            const text = await request.text().catch(() => "");
            if (text) {
              try {
                const json = JSON.parse(text) as Record<string, any>;
                if (json && typeof json === "object") {
                  for (const [k, v] of Object.entries(json)) {
                    params[k.toLowerCase()] = v;
                  }
                }
              } catch {
                const searchParams = new URLSearchParams(text);
                for (const [k, v] of searchParams.entries()) {
                  params[k.toLowerCase()] = v;
                }
              }
            }
          }
        }

        console.log(`[Payment Webhook] IP: ${clientIp}, method: ${request.method}, params:`, JSON.stringify(params));

        // Если передан идентификатор пользователя (uid) через data или order_id
        const rawData = String(params.data || params.custom || "");
        const rawOrder = String(params.order_id || params.orderid || "");
        const amount = Number(params.amount || params.in_amount || 0);

        let uid = 0;
        let days = 30;

        try {
          const cleanJson = rawData.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
          const parsed = JSON.parse(cleanJson);
          if (parsed && typeof parsed === "object") {
            if (parsed.uid) uid = parseInt(parsed.uid, 10);
            if (parsed.days) days = parseInt(parsed.days, 10);
          }
        } catch {
          // Fallback parsing below
        }

        if (!uid) {
          const uidMatch = rawData.match(/["']?uid["']?[:_]?(\d+)/i) || rawOrder.match(/^(\d+)(?:_(\d+))?$/);
          if (uidMatch) {
            uid = parseInt(uidMatch[1], 10);
            if (uidMatch[2]) days = parseInt(uidMatch[2], 10);
          }
        }

        if (uid > 0 && env.DB && typeof env.DB.prepare === "function") {
          const db = new Database(env);
          await db.activate(uid, "kassa", amount, days);
          console.log(`[Payment Webhook] Activated subscription for user ${uid}, days: ${days}, amount: ${amount}`);
          if (env.TELEGRAM_TOKEN) {
            try {
              const tg = new Telegram(env.TELEGRAM_TOKEN);
              await tg.sendMessage(uid, `🎉 <b>Оплата успешно получена!</b>\n\nПодписка активирована на ${days} дн.`);
            } catch (e) {
              console.error("[Payment Webhook] Failed to notify user:", e);
            }
          }
        }

        return new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain; charset=UTF-8" },
        });
      } catch (err) {
        console.error("[Payment Webhook] Error processing result.php:", err);
        return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=UTF-8" } });
      }
    }

    // ==========================================
    // ФИЛЬТРАЦИЯ БОТ-СКАНЕРОВ (WordPress, PHP, .env и т.д.)
    // ==========================================
    if (
      (lowerPath.endsWith(".php") && lowerPath !== "/result.php") ||
      lowerPath.endsWith(".asp") ||
      lowerPath.endsWith(".aspx") ||
      lowerPath.endsWith(".jsp") ||
      lowerPath.endsWith(".env") ||
      lowerPath.startsWith("/wp-") ||
      lowerPath === "/xmlrpc" ||
      lowerPath === "/feed" ||
      lowerPath === "/rss" ||
      lowerPath === "/atom" ||
      lowerPath === "/actuator" ||
      lowerPath === "/ads.txt"
    ) {
      return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }

    // ==========================================
    // ВЕБ-АДМИНКА (СТАТУС БОТОВ, АККАУНТЫ, ПАРОЛЬ)
    // ==========================================
    if (url.pathname.startsWith("/admin")) {
      return handleAdminRoute(request, env);
    }

    // Страница статистики для рекламодателей (отдельный логин/пароль, не считается в статистике)
    if (lowerPath === "/stats" || lowerPath.startsWith("/stats/")) {
      return handleStatsRoute(request, env);
    }

    // ==========================================
    // ОНЛАЙН-ОПЛАТА ПОДПИСКИ (ВРЕМЕННО НА ОБНОВЛЕНИИ)
    // ==========================================
    if (lowerPath === "/pay" || lowerPath === "/buy" || lowerPath === "/order") {
      const tgUsername = env.BOT_USERNAME || "threadsreaderbot";
      const isEn = detectLanguage(request) === "en" || url.searchParams.get("lang") === "en";
      return new Response(
        `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'ru'}">
<head>
  <meta charset="utf-8">
  <title>${isEn ? 'Subscription - Threads Viewer' : 'Оплата подписки - Threads Viewer'}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #131722; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #1e293b; border: 1px solid #3b82f6; padding: 28px; max-width: 520px; text-align: left; }
    h1 { font-size: 1.25rem; margin-top: 0; color: #fff; }
    p { color: #cbd5e1; font-size: 0.92rem; line-height: 1.5; margin: 10px 0; }
    .btn { display: inline-block; background: #2563eb; color: #fff; padding: 10px 20px; text-decoration: none; font-weight: 700; margin-top: 14px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${isEn ? 'Payment gateway update in progress' : 'Обновление платёжной системы'}</h1>
    <p>${isEn ? 'Direct online card payments are temporarily paused while we connect a new payment provider.' : 'Прямая оплата картами на сайте временно приостановлена в связи с подключением новой платёжной системы.'}</p>
    <p>${isEn ? 'You can instantly activate your subscription and ad-free access via our Telegram bot with Telegram Stars or Crypto:' : 'Вы можете моментально оформить подписку и отключить рекламу через нашего Telegram-бота с помощью Telegram Stars или криптовалюты:'}</p>
    <div style="margin-top:16px;">
      <a href="https://t.me/${esc(tgUsername)}?start=web_adfree" class="btn">${isEn ? 'Open Telegram Bot' : 'Перейти в Telegram-бота'}</a>
    </div>
    <div style="margin-top: 18px;"><a href="/" style="color:#93c5fd;font-size:0.84rem;">&larr; ${isEn ? 'Back to homepage' : 'Вернуться на сайт'}</a></div>
  </div>
</body>
</html>`,
        { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } }
      );
    }

    // ==========================================
    // ТЕЛЕГРАМ БОТ И СИСТЕМНЫЕ ЭНДПОИНТЫ
    // ==========================================
    if (url.pathname === "/health") {
      const accounts = await new Database(env).accountCounts();
      return Response.json({
        ok: true,
        version: env.VERSION || "unknown",
        accounts,
        queue: Boolean(env.UPDATES),
        browser: Boolean(env.BROWSER),
      });
    }

    if (url.pathname === "/setup-webhook") {
      const auth = request.headers.get("authorization");
      const secretParam = url.searchParams.get("secret");
      const isAuth = auth === `Bearer ${env.WEBHOOK_SECRET}` || secretParam === env.WEBHOOK_SECRET;
      if (!isAuth) {
        return Response.json({
          ok: false,
          error: "Unauthorized. Pass ?secret=YOUR_WEBHOOK_SECRET in URL or Authorization: Bearer <secret>"
        }, { status: 401 });
      }
      const dropPending = url.searchParams.get("drop_pending") === "1" || url.searchParams.get("drop") === "true";
      const webhook = `${url.origin}/telegram/${env.WEBHOOK_SECRET}`;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhook,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query", "pre_checkout_query"],
          drop_pending_updates: dropPending,
        }),
      });
      const data = await response.json<any>();
      return Response.json({
        ok: Boolean(data.ok),
        registered_url: webhook,
        drop_pending_updates: dropPending,
        telegram_response: data
      });
    }

    if (url.pathname.startsWith("/telegram/")) {
      const pathSecret = url.pathname.slice("/telegram/".length).replace(/\/$/, "");
      const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
      const isAuthorized = pathSecret === env.WEBHOOK_SECRET || headerSecret === env.WEBHOOK_SECRET;
      if (!isAuthorized) {
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const update = await request.json<TelegramUpdate>();

      if (needsBrowser(update)) {
        ctx.waitUntil((async () => {
          const tg = new Telegram(env.TELEGRAM_TOKEN);
          const chatId = chatIdOf(update);
          if (update.callback_query?.id) {
            await tg.answerCallbackQuery(update.callback_query.id).catch(() => {});
          }
          if (chatId) await tg.sendChatAction(chatId, "typing").catch(() => {});
          try {
            if (!env.UPDATES) throw new Error("UPDATES queue binding missing");
            await env.UPDATES.send(update);
          } catch (err) {
            await notifyError(env, err);
            if (chatId) {
              await tg.sendMessage(
                chatId,
                "❌ Очередь Cloudflare не приняла запрос.\n\n" +
                "Чтение постов требует <b>Workers Paid</b> ($5/мес): Queues + Browser Rendering.\n" +
                "На Free плане кнопки «Текст/Скрины» не могут открыть Threads.\n\n" +
                `<code>${String(err).slice(0, 200)}</code>`,
              ).catch(() => {});
            }
          }
        })());
      } else {
        ctx.waitUntil(
          (async () => {
            try { await new Bot(env).update(update); }
            catch (error) { await notifyError(env, error); }
          })(),
        );
      }

      return new Response("OK");
    }

    // ==========================================
    // ВЕБ-САЙТ И ЗЕРКАЛО ДЛЯ БРАУЗЕРА (БЕЗ VPN)
    // ==========================================

    const lang = detectLanguage(request);
    const country = (request.headers.get("cf-ipcountry") || (request as any).cf?.country || "").toUpperCase();

    /**
     * Единая точка учёта запроса к сайту. Вызывается ДО отдачи из Edge-кэша,
     * иначе просмотры, отданные кэшем, в статистику не попадают (так было до pr65).
     */
    const trackSite = async (page: PageKind, tag: string, label: string): Promise<{ isAdmin: boolean; cls: TrafficClass }> => {
      const isAdmin = await verifyAdmin(request, env);
      const cls = classifyTraffic(request.headers.get("user-agent") || "");
      if (!isAdmin) {
        ctx.waitUntil(trackRequest(env, request, page, country));
        if (cls.kind !== "human") {
          ctx.waitUntil(logSystem(env, "info", "web", `[BOT_CRAWL] ${cls.name}: ${label}`).catch(() => {}));
        } else if (tag) {
          ctx.waitUntil(logSystem(env, "info", "web", `[${tag}] ${label} (человек, ${country || "unknown"})`).catch(() => {}));
        }
      }
      return { isAdmin, cls };
    };
    /** Время ответа сервера - только для людей и только когда ответ не из Edge-кэша. */
    const trackLatency = (isAdmin: boolean, cls: TrafficClass) => {
      if (isAdmin || cls.kind !== "human") return;
      ctx.waitUntil(new Database(env).logEvent(0, "web_ms", String(Date.now() - reqStart)).catch(() => {}));
    };

    // Beacon: страница выполнила JS в браузере - подтверждённый живой посетитель
    if (url.pathname === "/api/hit") {
      if (request.method === "POST" && !(await verifyAdmin(request, env))) {
        ctx.waitUntil(trackJsBeacon(env, request).catch(() => false));
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    async function checkPremiumUser(req: Request, e: Env): Promise<{ isPremium: boolean; newAuthCookie?: string }> {
      const u = new URL(req.url);
      const authQuery = u.searchParams.get("auth");
      const cookieHeader = req.headers.get("cookie") || "";
      const cookieMatch = cookieHeader.match(/(?:^|;\s*)threads_auth=([A-Za-z0-9._]+)/);
      const authCookie = cookieMatch ? cookieMatch[1] : null;

      const candidate = authQuery || authCookie;
      if (!candidate) return { isPremium: false };

      const uid = await verifyAuthToken(candidate, e.WEBHOOK_SECRET);
      if (!uid) return { isPremium: false };

      const d = new Database(e);
      const sub = await d.subscription(uid);
      if (sub?.active) {
        const newAuthCookie = authQuery ? `threads_auth=${candidate}; Path=/; Max-Age=2592000; SameSite=Lax` : undefined;
        return { isPremium: true, newAuthCookie };
      }
      return { isPremium: false };
    }

    // Главная страница (включая языковые маршруты /ru, /ru/, /en, /en/)
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/ru" || url.pathname === "/ru/" || url.pathname === "/en" || url.pathname === "/en/") {
      const pageLang = url.pathname.startsWith("/en") ? "en" : (url.pathname.startsWith("/ru") ? "ru" : lang);
      const paymentParam = url.searchParams.get("payment");
      const paymentStatus = paymentParam === "success" ? "success" : (paymentParam === "fail" || paymentParam === "cancel" ? "fail" : null);

      const homeTrack = await trackSite("home", "WEB_VIEW", "Главная страница");
      if (!paymentStatus) {
        const edgeHit = await matchEdgeCache(request);
        if (edgeHit) return edgeHit;
      }

      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      trackLatency(homeTrack.isAdmin, homeTrack.cls);
      let res = renderHomePage(env, pageLang, isPremium, country, url.origin, paymentStatus);
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      } else if (!isPremium && !paymentStatus) {
        putEdgeCache(request, res, ctx, 300);
      }
      return res;
    }

    // Служебные страницы и SEO
    if (url.pathname === "/terms") {
      const res = renderTermsPage(lang, url.origin);
      putEdgeCache(request, res, ctx, 86400);
      return res;
    }
    if (url.pathname === "/privacy") {
      const res = renderPrivacyPage(lang, url.origin);
      putEdgeCache(request, res, ctx, 86400);
      return res;
    }
    if (url.pathname === "/robots.txt") {
      const res = renderRobotsTxt(url.origin);
      putEdgeCache(request, res, ctx, 86400);
      return res;
    }
    if (url.pathname === "/sitemap.xml") {
      const edgeHit = await matchEdgeCache(request);
      if (edgeHit) return edgeHit;

      let extraUsers: string[] = [];
      try {
        if (env.DB) {
          const rows = await env.DB.prepare(
            "SELECT DISTINCT username FROM cache WHERE mode='web_profile' ORDER BY cached_at DESC LIMIT 100"
          ).all<{ username: string }>();
          if (rows.results?.length) {
            extraUsers = rows.results.map((r: any) => r.username).filter(Boolean);
          }
        }
      } catch {}

      const defaultProfiles = [
        "durov", "mosseri", "zuck", "mrbeast", "openai", "techcrunch",
        "temalebedev", "wylsacom", "cristiano", "leomessi", "selenagomez",
        "kimkardashian", "billgates", "shakira", "nasa", "apple", "netflix",
        "mkbhd"
      ];
      const combined = Array.from(new Set([...defaultProfiles, ...extraUsers]));
      const res = renderSitemap(url.origin, combined);
      putEdgeCache(request, res, ctx, 3600);
      return res;
    }

    // Верификация поисковых систем (Яндекс.Вебмастер и Google Search Console)
    const yandexMatch = url.pathname.match(/^\/yandex_([a-zA-Z0-9]+)\.html$/);
    if (yandexMatch) {
      return new Response(
        `<html>\n    <head>\n        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">\n    </head>\n    <body>Verification: ${yandexMatch[1]}</body>\n</html>`,
        { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "public, max-age=86400" } }
      );
    }

    const googleMatch = url.pathname.match(/^\/(google([a-zA-Z0-9]+)\.html)$/);
    if (googleMatch) {
      return new Response(`google-site-verification: ${googleMatch[1]}`, {
        headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "public, max-age=86400" }
      });
    }

    // Иконки и фавиконы (пользовательский фавикон из репозитория)
    if (url.pathname === "/favicon.svg" || url.pathname === "/apple-touch-icon.png") {
      return new Response(FAVICON_SVG, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    if (url.pathname === "/favicon.ico") {
      const binStr = atob(FAVICON_ICO_BASE64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return new Response(bytes.buffer, {
        headers: {
          "content-type": "image/x-icon",
          "cache-control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    // OpenGraph превью-баннер главной страницы (1200x630) с пользовательским фавиконом и центрированной кнопкой
    if (url.pathname === "/og-image.svg" || url.pathname === "/og-image.png") {
      const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#0d0e10"/>
  <rect x="40" y="40" width="1120" height="550" fill="#141618" stroke="#2a2c30" stroke-width="2"/>
  <g transform="translate(100, 165)">
    <rect width="100" height="100" fill="#1e2024"/>
    <image href="${FAVICON_DATA_URL}" xlink:href="${FAVICON_DATA_URL}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/>
    <rect width="100" height="100" fill="none" stroke="#33363b" stroke-width="2"/>
  </g>
  <text x="230" y="220" fill="#ffffff" font-family="system-ui, Arial, sans-serif" font-size="52" font-weight="700">Threads Viewer</text>
  <text x="230" y="260" fill="#888888" font-family="system-ui, Arial, sans-serif" font-size="24">threadsviewer.online</text>
  <text x="100" y="360" fill="#dddddd" font-family="system-ui, Arial, sans-serif" font-size="34" font-weight="600">Смотреть и читать Threads без VPN</text>
  <text x="100" y="415" fill="#999999" font-family="system-ui, Arial, sans-serif" font-size="22">Анонимный онлайн-ридер профилей, постов и комментариев без регистрации.</text>
  <rect x="100" y="470" width="380" height="52" fill="#22252a" stroke="#3d424b" stroke-width="1"/>
  <text x="290" y="496" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="system-ui, Arial, sans-serif" font-size="20" font-weight="600">Быстрый поиск по @username</text>
</svg>`;
      return new Response(ogSvg, {
        headers: { "content-type": "image/svg+xml", "cache-control": "no-cache, no-store, must-revalidate" }
      });
    }

    // Прокси для изображений и видео (чтобы грузились без VPN в РФ)
    if (url.pathname === "/api/img" || url.pathname === "/api/media") {
      return handleImageProxy(request);
    }

    // Просмотр конкретного поста: /@username/post/:postId, /user/username/post/:postId, /profile/username/post/:postId
    const postMatch = url.pathname.match(/^\/(?:@|profile\/|user\/|u\/)?([A-Za-z0-9._]+)\/post\/([A-Za-z0-9._-]+)\/?$/);
    if (postMatch) {
      const username = postMatch[1].toLowerCase();
      const targetPostId = postMatch[2];
      const postTrack = await trackSite("post", "WEB_POST_VIEW", `Пост @${username}/post/${targetPostId}`);
      const edgeHit = await matchEdgeCache(request);
      if (edgeHit) return edgeHit;

      const db = new Database(env);
      trackLatency(postTrack.isAdmin, postTrack.cls);
      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      const cached = await db.cache<ProfileData>(username, "web_profile");
      let res = renderProfilePage(env, username, cached, null, lang, isPremium, country, targetPostId, url.origin);
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      } else if (cached && !isPremium) {
        putEdgeCache(request, res, ctx, 900);
      }
      return res;
    }

    // Просмотр профиля: /@username, /profile/username, /user/username, /u/username
    const profileMatch = url.pathname.match(/^\/(?:@|profile\/|user\/|u\/)([A-Za-z0-9._]+)\/?$/);
    if (profileMatch) {
      const username = profileMatch[1].toLowerCase();
      if (!isValidThreadsUsername(username)) {
        return renderNotFoundPage(lang, url.origin);
      }
      const profileTrack = await trackSite("profile", "WEB_VIEW", `Переход на @${username}`);
      const isAdmin = profileTrack.isAdmin;
      const edgeHit = await matchEdgeCache(request);
      if (edgeHit) return edgeHit;

      const db = new Database(env);
      trackLatency(profileTrack.isAdmin, profileTrack.cls);
      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("nocache") === "1";
      if (forceRefresh) {
        ctx.waitUntil(db.deleteCache(username, "web_profile").catch(() => {}));
      }
      const cached = forceRefresh ? null : await db.cache<any>(username, "web_profile");
      if (cached && Array.isArray(cached.posts)) {
        const cleanPosts = cached.posts.filter((p: any) => !p.author || p.author.toLowerCase() === username);
        if (cleanPosts.length !== cached.posts.length) {
          cached.posts = cleanPosts;
          if (cleanPosts.length === 0) {
            ctx.waitUntil(db.deleteCache(username, "web_profile").catch(() => {}));
          } else {
            ctx.waitUntil(db.setCache(username, "web_profile", cached).catch(() => {}));
          }
        }
      }
      const isNotFound = cached && (cached.notFound || cached.status === "user_not_found");
      const initialData = isNotFound ? null : (cached as ProfileData);
      const errorMsg = isNotFound ? (lang === "en" ? "Profile Not Found in Threads" : "Профиль не найден в Threads") : null;
      let res = renderProfilePage(env, username, initialData, errorMsg, lang, isPremium, country, undefined, url.origin);
      if (isNotFound) {
        res = new Response(res.body, {
          status: 404,
          headers: res.headers,
        });
      }
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      } else if (cached && !isPremium && !isNotFound) {
        putEdgeCache(request, res, ctx, 900);
      }
      return res;
    }

    // Прямой переход по никнейму без префикса (например, /zuck -> 301 редирект на /@zuck для популярных авторов)
    const directUserMatch = url.pathname.match(/^\/([A-Za-z0-9._]{1,40})\/?$/);
    if (directUserMatch) {
      const candidate = directUserMatch[1].toLowerCase();
      const isKnownCreator = candidate === "zuck" || POPULAR_CREATORS.some(c => c.username === candidate);
      if (isKnownCreator) {
        const target = `/@${candidate}${url.search}`;
        return Response.redirect(new URL(target, url.origin).toString(), 301);
      }
    }

    // API для получения данных профиля и постов (для "крутить как обычный тредс")
    if (url.pathname.startsWith("/api/profile/")) {
      const username = decodeURIComponent(url.pathname.slice("/api/profile/".length)).replace(/^@/, "").toLowerCase();
      if (!isValidThreadsUsername(username)) {
        return Response.json({ ok: false, error: "Некорректный username" }, { status: 400 });
      }

      const isMoreReq = url.searchParams.get("more") === "1";
      const apiTrack = await trackSite(isMoreReq ? "more" : "api", "API_REQ", isMoreReq ? `Загрузить ещё @${username}` : `Запрос профиля /api/profile/${username}`);
      const isAdmin = apiTrack.isAdmin;
      // Исключение из rate-limit - как и раньше, только для поисковых роботов по detectBotType
      const ua = request.headers.get("user-agent") || "";
      const botName = detectBotType(ua);
      // Без лимита - только крупные поисковики. Раньше исключение получал любой UA с "bot/" или "crawl"
      // (AhrefsBot, Semrush, самописные скрипты), и каждый такой запрос мог бесплатно жечь Browser Run.
      const isSearchBot = Boolean(botName && SEARCH_ENGINES_NO_LIMIT.has(botName));
      const db = new Database(env);
      if (!isAdmin && apiTrack.cls.kind === "human") {
        ctx.waitUntil(db.logEvent(0, isMoreReq ? "web_more" : "web_api", username).catch(() => {}));
      }

      const edgeHit = await matchEdgeCache(request);
      if (edgeHit) return edgeHit;

      // ==========================================
      // «ЗАГРУЗИТЬ ЕЩЁ ПОСТЫ»: /api/profile/:user?more=1&have=N
      // Клиент уже показал N постов. Возвращаем полный список, где первые N постов
      // идут в том же порядке, что и в кеше, а новые дописаны в конец - клиент
      // просто дорисует posts.slice(N). Если в кеше постов не больше N, запускаем
      // скрапер глубже (N + 20) и объединяем результат с кешем.
      // ==========================================
      if (url.searchParams.get("more") === "1") {
        const have = Math.max(0, Math.min(MORE_POSTS_MAX, parseInt(url.searchParams.get("have") || "0", 10) || 0));
        const noStore = { "cache-control": "no-store" };
        const cachedRaw = await db.cache<any>(username, "web_profile");
        const cachedOk = cachedRaw && !cachedRaw.notFound && cachedRaw.status !== "user_not_found" ? cachedRaw : null;
        const basePosts: any[] = Array.isArray(cachedOk?.posts)
          ? cachedOk.posts.filter((p: any) => !p.author || String(p.author).toLowerCase() === username)
          : [];

        if (basePosts.length > have) {
          await logSystem(env, "info", "api", `[API_MORE] @${username}: отдано из кеша ${basePosts.length - have} новых постов (было ${have})`);
          return Response.json({ ok: true, cached: true, profile: cachedOk?.profile || null, posts: basePosts, hasMore: true }, { headers: noStore });
        }
        // Конец ленты отмечаем ТОЛЬКО если его подтвердил сам Threads (has_next_page=false).
        // Старый флаг exhaustedAt (pr63) ставился по косвенным признакам и игнорируется.
        if (have >= MORE_POSTS_MAX || (cachedOk?.endReachedAt && Number(cachedOk.endReachedAt) >= have) || (cachedOk?.endReached === true && basePosts.length <= have)) {
          return Response.json({ ok: true, cached: true, profile: cachedOk?.profile || null, posts: basePosts, hasMore: false }, { headers: noStore });
        }

        if (!env.BROWSER) {
          return Response.json({ ok: false, error: "Сервис временно недоступен. Повторите попытку позже." }, { status: 503, headers: noStore });
        }
        const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
        const { isPremium: morePremium } = await checkPremiumUser(request, env);
        if (!isAdmin && !morePremium && !isSearchBot) {
          const rate = checkScraperRateLimit(clientIp, 20, 300_000);
          if (!rate.allowed) {
            return Response.json({
              ok: false,
              error: "Лимит запросов (20 за 5 минут) превышен. Повторите через пару минут или откройте профиль в Telegram-боте @threadsreaderbot.",
              retryAfter: rate.retryAfter,
            }, { status: 429, headers: { "Retry-After": String(rate.retryAfter), ...noStore } });
          }
        }

        const target = Math.min(MORE_POSTS_MAX, Math.max(have, basePosts.length) + MORE_POSTS_STEP);
        const flightKey = `${username}#more${target}`;
        let morePromise = inFlightProfileFetches.get(flightKey);
        if (!morePromise) {
          await logSystem(env, "info", "api", `[API_MORE] @${username}: догружаем посты (есть ${have}, цель ${target})`);
          morePromise = fetchProfileWithPosts(env, username, target);
          inFlightProfileFetches.set(flightKey, morePromise);
          morePromise.finally(() => inFlightProfileFetches.delete(flightKey));
        }
        try {
          const fresh = await morePromise;
          if (!isAdmin) {
            ctx.waitUntil(trackScrape(env, "more", fresh.status, fresh.data?.posts?.length || 0, Date.now() - reqStart).catch(() => {}));
          }
          if (fresh.status !== "ok" || !fresh.data) {
            await logSystem(env, "warn", "api", `[API_MORE] @${username}: скрапер вернул ${fresh.status}`);
            return Response.json({ ok: false, status: fresh.status, error: "Не удалось догрузить посты. Попробуйте ещё раз через минуту." }, { status: 502, headers: noStore });
          }
          if (fresh.data.source === "http") {
            // Браузерные аккаунты не сработали, а публичная HTML-страница не умеет листать ленту.
            await logSystem(env, "warn", "api", `[API_MORE] @${username}: браузер недоступен, HTTP-источник не листает ленту`);
            return Response.json({ ok: false, retry: true, error: "Сейчас не удалось догрузить посты. Попробуйте ещё раз через минуту." }, { status: 503, headers: noStore });
          }
          const freshPosts = (fresh.data.posts || []).filter((p: any) => !p.author || String(p.author).toLowerCase() === username);
          const merged = mergePostLists(basePosts, freshPosts);
          const added = merged.length - basePosts.length;
          const shownNew = Math.max(0, merged.length - have);
          const reachedEnd = fresh.data.endReached === true;
          const toCache: any = {
            ...(cachedOk || {}),
            ...fresh.data,
            profile: fresh.data.profile || cachedOk?.profile || null,
            posts: merged,
          };
          delete toCache.exhaustedAt;
          delete toCache.endReached;
          if (reachedEnd) toCache.endReachedAt = merged.length; else delete toCache.endReachedAt;
          await db.setCache(username, "web_profile", toCache);
          await logSystem(env, "info", "api", `[API_MORE] @${username}: +${added} в кеш, клиенту новых ${shownNew} (всего ${merged.length}, конец ленты подтверждён Threads: ${reachedEnd ? "да" : "нет"})`);
          return Response.json({
            ok: true,
            cached: false,
            profile: toCache.profile,
            posts: merged,
            // false - только когда Threads сам подтвердил конец ленты
            hasMore: !reachedEnd,
            notice: shownNew === 0 && !reachedEnd
              ? "Threads не успел отдать следующую порцию постов. Нажмите «Загрузить ещё» ещё раз."
              : undefined,
          }, { headers: noStore });
        } catch (error) {
          await logSystem(env, "error", "api", `[API_MORE] @${username}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
          return Response.json({ ok: false, error: "Не удалось догрузить посты. Попробуйте ещё раз через минуту." }, { status: 500, headers: noStore });
        }
      }

      // Сначала проверяем D1 кеш (включая отрицательный кеш)
      const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("nocache") === "1";
      if (forceRefresh) {
        ctx.waitUntil(db.deleteCache(username, "web_profile").catch(() => {}));
      }
      const cached = forceRefresh ? null : await db.cache<any>(username, "web_profile");
      if (cached) {
        trackLatency(isAdmin, apiTrack.cls);
        if (cached.notFound || cached.status === "user_not_found") {
          await logSystem(env, "info", "api", `[API_CACHE_NEGATIVE] Отдан кеш (не найден) для @${username}`);
          const res = Response.json({
            ok: false,
            cached: true,
            status: "user_not_found",
            error: "Профиль не найден в Threads",
          }, {
            status: 404,
            headers: {
              "cache-control": "public, max-age=900, s-maxage=900",
            },
          });
          putEdgeCache(request, res, ctx, 900);
          return res;
        }
        if (Array.isArray(cached.posts)) {
          const cleanPosts = cached.posts.filter((p: any) => !p.author || p.author.toLowerCase() === username);
          if (cleanPosts.length !== cached.posts.length) {
            cached.posts = cleanPosts;
            if (cleanPosts.length === 0) {
              ctx.waitUntil(db.deleteCache(username, "web_profile").catch(() => {}));
            } else {
              ctx.waitUntil(db.setCache(username, "web_profile", cached).catch(() => {}));
            }
          }
        }
        await logSystem(env, "info", "api", `[API_CACHE] Отдан кеш для @${username} (${cached.posts?.length || 0} постов)`);
        const res = Response.json({ ok: true, cached: true, ...cached }, {
          headers: {
            "cache-control": "public, max-age=600, s-maxage=900, stale-while-revalidate=1800",
          },
        });
        putEdgeCache(request, res, ctx, 900);
        return res;
      }

      // Если нет в кеше и есть браузер — запрашиваем
      if (!env.BROWSER) {
        await logSystem(env, "error", "api", `[API_ERROR] Browser Run (env.BROWSER) отсутствует`);
        return Response.json({ ok: false, error: "Сервис временно недоступен. Повторите попытку позже." }, { status: 503 });
      }

      const counts = await db.accountCounts();
      if (!counts.alive) {
        // РАНЬШЕ здесь был немедленный выход 503 с внутренним сообщением про cookies
        // и Telegram-бот. Это было вдвойне неправильно:
        //  1) пользователю показывались детали нашей инфраструктуры;
        //  2) выход случался ДО обращения к публичному HTTP-источнику, который умеет
        //     отдавать профиль и посты вообще без аккаунтов.
        // Поэтому просто логируем и идём дальше: скрапер сам дойдёт до HTTP-фолбэка.
        await logSystem(env, "warn", "api", `[API_NO_ACCOUNTS] @${username}: живых аккаунтов 0 из ${counts.total}, пробуем публичный HTTP-источник`);
      }

      // Защита от спам-парсинга: мягкий rate limit на чтение новых профилей с одного IP
      const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
      const { isPremium } = await checkPremiumUser(request, env);

      if (!isAdmin && !isPremium && !isSearchBot) {
        const rate = checkScraperRateLimit(clientIp, 20, 300_000);
        if (!rate.allowed) {
          await logSystem(env, "warn", "api", `[RATE_LIMIT] IP ${clientIp} превысил лимит скрапера для @${username}`);
          return Response.json({
            ok: false,
            error: "Лимит запросов к новым профилям (20 за 5 минут) превышен. Откройте профиль через Telegram-бота @threadsreaderbot или повторите через 2 минуты.",
            retryAfter: rate.retryAfter,
          }, {
            status: 429,
            headers: {
              "Retry-After": String(rate.retryAfter),
              "cache-control": "no-store",
            },
          });
        }
      }

      try {
        // Устранение дублирующих параллельных запросов (In-flight deduplication)
        let fetchPromise = inFlightProfileFetches.get(username);
        if (!fetchPromise) {
          await logSystem(env, "info", "api", `[API_FETCH] Запуск скрапера для @${username} (аккаунтов доступно: ${counts.alive})`);
          fetchPromise = fetchProfileWithPosts(env, username, 20);
          inFlightProfileFetches.set(username, fetchPromise);
          fetchPromise.finally(() => {
            inFlightProfileFetches.delete(username);
          });
        } else {
          await logSystem(env, "info", "api", `[API_DEDUP] Запрос @${username} подключен к текущему скраперу`);
        }

        const fetched = await fetchPromise;
        // Время, которое человек ждал первую загрузку профиля через браузер, - отдельная метрика
        if (!isAdmin) {
          ctx.waitUntil(trackScrape(env, "profile", fetched.status, fetched.data?.posts?.length || 0, Date.now() - reqStart).catch(() => {}));
        }
        await logSystem(env, "info", "api", `[API_RESULT] @${username}: status=${fetched.status}, постов=${fetched.data?.posts?.length || 0}`);
        if (fetched.status === "ok" && fetched.data) {
          if (Array.isArray(fetched.data.posts)) {
            fetched.data.posts = fetched.data.posts.filter((p: any) => !p.author || p.author.toLowerCase() === username);
          }
          await db.setCache(username, "web_profile", fetched.data);
          const res = Response.json({ ok: true, cached: false, ...fetched.data }, {
            headers: {
              "cache-control": "public, max-age=600, s-maxage=900, stale-while-revalidate=1800",
            },
          });
          putEdgeCache(request, res, ctx, 900);
          return res;
        }

        if (fetched.status === "user_not_found") {
          // Negative caching: кешируем "пользователь не найден" в D1 и на Edge
          await db.setCache(username, "web_profile", {
            notFound: true,
            status: "user_not_found",
            error: "Профиль не найден в Threads",
            profile: null,
            posts: [],
          });
          const res = Response.json({
            ok: false,
            cached: false,
            status: "user_not_found",
            error: "Профиль не найден в Threads",
          }, {
            status: 404,
            headers: {
              "cache-control": "public, max-age=120, s-maxage=120",
            },
          });
          putEdgeCache(request, res, ctx, 120);
          return res;
        }

        // Все остальные статусы (service_error, all_dead, browser_busy, no_posts...) -
        // это временные проблемы скрапера, а НЕ отсутствие профиля.
        // Их нельзя кешировать как 404, иначе пользователь застрянет на ложном "не найден".
        // Сообщения видны конечному пользователю, поэтому никаких внутренних деталей:
        // ни про "технические аккаунты", ни про cookies, ни про браузер, ни про бота.
        const transientMessage = fetched.status === "browser_busy"
          ? "Сервис сейчас обрабатывает другой запрос. Повторите попытку через 30 секунд."
          : "Не удалось получить данные из Threads. Повторите попытку через минуту.";
        await logSystem(env, "warn", "api", `[API_TRANSIENT] @${username}: status=${fetched.status}, отрицательный кеш НЕ записан`);
        return Response.json({
          ok: false,
          status: fetched.status,
          error: transientMessage,
          retryAfter: 60,
        }, {
          status: 503,
          headers: {
            "cache-control": "no-store, max-age=0",
          },
        });
      } catch (err) {
        await logSystem(env, "error", "api", `[API_EXCEPTION] Ошибка сбора @${username}: ${err}`);
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // API для комментариев поста
    const commentsMatch = url.pathname.match(/^\/api\/comments\/([A-Za-z0-9._]+)\/(\d+)$/);
    if (commentsMatch) {
      const username = commentsMatch[1].toLowerCase();
      const postIndex = Number(commentsMatch[2]);
      const refresh = url.searchParams.get("refresh") === "1";
      const cmtTrack = await trackSite("comments", "", `комментарии @${username}#${postIndex}`);
      const db = new Database(env);
      if (!cmtTrack.isAdmin && cmtTrack.cls.kind === "human") {
        ctx.waitUntil(db.logEvent(0, "web_comments", `${username}:${postIndex}`).catch(() => {}));
      }
      if (!refresh) {
        const edgeHit = await matchEdgeCache(request);
        if (edgeHit) return edgeHit;
      }
      const cacheKey = `${username}_cmt_${postIndex}`;
      if (!refresh) {
        const cached = await db.cache<Comment[]>(cacheKey, "comments");
        if (cached) {
          trackLatency(cmtTrack.isAdmin, cmtTrack.cls);
          const res = Response.json({ ok: true, cached: true, comments: cached }, {
            headers: {
              "cache-control": "public, max-age=900, s-maxage=1800, stale-while-revalidate=3600",
            },
          });
          putEdgeCache(request, res, ctx, 1800);
          return res;
        }
      }

      if (!env.BROWSER) {
        return Response.json({ ok: false, error: "Сервис временно недоступен. Повторите попытку позже." }, { status: 503 });
      }

      const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
      const { isPremium } = await checkPremiumUser(request, env);
      const isAuthAdmin = await verifyAdmin(request, env);
      if (!isAuthAdmin && !isPremium) {
        const rate = checkScraperRateLimit(clientIp + ":cmt", 25, 300_000);
        if (!rate.allowed) {
          return Response.json({
            ok: false,
            error: "Лимит запросов к комментариям превышен. Подождите пару минут или откройте пост в боте @threadsreaderbot.",
            retryAfter: rate.retryAfter,
          }, {
            status: 429,
            headers: {
              "Retry-After": String(rate.retryAfter),
              "cache-control": "no-store",
            },
          });
        }
      }

      try {
        const fetched = await fetchComments(env, username, postIndex, 30);
        if (!isAuthAdmin) {
          ctx.waitUntil(trackScrape(env, "comments", fetched.status, fetched.data?.length || 0, Date.now() - reqStart).catch(() => {}));
        }
        if (fetched.status === "ok" && fetched.data) {
          await db.setCache(cacheKey, "comments", fetched.data);
          const res = Response.json({ ok: true, cached: false, comments: fetched.data }, {
            headers: {
              "cache-control": "public, max-age=900, s-maxage=1800, stale-while-revalidate=3600",
            },
          });
          putEdgeCache(request, res, ctx, 1800);
          return res;
        }
        return Response.json({ ok: false, error: fetched.error || fetched.status });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // API для отправки формы поддержки с сайта
    if (url.pathname === "/api/support" && request.method === "POST") {
      try {
        const body = await request.json<any>().catch(() => ({}));
        const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
        const rawContact = typeof body.contact === "string" ? body.contact.trim().slice(0, 100) : "";
        const rawPath = typeof body.path === "string" ? body.path.trim().slice(0, 100) : "";

        if (!rawMessage || rawMessage.length < 3) {
          return Response.json({ ok: false, error: "Сообщение слишком короткое" }, { status: 400 });
        }

        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const countryCode = (request.headers.get("cf-ipcountry") || (request as any).cf?.country || "").toUpperCase();

        const db = new Database(env);
        const ticketId = await db.createTicket(
          0,
          rawContact || "web_guest",
          `[${countryCode || "GLOBAL"}] [${rawPath || "/"}] ${rawMessage}`,
          "web_support"
        );
        ctx.waitUntil(db.logEvent(0, "web_support", rawContact || "anonymous").catch(() => {}));

        // Отправка в Telegram всем администраторам
        if (env.TELEGRAM_TOKEN) {
          const tg = new Telegram(env.TELEGRAM_TOKEN);
          const aids = adminIds(env);
          const contactEsc = rawContact ? esc(rawContact) : "Не указан (без ответа)";
          const textLines = [
            `<b>[WEB SUPPORT] Новое обращение #${ticketId}</b>`,
            "",
            `<b>Контакты:</b> ${contactEsc}`,
            `<b>Страна / IP:</b> ${countryCode || "unknown"} (<code>${esc(ip)}</code>)`,
            rawPath ? `<b>Страница:</b> <code>${esc(rawPath)}</code>` : "",
            "",
            `<b>Вопрос:</b>`,
            esc(rawMessage.slice(0, 2500))
          ].filter(Boolean).join("\n");

          let replyKb: any = undefined;
          const tgMatch = rawContact.match(/^(?:@|https?:\/\/t\.me\/)?([A-Za-z0-9_]{4,32})$/);
          if (tgMatch) {
            replyKb = {
              inline_keyboard: [
                [{ text: `Написать @${tgMatch[1]}`, url: `https://t.me/${tgMatch[1]}` }]
              ]
            };
          }

          for (const aid of aids) {
            ctx.waitUntil(tg.sendMessage(aid, textLines, replyKb).catch(() => {}));
          }
        }

        return Response.json({ ok: true, ticketId });
      } catch (err: any) {
        return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
      }
    }

    return renderNotFoundPage(lang, url.origin);
  },

  async queue(batch: MessageBatch<TelegramUpdate>, env: Env) {
    for (const message of batch.messages) {
      const update = message.body;
      const existing = await env.DB
        .prepare("SELECT status, updated_at FROM processed_updates WHERE update_id=?")
        .bind(update.update_id)
        .first<{ status: string; updated_at: string }>();
      if (existing?.status === "done") { message.ack(); continue; }
      if (existing?.status === "processing") {
        // Повторная доставка того же update, пока браузер ещё работает — не шлём второй «⏳».
        message.ack();
        continue;
      }
      await env.DB
        .prepare("INSERT INTO processed_updates VALUES(?,'processing',?) ON CONFLICT(update_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at")
        .bind(update.update_id, new Date().toISOString())
        .run();
      try {
        await new Bot(env).update(update);
        await env.DB
          .prepare("UPDATE processed_updates SET status='done',updated_at=? WHERE update_id=?")
          .bind(new Date().toISOString(), update.update_id)
          .run();
        message.ack();
      } catch (error) {
        await env.DB
          .prepare("DELETE FROM processed_updates WHERE update_id=?")
          .bind(update.update_id)
          .run();
        await notifyError(env, error);
        message.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Техническая очистка + самодиагностика аккаунтов каждые 6 часов.
    ctx.waitUntil(
      (async () => {
        const db = new Database(env);
        await db.cleanup();
        const stats = await db.accountStats() as Array<{ name: string; is_alive: number; cookies: string }>;
        const issues: string[] = [];
        for (const a of stats) {
          const d = diagnoseAccountCookies(a.name, Boolean(a.is_alive), String(a.cookies || ""));
          if (d.issues.length) {
            issues.push(`${d.isAlive ? "🟢" : "🔴"} <b>${d.name}</b>: ${d.issues.join("; ")}`);
          }
        }
        if (issues.length) {
          const tg = new Telegram(env.TELEGRAM_TOKEN);
          const value = `🩺 <b>Самодиагностика аккаунтов</b>\n\n${issues.join("\n")}`;
          await Promise.all(
            adminIds(env).map(id => tg.sendMessage(id, value).catch(() => {})),
          );
        }

        // АВТОПРОДЛЕНИЕ СЕССИЙ (Keep-Alive) - главный механизм, заменяющий ручной заход в каждый аккаунт.
        // Meta продлевает срок жизни sessionid при каждом успешном обращении, поэтому регулярный
        // "прогрев" удерживает сессию живой неделями. Проверяет и продлевает за один проход браузера.
        try {
          if (env.BROWSER) {
            const intervalHours = Number(env.KEEPALIVE_HOURS || 12);
            const stale = await db.accountsStaleForKeepAlive(intervalHours, KEEPALIVE_BATCH);
            if (stale.length) {
              await logSystem(env, "info", "keepalive", `Автопродление сессий: ${stale.length} акк. не обновлялись дольше ${intervalHours}ч (${stale.join(", ")})`);
              const failed: string[] = [];
              const okList: string[] = [];
              for (const name of stale) {
                try {
                  const res = await refreshAccountCookies(env, name);
                  if (res.ok) okList.push(name);
                  else failed.push(`${name} - ${res.message}`);
                } catch (e) {
                  failed.push(`${name} - ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
                }
                await sleep(2000);
              }
              await logSystem(env, "info", "keepalive", `Автопродление завершено: успешно ${okList.length} (${okList.join(", ") || "-"}), с ошибкой ${failed.length}`);

              if (failed.length) {
                // Алерт сразу, не дожидаясь суточной сводки: чем раньше залиты свежие куки,
                // тем меньше шансов, что Meta убьёт сессию безвозвратно.
                const tg = new Telegram(env.TELEGRAM_TOKEN);
                const msg = `<b>Keep-Alive: сессии не продлены</b>\n\n- ${failed.join("\n- ")}\n\nПродлено успешно: ${okList.length}. По перечисленным аккаунтам нужен свежий экспорт cookies, иначе они отключатся и сайт начнёт отдавать ошибки.`;
                await Promise.all(
                  adminIds(env).map(id => tg.sendMessage(id, msg).catch(() => {})),
                );
              }
            }
          }
        } catch (keepAliveErr) {
          console.error("Keep-alive cron error:", keepAliveErr);
        }

        // Суточная сводка по состоянию аккаунтов. Без дополнительных запусков браузера:
        // берёт уже накопленные результаты автопродления и боевого скрапера.
        try {
          const lastDailyProbe = await db.state(0, "last_daily_probe");
          const oneDayAgo = Date.now() - 24 * 3600 * 1000;
          const lastTime = lastDailyProbe ? new Date(lastDailyProbe).getTime() : 0;
          if (lastTime < oneDayAgo) {
            await db.setState(0, "last_daily_probe", new Date().toISOString());
            const counts = await db.accountCounts();
            const deadNames = await db.deadAccountNames();
            await logSystem(env, "info", "cron", `Суточная сводка по аккаунтам: живых ${counts.alive} из ${counts.total}`);
            if (deadNames.length) {
              const tg = new Telegram(env.TELEGRAM_TOKEN);
              const msg = `<b>Суточная сводка по аккаунтам Threads</b>\n\nЖивых: ${counts.alive} из ${counts.total}\nТребуют свежие cookies:\n- ${deadNames.join("\n- ")}\n\nАвтопродление работает каждые ${Number(env.KEEPALIVE_HOURS || 12)}ч и само удерживает живые сессии. Перечисленные выше уже не продлеваются - по ним нужен ручной вход и новый экспорт.`;
              await Promise.all(
                adminIds(env).map(id => tg.sendMessage(id, msg).catch(() => {})),
              );
            }
          }
        } catch (probeErr) {
          console.error("Daily summary cron error:", probeErr);
        }

        // Анонимный мониторинг авторов (проверка новых постов)
        try {
          const authorsToPoll = await db.getTrackedAuthorsToPoll(4);
          if (authorsToPoll.length && env.BROWSER) {
            const tg = new Telegram(env.TELEGRAM_TOKEN);
            for (const item of authorsToPoll) {
              const fetched = await fetchProfileWithPosts(env, item.username, 3);
              if (fetched.status === "ok" && fetched.data?.posts?.length) {
                const newest = fetched.data.posts[0];
                const newPostId = String(newest.id || newest.date || newest.text.slice(0, 32));
                if (item.last_post_id && item.last_post_id !== newPostId) {
                  const subs = await db.getSubscribersForAuthor(item.username);
                  const webOrigin = env.SITE_URL || "https://threadsviewer.online";
                  const notifyMsg = `<b>[НОВЫЙ ПОСТ] @${item.username}</b>\n\n${esc(newest.text.slice(0, 3800))}\n\n<a href="${webOrigin}/@${item.username}">Открыть в веб-зеркале</a>`;
                  for (const sid of subs) {
                    await tg.sendMessage(sid, notifyMsg).catch(() => {});
                  }
                }
                await db.updateTrackedAuthor(item.username, newPostId, newest.text.slice(0, 100));
              }
            }
          }
        } catch (pollErr) {
          console.error("Tracking poll error:", pollErr);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env, TelegramUpdate>;
