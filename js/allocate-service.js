/**
 * allocate-service.js
 * Firestore access for bulk subject allocation.
 *
 *  - getGradeLines: line numbers used in a grade's timetable (grades 10-12).
 *  - applyAllocation: writes the enrollment to each "ready" student using
 *    field-path updates (other enrollments and concurrent edits are untouched),
 *    in chunks, and keeps one allocation-batches log document per run:
 *        stage 1 "started"  (written BEFORE any student; if it fails, nothing is written)
 *        stage 2 "completed" | "partial" | "failed" with counts and previous values
 */
import {
  auth,
  db,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  arrayUnion,
  serverTimestamp,
} from "./firebase-init.js";

import { subjectKey } from "./edit-form.js";
import { MAX_LINE, buildEnrollment } from "./allocate-form.js";

const {
  STUDENTS_COLLECTION,
  ALLOCATION_BATCHES_COLLECTION = "allocation-batches",
} = window.APP_CONFIG;
const CHUNK = 400; // Firestore allows 500 writes per batch

export async function getGradeLines(grade) {
  const fallback = Array.from({ length: MAX_LINE }, (_, i) => i + 1);
  try {
    const snap = await getDoc(doc(db, "timetables", `grade${Number(grade)}`));
    if (!snap.exists()) return fallback;
    const lines = new Set();
    (snap.data().grid || []).forEach((row) => {
      const cells = Array.isArray(row) ? row : row?.periods || [];
      cells.forEach((v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1) lines.add(n);
      });
    });
    return lines.size ? [...lines].sort((a, b) => a - b) : fallback;
  } catch (err) {
    console.warn("Could not read timetable lines, using defaults", err.code);
    return fallback;
  }
}

const logRow = (r) => ({
  adminNo: r.adminNo,
  name: r.name,
  class: r.class,
  status: r.status,
  reason: r.reason || "",
});

/**
 * @param {{draft:Object, rows:Array, user:Object}} args  rows come from classifyStudents()
 * @returns {Promise<{logId:string, status:string, updated:Array, failed:Array, skipped:Array}>}
 */
export async function applyAllocation({
  draft,
  rows,
  user = auth.currentUser,
}) {
  const key = subjectKey(draft.subject);
  const subject = draft.subject.trim();
  const ready = rows.filter((r) => r.status === "ready");
  const skipped = rows.filter((r) => r.status !== "ready");

  const logRef = doc(collection(db, ALLOCATION_BATCHES_COLLECTION));
  await setDoc(logRef, {
    grade: Number(draft.grade),
    classes: draft.classes,
    subject,
    teacher: draft.teacher.trim(),
    line: Number(draft.line),
    requested: rows.length,
    runBy: user?.email || "",
    runByUid: user?.uid || "",
    status: "started",
    startedAt: serverTimestamp(),
  });
  // add to the existing allocate-form import
  const toOp = (r) => {
    const enrollment = buildEnrollment(draft, r.student);
    return {
      adminNo: r.adminNo,
      before: r.student,
      after: patchStudent(r.student, enrollment),
      fields: {
        [`enrollments.${key}`]: enrollment,
        subjectsSummary: arrayUnion(subject),
      },
      row: r,
    };
  };

  let updated = [],
    failed = [];
  try {
    const res = await saveStudents(ready.map(toOp), {
      action: "allocate",
      source: "allocate-page",
      note: `${subject} · ${draft.teacher.trim()} · line ${draft.line} · log ${logRef.id}`,
    });
    updated = res.updated.map((o) => o.row);
    failed = res.failed.map((f) => ({
      ...f.op.row,
      status: "failed",
      reason: f.error.message,
    }));
  } catch (err) {
    failed = ready.map((r) => ({
      ...r,
      status: "failed",
      reason: err.message,
    }));
  }

  const status = failed.length
    ? updated.length
      ? "partial"
      : "failed"
    : "completed";
  try {
    await updateDoc(logRef, {
      status,
      finishedAt: serverTimestamp(),
      counts: {
        updated: updated.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      updated: updated.map((r) => ({
        adminNo: r.adminNo,
        previous: r.previous || null,
      })),
      skipped: [...skipped, ...failed].map(logRow),
    });
  } catch (err) {
    console.error(
      "Allocation finished but the log could not be completed",
      err,
    ); // students are already saved
  }

  return { logId: logRef.id, status, updated, failed, skipped };
}
