/**
 * awards-app.js — page controller for awards.html.
 * Wires auth gate, recommend form, and the review list.
 * Depends on data-service.js patch: getAllTeams(), patchCachedStudent().
 */
import { escapeHtml } from ".js/html.js";
import { onAuthChange, signInStaff, signOutStaff } from "./auth-service.js";
import { getAllStudents, getAllTeams, patchCachedStudent } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import {
  AWARD_LEVELS,
  NOTE_MAX,
  buildRecommendationDraft,
  applySelection,
  applyDraftChange,
  validateRecommendation,
  buildRecommendationPayload,
} from "./awards-form.js";
import {
  createRecommendation,
  listRecommendations,
  confirmRecommendation,
  rejectRecommendation,
  todayLocal,
} from "./awards-service.js";
import {
  escapeHtml,
  renderStudentMatches,
  renderSelectedStudent,
  renderTeamOptions,
  renderLevelOptions,
  renderRecommendationList,
} from "./render-awards.js";

const $ = (id) => document.getElementById(id);
const els = {
  authGate: $("authGate"),
  authForm: $("authForm"),
  authEmail: $("authEmail"),
  authPassword: $("authPassword"),
  authError: $("authError"),
  toolPanel: $("toolPanel"),
  userBadge: $("userBadge"),
  signOutBtn: $("signOutBtn"),
  studentSearch: $("studentSearch"),
  studentMatches: $("studentMatches"),
  selectedStudent: $("selectedStudent"),
  recommendForm: $("recommendForm"),
  teamSelect: $("teamSelect"),
  levelSelect: $("levelSelect"),
  noteInput: $("noteInput"),
  noteCount: $("noteCount"),
  recommendError: $("recommendError"),
  recommendStatus: $("recommendStatus"),
  statusTabs: document.querySelectorAll("[data-status]"),
  recList: $("recList"),
  refreshBtn: $("refreshBtn"),
};

let auth = { user: null, isAdmin: false, isApprover: false };
let roster = [];
let teams = [];
let draft = buildRecommendationDraft();
let activeStatus = "pending";
let loaded = false;

const findStudent = (adminNo) => roster.find((s) => String(s.adminNo) === String(adminNo));
const findTeam = (teamId) => teams.find((t) => t.teamId === teamId);

/* ---------------- Auth ---------------- */

els.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.authError.textContent = "";
  try {
    await signInStaff(els.authEmail.value, els.authPassword.value);
  } catch (err) {
    els.authError.textContent = "Sign-in failed: " + err.message;
  }
});
els.signOutBtn.addEventListener("click", () => signOutStaff());

onAuthChange(async (state) => {
  auth = state;
  const allowed = Boolean(state.user && state.isAdmin);
  els.authGate.classList.toggle("is-hidden", allowed);
  els.toolPanel.classList.toggle("is-hidden", !allowed);

  if (state.user && !state.isAdmin) {
    els.authError.textContent = "This account does not have staff access.";
  }
  if (!allowed) return;

  els.userBadge.textContent = `${state.user.email}${state.isApprover ? " · Approver" : ""}`;
  if (!loaded) {
    loaded = true;
    await init();
  }
  loadList(); // re-render so Accept/Decline reflect current role
});

async function init() {
  try {
    [roster, teams] = await Promise.all([getAllStudents(), getAllTeams()]);
  } catch (err) {
    els.recommendError.textContent = "Could not load data: " + err.message;
    loaded = false;
    return;
  }
  els.teamSelect.innerHTML = renderTeamOptions(teams);
  els.levelSelect.innerHTML = renderLevelOptions(AWARD_LEVELS);
  els.noteCount.textContent = `0 / ${NOTE_MAX}`;
  els.selectedStudent.innerHTML = renderSelectedStudent(null);
}

/* ---------------- Recommend form ---------------- */

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

els.studentSearch.addEventListener(
  "input",
  debounce(() => {
    const term = els.studentSearch.value.trim();
    if (term.length < 2) {
      els.studentMatches.innerHTML = "";
      return;
    }
    const hits = sortStudents(filterStudents(roster, { term, field: "auto" })).slice(0, 8);
    els.studentMatches.innerHTML = renderStudentMatches(hits);
  }, 150),
);

els.studentMatches.addEventListener("click", (e) => {
  const row = e.target.closest("[data-admin-no]");
  if (!row) return;
  const student = findStudent(row.dataset.adminNo);
  draft = applySelection(draft, student);
  els.selectedStudent.innerHTML = renderSelectedStudent(student);
  els.studentMatches.innerHTML = "";
  els.studentSearch.value = "";
});

els.teamSelect.addEventListener("change", () => (draft = applyDraftChange(draft, "teamId", els.teamSelect.value)));
els.levelSelect.addEventListener("change", () => (draft = applyDraftChange(draft, "awardLevel", els.levelSelect.value)));
els.noteInput.addEventListener("input", () => {
  draft = applyDraftChange(draft, "note", els.noteInput.value);
  els.noteCount.textContent = `${els.noteInput.value.length} / ${NOTE_MAX}`;
});

els.recommendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.recommendError.textContent = "";
  els.recommendStatus.textContent = "";

  const student = findStudent(draft.adminNo);
  const team = findTeam(draft.teamId);
  const problems = validateRecommendation(draft, student, team);
  if (problems.length) {
    els.recommendError.textContent = problems.join(" · ");
    return;
  }

  const btn = els.recommendForm.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    await createRecommendation(buildRecommendationPayload(draft, student, team), auth.user);
    els.recommendStatus.textContent = `Recommendation submitted for ${student.firstName} ${student.lastName}.`;
    draft = buildRecommendationDraft();
    els.recommendForm.reset();
    els.noteCount.textContent = `0 / ${NOTE_MAX}`;
    els.selectedStudent.innerHTML = renderSelectedStudent(null);
    if (activeStatus === "pending" || activeStatus === "all") loadList();
  } catch (err) {
    els.recommendError.textContent = "Could not submit: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- Review list ---------------- */

async function loadList() {
  els.recList.innerHTML = `<p class="empty-hint">Loading…</p>`;
  try {
    const recs = await listRecommendations(activeStatus);
    els.recList.innerHTML = renderRecommendationList(recs, {
      canReview: auth.isApprover,
      today: todayLocal(),
    });
  } catch (err) {
    els.recList.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

els.statusTabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    activeStatus = tab.dataset.status;
    els.statusTabs.forEach((t) => t.classList.toggle("is-active", t === tab));
    loadList();
  }),
);
els.refreshBtn.addEventListener("click", loadList);

els.recList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || !auth.isApprover) return;
  const card = btn.closest("[data-rec-id]");
  const recommendationId = card.dataset.recId;
  const buttons = card.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true)); // prevent double submits

  try {
    if (btn.dataset.action === "confirm") {
      const issuedDate = card.querySelector(".rec-issue-date").value || todayLocal();
      const { student } = await confirmRecommendation({ recommendationId, approver: auth.user, issuedDate });
      // Use the POST-transaction record, not the stale local copy.
      patchCachedStudent(student);
      roster = roster.map((s) => (String(s.adminNo) === String(student.adminNo) ? student : s));
      teams = await getAllTeams({ forceRefresh: true });
    } else {
      const reason = (window.prompt("Reason for declining (required):") || "").trim();
      if (!reason) {
        buttons.forEach((b) => (b.disabled = false));
        return;
      }
      await rejectRecommendation({ recommendationId, approver: auth.user, reason });
    }
    loadList();
  } catch (err) {
    buttons.forEach((b) => (b.disabled = false));
    alert(err.message);
  }
});
