import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { spawnSync } from "node:child_process";
import { diagnoseAccountCookies, normalizeCookiesJson } from "../src/cookies";

const dir = process.argv[2] || "accounts";
const remote = process.argv.includes("--remote");
const quote = (v: string) => `'${v.replaceAll("'", "''")}'`;
const files = (await readdir(dir)).filter(x => x.endsWith(".json"));
if (!files.length) throw new Error(`No account cookie files in ${dir}`);
const now = new Date().toISOString();
let sql = "";
let imported = 0;
for (const file of files) {
  const raw = await readFile(join(dir, file), "utf8");
  const name = parse(file).name;
  const normalized = normalizeCookiesJson(raw);
  if (!normalized.ok) {
    console.error(`❌ ${file}: ${normalized.error}`);
    continue;
  }
  const diagnosis = diagnoseAccountCookies(name, true, normalized.json);
  if (diagnosis.issues.length) console.warn(`⚠️ ${name}: ${diagnosis.issues.join("; ")}`);
  else console.log(`✅ ${name}: ${diagnosis.cookieCount} cookies`);
  sql += `INSERT INTO threads_accounts(name,cookies,enabled,is_alive,hourly_reset,updated_at) VALUES(${quote(name)},${quote(normalized.json)},1,1,${quote(now)},${quote(now)}) ON CONFLICT(name) DO UPDATE SET cookies=excluded.cookies,enabled=1,is_alive=1,last_error=NULL,updated_at=excluded.updated_at;\n`;
  imported++;
}
if (!imported) throw new Error("No valid JSON accounts to import");
const temp = ".accounts-import.sql";
await writeFile(temp, sql, { mode: 0o600 });
try {
  const args = ["wrangler", "d1", "execute", "threadsbot", remote ? "--remote" : "--local", "--file", temp];
  const result = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
} finally {
  await rm(temp, { force: true });
}
console.log(`Imported ${imported} Threads account(s).`);
