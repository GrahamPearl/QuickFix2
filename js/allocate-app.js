/**
 * allocate-app.js — page controller for allocate.html (bulk subject allocation).
 * Flow: grade + classes -> students -> subject + teacher -> line -> review -> confirm.
 * Access: usertypes.json permission "bulkAllocate" (UI only; Firestore Rules must also enforce it).
 */
import { auth, onAuthStateChanged } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { getAllStudents, collectSubjects, patchCachedStudents } from "./data-service.js";
import { subjectKey } from "./edit-form.js";
import { escapeHtml as esc } from "./html.js";
import {
  MAX_LINE, GRADES, clsOf, isClassGrade, buildDraft, applyField, setGrade, setClasses, setSelected,
  canonicalSubject, validateDraft, classifyStudents, missingRow, summarize, buildEnrollment, patchStudent, toCsv,
} from "./allocate-form.js";
import { getGradeLines, applyAllocation } from "./allocate-service.js";

const $ = (id) => document.getElementById(id);
const { IMAGE_BASE_URL, CLASS_TIMETABLE_GRADES = [8, 9] } = window.APP_CONFIG;
const OTHER = "__other__";

const S = {
  roster: [], draft: buildDraft(), user: null, lines: [], filter: "",
  overwrite: false, reviewed: null, busy: false, lineSeq: 0,
};

/* ---------- helpers ---------- */
const low = (v) => String(v || "").toLowerCase();
const byName = (a, b) => low(a.lastName).localeCompare(low(b.lastName)) || low(a.firstName).localeCompare(low(b.firstName));
const ini = (s) => `${(s.firstName || "?")[0]}${(s.lastName || "?")[0]}`.toUpperCase();
const photoSrc = (f) => (f ? IMAGE_BASE_URL + encodeURI(f) : "");
const gradeStudents = () => S.roster.filter((s) => String(s.grade) === S.draft.grade);
const subjects = () => collectSubjects(S.roster);
const sortClasses = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const say = (id, text, cls = "") => { const el = $(id); el.className = `plan-msg ${cls}`; el.textContent = text; };

// Broken photo -> initials (error events do not bubble, so listen in the capture phase).
document.addEventListener("error", (ev) => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.initials) return;
  const sp = document.createElement("span");
  sp.className = "stu-photo stu-ini";
  sp.textContent = img.dataset.initials;
  img.replaceWith(sp);
}, true);

function setBusy(on) {
  S.busy = on;
  document.querySelectorAll("#app button").forEach((b) => (b.disabled = on));
}

/* ---------- access gate ---------- */
function deny(msg) {
  $("app").classList.add("is-hidden");
  $("gate").style.display = "flex";
  $("gate").innerHTML = `<p class="error-text">${esc(msg)} <a href="index.html">Return to the roster</a></p>`;
}

let started = false;
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  if (started) return;
  try {
    const cfg = await loadUserTypes();
    if (!can(cfg, await resolveUserType(user, cfg), "bulkAllocate")) {
      deny("Access denied: bulk allocation is limited to administrators.");
      return;
    }
    started = true;
    S.user = user;
    $("userBadge").textContent = user.email;
    $("userBadge").classList.remove("is-hidden");
    S.roster = (await getAllStudents()).filter((s) => s && s.adminNo);
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    init();
  } catch (err) {
    console.error(err);
    deny(`Could not load data: ${err.message}`);
  }
});

function init() {
  $("gradeSel").innerHTML = `<option value="">Select a grade…</option>` +
    GRADES.map((g) => `<option value="${g}">Grade ${g}</option>`).join("");
  renderClasses(); renderStudents(); renderSubjects(); renderLine();
}

/* ---------- 1. grade + classes ---------- */
function clearReview() {
  S.reviewed = null;
  $("reviewBox").innerHTML = "";
  say("reviewMsg", "");
}

$("gradeSel").addEventListener("change", (e) => {
  S.draft = e.target.value ? setGrade(S.draft, e.target.value) : buildDraft();
  clearReview(); renderClasses(); renderStudents(); loadLines();
});

function renderClasses() {
  const counts = new Map();
  gradeStudents().forEach((s) => { const c = clsOf(s); if (c) counts.set(c, (counts.get(c) || 0) + 1); });
  const classes = [...counts.keys()].sort(sortClasses);
  const on = new Set(S.draft.classes);
  $("classBox").innerHTML = classes.length
    ? classes.map((c) => `<label class="tch ${on.has(c) ? "on" : ""}"><input type="checkbox" value="${esc(c)}" ${on.has(c) ? "checked" : ""}>
        ${esc(c)} <span class="empty-hint">(${counts.get(c)})</span></label>`).join("")
    : `<span class="empty-hint">${S.draft.grade ? "No classes found for this grade." : "Choose a grade first."}</span>`;
}

function setClassSelection(classes) {
  S.draft = setClasses(S.draft, classes, S.roster);
  clearReview(); renderClasses(); renderStudents();
}
$("classBox").addEventListener("change", () =>
  setClassSelection([...document.querySelectorAll("#classBox input:checked")].map((i) => i.value).sort(sortClasses)));
$("classAllBtn").addEventListener("click", () =>
  setClassSelection([...document.querySelectorAll("#classBox input")].map((i) => i.value)));
$("classNoneBtn").addEventListener("click", () => setClassSelection([]));

/* ---------- 2. students ---------- */
function cardHtml(s, on) {
  const src = photoSrc(s.photo);
  const photo = src
    ? `<img class="stu-photo" loading="lazy" src="${esc(src)}" alt="" data-initials="${esc(ini(s))}">`
    : `<span class="stu-photo stu-ini">${esc(ini(s))}</span>`;
  return `<label class="stu ${on ? "on" : ""}"><input type="checkbox" class="stu-chk" value="${esc(s.adminNo)}" ${on ? "checked" : ""}>
    ${photo}<span class="stu-name">${esc(low(s.lastName).toUpperCase())}, ${esc(s.firstName)}</span>
    <span class="stu-adm mono">${esc(s.adminNo)}</span></label>`;
}

function renderStudents() {
  const term = low(S.filter).trim();
  const sel = new Set(S.draft.selected);
  const html = S.draft.classes.map((c) => {
    const all = gradeStudents().filter((s) => clsOf(s) === c).sort(byName);
    const shown = all.filter((s) => !term || low(`${s.firstName} ${s.lastName} ${s.adminNo}`).includes(term));
    return `<section class="cls-sec" data-cls="${esc(c)}">
      <div class="cls-head"><strong>Class ${esc(c)}</strong>
        <span class="empty-hint" data-count>${all.filter((s) => sel.has(String(s.adminNo))).length} of ${all.length} selected</span>
        <span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-act="all">Select shown</button>
        <button type="button" class="btn btn-ghost" data-act="none">Clear shown</button></div>
      <div class="stu-grid">${shown.map((s) => cardHtml(s, sel.has(String(s.adminNo)))).join("") ||
        `<span class="empty-hint">No students match.</span>`}</div></section>`;
  }).join("");
  $("studentGrid").innerHTML = html || `<p class="empty-hint">Choose one or more classes to see their students.</p>`;
  updateSelCount();
}

function updateSelCount() {
  $("selCount").textContent = `${S.draft.selected.length} selected`;
  const sel = new Set(S.draft.selected);
  document.querySelectorAll(".cls-sec").forEach((sec) => {
    const c = sec.dataset.cls;
    const all = gradeStudents().filter((s) => clsOf(s) === c);
    sec.querySelector("[data-count]").textContent =
      `${all.filter((s) => sel.has(String(s.adminNo))).length} of ${all.length} selected`;
  });
}

$("studentGrid").addEventListener("change", (e) => {
  if (!e.target.classList.contains("stu-chk")) return;
  S.draft = setSelected(S.draft, [e.target.value], e.target.checked);
  e.target.closest(".stu").classList.toggle("on", e.target.checked);
  clearReview(); updateSelCount();
});
$("studentGrid").addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const ids = [...e.target.closest(".cls-sec").querySelectorAll(".stu-chk")].map((i) => i.value);
  S.draft = setSelected(S.draft, ids, act === "all");
  clearReview(); renderStudents();
});
$("selAllBtn").addEventListener("click", () => {
  S.draft = setSelected(S.draft, [...document.querySelectorAll(".stu-chk")].map((i) => i.value), true);
  clearReview(); renderStudents();
});
$("selNoneBtn").addEventListener("click", () => {
  S.draft = { ...S.draft, selected: [] };
  clearReview(); renderStudents();
});
$("studentSearch").addEventListener("input", (e) => { S.filter = e.target.value; renderStudents(); });

/* ---------- 3. subject + teacher ---------- */
function teachersFor(subject) {
  const key = subjectKey(subject);
  const set = new Set();
  if (key) S.roster.forEach((s) => { const t = s.enrollments?.[key]?.teacher; if (t) set.add(String(t).trim()); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function renderSubjects() {
  $("subjectSel").innerHTML = `<option value="">Select a subject…</option>` +
    subjects().map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("") +
    `<option value="${OTHER}">Other…</option>`;
  renderTeachers();
}

function renderTeachers() {
  const isOther = $("subjectSel").value === OTHER;
  const list = isOther ? [] : teachersFor(readSubject());
  $("teacherSel").innerHTML = `<option value="">Select a teacher…</option>` +
    list.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("") +
    `<option value="${OTHER}">Other…</option>`;
  if (isOther) $("teacherSel").value = OTHER; // a new subject has no known teachers
  $("subjectOther").classList.toggle("is-hidden", !isOther);
  $("teacherOther").classList.toggle("is-hidden", $("teacherSel").value !== OTHER);
}

function readSubject() {
  const v = $("subjectSel").value;
  return v === OTHER ? canonicalSubject($("subjectOther").value, subjects()) : v;
}
function readTeacher() {
  const v = $("teacherSel").value;
  return v === OTHER ? $("teacherOther").value.trim() : v;
}
function syncSubjectTeacher() {
  S.draft = applyField(applyField(S.draft, "subject", readSubject()), "teacher", readTeacher());
  clearReview();
}

$("subjectSel").addEventListener("change", () => { renderTeachers(); syncSubjectTeacher(); });
$("subjectOther").addEventListener("input", syncSubjectTeacher);
$("subjectOther").addEventListener("change", () => { renderTeachers(); syncSubjectTeacher(); });
$("teacherSel").addEventListener("change", () => {
  $("teacherOther").classList.toggle("is-hidden", $("teacherSel").value !== OTHER);
  syncSubjectTeacher();
});
$("teacherOther").addEventListener("input", syncSubjectTeacher);

/* ---------- 4. line ---------- */
async function loadLines() {
  const g = S.draft.grade, seq = ++S.lineSeq;
  S.lines = [];
  renderLine();
  if (!g || isClassGrade(g, CLASS_TIMETABLE_GRADES)) return;
  const lines = await getGradeLines(g);
  if (seq === S.lineSeq) { S.lines = lines; renderLine(); }
}

function renderLine() {
  const g = S.draft.grade, box = $("lineBox");
  if (!g) { box.innerHTML = `<span class="empty-hint">Choose a grade first.</span>`; return; }
  if (isClassGrade(g, CLASS_TIMETABLE_GRADES)) {
    box.innerHTML = `<input type="number" id="lineIn" min="1" max="${MAX_LINE}" value="${esc(S.draft.line)}" placeholder="1–${MAX_LINE}">
      <p class="empty-hint">Grade ${esc(g)} uses class timetables with no line numbers. Type the line to record on each enrollment.</p>`;
    return;
  }
  box.innerHTML = `<select id="lineSel"><option value="">Select a line…</option>` +
    S.lines.map((l) => `<option value="${l}" ${String(l) === S.draft.line ? "selected" : ""}>Line ${l}</option>`).join("") +
    `</select><p class="empty-hint">Lines come from the Grade ${esc(g)} timetable.</p>`;
}
$("lineBox").addEventListener("input", (e) => {
  if (e.target.id !== "lineIn" && e.target.id !== "lineSel") return;
  S.draft = applyField(S.draft, "line", e.target.value.trim());
  clearReview();
});

/* ---------- 5. review ---------- */
const reportRows = (rows) => rows.filter((r) => r.status !== "ready");

function downloadCsv(rows, name) {
  const url = URL.createObjectURL(new Blob(["\ufeff" + toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function reportTable(rows) {
  return `<div class="cand-wrap"><table><thead><tr><th>Admin No</th><th>Name</th><th>Class</th><th>Status</th><th>Reason</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono">${esc(r.adminNo)}</td><td>${esc(r.name)}</td><td>${esc(r.class)}</td>
      <td>${esc(r.status)}</td><td>${esc(r.reason)}</td></tr>`).join("")}</tbody></table></div>`;
}

function buildRows(draft) {
  const byId = new Map(S.roster.map((s) => [String(s.adminNo), s]));
  const found = draft.selected.map((id) => byId.get(id)).filter(Boolean);
  const missing = draft.selected.filter((id) => !byId.has(id)).map(missingRow);
  return [...classifyStudents(found, draft, { overwrite: S.overwrite }), ...missing];
}

async function review() {
  const problems = validateDraft(S.draft);
  if (problems.length) { say("reviewMsg", problems.join(" · "), "err"); return; }
  setBusy(true);
  say("reviewMsg", "Refreshing student data…", "warn");
  let ok = false;
  try {
    S.roster = (await getAllStudents({ forceRefresh: true })).filter((s) => s && s.adminNo); // conflicts need fresh data
    const draft = { ...S.draft, selected: [...S.draft.selected], classes: [...S.draft.classes] };
    S.reviewed = { draft, rows: buildRows(draft) };
    ok = true;
  } catch (err) {
    say("reviewMsg", `Could not load student data: ${err.message}`, "err");
  } finally {
    setBusy(false);
  }
  if (ok) { say("reviewMsg", ""); renderReview(); } // after setBusy so Confirm keeps its disabled state
}
$("reviewBtn").addEventListener("click", review);

function renderReview() {
  const { draft, rows } = S.reviewed;
  const sum = summarize(rows), skipped = reportRows(rows);
  const tt = isClassGrade(draft.grade, CLASS_TIMETABLE_GRADES)
    ? `<p class="empty-hint">Class timetable text: <strong>${esc(draft.subject)} | ${esc(draft.teacher)}</strong> (the class timetable itself is not changed here).</p>` : "";
  $("reviewBox").innerHTML = `
    <div class="review-sum">
      <p><strong>${esc(draft.subject)}</strong> · ${esc(draft.teacher)} · Line ${esc(draft.line)} · Grade ${esc(draft.grade)}</p>${tt}
      <p><span class="ok">${sum.ready} will be allocated</span> ·
         <span class="warn">${sum.conflict} conflict${sum.conflict === 1 ? "" : "s"} (skipped)</span> ·
         <span class="err">${sum.skip} cannot be allocated</span></p>
      <label class="chk"><input type="checkbox" id="overwriteChk" ${S.overwrite ? "checked" : ""}>
        Overwrite students who already have this subject (line clashes are never overwritten)</label>
    </div>
    ${skipped.length ? reportTable(skipped) : ""}
    <div class="btn-row" style="margin-top:12px">
      <button type="button" id="confirmBtn" class="btn btn-primary" ${sum.ready ? "" : "disabled"}>Allocate ${sum.ready} student${sum.ready === 1 ? "" : "s"}</button>
      ${skipped.length ? `<button type="button" id="reportBtn" class="btn">Download report (CSV)</button>` : ""}
    </div>`;
}

$("reviewBox").addEventListener("change", (e) => {
  if (e.target.id !== "overwriteChk" || !S.reviewed) return;
  S.overwrite = e.target.checked;
  S.reviewed.rows = buildRows(S.reviewed.draft);
  renderReview();
});

$("reviewBox").addEventListener("click", (e) => {
  if (e.target.id === "reportBtn" && S.reviewed) downloadCsv(reportRows(S.reviewed.rows), "allocation-report.csv");
  if (e.target.id === "confirmBtn") confirmAllocation();
});

async function confirmAllocation() {
  if (!S.reviewed || S.busy) return;
  const { draft, rows } = S.reviewed;
  const n = summarize(rows).ready;
  if (!window.confirm(`Allocate ${n} student(s) to ${draft.subject} (${draft.teacher}), line ${draft.line}?`)) return;

  setBusy(true);
  say("reviewMsg", "Saving…", "warn");
  try {
    const res = await applyAllocation({ draft, rows, user: S.user });
    const done = new Map(res.updated.map((r) => [r.adminNo, patchStudent(r.student, buildEnrollment(draft, r.student))]));
    S.roster = S.roster.map((s) => done.get(String(s.adminNo)) || s);
    patchCachedStudents([...done.values()]); // one cache write for the whole batch
    S.reviewed = null;
    $("reviewBox").innerHTML = "";
    say("reviewMsg", "");
    renderResult(draft, res);
  } catch (err) {
    console.error(err);
    say("reviewMsg", `Nothing was saved: ${err.message}`, "err");
  } finally {
    setBusy(false);
  }
}

/* ---------- result ---------- */
function renderResult(draft, res) {
  const problems = [...res.skipped, ...res.failed];
  const rerun = res.skipped.filter((r) => r.code === "same-subject");
  const cls = res.status === "completed" ? "ok" : "warn";
  $("resultBox").innerHTML = `
    <p class="plan-msg ${cls}">${res.updated.length} student(s) allocated to ${esc(draft.subject)} · ${problems.length} not allocated
      (${esc(res.status)}). Log ID: <span class="mono">${esc(res.logId)}</span></p>
    ${problems.length ? reportTable(problems) : ""}
    <div class="btn-row" style="margin-top:12px">
      ${problems.length ? `<button type="button" id="resReportBtn" class="btn">Download report (CSV)</button>` : ""}
      ${rerun.length ? `<button type="button" id="rerunBtn" class="btn btn-primary">Re-run ${rerun.length} already-allocated student(s) with overwrite</button>` : ""}
    </div>`;
  $("resultBox").dataset.rerun = JSON.stringify(rerun.map((r) => r.adminNo));
  $("resultBox")._problems = problems;
}

$("resultBox").addEventListener("click", (e) => {
  if (e.target.id === "resReportBtn") downloadCsv($("resultBox")._problems, "allocation-report.csv");
  if (e.target.id === "rerunBtn") {
    const ids = JSON.parse($("resultBox").dataset.rerun || "[]");
    S.draft = { ...S.draft, selected: ids };
    S.overwrite = true;
    $("resultBox").innerHTML = "";
    renderStudents();
    review(); // subject, teacher and line are still set; the roster is re-fetched first
  }
});
