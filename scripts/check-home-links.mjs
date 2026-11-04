import fs from "node:fs";
import path from "node:path";

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name.startsWith(".") ? [] :
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

let bad = 0;
for (const f of walk(".").filter((f) => f.endsWith(".html") && path.basename(f) !== "index.html")) {
  const src = fs.readFileSync(f, "utf8");
  const ok = /href=["'](\.\.\/)?index\.html(\?[^"']*)?["']/.test(src) || /home-link\.js/.test(src);
  if (!ok) { console.log(`${f}: no link back to index.html`); bad++; }
}
process.exit(bad ? 1 : 0);