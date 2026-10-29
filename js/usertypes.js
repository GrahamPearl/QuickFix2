/**
 * usertypes.js
 * Single place that knows about user types. Reads usertypes.json and
 * resolves a signed-in user's type from the authorized_users collection.
 * UI only: real enforcement must live in Firestore Security Rules.
 */
import { db, doc, getDoc } from "./firebase-init.js";

const TYPE_KEY = "hhs_usertype_v1";
const TYPE_TTL = 10 * 60 * 1000;
let cfgPromise;

export function loadUserTypes() {
  return (cfgPromise ??= fetch(new URL("../json/usertypes.json", import.meta.url))
    .then((r) => { if (!r.ok) throw new Error(`usertypes.json ${r.status}`); return r.json(); }));
}
loadUserTypes().catch(() => {}); // overlaps with Firebase auth start-up

export async function resolveUserType(user, cfg) {
  try {
    const c = JSON.parse(sessionStorage.getItem(TYPE_KEY) || "null");
    if (c && c.uid === user.uid && Date.now() - c.at < TYPE_TTL && cfg.types[c.type]) return c.type;
  } catch {}

  const ids = [user.uid, (user.email || "").toLowerCase()].filter(Boolean);
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, cfg.collection, id)).catch(() => null)));
  for (const snap of snaps) {
    if (!snap?.exists()) continue;
    const t = String(snap.data().type || "").toLowerCase();
    const key = Object.keys(cfg.types).find((k) => k.toLowerCase() === t);
    if (key) {
      sessionStorage.setItem(TYPE_KEY, JSON.stringify({ uid: user.uid, type: key, at: Date.now() }));
      return key;
    }
  }
  return null;
}

//let cache = null;

export const typeKeys = (cfg) => Object.keys(cfg.types);
export const getTypeDef = (cfg, type) =>
  cfg && type ? cfg.types[type] || null : null;
export const can = (cfg, type, permission) =>
  Boolean(getTypeDef(cfg, type)?.permissions?.[permission]);
