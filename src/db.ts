import { LIMITS, type Env, excludedIds } from "./config";

const now = () => new Date().toISOString();
const since = (ms: number) => new Date(Date.now() - ms).toISOString();
export type StateName = "last_button" | "last_username" | "waiting_support" | "admin_reply" | "fetch_lock";

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
    if (!row || Date.now()-new Date(row.cached_at).getTime() >= LIMITS.cacheMinutes*60_000) return null;
    return JSON.parse(row.data) as T;
  }
  setCache(username:string, mode:string, data:unknown, page=0) {
    if (!this.db?.prepare) return Promise.resolve() as any;
    return this.db.prepare("INSERT INTO cache VALUES(?,?,?,?,?) ON CONFLICT(username,mode,page) DO UPDATE SET data=excluded.data,cached_at=excluded.cached_at").bind(username,mode,page,JSON.stringify(data),now()).run();
  }

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
    ];
    const r=await this.db.batch(queries); const modes=(r[5]?.results || []) as {event_data?:string;c:number}[];
    const count=(i:number)=>Number((r[i]?.results?.[0] as {c:number}|undefined)?.c||0);
    const botReqs = count(3);
    const webViews = count(8);
    const webApi = count(9);
    const webComments = count(10);
    const webRequests = webViews + webApi + webComments;
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

  async botLatencyStats(): Promise<{
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
    try {
      const [r24, r7] = await Promise.all([
        this.db.prepare(
          `SELECT AVG(CAST(event_data AS REAL)) a, MIN(CAST(event_data AS REAL)) mn, MAX(CAST(event_data AS REAL)) mx, COUNT(*) c
           FROM user_events WHERE event_type='bot_latency' AND timestamp>?`
        ).bind(one).first<{ a?: number; mn?: number; mx?: number; c?: number }>(),
        this.db.prepare(
          `SELECT AVG(CAST(event_data AS REAL)) a, MIN(CAST(event_data AS REAL)) mn, MAX(CAST(event_data AS REAL)) mx, COUNT(*) c
           FROM user_events WHERE event_type='bot_latency' AND timestamp>?`
        ).bind(seven).first<{ a?: number; mn?: number; mx?: number; c?: number }>(),
      ]);

      return {
        avg24h: r24?.a ? Math.round((Number(r24.a) / 1000) * 10) / 10 : 0,
        min24h: r24?.mn ? Math.round((Number(r24.mn) / 1000) * 10) / 10 : 0,
        max24h: r24?.mx ? Math.round((Number(r24.mx) / 1000) * 10) / 10 : 0,
        count24h: Number(r24?.c || 0),
        avg7d: r7?.a ? Math.round((Number(r7.a) / 1000) * 10) / 10 : 0,
        min7d: r7?.mn ? Math.round((Number(r7.mn) / 1000) * 10) / 10 : 0,
        max7d: r7?.mx ? Math.round((Number(r7.mx) / 1000) * 10) / 10 : 0,
        count7d: Number(r7?.c || 0),
      };
    } catch {
      return { avg24h: 0, min24h: 0, max24h: 0, count24h: 0, avg7d: 0, min7d: 0, max7d: 0, count7d: 0 };
    }
  }

  async visitorCountries(): Promise<{
    top24h: Array<{ country: string; count: number; percent: number }>;
    top7d: Array<{ country: string; count: number; percent: number }>;
    total24h: number;
    total7d: number;
  }> {
    const one = since(86_400_000);
    const seven = since(7 * 86_400_000);

    try {
      const [res24, res7] = await Promise.all([
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
      ]);

      const list24 = (res24?.results || []).map(r => ({ country: String(r.country || "XX").toUpperCase(), count: Number(r.c || 0) }));
      const list7 = (res7?.results || []).map(r => ({ country: String(r.country || "XX").toUpperCase(), count: Number(r.c || 0) }));

      const total24h = list24.reduce((s, x) => s + x.count, 0);
      const total7d = list7.reduce((s, x) => s + x.count, 0);

      const top24h = list24.map(x => ({ ...x, percent: total24h > 0 ? Math.round((x.count / total24h) * 100) : 0 }));
      const top7d = list7.map(x => ({ ...x, percent: total7d > 0 ? Math.round((x.count / total7d) * 100) : 0 }));

      return { top24h, top7d, total24h, total7d };
    } catch {
      return { top24h: [], top7d: [], total24h: 0, total7d: 0 };
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
