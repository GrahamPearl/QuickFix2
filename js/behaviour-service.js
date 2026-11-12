/**
 * behaviour-service.js — Firestore access for behaviour-entries and detentions.
 * Rules decide who may read: staff/slt only their own entries from the last 24 h;
 * staff-gc everything except severity "serious"; staff-head/admin everything.
 * Queries must carry the same constraints as the rules, or Firestore rejects them.
 * Needed composite indexes (the console error gives a one-click link):
 *   behaviour-entries: recordedBy ASC + recordedAt DESC;  severity ASC + occurredOn DESC
 */
import { auth, db, collection, doc, addDoc, getDocs, updateDoc, query, where, orderBy, limit, serverTimestamp } from "./firebase-init.js";
import { meter } from "./usage-meter.js";

const E = () => collection(db, "behaviour-entries");
const D = () => collection(db, "detentions");
const email = (u) => String(u?.email || "").toLowerCase();
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

export async function addEntry(fields, user = auth.currentUser) {
  const ref = await addDoc(E(), {
    ...fields, recordedBy: user.uid, recordedByEmail: email(user), recordedAt: serverTimestamp(),
  });
  meter.write("behaviour", 1);
  return ref.id;
}

/** Own entries from the last 24 h (23 h window leaves a margin for clock differences). */
export async function listMine(user = auth.currentUser) {
  const cutoff = new Date(Date.now() - 23 * 3600000);
  const snap = await getDocs(query(E(), where("recordedBy", "==", user.uid),
    where("recordedAt", ">", cutoff), orderBy("recordedAt", "desc"), limit(50)));
  meter.read("behaviour-mine", snap.size);
  return rows(snap);
}

/** Managers. canSeeSerious=false (staff-gc) adds the severity filter the rules require. */
export async function listLedger({ from, to, canSeeSerious, max = 300 }) {
  const c = [where("occurredOn", ">=", from), where("occurredOn", "<=", to), orderBy("occurredOn", "desc"), limit(max)];
  if (!canSeeSerious) c.unshift(where("severity", "in", ["minor", "moderate"]));
  const snap = await getDocs(query(E(), ...c));
  meter.read("behaviour-ledger", snap.size);
  return rows(snap);
}

export function voidEntry(id, reason, user = auth.currentUser) {
  if (!reason.trim()) throw new Error("A reason is required.");
  meter.write("behaviour", 1);
  return updateDoc(doc(db, "behaviour-entries", id), {
    status: "voided", voidedBy: user.uid, voidedByEmail: email(user), voidedAt: serverTimestamp(), voidedReason: reason.trim(),
  });
}

export async function addDetentions(list, user = auth.currentUser) {
  await Promise.all(list.map((x) => addDoc(D(), {
    ...x, status: "scheduled", createdBy: user.uid, createdByEmail: email(user), createdAt: serverTimestamp(),
  })));
  meter.write("behaviour", list.length);
}

export async function listDetentions(from) {
  const snap = await getDocs(query(D(), where("date", ">=", from), orderBy("date", "asc"), limit(300)));
  meter.read("behaviour-detentions", snap.size);
  return rows(snap);
}

export function setDetention(id, patch, user = auth.currentUser) {
  meter.write("behaviour", 1);
  return updateDoc(doc(db, "detentions", id), { ...patch, updatedBy: user.uid, updatedByEmail: email(user), updatedAt: serverTimestamp() });
}