/**
 * pastoral-service.js — pastoral-entries/{auto}: referrals, medical/allergy alerts, at-risk flags.
 * Rules: staff may create and read only their own entries from the last 24 h; staff-gc/head/admin read and review all.
 * Index needed (console link on first use): pastoral-entries recordedBy ASC + recordedAt DESC.
 */
import { auth, db, collection, doc, addDoc, getDocs, updateDoc, query, where, orderBy, limit, serverTimestamp } from "./firebase-init.js";
import { meter } from "./usage-meter.js";

const C = () => collection(db, "pastoral-entries");
const email = (u) => String(u?.email || "").toLowerCase();
const rows = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));

export async function addEntry(fields, user = auth.currentUser) {
  const ref = await addDoc(C(), { ...fields, recordedBy: user.uid, recordedByEmail: email(user), recordedAt: serverTimestamp() });
  meter.write("pastoral", 1);
  return ref.id;
}

export async function listMine(user = auth.currentUser) {
  const cutoff = new Date(Date.now() - 23 * 3600000);
  const snap = await getDocs(query(C(), where("recordedBy", "==", user.uid), where("recordedAt", ">", cutoff), orderBy("recordedAt", "desc"), limit(50)));
  meter.read("pastoral-mine", snap.size);
  return rows(snap);
}

/** Reviewers. group "active" = open + in-progress, or "closed". Single-field query: no composite index. */
export async function listReview(group, max = 300) {
  const f = group === "closed" ? where("status", "==", "closed") : where("status", "in", ["open", "in-progress"]);
  const snap = await getDocs(query(C(), f, limit(max)));
  meter.read("pastoral-review", snap.size);
  return rows(snap).sort((a, b) => (b.recordedAt?.seconds || 0) - (a.recordedAt?.seconds || 0));
}

export function updateEntry(id, patch, user = auth.currentUser) {
  meter.write("pastoral", 1);
  return updateDoc(doc(db, "pastoral-entries", id), { ...patch, updatedBy: user.uid, updatedByEmail: email(user), updatedAt: serverTimestamp() });
}