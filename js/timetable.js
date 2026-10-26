/**
 * js/timetable.js
 * Streamlined Timetable Module (Delegates security checks to Firestore Rules)
 */

import { db, doc, getDoc, setDoc, auth } from "./firebase-init.js";
import { escapeHtml } from "./html.js";
let currentGrade = null;
let canEditNow = false;

const DEFAULT_DAYS = 5;
const DEFAULT_PERIODS = 6;


let currentStudent = null;
let currentTimetableData = null;
let isEditMode = false;
let editDays = DEFAULT_DAYS;
let editPeriods = DEFAULT_PERIODS;
let editGrid = [];

function createBlankGrid(days, periods) {
  return Array.from({ length: days }, () => Array(periods).fill(-1));
}

function deserializeGrid(rawGrid, days, periods) {
  if (!rawGrid || !Array.isArray(rawGrid))
    return createBlankGrid(days, periods);
  return rawGrid.map((row) => {
    if (Array.isArray(row)) return row;
    if (row && Array.isArray(row.periods)) return row.periods;
    return Array(periods).fill(-1);
  });
}

function serializeGrid(grid2D) {
  return grid2D.map((row) => ({
    periods: Array.isArray(row) ? row : [],
  }));
}

export async function getTimetableForGrade(grade) {
  const docRef = doc(db, "timetables", `grade${grade}`);
  const snap = await getDoc(docRef);

  if (snap.exists()) {
    const data = snap.data();
    const days = Number(data.days || DEFAULT_DAYS);
    const periods = Number(data.periods || DEFAULT_PERIODS);
    const grid = deserializeGrid(data.grid, days, periods);

    return {
      grade: Number(data.grade || grade),
      days,
      periods,
      grid,
      updatedAt: data.updatedAt || null,
      updatedBy: data.updatedBy || null,
      existsInDb: true,
    };
  }

  return {
    grade: Number(grade),
    days: DEFAULT_DAYS,
    periods: DEFAULT_PERIODS,
    grid: createBlankGrid(DEFAULT_DAYS, DEFAULT_PERIODS),
    updatedAt: null,
    updatedBy: null,
    existsInDb: false,
  };
}

export async function saveTimetableForGrade(grade, days, periods, grid2D) {
  const user = auth.currentUser;
  const userEmail = user ? user.email : "staff@hhs.co.za";
  const firestoreGrid = serializeGrid(grid2D);

  const payload = {
    grade: Number(grade),
    days: Number(days),
    periods: Number(periods),
    grid: firestoreGrid,
    updatedAt: new Date().toISOString(),
    updatedBy: userEmail,
  };

  const docRef = doc(db, "timetables", `grade${grade}`);
  await setDoc(docRef, payload, { merge: true });

  return {
    grade: Number(grade),
    days: Number(days),
    periods: Number(periods),
    grid: grid2D,
    updatedAt: payload.updatedAt,
    updatedBy: payload.updatedBy,
  };
}

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
  currentStudent ? buildLineToSubjectMap(currentStudent) : null;

function renderGridUI(days, periods, grid, lineMap = null) {
  const header = document.getElementById("ttGridHeader");
  const body = document.getElementById("ttGridBody");

  let headerHtml = "<tr><th>Day</th>";
  for (let p = 0; p < periods; p++) {
    headerHtml += `<th>Period ${p + 1}</th>`;
  }
  headerHtml += "</tr>";
  header.innerHTML = headerHtml;

  let bodyHtml = "";
  for (let d = 0; d < days; d++) {
    bodyHtml += `<tr><td class="tt-day-label">Day ${d + 1}</td>`;
    for (let p = 0; p < periods; p++) {
      const lineVal =
        grid[d] && grid[d][p] !== undefined ? Number(grid[d][p]) : -1;

      if (isEditMode) {
        bodyHtml += `
          <td>
            <input 
              type="text" 
              id="tt_cell_${d}_${p}" 
              class="tt-cell-input" 
              value="${lineVal}" 
              autocomplete="off"
            />
          </td>`;
      } else {
        let displayHtml = "";
        if (lineVal === -1) {
          displayHtml = `<span class="tt-badge-none">-</span>`;
        } else if (!lineMap) {
          displayHtml = `<span class="tt-badge-subject">Line ${lineVal}</span>`;
        } else if (lineMap[lineVal]) {
          const { subject, teacher } = lineMap[lineVal];
          displayHtml =
            `<span class="tt-badge-subject">${escapeHtml(subject)}</span>` +
            (teacher
              ? `<span class="tt-teacher">${escapeHtml(teacher)}</span>`
              : "");
        } else {
          displayHtml = `<span class="tt-badge-not-enrolled">Not Enrolled</span>`;
        }
      }
    }
    bodyHtml += "</tr>";
  }
  body.innerHTML = bodyHtml;
}

function readGridFromDOM(days, periods) {
  const grid = [];
  for (let d = 0; d < days; d++) {
    const row = [];
    for (let p = 0; p < periods; p++) {
      const input = document.getElementById(`tt_cell_${d}_${p}`);
      const val = input ? input.value.trim() : "";
      row.push(val === "" ? -1 : Number(val));
    }
    grid.push(row);
  }
  return grid;
}

function validateInputs(days, periods) {
  let isValid = true;
  let errorMsg = "";

  for (let d = 0; d < days; d++) {
    for (let p = 0; p < periods; p++) {
      const input = document.getElementById(`tt_cell_${d}_${p}`);
      if (!input) continue;

      const val = input.value.trim();
      input.classList.remove("invalid-cell");

      if (val === "") continue;

      const num = Number(val);
      if (isNaN(val) || !Number.isInteger(num)) {
        input.classList.add("invalid-cell");
        isValid = false;
        if (!errorMsg) {
          errorMsg = `Invalid line "${val}" at Day ${d + 1}, Period ${p + 1}. Integers only.`;
        }
      }
    }
  }
  return { isValid, errorMsg };
}

/**
 * Open Timetable Modal
 * Visibility of #ttEditBtn is controlled by app.js before opening
 */
async function openModal(grade, student, canEdit) {
  currentStudent = student;
  currentGrade = Number(grade);
  canEditNow = canEdit;
  isEditMode = false;
  const $ = (id) => document.getElementById(id);
  const gradeSel = $("ttGradeSelect");

  $("ttModalTitle").textContent = `Grade ${grade} Timetable`;
  $("ttModalSubtitle").textContent = student
    ? `Student: ${student.fullName || student.adminNo} (${student.registrationClass || ""})`
    : "All students · cells show subject line numbers (-1 = free period)";
  gradeSel?.classList.toggle("is-hidden", Boolean(student));
  if (gradeSel && !student) gradeSel.value = String(grade);

  $("ttStatusNotice").classList.add("is-hidden");
  $("ttStaffToolbar").classList.add("is-hidden");
  $("ttCancelEditBtn").classList.add("is-hidden");
  $("ttSaveBtn").classList.add("is-hidden");
  $("ttEditBtn").classList.toggle("is-hidden", !canEdit);
  $("timetableModal").classList.remove("is-hidden");

  const metaEl = $("ttMetaInfo"),
    noticeEl = $("ttStatusNotice");
  try {
    currentTimetableData = await getTimetableForGrade(grade);
    renderGridUI(
      currentTimetableData.days,
      currentTimetableData.periods,
      currentTimetableData.grid,
      currentLineMap(),
    );
    metaEl.textContent =
      currentTimetableData.existsInDb && currentTimetableData.updatedAt
        ? `Grade ${grade} schedule · Last updated ${new Date(currentTimetableData.updatedAt).toLocaleDateString()}`
        : `No timetable saved yet for Grade ${grade}.`;
  } catch (err) {
    console.error("Error opening timetable modal:", err);
    noticeEl.className = "tt-status-notice error";
    noticeEl.textContent = `Error loading timetable: ${err.message}`;
    noticeEl.classList.remove("is-hidden");
  }
}

export const openStudentTimetableModal = (student, { canEdit = false } = {}) =>
  openModal(student.grade, student, canEdit);
export const openGradeTimetableModal = (grade, { canEdit = false } = {}) =>
  openModal(grade, null, canEdit);

/**
 * Simplified Init Module
 */
export function initTimetableModule() {
  const modal = document.getElementById("timetableModal");
  const scrim = document.getElementById("timetableModalScrim");
  const closeBtn = document.getElementById("closeTimetableModalBtn");
  const ttCloseBtn = document.getElementById("ttCloseBtn");

  const editBtn = document.getElementById("ttEditBtn");
  const cancelEditBtn = document.getElementById("ttCancelEditBtn");
  const saveBtn = document.getElementById("ttSaveBtn");
  const staffToolbar = document.getElementById("ttStaffToolbar");
  const noticeEl = document.getElementById("ttStatusNotice");

  const addDayBtn = document.getElementById("ttAddDayBtn");
  const removeDayBtn = document.getElementById("ttRemoveDayBtn");
  const addPeriodBtn = document.getElementById("ttAddPeriodBtn");
  const removePeriodBtn = document.getElementById("ttRemovePeriodBtn");
  const gradeSel = document.getElementById("ttGradeSelect");
gradeSel?.addEventListener("change", () => openModal(gradeSel.value, null, canEditNow));

  const closeModal = () => {
    modal.classList.add("is-hidden");
    noticeEl.classList.add("is-hidden");
    isEditMode = false;
  };

  closeBtn?.addEventListener("click", closeModal);
  ttCloseBtn?.addEventListener("click", closeModal);
  scrim?.addEventListener("click", closeModal);

  editBtn?.addEventListener("click", () => {
    isEditMode = true;
    editDays = currentTimetableData.days;
    editPeriods = currentTimetableData.periods;
    editGrid = JSON.parse(JSON.stringify(currentTimetableData.grid));

    staffToolbar.classList.remove("is-hidden");
    editBtn.classList.add("is-hidden");
    cancelEditBtn.classList.remove("is-hidden");
    saveBtn.classList.remove("is-hidden");

    renderGridUI(editDays, editPeriods, editGrid);
  });

  cancelEditBtn?.addEventListener("click", () => {
    isEditMode = false;
    staffToolbar.classList.add("is-hidden");
    editBtn.classList.remove("is-hidden");
    cancelEditBtn.classList.add("is-hidden");
    saveBtn.classList.add("is-hidden");
    noticeEl.classList.add("is-hidden");

    const lineMap = currentLineMap();
    renderGridUI(
      currentTimetableData.days,
      currentTimetableData.periods,
      currentTimetableData.grid,
      lineMap,
    );
  });

  addDayBtn?.addEventListener("click", () => {
    editGrid = readGridFromDOM(editDays, editPeriods);
    editGrid.push(Array(editPeriods).fill(-1));
    editDays++;
    renderGridUI(editDays, editPeriods, editGrid);
  });

  removeDayBtn?.addEventListener("click", () => {
    if (editDays <= 1) return alert("Must have at least 1 day.");
    editGrid = readGridFromDOM(editDays, editPeriods);
    editGrid.pop();
    editDays--;
    renderGridUI(editDays, editPeriods, editGrid);
  });

  addPeriodBtn?.addEventListener("click", () => {
    editGrid = readGridFromDOM(editDays, editPeriods);
    editGrid.forEach((row) => row.push(-1));
    editPeriods++;
    renderGridUI(editDays, editPeriods, editGrid);
  });

  removePeriodBtn?.addEventListener("click", () => {
    if (editPeriods <= 1) return alert("Must have at least 1 period.");
    editGrid = readGridFromDOM(editDays, editPeriods);
    editGrid.forEach((row) => row.pop());
    editPeriods--;
    renderGridUI(editDays, editPeriods, editGrid);
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

      const saved = await saveTimetableForGrade(
        currentStudent.grade,
        editDays,
        editPeriods,
        finalGrid,
      );
      currentTimetableData = { ...saved, existsInDb: true };

      noticeEl.className = "tt-status-notice success";
      noticeEl.textContent = `Grade ${currentStudent.grade} timetable saved successfully!`;
      noticeEl.classList.remove("is-hidden");

      isEditMode = false;
      staffToolbar.classList.add("is-hidden");
      editBtn.classList.remove("is-hidden");
      cancelEditBtn.classList.add("is-hidden");
      saveBtn.classList.add("is-hidden");

      const lineMap = currentLineMap;
      renderGridUI(
        currentTimetableData.days,
        currentTimetableData.periods,
        currentTimetableData.grid,
        lineMap,
      );
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
