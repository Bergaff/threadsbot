import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { spawnSync } from "node:child_process";

const dir=process.argv[2]||"accounts";
const remote=process.argv.includes("--remote");
const quote=(v:string)=>`'${v.replaceAll("'","''")}'`;
const files=(await readdir(dir)).filter(x=>x.endsWith(".json"));
if(!files.length)throw new Error(`No account cookie files in ${dir}`);
const now=new Date().toISOString();
let sql="BEGIN;\n";
for(const file of files){const raw=await readFile(join(dir,file),"utf8");JSON.parse(raw);const name=parse(file).name;sql+=`INSERT INTO threads_accounts(name,cookies,enabled,is_alive,hourly_reset,updated_at) VALUES(${quote(name)},${quote(raw)},1,1,${quote(now)},${quote(now)}) ON CONFLICT(name) DO UPDATE SET cookies=excluded.cookies,enabled=1,is_alive=1,last_error=NULL,updated_at=excluded.updated_at;\n`}
sql+="COMMIT;\n";
const temp=".accounts-import.sql";await writeFile(temp,sql,{mode:0o600});
try{const args=["wrangler","d1","execute","threadsbot",remote?"--remote":"--local","--file",temp];const result=spawnSync("npx",args,{stdio:"inherit",shell:process.platform==="win32"});if(result.status!==0)process.exit(result.status||1)}finally{await rm(temp,{force:true})}
console.log(`Imported ${files.length} Threads account(s).`);
