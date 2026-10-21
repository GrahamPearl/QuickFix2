/**
 * usertypes.js
 * Single place that knows about user types. Reads usertypes.json and
 * resolves a signed-in user's type from the authorized_users collection.
 * UI only: real enforcement must live in Firestore Security Rules.
 */
import { db, doc, getDoc } from "./firebase-init.js";

let cache = null;

export async function loadUserTypes() {
  if (cache) return cache;
  const res = await fetch("usertypes.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load usertypes.json (${res.status})`);
  cache = await res.json();
  return cache;
}

export const typeKeys = (cfg) => Object.keys(cfg.types);
export const getTypeDef = (cfg, type) => (cfg && type ? cfg.types[type] || null : null);
export const can = (cfg, type, permission) => Boolean(getTypeDef(cfg, type)?.permissions?.[permission]);

/** Looks up authorized_users/<uid>, then authorized_users/<lowercase email>. Returns a valid type key or null. */
export async function resolveUserType(user, cfg) {
  const ids = [user.uid, (user.email || "").toLowerCase()].filter(Boolean);
  for (const id of ids) {
    try {
      const snap = await getDoc(doc(db, cfg.collection, id));
      if (snap.exists()) {
        const t = String(snap.data().type || "").toLowerCase();
        if (cfg.types[t]) return t;
      }
    } catch (err) {
      console.warn("authorized_users lookup failed for", id, err.code);
    }
  }
  return null;
}
