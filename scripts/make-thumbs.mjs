// npm i sharp   then:  node scripts/make-thumbs.mjs
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const src = "photos", out = "photos/thumb";
fs.mkdirSync(out, { recursive: true });

for (const f of fs.readdirSync(src).filter((f) => /\.(webp|jpe?g|png)$/i.test(f))) {
  const from = path.join(src, f);
  const to = path.join(out, f.replace(/\.\w+$/, ".webp"));
  if (fs.existsSync(to) && fs.statSync(to).mtimeMs >= fs.statSync(from).mtimeMs) continue; // skip unchanged
  await sharp(from).resize(180, 240, { fit: "cover", position: "top" }).webp({ quality: 70 }).toFile(to);
}
console.log("done");