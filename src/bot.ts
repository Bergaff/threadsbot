import { adminIds, isAdmin, LIMITS, type Env } from "./config";
import { Database } from "./db";
import { LANGUAGE_NAMES, languages, text } from "./i18n";
import { diagnoseAccountCookies, normalizeCookiesJson, parseThreadsUsername } from "./cookies";
import { fetchComments, fetchPosts, probeAccount, resetAccountStatuses, type Comment, type Post } from "./threads";
import { kb, Telegram, type CallbackQuery, type TelegramUpdate, type TgMessage } from "./telegram";

const esc=(v:unknown)=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const fmtDate=(d:Date)=>`${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;

export class Bot {
 private db:Database; private tg:Telegram;
 constructor(private env:Env){this.db=new Database(env);this.tg=new Telegram(env.TELEGRAM_TOKEN)}
 private async lang(uid:number){return this.db.getLang(uid)}
 private async removeButtons(cid:number){const id=Number(await this.db.state(cid,"last_button"));if(id){await this.tg.editMarkup(cid,id).catch(()=>{});await this.db.clearState(cid,"last_button")}}
 private async buttons(cid:number,value:string,keyboard:ReturnType<typeof kb>){await this.removeButtons(cid);const msg=await this.tg.sendMessage(cid,value,keyboard);await this.db.setState(cid,"last_button",String(msg.message_id))}
 private async access(uid:number){const lang=await this.lang(uid);if(isAdmin(this.env,uid)||await this.db.hasSubscription(uid))return{ok:true,note:"",kind:"ok"};const u=await this.db.usage(uid);if(u.monthly>=LIMITS.freeMonthly)return{ok:false,note:text("monthly_limit_reached",lang),kind:"month_limit"};if(u.daily>=LIMITS.freeDaily)return{ok:false,note:text("daily_limit_reached",lang,{limit:LIMITS.freeDaily}),kind:"day_limit"};return{ok:true,note:text("free_limit",lang,{daily:LIMITS.freeDaily-u.daily,monthly:LIMITS.freeMonthly-u.monthly}),kind:"ok"}}
 private async alert(value:string){for(const id of adminIds(this.env))await this.tg.sendMessage(id,`🚨 <b>ALERT</b>\n\n${esc(value)}`).catch(()=>{})}

 async update(update:TelegramUpdate){if(update.pre_checkout_query){await this.tg.answerPreCheckoutQuery(update.pre_checkout_query.id);return}if(update.callback_query){await this.callback(update.callback_query);return}if(update.message)await this.message(update.message)}
 private async message(m:TgMessage){if(!m.from)return;const uid=m.from.id,cid=m.chat.id,raw=(m.text||m.caption||"").trim();if(await this.db.isBanned(uid))return;this.tg.sendChatAction(cid,"typing").catch(()=>{});
  if(m.successful_payment){const exp=await this.db.activate(uid,"stars",m.successful_payment.total_amount);await this.db.logEvent(uid,"subscribe","stars");await this.tg.sendMessage(cid,`🎉 <b>${text("paid",await this.lang(uid))}!</b> ${text("until",await this.lang(uid))} ${fmtDate(exp)}`);return}
  if(m.reply_to_message?.from?.is_bot){await this.replyComments(m);return}
  const waiting=await this.db.state(uid,"waiting_support");if(waiting){await this.supportInput(m,waiting);return}
  const adminReply=await this.db.state(uid,"admin_reply");if(adminReply&&isAdmin(this.env,uid)){await this.adminReply(m,Number(adminReply));return}
  if(m.document){await this.handleDocument(m);return}
  if(raw.startsWith("/")){const [command]=raw.split(/\s+/);switch(command.split("@")[0]){case"/start":return this.start(m);case"/language":return this.language(m);case"/help":return this.help(m);case"/subscribe":return this.subscribe(m);case"/status":return this.status(m);case"/support":return this.support(m);case"/admin":return this.admin(m);case"/report":return this.report(m);case"/ban":return this.ban(m,true);case"/unban":return this.ban(m,false);case"/accounts":return this.accountsList(m);case"/account_check":return this.accountCheck(m);case"/account_del":return this.accountDelete(m);case"/account_export":return this.accountExport(m);default:return}}
  if(isAdmin(this.env,uid)&&/^\d+\s+.+/s.test(raw)){const match=raw.match(/^(\d+)\s+(.+)$/s)!;await this.answerTicket(cid,Number(match[1]),match[2]);return}
  await this.username(m,raw);
 }
 private async start(m:TgMessage){const uid=m.from!.id,cid=m.chat.id;if(!await this.db.hasLang(uid)){let lang=(m.from!.language_code||"ru").slice(0,2);if(!languages.includes(lang as any))lang="en";await this.db.setLang(uid,lang);await this.tg.sendMessage(cid,"🌍 Выберите язык / Select language / Sprache wählen:",this.languageKb());return}const [lang,sub,u]=await Promise.all([this.lang(uid),this.db.subscription(uid),this.db.usage(uid)]);const status=sub?.active?text("subscription_active",lang,{days:Number(sub.days_left)}):text("free_limit",lang,{daily:Math.max(0,LIMITS.freeDaily-u.daily),monthly:Math.max(0,LIMITS.freeMonthly-u.monthly)});await this.tg.sendMessage(cid,text("welcome",lang,{status}));this.removeButtons(cid).catch(()=>{});this.db.logEvent(uid,"start").catch(()=>{})}
 private languageKb(){return kb([[{text:LANGUAGE_NAMES.ru,callback_data:"set_lang:ru"},{text:LANGUAGE_NAMES.en,callback_data:"set_lang:en"}],[{text:LANGUAGE_NAMES.de,callback_data:"set_lang:de"},{text:LANGUAGE_NAMES.es,callback_data:"set_lang:es"}],[{text:LANGUAGE_NAMES.pt,callback_data:"set_lang:pt"}]])}
 private async language(m:TgMessage){await this.tg.sendMessage(m.chat.id,text("select_language",await this.lang(m.from!.id)),this.languageKb());this.removeButtons(m.chat.id).catch(()=>{})}
 private async help(m:TgMessage){let value=text("help",await this.lang(m.from!.id));if(isAdmin(this.env,m.from!.id))value+="\n\n🔐 /admin\n📂 /accounts\n🩺 /account_check\n🗑 /account_del имя\n📦 /account_export имя\n➕ Пришли JSON файл (подпись = имя аккаунта) — добавить";await this.tg.sendMessage(m.chat.id,value);this.removeButtons(m.chat.id).catch(()=>{})}
 private async subscribe(m:TgMessage){const uid=m.from!.id,cid=m.chat.id,lang=await this.lang(uid),sub=await this.db.subscription(uid);if(sub?.active){await this.buttons(cid,`✅ ${text("until",lang)} ${String(sub.expires_at).slice(0,10)} (${sub.days_left} ${text("days",lang)})`,kb([[{text:`🔄 ${text("renew",lang)}`,callback_data:"sub:choose"}]]));return}const u=await this.db.usage(uid);await this.buttons(cid,`📱 <b>${text("subscription",lang)} — 30 ${text("days",lang)}</b>\n✅ ${text("unlimited",lang)}\n🆓 ${text("left_today",lang)}: ${Math.max(0,LIMITS.freeDaily-u.daily)}`,kb([[{text:`💳 ${text("subscribe",lang)}`,callback_data:"sub:choose"}]]))}
 private async status(m:TgMessage){const uid=m.from!.id,lang=await this.lang(uid),sub=await this.db.subscription(uid);if(sub?.active)await this.tg.sendMessage(m.chat.id,`✅ <b>${text("active",lang)}</b> ${text("until",lang)} ${String(sub.expires_at).slice(0,10)} (${sub.days_left} ${text("days",lang)})`);else{const u=await this.db.usage(uid);await this.tg.sendMessage(m.chat.id,`❌ <b>${text("no_sub_short",lang)}</b>\n🆓 ${text("left_today",lang)}: ${Math.max(0,LIMITS.freeDaily-u.daily)}\n/subscribe`)}}
 private async support(m:TgMessage){const lang=await this.lang(m.from!.id);await this.buttons(m.chat.id,`<b>${text("support_title",lang)}</b>\n\n• ${text("ask_question",lang)}\n• ${text("suggest_idea",lang)}\n\n${text("choose",lang)} 👇`,kb([[{text:`❓ ${text("question",lang)}`,callback_data:"sup:write:question"}],[{text:`💡 ${text("suggestion",lang)}`,callback_data:"sup:write:suggestion"}],[{text:`📋 ${text("my_tickets",lang)}`,callback_data:"sup:my"}]]))}
 private async supportInput(m:TgMessage,type:string){const value=(m.text||m.caption||"").trim();if(!value){await this.tg.sendMessage(m.chat.id,"❌ Сообщение не может быть пустым.");return}await this.db.clearState(m.from!.id,"waiting_support");const id=await this.db.createTicket(m.from!.id,m.from!.username||String(m.from!.id),value,type);await this.db.logEvent(m.from!.id,"ticket",type);const lang=await this.lang(m.from!.id),label=text(type==="suggestion"?"suggestion":"question",lang);await this.tg.sendMessage(m.chat.id,`✅ <b>${label} #${id}</b>\n\nВаше обращение принято. Спасибо!`);for(const aid of adminIds(this.env))await this.tg.sendMessage(aid,`🆘 ${type==="suggestion"?"💡":"❓"} <b>#${id}</b>\n👤 @${esc(m.from!.username||m.from!.id)} (<code>${m.from!.id}</code>)\n📝 ${esc(value.slice(0,500))}`,kb([[{text:"💬 Reply",callback_data:`ticket:reply:${id}`}]] )).catch(()=>{})}
 private async adminReply(m:TgMessage,id:number){await this.db.clearState(m.from!.id,"admin_reply");await this.answerTicket(m.chat.id,id,(m.text||m.caption||"").trim())}
 private async answerTicket(cid:number,id:number,answer:string){const ticket=await this.db.ticket(id);if(!ticket){await this.tg.sendMessage(cid,"❌ Ticket not found.");return}if(!answer){await this.tg.sendMessage(cid,"❌ Empty answer.");return}await this.db.answerTicket(id,answer);await this.tg.sendMessage(Number(ticket.user_id),`💬 <b>Reply to #${id}</b>\n\n${esc(answer)}`).catch(()=>{});await this.tg.sendMessage(cid,`✅ Reply #${id} sent.`)}
 private async ban(m:TgMessage,enabled:boolean){if(!isAdmin(this.env,m.from!.id))return;const p=(m.text||"").split(/\s+/,3),uid=Number(p[1]);if(!Number.isFinite(uid)){await this.tg.sendMessage(m.chat.id,`<code>/${enabled?'ban':'unban'} ID</code>`);return}if(enabled)await this.db.ban(uid,p[2]||"ban");else await this.db.unban(uid);await this.tg.sendMessage(m.chat.id,`${enabled?'🚫':'✅'} ${uid} ${enabled?'banned':'unbanned'}`)}
 private adminKb(open:number){return kb([[{text:"📋 Full report",callback_data:"adm:report"},{text:"🧪 Accounts",callback_data:"adm:health"}],[{text:"♻️ Reset statuses",callback_data:"adm:reset"},{text:"📊 Stats",callback_data:"adm:stats"}],[{text:"🚫 Bans",callback_data:"adm:banlist"},{text:"👥 Subs",callback_data:"adm:subs"}],[{text:`🆘 Tickets (${open})`,callback_data:"adm:tickets"}],[{text:"📈 Analytics",callback_data:"adm:analytics"}]])}
 private async admin(m:TgMessage){if(!isAdmin(this.env,m.from!.id))return;const counts=await this.db.accountCounts(),subs=await this.db.subscribers(),tickets=await this.db.tickets();await this.buttons(m.chat.id,`🔐 <b>Admin</b>\n🟢${counts.alive||0}/${counts.total} | 👥${subs.length} | 🆘${tickets.length}`,this.adminKb(tickets.length))}
 private async report(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  await this.sendOperationalReport(m.chat.id);
 }
 private async sendOperationalReport(cid:number){
  const [analytics,system,counts,subscribers,accounts]=await Promise.all([this.db.analytics(),this.db.systemStats(),this.db.accountCounts(),this.db.subscribers(),this.db.accountStats()]);
  const browserMinutes=system.browserSeconds24h/60;
  const projectedHours=system.browserSeconds24h*30/3600;
  const estimatedBrowserOverage=Math.max(0,projectedHours-10)*0.09;
  const unhealthy=(accounts as any[]).filter(a=>!a.is_alive||a.last_error);
  const accountProblems=unhealthy.length?unhealthy.slice(0,8).map(a=>`${a.is_alive?'🟡':'🔴'} ${esc(a.name)} — ${esc(String(a.last_error||'disabled').slice(0,100))}`).join('\n'):'✅ No account errors';
  const value=`📋 <b>Operational report</b>\n🕐 ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC\n\n👥 <b>Users</b>\nTotal: ${system.totalUsers} | New 24h: ${analytics.newUsers}\nDAU: ${analytics.dau} | Active 7d: ${analytics.active7d}\nFree limits hit: ${analytics.exhausted}\n\n📨 <b>Requests, 24h</b>\nTotal: ${analytics.requests}\nText: ${analytics.text} | Screens: ${analytics.img} | Comments: ${analytics.comments}\nCache entries now: ${system.cacheEntries}\nQueue processing now: ${system.processingUpdates}\n\n🌐 <b>Browser Run, 24h</b>\nLaunches: ${system.browserLaunches24h} | 429: ${system.browser42924h}\nBrowser time: ${browserMinutes.toFixed(1)} min\n30d projection: ${projectedHours.toFixed(1)} h\nPaid-plan browser overage estimate: $${estimatedBrowserOverage.toFixed(2)} + $5 base\n\n🤖 <b>Threads accounts</b>\nAlive: ${counts.alive||0}/${counts.enabled||0} enabled (${counts.total} total)\nAll-time requests: ${system.accountRequests} | Posts: ${system.postsSent} | Errors: ${system.accountErrors}\nCurrent hourly usage: ${system.hourlyRequests}\n${accountProblems}\n\n💳 <b>Business</b>\nActive subscriptions: ${subscribers.length} | New 24h: ${analytics.newSubs}\nRecorded revenue: $${analytics.revenue.toFixed(2)}\n\n🆘 <b>Moderation</b>\nOpen tickets: ${system.openTickets} | Answered 24h: ${system.answeredTickets24h}\nBanned users: ${system.banned}`;
  await this.tg.sendMessage(cid,value);
 }
 private async username(m:TgMessage,raw:string){const username=parseThreadsUsername(raw),uid=m.from!.id,lang=await this.lang(uid);if(!username){await this.tg.sendMessage(m.chat.id,text("invalid_username",lang));return}const access=await this.access(uid);if(!access.ok){await this.db.logEvent(uid,"free_exhausted",access.kind);await this.buttons(m.chat.id,`${access.note}\n\n<b>${text("subscribe_unlocks",lang)}</b>`,kb([[{text:text("subscribe_btn",lang),callback_data:"sub:choose"}]]));return}const [limited,counts]=await Promise.all([this.db.rateLimit(uid),this.db.accountCounts()]);if(limited){await this.tg.sendMessage(m.chat.id,`⏳ ${limited}`);return}if(!counts.alive){await this.alert("Все аккаунты мертвы!");await this.tg.sendMessage(m.chat.id,text("no_accounts",lang));return}await this.buttons(m.chat.id,`🔍 <b>@${esc(username)}</b> — ${text("format",lang)}:${access.note?`\n${access.note}`:""}`,kb([[{text:text("text_btn",lang),callback_data:`text:${username}:0`},{text:text("screens_btn",lang),callback_data:`img:${username}:0`}]])) }

 private async callback(cb:CallbackQuery){if(!cb.data||!cb.message)return;const d=cb.data,uid=cb.from.id,cid=cb.message.chat.id;if(!d.startsWith("sub:check:")&&!d.startsWith("set_lang:"))await this.tg.answerCallbackQuery(cb.id).catch(()=>{});if(d.startsWith("set_lang:")){const lang=d.split(":")[1];await this.db.setLang(uid,languages.includes(lang as any)?lang:"en");await this.tg.answerCallbackQuery(cb.id,{text:text("language_set",lang)}).catch(()=>{});await this.tg.deleteMessage(cid,cb.message.message_id).catch(()=>{});const fake:{message_id:number;chat:{id:number};from:any}={message_id:0,chat:{id:cid},from:cb.from};await this.start(fake);return}if(d==="sub:choose"){const lang=await this.lang(uid);await this.buttons(cid,text("payment_method",lang),kb([[{text:`⭐ Stars (${LIMITS.priceStars}⭐)`,callback_data:"sub:stars"}],[{text:`💎 Crypto (${LIMITS.priceCryptoUsd}$)`,callback_data:"sub:crypto"}]]));return}if(d==="sub:stars"){const lang=await this.lang(uid);await this.tg.sendInvoice(cid,`${text("subscription",lang)} Threads Bot`,`30 ${text("days",lang)}`,`sub_${uid}`,LIMITS.priceStars);return}if(d==="sub:crypto")return this.crypto(cid,uid);if(d.startsWith("sub:check:"))return this.cryptoCheck(cb,Number(d.split(":")[2]));if(d.startsWith("sup:"))return this.supportCallback(cb);if(d.startsWith("ticket:"))return this.ticketCallback(cb);if(d.startsWith("adm:"))return this.adminCallback(cb);if(d.startsWith("cmt:"))return this.commentsPage(cb);if(/^(text|img):[\w.]+:\d+$/.test(d))return this.choice(cb)}
 private async crypto(cid:number,uid:number){const lang=await this.lang(uid),response=await fetch("https://pay.crypt.bot/api/createInvoice",{method:"POST",headers:{"content-type":"application/json","Crypto-Pay-API-Token":this.env.CRYPTO_BOT_TOKEN},body:JSON.stringify({asset:"USDT",amount:String(LIMITS.priceCryptoUsd),description:"Threads Bot Subscription — 30 days",payload:String(uid),paid_btn_name:"callback",paid_btn_url:`https://t.me/${(await this.tg.getMe()).username}`})});const data:any=await response.json();if(!data.ok){await this.tg.sendMessage(cid,"❌ Error.");return}await this.buttons(cid,`💎 <b>${LIMITS.priceCryptoUsd} USDT</b>\n${text("after_payment",lang)} «${text("i_paid",lang)}».`,kb([[{text:`💎 ${text("pay",lang)}`,url:data.result.pay_url}],[{text:`✅ ${text("i_paid",lang)}`,callback_data:`sub:check:${data.result.invoice_id}`}]]))}
 private async cryptoCheck(cb:CallbackQuery,id:number){const response=await fetch(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${id}`,{headers:{"Crypto-Pay-API-Token":this.env.CRYPTO_BOT_TOKEN}}),data:any=await response.json(),lang=await this.lang(cb.from.id);if(data.ok&&data.result.items?.[0]?.status==="paid"){const exp=await this.db.activate(cb.from.id,"crypto",LIMITS.priceCryptoUsd);await this.db.logEvent(cb.from.id,"subscribe","crypto");await this.tg.answerCallbackQuery(cb.id,{text:"✅!",show_alert:true}).catch(()=>{});await this.tg.editText(cb.message!.chat.id,cb.message!.message_id,`🎉 <b>${text("paid",lang)}!</b> ${text("until",lang)} ${fmtDate(exp)}`)}else await this.tg.answerCallbackQuery(cb.id,{text:`⏳ ${text("not_found",lang)}`,show_alert:true}).catch(()=>{})}
 private async supportCallback(cb:CallbackQuery){const d=cb.data!,uid=cb.from.id,cid=cb.message!.chat.id,lang=await this.lang(uid);if(d.startsWith("sup:write:")){const type=d.split(":")[2];await this.db.setState(uid,"waiting_support",type);await this.buttons(cid,`${type==="suggestion"?"💡":"❓"} <b>${text(type==="suggestion"?"suggestion":"question",lang)}</b>\n\nSend your message:`,kb([[{text:"❌ Cancel",callback_data:"sup:cancel"}]]));return}if(d==="sup:cancel"){await this.db.clearState(uid,"waiting_support");await this.tg.editText(cid,cb.message!.message_id,"❌ Cancelled.");return}const tickets=await this.db.tickets(uid);let value=tickets.length?`📋 <b>${text("my_tickets",lang)}:</b>\n\n`: `📋 ${text("my_tickets",lang)}: —`;for(const t of tickets)value+=`${t.status==="answered"?"✅":"⏳"}${t.ticket_type==="suggestion"?"💡":"❓"} <b>#${t.id}</b> (${String(t.created_at).slice(0,10)})\n   ${esc(String(t.message).slice(0,80))}\n${t.answer?`   💬 ${esc(String(t.answer).slice(0,80))}\n`:""}\n`;await this.buttons(cid,value,kb([[{text:`❓ ${text("question",lang)}`,callback_data:"sup:write:question"},{text:`💡 ${text("suggestion",lang)}`,callback_data:"sup:write:suggestion"}]]))}
 private async ticketCallback(cb:CallbackQuery){if(!isAdmin(this.env,cb.from.id))return;if(cb.data==="ticket:cancel"){await this.db.clearState(cb.from.id,"admin_reply");await this.tg.editText(cb.message!.chat.id,cb.message!.message_id,"❌ Cancelled.");return}const id=Number(cb.data!.split(":")[2]);await this.db.setState(cb.from.id,"admin_reply",String(id));await this.buttons(cb.message!.chat.id,`💬 Reply to <b>#${id}</b>:`,kb([[{text:"❌ Cancel",callback_data:"ticket:cancel"}]]))}
 private async adminCallback(cb:CallbackQuery){
  if(!isAdmin(this.env,cb.from.id))return;
  const parts=cb.data!.split(":"),action=parts[1],cid=cb.message!.chat.id;
  const back=kb([[{text:"◀️",callback_data:"adm:back"}]]);
  if(action==="back"){
   const counts=await this.db.accountCounts(),subs=await this.db.subscribers(),tickets=await this.db.tickets();
   await this.buttons(cid,`🔐 🟢${counts.alive||0}/${counts.total}|👥${subs.length}|🆘${tickets.length}`,this.adminKb(tickets.length));return;
  }
  if(action==="report"){await this.sendOperationalReport(cid);return}
  if(action==="reset"){
   const changed=await resetAccountStatuses(this.env);
   await this.buttons(cid,`♻️ Statuses reset: ${changed}\n\nNo browsers were launched. Use an individual Test button to validate a session.`,back);return;
  }
  if(action==="probe"){
   const name=parts.slice(2).join(":");
   const result=await probeAccount(this.env,name);
   await this.buttons(cid,`${result.ok?'🟢':'🔴'} <b>${esc(result.name)}</b>\n${esc(result.message)}`,back);return;
  }
  if(action==="stats"||action==="health"||action==="detailed"){
   const stats:any[]=await this.db.accountStats();
   let value=`${action==="stats"?"📊 <b>Stats</b>":"🧪 <b>Threads accounts</b>"}\n\n`;
   const rows:any[][]=[];
   for(const account of stats){
    value+=`${account.is_alive?'🟢':'🔴'} <b>${esc(account.name)}</b>\n   📨${account.requests_count}|⏰${account.hourly_requests}/${LIMITS.accountHourly}|📝${account.posts_sent}|❌${account.errors_count}\n   🕐${account.last_used?String(account.last_used).slice(11,19):'—'}|${esc(account.last_error||'—')}\n\n`;
    if(action==="health")rows.push([{text:`🧪 ${account.name}`.slice(0,50),callback_data:`adm:probe:${account.name}`}]);
   }
   rows.push([{text:"♻️ Reset statuses",callback_data:"adm:reset"},{text:"◀️",callback_data:"adm:back"}]);
   await this.buttons(cid,value,kb(rows));return;
  }
  if(action==="banlist"){
   const rows:any[]=await this.db.banned();
   await this.buttons(cid,rows.length?`🚫 (${rows.length})\n\n${rows.map(r=>`• <code>${r.user_id}</code> — ${esc(r.reason)}`).join('\n')}`:"🚫 Empty",back);return;
  }
  if(action==="subs"){
   const rows:any[]=await this.db.subscribers();
   await this.buttons(cid,rows.length?`👥 (${rows.length})\n\n${rows.map(r=>`• <code>${r.user_id}</code> ${Math.max(0,Math.floor((new Date(String(r.expires_at)).getTime()-Date.now())/86_400_000))}d|${esc(r.payment_method)}`).join('\n')}`:"👥 None",back);return;
  }
  if(action==="tickets"){
   const rows:any[]=await this.db.tickets();let value=rows.length?`🆘 Open (${rows.length}):\n\n`:`🆘 No open tickets.`;
   for(const row of rows.slice(0,10))value+=`${row.ticket_type==="suggestion"?'💡':'❓'} <b>#${row.id}</b> @${esc(row.username||row.user_id)} (${String(row.created_at).slice(0,10)})\n   ${esc(String(row.message).slice(0,80))}\n\n`;
   if(rows.length)value+='\n💬 <b>Quick reply:</b> <code>ID text</code>';
   await this.buttons(cid,value,back);return;
  }
  if(action==="analytics"){
   const a=await this.db.analytics();
   await this.buttons(cid,`📈 <b>Analytics (24h)</b>\n\n👥 New users: ${a.newUsers}\n🔥 DAU: ${a.dau}\n📊 Active (7d): ${a.active7d}\n\n📨 Total requests: ${a.requests}\n📝 Text: ${a.text} | 📸 Img: ${a.img} | 💬 Cmts: ${a.comments}\n\n🚫 Hit limits: ${a.exhausted}\n💰 New subs: ${a.newSubs}\n💵 Revenue: $${a.revenue.toFixed(2)}`,back);
  }
 }
 private async choice(cb:CallbackQuery){const [mode,username,pageRaw]=cb.data!.split(":"),page=Number(pageRaw),uid=cb.from.id,cid=cb.message!.chat.id,lang=await this.lang(uid);if(page===0){const access=await this.access(uid);if(!access.ok){await this.buttons(cid,"🔒",kb([[{text:text("subscribe_btn",lang),callback_data:"sub:choose"}]]));return}const limited=await this.db.rateLimit(uid);if(limited){await this.tg.editText(cid,cb.message!.message_id,`⏳ ${limited}`);return}}await this.tg.editMarkup(cid,cb.message!.message_id).catch(()=>{});const loading=await this.tg.sendMessage(cid,`⏳ @${esc(username)}...`);try{let posts=mode==="text"?await this.db.cache<Post[]>(username,mode):null,status:"ok"|string="ok";if(!posts){if(page===0)await Promise.all([this.db.logRequest(uid,username),this.db.logEvent(uid,"search",username),this.db.logEvent(uid,"request",`${mode}:${username}`)]);const fetched=await fetchPosts(this.env,username,mode as "text"|"img",20);posts=fetched.data;status=fetched.status;if(posts&&status==="ok"&&mode==="text")await this.db.setCache(username,mode,posts);if(posts&&status==="ok"&&page===0&&!await this.db.hasSubscription(uid)&&!isAdmin(this.env,uid))await this.db.logEvent(uid,"free_request",username)}await this.tg.deleteMessage(cid,loading.message_id).catch(()=>{});if(status==="all_dead"){await this.alert(`Все аккаунты недоступны! @${username}`);await this.tg.sendMessage(cid,text("all_dead",lang));return}if(status==="browser_busy"){await this.tg.sendMessage(cid,"⏳ Browser Run занят. Аккаунты не отключены; повторите запрос через 30 секунд.");return}if(status==="service_error"){await this.tg.sendMessage(cid,"⚠️ Threads временно не ответил. Аккаунт оставлен активным; попробуйте позже.");return}if(status==="user_not_found"){await this.tg.sendMessage(cid,text("user_not_found",lang,{username}));return}if(!posts?.length){await this.tg.sendMessage(cid,text("no_posts",lang));return}await this.db.setState(cid,"last_username",username);const start=page*5,current=posts.slice(start,start+5),end=start+current.length;if(!current.length){await this.tg.sendMessage(cid,text("no_more",lang));return}if(page===0)await this.tg.sendMessage(cid,text("posts_found",lang,{username,count:posts.length}));for(let i=0;i<current.length;i++){const p=current[i];if(mode==="text"){let indicator=p.has_image&&p.has_video?` (📷🎥 ${text("photo",lang)}+${text("video",lang)})`:p.has_image?` (📷 ${text("photo",lang)})`:p.has_video?` (🎥 ${text("video",lang)})`:"";await this.tg.sendMessage(cid,`<b>${start+i+1}.</b> ${esc(p.text.slice(0,4000))}${indicator}`)}else if(p.image)await this.tg.sendPhoto(cid,p.image,`${start+i+1}.`)}const more=posts.length>end,rows:any[][]=[];if(more)rows.push([{text:`➡️ ${text("more",lang)} (${end+1}–${Math.min(end+5,posts.length)})`,callback_data:`${mode}:${username}:${page+1}`}]);rows.push([{text:mode==="text"?text("screens_btn",lang):text("text_btn",lang),callback_data:`${mode==="text"?"img":"text"}:${username}:0`}]);await this.buttons(cid,`✅ <b>${start+1}–${end} ${text("of",lang)} ${posts.length}</b>\n${more?text("more_available",lang):`📭 ${text("all",lang)}`}\n${text("reply_for_comments",lang)}\n${text("send_other",lang)}`,kb(rows))}catch(error){await this.tg.deleteMessage(cid,loading.message_id).catch(()=>{});await this.alert(`Bot error: ${error}`);await this.tg.sendMessage(cid,`❌ <code>${esc(String(error).slice(0,300))}</code>`)}}
 private async replyComments(m:TgMessage){const uid=m.from!.id,cid=m.chat.id,lang=await this.lang(uid),replied=m.reply_to_message!,match=(replied.text||replied.caption||"").match(/^(?:📷|🎥)?\s*(?:<b>)?(\d+)\./),fallback=(m.text||"").match(/^(\d+)$/),number=Number(match?.[1]||fallback?.[1]);if(!number)return;const username=await this.db.state(cid,"last_username");if(!username){await this.tg.sendMessage(cid,"❌ Send a username first.");return}const access=await this.access(uid);if(!access.ok){await this.db.logEvent(uid,"free_exhausted",access.kind);await this.buttons(cid,access.note,kb([[{text:text("subscribe_btn",lang),callback_data:"sub:choose"}]]));return}const limited=await this.db.rateLimit(uid);if(limited){await this.tg.sendMessage(cid,`⏳ ${limited}`);return}const loading=await this.tg.sendMessage(cid,"💬 Загружаю комментарии...");try{const found=await fetchComments(this.env,username,number-1,20);await this.tg.deleteMessage(cid,loading.message_id).catch(()=>{});if(found.status==="all_dead"){await this.tg.sendMessage(cid,text("all_dead",lang));return}if(found.status==="browser_busy"){await this.tg.sendMessage(cid,"⏳ Browser Run занят. Аккаунты не отключены; повторите через 30 секунд.");return}if(found.status==="service_error"){await this.tg.sendMessage(cid,"⚠️ Threads временно не ответил. Попробуйте позже.");return}if(found.status==="post_not_found"||found.status==="user_not_found"){await this.tg.sendMessage(cid,"❌ Post not found.");return}if(!found.data?.length){await this.tg.sendMessage(cid,"😔 No comments.");return}await Promise.all([this.db.logRequest(uid,`${username}/cmt/${number}`),this.db.logEvent(uid,"comments_request",username),this.db.logEvent(uid,"request",`comments:${username}`)]);if(!await this.db.hasSubscription(uid)&&!isAdmin(this.env,uid))await this.db.logEvent(uid,"free_request",`cmt:${username}/${number}`);const key=`${username}_cmt_${number-1}`;await this.db.setCache(key,"comments",found.data.map(c=>({text:c.text,author:c.author})));await this.tg.sendMessage(cid,`💬 <b>@${esc(username)}</b> (${found.data.length})`);await this.sendComments(cid,found.data.slice(0,5),0);if(found.data.length>5)await this.buttons(cid,`✅ 1–5 ${text("of",lang)} ${found.data.length}`,kb([[{text:`➡️ ${text("more",lang)} (6–${Math.min(10,found.data.length)})`,callback_data:`cmt:${username}:${number-1}:1`}]]));else await this.tg.sendMessage(cid,`✅ ${text("all",lang)} ${found.data.length}.`)}catch(error){await this.tg.deleteMessage(cid,loading.message_id).catch(()=>{});await this.alert(`Bot error: ${error}`);await this.tg.sendMessage(cid,`❌ <code>${esc(String(error).slice(0,300))}</code>`)}}
 private async sendComments(cid:number,comments:Comment[],start:number){for(let i=0;i<comments.length;i++)await this.tg.sendMessage(cid,`<b>${start+i+1}. ${esc(comments[i].author||"—")}</b>\n${esc(comments[i].text.slice(0,1000))}`)}
 private async commentsPage(cb:CallbackQuery){const [,username,indexRaw,pageRaw]=cb.data!.split(":"),index=Number(indexRaw),page=Number(pageRaw),cid=cb.message!.chat.id,lang=await this.lang(cb.from.id),comments=await this.db.cache<Comment[]>(`${username}_cmt_${index}`,"comments");await this.tg.editMarkup(cid,cb.message!.message_id).catch(()=>{});if(!comments){await this.tg.sendMessage(cid,"⏳ Cache expired.");return}const start=page*5,current=comments.slice(start,start+5),end=start+current.length;if(!current.length){await this.tg.sendMessage(cid,text("no_more",lang));return}await this.sendComments(cid,current,start);if(comments.length>end)await this.buttons(cid,`✅ ${start+1}–${end} ${text("of",lang)} ${comments.length}`,kb([[{text:`➡️ ${text("more",lang)} (${end+1}–${Math.min(end+5,comments.length)})`,callback_data:`cmt:${username}:${index}:${page+1}`}]]));else await this.tg.sendMessage(cid,`✅ ${text("all",lang)} ${comments.length}.`)}
 // ============================
 // УПРАВЛЕНИЕ АККАУНТАМИ
 // ============================
 private async accountsList(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  const stats:any[]=await this.db.accountStats();
  if(!stats.length){await this.tg.sendMessage(m.chat.id,"📂 Аккаунтов нет.\nПришли <b>JSON файл</b> (Cookie-Editor/Playwright) — сохраню и запущу.");return}
  let value="📂 <b>Аккаунты</b>\n\n";
  for(const s of stats)value+=`${s.is_alive?'🟢':'🔴'} <b>${esc(s.name)}</b> ⏰${s.hourly_requests}/${LIMITS.accountHourly} | 📨${s.requests_count} | ❌${s.errors_count}\n`;
  value+="\n➕ Пришли JSON файл — добавить\n🩺 /account_check\n🗑 /account_del имя\n📦 /account_export имя";
  await this.tg.sendMessage(m.chat.id,value);
 }
 private async accountCheck(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  const loading=await this.tg.sendMessage(m.chat.id,"🩺 Проверяю cookies...");
  const stats:any[]=await this.db.accountStats();
  if(!stats.length){await this.tg.deleteMessage(m.chat.id,loading.message_id).catch(()=>{});await this.tg.sendMessage(m.chat.id,"📂 Аккаунтов нет. Пришли JSON файл.");return}
  const lines:string[]=[];
  for(const a of stats){
   const d=diagnoseAccountCookies(a.name,Boolean(a.is_alive),String(a.cookies||""));
   const mark=d.isAlive?'🟢':'🔴';
   const extra=d.issues.length?d.issues.join('; '):`ok, ${d.cookieCount} cookies`;
   lines.push(`${mark} <b>${esc(d.name)}</b>: ${extra}`);
  }
  await this.tg.deleteMessage(m.chat.id,loading.message_id).catch(()=>{});
  await this.tg.sendMessage(m.chat.id,`🩺 <b>Диагностика</b>\n\n${lines.join("\n")}`);
 }
 private async accountDelete(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  const p=(m.text||"").split(/\s+/,2);
  if(p.length<2){await this.tg.sendMessage(m.chat.id,"<code>/account_del имя</code>");return}
  const name=p[1];
  const account=await this.db.accountCookie(name);
  if(account)await this.db.accountDelete(name);
  await this.tg.sendMessage(m.chat.id,`${account?`🗑 <b>${esc(name)}</b> удалён`:`❌ Аккаунт "${esc(name)}" не найден`}`);
 }
 private async accountExport(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  const p=(m.text||"").split(/\s+/,2);
  if(p.length<2){await this.tg.sendMessage(m.chat.id,"<code>/account_export имя</code>");return}
  const name=p[1];
  const account=await this.db.accountCookie(name);
  if(!account){await this.tg.sendMessage(m.chat.id,`❌ Аккаунт "${esc(name)}" не найден`);return}
  await this.tg.sendMessage(m.chat.id,"⚠️ Файл содержит cookies — доступ к аккаунту Threads. Не используй одни cookies в двух местах одновременно.");
  const bytes=new TextEncoder().encode(account.cookies);
  await this.tg.sendDocument(m.chat.id,bytes,`${name}.json`);
 }
 /** Обработка документа (JSON-файла с cookies). Подпись сообщения = имя аккаунта. */
 private async handleDocument(m:TgMessage){
  if(!isAdmin(this.env,m.from!.id))return;
  if(!m.document)return;
  const fname=m.document.file_name||"";
  if(!fname.toLowerCase().endsWith(".json")){await this.tg.sendMessage(m.chat.id,"❌ Пришли файл <b>.json</b> с cookies (Cookie-Editor или Playwright).");return}
  const caption=(m.caption||"").trim();
  const name=(caption||fname.replace(/\.json$/i,"")).replace(/\s+/g,"_");
  if(!/^[\w.\-]{2,64}$/.test(name)){await this.tg.sendMessage(m.chat.id,"❌ Недопустимое имя. Используй латиницу/цифры или подпись к файлу.");return}
  const file=await this.tg.getFile(m.document.file_id);
  if(!file){await this.tg.sendMessage(m.chat.id,"❌ Не удалось скачать файл из Telegram.");return}
  const resp=await fetch(`https://api.telegram.org/file/bot${this.env.TELEGRAM_TOKEN}/${file}`);
  if(!resp.ok){await this.tg.sendMessage(m.chat.id,`❌ Telegram file HTTP ${resp.status}`);return}
  const raw=await resp.text();
  const normalized=normalizeCookiesJson(raw);
  if(!normalized.ok){await this.tg.sendMessage(m.chat.id,`❌ ${normalized.error}`);return}
  await this.db.accountUpsert(name,normalized.json);
  const d=diagnoseAccountCookies(name,true,normalized.json);
  const warn=d.issues.length?`\n⚠️ ${d.issues.join('; ')}`:`\n🍪 ${d.cookieCount} cookies`;
  await this.tg.sendMessage(m.chat.id,`✅ <b>${esc(name)}</b> — cookies сохранены в D1${warn}\n\n/accounts — список\n🩺 /account_check — диагностика`);
 }
}
