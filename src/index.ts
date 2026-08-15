import { Bot } from "./bot";
import { adminIds, type Env } from "./config";
import { Database } from "./db";
import { Telegram, type TelegramUpdate } from "./telegram";
import { reviveAccounts } from "./threads";

async function dailyReport(env:Env){const db=new Database(env),tg=new Telegram(env.TELEGRAM_TOKEN),a=await db.analytics(),accounts=await db.accountCounts(),tickets=await db.tickets();const date=new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Minsk"}).format(new Date());const value=`📊 <b>Daily Report</b> (${date})\n\n👥 <b>Users:</b>\n   New today: ${a.newUsers}\n   New subs: ${a.newSubs}\n\n💰 <b>Revenue (approx):</b> $${a.revenue.toFixed(2)}\n\n🤖 <b>Accounts:</b> ${accounts.alive||0}/${accounts.total} alive\n\n🆘 <b>Open tickets:</b> ${tickets.length}`;await Promise.all(adminIds(env).map(id=>tg.sendMessage(id,value).catch(()=>{})))}

export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname==="/health") { const accounts=await new Database(env).accountCounts();return Response.json({ok:true,accounts}); }
  if(url.pathname==="/setup-webhook"&&request.method==="POST"){
   if(request.headers.get("authorization")!==`Bearer ${env.WEBHOOK_SECRET}`)return new Response("Unauthorized",{status:401});
   const webhook=`${url.origin}/telegram/${env.WEBHOOK_SECRET}`;
   const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:webhook,secret_token:env.WEBHOOK_SECRET,allowed_updates:["message","callback_query","pre_checkout_query"],drop_pending_updates:false})});
   return new Response(response.body,{status:response.status,headers:{"content-type":"application/json"}});
  }
  if(url.pathname!==`/telegram/${env.WEBHOOK_SECRET}`||request.method!=="POST")return new Response("Not found",{status:404});
  if(request.headers.get("x-telegram-bot-api-secret-token")!==env.WEBHOOK_SECRET)return new Response("Forbidden",{status:403});
  const update=await request.json<TelegramUpdate>();
  await env.UPDATES.send(update);
  return new Response("OK");
 },
 async queue(batch:MessageBatch<TelegramUpdate>,env:Env){
  for(const message of batch.messages){const update=message.body;const existing=await env.DB.prepare("SELECT status FROM processed_updates WHERE update_id=?").bind(update.update_id).first<{status:string}>();if(existing?.status==="done"){message.ack();continue}await env.DB.prepare("INSERT INTO processed_updates VALUES(?,'processing',?) ON CONFLICT(update_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at").bind(update.update_id,new Date().toISOString()).run();try{await new Bot(env).update(update);await env.DB.prepare("UPDATE processed_updates SET status='done',updated_at=? WHERE update_id=?").bind(new Date().toISOString(),update.update_id).run();message.ack()}catch(error){console.error(error);await env.DB.prepare("DELETE FROM processed_updates WHERE update_id=?").bind(update.update_id).run();const tg=new Telegram(env.TELEGRAM_TOKEN);await Promise.all(adminIds(env).map(id=>tg.sendMessage(id,`🚨 <b>ALERT</b>\n\nBot error: ${String(error).slice(0,500)}`).catch(()=>{})));message.retry()}}
 },
 async scheduled(controller:ScheduledController,env:Env,ctx:ExecutionContext){if(controller.cron==="0 6 * * *")ctx.waitUntil(dailyReport(env));else ctx.waitUntil(Promise.all([new Database(env).cleanup(),reviveAccounts(env)]).then(()=>{}));}
} satisfies ExportedHandler<Env, TelegramUpdate>;
