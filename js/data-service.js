/**
 * data-service.js
 * ----------------------------------------------------------------
 * Loads the full student roster once, caches it in the browser
 * (sessionStorage) for CACHE_TTL_MS, and serves every search/filter
 * from memory afterwards. This keeps Firestore reads to one batch
 * per session instead of one read per keystroke or filter change —
 * the roster is small enough (~1-2k docs) for this to be both the
 * cheapest and the fastest option.
 * ----------------------------------------------------------------
 */
import { db, collection, getDocs } from "./firebase-init.js";


const CACHE_KEY = "hhs_students_cache_v1";
const { CACHE_TTL_MS, STUDENTS_COLLECTION } = window.APP_CONFIG;

let memoryCache = null; // array of student objects, held for the page's lifetime

function readSessionCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { savedAt, students } = JSON.parse(raw);
    if (Date.now() - savedAt > CACHE_TTL_MS) return null;
    return students;
  } catch {
    return null;
  }
}

function writeSessionCache(students) {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), students }),
    );
  } catch {
    /* storage full or unavailable — safe to ignore, just skip caching */
  }
}

async function fetchFromFirestore() {
  const snapshot = await getDocs(collection(db, "students"));
  const students = [];
  snapshot.forEach((doc) => {
    students.push({
      id: doc.id,         // <--- THIS IS THE CRITICAL LINE
      ...doc.data()
    });
  });
  return students;
}

/**
 * Returns the full roster, from memory > sessionStorage > Firestore,
 * in that order of preference.
 */
export async function getAllStudents({ forceRefresh = false } = {}) {
  if (!forceRefresh && memoryCache) return memoryCache;

  if (!forceRefresh) {
    const cached = readSessionCache();
    if (cached) {
      memoryCache = cached;
      return memoryCache;
    }
  }

  const students = await fetchFromFirestore();
  memoryCache = students;
  writeSessionCache(students);
  return students;
}

/** Distinct, sorted subject names across the whole roster. */
export function collectSubjects(students) {
  const set = new Set();
  students.forEach((s) => (s.subjectsSummary || []).forEach((sub) => set.add(sub)));
  return Array.from(set).sort();
}

/** Distinct, sorted class codes, optionally narrowed to one grade. */
export function collectClasses(students, grade) {
  const set = new Set();
  students
    .filter((s) => !grade || String(s.grade) === String(grade))
    .forEach((s) => set.add(s.class));
  return Array.from(set).sort();
}

/** Distinct, sorted teacher names who teach a given subject. */
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

/**
 * Updates one student in the in-memory + sessionStorage cache after a
 * successful edit, so the table reflects it instantly without an extra
 * Firestore read. Returns the refreshed array.
 */
export function patchCachedStudent(updatedRecord) {
  if (!memoryCache) return null;
  memoryCache = memoryCache.map((s) =>
    String(s.adminNo) === String(updatedRecord.adminNo) ? updatedRecord : s,
  );
  writeSessionCache(memoryCache);
  return memoryCache;
}
