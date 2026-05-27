import { spawnSync } from "child_process";
const r = spawnSync("npx", ["eslint", ".", "--ext", ".ts,.tsx", "--format", "json"], { cwd: process.cwd(), shell: true, maxBuffer: 50 * 1024 * 1024 });
const data = JSON.parse(r.stdout.toString());
const byRule = {};
const byFile = {};
for (const f of data) {
  if (!f.messages.length) continue;
  const rel = f.filePath.replace(process.cwd() + "\\", "").replace(/\\/g, "/");
  byFile[rel] = f.messages.length;
  for (const m of f.messages) byRule[m.ruleId] = (byRule[m.ruleId] || 0) + 1;
}
console.log("=== Rule별 ===");
Object.entries(byRule).sort((a,b) => b[1]-a[1]).forEach(([r,c]) => console.log(`${c.toString().padStart(3)} ${r}`));
console.log("\n=== File별 ===");
Object.entries(byFile).sort((a,b) => b[1]-a[1]).forEach(([f,c]) => console.log(`${c.toString().padStart(3)} ${f}`));
