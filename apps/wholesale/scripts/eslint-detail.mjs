import { spawnSync } from "child_process";
const r = spawnSync("npx", ["eslint", ".", "--ext", ".ts,.tsx", "--format", "json"], { cwd: process.cwd(), shell: true, maxBuffer: 50 * 1024 * 1024 });
const data = JSON.parse(r.stdout.toString());

const wantRule = process.argv[2];
for (const f of data) {
  if (!f.messages.length) continue;
  const rel = f.filePath.replace(process.cwd() + "\\", "").replace(/\\/g, "/");
  for (const m of f.messages) {
    if (wantRule && m.ruleId !== wantRule) continue;
    console.log(`${rel}:${m.line}:${m.column} [${m.ruleId}] ${m.message.split("\n")[0]}`);
  }
}
