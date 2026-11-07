/**
 * awards-app.js — page controller for awards.html.
 * Access: pages.js guardCurrentPage() (needs "viewAwards"); the form and Withdraw need "recommendAwards";
 * Accept / Decline / Revoke need "approveAwards" (json/usertypes.json). UI only: Firestore Rules enforce the same.
 * Lists are cached per tab in memory and patched locally after each action (no re-read).
 */
import { guardCurrentPage } from "./pages.js";
import { can, getTypeDef } from "./usertypes.js";
import { escapeHtml } from "./html.js";
import { getAllStudents, getTeamsList } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import {
  AWARD_LEVELS,
  NOTE_MAX,
  buildRecommendationDraft,
  applySelection,
  applyTeamChange,
  applyDraftChange,
  isNonMember,
  memberAgeGroups,
  validateRecommendation,
  buildRecommendationPayload,
  validateApproval,
  schoolYearOf,
} from "./awards-form.js";
import {
  createRecommendation,
  listRecommendations,
  countPriorAwards,
  confirmRecommendation,
  rejectRecommendation,
  revokeAward,
  withdrawRecommendation,
  todayLocal,
} from "./awards-service.js";
import {
  renderStudentMatches,
  renderSelectedStudent,
  renderTeamOptions,
  renderAgeGroupOptions,
  renderLevelOptions,
  renderRecommendationList,
} from "./render-awards.js";

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gate"),
  toolPanel: $("toolPanel"),
  recommendPanel: $("recommendPanel"),
  userBadge: $("userBadge"),
  studentSearch: $("studentSearch"),
  studentMatches: $("studentMatches"),
  selectedStudent: $("selectedStudent"),
  recommendForm: $("recommendForm"),
  teamSelect: $("teamSelect"),
  ageGroupField: $("ageGroupField"),
  ageGroupSelect: $("ageGroupSelect"),
  levelSelect: $("levelSelect"),
  memberWarning: $("memberWarning"),
  noteInput: $("noteInput"),
  noteCount: $("noteCount"),
  recommendError: $("recommendError"),
  recommendStatus: $("recommendStatus"),
  statusTabs: document.querySelectorAll("[data-status]"),
  recList: $("recList"),
  loadMoreBtn: $("loadMoreBtn"),
  refreshBtn: $("refreshBtn"),
};

const TABS = ["pending", "confirmed", "rejected", "revoked", "withdrawn", "all"];
const lists = Object.fromEntries(TABS.map((t) => [t, { rows: [], last: null, full: false, loaded: false }]));
let activeStatus = "pending";

let me = { user: null, canRecommend: false, isApprover: false };
let roster = [];
let teams = []; // [{ teamId, name, ageGroups: [] }]
let draft = buildRecommendationDraft();

const findStudent = (adminNo) => roster.find((s) => String(s.adminNo) === String(adminNo));
const findTeam = (teamId) => teams.find((t) => t.teamId === teamId);
const findRec = (id) => lists[activeStatus].rows.find((r) => r.id === id);

/* ---------------- Access gate + startup ---------------- */

function fail(message) {
  els.toolPanel.classList.add("is-hidden");
  els.gate.style.display = "flex";
  els.gate.innerHTML = `<p class="error-text">${escapeHtml(message)} <a href="index.html">Return to the dashboard</a></p>`;
}

async function start() {
  const g = await guardCurrentPage(); // redirects to the dashboard when not signed in / not allowed
  if (!g) return;
  const { user, cfg, type } = g;
  me = {
    user,
    canRecommend: can(cfg, type, "recommendAwards"),
    isApprover: can(cfg, type, "approveAwards"),
  };

  els.userBadge.textContent = `${getTypeDef(cfg, type)?.label || type}: ${user.email}${me.isApprover ? " · Approver" : ""}`;
  els.recommendPanel.classList.toggle("is-hidden", !me.canRecommend);

  try {
    // Roster from the cache (about 6 reads on a cold start); teams from the 3 h teams cache.
    const [students, teamList] = await Promise.all([getAllStudents(), getTeamsList()]);
    roster = students.filter((s) => s && s.adminNo);
    const hide = new Set(teamList.hidden || []);
    teams = teamList.teams
      .filter((t) => !hide.has(t.teamName))
      .map((t) => ({ teamId: t.id, name: t.teamName, ageGroups: Object.keys(t.ageGroups || {}).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error(err);
    fail(`Could not load data: ${err.message}`);
    return;
  }

  resetFormUi();
  els.levelSelect.innerHTML = renderLevelOptions(AWARD_LEVELS);
  els.gate.style.display = "none";
  els.toolPanel.classList.remove("is-hidden");
  loadList();
}

/* ---------------- Recommend form ---------------- */

function resetFormUi() {
  els.teamSelect.innerHTML = renderTeamOptions(teams);
  els.ageGroupField.classList.add("is-hidden");
  els.ageGroupSelect.innerHTML = "";
  els.memberWarning.textContent = "";
  els.noteCount.textContent = `0 / ${NOTE_MAX}`;
  els.selectedStudent.innerHTML = renderSelectedStudent(null);
}

function updateWarning() {
  const student = findStudent(draft.adminNo);
  const team = findTeam(draft.teamId);
  els.memberWarning.textContent =
    student && team && isNonMember(student, team, draft.ageGroup)
      ? `${student.firstName} ${student.lastName} is not recorded as a member of ${team.name}${draft.ageGroup ? ` (${draft.ageGroup})` : ""}. You can still recommend; an approver must confirm it before it is approved.`
      : "";
}

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
  // the student's own teams first (cached roster: no reads)
  els.teamSelect.innerHTML = renderTeamOptions(teams, (student?.teams || []).map((t) => t.teamName));
  els.ageGroupField.classList.add("is-hidden");
  updateWarning();
  els.studentMatches.innerHTML = "";
  els.studentSearch.value = "";
});

els.teamSelect.addEventListener("change", () => {
  draft = applyTeamChange(draft, els.teamSelect.value);
  const team = findTeam(draft.teamId);
  const groups = team?.ageGroups || [];
  els.ageGroupField.classList.toggle("is-hidden", !groups.length);
  const mine = memberAgeGroups(findStudent(draft.adminNo), team);
  if (mine.length === 1 && groups.includes(mine[0])) draft = applyDraftChange(draft, "ageGroup", mine[0]);
  els.ageGroupSelect.innerHTML = renderAgeGroupOptions(groups, draft.ageGroup);
  updateWarning();
});
els.ageGroupSelect.addEventListener("change", () => {
  draft = applyDraftChange(draft, "ageGroup", els.ageGroupSelect.value);
  updateWarning();
});
els.levelSelect.addEventListener("change", () => (draft = applyDraftChange(draft, "awardLevel", els.levelSelect.value)));
els.noteInput.addEventListener("input", () => {
  draft = applyDraftChange(draft, "note", els.noteInput.value);
  els.noteCount.textContent = `${els.noteInput.value.length} / ${NOTE_MAX}`;
});

els.recommendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.recommendError.textContent = "";
  els.recommendStatus.textContent = "";
  if (!me.canRecommend) return;

  const student = findStudent(draft.adminNo);
  const team = findTeam(draft.teamId);
  const problems = validateRecommendation(draft, student, team);
  if (problems.length) {
    els.recommendError.textContent = problems.join(" · ");
    return;
  }

  // Already waiting in the (loaded) pending list?
  const dupe = lists.pending.rows.some(
    (r) => r.adminNo === String(student.adminNo) && r.teamName === team.name &&
           (r.ageGroup || "") === (draft.ageGroup || "") && r.awardLevel === draft.awardLevel,
  );
  if (dupe && !window.confirm("A pending recommendation for this student, team and level already exists. Submit another?")) return;

  const btn = els.recommendForm.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    let priorCount = 0;
    try {
      priorCount = await countPriorAwards({ adminNo: student.adminNo, teamName: team.name, awardLevel: draft.awardLevel });
    } catch (err) {
      console.warn("re-award check failed (the approver re-checks)", err); // not blocking
    }
    const payload = buildRecommendationPayload(draft, student, team, {
      nonMember: isNonMember(student, team, draft.ageGroup),
      priorCount,
    });
    await createRecommendation(payload, me.user);
    els.recommendStatus.textContent = `Recommendation submitted for ${student.firstName} ${student.lastName}${priorCount ? " (re-award)" : ""}.`;
    draft = buildRecommendationDraft();
    els.recommendForm.reset();
    resetFormUi();
    lists.pending.loaded = false;
    lists.all.loaded = false;
    if (activeStatus === "pending" || activeStatus === "all") loadList();
  } catch (err) {
    els.recommendError.textContent = "Could not submit: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- Lists (cached per tab, patched locally) ---------------- */

function renderList() {
  const L = lists[activeStatus];
  els.recList.innerHTML = renderRecommendationList(L.rows, {
    canReview: me.isApprover,
    canRecommend: me.canRecommend,
    today: todayLocal(),
  });
  els.loadMoreBtn.classList.toggle("is-hidden", !L.full);
  const p = lists.pending;
  const pendingTab = document.querySelector('[data-status="pending"]');
  if (pendingTab) pendingTab.textContent = p.loaded ? `Pending (${p.rows.length}${p.full ? "+" : ""})` : "Pending";
}

async function loadList({ more = false } = {}) {
  const status = activeStatus;
  const L = lists[status];
  if (!more) els.recList.innerHTML = `<p class="empty-hint">Loading…</p>`;
  try {
    const res = await listRecommendations(status, { after: more ? L.last : null });
    L.rows = more ? [...L.rows, ...res.rows] : res.rows;
    L.last = res.last;
    L.full = res.full;
    L.loaded = true;
  } catch (err) {
    if (status === activeStatus) els.recList.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (status === activeStatus) renderList();
}

function showTab(status) {
  activeStatus = status;
  els.statusTabs.forEach((t) => t.classList.toggle("is-active", t.dataset.status === status));
  if (lists[status].loaded) renderList();
  else loadList();
}

/** Patch every cached tab with the updated record instead of re-reading. */
function applyChange(rec) {
  TABS.forEach((t) => {
    const L = lists[t];
    if (!L.loaded) return;
    if (t === "all") {
      L.rows = L.rows.map((r) => (r.id === rec.id ? rec : r));
    } else {
      L.rows = L.rows.filter((r) => r.id !== rec.id);
      if (t === rec.status) L.loaded = false; // newly arrived there: order unknown, reload when next viewed
    }
  });
  renderList();
}

function staleAll() {
  TABS.forEach((t) => (lists[t].loaded = false));
}

els.statusTabs.forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.status)));
els.refreshBtn.addEventListener("click", () => loadList());
els.loadMoreBtn.addEventListener("click", () => loadList({ more: true }));

// School year follows the issue date until the approver edits it.
els.recList.addEventListener("input", (e) => {
  if (e.target.classList.contains("rec-school-year")) e.target.dataset.touched = "1";
});
els.recList.addEventListener("change", (e) => {
  if (!e.target.classList.contains("rec-issue-date")) return;
  const y = card(e.target).querySelector(".rec-school-year");
  const year = schoolYearOf(e.target.value);
  if (y && !y.dataset.touched && year) y.value = year;
});
const card = (el) => el.closest("[data-rec-id]");

/* ---------------- Actions ---------------- */

els.recList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const el = card(btn);
  const id = el.dataset.recId;
  const rec = findRec(id);
  if (!rec) return;
  const needsApprover = ["confirm", "reject", "revoke"].includes(action);
  if ((needsApprover && !me.isApprover) || (action === "withdraw" && !me.canRecommend)) return;

  const buttons = el.querySelectorAll("button");
  const enable = () => buttons.forEach((b) => (b.disabled = false));
  buttons.forEach((b) => (b.disabled = true)); // prevent double submits

  try {
    let updated;
    if (action === "confirm") {
      const issuedDate = el.querySelector(".rec-issue-date").value;
      const schoolYear = Number(el.querySelector(".rec-school-year").value);
      const nonMemberConfirmed = Boolean(el.querySelector(".rec-nonmember-ok")?.checked);
      const problems = validateApproval({ issuedDate, schoolYear, nonMember: rec.nonMember, nonMemberConfirmed });
      if (problems.length) {
        alert(problems.join("\n"));
        return enable();
      }
      // Re-check now: another award may have been approved since this was recommended.
      let priorCount = rec.priorCount || 0;
      try {
        priorCount = await countPriorAwards({ adminNo: rec.adminNo, teamName: rec.teamName, awardLevel: rec.awardLevel, excludeId: id });
      } catch (err) {
        console.warn("re-award re-check failed, using the stored value", err);
      }
      if (priorCount > 0 && !rec.reAward &&
          !window.confirm(`This student already has ${priorCount} confirmed award(s) at this level for this team, so this is a re-award. Accept anyway?`)) {
        return enable();
      }
      updated = await confirmRecommendation({
        recommendationId: id, approver: me.user, issuedDate, schoolYear, nonMemberConfirmed, priorCount,
      });
    } else if (action === "reject") {
      const reason = (window.prompt("Reason for declining (required):") || "").trim();
      if (!reason) return enable();
      updated = await rejectRecommendation({ recommendationId: id, approver: me.user, reason });
    } else if (action === "revoke") {
      const reason = (window.prompt("Reason for revoking this award (required):") || "").trim();
      if (!reason) return enable();
      updated = await revokeAward({ recommendationId: id, approver: me.user, reason });
    } else if (action === "withdraw") {
      if (!window.confirm(`Withdraw the recommendation for ${rec.studentName}? It leaves the approval queue.`)) return enable();
      updated = await withdrawRecommendation({ recommendationId: id, user: me.user });
    }
    if (updated) applyChange(updated);
  } catch (err) {
    enable();
    alert(err.message);
    if (err.stale) {
      staleAll(); // someone else changed it: reload from the server
      loadList();
    }
  }
});

start();