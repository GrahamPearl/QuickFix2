/**
 * textbooks-app.js — controller for textbooks.html.
 * Permissions (usertypes.json): viewTextbooks (open page, search), captureTextbooks (add books/titles, issue, return),
 * manageTextbooks (correct status, import). UI only: Firestore Rules enforce the same.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import { logAudit } from "./audit-service.js";
import * as F from "./textbooks-form.js";
import * as S from "./textbooks-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const opts = (l, f = (x) => x) => l.map((x) => `<option value="${esc(x.v ?? x)}">${esc(f(x))}</option>`).join("");
const low = (v) => String(v || "").toLowerCase();

let me, P = {}, roster = [], byAdmin = new Map(), titles = [], learner = null, lines = [], rows = [], classBooks = [];

const g = await guardCurrentPage();
if (g) {
  me = g.user;
  P = { add: can(g.cfg, g.type, "captureTextbooks"), manage: can(g.cfg, g.type, "manageTextbooks") };
  try {
    roster = (await getAllStudents()).filter((s) => s?.adminNo);
    roster.forEach((s) => byAdmin.set(String(s.adminNo), s));
    titles = await S.listTitles();
    $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
    $("userBadge").textContent = me.email; $("userBadge").classList.remove("is-hidden");
    $("outcome").innerHTML = F.OUTCOMES.map((o) => `<option value="${o.key}">${esc(o.label)}</option>`).join("");
    $("aCond").innerHTML = opts(F.CONDITIONS); $("bStatus").innerHTML = opts(F.STATUSES);
    $("tGrade").innerHTML = opts(F.GRADES, (x) => `Grade ${x}`);
    $("cGrade").innerHTML = opts(F.GRADES, (x) => `Grade ${x}`);
    $("aTeacher").value = me.email; $("bValue").value = me.email;
    ["aSave", "tSave", "aCodes", "tTitle"].forEach((i) => ($(i).disabled = !P.add));
    $("cApply").disabled = !P.manage;
    fillTitles(); fillClasses(); $("scanIn").focus();
  } catch (err) { $("gate").style.display = "flex"; $("gate").innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== t.dataset.tab));
}));

function fillTitles() {
  const tl = (t) => `${t.title} (Gr ${t.grade})`;
  $("aTitle").innerHTML = `<option value="">Choose a title…</option>` + titles.map((t) => `<option value="${esc(t.id)}">${esc(tl(t))}</option>`).join("");
  $("bTitle").innerHTML = $("aTitle").innerHTML;
  $("subjList").innerHTML = [...new Set(titles.map((t) => t.subject))].map((s) => `<option value="${esc(s)}">`).join("");
  $("tBody").innerHTML = titles.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.subject)}</td><td>${esc(t.grade)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty-hint">No titles yet.</td></tr>`;
}

/* ---------- issue / return ---------- */
$("mode").addEventListener("change", () => {
  const ret = $("mode").value === "return";
  $("outcome").classList.toggle("is-hidden", !ret); $("learnerBox").classList.toggle("is-hidden", ret); $("scanIn").focus();
});
$("stuSearch").addEventListener("input", () => {
  const term = $("stuSearch").value.trim();
  if (term.length < 2) { $("stuMatches").innerHTML = ""; return; }
  $("stuMatches").innerHTML = sortStudents(filterStudents(roster, { term, field: "auto" })).slice(0, 8).map((s) =>
    `<button type="button" class="btn btn-ghost" style="display:block;width:100%;text-align:left" data-adm="${esc(s.adminNo)}">${esc(s.lastName)}, ${esc(s.firstName)} · Gr ${esc(s.grade)} · ${esc(F.clsOf(s))} · <span class="mono">${esc(s.adminNo)}</span></button>`).join("");
});
$("stuMatches").addEventListener("click", (e) => {
  const b = e.target.closest("[data-adm]"); if (!b) return;
  learner = byAdmin.get(b.dataset.adm);
  $("stuPicked").textContent = `${learner.lastName}, ${learner.firstName} · Gr ${learner.grade} · ${F.clsOf(learner)} · ${learner.adminNo}`;
  $("stuMatches").innerHTML = ""; $("stuSearch").value = ""; $("scanIn").focus();
});
const log = (ok, text) => { lines.unshift(`<tr class="${ok ? "" : "bad"}"><td>${ok ? "✓" : "✗"} ${esc(text)}</td></tr>`); $("scanLog").innerHTML = lines.slice(0, 40).join(""); };

$("scanIn").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const code = F.normCode($("scanIn").value); if (!code) return;
  if (!P.add) return say("scanMsg", "You do not have permission to issue or return books.", "err");
  const ret = $("mode").value === "return";
  if (!ret && !learner) return say("scanMsg", "Choose a learner first.", "warn");
  $("scanIn").value = ""; say("scanMsg", "");
  try {
    if (ret) { const b = await S.returnBook(code, $("outcome").value, me); log(true, `${code} · ${F.bookLabel(b)} returned by ${b.formerName}${b.status === "lost" ? " (marked lost)" : ""}`); }
    else {
      const b = await S.issueBook(code, learner, me);
      log(true, `${code} · ${F.bookLabel(b)} issued to ${b.issuedName}${Number(b.grade) !== Number(learner.grade) ? ` · cross-grade loan (learner Gr ${learner.grade})` : ""}`);
    }
  } catch (err) { log(false, `${code} · ${err.message}`); }
  $("scanIn").focus();
});

/* ---------- titles ---------- */
$("tSave").addEventListener("click", async () => {
  const t = { title: $("tTitle").value, subject: $("tSubject").value, grade: $("tGrade").value };
  const p = F.validateTitle(t); if (p.length) return say("tMsg", p.join(" · "), "err");
  try { await S.addTitle(t, me); titles = await S.listTitles(); fillTitles(); $("tTitle").value = ""; say("tMsg", "Title added.", "ok"); }
  catch (err) { say("tMsg", err.message, "err"); }
});

/* ---------- books ---------- */
$("bMode").addEventListener("change", () => {
  const m = $("bMode").value;
  $("bTitle").classList.toggle("is-hidden", m !== "title"); $("bStatus").classList.toggle("is-hidden", m !== "status");
  $("bValue").classList.toggle("is-hidden", m === "title" || m === "status");
  $("bValue").value = m === "teacher" ? me.email : "";
});
$("aSave").addEventListener("click", async () => {
  const codes = F.parseCodes($("aCodes").value), title = titles.find((t) => t.id === $("aTitle").value);
  const p = F.validateBooks(codes, title, $("aTeacher").value); if (p.length) return say("aMsg", p.join(" · "), "err");
  $("aSave").disabled = true; say("aMsg", "Saving…", "warn");
  try {
    const r = await S.addBooks(codes, title, { teacher: $("aTeacher").value, condition: $("aCond").value }, me);
    say("aMsg", `${r.added} added.${r.skipped.length ? ` Already in the register: ${r.skipped.join(", ")}.` : ""}`, r.skipped.length ? "warn" : "ok");
    $("aCodes").value = "";
  } catch (err) { say("aMsg", `Could not save: ${err.message}`, "err"); }
  finally { $("aSave").disabled = !P.add; }
});
function renderBooks(list) {
  $("bBody").innerHTML = list.map((b) => `<tr><td class="mono">${esc(b.barcode)}</td><td>${esc(b.title)}</td><td>${esc(b.grade)}</td><td>${esc(b.subject)}</td><td>${esc(b.teacher)}</td><td>${esc(b.condition)}</td>
    <td>${P.manage && b.status !== "issued" ? `<select data-code="${esc(b.barcode)}">${["available", "lost", "damaged", "withdrawn"].map((s) => `<option ${s === b.status ? "selected" : ""}>${s}</option>`).join("")}</select>` : esc(b.status)}</td>
    <td class="student-sub">${b.status === "issued" ? `${esc(b.issuedName)} · ${esc(b.issuedClass)} · ${esc(b.currentAdminNo)}` : ""}</td></tr>`).join("") || `<tr><td colspan="8" class="empty-hint">No books found.</td></tr>`;
}
$("bLoad").addEventListener("click", async () => {
  const m = $("bMode").value, v = m === "title" ? $("bTitle").value : m === "status" ? $("bStatus").value : $("bValue").value.trim();
  if (!v) return say("bMsg", "Enter or choose a value to search for.", "warn");
  say("bMsg", "Loading…", "warn");
  try { const l = await S.listBooks(m, v); renderBooks(l); say("bMsg", `${l.length} book(s)${l.length >= 400 ? " (first 400 shown, narrow the search)" : ""}.`); }
  catch (err) { say("bMsg", `Could not load: ${err.message}`, "err"); }
});
$("bBody").addEventListener("change", async (e) => {
  const code = e.target.dataset.code; if (!code || !P.manage) return;
  try { await S.updateBook(code, { status: e.target.value }, me); say("bMsg", `${code} marked ${e.target.value}.`, "ok"); }
  catch (err) { say("bMsg", `Could not update: ${err.message}`, "err"); }
});

/* ---------- class lists: export / import ---------- */
const inClass = () => roster.filter((s) => String(s.grade) === $("cGrade").value && F.clsOf(s) === $("cClass").value).sort((a, b) => low(a.lastName).localeCompare(low(b.lastName)) || low(a.firstName).localeCompare(low(b.firstName)));
function fillClasses() {
  const cl = [...new Set(roster.filter((s) => String(s.grade) === $("cGrade").value).map(F.clsOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $("cClass").innerHTML = opts(cl);
}
$("cGrade").addEventListener("change", fillClasses);

function showClass() {
  const by = new Map(); classBooks.forEach((b) => by.set(b.currentAdminNo, [...(by.get(b.currentAdminNo) || []), b]));
  $("cBody").innerHTML = inClass().flatMap((s) => (by.get(String(s.adminNo)) || [null]).map((b) =>
    `<tr><td class="mono">${esc(s.adminNo)}</td><td>${esc(s.lastName)}, ${esc(s.firstName)}</td><td class="mono">${esc(b?.barcode || "")}</td><td>${esc(b ? F.bookLabel(b) : "")}</td><td>${b ? "issued" : "no book"}</td></tr>`)).join("");
}
$("cLoad").addEventListener("click", async () => {
  say("cMsg", "Loading…", "warn"); $("cApply").classList.add("is-hidden");
  try { classBooks = await S.listBooks("class", $("cClass").value); showClass(); say("cMsg", `${classBooks.length} book(s) issued to ${$("cClass").value}.`); }
  catch (err) { say("cMsg", `Could not load: ${err.message}`, "err"); }
});
$("cExport").addEventListener("click", () => {
  const by = new Map(); classBooks.forEach((b) => by.set(b.currentAdminNo, [...(by.get(b.currentAdminNo) || []), b]));
  const out = inClass().flatMap((s) => (by.get(String(s.adminNo)) || [null]).map((b) => ({
    ADMNO: s.adminNo, Surname: F.csvSafe(s.lastName), "First name": F.csvSafe(s.firstName), Class: F.clsOf(s), Grade: s.grade,
    BARCODE: b?.barcode || "", Title: b ? b.title : "", "Book grade": b ? b.grade : "", Subject: b?.subject || "", Teacher: b ? F.csvSafe(b.teacher) : "", "Issued on": b?.issuedOn || "",
  })));
  if (!out.length) return say("cMsg", "Choose a class first.", "warn");
  if (!classBooks.length) say("cMsg", "Tip: load the class first so existing books are included.", "warn");
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), "Textbooks");
  XLSX.writeFile(wb, `textbooks-${$("cClass").value}-${F.today()}.xlsx`);
});
$("cFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" }), raw = [], n = (c) => low(c).replace(/[^a-z]/g, "");
    wb.SheetNames.forEach((name) => {
      const d = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
      const hi = d.findIndex((r, i) => i < 20 && r.some((c) => n(c) === "admno") && r.some((c) => n(c) === "barcode")); if (hi < 0) return;
      const ia = d[hi].findIndex((c) => n(c) === "admno"), ib = d[hi].findIndex((c) => n(c) === "barcode");
      d.slice(hi + 1).forEach((r) => { const code = F.normCode(r[ib]); if (code) raw.push({ adm: String(r[ia] ?? "").trim().replace(/\.0$/, "").padStart(5, "0"), code }); });
    });
    if (!raw.length) return say("cMsg", "No rows with a BARCODE found. Check the ADMNO and BARCODE headers.", "err");
    say("cMsg", `Checking ${raw.length} barcode(s)…`, "warn");
    const codes = [...new Set(raw.map((r) => r.code))], books = new Map();
    for (let i = 0; i < codes.length; i += 20) (await Promise.all(codes.slice(i, i + 20).map(S.getBook))).forEach((b, k) => books.set(codes[i + k], b));
    rows = F.classifyImport(raw, byAdmin, books);
    const c = (s) => rows.filter((r) => r.status === s).length;
    $("cBody").innerHTML = rows.map((r) => `<tr class="${r.status === "error" ? "bad" : r.status === "conflict" ? "warnrow" : ""}"><td class="mono">${esc(r.adm)}</td><td>${esc(r.student ? `${r.student.lastName}, ${r.student.firstName}` : "—")}</td><td class="mono">${esc(r.code)}</td><td>${esc(r.book ? F.bookLabel(r.book) : "—")}</td><td>${esc(r.status === "ready" ? r.msg || "ready" : r.msg)}</td></tr>`).join("");
    say("cMsg", `${c("ready")} ready · ${c("same")} unchanged · ${c("conflict")} conflicts · ${c("error")} errors.`, c("error") || c("conflict") ? "warn" : "ok");
    $("cApply").classList.toggle("is-hidden", !c("ready")); $("cApply").textContent = `Issue ${c("ready")} book(s)`;
  } catch (err) { say("cMsg", `Could not read file: ${err.message}`, "err"); }
  e.target.value = "";
});
$("cApply").addEventListener("click", async () => {
  if (!P.manage) return;
  const todo = rows.filter((r) => r.status === "ready"); let ok = 0; const fail = [];
  $("cApply").disabled = true;
  for (const r of todo) { try { await S.issueBook(r.code, r.student, me); ok++; } catch (err) { fail.push(`${r.code}: ${err.message}`); } }
  logAudit({ action: "textbook.import", source: "textbooks-page", count: ok, note: `${ok} issued, ${fail.length} failed` }).catch(() => {});
  say("cMsg", `${ok} issued.${fail.length ? ` Failed: ${fail.join("; ")}` : ""}`, fail.length ? "warn" : "ok");
  $("cApply").classList.add("is-hidden"); $("cApply").disabled = false; rows = [];
});