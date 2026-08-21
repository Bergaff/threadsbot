import { Bot } from "./bot";
import { adminIds, type Env } from "./config";
import { Database } from "./db";
import { diagnoseAccountCookies } from "./cookies";
import { Telegram, type TelegramUpdate } from "./telegram";

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
      })(),
    );
  },
} satisfies ExportedHandler<Env, TelegramUpdate>;
