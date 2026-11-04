import fs from "node:fs";
import path from "node:path";

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name.startsWith(".") ? [] :
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

for (const f of walk(".").filter((f) => f.endsWith(".js"))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+["'](\.[^"']+)["']/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) console.log(`${f}: missing ${m[1]}`);
  }
}