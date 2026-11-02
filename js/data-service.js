/**
 * data-service.js
 * Roster cache (memory + localStorage) governed by the shared setting/roster document.
 *
 * Search page: ensureFreshRoster() reads the setting (1 read) and reloads ALL students only when
 *   - there is no usable cache, or the cache is older than setting.maxAgeHours, or
 *   - an admin requested a refresh (setting.forceRefreshAt newer than the one this cache saw) AND
 *     (the request is urgent OR the cache is already older than setting.minIntervalHours, default 6h).
 * Other pages: getAllStudents() uses whatever cache exists (up to HARD_MAX_H), so they cost no extra reads.
 * Cache age is measured from the last FULL load; patching a student never extends it.
 */
import { auth, db, collection, getDocs } from "./firebase-init.js";
import { getRosterSettings, ROSTER_DEFAULTS } from "./settings-service.js";

const { STUDENTS_COLLECTION } = window.APP_CONFIG;
const KEY = `hhs_cache_${STUDENTS_COLLECTION}_v2`;
const HARD_MAX_H = 24;
const HOUR = 3600000;

let memoryCache = null;
let meta = null; // { loadedAt (client ms), forceSeen (server ms of the setting this cache satisfied) }

const ageH = (m) => (Date.now() - m.loadedAt) / HOUR;
const uid = () => auth.currentUser?.uid || null;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    return c && c.uid && c.uid === uid() ? c : null; // never reuse another user's copy
  } catch { return null; }
}
function writeCache() {
  try { localStorage.setItem(KEY, JSON.stringify({ ...meta, uid: uid(), students: memoryCache })); }
  catch { /* storage full: carry on with the in-memory copy */ }
}

/** Loads memory/storage cache if younger than maxH. Returns true when memoryCache is usable. */
function useCache(maxH) {
  if (memoryCache && meta && ageH(meta) < maxH) return true;
  const c = readCache();
  if (c && (Date.now() - c.loadedAt) / HOUR < maxH) {
    memoryCache = c.students;
    meta = { loadedAt: c.loadedAt, forceSeen: c.forceSeen || 0 };
    return true;
  }
  return false;
}

async function fetchAll(forceSeen) {
  const snap = await getDocs(collection(db, STUDENTS_COLLECTION));
  memoryCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  meta = { loadedAt: Date.now(), forceSeen: forceSeen || 0 };
  writeCache();
  return memoryCache;
}

export function needsReload(m, s) {
  if (!m) return true;
  const age = ageH(m);
  if (age >= s.maxAgeHours) return true;
  const requested = s.forceRefreshAt > (m.forceSeen || 0);
  return requested && (s.urgent === true || age >= s.minIntervalHours);
}

/** For search.html. Returns { students, reloaded, loadedAt }. */
export async function ensureFreshRoster() {
  let s = null;
  try { s = await getRosterSettings(); } catch (e) { console.warn("Roster settings unreadable:", e.code || e.message); }
  const have = useCache(Infinity) ? meta : null;
  const out = (reloaded) => ({ students: memoryCache, reloaded, loadedAt: meta.loadedAt });

  if (!s) { // settings unavailable: keep a copy younger than the default interval, otherwise reload
    if (have && ageH(have) < ROSTER_DEFAULTS.minIntervalHours) return out(false);
    await fetchAll(have?.forceSeen);
    return out(true);
  }
  if (needsReload(have, s)) { await fetchAll(s.forceRefreshAt); return out(true); }
  return out(false);
}

export const getRosterMeta = () => (meta ? { ...meta } : null);

/** Other pages: cache if present (up to HARD_MAX_H), else one full read. */
export async function getAllStudents({ forceRefresh = false } = {}) {
  if (!forceRefresh && useCache(HARD_MAX_H)) return memoryCache;
  return fetchAll(meta?.forceSeen);
}

export function collectSubjects(students) {
  const set = new Set();
  students.forEach((s) => (s.subjectsSummary || []).forEach((sub) => set.add(sub)));
  return Array.from(set).sort();
}

export function collectClasses(students, grade) {
  const set = new Set();
  students.filter((s) => !grade || String(s.grade) === String(grade)).forEach((s) => set.add(s.class));
  return Array.from(set).sort();
}

export function collectTeachers(students, subject) {
  if (!subject) return [];
  const key = subject.toLowerCase().replace(/[^a-z0-9]/g, "");
  const set = new Set();
  students.forEach((s) => { const enr = (s.enrollments || {})[key]; if (enr && enr.teacher) set.add(enr.teacher); });
  return Array.from(set).sort();
}

/* ---- local patches after a successful write (do not change cache age) ---- */
export function patchCachedStudent(rec) {
  if (!memoryCache) return null;
  memoryCache = memoryCache.map((s) => (String(s.adminNo) === String(rec.adminNo) ? rec : s));
  writeCache();
  return memoryCache;
}
export function patchCachedStudents(records) {
  if (!memoryCache || !records.length) return null;
  const byId = new Map(records.map((r) => [String(r.adminNo), r]));
  memoryCache = memoryCache.map((s) => byId.get(String(s.adminNo)) || s);
  writeCache();
  return memoryCache;
}
export function addCachedStudent(rec) {
  if (!memoryCache) return;
  memoryCache = [rec, ...memoryCache.filter((s) => String(s.adminNo) !== String(rec.adminNo))];
  writeCache();
}

export function clearRosterCache() {
  memoryCache = null; meta = null;
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(`hhs_cache_${STUDENTS_COLLECTION}_v1`); } catch { /* ignore */ }
}
