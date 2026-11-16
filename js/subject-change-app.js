/**
 * subject-change-app.js — controller for subject-change.html.
 * Permissions: requestSubjectChange (submit, see own), manageSubjectChange (review, approve and apply, decline).
 * Approval updates students/{adminNo} through student-write-service (audit + snapshot in the same batch), so the
 * reviewer also needs the Rules' canEditStudents (admin, staff-head, staff-gc). UI only: Rules enforce the same.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { deleteField, serverTimestamp } from "./firebase-init.js";
import { getAllStudents, collectSubjects, collectTeachers, patchCachedStudent } from "./data-service.js";
import { saveStudents } from "./student-write-service.js";
import { subjectKey } from "./edit-form.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import * as S from "./subject-change-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
const MAX_LINE = 10;

let me, P = {}, roster = [], byAdmin = new Map(), pick = null, list = [];

const g = await guardCurrentPage();
if (g) {
  me = g.user;
  P = { req: can(g.cfg, g.type, "requestSubjectChange"), manage: can(g.cfg, g.type, "manageSubjectChange") };
  try {
    roster = (await getAllStudents()).filter((s) => s?.adminNo);
    roster.forEach((s) => byAdmin.set(String(s.adminNo), s));
    $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
    $("userBadge").textContent = me.email; $("userBadge").classList.remove("is-hidden");
    document.querySelector('[data-tab="review"]').classList.toggle("is-hidden", !P.manage);
    $("fTo").innerHTML = `<option value="">— Drop the subject —</option>` + collectSubjects(roster).map((s) => `<option>${esc(s)}</option>`).join("");
    await loadMine();
  } catch (err) { $("gate").style.display = "flex"; $("gate").innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== t.dataset.tab));
}));

/* ---------- request ---------- */
$("stuSearch").addEventListener("input", () => {
  const term = $("stuSearch").value.trim();
  if (term.length < 2) { $("stuMatches").innerHTML = ""; return; }
  $("stuMatches").innerHTML = sortStudents(filterStudents(roster, { term, field: "auto" })).slice(0, 8).map((s) =>
    `<button type="button" class="btn btn-ghost" style="display:block;width:100%;text-align:left" data-adm="${esc(s.adminNo)}">${esc(s.lastName)}, ${esc(s.firstName)} · Gr ${esc(s.grade)} · ${esc(clsOf(s))} · <span class="mono">${esc(s.adminNo)}</span></button>`).join("");
});
$("stuMatches").addEventListener("click", (e) => {
  const b = e.target.closest("[data-adm]"); if (!b) return;
  pick = byAdmin.get(b.dataset.adm);
  $("stuPicked").textContent = `${pick.lastName}, ${pick.firstName} · Gr ${pick.grade} · ${clsOf(pick)} · ${pick.adminNo}`;
  $("fFrom").innerHTML = (pick.subjectsSummary || []).map((s) => `<option>${esc(s)}</option>`).join("") || `<option value="">No subjects on file</option>`;
  $("stuMatches").innerHTML = ""; $("stuSearch").value = "";
});

$("reqBtn").addEventListener("click", async () => {
  if (!P.req) return;
  const from = $("fFrom").value, to = $("fTo").value, reason = $("fReason").value.trim();
  const p = [];
  if (!pick) p.push("Choose a learner");
  if (!from) p.push("Choose the current subject");
  if (to && to === from) p.push("The new subject is the same as the current one");
  if (to && (pick?.subjectsSummary || []).includes(to)) p.push("The learner already takes that subject");
  if (!reason) p.push("Give a reason");
  if (p.length) return say("reqMsg", p.join(" · "), "err");
  $("reqBtn").disabled = true;
  try {
    await S.createRequest({
      adminNo: String(pick.adminNo), studentName: pick.fullName || `${pick.firstName} ${pick.lastName}`.trim(),
      grade: Number(pick.grade) || null, class: clsOf(pick), fromSubject: from, toSubject: to, reason,
    }, me);
    say("reqMsg", `Request submitted for ${pick.firstName} ${pick.lastName}.`, "ok");
    $("fReason").value = ""; pick = null; $("stuPicked").textContent = "No learner selected."; $("fFrom").innerHTML = "";
    await loadMine();
  } catch (err) { say("reqMsg", `Could not submit: ${err.message}`, "err"); }
  finally { $("reqBtn").disabled = false; }
});

const change = (r) => `${esc(r.fromSubject)} → ${r.toSubject ? esc(r.toSubject) : "<em>drop</em>"}`;
async function loadMine() {
  try {
    const rows = await S.listMine(me);
    $("mineBody").innerHTML = rows.map((r) => `<tr><td>${esc(r.studentName)}</td><td>${change(r)}</td>
      <td>${esc(r.status)}${r.declineReason ? `<br><span class="student-sub">${esc(r.declineReason)}</span>` : ""}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="empty-hint">No requests yet.</td></tr>`;
  } catch (err) { $("mineBody").innerHTML = `<tr><td colspan="3" class="error-text">${esc(err.message)}</td></tr>`; }
}

/* ---------- review ---------- */
function renderReview() {
  const pending = $("rStatus").value === "pending";
  $("rBody").innerHTML = list.map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(r.studentName)} <span class="empty-hint mono">${esc(r.adminNo)} · ${esc(r.class)}</span></td>
    <td>${change(r)}</td><td class="student-sub">${esc(r.reason)}</td><td class="student-sub">${esc(r.requestedByEmail)}</td>
    <td>${pending && P.manage ? `${r.toSubject ? `<input type="text" data-teacher list="teacherList" placeholder="Teacher" style="width:130px" />
        <input type="number" data-line min="1" max="${MAX_LINE}" placeholder="Line" style="width:70px" />` : ""}
      <button type="button" class="btn btn-primary" data-act="approve">Approve</button>
      <button type="button" class="btn btn-ghost" data-act="decline">Decline</button>`
      : `${esc(r.status)}${r.declineReason ? `<br><span class="student-sub">${esc(r.declineReason)}</span>` : ""}`}</td></tr>`).join("") ||
    `<tr><td colspan="5" class="empty-hint">Nothing here.</td></tr>`;
}
$("rLoad").addEventListener("click", async () => {
  say("rMsg", "Loading…", "warn");
  try { list = await S.listByStatus($("rStatus").value); renderReview(); say("rMsg", `${list.length} request(s).`); }
  catch (err) { say("rMsg", `Could not load: ${err.message}`, "err"); }
});
$("rBody").addEventListener("focusin", (e) => {
  if (!e.target.matches("[data-teacher]")) return;
  const r = list.find((x) => x.id === e.target.closest("tr").dataset.id);
  $("teacherList").innerHTML = collectTeachers(roster, r.toSubject).map((t) => `<option value="${esc(t)}">`).join("");
});

/** Moves the learner between subjects with field-path updates (other enrollments untouched). */
async function applyChange(r, teacher, line) {
  const before = byAdmin.get(r.adminNo);
  if (!before) throw new Error("Learner is no longer on the roster.");
  const fk = subjectKey(r.fromSubject), after = structuredClone(before);
  if (!(after.subjectsSummary || []).includes(r.fromSubject)) throw new Error(`The learner no longer takes ${r.fromSubject}. Decline this request.`);
  after.enrollments ||= {}; delete after.enrollments[fk];
  after.subjectsSummary = after.subjectsSummary.filter((s) => s !== r.fromSubject);
  const fields = { [`enrollments.${fk}`]: deleteField() };
  if (r.toSubject) {
    const tk = subjectKey(r.toSubject), n = Number(line);
    if (after.subjectsSummary.includes(r.toSubject)) throw new Error("The learner already takes the new subject.");
    if (!teacher) throw new Error("Enter the teacher.");
    if (!Number.isInteger(n) || n < 1 || n > MAX_LINE) throw new Error(`Enter a line from 1 to ${MAX_LINE}.`);
    if (Object.values(after.enrollments).some((e) => Number(e?.line) === n)) throw new Error(`Line ${n} is already used by another subject.`);
    const en = { subject: r.toSubject, teacher, line: n };
    after.enrollments[tk] = en; after.subjectsSummary.push(r.toSubject); fields[`enrollments.${tk}`] = en;
  }
  fields.subjectsSummary = after.subjectsSummary;
  const { failed } = await saveStudents([{ adminNo: r.adminNo, before, after, fields }],
    { action: "student.subject-change", source: "subject-change-page", note: `${r.fromSubject} → ${r.toSubject || "dropped"}` });
  if (failed.length) throw failed[0].error;
  patchCachedStudent(after); byAdmin.set(r.adminNo, after);
}

$("rBody").addEventListener("click", async (e) => {
  const act = e.target.dataset.act; if (!act || !P.manage) return;
  const tr = e.target.closest("tr"), r = list.find((x) => x.id === tr.dataset.id);
  e.target.disabled = true;
  try {
    if (act === "decline") {
      const reason = (prompt("Reason for declining (required):") || "").trim();
      if (!reason) { e.target.disabled = false; return; }
      await S.decide(r.id, "declined", { declineReason: reason.slice(0, 200) }, me);
    } else {
      const teacher = tr.querySelector("[data-teacher]")?.value.trim() || "", line = tr.querySelector("[data-line]")?.value || "";
      await applyChange(r, teacher, line);
      try { await S.decide(r.id, "approved", { newTeacher: teacher, newLine: line ? Number(line) : null, appliedAt: serverTimestamp() }, me); }
      catch (err) { say("rMsg", `Enrolment updated, but the request could not be marked approved: ${err.message}`, "warn"); return; }
    }
    list = list.filter((x) => x.id !== r.id); renderReview(); say("rMsg", act === "approve" ? "Approved and enrolment updated." : "Declined.", "ok");
  } catch (err) { e.target.disabled = false; say("rMsg", err.message, "err"); }
});