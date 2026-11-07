/**
 * awards-service.js
 * Firestore access for the awards workflow. LEDGER ONLY: everything lives in
 * awards-recommendations; students/* and teams/* are never written.
 *
 *   pending --approve--> confirmed --revoke--> revoked
 *   pending --decline--> rejected
 *   pending --withdraw-> withdrawn
 *
 * Every state change is ONE transaction: 1 read (the recommendation) + 1 update + 1 audit-log entry.
 * Creating a recommendation is a single addDoc. Each function returns the updated record so the
 * page can patch its list instead of re-reading it.
 * Emails are stored lower-cased (the rules compare with request.auth.token.email.lower()).
 */
import {
  db, collection, doc, addDoc, getDocs, query, where, orderBy, limit, startAfter,
  runTransaction, serverTimestamp,
} from "./firebase-init.js";
import { buildAudit } from "./audit-service.js";
import { meter } from "./usage-meter.js";
import { levelLabel, validateApproval, schoolYearOf } from "./awards-form.js";

const { AWARDS_RECOMMENDATIONS_COLLECTION, AUDIT_COLLECTION = "audit-log" } = window.APP_CONFIG;
const PAGE = 50;
const PENDING_PAGE = 100;

const col = () => collection(db, AWARDS_RECOMMENDATIONS_COLLECTION);
const recRef = (id) => doc(db, AWARDS_RECOMMENDATIONS_COLLECTION, id);
const auditRef = () => doc(collection(db, AUDIT_COLLECTION));
const emailOf = (u) => String(u?.email || "").toLowerCase();
const stale = (message) => Object.assign(new Error(message), { stale: true });

/** Local-date ISO string (avoids the UTC off-by-one around midnight). */
export function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const describe = (rec, extra = "") =>
  `${levelLabel(rec.awardLevel)} · ${rec.teamName}${rec.ageGroup ? ` ${rec.ageGroup}` : ""}${extra ? ` · ${extra}` : ""}`;

const audit = (rec, id, action, extra) =>
  buildAudit({
    ops: [{ adminNo: rec.adminNo }],
    action,
    source: "awards-page",
    note: describe(rec, extra),
    extra: { recommendationId: id },
  });

/** Reads inside a transaction and checks the current status. */
async function load(tx, ref, expected) {
  const snap = await tx.get(ref);
  if (!snap.exists()) throw stale("This recommendation no longer exists.");
  const rec = snap.data();
  if (rec.status !== expected) throw stale(`This recommendation is already ${rec.status}.`);
  return rec;
}

function finish(id, rec, patch, stamps) {
  meter.read("awards-tx", 1);
  meter.write("awards", 1);
  meter.write("audit", 1);
  return { id, ...rec, ...patch, ...stamps };
}

/* ---------------- create ---------------- */

/** @returns {Promise<string>} the new document id */
export async function createRecommendation(payload, user) {
  const ref = await addDoc(col(), {
    ...payload,
    status: "pending",
    recommendedBy: user.uid,
    recommendedByEmail: emailOf(user),
    recommendedAt: serverTimestamp(),
  });
  meter.write("awards", 1);
  return ref.id;
}

/* ---------------- read ---------------- */

/**
 * One page, newest first. status: pending | confirmed | rejected | revoked | withdrawn | all.
 * Needs the composite index (status ASC, recommendedAt DESC) for the status tabs.
 * @returns {Promise<{rows:Array, last:Object|null, full:boolean}>} full = there may be more
 */
export async function listRecommendations(status = "pending", { after = null } = {}) {
  const n = status === "pending" ? PENDING_PAGE : PAGE;
  const clauses = [
    ...(status === "all" ? [] : [where("status", "==", status)]),
    orderBy("recommendedAt", "desc"),
    ...(after ? [startAfter(after)] : []),
    limit(n),
  ];
  const snap = await getDocs(query(col(), ...clauses));
  meter.read("awards-list", snap.size);
  return {
    rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    last: snap.docs.at(-1) || null,
    full: snap.size === n,
  };
}

/**
 * How many CONFIRMED awards the student already has for this team + level (any year, any age group).
 * Equality filters only, so no composite index. Revoked awards are excluded automatically.
 */
export async function countPriorAwards({ adminNo, teamName, awardLevel, excludeId = "" }) {
  const snap = await getDocs(
    query(col(), where("adminNo", "==", String(adminNo)), where("status", "==", "confirmed")),
  );
  meter.read("awards-prior", snap.size);
  return snap.docs.filter((d) => {
    const r = d.data();
    return d.id !== excludeId && r.teamName === teamName && r.awardLevel === awardLevel;
  }).length;
}

/* ---------------- approver actions ---------------- */

export function confirmRecommendation({
  recommendationId, approver, issuedDate = todayLocal(),
  schoolYear = schoolYearOf(issuedDate), nonMemberConfirmed = false, priorCount = 0,
}) {
  const ref = recRef(recommendationId);
  return runTransaction(db, async (tx) => {
    const rec = await load(tx, ref, "pending");
    const problems = validateApproval({ issuedDate, schoolYear, nonMember: Boolean(rec.nonMember), nonMemberConfirmed });
    if (problems.length) throw new Error(problems.join(" · "));
    const patch = {
      status: "confirmed",
      confirmedBy: approver.uid,
      confirmedByEmail: emailOf(approver),
      confirmedAt: serverTimestamp(),
      issuedDate,
      schoolYear: Number(schoolYear),
      reAward: priorCount > 0,
      priorCount,
      ...(rec.nonMember ? { nonMemberConfirmed: true } : {}),
    };
    tx.update(ref, patch);
    tx.set(auditRef(), audit(rec, recommendationId, "award.confirm", `school year ${patch.schoolYear}`));
    return finish(recommendationId, rec, patch, { confirmedAt: new Date() });
  });
}

export function rejectRecommendation({ recommendationId, approver, reason }) {
  if (!reason || !reason.trim()) throw new Error("A reason is required to decline.");
  const ref = recRef(recommendationId);
  return runTransaction(db, async (tx) => {
    const rec = await load(tx, ref, "pending");
    const patch = {
      status: "rejected",
      rejectedReason: reason.trim(),
      confirmedBy: approver.uid,
      confirmedByEmail: emailOf(approver),
      confirmedAt: serverTimestamp(),
    };
    tx.update(ref, patch);
    tx.set(auditRef(), audit(rec, recommendationId, "award.reject", reason.trim().slice(0, 80)));
    return finish(recommendationId, rec, patch, { confirmedAt: new Date() });
  });
}

/** Approvers only. The record is kept; counts and reports exclude it. */
export function revokeAward({ recommendationId, approver, reason }) {
  if (!reason || !reason.trim()) throw new Error("A reason is required to revoke.");
  const ref = recRef(recommendationId);
  return runTransaction(db, async (tx) => {
    const rec = await load(tx, ref, "confirmed");
    const patch = {
      status: "revoked",
      revokedBy: approver.uid,
      revokedByEmail: emailOf(approver),
      revokedAt: serverTimestamp(),
      revokedReason: reason.trim(),
    };
    tx.update(ref, patch);
    tx.set(auditRef(), audit(rec, recommendationId, "award.revoke", reason.trim().slice(0, 80)));
    return finish(recommendationId, rec, patch, { revokedAt: new Date() });
  });
}

/* ---------------- any recommender ---------------- */

/** Removes a PENDING recommendation from the queue (soft: status "withdrawn", history kept). */
export function withdrawRecommendation({ recommendationId, user }) {
  const ref = recRef(recommendationId);
  return runTransaction(db, async (tx) => {
    const rec = await load(tx, ref, "pending");
    const patch = {
      status: "withdrawn",
      withdrawnBy: user.uid,
      withdrawnByEmail: emailOf(user),
      withdrawnAt: serverTimestamp(),
    };
    tx.update(ref, patch);
    tx.set(auditRef(), audit(rec, recommendationId, "award.withdraw"));
    return finish(recommendationId, rec, patch, { withdrawnAt: new Date() });
  });
}