import { Bot } from "./bot";
import { adminIds, LIMITS, type Env } from "./config";
import { Database } from "./db";
import { diagnoseAccountCookies } from "./threads";
import { Telegram, type TelegramUpdate } from "./telegram";

function shouldHandleImmediately(update: TelegramUpdate): boolean {
  if (update.pre_checkout_query || update.message?.successful_payment) return true;
  if (update.message) {
    // Document upload (JSON cookies) = fast DB operation.
    if (update.message.document) return true;
    // Only a reply to a bot post can launch the comments browser. All other messages are fast.
    return update.message.reply_to_message?.from?.is_bot !== true;
  }
  const data = update.callback_query?.data || "";
  if (!data) return false;
  // Browser work stays in Queue; menus, payments and admin status buttons answer immediately.
  return !/^(text|img):/.test(data) && !data.startsWith("cmt:") && !data.startsWith("adm:probe:");
}

async function notifyError(env: Env, error: unknown) {
  console.error(error);
  const telegram = new Telegram(env.TELEGRAM_TOKEN);
  await Promise.all(adminIds(env).map(id => telegram.sendMessage(id, `🚨 <b>ALERT</b>\n\nBot error: ${String(error).slice(0, 500)}`).catch(() => {})));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const accounts = await new Database(env).accountCounts();
      return Response.json({ ok: true, accounts });
    }
    if (url.pathname === "/setup-webhook" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) return new Response("Unauthorized", { status: 401 });
      const webhook = `${url.origin}/telegram/${env.WEBHOOK_SECRET}`;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: webhook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "pre_checkout_query"], drop_pending_updates: false }),
      });
      return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
    }
    if (url.pathname !== `/telegram/${env.WEBHOOK_SECRET}` || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });

    const update = await request.json<TelegramUpdate>();
    if (shouldHandleImmediately(update)) {
      try { await new Bot(env).update(update); }
      catch (error) { await notifyError(env, error); }
    } else {
      await env.UPDATES.send(update);
    }
    return new Response("OK");
  },

  async queue(batch: MessageBatch<TelegramUpdate>, env: Env) {
    for (const message of batch.messages) {
      const update = message.body;
      const existing = await env.DB.prepare("SELECT status FROM processed_updates WHERE update_id=?").bind(update.update_id).first<{ status: string }>();
      if (existing?.status === "done") { message.ack(); continue; }
      await env.DB.prepare("INSERT INTO processed_updates VALUES(?,'processing',?) ON CONFLICT(update_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at").bind(update.update_id, new Date().toISOString()).run();
      try {
        await new Bot(env).update(update);
        await env.DB.prepare("UPDATE processed_updates SET status='done',updated_at=? WHERE update_id=?").bind(new Date().toISOString(), update.update_id).run();
        message.ack();
      } catch (error) {
        await env.DB.prepare("DELETE FROM processed_updates WHERE update_id=?").bind(update.update_id).run();
        await notifyError(env, error);
        message.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Техническая очистка + самодиагностика аккаунтов
    ctx.waitUntil(async () => {
      const db = new Database(env);
      await db.cleanup();
      // Самодиагностика cookies: проверка раз в 6 часов
      const stats: any[] = await db.accountStats();
      const issues: string[] = [];
      for (const a of stats) {
        const d = diagnoseAccountCookies(a.name, Boolean(a.is_alive), String(a.cookies || ""));
        if (d.issues.length) issues.push(`${d.isAlive ? '🟢' : '🔴'} <b>${d.name}</b>: ${d.issues.join('; ')}`);
      }
      if (issues.length) {
        const tg = new Telegram(env.TELEGRAM_TOKEN);
        await Promise.all(adminIds(env).map(id =>
          tg.sendMessage(id, `🩺 <b>Самодиагностика аккаунтов</b>\n\n${issues.join('\n')}`).catch(() => {})
        ));
      }
    }());
  },
} satisfies ExportedHandler<Env, TelegramUpdate>;
