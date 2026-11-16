/**
 * subject-change-service.js — subject-changes/{auto}: a request to move a learner from one subject to another (or drop one).
 * pending -> approved (enrolment applied by the page) | declined. Requesters read only their own requests; reviewers read all.
 * Single-field equality queries only: no composite index.
 */
import { auth, db, collection, doc, addDoc, getDocs, updateDoc, query, where, limit, serverTimestamp } from "./firebase-init.js";
import { meter } from "./usage-meter.js";

const C = () => collection(db, "subject-changes");
const email = (u) => String(u?.email || "").toLowerCase();
const rows = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0));

export async function createRequest(fields, user = auth.currentUser) {
  const ref = await addDoc(C(), { ...fields, status: "pending", requestedBy: user.uid, requestedByEmail: email(user), requestedAt: serverTimestamp() });
  meter.write("subject-changes", 1);
  return ref.id;
}

export async function listMine(user = auth.currentUser) {
  const snap = await getDocs(query(C(), where("requestedBy", "==", user.uid), limit(50)));
  meter.read("subject-changes-mine", snap.size);
  return rows(snap);
}

export async function listByStatus(status, max = 200) {
  const snap = await getDocs(query(C(), where("status", "==", status), limit(max)));
  meter.read("subject-changes-review", snap.size);
  return rows(snap);
}

/** status: approved | declined. extra: { declineReason } or { newTeacher, newLine, appliedAt }. */
export function decide(id, status, extra = {}, user = auth.currentUser) {
  meter.write("subject-changes", 1);
  return updateDoc(doc(db, "subject-changes", id), {
    status, ...extra, decidedBy: user.uid, decidedByEmail: email(user), decidedAt: serverTimestamp(),
  });
}