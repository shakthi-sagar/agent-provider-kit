// Copies the relative-import closure of T3 Code server files, keeping their paths.
// usage: node scripts/copy-closure.mjs <t3 apps/server/src> <dest src> <stop,list> <entry...>
// Files in the stop list are agent-provider-kit shims: never copied or followed, so re-runs keep them.
import fs from "node:fs";
import path from "node:path";

const [root, dest, stopCsv, ...entries] = process.argv.slice(2);
const stop = new Set(stopCsv.split(",").filter(Boolean));
const seen = new Set();
const shims = new Set();
const stack = entries.map((e) => path.resolve(root, e));
const re = /(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
while (stack.length) {
  const f = stack.pop();
  const rf = path.relative(root, f);
  if (stop.has(rf)) { shims.add(rf); continue; }
  if (seen.has(f) || !fs.existsSync(f)) continue;
  seen.add(f);
  const out = path.join(dest, rf);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(f, out);
  if (!f.endsWith(".ts")) continue;
  for (const m of fs.readFileSync(f, "utf8").matchAll(re)) {
    const s = m[1] ?? m[2];
    if (/\.(ts|json)$/.test(s)) stack.push(path.resolve(path.dirname(f), s));
  }
}
console.log(`copied ${seen.size} files`);
if (shims.size) console.log("shimmed (not copied):\n  " + [...shims].sort().join("\n  "));
