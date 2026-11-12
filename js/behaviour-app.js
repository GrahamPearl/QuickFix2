/**
 * behaviour-app.js — controller for behaviour.html.
 * Permissions (usertypes.json): addBehaviour (record), viewBehaviour (ledger, frequency),
 * manageBehaviour (void, detentions), adminBehaviour (see "serious" entries). UI only: Rules enforce the same.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import { logAudit } from "./audit-service.js";
import * as F from "./behaviour-form.js";
import * as S from "./behaviour-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const opts = (list) => list.map((x) => `<option value="${esc(x.key ?? x)}">${esc(x.label ?? x)}</option>`).join("");
const audit = (action, n, note) => logAudit({ action, source: "behaviour-page", count: n, note }).catch(() => {});

let me, P = {}, roster = [], byAdmin = new Map(), pick = null, ledger = [];

const g = await guardCurrentPage();
if (g) {
  me = g.user;
  P = { add: can(g.cfg, g.type, "addBehaviour"), view: can(g.cfg, g.type, "viewBehaviour"),
        manage: can(g.cfg, g.type, "manageBehaviour"), serious: can(g.cfg, g.type, "adminBehaviour") };
  try {
    roster = (await getAllStudents()).filter((s) => s?.adminNo);
    roster.forEach((s) => byAdmin.set(String(s.adminNo), s));
    $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
    $("userBadge").textContent = me.email; $("userBadge").classList.remove("is-hidden");
    document.querySelector('[data-tab="ledger"]').classList.toggle("is-hidden", !P.view);
    document.querySelector('[data-tab="report"]').classList.toggle("is-hidden", !P.view);
    document.querySelector('[data-tab="detention"]').classList.toggle("is-hidden", !P.manage);
    $("fType").innerHTML = opts(F.TYPES);
    $("fSev").innerHTML = opts(F.SEVERITIES); // everyone may record serious; only head/admin can read it back
    $("fDate").value = F.todayIso(); $("dDate").value = F.todayIso();
    $("lFrom").value = F.daysAgoIso(14); $("lTo").value = F.todayIso();
    $("lType").innerHTML = `<option value="">All types</option>` + opts(F.TYPES);
    $("rType").innerHTML = `<option value="">All types</option>` + opts(F.TYPES);
    fillCats(); await loadMine();
  } catch (err) { $("gate").style.display = "flex"; $("gate").innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== t.dataset.tab));
  if (t.dataset.tab === "detention" && !$("dBody").children.length) loadDet();
  if (t.dataset.tab === "report") renderReport();
}));

/* ---------- record ---------- */
function fillCats() { $("fCat").innerHTML = opts(F.CATEGORIES[$("fType").value] || []); }

$("fType").addEventListener("change", fillCats);

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
  const d = { type: $("fType").value, category: $("fCat").value, severity: $("fSev").value, occurredOn: $("fDate").value, note: $("fNote").value };
  const problems = F.validateEntry(d, pick);
  if (problems.length) return say("capMsg", problems.join(" · "), "err");
  $("saveBtn").disabled = true;
  try {
    await S.addEntry(F.buildEntry(d, pick), me);
    say("capMsg", `Saved for ${pick.firstName} ${pick.lastName}.`, "ok");
    $("fNote").value = ""; pick = null; $("stuPicked").textContent = "No learner selected.";
    await loadMine();
  } catch (err) { say("capMsg", `Could not save: ${err.message}`, "err"); }
  finally { $("saveBtn").disabled = false; }
});

async function loadMine() {
  try {
    const rows = await S.listMine(me);
    $("mineBody").innerHTML = rows.map((r) => `<tr><td>${esc(r.occurredOn)}</td><td>${esc(r.studentName)}</td><td>${esc(F.label(F.TYPES, r.type))}</td><td>${esc(r.category)}</td><td>${esc(r.status)}</td></tr>`).join("") ||
      `<tr><td colspan="5" class="empty-hint">Nothing recorded in the last 24 hours.</td></tr>`;
  } catch (err) { $("mineBody").innerHTML = `<tr><td colspan="5" class="error-text">${esc(err.message)}</td></tr>`; }
}

/* ---------- ledger ---------- */
function renderLedger() {
  const t = $("lType").value, q = $("lText").value.trim().toLowerCase();
  const list = ledger.filter((r) => (!t || r.type === t) && (!q || `${r.studentName} ${r.adminNo}`.toLowerCase().includes(q)));
  $("lMsg").textContent = `${list.length} of ${ledger.length} entries shown.`;
  $("lBody").innerHTML = list.map((r) => `<tr class="${r.status === "voided" ? "is-unselected" : ""}">
    <td>${esc(r.occurredOn)}</td><td>${esc(r.studentName)} <span class="empty-hint mono">${esc(r.adminNo)}</span></td>
    <td>${esc(F.label(F.TYPES, r.type))}</td><td>${esc(r.category)}</td><td>${esc(r.severity)}</td>
    <td class="student-sub">${esc(r.note)}${r.status === "voided" ? `<br>Voided: ${esc(r.voidedReason)}` : ""}</td>
    <td class="student-sub">${esc(r.recordedByEmail)}</td>
    <td>${P.manage && r.status === "active" ? `<button type="button" class="btn btn-ghost" data-void="${esc(r.id)}">Void</button>` : ""}</td></tr>`).join("") ||
    `<tr><td colspan="8" class="empty-hint">No entries.</td></tr>`;
}
$("lLoad").addEventListener("click", async () => {
  say("lMsg", "Loading…", "warn");
  try { ledger = await S.listLedger({ from: $("lFrom").value, to: $("lTo").value, canSeeSerious: P.serious }); renderLedger(); }
  catch (err) { say("lMsg", `Could not load: ${err.message}`, "err"); }
});
["lType", "lText"].forEach((i) => $(i).addEventListener("input", renderLedger));
$("lBody").addEventListener("click", async (e) => {
  const id = e.target.dataset.void; if (!id || !P.manage) return;
  const reason = (prompt("Reason for voiding this entry (required):") || "").trim(); if (!reason) return;
  try {
    await S.voidEntry(id, reason, me);
    const r = ledger.find((x) => x.id === id); Object.assign(r, { status: "voided", voidedReason: reason });
    audit("behaviour.void", 1, `${r.adminNo} ${r.type}/${r.category}`); renderLedger();
  } catch (err) { say("lMsg", `Could not void: ${err.message}`, "err"); }
});

/* ---------- frequency ---------- */
function renderReport() {
  const rows = F.frequency(ledger, { type: $("rType").value, min: Number($("rMin").value) || 1 });
  $("rBody").innerHTML = rows.map((x) => `<tr><td>${esc(x.name)} <span class="empty-hint mono">${esc(x.adminNo)}</span></td><td>${esc(x.cls)}</td><td class="num">${x.total}</td>
    <td class="student-sub">${Object.entries(x.cats).map(([c, n]) => `${esc(c)} ${n}`).join(", ")}</td></tr>`).join("") ||
    `<tr><td colspan="4" class="empty-hint">${ledger.length ? "No learners at that level." : "Load a period on the Ledger tab first."}</td></tr>`;
}
["rType", "rMin"].forEach((i) => $(i).addEventListener("input", renderReport));

/* ---------- detentions ---------- */
async function loadDet() {
  try {
    const rows = await S.listDetentions(F.daysAgoIso(7));
    $("dBody").innerHTML = rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.studentName)} <span class="empty-hint mono">${esc(r.adminNo)}</span></td><td>${esc(r.venue)}</td><td>${esc(r.reason)}</td>
      <td><select data-det="${esc(r.id)}">${F.DETENTION_STATUS.map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("") ||
      `<tr><td colspan="5" class="empty-hint">No detentions from the last 7 days onward.</td></tr>`;
  } catch (err) { say("dMsg", `Could not load: ${err.message}`, "err"); }
}
$("dLoad").addEventListener("click", loadDet);
$("dBody").addEventListener("change", async (e) => {
  const id = e.target.dataset.det; if (!id || !P.manage) return;
  try { await S.setDetention(id, { status: e.target.value }, me); audit("behaviour.detention", 1, `${id} → ${e.target.value}`); }
  catch (err) { say("dMsg", `Could not update: ${err.message}`, "err"); loadDet(); }
});
$("dSave").addEventListener("click", async () => {
  if (!P.manage) return;
  const ids = [...new Set($("dAdm").value.split(/[\s,;]+/).filter(Boolean).map((v) => v.padStart(5, "0")))];
  const found = ids.map((a) => byAdmin.get(a)).filter(Boolean), missing = ids.filter((a) => !byAdmin.has(a));
  if (!found.length) return say("dMsg", "No valid admin numbers.", "err");
  if (!$("dDate").value || !$("dReason").value.trim()) return say("dMsg", "Enter a date and a reason.", "err");
  try {
    await S.addDetentions(found.map((s) => ({
      adminNo: String(s.adminNo), studentName: s.fullName || `${s.firstName} ${s.lastName}`.trim(), grade: Number(s.grade) || null, class: F.clsOf(s),
      date: $("dDate").value, venue: $("dVenue").value.trim(), reason: $("dReason").value.trim(), parentNotifiedOn: $("dParent").value || "",
    })), me);
    audit("behaviour.detention", found.length, `scheduled ${$("dDate").value}`);
    say("dMsg", `${found.length} scheduled.${missing.length ? ` Not found: ${missing.join(", ")}.` : ""}`, missing.length ? "warn" : "ok");
    $("dAdm").value = ""; loadDet();
  } catch (err) { say("dMsg", `Could not schedule: ${err.message}`, "err"); }
});