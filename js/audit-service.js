/**
 * audit-service.js — immutable audit-log/{auto}. One entry per committed batch (not per student).
 * { at, day, by, byEmail, action, source, count, adminNos[<=200], truncated, changes[<=25], fields[], note }
 * Names are never stored; birthdate values are masked. Rules make the collection create-only.
 */
import {
  auth, db, collection, doc, setDoc, getDocs, query, where, orderBy, limit, startAfter, serverTimestamp,
} from "./firebase-init.js";
import { meter } from "./usage-meter.js";

const COL = window.APP_CONFIG.AUDIT_COLLECTION || "audit-log";
const MAX_IDS = 200, MAX_CHANGES = 25;
const TRACKED = ["firstName", "lastName", "grade", "class", "registrationClass", "gender", "birthdate",
  "agegroup", "photo", "subjectsSummary", "enrollments", "teams"];

export const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const show = (k, v) => {
  if (k === "birthdate") return "(changed)";
  const t = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
};

function diff(op) {
  const id = String(op.adminNo);
  if (op.remove) return [{ adminNo: id, field: "(record)", from: "exists", to: "deleted" }];
  if (op.create) return [{ adminNo: id, field: "(record)", from: "", to: "created" }];
  const b = op.before || {}, a = op.after || {};
  return TRACKED.filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null))
    .map((k) => ({ adminNo: id, field: k, from: op.before ? show(k, b[k]) : "?", to: show(k, a[k]) }));
}

/** Plain object to pass to batch.set / tx.set (serverTimestamp inside). */
export function buildAudit({ ops, action, source = "", note = "", extra = {} }) {
  const user = auth.currentUser;
  const ids = ops.map((o) => String(o.adminNo));
  const changes = ops.flatMap(diff).slice(0, MAX_CHANGES);
  return {
    at: serverTimestamp(), day: dayKey(), by: user?.uid || "", byEmail: user?.email || "",
    action, source, count: ids.length, adminNos: ids.slice(0, MAX_IDS), truncated: ids.length > MAX_IDS,
    changes, fields: [...new Set(changes.map((c) => c.field))], note: String(note).slice(0, 300), ...extra,
  };
}

/** For events that are not student writes (snapshot publish, roster refresh, structure changes…). */
export async function logAudit({ action, source = "", note = "", count = 0, extra = {} }) {
  await setDoc(doc(collection(db, COL)), buildAudit({ ops: [], action, source, note, extra: { count, ...extra } }));
  meter.write("audit", 1);
}

/** Admin view. Single range field + orderBy on the same field: no composite index needed. */
export async function listAudit({ fromDay, toDay, max = 300, after = null }) {
  const clauses = [where("day", ">=", fromDay), where("day", "<=", toDay), orderBy("day", "desc"), limit(max)];
  if (after) clauses.push(startAfter(after));
  const snap = await getDocs(query(collection(db, COL), ...clauses));
  meter.read("audit-view", snap.size);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.at?.seconds ?? 0) - (a.at?.seconds ?? 0));
  return { rows, last: snap.docs.at(-1) || null, full: snap.size === max };
}