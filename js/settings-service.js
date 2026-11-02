/**
 * settings-service.js — shared app settings in Firestore: setting/roster
 *   { forceRefreshAt (server time), urgent, minIntervalHours, maxAgeHours, reason, updatedBy, updatedAt }
 * Reading it costs 1 read. Only users with "refreshRoster" should write it (enforce in Rules).
 */
import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";

const COL = window.APP_CONFIG.SETTINGS_COLLECTION || "setting";
const ref = () => doc(db, COL, "roster");

export const ROSTER_DEFAULTS = { forceRefreshAt: 0, urgent: false, minIntervalHours: 6, maxAgeHours: 24 };

export async function getRosterSettings() {
  const snap = await getDoc(ref());
  const d = snap.exists() ? snap.data() : {};
  const t = d.forceRefreshAt;
  return { ...ROSTER_DEFAULTS, ...d, forceRefreshAt: t?.toMillis ? t.toMillis() : Number(t) || 0 };
}

/** Asks every user's browser to reload the roster. urgent=true ignores the minimum-interval guard. */
export function requestRosterRefresh({ user, urgent = false, reason = "" }) {
  return setDoc(ref(), {
    forceRefreshAt: serverTimestamp(), urgent, reason,
    updatedBy: user?.email || "", updatedAt: serverTimestamp(),
  }, { merge: true });
}
