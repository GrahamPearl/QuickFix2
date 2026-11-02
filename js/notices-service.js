/**
 * notices-service.js — school notices kept in ONE document, notices/current { items:[...] }.
 * Cost: 1 read per dashboard load, cached 5 minutes in sessionStorage; no live listener.
 * A post or delete is one transaction (1 read + 1 write).
 */
import { db, doc, getDoc, runTransaction } from "./firebase-init.js";

const REF = () => doc(db, "notices", "current");
const KEY = "hhs_notices_v1", TTL = 5 * 60 * 1000, MAX = 30;
const today = () => new Date().toISOString().slice(0, 10);

export async function loadNotices({ force = false } = {}) {
  if (!force) {
    try { const c = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (c && Date.now() - c.at < TTL) return c; } catch { /* ignore */ }
  }
  const snap = await getDoc(REF());
  const out = { items: snap.exists() ? snap.data().items || [] : [], at: Date.now() };
  try { sessionStorage.setItem(KEY, JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}

async function edit(fn) {
  await runTransaction(db, async (tx) => {
    const s = await tx.get(REF());
    const items = fn(s.exists() ? s.data().items || [] : []).slice(0, MAX);
    tx.set(REF(), { items, updatedAt: new Date().toISOString() });
  });
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

export const postNotice = (n, user) =>
  edit((items) => [
    { id: crypto.randomUUID(), ...n, postedBy: user.email, publishedAt: new Date().toISOString() },
    ...items.filter((i) => !i.expiresAt || i.expiresAt >= today()),
  ]);

export const removeNotice = (id) => edit((items) => items.filter((i) => i.id !== id));

const RANK = { urgent: 0, important: 1, info: 2 };
/** Hides expired notices and those aimed at other user types (relevance only, not security). */
export const visibleNotices = (items, type) =>
  items
    .filter((i) => (!i.expiresAt || i.expiresAt >= today()) && (!i.audience?.length || i.audience.includes(type)))
    .sort((a, b) => (RANK[a.level] ?? 2) - (RANK[b.level] ?? 2) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
