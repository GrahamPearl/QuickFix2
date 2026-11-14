/**
 * sports-service.js — Firestore access for sports results.
 *
 *  sports-results/{id}     one document per match: scheduled -> live -> final (the source of truth)
 *  sports-live/{id}        tiny doc per match in play (same id as the match). Score taps write ONLY here;
 *                          it is deleted when the match is finalised. Viewers listen to this collection.
 *  sports-summary/{season} one digest per season: { season, updatedAt, items: { "<id>": "<JSON slim result>" } }
 *                          Written in the same transaction/batch as every final result, so it cannot drift.
 *  sports-config/lists     { opponents: [] } shared opponent names (consistent spelling)
 *
 * Cost model
 *  - Reviewing a season (list, filters, team records, weekly feed, Excel) = 1 read, cached in localStorage
 *    (10 min for the current season, 24 h for past seasons). Everything is computed client-side.
 *  - Items are JSON STRINGS (like snapshot-service.js) so Firestore does not index every nested field.
 *  - Upcoming fixtures = one query on (status IN scheduled/live, dayKey >=) and only returns unfinished matches.
 *  - A live score tap = 1 write (increment, so two scorers never overwrite each other). A viewer pays one read
 *    per changed live document.
 *  - Finalising = 1 read + 4 writes (match, delete live, season digest, audit).
 */
import {
  auth, db, collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, runTransaction,
  serverTimestamp, onSnapshot, query, where, orderBy, limit, increment, deleteField, arrayUnion,
} from "./firebase-init.js";
import { buildAudit } from "./audit-service.js";
import { meter } from "./usage-meter.js";
import { slim, seasonOf, daysAgoIso } from "./sports-form.js";

const {
  SPORTS_RESULTS_COLLECTION = "sports-results",
  SPORTS_LIVE_COLLECTION = "sports-live",
  SPORTS_SUMMARY_COLLECTION = "sports-summary",
  SPORTS_CONFIG_COLLECTION = "sports-config",
  AUDIT_COLLECTION = "audit-log",
} = window.APP_CONFIG;

const resCol = () => collection(db, SPORTS_RESULTS_COLLECTION);
const resRef = (id) => doc(db, SPORTS_RESULTS_COLLECTION, id);
const liveRef = (id) => doc(db, SPORTS_LIVE_COLLECTION, id);
const sumRef = (season) => doc(db, SPORTS_SUMMARY_COLLECTION, String(season));
const cfgRef = () => doc(db, SPORTS_CONFIG_COLLECTION, "lists");

const email = (u) => String(u?.email || "").toLowerCase();
const uid = () => auth.currentUser?.uid || null;
const stale = (message) => Object.assign(new Error(message), { stale: true });
const stamp = (u) => ({ updatedBy: u.uid, updatedByEmail: email(u), updatedAt: serverTimestamp() });

/* ---------------- season digest cache ---------------- */
const cacheKey = (s) => `hhs_sports_${s}_v1`;
const TTL_CURRENT = 10 * 60 * 1000;
const TTL_PAST = 24 * 60 * 60 * 1000;

function readCache(season, { ignoreAge = false } = {}) {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(season)) || "null");
    if (!c || c.uid !== uid()) return null;
    const ttl = Number(season) < new Date().getFullYear() ? TTL_PAST : TTL_CURRENT;
    return ignoreAge || Date.now() - c.at < ttl ? c : null;
  } catch {
    return null;
  }
}
function writeCache(season, items, at = Date.now()) {
  try {
    localStorage.setItem(cacheKey(season), JSON.stringify({ uid: uid(), at, items }));
  } catch {
    meter.error("localstorage-full");
  }
}
/** Patches the cached digest after a local write. Does not extend the cache age. */
function patchCache(season, id, rec) {
  const c = readCache(season, { ignoreAge: true });
  if (!c) return;
  const items = c.items.filter((x) => x.id !== id);
  if (rec) items.push({ id, ...rec });
  writeCache(season, items, c.at);
}

/** @returns {Promise<{items:Array, at:number}>} items = [{ id, ...slim result }] */
export async function loadSeason(season, { force = false } = {}) {
  if (!force) {
    const c = readCache(season);
    if (c) {
      meter.cache(true);
      return c;
    }
  }
  meter.cache(false);
  const snap = await getDoc(sumRef(season));
  meter.read("sports-season", 1);
  const raw = snap.exists() ? snap.data().items || {} : {};
  const items = Object.entries(raw)
    .map(([id, json]) => {
      try {
        return { id, ...JSON.parse(json) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const out = { items, at: Date.now() };
  writeCache(season, items, out.at);
  return out;
}

/* ---------------- writer helpers (work with a batch or a transaction) ---------------- */
const sumPut = (w, season, id, rec) =>
  w.set(sumRef(season), { season: Number(season), updatedAt: serverTimestamp(), items: { [id]: JSON.stringify(slim(rec)) } }, { merge: true });
const sumDel = (w, season, id) =>
  w.set(sumRef(season), { season: Number(season), updatedAt: serverTimestamp(), items: { [id]: deleteField() } }, { merge: true });
const audit = (w, action, rec, note = "") =>
  w.set(
    doc(collection(db, AUDIT_COLLECTION)),
    buildAudit({
      ops: [],
      action,
      source: "sports-page",
      note: `${rec.teamName}${rec.ageGroup ? ` ${rec.ageGroup}` : ""} v ${rec.opponent}${note ? ` · ${note}` : ""}`.slice(0, 300),
      extra: { count: 1 },
    }),
  );

/* ---------------- fixtures ---------------- */
/** @returns {Promise<Object>} the new match, with its id */
export async function createFixture(fields, user = auth.currentUser) {
  const ref = doc(resCol());
  await setDoc(ref, {
    ...fields,
    createdBy: user.uid,
    createdByEmail: email(user),
    createdAt: serverTimestamp(),
    ...stamp(user),
  });
  meter.write("sports", 1);
  clearUpcoming();
  return { id: ref.id, ...fields };
}

let upCache = null;
export const clearUpcoming = () => {
  upCache = null;
};

/**
 * Unfinished matches from 14 days ago onwards. Needs the composite index
 * sports-results: status ASC + dayKey ASC (the console error gives a one-click link).
 */
export async function listUpcoming({ force = false } = {}) {
  if (!force && upCache && Date.now() - upCache.at < 5 * 60 * 1000) return upCache.rows;
  const snap = await getDocs(
    query(resCol(), where("status", "in", ["scheduled", "live"]), where("dayKey", ">=", daysAgoIso(14)), orderBy("dayKey", "asc"), limit(100)),
  );
  meter.read("sports-upcoming", snap.size);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  upCache = { at: Date.now(), rows };
  return rows;
}

/** Removes a fixture (any capturer, scheduled only) or a final result (managers). */
export function deleteMatch(rec, user = auth.currentUser) {
  const b = writeBatch(db);
  b.delete(resRef(rec.id));
  b.delete(liveRef(rec.id));
  if (rec.status === "final") sumDel(b, rec.season ?? seasonOf(rec.dayKey), rec.id);
  audit(b, rec.status === "final" ? "sports.delete" : "sports.cancel", rec);
  return b.commit().then(() => {
    meter.write("sports", 3);
    clearUpcoming();
    if (rec.status === "final") patchCache(rec.season ?? seasonOf(rec.dayKey), rec.id, null);
  });
}

/* ---------------- live ---------------- */
export function goLive(rec, user = auth.currentUser) {
  const b = writeBatch(db);
  b.update(resRef(rec.id), { status: "live", liveStartedAt: serverTimestamp(), ...stamp(user) });
  b.set(liveRef(rec.id), {
    matchId: rec.id,
    teamName: rec.teamName,
    ageGroup: rec.ageGroup || "",
    opponent: rec.opponent,
    home: Boolean(rec.home),
    venue: rec.venue || "",
    dayKey: rec.dayKey,
    ourScore: 0,
    theirScore: 0,
    period: "",
    startedBy: email(user),
    updatedAt: serverTimestamp(),
  });
  return b.commit().then(() => {
    meter.write("sports", 2);
    clearUpcoming();
  });
}

/** side = "us" | "them". increment() so two scorers tapping at once both count. */
export function adjustLive(id, side, delta, user = auth.currentUser) {
  meter.write("sports-live", 1);
  return updateDoc(liveRef(id), {
    [side === "us" ? "ourScore" : "theirScore"]: increment(delta),
    updatedAt: serverTimestamp(),
    updatedBy: email(user),
  });
}

export function setPeriod(id, text, user = auth.currentUser) {
  meter.write("sports-live", 1);
  return updateDoc(liveRef(id), { period: String(text || "").slice(0, 40), updatedAt: serverTimestamp(), updatedBy: email(user) });
}

/** One listener on a tiny collection (usually 0 to 5 documents). Call the returned function to stop. */
export function watchLive(onRows, onError) {
  return onSnapshot(
    collection(db, SPORTS_LIVE_COLLECTION),
    (s) => {
      if (!s.metadata.fromCache) meter.read("sports-live", Math.max(1, s.docChanges().length));
      onRows(s.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    onError,
  );
}

/* ---------------- results ---------------- */
/** Scheduled or live -> final. One transaction: match, live doc, season digest and audit entry. */
export function finalizeMatch(id, fields, user = auth.currentUser) {
  const ref = resRef(id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw stale("This fixture no longer exists.");
    const cur = snap.data();
    if (cur.status === "final") throw stale("This match has already been finalised.");
    tx.update(ref, {
      ...fields,
      status: "final",
      finalizedBy: user.uid,
      finalizedByEmail: email(user),
      finalizedAt: serverTimestamp(),
      ...stamp(user),
    });
    tx.delete(liveRef(id));
    const full = { ...cur, ...fields, status: "final" };
    sumPut(tx, cur.season ?? seasonOf(cur.dayKey), id, full);
    audit(tx, "sports.final", full, `${fields.ourScore}-${fields.theirScore}`);
    return full;
  }).then((full) => {
    meter.read("sports-tx", 1);
    meter.write("sports", 4);
    clearUpcoming();
    const season = full.season ?? seasonOf(full.dayKey);
    patchCache(season, id, slim(full));
    return { id, ...full, season };
  });
}

/** Managers only (Rules). Corrects scores, breakdown, notes or top players of a final result. */
export function editFinal(id, fields, user = auth.currentUser) {
  const ref = resRef(id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw stale("This result no longer exists.");
    const cur = snap.data();
    if (cur.status !== "final") throw stale("This match is not finalised yet.");
    tx.update(ref, { ...fields, ...stamp(user) });
    const full = { ...cur, ...fields };
    sumPut(tx, cur.season ?? seasonOf(cur.dayKey), id, full);
    audit(tx, "sports.edit", full, `${cur.ourScore}-${cur.theirScore} → ${fields.ourScore}-${fields.theirScore}`);
    return full;
  }).then((full) => {
    meter.read("sports-tx", 1);
    meter.write("sports", 3);
    const season = full.season ?? seasonOf(full.dayKey);
    patchCache(season, id, slim(full));
    return { id, ...full, season };
  });
}

/* ---------------- opponents ---------------- */
let oppCache = null;
export async function loadOpponents() {
  if (oppCache) return oppCache;
  const s = await getDoc(cfgRef());
  meter.read("sports-config", 1);
  oppCache = (s.exists() ? s.data().opponents || [] : []).slice().sort((a, b) => a.localeCompare(b));
  return oppCache;
}

export async function rememberOpponent(name) {
  if (!name || oppCache?.includes(name)) return oppCache;
  await setDoc(cfgRef(), { opponents: arrayUnion(name) }, { merge: true });
  meter.write("sports", 1);
  oppCache = [...(oppCache || []), name].sort((a, b) => a.localeCompare(b));
  return oppCache;
}