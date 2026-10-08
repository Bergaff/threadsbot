import { LIMITS, type Env, excludedIds } from "./config";
import { percentile } from "./analytics";

const now = () => new Date().toISOString();
const since = (ms: number) => new Date(Date.now() - ms).toISOString();
export type StateName =
  | "last_button"
  | "last_username"
  | "waiting_support"
  | "admin_reply"
  | "fetch_lock"
  | "last_daily_probe"
  /** Карта {токен: ISO-дата истечения} активных админских сессий. */
  | "admin_sessions"
  /** Счётчик неудачных попыток входа в админку для защиты от перебора. */
  | "admin_login_fails"
  /** Логин и PBKDF2-хеш пароля страницы статистики для рекламодателей */
  | "stats_access"
  /** Сессии страницы статистики {токен: ISO-дата истечения} */
  | "stats_sessions"
  /** Счётчик неудачных входов на страницу статистики */
  | "stats_login_fails"
  /** Отметка «счёт CryptoBot уже активирован» (scope cinv:<id>) */
  | "paid_invoice"
  /** Отметка «заказ из платёжного вебхука уже обработан» (scope order:<id>) */
  | "paid_order"
  /** Последний отчёт ежедневной самодиагностики (JSON DiagReport) */
  | "diag_last"
  /** История самодиагностики: последние 14 запусков [{at, ok, fails}] */
  | "diag_history";

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

  logEvent(uid: number, type: string, data = "") {
    if (!this.db?.prepare) return Promise.resolve() as any;
    return this.db.prepare("INSERT INTO user_events(user_id,event_type,event_data,timestamp) VALUES(?,?,?,?)").bind(uid,type,data,now()).run();
  }
  logRequest(uid: number, username: string) {
    if (!this.db?.prepare) return Promise.resolve() as any;
    return this.db.prepare("INSERT INTO request_log(user_id,username_requested,timestamp) VALUES(?,?,?)").bind(uid,username,now()).run();
  }
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
  async activate(uid: number, method: string, amount: number, days: number = LIMITS.subscriptionDays): Promise<Date> {
    const old = await this.subscription(uid);
    const base = old?.active ? new Date(String(old.expires_at)) : new Date();
    const expiry = new Date(base.getTime() + days * 86_400_000);
    await this.db.batch([
      this.db.prepare("INSERT INTO subscriptions(user_id,expires_at,payment_method,total_paid,payments_count) VALUES(?,?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,payment_method=excluded.payment_method,total_paid=total_paid+excluded.total_paid,payments_count=payments_count+1").bind(uid,expiry.toISOString(),method,amount),
      this.db.prepare("INSERT INTO payments_log(user_id,amount,method,timestamp) VALUES(?,?,?,?)").bind(uid,String(amount),method,now()),
    ]);
    return expiry;
  }
  async subscribers() { return (await this.db.prepare("SELECT * FROM subscriptions WHERE expires_at>?").bind(now()).all()).results; }

  async initTrackingTables(): Promise<void> {
    try {
      await this.db.batch([
        this.db.prepare(`CREATE TABLE IF NOT EXISTS tracked_authors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          last_post_id TEXT,
          last_post_text TEXT,
          last_checked_at TEXT
        )`),
        this.db.prepare(`CREATE TABLE IF NOT EXISTS user_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          author_username TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(user_id, author_username)
        )`),
        this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_tracks_user ON user_tracks(user_id)`),
        this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_tracks_author ON user_tracks(author_username)`)
      ]);
    } catch (_) {}
  }

  async addTrack(userId: number, authorUsername: string): Promise<{ ok: boolean; count: number; max: number; error?: string }> {
    await this.initTrackingTables();
    const cleanUser = authorUsername.replace(/^@/, "").toLowerCase();
    const sub = await this.subscription(userId);
    const max = sub?.active ? 5 : 0;

    const countRow = await this.db.prepare("SELECT COUNT(*) c FROM user_tracks WHERE user_id=?").bind(userId).first<{ c: number }>();
    const count = Number(countRow?.c || 0);

    if (count >= max) {
      return { ok: false, count, max, error: max === 0 ? "free_limit" : "limit_reached" };
    }

    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO tracked_authors(username, last_checked_at) VALUES(?,?)").bind(cleanUser, now()),
      this.db.prepare("INSERT OR REPLACE INTO user_tracks(user_id, author_username, created_at) VALUES(?,?,?)").bind(userId, cleanUser, now())
    ]);

    return { ok: true, count: count + 1, max };
  }

  async removeTrack(userId: number, authorUsername: string): Promise<boolean> {
    await this.initTrackingTables();
    const cleanUser = authorUsername.replace(/^@/, "").toLowerCase();
    const res = await this.db.prepare("DELETE FROM user_tracks WHERE user_id=? AND author_username=?").bind(userId, cleanUser).run();
    return Boolean(res.meta?.changes);
  }

  async getUserTracks(userId: number): Promise<string[]> {
    await this.initTrackingTables();
    const res = await this.db.prepare("SELECT author_username FROM user_tracks WHERE user_id=? ORDER BY created_at DESC").bind(userId).all<{ author_username: string }>();
    return (res.results || []).map(r => r.author_username);
  }

  async getTrackedAuthorsToPoll(limit = 6): Promise<{ username: string; last_post_id: string | null }[]> {
    await this.initTrackingTables();
    const res = await this.db.prepare(`
      SELECT a.username, a.last_post_id 
      FROM tracked_authors a
      INNER JOIN user_tracks u ON u.author_username = a.username
      GROUP BY a.username
      ORDER BY a.last_checked_at ASC
      LIMIT ?
    `).bind(limit).all<{ username: string; last_post_id: string | null }>();
    return res.results || [];
  }

  async updateTrackedAuthor(username: string, lastPostId: string, lastPostText = ""): Promise<void> {
    await this.initTrackingTables();
    const cleanUser = username.replace(/^@/, "").toLowerCase();
    await this.db.prepare(
      "UPDATE tracked_authors SET last_post_id=?, last_post_text=?, last_checked_at=? WHERE username=?"
    ).bind(lastPostId, lastPostText, now(), cleanUser).run();
  }

  async getSubscribersForAuthor(username: string): Promise<number[]> {
    await this.initTrackingTables();
    const cleanUser = username.replace(/^@/, "").toLowerCase();
    const res = await this.db.prepare(
      "SELECT user_id FROM user_tracks WHERE author_username=?"
    ).bind(cleanUser).all<{ user_id: number }>();
    return (res.results || []).map(r => Number(r.user_id));
  }

  async cache<T>(username:string, mode:string, page=0): Promise<T|null> {
    if (!this.db?.prepare) return null;
    const row = await this.db.prepare("SELECT data,cached_at FROM cache WHERE username=? AND mode=? AND page=?").bind(username,mode,page).first<{data:string;cached_at:string}>();
    if (!row) return null;
    const age = Date.now() - new Date(row.cached_at).getTime();
    if (age >= LIMITS.cacheMinutes * 60_000) return null;
    try {
      const parsed = JSON.parse(row.data) as any;
      if (parsed && (parsed.notFound || parsed.status === "user_not_found")) {
        // Отрицательный кеш (не найден) живет максимум 2 минуты (120 секунд), чтобы не блокировать профили при временных сбоях
        if (age >= 120_000) return null;
      }
      return parsed as T;
    } catch {
      return null;
    }
  }
  setCache(username:string, mode:string, data:unknown, page=0) {
    if (!this.db?.prepare) return Promise.resolve() as any;
    return this.db.prepare("INSERT INTO cache VALUES(?,?,?,?,?) ON CONFLICT(username,mode,page) DO UPDATE SET data=excluded.data,cached_at=excluded.cached_at").bind(username,mode,page,JSON.stringify(data),now()).run();
  }
  deleteCache(username:string, mode:string, page=0) {
    if (!this.db?.prepare) return Promise.resolve() as any;
    return this.db.prepare("DELETE FROM cache WHERE username=? AND mode=? AND page=?").bind(username,mode,page).run();
  }

  async state(scope:string|number,key:StateName): Promise<string|null> { return (await this.db.prepare("SELECT value FROM bot_state WHERE scope=? AND state_key=?").bind(String(scope),key).first<{value:string}>())?.value || null; }
  setState(scope:string|number,key:StateName,value:string) { return this.db.prepare("INSERT INTO bot_state VALUES(?,?,?,?) ON CONFLICT(scope,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(scope),key,value,now()).run(); }
  clearState(scope:string|number,key:StateName) { return this.db.prepare("DELETE FROM bot_state WHERE scope=? AND state_key=?").bind(String(scope),key).run(); }

  async createTicket(uid:number, username:string, message:string, type:string): Promise<number> { const r=await this.db.prepare("INSERT INTO support_tickets(user_id,username,message,ticket_type,status,created_at) VALUES(?,?,?,?,'open',?)").bind(uid,username,message,type,now()).run(); return Number(r.meta.last_row_id); }
  ticket(id:number) { return this.db.prepare("SELECT * FROM support_tickets WHERE id=?").bind(id).first<Record<string,unknown>>(); }
  async tickets(uid?:number) { const q=uid?this.db.prepare("SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 5").bind(uid):this.db.prepare("SELECT * FROM support_tickets WHERE status='open' ORDER BY created_at DESC"); return (await q.all()).results; }
  answerTicket(id:number, answer:string) { return this.db.prepare("UPDATE support_tickets SET status='answered',answer=?,answered_at=? WHERE id=?").bind(answer,now(),id).run(); }

  async accountCounts() { return await this.db.prepare("SELECT COUNT(*) total,SUM(enabled) enabled,SUM(enabled AND is_alive) alive FROM threads_accounts").first<{total:number;enabled:number;alive:number}>() || {total:0,enabled:0,alive:0}; }
  async accountStats() { return (await this.db.prepare("SELECT name,is_alive,last_error,requests_count,posts_sent,errors_count,hourly_requests,hourly_reset,last_used,updated_at,cookies FROM threads_accounts ORDER BY name").all()).results; }
  /** Только включенные аккаунты (enabled=1) — для ежедневного автотеста сессий */
  async enabledAccountNames(): Promise<string[]> {
    const res = await this.db.prepare("SELECT name FROM threads_accounts WHERE enabled=1 ORDER BY name").all<{ name: string }>();
    return (res.results || []).map(r => String(r.name));
  }

  /**
   * Аккаунты, которые не обновлялись дольше указанного срока и нуждаются в автопродлении сессии.
   * Сортировка по возрастанию updated_at: первыми прогреваются самые "холодные",
   * то есть те, у которых больше всего риск потерять сессию.
   *
   * Только is_alive=1: сессию, которую Meta уже аннулировала, Keep-Alive оживить не может,
   * поэтому гонять браузер по мёртвым аккаунтам - пустая трата лимита Browser Rendering.
   * Их лечит только свежий экспорт cookies; они видны в deadAccountNames() и в суточной сводке.
   */
  async accountsStaleForKeepAlive(hours: number, limit = 3): Promise<string[]> {
    const cutoff = new Date(Date.now() - Math.max(1, hours) * 3_600_000).toISOString();
    const res = await this.db.prepare(
      "SELECT name FROM threads_accounts WHERE enabled=1 AND is_alive=1 AND (updated_at IS NULL OR updated_at < ?) ORDER BY updated_at ASC LIMIT ?"
    ).bind(cutoff, Math.max(1, limit)).all<{ name: string }>();
    return (res.results || []).map(r => String(r.name));
  }

  /** Аккаунты, помеченные мёртвыми: по ним автопродление уже не поможет, нужен ручной логин. */
  async deadAccountNames(): Promise<string[]> {
    const res = await this.db.prepare(
      "SELECT name, COALESCE(last_error,'') AS reason FROM threads_accounts WHERE enabled=1 AND is_alive=0 ORDER BY name"
    ).all<{ name: string; reason: string }>();
    return (res.results || []).map(r => `${r.name}${r.reason ? ` (${r.reason})` : ""}`);
  }
  async accountCookie(name:string) { return await this.db.prepare("SELECT cookies FROM threads_accounts WHERE name=?").bind(name).first<{cookies:string}>(); }
  async accountDelete(name:string) { return this.db.prepare("DELETE FROM threads_accounts WHERE name=?").bind(name).run(); }
  /** ВАЖНО: сохраняет/обновляет cookies аккаунта. Раньше здесь была опечатка iso() -> ReferenceError, из-за
   *  чего загрузка JSON и запись «жила» аккаунта падали. Теперь используется общий now(). */
  accountUpsert(name: string, cookies: string, alive = true, lastError: string | null = null) {
    const ts = now();
    const flag = alive ? 1 : 0;
    return this.db.prepare(
      "INSERT INTO threads_accounts(name,cookies,enabled,is_alive,last_error,hourly_reset,updated_at) VALUES(?,?,1,?,?,?,?) " +
      "ON CONFLICT(name) DO UPDATE SET cookies=excluded.cookies,enabled=1,is_alive=excluded.is_alive,last_error=excluded.last_error,updated_at=excluded.updated_at"
    ).bind(name, cookies, flag, lastError, ts, ts).run();
  }
  accountMarkDead(name: string, reason: string) {
    return this.db.prepare("UPDATE threads_accounts SET is_alive=0,last_error=?,updated_at=? WHERE name=?").bind(reason, now(), name).run();
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
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='web_view' AND timestamp>?`).bind(one),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='web_api' AND timestamp>?`).bind(one),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='web_comments' AND timestamp>?`).bind(one),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='web_bot_crawl' AND timestamp>?`).bind(one),
      this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='web_bot_crawl' AND timestamp>?`).bind(seven),
    ];
    const r=await this.db.batch(queries); const modes=(r[5]?.results || []) as {event_data?:string;c:number}[];
    const count=(i:number)=>Number((r[i]?.results?.[0] as {c:number}|undefined)?.c||0);
    const botReqs = count(3);
    const webViews = count(8);
    const webApi = count(9);
    const webComments = count(10);
    const botCrawls24h = count(11);
    const botCrawls7d = count(12);
    const webHumanRequests = webViews + webApi + webComments;
    const webRequests = webHumanRequests + botCrawls24h;
    return {
      newUsers: count(0),
      dau: count(1),
      active7d: count(2),
      requests: botReqs,
      botRequests: botReqs,
      webViews,
      webApi,
      webComments,
      webRequests,
      webHumanRequests,
      botCrawls24h,
      botCrawls7d,
      totalRequests: botReqs + webRequests,
      exhausted: count(4),
      newSubs: count(6),
      revenue: count(7),
      text: modes.filter(x=>(x?.event_data||'').startsWith('text:')).reduce((a,x)=>a+Number(x.c),0),
      img: modes.filter(x=>(x?.event_data||'').startsWith('img:')).reduce((a,x)=>a+Number(x.c),0),
      comments: modes.filter(x=>(x?.event_data||'').startsWith('comments:')).reduce((a,x)=>a+Number(x.c),0),
    };
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

  /**
   * Честная статистика сайта (события с pr65). Всё считается из сырых событий,
   * без подстановок: если данных нет - возвращается 0 / пустой список.
   */
  async siteTruth(): Promise<SiteTruth> {
    const one = since(86_400_000), seven = since(7 * 86_400_000);
    const empty: SiteTruth = {
      pv: { home: 0, profile: 0, post: 0, total: 0 }, uv24h: 0, js24h: 0, dc24h: 0, dcTop: [],
      api24h: 0, more24h: 0, comments24h: 0, geo24h: [], geo7d: [], geoTotal24h: 0, geoTotal7d: 0,
      robots24h: { total: 0, byKind: {}, top: [] },
      scrape: {}, webMs: emptyDist(), botMs24h: emptyDist(), botMs7d: emptyDist(), accounts: {}, daily: [], since: null,
      scrapeErrors: [], scrapeErrorGroups: [],
    };
    if (!this.db?.prepare) return empty;
    const all = async <T>(sql: string, ...args: unknown[]): Promise<T[]> => {
      try { return ((await this.db.prepare(sql).bind(...args).all<T>())?.results || []) as T[]; } catch { return []; }
    };
    const excluded = excludedIds(this.env);
    const marks = excluded.map(() => "?").join(",");
    const tgClause = ` AND user_id<>0${excluded.length ? ` AND user_id NOT IN (${marks})` : ""}`;

    const [pvRows, uvRows, simpleRows, dcRows, geo24, geo7, robotRows, scrapeRows, webMsRows, botMs7Rows, acctRows, dailyRows, dailyTg, firstRow] = await Promise.all([
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_pv' AND timestamp>? GROUP BY event_data", one),
      all<{ t: string; c: number }>("SELECT event_type t, COUNT(DISTINCT event_data) c FROM user_events WHERE event_type IN ('web_uv','web_js') AND timestamp>? GROUP BY event_type", one),
      all<{ t: string; c: number }>("SELECT event_type t, COUNT(*) c FROM user_events WHERE event_type IN ('web_dc','web_api','web_more','web_comments') AND timestamp>? GROUP BY event_type", one),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_dc' AND timestamp>? GROUP BY event_data ORDER BY c DESC LIMIT 6", one),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_geo' AND timestamp>? GROUP BY event_data ORDER BY c DESC", one),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_geo' AND timestamp>? GROUP BY event_data ORDER BY c DESC", seven),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_robot' AND timestamp>? GROUP BY event_data", one),
      all<{ k: string; ts: string }>("SELECT event_data k, timestamp ts FROM user_events WHERE event_type='scrape' AND timestamp>? ORDER BY id DESC LIMIT 5000", one),
      all<{ v: number }>("SELECT CAST(event_data AS REAL) v FROM user_events WHERE event_type='web_ms' AND timestamp>? ORDER BY v LIMIT 20000", one),
      all<{ v: number; ts: string }>("SELECT CAST(event_data AS REAL) v, timestamp ts FROM user_events WHERE event_type='bot_latency' AND timestamp>? ORDER BY v LIMIT 20000", seven),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='acct' AND timestamp>? GROUP BY event_data", one),
      all<{ day: string; t: string; c: number; u: number }>(
        "SELECT substr(timestamp,1,10) day, event_type t, COUNT(*) c, COUNT(DISTINCT event_data) u FROM user_events " +
        "WHERE event_type IN ('web_pv','web_uv','web_js','web_robot','web_view','web_api','web_comments','web_post_view','web_bot_crawl') AND timestamp>? " +
        "GROUP BY day, event_type", seven),
      all<{ day: string; c: number; u: number }>(`SELECT substr(timestamp,1,10) day, COUNT(*) c, COUNT(DISTINCT user_id) u FROM user_events WHERE event_type='request' AND timestamp>?${tgClause} GROUP BY day`, seven, ...excluded),
      all<{ ts: string }>("SELECT MIN(timestamp) ts FROM user_events WHERE event_type IN ('web_pv','web_robot')"),
    ]);

    const out = empty;
    for (const r of pvRows) {
      const k = String(r.k) as "home" | "profile" | "post";
      if (k in out.pv) (out.pv as any)[k] = Number(r.c || 0);
    }
    out.pv.total = out.pv.home + out.pv.profile + out.pv.post;
    for (const r of uvRows) {
      if (r.t === "web_uv") out.uv24h = Number(r.c || 0);
      if (r.t === "web_js") out.js24h = Number(r.c || 0);
    }
    for (const r of simpleRows) {
      const c = Number(r.c || 0);
      if (r.t === "web_dc") out.dc24h = c;
      if (r.t === "web_api") out.api24h = c;
      if (r.t === "web_more") out.more24h = c;
      if (r.t === "web_comments") out.comments24h = c;
    }
    out.dcTop = dcRows.map((r) => ({ name: String(r.k || "?"), count: Number(r.c || 0) }));
    const geo = (rows: { k: string; c: number }[]) => {
      const total = rows.reduce((a, r) => a + Number(r.c || 0), 0);
      return { total, list: rows.slice(0, 12).map((r) => ({ country: String(r.k || "XX"), count: Number(r.c || 0), percent: total ? Math.round((Number(r.c) / total) * 100) : 0 })) };
    };
    const g24 = geo(geo24), g7 = geo(geo7);
    out.geo24h = g24.list; out.geoTotal24h = g24.total; out.geo7d = g7.list; out.geoTotal7d = g7.total;

    const byName = new Map<string, number>();
    for (const r of robotRows) {
      const [kind = "search", name = "?"] = String(r.k || "").split(":");
      const c = Number(r.c || 0);
      out.robots24h.total += c;
      out.robots24h.byKind[kind] = (out.robots24h.byKind[kind] || 0) + c;
      byName.set(`${kind}:${name}`, (byName.get(`${kind}:${name}`) || 0) + c);
    }
    out.robots24h.top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, c]) => ({ kind: k.split(":")[0], name: k.split(":").slice(1).join(":"), count: c }));

    const scrapeMs: Record<string, number[]> = {};
    const groups = new Map<string, { kind: string; status: string; error: string; count: number; lastTs: string; lastTarget: string }>();
    for (const r of scrapeRows) {
      const [kind = "?", status = "?", posts = "0", ms = "0", target = "", ...errParts] = String(r.k || "").split("|");
      const error = errParts.join("|");
      // Самодиагностика (kind=diag) в боевую статистику не входит - у неё свой отчёт
      if (kind === "diag") continue;
      const b = out.scrape[kind] || (out.scrape[kind] = { total: 0, ok: 0, notFound: 0, failed: 0, posts: 0, ms: emptyDist() });
      b.total++;
      if (status === "ok") { b.ok++; b.posts += Number(posts) || 0; }
      else if (status === "user_not_found" || status === "post_not_found") b.notFound++;
      else b.failed++;
      (scrapeMs[kind] ||= []).push(Number(ms) || 0);
      if (status !== "ok") {
        const ts = String(r.ts || "");
        if (out.scrapeErrors.length < 40) out.scrapeErrors.push({ ts, kind, status, target, error, ms: Number(ms) || 0 });
        // Группируем по виду ошибки; цифры и имена аккаунтов в тексте не должны дробить группы
        const norm = error.replace(/\[[^\]]*\]/g, "[…]").replace(/\d+/g, "N").slice(0, 120);
        const key = `${kind}|${status}|${norm}`;
        const g = groups.get(key);
        if (g) g.count++;
        else groups.set(key, { kind, status, error: error.slice(0, 400), count: 1, lastTs: ts, lastTarget: target });
      }
    }
    out.scrapeErrorGroups = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 12);
    for (const [kind, list] of Object.entries(scrapeMs)) out.scrape[kind].ms = dist(list.sort((a, b) => a - b));

    out.webMs = dist(webMsRows.map((r) => Number(r.v) || 0));
    const bot7 = botMs7Rows.map((r) => Number(r.v) || 0);
    out.botMs7d = dist(bot7);
    out.botMs24h = dist(botMs7Rows.filter((r) => String(r.ts) > one).map((r) => Number(r.v) || 0));

    for (const r of acctRows) {
      const [name = "?", result = "?"] = String(r.k || "").split("|");
      const a = out.accounts[name] || (out.accounts[name] = { ok: 0, err: 0, dead: 0 });
      if (result === "ok" || result === "err" || result === "dead") a[result] += Number(r.c || 0);
    }

    const days = new Map<string, DailyTruth>();
    const day = (d: string) => days.get(d) || (days.set(d, { day: d, tgRequests: 0, tgUsers: 0, pv: 0, uv: 0, js: 0, robots: 0, legacyWeb: 0 }), days.get(d)!);
    for (const r of dailyRows) {
      const d = day(String(r.day));
      const c = Number(r.c || 0), u = Number(r.u || 0);
      if (r.t === "web_pv") d.pv = c;
      else if (r.t === "web_uv") d.uv = u;
      else if (r.t === "web_js") d.js = u;
      else if (r.t === "web_robot") d.robots = c;
      else d.legacyWeb += c;
    }
    for (const r of dailyTg) {
      const d = day(String(r.day));
      d.tgRequests = Number(r.c || 0);
      d.tgUsers = Number(r.u || 0);
    }
    out.daily = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7);
    out.since = firstRow[0]?.ts ? String(firstRow[0].ts) : null;
    return out;
  }

  /**
   * Отчёт для рекламодателей за N дней. Только люди (роботы отфильтрованы и показаны одной цифрой).
   * Уникальные посетители считаются по суткам (суточный хеш), поэтому за период отдаём
   * сумму и среднее суточных уникальных - без выдуманной «месячной аудитории».
   */
  async advertiserReport(days: number): Promise<AdvertiserReport> {
    const d = Math.max(1, Math.min(30, Math.floor(days) || 7));
    const from = since(d * 86_400_000);
    const excluded = excludedIds(this.env);
    const marks = excluded.map(() => "?").join(",");
    const tgClause = ` AND user_id<>0${excluded.length ? ` AND user_id NOT IN (${marks})` : ""}`;
    const all = async <T>(sql: string, ...args: unknown[]): Promise<T[]> => {
      try { return ((await this.db.prepare(sql).bind(...args).all<T>())?.results || []) as T[]; } catch { return []; }
    };
    const [dailyRows, geoRows, devRows, refRows, kindRows, dcRows, tgRows, tgTotalRows, firstRows, visitRows, jsRows, visitFirstRows] = await Promise.all([
      all<{ day: string; t: string; c: number; u: number }>(
        "SELECT substr(timestamp,1,10) day, event_type t, COUNT(*) c, COUNT(DISTINCT event_data) u FROM user_events " +
        "WHERE event_type IN ('web_pv','web_uv','web_js','web_robot') AND timestamp>? GROUP BY day, event_type", from),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_geo' AND timestamp>? GROUP BY event_data ORDER BY c DESC", from),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_dev' AND timestamp>? GROUP BY event_data", from),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_ref' AND timestamp>? GROUP BY event_data ORDER BY c DESC", from),
      all<{ k: string; c: number }>("SELECT event_data k, COUNT(*) c FROM user_events WHERE event_type='web_pv' AND timestamp>? GROUP BY event_data", from),
      all<{ c: number }>("SELECT COUNT(*) c FROM user_events WHERE event_type='web_dc' AND timestamp>?", from),
      all<{ c: number }>(`SELECT COUNT(DISTINCT user_id) c FROM user_events WHERE event_type='request' AND timestamp>?${tgClause}`, from, ...excluded),
      all<{ c: number }>("SELECT COUNT(*) c FROM user_settings"),
      all<{ ts: string }>("SELECT MIN(timestamp) ts FROM user_events WHERE event_type='web_pv'"),
      all<{ k: string }>("SELECT event_data k FROM user_events WHERE event_type='web_visit' AND timestamp>? LIMIT 200000", from),
      all<{ k: string }>("SELECT DISTINCT event_data k FROM user_events WHERE event_type='web_js' AND timestamp>?", from),
      all<{ ts: string }>("SELECT MIN(timestamp) ts FROM user_events WHERE event_type='web_visit'"),
    ]);

    const byDay = new Map<string, { day: string; pv: number; uv: number; js: number; robots: number }>();
    const getDay = (k: string) => byDay.get(k) || (byDay.set(k, { day: k, pv: 0, uv: 0, js: 0, robots: 0 }), byDay.get(k)!);
    for (const r of dailyRows) {
      const x = getDay(String(r.day));
      if (r.t === "web_pv") x.pv = Number(r.c || 0);
      else if (r.t === "web_uv") x.uv = Number(r.u || 0);
      else if (r.t === "web_js") x.js = Number(r.u || 0);
      else if (r.t === "web_robot") x.robots = Number(r.c || 0);
    }
    // Непрерывный ряд дат (дни без данных - нули, а не пропуски)
    const daily: AdvertiserReport["daily"] = [];
    for (let i = d - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      daily.push(byDay.get(key) || { day: key, pv: 0, uv: 0, js: 0, robots: 0 });
    }
    const sum = (f: (x: { pv: number; uv: number; js: number; robots: number }) => number) => daily.reduce((a, x) => a + f(x), 0);
    const pageviews = sum((x) => x.pv);
    const visitorDays = sum((x) => x.uv);
    const jsDays = sum((x) => x.js);
    const robots = sum((x) => x.robots);
    const firstTs = firstRows[0]?.ts ? String(firstRows[0].ts) : null;
    const daysWithData = daily.filter((x) => x.pv > 0 || x.uv > 0).length;
    const activeDays = firstTs
      ? Math.max(1, Math.min(d, Math.ceil((Date.now() - new Date(firstTs).getTime()) / 86_400_000)))
      : daysWithData;

    const share = (rows: Array<{ k: string; c: number }>) => {
      const total = rows.reduce((a, r) => a + Number(r.c || 0), 0);
      return { total, list: rows.map((r) => ({ key: String(r.k || ""), count: Number(r.c || 0), percent: total ? (Number(r.c || 0) / total) * 100 : 0 })) };
    };
    const geo = share(geoRows);
    const devAgg = new Map<string, number>(), osAgg = new Map<string, number>();
    for (const r of devRows) {
      const [dev = "desktop", os = "Другая"] = String(r.k || "").split("|");
      devAgg.set(dev, (devAgg.get(dev) || 0) + Number(r.c || 0));
      osAgg.set(os, (osAgg.get(os) || 0) + Number(r.c || 0));
    }
    const toRows = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ k, c }));
    // Источники: только входы на сайт (внутренние переходы исключаем)
    const srcAgg = new Map<string, number>();
    const refAgg = new Map<string, number>();
    for (const r of refRows) {
      const k = String(r.k || "direct");
      if (k === "internal") continue;
      const group = k.split(":")[0];
      srcAgg.set(group, (srcAgg.get(group) || 0) + Number(r.c || 0));
      if (k.includes(":")) refAgg.set(k, (refAgg.get(k) || 0) + Number(r.c || 0));
    }
    const pvKinds: Record<string, number> = {};
    for (const r of kindRows) pvKinds[String(r.k)] = Number(r.c || 0);

    // С pr73: разбивки только по посетителям, подтверждённым браузером (web_visit + web_js по vid).
    // Неподтверждённые (браузерный User-Agent, но JS не выполнен) - в основном автоматический трафик,
    // их показываем отдельной строкой, а не смешиваем с людьми.
    const verified = (() => {
      if (!visitRows.length) return null;
      const jsSet = new Set(jsRows.map((r) => String(r.k || "")));
      const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) || 0) + n);
      const geoM = new Map<string, number>(), devM = new Map<string, number>(), osM = new Map<string, number>();
      const srcM = new Map<string, number>(), refM = new Map<string, number>(), kindM = new Map<string, number>();
      const vids = new Set<string>(), unVids = new Map<string, string>();
      let pv = 0, dc = 0;
      for (const r of visitRows) {
        const [vid = "", country = "XX", pageKind = "home", device = "desktop", os = "Другая", source = "direct", isDc = "0"] = String(r.k || "").split("|");
        if (!vid) continue;
        if (!jsSet.has(vid)) { if (!unVids.has(vid)) unVids.set(vid, country); continue; }
        pv++;
        vids.add(vid);
        inc(geoM, country); inc(devM, device); inc(osM, os); inc(kindM, pageKind);
        if (isDc === "1") dc++;
        if (source !== "internal") {
          inc(srcM, source.split(":")[0]);
          if (source.includes(":")) inc(refM, source);
        }
      }
      const unGeo = new Map<string, number>();
      for (const c of unVids.values()) inc(unGeo, c);
      const g = share(toRows(geoM));
      return {
        since: visitFirstRows[0]?.ts ? String(visitFirstRows[0].ts) : null,
        pageviews: pv,
        visitors: vids.size,
        pvKinds: Object.fromEntries(kindM),
        vpnViews: dc,
        geo: g.list.slice(0, 15),
        geoTotal: g.total,
        devices: share(toRows(devM)).list,
        os: share(toRows(osM)).list,
        sources: share(toRows(srcM)).list,
        topReferrers: share(toRows(refM)).list.slice(0, 10),
        unverifiedVisitors: unVids.size,
        unverifiedGeo: share(toRows(unGeo)).list.slice(0, 6),
      };
    })();

    return {
      days: d,
      activeDays,
      since: firstTs,
      pageviews,
      pvKinds,
      visitorDays,
      avgDailyVisitors: activeDays ? visitorDays / activeDays : 0,
      jsVisitorDays: jsDays,
      pagesPerVisitor: visitorDays ? pageviews / visitorDays : 0,
      robotsFiltered: robots,
      vpnViews: Number(dcRows[0]?.c || 0),
      geo: geo.list.slice(0, 15),
      geoTotal: geo.total,
      devices: share(toRows(devAgg)).list,
      os: share(toRows(osAgg)).list,
      sources: share(toRows(srcAgg)).list,
      topReferrers: share(toRows(refAgg)).list.slice(0, 10),
      tgActiveUsers: Number(tgRows[0]?.c || 0),
      tgTotalUsers: Number(tgTotalRows[0]?.c || 0),
      daily,
      avgDailyVerified: activeDays ? jsDays / activeDays : 0,
      verified,
    };
  }

  async getSystemLogs(limit = 40): Promise<{ id: number; data: string; timestamp: string }[]> {
    const res = await this.db.prepare(
      "SELECT id, event_data as data, timestamp FROM user_events WHERE event_type='system_log' ORDER BY id DESC LIMIT ?"
    ).bind(limit).all<{ id: number; data: string; timestamp: string }>();
    return res.results || [];
  }

  async clearSystemLogs(): Promise<void> {
    await this.db.prepare("DELETE FROM user_events WHERE event_type='system_log'").run();
  }

  async weeklyStats(): Promise<{
    bot7d: number;
    web7d: number;
    total7d: number;
    daily: Array<{ day: string; bot: number; web: number; total: number }>;
  }> {
    const seven = since(7 * 86_400_000);
    const excluded = excludedIds(this.env);
    const marks = excluded.map(() => "?").join(",");
    const clause = ` AND user_id<>0${excluded.length ? ` AND user_id NOT IN (${marks})` : ""}`;

    try {
      const [botRes, webRes, dailyRes] = await Promise.all([
        this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type='request' AND timestamp>?${clause}`).bind(seven, ...excluded).first<{ c: number }>(),
        this.db.prepare(`SELECT COUNT(*) c FROM user_events WHERE event_type IN ('web_view','web_api','web_comments','web_post_view') AND timestamp>?`).bind(seven).first<{ c: number }>(),
        this.db.prepare(
          `SELECT substr(timestamp, 1, 10) as day,
                  COUNT(CASE WHEN event_type='request' THEN 1 END) as bot,
                  COUNT(CASE WHEN event_type IN ('web_view','web_api','web_comments','web_post_view') THEN 1 END) as web,
                  COUNT(*) as total
           FROM user_events
           WHERE event_type IN ('request','web_view','web_api','web_comments','web_post_view') AND timestamp>?
           GROUP BY substr(timestamp, 1, 10)
           ORDER BY day DESC
           LIMIT 7`
        ).bind(seven).all<{ day: string; bot: number; web: number; total: number }>(),
      ]);

      const bot7d = Number(botRes?.c || 0);
      const web7d = Number(webRes?.c || 0);
      const daily = (dailyRes?.results || []).map(d => ({
        day: String(d.day || ""),
        bot: Number(d.bot || 0),
        web: Number(d.web || 0),
        total: Number(d.total || 0),
      }));

      return { bot7d, web7d, total7d: bot7d + web7d, daily };
    } catch {
      return { bot7d: 0, web7d: 0, total7d: 0, daily: [] };
    }
  }

  async channelLatencyStats(eventType: "bot_latency" | "web_latency"): Promise<{
    avg24h: number;
    min24h: number;
    max24h: number;
    count24h: number;
    avg7d: number;
    min7d: number;
    max7d: number;
    count7d: number;
  }> {
    const one = since(86_400_000);
    const seven = since(7 * 86_400_000);
    const fmt = (ms?: number) => {
      if (!ms || ms <= 0) return 0;
      const sec = Number(ms) / 1000;
      if (sec < 0.1) return Math.round(sec * 100) / 100;
      return Math.round(sec * 10) / 10;
    };
    try {
      const [r24, r7] = await Promise.all([
        this.db.prepare(
          `SELECT AVG(CAST(event_data AS REAL)) a, MIN(CAST(event_data AS REAL)) mn, MAX(CAST(event_data AS REAL)) mx, COUNT(*) c
           FROM user_events WHERE event_type=? AND timestamp>?`
        ).bind(eventType, one).first<{ a?: number; mn?: number; mx?: number; c?: number }>(),
        this.db.prepare(
          `SELECT AVG(CAST(event_data AS REAL)) a, MIN(CAST(event_data AS REAL)) mn, MAX(CAST(event_data AS REAL)) mx, COUNT(*) c
           FROM user_events WHERE event_type=? AND timestamp>?`
        ).bind(eventType, seven).first<{ a?: number; mn?: number; mx?: number; c?: number }>(),
      ]);

      return {
        avg24h: r24?.a ? fmt(r24.a) : 0,
        min24h: r24?.mn ? fmt(r24.mn) : 0,
        max24h: r24?.mx ? fmt(r24.mx) : 0,
        count24h: Number(r24?.c || 0),
        avg7d: r7?.a ? fmt(r7.a) : 0,
        min7d: r7?.mn ? fmt(r7.mn) : 0,
        max7d: r7?.mx ? fmt(r7.mx) : 0,
        count7d: Number(r7?.c || 0),
      };
    } catch {
      return { avg24h: 0, min24h: 0, max24h: 0, count24h: 0, avg7d: 0, min7d: 0, max7d: 0, count7d: 0 };
    }
  }

  async botLatencyStats() {
    return this.channelLatencyStats("bot_latency");
  }

  async webLatencyStats() {
    return this.channelLatencyStats("web_latency");
  }

  async visitorCountries(): Promise<{
    top24h: Array<{ country: string; count: number; percent: number }>;
    top7d: Array<{ country: string; count: number; percent: number }>;
    topHuman24h: Array<{ country: string; count: number; percent: number }>;
    topBots24h: Array<{ bot: string; count: number; percent: number }>;
    total24h: number;
    total7d: number;
    totalHuman24h: number;
  }> {
    const one = since(86_400_000);
    const seven = since(7 * 86_400_000);

    try {
      const [res24, res7, resHuman24, resBots24] = await Promise.all([
        this.db.prepare(
          `SELECT event_data as country, COUNT(*) as c
           FROM user_events
           WHERE event_type='web_country' AND timestamp>?
           GROUP BY event_data
           ORDER BY c DESC
           LIMIT 12`
        ).bind(one).all<{ country: string; c: number }>(),
        this.db.prepare(
          `SELECT event_data as country, COUNT(*) as c
           FROM user_events
           WHERE event_type='web_country' AND timestamp>?
           GROUP BY event_data
           ORDER BY c DESC
           LIMIT 12`
        ).bind(seven).all<{ country: string; c: number }>(),
        this.db.prepare(
          `SELECT event_data as country, COUNT(*) as c
           FROM user_events
           WHERE event_type='web_human_country' AND timestamp>?
           GROUP BY event_data
           ORDER BY c DESC
           LIMIT 12`
        ).bind(one).all<{ country: string; c: number }>(),
        this.db.prepare(
          `SELECT SUBSTR(event_data, 1, INSTR(event_data || ':', ':') - 1) as bot, COUNT(*) as c
           FROM user_events
           WHERE event_type='web_bot_crawl' AND timestamp>?
           GROUP BY bot
           ORDER BY c DESC
           LIMIT 8`
        ).bind(one).all<{ bot: string; c: number }>(),
      ]);

      const list24 = (res24?.results || []).map(r => ({ country: String(r.country || "XX").toUpperCase(), count: Number(r.c || 0) }));
      const list7 = (res7?.results || []).map(r => ({ country: String(r.country || "XX").toUpperCase(), count: Number(r.c || 0) }));
      const listHuman24 = (resHuman24?.results || []).map(r => ({ country: String(r.country || "XX").toUpperCase(), count: Number(r.c || 0) }));
      const listBots24 = (resBots24?.results || []).map(r => ({ bot: String(r.bot || "Bot"), count: Number(r.c || 0) }));

      const total24h = list24.reduce((s, x) => s + x.count, 0);
      const total7d = list7.reduce((s, x) => s + x.count, 0);
      const totalHuman24h = listHuman24.reduce((s, x) => s + x.count, 0);
      const totalBots24h = listBots24.reduce((s, x) => s + x.count, 0);

      const top24h = list24.map(x => ({ ...x, percent: total24h > 0 ? Math.round((x.count / total24h) * 100) : 0 }));
      const top7d = list7.map(x => ({ ...x, percent: total7d > 0 ? Math.round((x.count / total7d) * 100) : 0 }));
      const topHuman24h = listHuman24.map(x => ({ ...x, percent: totalHuman24h > 0 ? Math.round((x.count / totalHuman24h) * 100) : 0 }));
      const topBots24h = listBots24.map(x => ({ ...x, percent: totalBots24h > 0 ? Math.round((x.count / totalBots24h) * 100) : 0 }));

      return { top24h, top7d, topHuman24h, topBots24h, total24h, total7d, totalHuman24h };
    } catch {
      return { top24h: [], top7d: [], topHuman24h: [], topBots24h: [], total24h: 0, total7d: 0, totalHuman24h: 0 };
    }
  }

  async repeatRequestStats(): Promise<{
    totalUsers: number;
    repeatUsers: number;
    singleUsers: number;
    repeatPercent: number;
    immediate: number;      // <= 2 мин (< 120 сек)
    withinHour: number;     // 2 - 60 мин
    withinDay: number;      // 1 - 24 ч
    laterDays: number;      // > 24 ч
    immediatePct: number;
    withinHourPct: number;
    withinDayPct: number;
    laterDaysPct: number;
  }> {
    try {
      const q = `
        WITH user_reqs AS (
          SELECT user_id, timestamp,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp ASC) as rn
          FROM user_events
          WHERE event_type='request' AND user_id > 0
        ),
        pairs AS (
          SELECT r1.user_id,
                 (julianday(r2.timestamp) - julianday(r1.timestamp)) * 86400 as diff_sec
          FROM user_reqs r1
          JOIN user_reqs r2 ON r1.user_id = r2.user_id AND r2.rn = 2
          WHERE r1.rn = 1
        )
        SELECT 
          (SELECT COUNT(DISTINCT user_id) FROM user_events WHERE event_type='request' AND user_id > 0) as total_users,
          COUNT(*) as repeat_users,
          COUNT(CASE WHEN diff_sec <= 120 THEN 1 END) as immediate,
          COUNT(CASE WHEN diff_sec > 120 AND diff_sec <= 3600 THEN 1 END) as within_hour,
          COUNT(CASE WHEN diff_sec > 3600 AND diff_sec <= 86400 THEN 1 END) as within_day,
          COUNT(CASE WHEN diff_sec > 86400 THEN 1 END) as later_days
        FROM pairs;
      `;
      const row = await this.db.prepare(q).first<{
        total_users?: number;
        repeat_users?: number;
        immediate?: number;
        within_hour?: number;
        within_day?: number;
        later_days?: number;
      }>();

      const totalUsers = Number(row?.total_users || 0);
      const repeatUsers = Number(row?.repeat_users || 0);
      const singleUsers = Math.max(0, totalUsers - repeatUsers);
      const repeatPercent = totalUsers > 0 ? Math.round((repeatUsers / totalUsers) * 100) : 0;

      const immediate = Number(row?.immediate || 0);
      const withinHour = Number(row?.within_hour || 0);
      const withinDay = Number(row?.within_day || 0);
      const laterDays = Number(row?.later_days || 0);

      const immediatePct = repeatUsers > 0 ? Math.round((immediate / repeatUsers) * 100) : 0;
      const withinHourPct = repeatUsers > 0 ? Math.round((withinHour / repeatUsers) * 100) : 0;
      const withinDayPct = repeatUsers > 0 ? Math.round((withinDay / repeatUsers) * 100) : 0;
      const laterDaysPct = repeatUsers > 0 ? Math.round((laterDays / repeatUsers) * 100) : 0;

      return {
        totalUsers,
        repeatUsers,
        singleUsers,
        repeatPercent,
        immediate,
        withinHour,
        withinDay,
        laterDays,
        immediatePct,
        withinHourPct,
        withinDayPct,
        laterDaysPct,
      };
    } catch {
      return {
        totalUsers: 0,
        repeatUsers: 0,
        singleUsers: 0,
        repeatPercent: 0,
        immediate: 0,
        withinHour: 0,
        withinDay: 0,
        laterDays: 0,
        immediatePct: 0,
        withinHourPct: 0,
        withinDayPct: 0,
        laterDaysPct: 0,
      };
    }
  }

  cleanup() { return this.db.batch([this.db.prepare("DELETE FROM request_log WHERE timestamp<?").bind(since(14*86_400_000)),this.db.prepare("DELETE FROM cache WHERE cached_at<?").bind(since(LIMITS.cacheMinutes*60_000)),this.db.prepare("DELETE FROM bot_state WHERE updated_at<? AND state_key IN ('waiting_support','admin_reply')").bind(since(7*86_400_000)),this.db.prepare("DELETE FROM processed_updates WHERE status='done' AND updated_at<?").bind(since(7*86_400_000)),this.db.prepare("DELETE FROM user_events WHERE user_id=0 AND timestamp<?").bind(since(30*86_400_000))]); }
}

export interface Dist { count: number; median: number; p95: number; max: number }
function emptyDist(): Dist { return { count: 0, median: 0, p95: 0, max: 0 }; }
/** Распределение по ОТСОРТИРОВАННОМУ массиву миллисекунд. */
function dist(sorted: number[]): Dist {
  if (!sorted.length) return emptyDist();
  return { count: sorted.length, median: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
}
export interface DailyTruth { day: string; tgRequests: number; tgUsers: number; pv: number; uv: number; js: number; robots: number; legacyWeb: number }
export interface ScrapeBucket { total: number; ok: number; notFound: number; failed: number; posts: number; ms: Dist }
export interface SiteTruth {
  pv: { home: number; profile: number; post: number; total: number };
  uv24h: number;
  js24h: number;
  dc24h: number;
  dcTop: Array<{ name: string; count: number }>;
  api24h: number;
  more24h: number;
  comments24h: number;
  geo24h: Array<{ country: string; count: number; percent: number }>;
  geo7d: Array<{ country: string; count: number; percent: number }>;
  geoTotal24h: number;
  geoTotal7d: number;
  robots24h: { total: number; byKind: Record<string, number>; top: Array<{ kind: string; name: string; count: number }> };
  scrape: Record<string, ScrapeBucket>;
  webMs: Dist;
  botMs24h: Dist;
  botMs7d: Dist;
  accounts: Record<string, { ok: number; err: number; dead: number }>;
  daily: DailyTruth[];
  /** Когда появились первые события новой аналитики */
  since: string | null;
  /** Последние неуспешные запуски скрапера за 24ч (новые сверху), с pr74 - с текстом ошибки */
  scrapeErrors: ScrapeError[];
  /** Те же ошибки, сгруппированные по виду: что ломается чаще всего */
  scrapeErrorGroups: Array<{ kind: string; status: string; error: string; count: number; lastTs: string; lastTarget: string }>;
}

export interface ScrapeError { ts: string; kind: string; status: string; target: string; error: string; ms: number }

export interface ShareRow { key: string; count: number; percent: number }
export interface AdvertiserReport {
  days: number;
  /** Сколько дней из периода реально покрыто новой статистикой */
  activeDays: number;
  since: string | null;
  pageviews: number;
  pvKinds: Record<string, number>;
  visitorDays: number;
  avgDailyVisitors: number;
  jsVisitorDays: number;
  pagesPerVisitor: number;
  robotsFiltered: number;
  vpnViews: number;
  geo: ShareRow[];
  geoTotal: number;
  devices: ShareRow[];
  os: ShareRow[];
  sources: ShareRow[];
  topReferrers: ShareRow[];
  tgActiveUsers: number;
  tgTotalUsers: number;
  daily: Array<{ day: string; pv: number; uv: number; js: number; robots: number }>;
  /** Среднее в сутки посетителей, подтверждённых браузером (выполнили JS) */
  avgDailyVerified: number;
  /** Разбивки только по подтверждённым посетителям (данные web_visit с pr73); null - данных ещё нет */
  verified: {
    since: string | null;
    pageviews: number;
    visitors: number;
    pvKinds: Record<string, number>;
    vpnViews: number;
    geo: ShareRow[];
    geoTotal: number;
    devices: ShareRow[];
    os: ShareRow[];
    sources: ShareRow[];
    topReferrers: ShareRow[];
    unverifiedVisitors: number;
    unverifiedGeo: ShareRow[];
  } | null;
}
