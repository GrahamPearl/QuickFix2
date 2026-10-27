/**
 * js/timetable.js
 * Two kinds of timetable, one modal:
 *  - "line"  (grades 10-12): one doc per grade; cells are subject LINE numbers
 *            (-1 = free), resolved per student through enrollments.
 *  - "class" (grades 8-9, APP_CONFIG.CLASS_TIMETABLE_GRADES): one doc per
 *            registration class; cells are free text, e.g. "Maths | Mr Smith".
 * Security is enforced by Firestore Rules, not by this file.
 */
import { db, doc, getDoc, setDoc, auth } from "./firebase-init.js";
import { escapeHtml } from "./html.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_DAYS = 5;
const DEFAULT_PERIODS = 6;
const MAX_LINE = 10; // keep in step with the line input in render.js

const classGrades = () =>
  (window.APP_CONFIG?.CLASS_TIMETABLE_GRADES || [8, 9]).map(Number);
const isClassGrade = (g) => classGrades().includes(Number(g));
const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();

export function makeTarget(grade, className = "") {
  grade = Number(grade);
  if (isClassGrade(grade)) {
    return {
      grade,
      className,
      mode: "class",
      docId: className ? `class_${grade}_${slug(className)}` : null,
    };
  }
  return { grade, className: "", mode: "line", docId: `grade${grade}` };
}
const blankOf = (t) => (t.mode === "class" ? "" : -1);
const labelOf = (t) =>
  t.mode === "class" ? `Grade ${t.grade} class ${t.className || "—"}` : `Grade ${t.grade}`;

/* ---------- state ---------- */
let currentTarget = null;
let currentStudent = null;
let currentTimetableData = null;
let isEditMode = false;
let canEditNow = false;
let editDays = DEFAULT_DAYS;
let editPeriods = DEFAULT_PERIODS;
let editGrid = [];
let openSeq = 0;
let getClasses = () => [];

/* ---------- grid helpers ---------- */
const blankGrid = (d, p, b) => Array.from({ length: d }, () => Array(p).fill(b));

function deserializeGrid(raw, days, periods, blank) {
  if (!Array.isArray(raw)) return blankGrid(days, periods, blank);
  return raw.map((row) => {
    if (Array.isArray(row)) return row;
    if (row && Array.isArray(row.periods)) return row.periods;
    return Array(periods).fill(blank);
  });
}
const serializeGrid = (grid) =>
  grid.map((row) => ({ periods: Array.isArray(row) ? row : [] }));

/* ---------- Firestore ---------- */
export async function getTimetable(target) {
  const blank = blankOf(target);
  const empty = {
    target, days: DEFAULT_DAYS, periods: DEFAULT_PERIODS,
    grid: blankGrid(DEFAULT_DAYS, DEFAULT_PERIODS, blank),
    updatedAt: null, updatedBy: null, existsInDb: false,
  };
  if (!target.docId) return empty;

  const snap = await getDoc(doc(db, "timetables", target.docId));
  if (!snap.exists()) return empty;

  const d = snap.data();
  const days = Number(d.days || DEFAULT_DAYS);
  const periods = Number(d.periods || DEFAULT_PERIODS);
  return {
    target, days, periods,
    grid: deserializeGrid(d.grid, days, periods, blank),
    updatedAt: d.updatedAt || null,
    updatedBy: d.updatedBy || null,
    existsInDb: true,
  };
}

export async function saveTimetable(target, days, periods, grid) {
  if (!target.docId) throw new Error("Choose a class first.");
  const payload = {
    grade: target.grade,
    mode: target.mode,
    days: Number(days),
    periods: Number(periods),
    grid: serializeGrid(grid),
    updatedAt: new Date().toISOString(),
    updatedBy: auth.currentUser?.email || "unknown",
  };
  if (target.mode === "class") payload.className = target.className;
  await setDoc(doc(db, "timetables", target.docId), payload, { merge: true });
  return {
    target, days: payload.days, periods: payload.periods, grid,
    updatedAt: payload.updatedAt, updatedBy: payload.updatedBy, existsInDb: true,
  };
}

/* ---------- student line lookup (line mode only) ---------- */
export function buildLineToSubjectMap(student) {
  const map = {};
  const key = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  (student?.subjectsSummary || []).forEach((name) => {
    const enr = (student.enrollments || {})[key(name)];
    if (enr && enr.line !== undefined && enr.line !== null && enr.line !== "") {
      map[Number(enr.line)] = { subject: name, teacher: enr.teacher || "" };
    }
  });
  return map;
}
const currentLineMap = () =>
  currentTarget?.mode === "line" && currentStudent
    ? buildLineToSubjectMap(currentStudent)
    : null;

/* ---------- rendering ---------- */
function cellHtml(value, lineMap) {
  if (currentTarget.mode === "class") {
    const text = String(value ?? "").trim();
    if (!text) return `<span class="tt-badge-none">-</span>`;
    const [subject, teacher] = text.split("|").map((s) => s.trim());
    return (
      `<span class="tt-badge-subject">${escapeHtml(subject)}</span>` +
      (teacher ? `<span class="tt-teacher">${escapeHtml(teacher)}</span>` : "")
    );
  }
  const n = Number(value);
  const line = Number.isFinite(n) ? n : -1;
  if (line === -1) return `<span class="tt-badge-none">-</span>`;
  if (!lineMap) return `<span class="tt-badge-subject">Line ${line}</span>`;
  const hit = lineMap[line];
  if (!hit) return `<span class="tt-badge-not-enrolled">Not Enrolled</span>`;
  return (
    `<span class="tt-badge-subject">${escapeHtml(hit.subject)}</span>` +
    (hit.teacher ? `<span class="tt-teacher">${escapeHtml(hit.teacher)}</span>` : "")
  );
}

function inputHtml(d, p, value) {
  if (currentTarget.mode === "class") {
    return `<input type="text" id="tt_cell_${d}_${p}" class="tt-cell-input tt-cell-text"
      maxlength="40" value="${escapeHtml(String(value ?? ""))}" placeholder="Subject | Teacher" autocomplete="off" />`;
  }
  const n = Number(value);
  return `<input type="text" id="tt_cell_${d}_${p}" class="tt-cell-input"
    value="${Number.isFinite(n) ? n : -1}" autocomplete="off" />`;
}

function renderGridUI(days, periods, grid, lineMap = null) {
  let head = "<tr><th>Day</th>";
  for (let p = 0; p < periods; p++) head += `<th>Period ${p + 1}</th>`;
  $("ttGridHeader").innerHTML = head + "</tr>";

  let body = "";
  for (let d = 0; d < days; d++) {
    body += `<tr><td class="tt-day-label">Day ${d + 1}</td>`;
    for (let p = 0; p < periods; p++) {
      const value = grid[d] && grid[d][p] !== undefined ? grid[d][p] : blankOf(currentTarget);
      body += `<td>${isEditMode ? inputHtml(d, p, value) : cellHtml(value, lineMap)}</td>`;
    }
    body += "</tr>";
  }
  $("ttGridBody").innerHTML = body;
}

function readGridFromDOM(days, periods) {
  const text = currentTarget.mode === "class";
  const grid = [];
  for (let d = 0; d < days; d++) {
    const row = [];
    for (let p = 0; p < periods; p++) {
      const val = ($(`tt_cell_${d}_${p}`)?.value ?? "").trim();
      row.push(text ? val : val === "" ? -1 : Number(val));
    }
    grid.push(row);
  }
  return grid;
}

function validateInputs(days, periods) {
  if (currentTarget.mode === "class") return { isValid: true, errorMsg: "" };
  let isValid = true;
  let errorMsg = "";
  for (let d = 0; d < days; d++) {
    for (let p = 0; p < periods; p++) {
      const input = $(`tt_cell_${d}_${p}`);
      if (!input) continue;
      input.classList.remove("invalid-cell");
      const val = input.value.trim();
      if (val === "") continue;
      const num = Number(val);
      const bad =
        !Number.isInteger(num) || (num !== -1 && (num < 1 || num > MAX_LINE));
      if (bad) {
        input.classList.add("invalid-cell");
        isValid = false;
        if (!errorMsg) {
          errorMsg = `Day ${d + 1}, Period ${p + 1}: use -1 (free) or a line from 1 to ${MAX_LINE}.`;
        }
      }
    }
  }
  return { isValid, errorMsg };
}

/* ---------- modal ---------- */
async function openModal(target, student, canEdit) {
  const mine = ++openSeq;
  currentTarget = target;
  currentStudent = student;
  currentTimetableData = null;
  canEditNow = canEdit;
  isEditMode = false;

  const gradeMode = !student;
  const gradeSel = $("ttGradeSelect");
  const classSel = $("ttClassSelect");

  gradeSel?.classList.toggle("is-hidden", !gradeMode);
  if (gradeSel && gradeMode) gradeSel.value = String(target.grade);

  const showClass = gradeMode && target.mode === "class";
  classSel?.classList.toggle("is-hidden", !showClass);
  if (classSel && showClass) {
    const classes = getClasses(target.grade);
    classSel.innerHTML = classes.length
      ? classes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")
      : `<option value="">No classes found</option>`;
    classSel.value = target.className;
  }

  $("ttModalTitle").textContent =
    target.mode === "class"
      ? `Grade ${target.grade} · Class ${target.className || "—"} Timetable`
      : `Grade ${target.grade} Timetable`;
  $("ttModalSubtitle").textContent = student
    ? `Student: ${student.fullName || student.adminNo} (${clsOf(student)})`
    : target.mode === "class"
      ? "Class timetable · type the subject, or Subject | Teacher"
      : "All students · cells show subject line numbers (-1 = free period)";

  const noticeEl = $("ttStatusNotice");
  noticeEl.classList.add("is-hidden");
  $("ttStaffToolbar").classList.add("is-hidden");
  $("ttCancelEditBtn").classList.add("is-hidden");
  $("ttSaveBtn").classList.add("is-hidden");
  $("ttEditBtn").classList.toggle("is-hidden", !canEdit || !target.docId);
  $("timetableModal").classList.remove("is-hidden");

  const metaEl = $("ttMetaInfo");
  try {
    const data = await getTimetable(target);
    if (mine !== openSeq) return; // a newer open superseded this one
    currentTimetableData = data;
    renderGridUI(data.days, data.periods, data.grid, currentLineMap());
    if (!target.docId) {
      metaEl.textContent = student
        ? "This student has no registration class on file."
        : "Choose a class.";
    } else {
      metaEl.textContent =
        data.existsInDb && data.updatedAt
          ? `${labelOf(target)} · Last updated ${new Date(data.updatedAt).toLocaleDateString()}`
          : `No timetable saved yet for ${labelOf(target)}.`;
    }
  } catch (err) {
    if (mine !== openSeq) return;
    console.error("Error opening timetable modal:", err);
    noticeEl.className = "tt-status-notice error";
    noticeEl.textContent = `Error loading timetable: ${err.message}`;
    noticeEl.classList.remove("is-hidden");
  }
}

export const openStudentTimetableModal = (student, { canEdit = false } = {}) =>
  openModal(makeTarget(student.grade, clsOf(student)), student, canEdit);

export const openGradeTimetableModal = (grade, { canEdit = false } = {}) => {
  const first = isClassGrade(grade) ? getClasses(grade)[0] || "" : "";
  return openModal(makeTarget(grade, first), null, canEdit);
};

/* ---------- wiring ---------- */
export function initTimetableModule(opts = {}) {
  if (typeof opts.getClasses === "function") getClasses = opts.getClasses;

  const modal = $("timetableModal");
  const editBtn = $("ttEditBtn");
  const cancelEditBtn = $("ttCancelEditBtn");
  const saveBtn = $("ttSaveBtn");
  const staffToolbar = $("ttStaffToolbar");
  const noticeEl = $("ttStatusNotice");
  const gradeSel = $("ttGradeSelect");
  const classSel = $("ttClassSelect");

  const closeModal = () => {
    modal.classList.add("is-hidden");
    noticeEl.classList.add("is-hidden");
    isEditMode = false;
  };
  $("closeTimetableModalBtn")?.addEventListener("click", closeModal);
  $("ttCloseBtn")?.addEventListener("click", closeModal);
  $("timetableModalScrim")?.addEventListener("click", closeModal);

  const okToLeave = () =>
    !isEditMode || confirm("Discard your unsaved timetable changes?");

  gradeSel?.addEventListener("change", () => {
    if (!okToLeave()) { gradeSel.value = String(currentTarget.grade); return; }
    const g = gradeSel.value;
    const first = isClassGrade(g) ? getClasses(g)[0] || "" : "";
    openModal(makeTarget(g, first), null, canEditNow);
  });
  classSel?.addEventListener("change", () => {
    if (!okToLeave()) { classSel.value = currentTarget.className; return; }
    openModal(makeTarget(currentTarget.grade, classSel.value), null, canEditNow);
  });

  const leaveEdit = () => {
    isEditMode = false;
    staffToolbar.classList.add("is-hidden");
    editBtn.classList.remove("is-hidden");
    cancelEditBtn.classList.add("is-hidden");
    saveBtn.classList.add("is-hidden");
  };
  const showView = () =>
    renderGridUI(
      currentTimetableData.days, currentTimetableData.periods,
      currentTimetableData.grid, currentLineMap(),
    );

  editBtn?.addEventListener("click", () => {
    if (!currentTimetableData || !currentTarget?.docId) return;
    isEditMode = true;
    editDays = currentTimetableData.days;
    editPeriods = currentTimetableData.periods;
    editGrid = JSON.parse(JSON.stringify(currentTimetableData.grid));

    const badge = $("ttEditBadge");
    if (badge) {
      badge.textContent =
        currentTarget.mode === "class"
          ? `Editing ${labelOf(currentTarget)} · Subject | Teacher`
          : `Editing line numbers · ${labelOf(currentTarget)}`;
    }
    staffToolbar.classList.remove("is-hidden");
    editBtn.classList.add("is-hidden");
    cancelEditBtn.classList.remove("is-hidden");
    saveBtn.classList.remove("is-hidden");
    renderGridUI(editDays, editPeriods, editGrid);
  });

  cancelEditBtn?.addEventListener("click", () => {
    leaveEdit();
    noticeEl.classList.add("is-hidden");
    showView();
  });

  const resize = (fn) => {
    editGrid = readGridFromDOM(editDays, editPeriods);
    fn();
    renderGridUI(editDays, editPeriods, editGrid);
  };
  $("ttAddDayBtn")?.addEventListener("click", () =>
    resize(() => { editGrid.push(Array(editPeriods).fill(blankOf(currentTarget))); editDays++; }));
  $("ttRemoveDayBtn")?.addEventListener("click", () => {
    if (editDays <= 1) return alert("Must have at least 1 day.");
    resize(() => { editGrid.pop(); editDays--; });
  });
  $("ttAddPeriodBtn")?.addEventListener("click", () =>
    resize(() => { editGrid.forEach((r) => r.push(blankOf(currentTarget))); editPeriods++; }));
  $("ttRemovePeriodBtn")?.addEventListener("click", () => {
    if (editPeriods <= 1) return alert("Must have at least 1 period.");
    resize(() => { editGrid.forEach((r) => r.pop()); editPeriods--; });
  });

  saveBtn?.addEventListener("click", async () => {
    const { isValid, errorMsg } = validateInputs(editDays, editPeriods);
    if (!isValid) {
      noticeEl.className = "tt-status-notice error";
      noticeEl.textContent = errorMsg;
      noticeEl.classList.remove("is-hidden");
      return;
    }
    const finalGrid = readGridFromDOM(editDays, editPeriods);
    try {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      currentTimetableData = await saveTimetable(currentTarget, editDays, editPeriods, finalGrid);
      noticeEl.className = "tt-status-notice success";
      noticeEl.textContent = `${labelOf(currentTarget)} timetable saved.`;
      noticeEl.classList.remove("is-hidden");
      leaveEdit();
      showView();
    } catch (err) {
      console.error("Save error:", err);
      noticeEl.className = "tt-status-notice error";
      noticeEl.textContent = `Save failed: ${err.message}`;
      noticeEl.classList.remove("is-hidden");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  });
}