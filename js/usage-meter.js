/**
 * usage-meter.js — client-side counters flushed to usage-daily/{day}_{uid} and usage-summary/{day}.
 * Flush: when the tab is hidden, on pagehide, and every 30 min if >= 25 events are pending.
 * Cost: about 2 writes per flush (~6 flushes per user per day ≈ 600 writes/day for 50 users).
 * The flush's own writes are not counted.
 */
import { auth, db, doc, setDoc, increment } from "./firebase-init.js";

const { USAGE_COLLECTION = "usage-daily", USAGE_SUMMARY_COLLECTION = "usage-summary" } = window.APP_CONFIG;
const bag = () => ({ reads: {}, writes: {}, cache: {}, errors: {}, timing: {} });
let pend = bag(), dirty = 0;
const bump = (group, key, n) => { pend[group][key] = (pend[group][key] || 0) + n; dirty += n; };

export const meter = {
  read: (src, n = 1) => { if (n > 0) bump("reads", src, n); },
  write: (src, n = 1) => { if (n > 0) bump("writes", src, n); },
  cache: (hit) => bump("cache", hit ? "hit" : "miss", 1),
  error: (code) => bump("errors", String(code || "unknown").replace(/[^\w-]/g, "_"), 1),
  time(name, ms) { bump("timing", `${name}_ms`, Math.round(ms)); bump("timing", `${name}_n`, 1); },
};

const dayKey = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const inc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "object" ? inc(v) : increment(v)]));

export async function flushMeter() {
  const user = auth.currentUser;
  if (!user || !dirty) return;
  const out = pend; pend = bag(); dirty = 0;
  const day = dayKey(), body = inc(out);
  try {
    await Promise.all([
      setDoc(doc(db, USAGE_COLLECTION, `${day}_${user.uid}`), { day, uid: user.uid, email: user.email, ...body }, { merge: true }),
      setDoc(doc(db, USAGE_SUMMARY_COLLECTION, day), { day, ...body }, { merge: true }),
    ]);
  } catch (e) { console.warn("usage flush failed", e.code || e.message); } // metrics only: drop the counts
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushMeter(); });
window.addEventListener("pagehide", flushMeter);
setInterval(() => { if (dirty >= 25) flushMeter(); }, 30 * 60 * 1000);