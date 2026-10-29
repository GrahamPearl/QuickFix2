/**
 * allocate-form.js
 * Pure helpers for the bulk subject allocation page. No DOM, no network.
 *
 * Enrollment written per student (key = subjectKey(subject)):
 *   { subject, teacher, line, grade, class }   // class = registration class
 */
import { subjectKey } from "./edit-form.js";

export const MAX_LINE = 10; // keep in step with timetable.js and the line input in render.js
export const GRADES = [8, 9, 10, 11, 12];

export const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const studentName = (s) =>
  s.fullName || `${s.firstName || ""} ${s.lastName || ""}`.trim() || String(s.adminNo);
export const isClassGrade = (grade, classGrades = [8, 9]) =>
  classGrades.map(Number).includes(Number(grade));

/* ---------- draft ---------- */
export const buildDraft = () => ({ grade: "", classes: [], selected: [], subject: "", teacher: "", line: "" });

export const applyField = (draft, field, value) => ({ ...draft, [field]: value });

/** Changing grade clears classes, selection and line (lines differ per grade). */
export const setGrade = (draft, grade) => ({ ...draft, grade: String(grade), classes: [], selected: [], line: "" });

/** Keeps only selected students who belong to one of the chosen classes. */
export function setClasses(draft, classes, roster) {
  const allowed = new Set(classes);
  const inClass = new Set(
    roster.filter((s) => allowed.has(clsOf(s))).map((s) => String(s.adminNo)),
  );
  return { ...draft, classes: [...classes], selected: draft.selected.filter((id) => inClass.has(id)) };
}

export function setSelected(draft, adminNos, on) {
  const set = new Set(draft.selected);
  adminNos.forEach((a) => (on ? set.add(String(a)) : set.delete(String(a))));
  return { ...draft, selected: [...set] };
}

/** Matches a typed subject to an existing one by key, so "maths" cannot create a duplicate of "Maths". */
export function canonicalSubject(typed, known) {
  const t = String(typed || "").trim();
  return known.find((s) => subjectKey(s) === subjectKey(t)) || t;
}

/** Returns a list of problems (empty = valid). */
export function validateDraft(draft) {
  const p = [];
  if (!draft.grade) p.push("Choose a grade");
  if (!draft.classes.length) p.push("Choose at least one class");
  if (!draft.selected.length) p.push("Select at least one student");
  if (!draft.subject.trim() || !subjectKey(draft.subject)) p.push("Choose a subject");
  if (!draft.teacher.trim()) p.push("Choose a teacher");
  const n = Number(draft.line);
  if (draft.line === "" || !Number.isInteger(n) || n < 1 || n > MAX_LINE) {
    p.push(`Choose a line from 1 to ${MAX_LINE}`);
  }
  return p;
}

/* ---------- enrollment ---------- */
export function buildEnrollment(draft, student) {
  return {
    subject: draft.subject.trim(),
    teacher: draft.teacher.trim(),
    line: Number(draft.line),
    grade: Number(draft.grade),
    class: clsOf(student),
  };
}

/** Returns a copy of the student with the new enrollment applied (for the roster and cache). */
export function patchStudent(student, enrollment) {
  const key = subjectKey(enrollment.subject);
  const summary = student.subjectsSummary || [];
  return {
    ...student,
    enrollments: { ...(student.enrollments || {}), [key]: enrollment },
    subjectsSummary: summary.includes(enrollment.subject) ? summary : [...summary, enrollment.subject],
  };
}

/* ---------- conflicts ----------
 * status "ready"    -> will be written
 * status "conflict" -> skipped (same-subject: fixable with overwrite; line-clash: fix manually)
 * status "skip"     -> cannot be allocated (no class / not found)
 */
export function classifyStudents(students, draft, { overwrite = false } = {}) {
  const key = subjectKey(draft.subject);
  const line = Number(draft.line);

  return students.map((s) => {
    const base = { student: s, adminNo: String(s.adminNo), name: studentName(s), class: clsOf(s) };
    if (!base.class) return { ...base, status: "skip", code: "no-class", reason: "No registration class on file" };

    const enrollments = s.enrollments || {};
    const same = enrollments[key] || null;
    if (same && !overwrite) {
      return {
        ...base, status: "conflict", code: "same-subject", previous: same,
        reason: `Already allocated: teacher ${same.teacher || "—"}, line ${same.line ?? "—"}`,
      };
    }

    const clash = Object.entries(enrollments).find(([k, e]) => k !== key && Number(e?.line) === line);
    if (clash) {
      return {
        ...base, status: "conflict", code: "line-clash",
        reason: `Line ${line} is already used by ${clash[1].subject || clash[0]}`,
      };
    }
    return { ...base, status: "ready", code: same ? "overwrite" : "new", previous: same };
  });
}

export const missingRow = (adminNo) => ({
  student: null, adminNo: String(adminNo), name: "(not found)", class: "",
  status: "skip", code: "missing", reason: "Student no longer exists",
});

export function summarize(rows) {
  const n = (st) => rows.filter((r) => r.status === st).length;
  return { total: rows.length, ready: n("ready"), conflict: n("conflict"), skip: n("skip"), failed: n("failed") };
}

/* ---------- CSV report ---------- */
function csvCell(v) {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // stop spreadsheet formula injection
  return `"${t.replace(/"/g, '""')}"`;
}

export function toCsv(rows) {
  const head = ["Admin No", "Name", "Class", "Status", "Reason"];
  const body = rows.map((r) => [r.adminNo, r.name, r.class, r.status, r.reason || ""]);
  return [head, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
