import { handleAdminRoute, verifyAdmin } from "./admin";
import { FAVICON_SVG, FAVICON_ICO_BASE64, FAVICON_DATA_URL } from "./assets";
import { Bot } from "./bot";
import { adminIds, type Env } from "./config";
import { Database } from "./db";
import { diagnoseAccountCookies } from "./cookies";
import { Telegram, type TelegramUpdate } from "./telegram";
import { fetchComments, fetchProfileWithPosts, logSystem, type ProfileData, type Comment } from "./threads";
import { verifyAuthToken } from "./auth";
import {
  detectLanguage,
  esc,
  handleImageProxy,
  renderHomePage,
  renderPrivacyPage,
  renderProfilePage,
  renderRobotsTxt,
  renderSitemap,
  renderTermsPage,
} from "./web";

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

async function notifyError(env: Env, error: unknown) {
  console.error(error);
  const telegram = new Telegram(env.TELEGRAM_TOKEN);
  const value = `🚨 <b>ALERT</b>\n\nBot error: ${String(error).slice(0, 500)}`;
  await Promise.all(
    adminIds(env).map(id => telegram.sendMessage(id, value).catch(() => {})),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ==========================================
    // ВЕБ-АДМИНКА (СТАТУС БОТОВ, АККАУНТЫ, ПАРОЛЬ)
    // ==========================================
    if (url.pathname.startsWith("/admin")) {
      return handleAdminRoute(request, env);
    }

    // ==========================================
    // ВЕБ-САЙТ И ЗЕРКАЛО ДЛЯ БРАУЗЕРА (БЕЗ VPN)
    // ==========================================

    const lang = detectLanguage(request);
    const country = (request.headers.get("cf-ipcountry") || (request as any).cf?.country || "").toUpperCase();

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

    // Главная страница
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      let res = renderHomePage(env, lang, isPremium, country, url.origin);
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      }
      return res;
    }

    // Служебные страницы и SEO
    if (url.pathname === "/terms") return renderTermsPage(lang);
    if (url.pathname === "/privacy") return renderPrivacyPage(lang);
    if (url.pathname === "/robots.txt") return renderRobotsTxt(url.origin);
    if (url.pathname === "/sitemap.xml") {
      return renderSitemap(url.origin, ["durov", "mosseri", "zuck", "mrbeast", "openai", "techcrunch"]);
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

    // Просмотр конкретного поста: /@username/post/:postId или /profile/username/post/:postId
    const postMatch = url.pathname.match(/^\/(?:@|profile\/)([A-Za-z0-9._]+)\/post\/([A-Za-z0-9._-]+)$/);
    if (postMatch) {
      const username = postMatch[1].toLowerCase();
      const targetPostId = postMatch[2];
      const db = new Database(env);
      const isAdmin = verifyAdmin(request, env);
      if (!isAdmin) {
        ctx.waitUntil(db.logEvent(0, "web_post_view", `${username}:${targetPostId}`).catch(() => {}));
      }
      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      ctx.waitUntil(logSystem(env, "info", "web", `[WEB_POST_VIEW] Переход на @${username}/post/${targetPostId} (admin: ${isAdmin}, premium: ${isPremium})`).catch(() => {}));
      const cached = await db.cache<ProfileData>(username, "web_profile");
      let res = renderProfilePage(env, username, cached, null, lang, isPremium, country, targetPostId, url.origin);
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      }
      return res;
    }

    // Просмотр профиля: /@username или /profile/username
    const profileMatch = url.pathname.match(/^\/(?:@|profile\/)([A-Za-z0-9._]+)$/);
    if (profileMatch) {
      const username = profileMatch[1].toLowerCase();
      const db = new Database(env);
      const isAdmin = verifyAdmin(request, env);
      if (!isAdmin) {
        ctx.waitUntil(db.logEvent(0, "web_view", username).catch(() => {}));
      }
      const { isPremium, newAuthCookie } = await checkPremiumUser(request, env);
      ctx.waitUntil(logSystem(env, "info", "web", `[WEB_VIEW] Переход на @${username} (admin: ${isAdmin}, premium: ${isPremium})`).catch(() => {}));
      const cached = await db.cache<ProfileData>(username, "web_profile");
      let res = renderProfilePage(env, username, cached, null, lang, isPremium, country, undefined, url.origin);
      if (newAuthCookie) {
        res = new Response(res.body, res);
        res.headers.append("Set-Cookie", newAuthCookie);
      }
      return res;
    }

    // API для получения данных профиля и постов (для "крутить как обычный тредс")
    if (url.pathname.startsWith("/api/profile/")) {
      const username = decodeURIComponent(url.pathname.slice("/api/profile/".length)).replace(/^@/, "").toLowerCase();
      if (!username || !/^[A-Za-z0-9._]{1,60}$/.test(username)) {
        return Response.json({ ok: false, error: "Некорректный username" }, { status: 400 });
      }

      const db = new Database(env);
      const isAdmin = verifyAdmin(request, env);
      if (!isAdmin) {
        ctx.waitUntil(db.logEvent(0, "web_api", username).catch(() => {}));
      }
      await logSystem(env, "info", "api", `[API_REQ] Запрос профиля /api/profile/${username} (admin: ${isAdmin})`);

      // Сначала проверяем D1 кеш
      const cached = await db.cache<ProfileData>(username, "web_profile");
      if (cached) {
        await logSystem(env, "info", "api", `[API_CACHE] Отдан кеш для @${username} (${cached.posts?.length || 0} постов)`);
        return Response.json({ ok: true, cached: true, ...cached });
      }

      // Если нет в кеше и есть браузер — запрашиваем
      if (!env.BROWSER) {
        await logSystem(env, "error", "api", `[API_ERROR] Browser Run (env.BROWSER) отсутствует`);
        return Response.json({ ok: false, error: "Browser Run недоступен на этом плане Cloudflare" }, { status: 503 });
      }

      const counts = await db.accountCounts();
      if (!counts.alive) {
        await logSystem(env, "warn", "api", `[API_ERROR] Нет активных аккаунтов (живых: 0 из ${counts.total})`);
        return Response.json({
          ok: false,
          error: "Нет активных технических аккаунтов Threads. Добавьте JSON cookies через Telegram-бот (/accounts).",
        }, { status: 503 });
      }

      try {
        await logSystem(env, "info", "api", `[API_FETCH] Запуск скрапера для @${username} (аккаунтов доступно: ${counts.alive})`);
        const fetched = await fetchProfileWithPosts(env, username, 20);
        await logSystem(env, "info", "api", `[API_RESULT] @${username}: status=${fetched.status}, постов=${fetched.data?.posts?.length || 0}`);
        if (fetched.status === "ok" && fetched.data) {
          await db.setCache(username, "web_profile", fetched.data);
          return Response.json({ ok: true, cached: false, ...fetched.data });
        }
        return Response.json({
          ok: false,
          status: fetched.status,
          error: fetched.status === "user_not_found" ? "Профиль не найден в Threads" : (fetched.error || fetched.status),
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
      const db = new Database(env);
      if (!verifyAdmin(request, env)) {
        ctx.waitUntil(db.logEvent(0, "web_comments", `${username}:${postIndex}`).catch(() => {}));
      }
      const cacheKey = `${username}_cmt_${postIndex}`;
      if (!refresh) {
        const cached = await db.cache<Comment[]>(cacheKey, "comments");
        if (cached) {
          return Response.json({ ok: true, cached: true, comments: cached });
        }
      }

      if (!env.BROWSER) {
        return Response.json({ ok: false, error: "Browser Run недоступен" }, { status: 503 });
      }

      try {
        const fetched = await fetchComments(env, username, postIndex, 30);
        if (fetched.status === "ok" && fetched.data) {
          await db.setCache(cacheKey, "comments", fetched.data);
          return Response.json({ ok: true, cached: false, comments: fetched.data });
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

    if (url.pathname === "/setup-webhook" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const webhook = `${url.origin}/telegram/${env.WEBHOOK_SECRET}`;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhook,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query", "pre_checkout_query"],
          drop_pending_updates: false,
        }),
      });
      return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
    }

    if (url.pathname !== `/telegram/${env.WEBHOOK_SECRET}` || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = await request.json<TelegramUpdate>();

    if (needsBrowser(update)) {
      // Тяжёлое — в очередь. Кнопки подтверждаем СРАЗУ: иначе Telegram крутит
      // спиннер 30с и считает, что бот мёртв, пока Queue + браузер не стартанут.
      // Queue и Browser Rendering есть только на Workers Paid.
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
      // Быстрое (команды, меню, загрузка JSON, платежи, обычный username) —
      // обрабатываем прямо здесь, но НЕ заставляем Telegram ждать: возвращаем 200
      // немедленно, а работа продолжается в фоне через ctx.waitUntil.
      // Это и убирает «задержку перед ответом на команды».
      ctx.waitUntil(
        (async () => {
          try { await new Bot(env).update(update); }
          catch (error) { await notifyError(env, error); }
        })(),
      );
    }

    return new Response("OK");
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
