/**
 * student-write-service.js — the ONLY place that writes students/*.
 * op shapes:
 *   update: { adminNo, fields, before, after }   fields = Firestore update() map (dotted field paths allowed)
 *   remove: { adminNo, remove: true, before }
 * create: use createStudent() (transaction, existence check).
 */
import {
  auth,
  db,
  collection,
  doc,
  writeBatch,
  runTransaction,
  serverTimestamp,
} from "./firebase-init.js";
import { addSnapshotWrites } from "./snapshot-service.js";
import { buildAudit } from "./audit-service.js";
import { meter } from "./usage-meter.js";

const { STUDENTS_COLLECTION = "students", AUDIT_COLLECTION = "audit-log" } =
  window.APP_CONFIG;
const CHUNK = 450; // + a few snapshot chunk writes + 1 audit stays under the 500-write batch limit

function requireUser() {
  const u = auth.currentUser;
  if (!u) throw new Error("You are signed out.");
  return u;
}

async function commit(part, user, meta) {
  const batch = writeBatch(db);
  const stamp = { updatedBy: user.email, updatedAt: serverTimestamp() };
  part.forEach((op) => {
    const r = doc(db, STUDENTS_COLLECTION, String(op.adminNo));
    if (op.remove) {
      batch.delete(r);
      return;
    }
    if (!op.after)
      throw new Error(`saveStudents: "after" record missing for ${op.adminNo}`);
    batch.update(r, { ...op.fields, ...stamp });
  });
  const snapWrites = addSnapshotWrites(
    batch,
    part.map((op) => ({
      before: op.before || null,
      after: op.remove ? null : op.after,
    })),
  );
  batch.set(
    doc(collection(db, AUDIT_COLLECTION)),
    buildAudit({ ops: part, ...meta }),
  );
  await batch.commit();
  meter.write("students", part.length);
  meter.write("snapshot", snapWrites);
  meter.write("audit", 1);
}

/** @returns {{updated: Array, failed: Array<{op, error}>}} — throws only if nothing was saved. */
export async function saveStudents(ops, { action, source = "", note = "" }) {
  const user = requireUser();
  const meta = { action, source, note };
  const updated = [],
    failed = [];
  for (let i = 0; i < ops.length; i += CHUNK) {
    const part = ops.slice(i, i + CHUNK);
    try {
      await commit(part, user, meta);
      updated.push(...part);
    } catch (err) {
      meter.error(err.code || "batch-failed");
      if (
        ["permission-denied", "unauthenticated", "resource-exhausted"].includes(
          err.code,
        )
      ) {
        failed.push(...part.map((op) => ({ op, error: err }))); // retrying cannot help
        continue;
      }
      if (part.length === 1) {
        failed.push({ op: part[0], error: err });
        continue;
      }
      for (const op of part) {
        // nothing was applied (batches are atomic), so retry one by one
        try {
          await commit([op], user, { ...meta, note: `${note} (retry)`.trim() });
          updated.push(op);
        } catch (e) {
          meter.error(e.code || "write-failed");
          failed.push({ op, error: e });
        }
      }
    }
  }
  if (!updated.length && failed.length) throw failed[0].error;
  return { updated, failed };
}

export async function createStudent(rec, { source = "" } = {}) {
  const user = requireUser();
  const adminNo = String(rec.adminNo);
  const r = doc(db, STUDENTS_COLLECTION, adminNo);
  await runTransaction(db, async (tx) => {
    if ((await tx.get(r)).exists())
      throw new Error(`Student ${adminNo} already exists.`);
    tx.set(r, {
      ...rec,
      createdBy: user.email,
      createdAt: serverTimestamp(),
      updatedBy: user.email,
      updatedAt: serverTimestamp(),
    });
    addSnapshotWrites(tx, [{ before: null, after: rec }]);
    tx.set(
      doc(collection(db, AUDIT_COLLECTION)),
      buildAudit({
        ops: [{ adminNo, create: true }],
        action: "student.create",
        source,
      }),
    );
  });
  meter.write("students", 1);
  meter.write("snapshot", 1);
  meter.write("audit", 1);
}
