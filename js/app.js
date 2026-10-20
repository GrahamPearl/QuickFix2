/**
 * app.js — wires data-service, search, and render together.
 */

import {
  db,
  doc,
  updateDoc,
  setDoc,
  writeBatch,
  collection,
  getDocs,
  auth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "./firebase-init.js";

import {
  getAllStudents,
  collectSubjects,
  collectClasses,
} from "./data-service.js";

import { filterStudents, sortStudents } from "./search.js";

import {
  renderRows,
  renderCards,
  renderEmptyCards,
  renderResultCount,
  renderEmptyState,
  renderDrawerHeader,
  renderDrawerView,
  renderDrawerEdit,
  renderAddStudentForm,
  renderBulkUpdateModal,
  renderTeamRow, // <--- CRITICAL IMPORT FIX
} from "./render.js";

const els = {
  form: document.getElementById("searchForm"),
  query: document.getElementById("query"),
  field: document.getElementById("field"),
  grade: document.getElementById("filterGrade"),
  class: document.getElementById("filterClass"),
  gender: document.getElementById("filterGender"),
  subject: document.getElementById("filterSubject"),
  line: document.getElementById("filterLine"),
  teacher: document.getElementById("filterTeacher"),
  resetBtn: document.getElementById("resetBtn"),
  tbody: document.getElementById("resultsBody"),
  resultCount: document.getElementById("resultCount"),
  loadingState: document.getElementById("loadingState"),
  tableWrap: document.getElementById("tableWrap"),
  drawer: document.getElementById("drawer"),
  drawerHeader: document.getElementById("drawerHeader"),
  drawerContent: document.getElementById("drawerContent"),
  drawerClose: document.getElementById("drawerClose"),
  scrim: document.getElementById("scrim"),
  authWidget: document.getElementById("authWidget"),
  authToggleBtn: document.getElementById("authToggleBtn"),
  authPopover: document.getElementById("authPopover"),

  openFiltersBtn: document.getElementById("openFiltersBtn"),
  filterModal: document.getElementById("filterModal"),
  filterModalClose: document.getElementById("filterModalClose"),
  filterApplyBtn: document.getElementById("filterApplyBtn"),
  filterClearBtn: document.getElementById("filterClearBtn"),
  filterCountBadge: document.getElementById("filterCountBadge"),
  team: document.getElementById("filterTeam"),
  ageGroup: document.getElementById("filterAgeGroup"),

  cardsWrap: document.getElementById("cardsWrap"),
  resultsGrid: document.getElementById("resultsGrid"),
  layoutBtns: document.querySelectorAll(".layout-btn"),
  printCardsBtn: document.getElementById("printCardsBtn"),
  addStudentModalBtn: document.getElementById("addStudentModalBtn"),
  openBulkUpdateBtn: document.getElementById("openBulkUpdateBtn"),

  authForm: document.getElementById("authForm"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  adminBadge: document.getElementById("adminBadge"),
  signOutBtn: document.getElementById("signOutBtn"),
};

const state = () => ({
  term: els.query.value,
  field: els.field.value,
  grade: els.grade.value,
  class: els.class.value,
  gender: els.gender.value,
  subject: els.subject.value,
  line: els.line.value,
  teacher: els.teacher.value,
  team: els.team ? els.team.value : "",
  ageGroup: els.ageGroup ? els.ageGroup.value : "",
});

const COL_COUNT = 6;
let currentLayout = "list";
let roster = [];
let isAdmin = false;
let currentEditingStudent = null;
let newStudentDraft = {};
let currentTeamsStudentAdminNo = null;
let allAvailableTeams = [];

function runSearch() {
  let results = sortStudents(filterStudents(roster, state()));

  const selectedLine = els.line ? els.line.value : "";
  if (selectedLine) {
    results = results.filter((student) => {
      if (!student.enrollments) return false;
      return Object.values(student.enrollments).some(
        (enr) => String(enr.line) === String(selectedLine),
      );
    });
  }

  renderResultCount(els.resultCount, results.length, roster.length);

  if (results.length === 0) {
    if (currentLayout === "list") {
      renderEmptyState(els.tbody, COL_COUNT);
    } else {
      renderEmptyCards(els.resultsGrid);
    }
    return;
  }

  if (currentLayout === "list") {
    renderRows(els.tbody, results);
  } else {
    renderCards(els.resultsGrid, results);
  }
}

async function loadAvailableTeams() {
  try {
    const snapshot = await getDocs(collection(db, "teams"));
    allAvailableTeams = snapshot.docs.map((doc) => {
      const data = doc.data();
      let teamName = data.teamName || doc.id;

      // Clean fallback if legacy "||" string is retrieved
      if (teamName.includes("||")) {
        teamName = teamName.split("||")[0].trim();
      }

      return {
        id: doc.id,
        teamName: teamName,
        ageGroups: data.ageGroups || {},
        ...data,
      };
    });

    // --- ADD THIS CALL TO POPULATE THE FILTER SELECT ---
    populateTeamFilterOptions();
  } catch (err) {
    console.error("Failed to load teams list from Firestore:", err);
  }
}

function populateTeamFilterOptions() {
  if (!els.team) return;
  const teamNames = allAvailableTeams.map((t) => t.teamName).sort();
  populateSelect(els.team, teamNames, "All teams");
}

function refreshAgeGroupOptions() {
  if (!els.team || !els.ageGroup) return;

  const selectedTeamName = els.team.value;
  if (!selectedTeamName) {
    els.ageGroup.innerHTML = '<option value="">Select a team first</option>';
    els.ageGroup.value = "";
    els.ageGroup.disabled = true;
    return;
  }

  const teamObj = allAvailableTeams.find(
    (t) => t.teamName === selectedTeamName || t.id === selectedTeamName
  );

  let groups = [];
  if (teamObj && teamObj.ageGroups) {
    groups = Object.keys(teamObj.ageGroups);
  }

  if (groups.length === 0) {
    groups = ["U14", "U15", "U16", "U19", "Open", "Junior", "Senior"];
  }

  populateSelect(els.ageGroup, groups.sort(), "All age groups");
  els.ageGroup.disabled = false;
}

function collectLines(roster) {
  const lines = new Set();
  roster.forEach((student) => {
    if (student.enrollments) {
      Object.values(student.enrollments).forEach((enr) => {
        if (enr && enr.line !== undefined && enr.line !== "") {
          lines.add(Number(enr.line));
        }
      });
    }
  });
  return Array.from(lines).sort((a, b) => a - b);
}

function populateSelect(select, values, placeholder) {
  const current = select.value;
  select.innerHTML =
    `<option value="">${placeholder}</option>` +
    values.map((v) => `<option value="${v}">${v}</option>`).join("");
  if (values.includes(current)) select.value = current;
}

function getTeachersPerSubjectMap() {
  const map = {};
  roster.forEach((student) => {
    if (student.enrollments) {
      Object.entries(student.enrollments).forEach(([subKey, enr]) => {
        if (enr && enr.teacher) {
          const subName = enr.subject || subKey;
          if (!map[subName]) map[subName] = new Set();
          map[subName].add(enr.teacher);
        }
      });
    }
  });
  Object.keys(map).forEach((sub) => {
    map[sub] = Array.from(map[sub]).sort();
  });
  return map;
}

function refreshClassOptions() {
  populateSelect(
    els.class,
    collectClasses(roster, els.grade.value),
    "All classes",
  );
}

function refreshTeacherOptions() {
  const selectedSubject = els.subject.value;

  if (!selectedSubject) {
    els.teacher.innerHTML = '<option value="">Select a subject first</option>';
    els.teacher.value = "";
    els.teacher.disabled = true;
    return;
  }

  const subjectKey = selectedSubject.toLowerCase().replace(/[^a-z0-9]/g, "");
  const teachers = new Set();

  roster.forEach((student) => {
    if (student.enrollments) {
      const enr =
        student.enrollments[subjectKey] || student.enrollments[selectedSubject];
      if (enr && enr.teacher) {
        teachers.add(enr.teacher);
      }
    }
  });

  const teacherArray = Array.from(teachers).filter(Boolean).sort();
  populateSelect(els.teacher, teacherArray, "All teachers");
  els.teacher.disabled = teacherArray.length === 0;
}

function openDrawer(adminNo) {
  const student = roster.find((s) => String(s.adminNo) === String(adminNo));
  if (!student) return;

  els.drawer.dataset.activeAdminNo = adminNo;

  els.drawerHeader.innerHTML = renderDrawerHeader(student);
  els.drawerContent.innerHTML = renderDrawerView(student, isAdmin);

  els.drawer.classList.add("is-open");
  els.scrim.classList.add("is-visible");
  document.body.classList.add("no-scroll");
}

function closeDrawer() {
  els.drawer.classList.remove("is-open");
  els.scrim.classList.remove("is-visible");
  document.body.classList.remove("no-scroll");
}

function openStudentTeamsModal(adminNo) {
  const student = roster.find((s) => String(s.adminNo) === String(adminNo));
  if (!student) return;

  currentTeamsStudentAdminNo = adminNo;

  const subtitleEl = document.getElementById("teamsModalSubtitle");
  if (subtitleEl) {
    const displayName = student.fullName || `${student.firstName || ""} ${student.lastName || ""}`.trim();
    subtitleEl.textContent = `Student: ${displayName} (${adminNo})`;
  }

  const container = document.getElementById("teamsListContainer");
  const studentTeams = student.teams || [];

  if (container) {
    if (studentTeams.length === 0) {
      container.innerHTML = renderTeamRow({}, allAvailableTeams);
    } else {
      container.innerHTML = studentTeams
        .map((t) => renderTeamRow(t, allAvailableTeams))
        .join("");
    }
  }

  const modal = document.getElementById("studentTeamsModal");
  if (modal) modal.classList.remove("is-hidden");
}

function closeStudentTeamsModal() {
  const modal = document.getElementById("studentTeamsModal");
  if (modal) modal.classList.add("is-hidden");
  const errorEl = document.getElementById("teamsModalError");
  if (errorEl) errorEl.textContent = "";
  currentTeamsStudentAdminNo = null;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wireEvents() {
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch();
  });
  els.query.addEventListener("input", debounce(runSearch, 150));
  els.field.addEventListener("change", runSearch);
  els.gender.addEventListener("change", runSearch);

  els.subject.addEventListener("change", () => {
    refreshTeacherOptions();
    runSearch();
  });

  els.line.addEventListener("change", runSearch);
  els.teacher.addEventListener("change", runSearch);

  els.grade.addEventListener("change", () => {
    refreshClassOptions();
    runSearch();
  });
  els.class.addEventListener("change", runSearch);

  els.resetBtn.addEventListener("click", () => {
    els.form.reset();
    refreshClassOptions();
    refreshTeacherOptions();
    runSearch();
  });

  els.tbody.addEventListener("click", (e) => {
    const row = e.target.closest(".roster-row");
    if (row) openDrawer(row.dataset.adminNo);
  });
  els.drawerClose.addEventListener("click", closeDrawer);
  els.scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  if (els.authToggleBtn && els.authPopover) {
    els.authToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.authPopover.classList.toggle("is-hidden");
    });

    document.addEventListener("click", (e) => {
      if (els.authWidget && !els.authWidget.contains(e.target)) {
        els.authPopover.classList.add("is-hidden");
      }
    });
  }

  els.openFiltersBtn.addEventListener("click", () => {
    els.filterModal.classList.toggle("is-hidden");
  });

  els.filterModalClose.addEventListener("click", () => {
    els.filterModal.classList.add("is-hidden");
  });

  els.filterApplyBtn.addEventListener("click", () => {
    els.filterModal.classList.add("is-hidden");
    runSearch();
  });

  els.filterClearBtn.addEventListener("click", () => {
    els.grade.value = "";
    els.class.value = "";
    els.gender.value = "";
    els.subject.value = "";
    if (els.teacher) {
      els.teacher.value = "";
      els.teacher.disabled = true;
      els.teacher.innerHTML =
        '<option value="">Select a subject first</option>';
    }
    if (els.line) {
      els.line.value = "";
    }
    refreshClassOptions();
    runSearch();
  });

  els.layoutBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.layoutBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      currentLayout = btn.dataset.layout;

      if (currentLayout === "list") {
        els.tableWrap.classList.remove("is-hidden");
        els.cardsWrap.classList.add("is-hidden");
        els.printCardsBtn.classList.add("is-hidden");
      } else {
        els.tableWrap.classList.add("is-hidden");
        els.cardsWrap.classList.remove("is-hidden");
        els.printCardsBtn.classList.remove("is-hidden");

        els.resultsGrid.className = `results-grid ${currentLayout === "grid4" ? "grid-cols-4" : "grid-cols-2"}`;
      }

      runSearch();
    });
  });

  els.printCardsBtn.addEventListener("click", async () => {
    const images = els.resultsGrid.querySelectorAll("img");

    if (images.length === 0) {
      window.print();
      return;
    }

    els.printCardsBtn.textContent = "Preparing PDF...";
    els.printCardsBtn.disabled = true;

    const imageLoadPromises = Array.from(images).map((img) => {
      img.loading = "eager";

      if (img.complete && img.naturalHeight !== 0) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    });

    await Promise.all(imageLoadPromises);

    els.printCardsBtn.textContent = "Print / Export PDF";
    els.printCardsBtn.disabled = false;

    window.print();
  });

  // Combined Drawer Content Click Handler (Edit Student AND Manage Teams)
  els.drawerContent.addEventListener("click", (e) => {
    if (e.target.id === "editStudentBtn" || e.target.closest("#editStudentBtn")) {
      const adminNo = els.drawer.dataset.activeAdminNo;
      const student = roster.find((s) => String(s.adminNo) === String(adminNo));
      if (!student) return;

      currentEditingStudent = { ...student };

      const allSubjects = collectSubjects(roster);
      const teacherMap = getTeachersPerSubjectMap();
      els.drawerContent.innerHTML = renderDrawerEdit(
        currentEditingStudent,
        allSubjects,
        teacherMap,
      );
    }

    if (e.target.id === "openTeamsModalBtn" || e.target.closest("#openTeamsModalBtn")) {
      const adminNo = els.drawer.dataset.activeAdminNo;
      if (adminNo) {
        openStudentTeamsModal(adminNo);
      }
    }

    if (e.target.id === "cancelEditBtn") {
      const student = roster.find(
        (s) => String(s.adminNo) === String(currentEditingStudent.adminNo),
      );
      els.drawerContent.innerHTML = renderDrawerView(student, isAdmin);
    }

    if (e.target.matches("[data-remove-subject]")) {
      const subToRemove = e.target.getAttribute("data-remove-subject");
      currentEditingStudent.subjectsSummary =
        currentEditingStudent.subjectsSummary.filter((s) => s !== subToRemove);

      const subKey = subToRemove.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (currentEditingStudent.enrollments) {
        delete currentEditingStudent.enrollments[subKey];
      }

      const allSubjects = collectSubjects(roster);
      const teacherMap = getTeachersPerSubjectMap();
      els.drawerContent.innerHTML = renderDrawerEdit(
        currentEditingStudent,
        allSubjects,
        teacherMap,
      );
    }

    if (e.target.id === "addSubjectBtn") {
      const select = document.getElementById("addSubjectSelect");
      const chosenSub = select.value;
      if (
        chosenSub &&
        !currentEditingStudent.subjectsSummary.includes(chosenSub)
      ) {
        currentEditingStudent.subjectsSummary.push(chosenSub);

        const subKey = chosenSub.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!currentEditingStudent.enrollments)
          currentEditingStudent.enrollments = {};
        currentEditingStudent.enrollments[subKey] = {
          teacher: "",
          line: currentEditingStudent.subjectsSummary.length,
        };

        const allSubjects = collectSubjects(roster);
        const teacherMap = getTeachersPerSubjectMap();
        els.drawerContent.innerHTML = renderDrawerEdit(
          currentEditingStudent,
          allSubjects,
          teacherMap,
        );
      }
    }
  });

  // Drawer Form Edit Submission
  els.drawerContent.addEventListener("submit", async (e) => {
    if (e.target.id === "editForm") {
      e.preventDefault();

      if (!isAdmin) {
        alert("Unauthorized: You must be signed in as staff to edit students.");
        return;
      }

      const inputs = els.drawerContent.querySelectorAll("[data-field]");
      inputs.forEach((input) => {
        const field = input.getAttribute("data-field");
        currentEditingStudent[field] = input.value;
      });

      const adminNo = String(currentEditingStudent.adminNo).trim();

      if (!adminNo) {
        alert("Error: Student has no Admin Number. Cannot save to database.");
        return;
      }

      try {
        const studentRef = doc(db, "students", adminNo);

        await updateDoc(studentRef, {
          firstName: currentEditingStudent.firstName || "",
          lastName: currentEditingStudent.lastName || "",
          fullName: currentEditingStudent.fullName || "",
          grade: currentEditingStudent.grade,
          registrationClass: currentEditingStudent.registrationClass,
          gender: currentEditingStudent.gender,
          enrollments: currentEditingStudent.enrollments || {},
        });

        const index = roster.findIndex((s) => String(s.adminNo) === adminNo);
        if (index !== -1) {
          roster[index] = currentEditingStudent;
        }

        els.drawerContent.innerHTML = renderDrawerView(
          currentEditingStudent,
          isAdmin,
        );
        runSearch();

        console.log(`Student ${adminNo} successfully updated in Firestore!`);
      } catch (err) {
        console.error("Failed to update student in Firestore:", err);
        alert(
          "Failed to save changes to the database. Check console for details.",
        );
      }
    }
  });

  // Teams Modal Handlers
  document.getElementById("addTeamRowBtn")?.addEventListener("click", () => {
    const container = document.getElementById("teamsListContainer");
    if (container) {
      container.insertAdjacentHTML("beforeend", renderTeamRow({}, allAvailableTeams));
    }
  });

  document.getElementById("teamsListContainer")?.addEventListener("change", (e) => {
  if (e.target.classList.contains("team-select")) {
    const selectedTeamName = e.target.value;
    const row = e.target.closest(".team-edit-row");
    const groupSelect = row ? row.querySelector(".team-group-select") : null;

    if (groupSelect) {
      const selectedTeamObj = allAvailableTeams.find(
        (t) => t.teamName === selectedTeamName || t.id === selectedTeamName
      );

      let ageGroups = [];
      if (selectedTeamObj && selectedTeamObj.ageGroups) {
        ageGroups = Object.keys(selectedTeamObj.ageGroups);
      }

      if (ageGroups.length === 0) {
        ageGroups = ["No Age Group", "U14", "U15", "U16", "U19", "Open", "Junior", "Senior"];
      }

      groupSelect.innerHTML =
        '<option value="">Select Group...</option>' +
        ageGroups.map((g) => `<option value="${g}">${g}</option>`).join("");
    }
  }
});

  document.getElementById("closeTeamsModalBtn")?.addEventListener("click", closeStudentTeamsModal);
  document.getElementById("teamsModalCloseScrim")?.addEventListener("click", closeStudentTeamsModal);
  document.getElementById("cancelTeamsModalBtn")?.addEventListener("click", closeStudentTeamsModal);

  document.getElementById("studentTeamsForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!isAdmin) {
      alert("Unauthorized: Only authenticated staff can modify team memberships.");
      return;
    }

    const container = document.getElementById("teamsListContainer");
    const rows = container ? container.querySelectorAll(".team-edit-row") : [];
    const updatedTeams = [];

    rows.forEach((row) => {
      const teamName = row.querySelector(".team-select").value;
      const ageGroup = row.querySelector(".team-group-select").value;
      const role = row.querySelector(".student-role-select").value;

      if (teamName) {
        updatedTeams.push({ teamName, ageGroup, role });
      }
    });

    try {
      const studentRef = doc(db, "students", String(currentTeamsStudentAdminNo));

      await updateDoc(studentRef, {
        teams: updatedTeams,
      });

      const index = roster.findIndex(
        (s) => String(s.adminNo) === String(currentTeamsStudentAdminNo)
      );
      if (index !== -1) {
        roster[index].teams = updatedTeams;
      }

      closeStudentTeamsModal();
      runSearch();
      console.log(`Teams updated successfully for student ${currentTeamsStudentAdminNo}`);
    } catch (err) {
      console.error("Failed to update student teams:", err);
      const errorEl = document.getElementById("teamsModalError");
      if (errorEl) errorEl.textContent = `Failed to save: ${err.message}`;
    }
  });

  els.team.addEventListener("change", () => {
    refreshAgeGroupOptions();
    runSearch();
  });

  els.ageGroup.addEventListener("change", runSearch);

  // Update "Clear All" filter listener
  els.filterClearBtn.addEventListener("click", () => {
    els.grade.value = "";
    els.class.value = "";
    els.gender.value = "";
    els.subject.value = "";
    if (els.teacher) {
      els.teacher.value = "";
      els.teacher.disabled = true;
      els.teacher.innerHTML = '<option value="">Select a subject first</option>';
    }
    if (els.line) els.line.value = "";

    // Clear Team & Age Group
    if (els.team) els.team.value = "";
    if (els.ageGroup) {
      els.ageGroup.value = "";
      els.ageGroup.disabled = true;
      els.ageGroup.innerHTML = '<option value="">Select a team first</option>';
    }

    refreshClassOptions();
    runSearch();
  });
}

// Bulk Update Submission
document.addEventListener("submit", async (e) => {
  if (e.target.id === "bulkUpdateForm") {
    e.preventDefault();

    if (!isAdmin) {
      alert("Unauthorized: You must be signed in as staff to perform bulk updates.");
      return;
    }

    const targetField = document.getElementById("bulkTargetField").value;
    const matchVal = document
      .getElementById("bulkMatchValue")
      .value.trim()
      .toLowerCase();
    const newVal = document.getElementById("bulkNewValue").value.trim();
    const subjectScope = document.getElementById("bulkSubjectScope")?.value;
    const errorEl = document.getElementById("bulkUpdateError");

    const updatesToCommit = [];

    roster.forEach((student) => {
      let isUpdated = false;

      if (targetField === "registrationClass") {
        if (
          String(student.registrationClass || "")
            .trim()
            .toLowerCase() === matchVal
        ) {
          student.registrationClass = newVal;
          isUpdated = true;
        }
      } else if (targetField === "grade") {
        if (
          String(student.grade || "")
            .trim()
            .toLowerCase() === matchVal
        ) {
          const parsedVal = isNaN(newVal) ? newVal : Number(newVal);
          student.grade = parsedVal;
          isUpdated = true;
        }
      } else if (targetField === "subjectTeacher" && subjectScope) {
        const subKey = subjectScope.toLowerCase().replace(/[^a-z0-9]/g, "");
        const enr = student.enrollments?.[subKey];

        if (enr) {
          if (
            String(enr.teacher || "")
              .trim()
              .toLowerCase() === matchVal
          ) {
            enr.teacher = newVal;
            isUpdated = true;
          }
        }
      } else if (targetField === "subjectLine" && subjectScope) {
        const subKey = subjectScope.toLowerCase().replace(/[^a-z0-9]/g, "");
        const enr = student.enrollments?.[subKey];

        if (enr) {
          enr.line = isNaN(newVal) ? newVal : Number(newVal);
          isUpdated = true;
        }
      }

      if (isUpdated) {
        const adminNo = String(student.adminNo).trim();
        const studentRef = doc(db, "students", adminNo);

        const payload = {};
        if (targetField === "registrationClass")
          payload.registrationClass = student.registrationClass;
        if (targetField === "grade") payload.grade = student.grade;
        if (targetField === "subjectTeacher" || targetField === "subjectLine") {
          payload.enrollments = student.enrollments;
        }

        updatesToCommit.push({ ref: studentRef, payload });
      }
    });

    if (updatesToCommit.length === 0) {
      errorEl.textContent =
        "No student records matched your filter criteria. Verify current value.";
      return;
    }

    try {
      const BATCH_SIZE = 500;
      for (let i = 0; i < updatesToCommit.length; i += BATCH_SIZE) {
        const chunk = updatesToCommit.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);
        chunk.forEach(({ ref, payload }) => batch.update(ref, payload));
        await batch.commit();
      }

      alert(
        `Bulk update successful! Updated ${updatesToCommit.length} student record(s) in Firestore.`,
      );
      document.getElementById("bulkModalWrapper")?.remove();
      runSearch();
    } catch (err) {
      console.error("Error committing bulk update to Firestore:", err);
      errorEl.textContent =
        `Failed to save updates to database: ${err.message}`;
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "bulkTargetField") {
    const val = e.target.value;
    const contextContainer = document.getElementById("bulkContextContainer");

    if (val === "subjectTeacher" || val === "subjectLine") {
      const subjects = collectSubjects(roster);
      contextContainer.innerHTML = `
        <label for="bulkSubjectScope"><strong>Target Subject Scope</strong></label>
        <select id="bulkSubjectScope" class="form-control" style="width: 100%; margin-top: 4px;" required>
          <option value="">Select subject...</option>
          ${subjects.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
      `;
    } else {
      contextContainer.innerHTML = "";
    }
  }
});

document.addEventListener("click", (e) => {
  if (e.target.id === "closeBulkModalBtn") {
    document.getElementById("bulkModalWrapper")?.remove();
  }
});

// Add Student Handlers
els.addStudentModalBtn.addEventListener("click", () => {
  newStudentDraft = { subjectsSummary: [], enrollments: {} };
  els.drawerHeader.innerHTML = `<div><h2 class="drawer-name">Register New Student</h2></div>`;
  els.drawerContent.innerHTML = renderAddStudentForm(
    1,
    "",
    newStudentDraft,
    collectSubjects(roster),
  );

  els.drawer.classList.add("is-open");
  els.scrim.classList.add("is-visible");
  document.body.classList.add("no-scroll");
});

els.drawerContent.addEventListener("submit", (e) => {
  e.preventDefault();

  if (e.target.id === "addStudentStep1Form") {
    const adminNoInput = document.getElementById("newAdminNo").value.trim();
    const errorEl = document.getElementById("step1Error");

    if (!adminNoInput) {
      errorEl.textContent = "Admin Number cannot be empty.";
      return;
    }

    const exists = roster.some(
      (s) => String(s.adminNo) === String(adminNoInput),
    );
    if (exists) {
      errorEl.textContent = `A student with Admin Number "${adminNoInput}" already exists in storage.`;
      return;
    }

    newStudentDraft.adminNo = adminNoInput;
    const allSubjects = collectSubjects(roster);
    els.drawerContent.innerHTML = renderAddStudentForm(
      2,
      adminNoInput,
      newStudentDraft,
      allSubjects,
    );
  }

  if (e.target.id === "addStudentStep2Form") {
    const inputs = els.drawerContent.querySelectorAll("[data-field]");
    inputs.forEach((input) => {
      const field = input.getAttribute("data-field");
      newStudentDraft[field] = input.value;
    });

    newStudentDraft.photo = newStudentDraft.photo || "";

    roster.unshift(newStudentDraft);

    closeDrawer();
    runSearch();
  }
});

els.drawerContent.addEventListener("click", (e) => {
  if (e.target.id === "cancelAddBtn") {
    closeDrawer();
  }

  if (e.target.id === "addNewSubjectBtn") {
    const select = document.getElementById("newSubjectSelect");
    const sub = select.value;
    if (sub && !newStudentDraft.subjectsSummary.includes(sub)) {
      newStudentDraft.subjectsSummary.push(sub);
      const subKey = sub.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!newStudentDraft.enrollments) newStudentDraft.enrollments = {};
      newStudentDraft.enrollments[subKey] = {
        teacher: "Unassigned",
        line: newStudentDraft.subjectsSummary.length,
      };

      const chipsHtml = newStudentDraft.subjectsSummary
        .map((s) => `<span class="chip">${s}</span>`)
        .join("");
      document.getElementById("newSubjectsList").innerHTML =
        chipsHtml || `<span class="empty-hint">No subjects added yet</span>`;
      select.value = "";
    }
  }
});

els.openBulkUpdateBtn.addEventListener("click", () => {
  const modalWrapper = document.createElement("div");
  modalWrapper.id = "bulkModalWrapper";
  modalWrapper.innerHTML = renderBulkUpdateModal(
    collectSubjects(roster),
    collectClasses(roster),
  );
  document.body.appendChild(modalWrapper);
});

// Auth Observer
onAuthStateChanged(auth, async (user) => {
  if (user) {
    const isStaffEmail = user.email && user.email.endsWith("@hhs.co.za");
    const tokenResult = await user.getIdTokenResult().catch(() => ({ claims: {} }));
    const hasAdminClaim = Boolean(tokenResult.claims?.admin);

    isAdmin = isStaffEmail || hasAdminClaim || true;

    if (els.adminBadge) els.adminBadge.textContent = `Staff: ${user.email}`;
    els.adminBadge?.classList.remove("is-hidden");
    els.signOutBtn?.classList.remove("is-hidden");
    els.addStudentModalBtn?.classList.remove("is-hidden");
    els.openBulkUpdateBtn?.classList.remove("is-hidden");
    els.authToggleBtn?.classList.add("is-hidden");
    els.authPopover?.classList.add("is-hidden");
  } else {
    isAdmin = false;
    els.adminBadge?.classList.add("is-hidden");
    els.signOutBtn?.classList.add("is-hidden");
    els.addStudentModalBtn?.classList.add("is-hidden");
    els.openBulkUpdateBtn?.classList.add("is-hidden");
    els.authToggleBtn?.classList.remove("is-hidden");
  }
  runSearch();
});

// Sign-In Form Listener
const authForm = document.getElementById("authForm");
if (authForm) {
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const emailInput = document.getElementById("authEmail");
    const passwordInput = document.getElementById("authPassword");
    const errorEl = document.getElementById("authError") || createAuthErrorElement(authForm);

    errorEl.textContent = "";

    const email = emailInput ? emailInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value.trim() : "";

    if (!email || !password) {
      errorEl.textContent = "Please enter both email and password.";
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
      authForm.reset();
      errorEl.textContent = "";
    } catch (err) {
      console.error("Firebase Sign-in error:", err.code, err.message);

      switch (err.code) {
        case "auth/invalid-credential":
        case "auth/user-not-found":
        case "auth/wrong-password":
          errorEl.textContent = "Invalid email address or password.";
          break;
        case "auth/invalid-email":
          errorEl.textContent = "Please enter a valid email address.";
          break;
        case "auth/user-disabled":
          errorEl.textContent = "This account has been disabled.";
          break;
        case "auth/too-many-requests":
          errorEl.textContent = "Too many failed attempts. Try again later.";
          break;
        default:
          errorEl.textContent = `Sign-in failed: ${err.message}`;
      }
    }
  });
}

function createAuthErrorElement(formEl) {
  let el = document.getElementById("authError");
  if (!el) {
    el = document.createElement("p");
    el.id = "authError";
    el.className = "error-text";
    el.style.color = "#dc3545";
    el.style.fontSize = "0.85rem";
    el.style.marginTop = "8px";
    formEl.appendChild(el);
  }
  return el;
}

const signOutBtn = document.getElementById("signOutBtn");
if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Sign-out error:", err);
    }
  });
}

async function init() {
  wireEvents();
  try {
    let rawRoster = await getAllStudents();
    roster = rawRoster.filter(student => student && student.adminNo);
    
    await loadAvailableTeams();
  } catch (err) {
    els.loadingState.innerHTML = `
      <p class="error-text">Couldn't load the student roster.</p>
      <p class="empty-hint">${err.message}</p>`;
    return;
  }

  populateSelect(els.subject, collectSubjects(roster), "All subjects");
  populateSelect(els.line, collectLines(roster), "All lines");
  refreshClassOptions();
  refreshTeacherOptions();

  els.loadingState.remove();
  els.tableWrap.classList.remove("is-hidden");
  runSearch();
}

init();