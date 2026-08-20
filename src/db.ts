import { LIMITS, type Env, excludedIds } from "./config";

const now = () => new Date().toISOString();
const since = (ms: number) => new Date(Date.now() - ms).toISOString();
export type StateName = "last_button" | "last_username" | "waiting_support" | "admin_reply";

export class Database {
  constructor(private readonly env: Env) {}
  private get db() { return this.env.DB; }

  async getLang(uid: number): Promise<string> {
    return (await this.db.prepare("SELECT language FROM user_settings WHERE user_id=?").bind(uid).first<{language:string}>())?.language || "ru";
  }
  async hasLang(uid: number): Promise<boolean> { return !!await this.db.prepare("SELECT 1 x FROM user_settings WHERE user_id=?").bind(uid).first(); }
  setLang(uid: number, lang: string) { return this.db.prepare("INSERT INTO user_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET language=excluded.language").bind(uid, lang, now()).run(); }
  isBanned(uid: number) { return this.db.prepare("SELECT 1 x FROM banned_users WHERE user_id=?").bind(uid).first().then(Boolean); }
  ban(uid: number, reason: string) { return this.db.prepare("INSERT INTO banned_users(user_id,reason,banned_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason,banned_at=excluded.banned_at").bind(uid, reason, now()).run(); }
  unban(uid: number) { return this.db.prepare("DELETE FROM banned_users WHERE user_id=?").bind(uid).run(); }
  async banned() { return (await this.db.prepare("SELECT * FROM banned_users ORDER BY banned_at DESC").all()).results; }

  logEvent(uid: number, type: string, data = "") { return this.db.prepare("INSERT INTO user_events(user_id,event_type,event_data,timestamp) VALUES(?,?,?,?)").bind(uid,type,data,now()).run(); }
  logRequest(uid: number, username: string) { return this.db.prepare("INSERT INTO request_log(user_id,username_requested,timestamp) VALUES(?,?,?)").bind(uid,username,now()).run(); }
  async usage(uid: number): Promise<{daily:number;monthly:number}> {
    const d = new Date(); d.setUTCHours(0,0,0,0);
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const row = await this.db.prepare("SELECT SUM(timestamp>=?) daily, COUNT(*) monthly FROM user_events WHERE user_id=? AND event_type='free_request' AND timestamp>=?").bind(d.toISOString(),uid,m.toISOString()).first<{daily:number;monthly:number}>();
    return { daily: Number(row?.daily || 0), monthly: Number(row?.monthly || 0) };
  }
  async rateLimit(uid: number): Promise<string | null> {
    const row = await this.db.prepare("SELECT SUM(timestamp>?) m, SUM(timestamp>?) h, COUNT(*) d FROM request_log WHERE user_id=? AND timestamp>?").bind(since(60_000),since(3_600_000),uid,since(86_400_000)).first<{m:number;h:number;d:number}>();
    if (Number(row?.m||0) >= LIMITS.perMinute) return `Лимит ${LIMITS.perMinute}/мин.`;
    if (Number(row?.h||0) >= LIMITS.perHour) return `Лимит ${LIMITS.perHour}/час.`;
    if (Number(row?.d||0) >= LIMITS.perDay) return `Лимит ${LIMITS.perDay}/сутки.`;
    return null;
  }
  async subscription(uid: number): Promise<(Record<string, unknown> & { expires_at: string; active: boolean; days_left: number }) | null> {
    const row = await this.db.prepare("SELECT * FROM subscriptions WHERE user_id=?").bind(uid).first<Record<string,unknown>>();
    if (!row) return null;
    const expires_at = String(row.expires_at);
    const delta = new Date(expires_at).getTime() - Date.now();
    return { ...row, expires_at, active: delta > 0, days_left: Math.max(0, Math.floor(delta/86_400_000)) };
  }
  async hasSubscription(uid: number) { return (await this.subscription(uid))?.active === true; }
  async activate(uid: number, method: string, amount: number): Promise<Date> {
    const old = await this.subscription(uid);
    const base = old?.active ? new Date(String(old.expires_at)) : new Date();
    const expiry = new Date(base.getTime() + LIMITS.subscriptionDays*86_400_000);
    await this.db.batch([
      this.db.prepare("INSERT INTO subscriptions(user_id,expires_at,payment_method,total_paid,payments_count) VALUES(?,?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,payment_method=excluded.payment_method,total_paid=total_paid+excluded.total_paid,payments_count=payments_count+1").bind(uid,expiry.toISOString(),method,amount),
      this.db.prepare("INSERT INTO payments_log(user_id,amount,method,timestamp) VALUES(?,?,?,?)").bind(uid,String(amount),method,now()),
    ]);
    return expiry;
  }
  async subscribers() { return (await this.db.prepare("SELECT * FROM subscriptions WHERE expires_at>?").bind(now()).all()).results; }

  async cache<T>(username:string, mode:string, page=0): Promise<T|null> {
    const row = await this.db.prepare("SELECT data,cached_at FROM cache WHERE username=? AND mode=? AND page=?").bind(username,mode,page).first<{data:string;cached_at:string}>();
    if (!row || Date.now()-new Date(row.cached_at).getTime() >= LIMITS.cacheMinutes*60_000) return null;
    return JSON.parse(row.data) as T;
  }
  setCache(username:string, mode:string, data:unknown, page=0) { return this.db.prepare("INSERT INTO cache VALUES(?,?,?,?,?) ON CONFLICT(username,mode,page) DO UPDATE SET data=excluded.data,cached_at=excluded.cached_at").bind(username,mode,page,JSON.stringify(data),now()).run(); }

  async state(scope:string|number,key:StateName): Promise<string|null> { return (await this.db.prepare("SELECT value FROM bot_state WHERE scope=? AND state_key=?").bind(String(scope),key).first<{value:string}>())?.value || null; }
  setState(scope:string|number,key:StateName,value:string) { return this.db.prepare("INSERT INTO bot_state VALUES(?,?,?,?) ON CONFLICT(scope,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(scope),key,value,now()).run(); }
  clearState(scope:string|number,key:StateName) { return this.db.prepare("DELETE FROM bot_state WHERE scope=? AND state_key=?").bind(String(scope),key).run(); }

  async createTicket(uid:number, username:string, message:string, type:string): Promise<number> { const r=await this.db.prepare("INSERT INTO support_tickets(user_id,username,message,ticket_type,status,created_at) VALUES(?,?,?,?,'open',?)").bind(uid,username,message,type,now()).run(); return Number(r.meta.last_row_id); }
  ticket(id:number) { return this.db.prepare("SELECT * FROM support_tickets WHERE id=?").bind(id).first<Record<string,unknown>>(); }
  async tickets(uid?:number) { const q=uid?this.db.prepare("SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 5").bind(uid):this.db.prepare("SELECT * FROM support_tickets WHERE status='open' ORDER BY created_at DESC"); return (await q.all()).results; }
  answerTicket(id:number, answer:string) { return this.db.prepare("UPDATE support_tickets SET status='answered',answer=?,answered_at=? WHERE id=?").bind(answer,now(),id).run(); }

  async accountCounts() { return await this.db.prepare("SELECT COUNT(*) total,SUM(enabled) enabled,SUM(enabled AND is_alive) alive FROM threads_accounts").first<{total:number;enabled:number;alive:number}>() || {total:0,enabled:0,alive:0}; }
  async accountStats() { return (await this.db.prepare("SELECT name,is_alive,last_error,requests_count,posts_sent,errors_count,hourly_requests,hourly_reset,last_used,cookies FROM threads_accounts ORDER BY name").all()).results; }
  async accountCookie(name:string) { return await this.db.prepare("SELECT cookies FROM threads_accounts WHERE name=?").bind(name).first<{cookies:string}>(); }
  async accountDelete(name:string) { return this.db.prepare("DELETE FROM threads_accounts WHERE name=?").bind(name).run(); }
  /** ВАЖНО: сохраняет/обновляет cookies аккаунта. Раньше здесь была опечатка iso() -> ReferenceError, из-за
   *  чего загрузка JSON и запись «жила» аккаунта падали. Теперь используется общий now(). */
  accountUpsert(name: string, cookies: string) {
    const ts = now();
    return this.db.prepare(
      "INSERT INTO threads_accounts(name,cookies,enabled,is_alive,hourly_reset,updated_at) VALUES(?,?,1,1,?,?) " +
      "ON CONFLICT(name) DO UPDATE SET cookies=excluded.cookies,enabled=1,is_alive=1,last_error=NULL,updated_at=excluded.updated_at"
    ).bind(name, cookies, ts, ts).run();
  }

  async analytics() {
    const excluded=excludedIds(this.env); const marks=excluded.map(()=>"?").join(","); const clause=` AND user_id<>0${excluded.length?` AND user_id NOT IN (${marks})`:""}`;
    const one=since(86_400_000), seven=since(7*86_400_000);
    const queries = [
      this.db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM user_events WHERE event_type='start' AND timestamp>?${clause}`).bind(one,...excluded),
      this.db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM user_events WHERE timestamp>?${clause}`).bind(one,...excluded),
      this.db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM user_events WHERE timestamp>?${clause}`).bind(seven,...excluded),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='request' AND timestamp>?${clause}`).bind(one,...excluded),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='free_exhausted' AND timestamp>?${clause}`).bind(one,...excluded),
      this.db.prepare(`SELECT event_data,COUNT(*) c FROM user_events WHERE event_type='request' AND timestamp>?${clause} GROUP BY event_data`).bind(one,...excluded),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='subscribe' AND timestamp>?${clause}`).bind(one,...excluded),
      this.db.prepare(`SELECT COALESCE(SUM(total_paid),0) c FROM subscriptions WHERE expires_at>?${clause}`).bind(since(30*86_400_000),...excluded),
    ];
    const r=await this.db.batch(queries); const modes=r[5].results as {event_data:string;c:number}[];
    const count=(i:number)=>Number((r[i].results[0] as {c:number}|undefined)?.c||0);
    return {newUsers:count(0),dau:count(1),active7d:count(2),requests:count(3),exhausted:count(4),newSubs:count(6),revenue:count(7),text:modes.filter(x=>x.event_data.startsWith('text:')).reduce((a,x)=>a+Number(x.c),0),img:modes.filter(x=>x.event_data.startsWith('img:')).reduce((a,x)=>a+Number(x.c),0),comments:modes.filter(x=>x.event_data.startsWith('comments:')).reduce((a,x)=>a+Number(x.c),0)};
  }
  async systemStats() {
    const one = since(86_400_000);
    const results = await this.db.batch([
      this.db.prepare("SELECT COUNT(*) c FROM user_settings"),
      this.db.prepare("SELECT COUNT(*) c FROM cache WHERE cached_at>?").bind(since(LIMITS.cacheMinutes * 60_000)),
      this.db.prepare("SELECT COUNT(*) c FROM banned_users"),
      this.db.prepare("SELECT COUNT(*) c FROM support_tickets WHERE status='open'"),
      this.db.prepare("SELECT COUNT(*) c FROM support_tickets WHERE status='answered' AND answered_at>?").bind(one),
      this.db.prepare("SELECT COALESCE(SUM(requests_count),0) requests,COALESCE(SUM(posts_sent),0) posts,COALESCE(SUM(errors_count),0) errors,COALESCE(SUM(hourly_requests),0) hourly FROM threads_accounts"),
      this.db.prepare("SELECT COUNT(*) c FROM user_events WHERE event_type='browser_launch' AND timestamp>?").bind(one),
      this.db.prepare("SELECT COUNT(*) c FROM user_events WHERE event_type='browser_429' AND timestamp>?").bind(one),
      this.db.prepare("SELECT COALESCE(SUM(CAST(event_data AS REAL)),0) c FROM user_events WHERE event_type='browser_seconds' AND timestamp>?").bind(one),
      this.db.prepare("SELECT COUNT(*) c FROM processed_updates WHERE status='processing'"),
    ]);
    const count = (index: number) => Number((results[index].results[0] as { c?: number } | undefined)?.c || 0);
    const accounts = (results[5].results[0] || {}) as { requests?: number; posts?: number; errors?: number; hourly?: number };
    return {
      totalUsers: count(0), cacheEntries: count(1), banned: count(2), openTickets: count(3), answeredTickets24h: count(4),
      accountRequests: Number(accounts.requests || 0), postsSent: Number(accounts.posts || 0), accountErrors: Number(accounts.errors || 0), hourlyRequests: Number(accounts.hourly || 0),
      browserLaunches24h: count(6), browser42924h: count(7), browserSeconds24h: count(8), processingUpdates: count(9),
    };
  }

  cleanup() { return this.db.batch([this.db.prepare("DELETE FROM request_log WHERE timestamp<?").bind(since(2*86_400_000)),this.db.prepare("DELETE FROM cache WHERE cached_at<?").bind(since(LIMITS.cacheMinutes*60_000)),this.db.prepare("DELETE FROM bot_state WHERE updated_at<? AND state_key IN ('waiting_support','admin_reply')").bind(since(7*86_400_000)),this.db.prepare("DELETE FROM processed_updates WHERE status='done' AND updated_at<?").bind(since(7*86_400_000)),this.db.prepare("DELETE FROM user_events WHERE user_id=0 AND timestamp<?").bind(since(30*86_400_000))]); }
}
