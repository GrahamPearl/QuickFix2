/**
 * settings-service.js — shared app settings in Firestore: setting/roster
 *   { forceRefreshAt (server time), urgent, minIntervalHours, maxAgeHours, reason, updatedBy, updatedAt }
 * Reading it costs 1 read. Only users with "refreshRoster" should write it (enforce in Rules).
 */
import {
  db, doc, getDoc, collection, getCountFromServer, runTransaction, serverTimestamp,
} from "./firebase-init.js";

const COL = window.APP_CONFIG.SETTINGS_COLLECTION || "setting";
const STUDENTS = window.APP_CONFIG.STUDENTS_COLLECTION || "students";
const ref = () => doc(db, COL, "roster");
export const ROSTER_DEFAULTS = { forceRefreshAt: 0, urgent: false, minIntervalHours: 6, maxAgeHours: 24, indexChunks: 0 };
export const DAILY_READ_QUOTA = 50000;       // Firebase Spark limit
const MIN_GAP_HOURS = { normal: 1, urgent: 24 };

const SNAPSHOT = window.APP_CONFIG.SNAPSHOT_COLLECTION || "rosterSnapshot";

export async function estimateRefreshCost(usersCollection = "authorized_users") {
  const count = async (name) => (await getCountFromServer(collection(db, name))).data().count;
  const [students, users, metaSnap] = await Promise.all([
    count(STUDENTS), count(usersCollection), getDoc(doc(db, SNAPSHOT, "_meta")),
  ]);
  const m = metaSnap.exists() ? metaSnap.data() : null;
  const perLoad = m?.ready ? (m.chunks || 0) + 2 : students;   // snapshot: chunks + _meta + setting
  return { students, users, perLoad, snapshot: Boolean(m?.ready), reads: perLoad * users };
}

export async function getRosterSettings() {
  const snap = await getDoc(ref());
  const d = snap.exists() ? snap.data() : {};
  const t = d.forceRefreshAt;
  return { ...ROSTER_DEFAULTS, ...d, forceRefreshAt: t?.toMillis ? t.toMillis() : Number(t) || 0 };
}

/** Asks every user's browser to reload the roster. urgent=true ignores the minimum-interval guard. */
export async function requestRosterRefresh({ user, urgent = false, reason = "" }) {
  const r = ref();
  await runTransaction(db, async (tx) => {
    const d = (await tx.get(r)).data() || {};
    const hoursSince = (t) => (t?.toMillis ? (Date.now() - t.toMillis()) / 3600000 : Infinity);

    if (urgent && hoursSince(d.lastUrgentAt) < MIN_GAP_HOURS.urgent) {
      throw new Error(`An urgent refresh was already requested ${Math.floor(hoursSince(d.lastUrgentAt))} h ago. Only one is allowed per 24 hours.`);
    }
    if (hoursSince(d.forceRefreshAt) < MIN_GAP_HOURS.normal) {
      throw new Error("A refresh was requested less than an hour ago. Please wait.");
    }
    tx.set(r, {
      forceRefreshAt: serverTimestamp(), urgent, reason,
      ...(urgent ? { lastUrgentAt: serverTimestamp() } : {}),
      updatedBy: user?.email || "", updatedAt: serverTimestamp(),
    }, { merge: true });
  });
}
