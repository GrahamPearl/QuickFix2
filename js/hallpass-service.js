/**
 * hallpass-service.js — all Firestore access for hall passes.
 *
 *  active-hall-passes/{teacherEmail}  { teacherEmail, activeStudents:[{adminNo,studentName,grade,class,reason,note?,leaveTime}] }
 *  history-hall-pass/{auto}           immutable log (see historyRecord)
 *
 * Cost notes
 *  - One live listener on active-hall-passes (one doc per teacher, so tiny).
 *  - A pass = 1 write (active doc) on sign-out, 2 writes on return (active + history).
 *  - History reads are by `dayKey` range, and COMPLETED weeks are cached in
 *    sessionStorage, so re-opening a past week or the 4-week view costs 0 reads.
 *  - serverTimestamp() is not allowed inside arrays, so entries use client Dates.
 */
import { escapeHtml as esc } from "./html.js";
import {
  db, collection, doc, getDocs, onSnapshot, query, where, runTransaction,
} from "./firebase-init.js";

const ACTIVE = "active-hall-passes";
const HISTORY = "history-hall-pass";

export const REASONS = [
  { key: "toilet", label: "Toilet" },
  { key: "front-office", label: "Front office" },
  { key: "grade-controller", label: "Grade controller" },
  { key: "other teacher", label: "Other teacher" },
  { key: "other reason", label: "Other reason" },
];
export const reasonLabel = (k) => REASONS.find((r) => r.key === k)?.label ?? k;
export const MAX_OUT = 2;
export const OVERDUE_MIN = 30;

/* ---------- date helpers (local time) ---------- */
const p2 = (n) => String(n).padStart(2, "0");
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const dateOfKey = (k) => new Date(`${k}T00:00:00`);
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
export const minutesOut = (ts, now = Date.now()) => Math.max(0, Math.floor((now - ts.toDate().getTime()) / 60000));

/** Spec protocol B: pad to 5 digits, then validate. */
export function normaliseAdminNo(v) {
  const raw = String(v ?? "").trim();
  if (!raw) throw new Error("Enter an admin number.");
  const s = raw.padStart(5, "0");
  if (!/^\d{5}$/.test(s)) throw new Error("Admin number must be 5 digits.");
  return s;
}

/* ---------- live view of everyone out ---------- */
export function watchActive(onRows, onError) {
  return onSnapshot(
    collection(db, ACTIVE),
    (snap) => onRows(snap.docs.map((d) => ({ email: d.id, ...d.data() }))),
    onError,
  );
}

/* ---------- history record ---------- */
function historyRecord(teacherEmail, e, { returnedOn, minutes, auto, signedOff, returnedBy }) {
  return {
    teacherEmail,
    adminNo: e.adminNo,
    studentName: e.studentName || "",
    grade: Number(e.grade) || null,
    class: e.class || "",
    photo: e.photo || "",
    reason: e.reason,
    ...(e.note ? { notes: e.note } : {}),
    leaveTime: e.leaveTime,
    returnedOn,
    durationMinutes: minutes,
    autoReturned: auto,
    signedOffByTeacher: signedOff,
    returnedBy: returnedBy || "",
    dayKey: dayKey(e.leaveTime.toDate()),
  };
}

/* ---------- sign out / return ---------- */
export function signOutStudent({ teacherEmail, student, reason, note = "" }) {
  const ref = doc(db, ACTIVE, teacherEmail);
  const adminNo = String(student.adminNo);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const list = snap.exists() ? snap.data().activeStudents || [] : [];
    if (list.length >= MAX_OUT) {
      throw new Error("Venue Limit Reached: Maximum of 2 students allowed out simultaneously. Please log a returning student first.");
    }
    if (list.some((e) => e.adminNo === adminNo)) throw new Error("That learner is already signed out by you.");
    const entry = {
      adminNo,
      studentName: student.fullName || `${student.firstName} ${student.lastName}`.trim(),
      grade: Number(student.grade) || null,
      class: String(student.registrationClass || student.class || ""),
      photo: String(student.photo || ""),
      reason,
      ...(note.trim() ? { note: note.trim().slice(0, 120) } : {}),
      leaveTime: new Date(),
    };
    tx.set(ref, { teacherEmail, activeStudents: [...list, entry] });
  });
}

/** forced=true when a reviewer closes someone else's stuck pass. */
export function returnStudent({ teacherEmail, adminNo, returnedBy, forced = false }) {
  const ref = doc(db, ACTIVE, teacherEmail);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const list = snap.exists() ? snap.data().activeStudents || [] : [];
    const e = list.find((x) => x.adminNo === String(adminNo));
    if (!e) throw new Error("This pass was already closed.");
    const now = new Date();
    const minutes = Math.max(0, Math.round((now - e.leaveTime.toDate()) / 60000));
    tx.set(doc(collection(db, HISTORY)), historyRecord(teacherEmail, e, {
      returnedOn: now, minutes, auto: false, signedOff: !forced, returnedBy,
    }));
    tx.set(ref, { teacherEmail, activeStudents: list.filter((x) => x !== e) });
  });
}

/** Lazy sweep (spec protocol C): closes passes left over from a previous day. No cron needed. */
export async function sweepStale(rows) {
  const today = dayKey();
  const isOld = (e) => dayKey(e.leaveTime.toDate()) < today;
  for (const r of rows.filter((x) => (x.activeStudents || []).some(isOld))) {
    const ref = doc(db, ACTIVE, r.email);
    await runTransaction(db, async (tx) => {
      const list = (await tx.get(ref)).data()?.activeStudents || [];
      const old = list.filter(isOld);
      if (!old.length) return;
      old.forEach((e) => tx.set(doc(collection(db, HISTORY)), historyRecord(r.email, e, {
        returnedOn: e.leaveTime.toDate(), minutes: null, auto: true, signedOff: false, returnedBy: "auto-sweep",
      })));
      tx.set(ref, { teacherEmail: r.email, activeStudents: list.filter((e) => !old.includes(e)) });
    });
  }
}

/* ---------- history for reviewers ---------- */
const slim = (d) => ({
  adminNo: d.adminNo, name: d.studentName, grade: d.grade, cls: d.class,
  photo: d.photo || "", reason: d.reason, day: d.dayKey, min: d.durationMinutes, auto: !!d.autoReturned, teacher: d.teacherEmail,
  t: d.leaveTime?.toMillis?.() ?? null, back: d.returnedOn?.toMillis?.() ?? null,
  by: d.returnedBy || "", forced: d.signedOffByTeacher === false && !d.autoReturned, note: d.notes || "",
});

/**
 * One Monday-to-Sunday week. Needs a composite index when grade is used
 * (grade ASC, dayKey ASC) — the console error contains a one-click link.
 */
export async function fetchWeek(monday, grade = "") {
  const start = dayKey(monday), end = dayKey(addDays(monday, 7));
  const complete = end <= dayKey(mondayOf()); // week fully in the past → will never change
  const ck = `hhs_hp_v2_${grade || "all"}_${start}`;
  if (complete) {
    try { const c = sessionStorage.getItem(ck); if (c) return JSON.parse(c); } catch { /* ignore */ }
  }
  const col = collection(db, HISTORY);
  const clauses = [where("dayKey", ">=", start), where("dayKey", "<", end)];
  if (grade) clauses.unshift(where("grade", "==", Number(grade)));
  const rows = (await getDocs(query(col, ...clauses))).docs.map((d) => slim(d.data()));
  if (complete) { try { sessionStorage.setItem(ck, JSON.stringify(rows)); } catch { /* ignore */ } }
  return rows;
}

/* ---------- photos (filename is stored on each pass, so tables need no student reads) ---------- */
const initialsOf = (name) => {
  const w = String(name || "?").trim().split(/\s+/);
  return ((w[0]?.[0] || "?") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
};
export function avatar(name, photo, large = false) {
  const size = large ? " hp-photo-lg" : "";
  const ini = esc(initialsOf(name));
  if (!photo) return `<span class="hp-photo hp-initials${size}">${ini}</span>`;
  const src = (window.APP_CONFIG?.IMAGE_BASE_URL || "") + encodeURI(photo);
  return `<img class="hp-photo${size}" src="${esc(src)}" alt="" loading="lazy" data-initials="${ini}" data-large="${large ? 1 : ""}">`;
}
// Broken photo -> initials (error events don't bubble, so capture)
document.addEventListener("error", (ev) => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.initials) return;
  const sp = document.createElement("span");
  sp.className = `hp-photo hp-initials${img.dataset.large ? " hp-photo-lg" : ""}`;
  sp.textContent = img.dataset.initials;
  img.replaceWith(sp);
}, true);
