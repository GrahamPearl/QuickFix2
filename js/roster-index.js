/**
 * roster-index.js — compact copy of the student roster so a full load costs a handful of reads.
 *
 *  rosterIndex/chunk_000, chunk_001, …  { seq, count, version, data: "<JSON array of compact students>" }
 *  setting/roster                       { indexChunks, indexCount, indexUpdatedAt, indexBuiltAt, … }
 *
 * - `data` is a STRING on purpose: Firestore would otherwise create an index entry for every field
 *   of every student (40,000 per document limit). Each chunk stays under ~700 KB (limit is 1 MiB).
 * - students/{adminNo} remains the source of truth. The index is a derived copy:
 *     rebuildIndex()   admin button on the dashboard (reads every student once, writes ~5 docs)
 *     indexApply()     transactional patch after a write (reads the ~5 chunks, rewrites changed ones)
 *     queueIndexPatch() debounced indexApply for field patches (used by team membership sync)
 * - Chunk writes and the setting update are atomic (batch / transaction), so readers never see a mix.
 * - Loading: loadIndex() = one read per chunk (about 5 for 2,000 students). Callers fall back to reading
 *   students directly if it throws (index missing, incomplete, or rules not deployed).
 */
import { db, collection, doc, getDoc, getDocs, writeBatch, runTransaction, serverTimestamp } from "./firebase-init.js";

const CFG = window.APP_CONFIG;
const INDEX_COL = CFG.ROSTER_INDEX_COLLECTION || "rosterIndex";
const SETTINGS_COL = CFG.SETTINGS_COLLECTION || "setting";
const STUDENTS_COL = CFG.STUDENTS_COLLECTION || "students";
const MAX_BYTES = 700000;

const settingRef = () => doc(db, SETTINGS_COL, "roster");
const chunkRef = (i) => doc(db, INDEX_COL, `chunk_${String(i).padStart(3, "0")}`);
const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;

/* ---------- compact record <-> student ---------- */
// Everything search, drawer, seating, allocate, timetable and teams pages read. Awards/flags/academic stay in students/.
const KEEP = ["adminNo", "firstName", "lastName", "grade", "class", "registrationClass", "gender", "birthdate",
  "agegroup", "photo", "subjectsSummary", "enrollments", "teams"];
const empty = (v) => v === undefined || v === null || v === "" ||
  (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

export function toIndexRecord(s) {
  const r = { adminNo: String(s.adminNo) };
  KEEP.forEach((k) => { if (k !== "adminNo" && !empty(s[k])) r[k] = s[k]; });
  return r;
}

export function fromIndexRecord(r) {
  const low = (v) => String(v || "").trim().toLowerCase();
  const first = r.firstName || "", last = r.lastName || "";
  return {
    id: r.adminNo, class: "", registrationClass: "", gender: "", birthdate: "", agegroup: "", photo: "",
    ...r, firstName: first, lastName: last, fullName: `${first} ${last}`.trim(),
    subjectsSummary: r.subjectsSummary || [], enrollments: r.enrollments || {}, teams: r.teams || [],
    searchTokens: [...new Set([r.adminNo, low(first), low(last), `${low(first)} ${low(last)}`.trim()])],
  };
}

/** Sorted, de-duplicated students -> [{ data (JSON string), count }] each under MAX_BYTES. */
function partition(students) {
  const byId = new Map();
  students.filter((s) => s && s.adminNo).forEach((s) => byId.set(String(s.adminNo), toIndexRecord(s)));
  const recs = [...byId.values()].sort((a, b) => a.adminNo.localeCompare(b.adminNo));
  const out = []; let cur = [], size = 2;
  const flush = () => { if (cur.length) out.push({ data: JSON.stringify(cur), count: cur.length }); cur = []; size = 2; };
  for (const r of recs) {
    const n = bytes(JSON.stringify(r)) + 1;
    if (cur.length && size + n > MAX_BYTES) flush();
    cur.push(r); size += n;
  }
  flush();
  return out;
}

/** Works with a WriteBatch or a Transaction (both expose set/delete). Writes only changed chunks. */
function stage(w, parts, oldCount, prev = [], extra = {}) {
  const version = Date.now();
  parts.forEach((p, i) => { if (prev[i] !== p.data) w.set(chunkRef(i), { seq: i, count: p.count, version, data: p.data }); });
  for (let i = parts.length; i < oldCount; i++) w.delete(chunkRef(i));
  w.set(settingRef(), {
    indexChunks: parts.length, indexCount: parts.reduce((n, p) => n + p.count, 0),
    indexUpdatedAt: serverTimestamp(), forceRefreshAt: serverTimestamp(), ...extra,
  }, { merge: true });
}

/* ---------- read ---------- */
export async function loadIndex({ expectChunks = 0 } = {}) {
  const snap = await getDocs(collection(db, INDEX_COL));
  const docs = snap.docs.map((d) => d.data()).sort((a, b) => a.seq - b.seq);
  if (!docs.length) throw new Error("roster index is empty");
  if (docs.some((d, i) => d.seq !== i)) throw new Error("roster index is incomplete");
  if (expectChunks && docs.length !== expectChunks) throw new Error("roster index chunk count mismatch");
  return docs.flatMap((d) => JSON.parse(d.data)).map(fromIndexRecord);
}

/* ---------- rebuild (admin) ---------- */
export async function rebuildIndexFrom(students, { user } = {}) {
  const parts = partition(students);
  const snap = await getDoc(settingRef());
  const oldCount = snap.exists() ? snap.data().indexChunks || 0 : 0;
  const batch = writeBatch(db);
  stage(batch, parts, oldCount, [], { urgent: true, indexBuiltAt: serverTimestamp(), updatedBy: user?.email || "" });
  await batch.commit();
  return { chunks: parts.length, students: parts.reduce((n, p) => n + p.count, 0) };
}

/** Reads every student once (one read each) and rewrites the index. */
export async function rebuildIndex({ user } = {}) {
  const snap = await getDocs(collection(db, STUDENTS_COL));
  return rebuildIndexFrom(snap.docs.map((d) => ({ id: d.id, ...d.data() })), { user });
}

/* ---------- incremental maintenance ---------- */
/**
 * changes: { upserts:[full student objects], patches:[{adminNo, fields}], removes:[adminNo] }
 * No-op until an index has been built. Also bumps setting.forceRefreshAt so other users reload (cheaply).
 */
export async function indexApply({ upserts = [], patches = [], removes = [] } = {}) {
  if (!upserts.length && !patches.length && !removes.length) return { skipped: true };
  return runTransaction(db, async (tx) => {
    const s = await tx.get(settingRef());
    const n = s.exists() ? s.data().indexChunks || 0 : 0;
    if (!n) return { skipped: true };
    const snaps = await Promise.all(Array.from({ length: n }, (_, i) => tx.get(chunkRef(i))));
    if (snaps.some((x) => !x.exists())) throw new Error("Roster index is incomplete. Rebuild it from the dashboard.");
    const prev = snaps.map((x) => x.data().data);
    const map = new Map(prev.flatMap((d) => JSON.parse(d)).map((r) => [r.adminNo, r]));
    removes.forEach((a) => map.delete(String(a)));
    upserts.forEach((st) => map.set(String(st.adminNo), toIndexRecord(st)));
    patches.forEach(({ adminNo, fields }) => {
      const cur = map.get(String(adminNo));
      if (cur) map.set(String(adminNo), toIndexRecord({ ...cur, ...fields }));
    });
    stage(tx, partition([...map.values()]), n, prev);
    return { skipped: false };
  });
}

/* Debounced field patches (e.g. 30 team changes from one bulk add become one transaction). */
const pending = new Map();
let timer = null;
export function queueIndexPatch(adminNo, fields) {
  const k = String(adminNo);
  pending.set(k, { adminNo: k, fields: { ...(pending.get(k)?.fields || {}), ...fields } });
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const patches = [...pending.values()]; pending.clear();
    try { await indexApply({ patches }); }
    catch (e) { console.warn("Roster index update failed", e); window.dispatchEvent(new CustomEvent("roster-index-error", { detail: e })); }
  }, 1500);
}
