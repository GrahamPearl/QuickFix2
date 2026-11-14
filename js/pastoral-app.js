/**
 * pastoral-app.js — controller for pastoral.html.
 * Permissions (usertypes.json): addPastoral (record), viewPastoral + managePastoral (review, change status). UI only: Rules enforce the same.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import { logAudit } from "./audit-service.js";
import * as F from "./pastoral-form.js";
import * as S from "./pastoral-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const opts = (l) => l.map((x) => `<option value="${esc(x.key ?? x)}">${esc(x.label ?? x)}</option>`).join("");
const audit = (action, note) => logAudit({ action, source: "pastoral-page", count: 1, note }).catch(() => {});

let me, P = {}, roster = [], byAdmin = new Map(), pick = null, list = [];

const g = await guardCurrentPage();
if (g) {
  me = g.user;
  P = { add: can(g.cfg, g.type, "addPastoral"), review: can(g.cfg, g.type, "viewPastoral"), manage: can(g.cfg, g.type, "managePastoral") };
  try {
    roster = (await getAllStudents()).filter((s) => s?.adminNo);
    roster.forEach((s) => byAdmin.set(String(s.adminNo), s));
    $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
    $("userBadge").textContent = me.email; $("userBadge").classList.remove("is-hidden");
    document.querySelector('[data-tab="review"]').classList.toggle("is-hidden", !P.review);
    $("fKind").innerHTML = opts(F.KINDS); $("fUrg").innerHTML = opts(F.URGENCY);
    $("rKind").innerHTML = `<option value="">All types</option>` + opts(F.KINDS);
    fillCats(); await loadMine();
  } catch (err) { $("gate").style.display = "flex"; $("gate").innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== t.dataset.tab));
}));

function fillCats() {
  const k = $("fKind").value;
  $("fCat").innerHTML = opts(F.CATEGORIES[k] || []);
  $("revWrap").classList.toggle("is-hidden", k !== "atrisk");
}
$("fKind").addEventListener("change", fillCats);

$("stuSearch").addEventListener("input", () => {
  const term = $("stuSearch").value.trim();
  if (term.length < 2) { $("stuMatches").innerHTML = ""; return; }
  $("stuMatches").innerHTML = sortStudents(filterStudents(roster, { term, field: "auto" })).slice(0, 8).map((s) =>
    `<button type="button" class="btn btn-ghost" style="display:block;width:100%;text-align:left" data-adm="${esc(s.adminNo)}">${esc(s.lastName)}, ${esc(s.firstName)} · Gr ${esc(s.grade)} · ${esc(F.clsOf(s))} · <span class="mono">${esc(s.adminNo)}</span></button>`).join("");
});
$("stuMatches").addEventListener("click", (e) => {
  const b = e.target.closest("[data-adm]"); if (!b) return;
  pick = byAdmin.get(b.dataset.adm);
  $("stuPicked").textContent = `${pick.lastName}, ${pick.firstName} · Gr ${pick.grade} · ${F.clsOf(pick)} · ${pick.adminNo}`;
  $("stuMatches").innerHTML = ""; $("stuSearch").value = "";
});

$("saveBtn").addEventListener("click", async () => {
  if (!P.add) return;
  const d = { kind: $("fKind").value, category: $("fCat").value, urgency: $("fUrg").value, note: $("fNote").value, reviewDate: $("fRev").value };
  const problems = F.validateEntry(d, pick);
  if (problems.length) return say("capMsg", problems.join(" · "), "err");
  $("saveBtn").disabled = true;
  try {
    await S.addEntry(F.buildEntry(d, pick), me);
    say("capMsg", `Saved for ${pick.firstName} ${pick.lastName}.`, "ok");
    $("fNote").value = ""; $("fRev").value = ""; pick = null; $("stuPicked").textContent = "No learner selected.";
    await loadMine();
  } catch (err) { say("capMsg", `Could not save: ${err.message}`, "err"); }
  finally { $("saveBtn").disabled = false; }
});

async function loadMine() {
  try {
    const rows = await S.listMine(me);
    $("mineBody").innerHTML = rows.map((r) => `<tr><td>${esc(r.studentName)}</td><td>${esc(F.label(F.KINDS, r.kind))}</td><td>${esc(r.category)}</td><td>${esc(r.status)}</td></tr>`).join("") ||
      `<tr><td colspan="4" class="empty-hint">Nothing recorded in the last 24 hours.</td></tr>`;
  } catch (err) { $("mineBody").innerHTML = `<tr><td colspan="4" class="error-text">${esc(err.message)}</td></tr>`; }
}

/* ---------- review ---------- */
function renderReview() {
  const k = $("rKind").value, q = $("rText").value.trim().toLowerCase(), today = F.todayIso();
  const rows = list.filter((r) => (!k || r.kind === k) && (!q || `${r.studentName} ${r.adminNo}`.toLowerCase().includes(q)));
  $("rMsg").textContent = `${rows.length} of ${list.length} entries shown.`;
  $("rBody").innerHTML = rows.map((r) => `<tr class="${r.urgency === "urgent" && r.status !== "closed" ? "warnrow" : ""}">
    <td>${esc(r.studentName)} <span class="empty-hint mono">${esc(r.adminNo)} · ${esc(r.class)}</span></td>
    <td>${esc(F.label(F.KINDS, r.kind))}<br><span class="student-sub">${esc(r.category)}</span></td><td>${esc(r.urgency)}</td>
    <td class="student-sub">${esc(r.note)}${r.managerNote ? `<br>Outcome: ${esc(r.managerNote)}` : ""}</td>
    <td class="${r.reviewDate && r.reviewDate < today && r.status !== "closed" ? "err" : ""}">${esc(r.reviewDate || "")}</td>
    <td class="student-sub">${esc(r.recordedByEmail)}</td>
    <td>${P.manage ? `<select data-id="${esc(r.id)}">${F.STATUSES.map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select>` : esc(r.status)}</td></tr>`).join("") ||
    `<tr><td colspan="7" class="empty-hint">No entries.</td></tr>`;
}
$("rLoad").addEventListener("click", async () => {
  say("rMsg", "Loading…", "warn");
  try { list = await S.listReview($("rGroup").value); renderReview(); }
  catch (err) { say("rMsg", `Could not load: ${err.message}`, "err"); }
});
["rKind", "rText"].forEach((i) => $(i).addEventListener("input", renderReview));
$("rBody").addEventListener("change", async (e) => {
  const id = e.target.dataset.id; if (!id || !P.manage) return;
  const r = list.find((x) => x.id === id), status = e.target.value, patch = { status };
  if (status === "closed") {
    const note = (prompt("Outcome / how this was resolved (required):") || "").trim();
    if (!note) { e.target.value = r.status; return; }
    patch.managerNote = note.slice(0, 300);
  }
  try {
    await S.updateEntry(id, patch, me); Object.assign(r, patch);
    audit("pastoral.status", `${r.kind} ${r.adminNo} → ${status}`); say("rMsg", "Updated.", "ok");
  } catch (err) { say("rMsg", `Could not update: ${err.message}`, "err"); e.target.value = r.status; }
});