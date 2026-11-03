/**
 * snapshot-service.js — compact roster snapshot: rosterSnapshot/{chunk} + rosterSnapshot/_meta
 *   chunk = { chunk, builtAt, updatedAt, count, students: { "<adminNo>": "<JSON of compact student>" } }
 * One chunk per grade (optionally per class for big grades). Writers patch chunks in the SAME batch
 * as the student write (addSnapshotWrites), so the snapshot cannot silently drift.
 */
import {
  db, collection, doc, getDocs, getCountFromServer, writeBatch, serverTimestamp, deleteField, FieldPath,
} from "./firebase-init.js";
import { meter } from "./usage-meter.js";

const {
  STUDENTS_COLLECTION = "students", SNAPSHOT_COLLECTION = "rosterSnapshot", SNAPSHOT_SPLIT_GRADES = [],
} = window.APP_CONFIG;
const SCHEMA = 1, META = "_meta", MAX_BYTES = 900_000; // Firestore document limit is 1 MiB
const SPLIT = new Set(SNAPSHOT_SPLIT_GRADES.map(Number));
const ref = (id) => doc(db, SNAPSHOT_COLLECTION, id);

/* ---------- pure helpers ---------- */
const KEEP = ["adminNo", "firstName", "lastName", "fullName", "grade", "class", "registrationClass",
  "gender", "birthdate", "agegroup", "photo"];

/** Only what search, drawer, seating, allocation and teams pages read. Everything else stays in students/{id}. */
export function toCompact(s) {
  const c = {};
  KEEP.forEach((k) => { if (s[k] !== undefined && s[k] !== null && s[k] !== "") c[k] = s[k]; });
  c.adminNo = String(s.adminNo);
  c.subjectsSummary = s.subjectsSummary || [];
  c.enrollments = Object.fromEntries(Object.entries(s.enrollments || {}).map(([k, e]) =>
    [k, { subject: e?.subject || "", teacher: e?.teacher || "", line: e?.line ?? "" }]));
  c.teams = (s.teams || []).map((t) => ({ teamName: t.teamName || "", ageGroup: t.ageGroup || "", role: t.role || "Member" }));
  return c;
}

export function fromCompact(c) {
  const low = (v) => String(v || "").toLowerCase();
  const f = low(c.firstName), l = low(c.lastName);
  return { ...c, id: c.adminNo, searchTokens: [...new Set([String(c.adminNo), f, l, `${f} ${l}`.trim()])] };
}

export function chunkId(s) {
  const g = Number(s.grade) || 0;
  if (!SPLIT.has(g)) return `g${g}`;
  return `g${g}_${String(s.registrationClass || s.class || "x").replace(/[^A-Za-z0-9]/g, "")}`;
}

/**
 * Adds ONE set() per affected chunk to a WriteBatch or Transaction.
 * changes: [{ before, after }]  (before=null for a new student, after=null for a deleted one)
 * Returns the number of write operations added.
 */
export function addSnapshotWrites(writer, changes) {
  const per = new Map();
  const slot = (cid) => per.get(cid) || per.set(cid, { set: {}, del: new Set() }).get(cid);
  for (const { before, after } of changes) {
    const id = String((after || before).adminNo);
    const from = before ? chunkId(before) : null, to = after ? chunkId(after) : null;
    if (from && from !== to) slot(from).del.add(id);          // moved to another grade/class chunk
    if (to) slot(to).set[id] = JSON.stringify(toCompact(after));
  }
  per.forEach((p, cid) => {
    const students = { ...p.set };
    p.del.forEach((id) => { students[id] = deleteField(); });
    const ids = Object.keys(students);
    writer.set(ref(cid), { chunk: cid, updatedAt: serverTimestamp(), students }, {
      mergeFields: [new FieldPath("chunk"), new FieldPath("updatedAt"), ...ids.map((id) => new FieldPath("students", id))],
    });
  });
  return per.size;
}

/* ---------- read ---------- */
/** One read per chunk (+1 for _meta). Returns null when no published snapshot exists. */
export async function loadSnapshot() {
  const snap = await getDocs(collection(db, SNAPSHOT_COLLECTION));
  meter.read("roster-snapshot", snap.size);
  const meta = snap.docs.find((d) => d.id === META)?.data();
  if (!meta?.ready || meta.schema !== SCHEMA) return null;
  const students = [];
  snap.forEach((d) => {
    if (d.id === META) return;
    Object.values(d.data().students || {}).forEach((json) => {
      try { students.push(fromCompact(JSON.parse(json))); } catch { console.warn("Bad snapshot entry in", d.id); }
    });
  });
  return { students, chunks: snap.size - 1 };
}

/* ---------- admin tools ---------- */
/** Rebuilds every chunk from students/*. Costs one read per student + a few; run out of hours. */
export async function publishSnapshot() {
  const all = await getDocs(collection(db, STUDENTS_COLLECTION));
  meter.read("snapshot-publish", all.size);
  const per = new Map(), sizes = {};
  all.forEach((d) => {
    const s = { ...d.data(), adminNo: String(d.data().adminNo ?? d.id) };
    const cid = chunkId(s);
    if (!per.has(cid)) per.set(cid, {});
    per.get(cid)[s.adminNo] = JSON.stringify(toCompact(s));
  });
  for (const [cid, students] of per) {
    sizes[cid] = JSON.stringify(students).length;
    if (sizes[cid] > MAX_BYTES) {
      throw new Error(`Chunk ${cid} is ${Math.round(sizes[cid] / 1024)} KB (limit ~1024 KB). Add its grade to SNAPSHOT_SPLIT_GRADES in config.js, redeploy, and publish again.`);
    }
  }
  const old = await getDocs(collection(db, SNAPSHOT_COLLECTION));
  meter.read("snapshot-publish", old.size);
  const batch = writeBatch(db);
  old.forEach((d) => { if (d.id !== META && !per.has(d.id)) batch.delete(d.ref); });
  per.forEach((students, cid) => batch.set(ref(cid), {
    chunk: cid, builtAt: serverTimestamp(), updatedAt: serverTimestamp(), count: Object.keys(students).length, students,
  }));
  batch.set(ref(META), { ready: true, schema: SCHEMA, builtAt: serverTimestamp(), students: all.size, chunks: per.size });
  await batch.commit();
  meter.write("snapshot", per.size + 1);
  return { students: all.size, chunks: per.size, sizes };
}

/** Compares student count with snapshot count and reports chunk sizes. ~chunks + 1 reads. */
export async function checkSnapshot() {
  const [snap, total] = await Promise.all([
    getDocs(collection(db, SNAPSHOT_COLLECTION)), getCountFromServer(collection(db, STUDENTS_COLLECTION)),
  ]);
  meter.read("snapshot-check", snap.size + 1);
  let inSnapshot = 0;
  const chunks = [];
  snap.forEach((d) => {
    if (d.id === META) return;
    const n = Object.keys(d.data().students || {}).length;
    inSnapshot += n;
    chunks.push({ id: d.id, count: n, kb: Math.round(JSON.stringify(d.data()).length / 1024) });
  });
  const ready = Boolean(snap.docs.find((d) => d.id === META)?.data()?.ready);
  return { ready, students: total.data().count, inSnapshot, chunks, ok: ready && total.data().count === inSnapshot };
}