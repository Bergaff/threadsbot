#!/usr/bin/env python3
"""Import the Python bot's SQLite data and account cookies into Cloudflare D1."""
import argparse, json, sqlite3, subprocess
from pathlib import Path

TABLES = ["banned_users", "request_log", "cache", "subscriptions", "payments_log", "support_tickets", "user_events", "user_settings"]

def quote(value):
    if value is None: return "NULL"
    if isinstance(value, (int, float)): return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db", default="data/bot.db")
    p.add_argument("--accounts", default="accounts")
    p.add_argument("--local", action="store_true")
    args=p.parse_args()
    conn=sqlite3.connect(args.db); conn.row_factory=sqlite3.Row
    lines=["BEGIN;"]
    existing={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in TABLES:
        if table not in existing: continue
        for row in conn.execute(f'SELECT * FROM "{table}"'):
            columns=",".join(f'"{k}"' for k in row.keys())
            values=",".join(quote(row[k]) for k in row.keys())
            lines.append(f'INSERT OR REPLACE INTO "{table}"({columns}) VALUES({values});')
    now=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    account_dir=Path(args.accounts)
    if account_dir.exists():
        for file in sorted(account_dir.glob("*.json")):
            raw=file.read_text("utf-8"); json.loads(raw)
            lines.append("INSERT INTO threads_accounts(name,cookies,enabled,is_alive,hourly_reset,updated_at) "
                         f"VALUES({quote(file.stem)},{quote(raw)},1,1,{quote(now)},{quote(now)}) "
                         "ON CONFLICT(name) DO UPDATE SET cookies=excluded.cookies,enabled=1,is_alive=1,updated_at=excluded.updated_at;")
    lines.append("COMMIT;")
    temp=Path(".legacy-import.sql")
    try:
        temp.write_text("\n".join(lines),"utf-8")
        command=["npx","wrangler","d1","execute","threadsbot","--local" if args.local else "--remote","--file",str(temp)]
        subprocess.run(command,check=True)
    finally: temp.unlink(missing_ok=True)

if __name__ == "__main__": main()
