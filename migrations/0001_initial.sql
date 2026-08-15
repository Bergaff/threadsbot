CREATE TABLE IF NOT EXISTS banned_users (user_id INTEGER PRIMARY KEY, username TEXT, reason TEXT, banned_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username_requested TEXT NOT NULL, timestamp TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_request_log_user_time ON request_log(user_id, timestamp);
CREATE TABLE IF NOT EXISTS cache (username TEXT, mode TEXT, page INTEGER, data TEXT NOT NULL, cached_at TEXT NOT NULL, PRIMARY KEY(username,mode,page));
CREATE TABLE IF NOT EXISTS subscriptions (user_id INTEGER PRIMARY KEY, expires_at TEXT NOT NULL, payment_method TEXT, total_paid REAL DEFAULT 0, payments_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount TEXT, method TEXT, timestamp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT, message TEXT NOT NULL, ticket_type TEXT DEFAULT 'question', status TEXT DEFAULT 'open', created_at TEXT NOT NULL, answered_at TEXT, answer TEXT);
CREATE TABLE IF NOT EXISTS user_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_type TEXT NOT NULL, event_data TEXT, timestamp TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_user_type_time ON user_events(user_id,event_type,timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON user_events(event_type,timestamp);
CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, language TEXT DEFAULT 'ru', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_state (scope TEXT NOT NULL, state_key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,state_key));
CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads_accounts (
  name TEXT PRIMARY KEY, cookies TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  is_alive INTEGER NOT NULL DEFAULT 1, last_error TEXT, requests_count INTEGER NOT NULL DEFAULT 0,
  posts_sent INTEGER NOT NULL DEFAULT 0, errors_count INTEGER NOT NULL DEFAULT 0,
  hourly_requests INTEGER NOT NULL DEFAULT 0, hourly_reset TEXT NOT NULL, last_used TEXT, updated_at TEXT NOT NULL
);
