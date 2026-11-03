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
import { loadSnapshot, toCompact, fromCompact } from "./snapshot-service.js";
import { meter } from "./usage-meter.js";

const { STUDENTS_COLLECTION } = window.APP_CONFIG;
const KEY = `hhs_cache_${STUDENTS_COLLECTION}_v3`; // v3: compact records
const OLD_KEYS = [`hhs_cache_${STUDENTS_COLLECTION}_v2`]; // removed once, see below
try {
  OLD_KEYS.forEach((k) => localStorage.removeItem(k));
} catch {
  /* ignore */
}

const HARD_MAX_H = 24;
const HOUR = 3600000;

const TEAMS_COLLECTION = window.APP_CONFIG.TEAMS_COLLECTION || "teams";
const TEAMS_KEY = "hhs_teams_list_v1";
const TEAMS_TTL = 3 * HOUR;
const TEAMS_META = "_metadata";

let memoryCache = null;
let meta = null; // { loadedAt (client ms), forceSeen (server ms of the setting this cache satisfied) }

const ageH = (m) => (Date.now() - m.loadedAt) / HOUR;
const uid = () => auth.currentUser?.uid || null;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    return c && c.uid && c.uid === uid() ? c : null; // never reuse another user's copy
  } catch {
    return null;
  }
}

function writeCache() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...meta,
        uid: uid(),
        students: memoryCache.map(toCompact),
      }),
    );
  } catch {
    meter.error("localstorage-full"); /* carry on with the in-memory copy */
  }
}

function useCache(maxH) {
  const me = uid();
  if (memoryCache && meta && meta.uid === me && ageH(meta) < maxH) return true;
  const c = readCache();
  if (c && (Date.now() - c.loadedAt) / HOUR < maxH) {
    memoryCache = c.students.map(fromCompact);
    meta = {
      loadedAt: c.loadedAt,
      forceSeen: c.forceSeen || 0,
      uid: me,
      source: c.source,
    };
    return true;
  }
  return false;
}

/** Prefers the roster index (about 5 reads); falls back to reading every student if it is missing/unusable. */
async function fetchAll(forceSeen) {
  const t0 = performance.now();
  let list = null,
    source = "snapshot";
  try {
    const snap = await loadSnapshot(); // ≈ 6 reads
    if (snap) list = snap.students;
  } catch (e) {
    console.warn("Snapshot unreadable:", e.code || e.message);
    meter.error("snapshot-unreadable");
  }

  if (!list) {
    // not published yet / unreadable: old behaviour
    source = "students";
    meter.error("snapshot-missing");
    const snap = await getDocs(collection(db, STUDENTS_COLLECTION));
    meter.read("roster-full", snap.size);
    list = snap.docs.map((d) =>
      fromCompact(
        toCompact({ ...d.data(), adminNo: String(d.data().adminNo ?? d.id) }),
      ),
    );
  }
  memoryCache = list;
  meta = {
    loadedAt: Date.now(),
    forceSeen: forceSeen || 0,
    uid: uid(),
    source,
  };
  writeCache();
  meter.time("roster.load", performance.now() - t0);
  return memoryCache;
}

export function releaseRosterMemory() {
  memoryCache = null;
  meta = null;
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
  try {
    s = await getRosterSettings();
    meter.read("settings", 1);
  } catch (e) {
    console.warn("Roster settings unreadable:", e.code || e.message);
  }
  const have = useCache(Infinity) ? meta : null;
  const out = (reloaded) => ({
    students: memoryCache,
    reloaded,
    loadedAt: meta.loadedAt,
  });

  if (!s) {
    if (have && ageH(have) < ROSTER_DEFAULTS.minIntervalHours) {
      meter.cache(true);
      return out(false);
    }
    meter.cache(false);
    await fetchAll(have?.forceSeen);
    return out(true);
  }
  if (needsReload(have, s)) {
    meter.cache(false);
    await fetchAll(s.forceRefreshAt);
    return out(true);
  }
  meter.cache(true);
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
  students.forEach((s) =>
    (s.subjectsSummary || []).forEach((sub) => set.add(sub)),
  );
  return Array.from(set).sort();
}

export function collectClasses(students, grade) {
  const set = new Set();
  students
    .filter((s) => !grade || String(s.grade) === String(grade))
    .forEach((s) => set.add(s.class));
  return Array.from(set).sort();
}

export function collectTeachers(students, subject) {
  if (!subject) return [];
  const key = subject.toLowerCase().replace(/[^a-z0-9]/g, "");
  const set = new Set();
  students.forEach((s) => {
    const enr = (s.enrollments || {})[key];
    if (enr && enr.teacher) set.add(enr.teacher);
  });
  return Array.from(set).sort();
}

/* ---- local patches after a successful write (do not change cache age) ---- */
export function patchCachedStudent(rec) {
  if (!memoryCache) return null;
  memoryCache = memoryCache.map((s) =>
    String(s.adminNo) === String(rec.adminNo) ? rec : s,
  );
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
  memoryCache = [
    rec,
    ...memoryCache.filter((s) => String(s.adminNo) !== String(rec.adminNo)),
  ];
  writeCache();
}

export function clearRosterCache() {
  memoryCache = null;
  meta = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export async function getTeamsList({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    try {
      const c = JSON.parse(localStorage.getItem(TEAMS_KEY) || "null");
      if (c && c.uid === uid() && Date.now() - c.at < TEAMS_TTL) return c;
    } catch {
      /* ignore */
    }
  }
  const snap = await getDocs(collection(db, TEAMS_COLLECTION)); // includes _metadata, so no second read
  meter.read("teams-list", snap.size)
  let hidden = [];
  const teams = [];
  snap.forEach((d) => {
    if (d.id === TEAMS_META) {
      hidden = d.data().hidden || [];
      return;
    }
    if (d.id.startsWith("_") || d.id.includes("||")) return; // template / legacy docs
    const x = d.data();
    teams.push({
      id: d.id,
      teamName: x.teamName || d.id,
      ageGroups: Object.fromEntries(
        Object.keys(x.ageGroups || {}).map((g) => [g, true]),
      ),
    });
  });
  const out = { teams, hidden, at: Date.now(), uid: uid() };
  try {
    localStorage.setItem(TEAMS_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
  return out;
}

export function clearTeamsListCache() {
  try {
    localStorage.removeItem(TEAMS_KEY);
  } catch {
    /* ignore */
  }
}
