/**
 * awards-service.js
 * Firestore access for the two-stage awards workflow.
 *
 *  - createRecommendation: admin/approver -> awards-recommendations (status "pending").
 *    The student record is NOT touched.
 *  - confirmRecommendation: approver only. ONE transaction updates the student
 *    (awards, teamMemberships, teamsSummary), the team (members) and the
 *    recommendation (status/approver/issue date) together, then returns the
 *    post-transaction student so callers can patch their caches with it.
 *  - rejectRecommendation: approver only; marks the recommendation rejected.
 *
 * The same award level may be issued to the same student more than once for a
 * team; every confirmation appends a new entry and increments the counter.
 */
import {
  db,
  collection,
  doc,
  addDoc,
  getDocs,
  query,
  where,
  runTransaction,
  serverTimestamp,
  arrayUnion,
} from "./firebase-init.js";

const { STUDENTS_COLLECTION, TEAMS_COLLECTION, AWARDS_RECOMMENDATIONS_COLLECTION } = window.APP_CONFIG;

const emptyCounts = () => ({ merits: 0, halfColours: 0, fullColours: 0 });

/** Local-date ISO string (avoids the UTC off-by-one after 22:00 in UTC+2). */
export function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function createRecommendation(payload, user) {
  const ref = await addDoc(collection(db, AWARDS_RECOMMENDATIONS_COLLECTION), {
    ...payload,
    status: "pending",
    recommendedBy: user.uid,
    recommendedByEmail: user.email,
    recommendedAt: serverTimestamp(),
    confirmedBy: null,
    confirmedByEmail: null,
    confirmedAt: null,
    issuedDate: null,
    rejectedReason: null,
  });
  return ref.id;
}

/**
 * @param {"pending"|"confirmed"|"rejected"|"all"} status
 * Sorted newest-first client-side, so no composite index is needed.
 */
export async function listRecommendations(status = "pending") {
  const col = collection(db, AWARDS_RECOMMENDATIONS_COLLECTION);
  const snap = await getDocs(status === "all" ? col : query(col, where("status", "==", status)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.recommendedAt?.seconds ?? 0) - (a.recommendedAt?.seconds ?? 0));
}

/**
 * @returns {Promise<{student: Object, team: Object}>} post-transaction records
 */
export async function confirmRecommendation({ recommendationId, approver, issuedDate = todayLocal() }) {
  const recRef = doc(collection(db, AWARDS_RECOMMENDATIONS_COLLECTION), recommendationId);

  return runTransaction(db, async (tx) => {
    // ---- all reads first ----
    const recSnap = await tx.get(recRef);
    if (!recSnap.exists()) throw new Error("This recommendation no longer exists.");
    const rec = recSnap.data();
    if (rec.status !== "pending") throw new Error(`This recommendation is already ${rec.status}.`);

    const studentRef = doc(collection(db, STUDENTS_COLLECTION), String(rec.adminNo));
    const teamRef = doc(collection(db, TEAMS_COLLECTION), rec.teamId);
    const [studentSnap, teamSnap] = await Promise.all([tx.get(studentRef), tx.get(teamRef)]);
    if (!studentSnap.exists()) throw new Error(`Student ${rec.adminNo} no longer exists.`);
    if (!teamSnap.exists()) throw new Error(`Team "${rec.teamName}" no longer exists.`);
    if (!(rec.awardLevel in emptyCounts())) throw new Error(`Unknown award level "${rec.awardLevel}".`);

    const student = studentSnap.data();
    const team = teamSnap.data();

    // ---- compute ----
    const memberships = { ...(student.teamMemberships || {}) };
    const current = memberships[rec.teamId] || {
      teamId: rec.teamId,
      teamName: team.name,
      category: team.category || "",
      awards: emptyCounts(),
    };
    const awardCounts = { ...emptyCounts(), ...current.awards };
    awardCounts[rec.awardLevel] += 1;
    memberships[rec.teamId] = { ...current, teamName: team.name, awards: awardCounts };

    const awards = [
      ...(student.awards || []),
      {
        recommendationId: recommendationId,
        teamId: rec.teamId,
        teamName: team.name,
        level: rec.awardLevel,
        note: rec.note || "",
        issuedDate,
        confirmedBy: approver.email,
      },
    ];
    const teamsSummary = Array.from(new Set([...(student.teamsSummary || []), team.name]));
    const members = Array.from(new Set([...(team.members || []), String(rec.adminNo)]));

    // ---- all writes together ----
    tx.update(studentRef, { awards, teamMemberships: memberships, teamsSummary });
    tx.update(teamRef, { members: arrayUnion(String(rec.adminNo)) });
    tx.update(recRef, {
      status: "confirmed",
      confirmedBy: approver.uid,
      confirmedByEmail: approver.email,
      confirmedAt: serverTimestamp(),
      issuedDate,
    });

    return {
      student: { ...student, awards, teamMemberships: memberships, teamsSummary },
      team: { ...team, teamId: rec.teamId, members },
    };
  });
}

/** Reviewer stamps reuse confirmedBy/confirmedByEmail/confirmedAt for rejections too. */
export async function rejectRecommendation({ recommendationId, approver, reason }) {
  if (!reason || !reason.trim()) throw new Error("A reason is required to decline.");
  const recRef = doc(collection(db, AWARDS_RECOMMENDATIONS_COLLECTION), recommendationId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(recRef);
    if (!snap.exists()) throw new Error("This recommendation no longer exists.");
    if (snap.data().status !== "pending") throw new Error(`This recommendation is already ${snap.data().status}.`);
    tx.update(recRef, {
      status: "rejected",
      rejectedReason: reason.trim(),
      confirmedBy: approver.uid,
      confirmedByEmail: approver.email,
      confirmedAt: serverTimestamp(),
    });
  });
}
