/**
 * admin_import.js — page controller for admin_import.html.
 * Excel class lists (one sheet per registration class) -> students collection.
 * Flow: parse + review -> compare with Firestore -> mandatory backup -> batched write.
 * Needs permission "bulkImport" in usertypes.json. Real enforcement = Firestore Rules.
 */
import {
  auth, db, collection, doc, getDocs, writeBatch, addDoc, serverTimestamp, onAuthStateChanged,
} from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { clearRosterCache } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";

const $ = (id) => document.getElementById(id);
const COL = window.APP_CONFIG.STUDENTS_COLLECTION || "students";
const LOG_COL = "import-batches";
const BATCH = 400;
// Fields the spreadsheet owns. Everything else (subjects, teams, awards...) is left alone on existing docs.
const OWNED = ["id", "adminNo", "firstName", "lastName", "fullName", "grade", "class", "registrationClass",
  "gender", "birthdate", "agegroup", "photo", "searchTokens"];
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEAD = { admno: "adminNo", surname: "lastName", preferredname: "firstName", g: "gender", bdate: "birthdate", agegroup: "agegroup" };

const S = { user: null, file: "", rows: [], sheets: [], existing: new Map(), plan: [], orphans: [], backedUp: false, source: "xlsx" };

/* ---------- access ---------- */
function deny(msg) {
  $("app").classList.add("is-hidden");
  $("gate").style.display = "flex";
  $("gate").innerHTML = `<p class="error-text">${esc(msg)} <a href="index.html">Return to the roster</a></p>`;
}
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  try {
    const cfg = await loadUserTypes();
    if (!can(cfg, await resolveUserType(user, cfg), "bulkImport")) { deny("Access denied: administrators only."); return; }
    S.user = user;
    $("ageYear").value = new Date().getFullYear();
    $("colName").textContent = COL;
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
  } catch (err) { deny(`Could not verify access: ${err.message}`); }
});

/* ---------- parsing ---------- */
function fmtDate(v) {
  if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 43200000); return d.toISOString().slice(0, 10); }
  if (typeof v === "number") { const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : null; }
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
const ageGroup = (bd) => (bd ? `Under ${Number($("ageYear").value) - Number(bd.slice(0, 4))}` : "");

function buildRecord(sheet, r) {
  const adminNo = String(r.adminNo ?? "").trim().replace(/\.0$/, "").padStart(5, "0");
  const firstName = String(r.firstName ?? "").trim(), lastName = String(r.lastName ?? "").trim();
  const g = String(r.gender ?? "").trim().toUpperCase();
  const birthdate = fmtDate(r.birthdate);
  const grade = Number((sheet.match(/grade\s*(\d+)/i) || [])[1]) || null;
  const cls = (sheet.match(/\b(\d+[A-Z]+)\b/) || [])[1] || "";
  const errors = [];
  if (!/^\d{5}$/.test(adminNo)) errors.push("Admin no must be 5 digits");
  if (!firstName) errors.push("Missing preferred name");
  if (!lastName) errors.push("Missing surname");
  if (!/^[MF]/.test(g)) errors.push("Gender must be M or F");
  if (!birthdate) errors.push("Invalid birthdate");
  if (!grade || !cls) errors.push("Cannot read grade/class from sheet name");
  const low = (x) => x.toLowerCase();
  return {
    errors,
    rec: {
      id: adminNo, adminNo, firstName, lastName, fullName: `${firstName} ${lastName}`.trim(), grade, class: cls,
      registrationClass: sheet, gender: g.startsWith("M") ? "Male" : "Female", birthdate,
      agegroup: String(r.agegroup ?? "").trim() || ageGroup(birthdate), photo: `${adminNo}.webp`,
      searchTokens: [...new Set([adminNo, low(firstName), low(lastName), `${low(firstName)} ${low(lastName)}`.trim()])],
    },
  };
}
// Fields only given to brand-new students (match the sample_students.json layout).
const newDefaults = () => ({ subjectsSummary: [], enrollments: {}, teams: [], academic: { candidateNo: null, examNo: null }, flags: { concession: false } });

function parseWorkbook(wb) {
  const rows = [], sheets = [], seen = new Map();
  wb.SheetNames.forEach((name) => {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const hi = data.findIndex((r, i) => i < 20 && r.some((c) => norm(c) === "admno"));
    const sh = { name: name.trim(), count: 0, declared: null, issues: [] };
    sheets.push(sh);
    if (hi < 0) { sh.issues.push("No ADMNO header row found — sheet skipped"); return; }
    const cols = {};
    data[hi].forEach((c, i) => { if (HEAD[norm(c)]) cols[HEAD[norm(c)]] = i; });
    const miss = ["adminNo", "lastName", "firstName", "gender", "birthdate"].filter((k) => !(k in cols));
    if (miss.length) { sh.issues.push(`Missing columns: ${miss.join(", ")} — sheet skipped`); return; }
    data.slice(0, hi).forEach((r) => r.forEach((c, i) => { if (norm(c) === "total" && typeof r[i + 1] === "number") sh.declared = r[i + 1]; }));
    data.slice(hi + 1).forEach((r, k) => {
      if (r.every((c) => c === null || c === "")) return;
      const raw = {}; Object.entries(cols).forEach(([f, i]) => (raw[f] = r[i]));
      if (raw.adminNo === null || raw.adminNo === "") return;
      const { rec, errors } = buildRecord(sh.name, raw);
      if (seen.has(rec.id)) errors.push(`Duplicate of ${seen.get(rec.id)}`); else seen.set(rec.id, sh.name);
      rows.push({ sheet: sh.name, rowNo: hi + k + 2, rec, errors });
      sh.count++;
    });
    if (sh.declared !== null && sh.declared !== sh.count) sh.issues.push(`Sheet says ${sh.declared} students, ${sh.count} rows read`);
  });
  return { rows, sheets };
}

$("fileIn").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  resetFrom("review");
  try {
    S.file = f.name;
    if (f.name.toLowerCase().endsWith(".json")) {
      S.source = "json";
      const obj = JSON.parse(await f.text());
      const list = Array.isArray(obj) ? obj : Object.values(obj);
      S.rows = list.filter((s) => s && s.adminNo).map((s) => ({ sheet: s.registrationClass || "backup", rowNo: 0, rec: { ...s, id: String(s.adminNo) }, errors: [] }));
      S.sheets = [...new Set(S.rows.map((r) => r.sheet))].map((n) => ({ name: n, count: S.rows.filter((r) => r.sheet === n).length, issues: [] }));
    } else {
      S.source = "xlsx";
      Object.assign(S, parseWorkbook(XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true })));
    }
    showReview();
  } catch (err) { $("loadMsg").textContent = `Could not read file: ${err.message}`; }
});
$("ageYear").addEventListener("change", () => { if (S.source === "xlsx" && $("fileIn").files[0]) $("fileIn").dispatchEvent(new Event("change")); });

/* ---------- review table ---------- */
function showReview() {
  const bad = S.rows.filter((r) => r.errors.length).length;
  $("loadMsg").textContent = `${S.file}: ${S.sheets.length} worksheets, ${S.rows.length} students, ${bad} with problems.`;
  $("sheetSel").innerHTML = `<option value="">All worksheets (${S.rows.length})</option>` +
    S.sheets.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.count})${s.issues.length ? " ⚠" : ""}</option>`).join("");
  const warns = S.sheets.filter((s) => s.issues.length);
  $("sheetWarn").innerHTML = warns.map((s) => `<div class="warn-box"><strong>${esc(s.name)}:</strong> ${esc(s.issues.join("; "))}</div>`).join("");
  $("revCount").textContent = `(${S.rows.length} rows)`;
  $("reviewPanel").classList.remove("is-hidden");
  renderReview();
}
function renderReview() {
  const sh = $("sheetSel").value, q = $("rowFilter").value.trim().toLowerCase(), eo = $("errOnly").checked;
  $("revBody").innerHTML = S.rows.filter((r) =>
    (!sh || r.sheet === sh) && (!eo || r.errors.length) && (!q || `${r.rec.fullName} ${r.rec.adminNo}`.toLowerCase().includes(q)))
    .map(({ sheet, rec: s, errors }) => `<tr class="${errors.length ? "bad" : ""}"><td>${esc(sheet)}</td><td class="mono">${esc(s.adminNo)}</td>
      <td>${esc(s.firstName)}</td><td>${esc(s.lastName)}</td><td>${esc(s.grade)}</td><td>${esc(s.class)}</td><td>${esc(s.gender)}</td>
      <td>${esc(s.birthdate)}</td><td>${esc(s.agegroup)}</td><td>${errors.length ? esc(errors.join("; ")) : "OK"}</td></tr>`).join("");
}
["sheetSel", "rowFilter", "errOnly"].forEach((i) => $(i).addEventListener("input", renderReview));
$("reviewed").addEventListener("change", () => { resetFrom("mode"); $("modePanel").classList.toggle("is-hidden", !$("reviewed").checked); });

function resetFrom(step) {
  S.backedUp = false; S.plan = [];
  const order = ["review", "mode", "plan", "go"];
  order.slice(order.indexOf(step)).forEach((s) => $(s + "Panel").classList.add("is-hidden"));
  if (step === "review") $("reviewed").checked = false;
  $("planPanel").classList.add("is-hidden"); $("goPanel").classList.add("is-hidden");
  $("backupMsg").textContent = "Not downloaded yet."; $("savedOk").checked = false; $("savedOk").disabled = true;
  $("importMsg").textContent = ""; updateImportBtn();
}

/* ---------- compare ---------- */
const mode = () => document.querySelector('input[name="mode"]:checked').value;
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
  $("replaceOpts").classList.toggle("is-hidden", mode() !== "replace");
  $("typeRow").classList.toggle("is-hidden", mode() !== "replace");
  $("planPanel").classList.add("is-hidden"); $("goPanel").classList.add("is-hidden");
}));
const blank = (v) => v === undefined || v === null || v === "";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

$("compareBtn").addEventListener("click", async () => {
  $("compareBtn").disabled = true; $("cmpMsg").textContent = "Reading current students from Firestore…";
  try {
    const snap = await getDocs(collection(db, COL));
    S.existing = new Map(snap.docs.map((d) => [d.id, d.data()]));
    buildPlan();
    $("cmpMsg").textContent = `Firestore currently holds ${S.existing.size} students.`;
    $("planPanel").classList.remove("is-hidden"); $("goPanel").classList.remove("is-hidden");
    S.backedUp = false; $("savedOk").checked = false; $("savedOk").disabled = true; $("backupMsg").textContent = "Not downloaded yet.";
    updateImportBtn();
  } catch (err) { $("cmpMsg").textContent = `Could not read Firestore: ${err.message}`; }
  finally { $("compareBtn").disabled = false; }
});

function buildPlan() {
  const m = mode(), good = S.rows.filter((r) => !r.errors.length), ids = new Set(good.map((r) => r.rec.id));
  S.plan = good.map(({ rec }) => {
    const old = S.existing.get(rec.id);
    if (!old) return { id: rec.id, rec, kind: "new", data: { ...rec, ...(S.source === "json" ? {} : newDefaults()) }, details: "New student", on: true };
    const diffs = OWNED.filter((f) => !same(old[f], rec[f]) && rec[f] !== undefined);
    if (m === "replace") {
      return { id: rec.id, rec, kind: diffs.length ? "over" : "same", data: pick(rec, OWNED), details: diffs.map((f) => `${f}: ${show(old[f])} → ${show(rec[f])}`).join("; "), on: diffs.length > 0 };
    }
    const fillF = diffs.filter((f) => blank(old[f]));
    const data = pick(rec, fillF);
    Object.entries(newDefaults()).forEach(([k, v]) => { if (S.source !== "json" && old[k] === undefined) { data[k] = v; fillF.push(k); } });
    const conflicts = diffs.filter((f) => !blank(old[f])).map((f) => `${f}: ${show(old[f])} ≠ ${show(rec[f])}`);
    return { id: rec.id, rec, kind: fillF.length ? "fill" : "same", data,
      details: [fillF.length ? `Fills: ${fillF.join(", ")}` : "", conflicts.length ? `Not changed (differs): ${conflicts.join("; ")}` : ""].filter(Boolean).join(" · "), on: fillF.length > 0 };
  });
  S.orphans = [...S.existing.keys()].filter((id) => !ids.has(id));
  renderPlan();
}
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const show = (v) => (blank(v) ? "(empty)" : Array.isArray(v) ? v.join(",") : String(v));

function renderPlan() {
  const c = (k) => S.plan.filter((p) => p.kind === k).length;
  $("planCount").textContent = `(${c("new")} new · ${c("fill") + c("over")} to update · ${c("same")} unchanged · ${S.orphans.length} in Firestore but not in file)`;
  const manual = mode() === "confirm";
  $("tickAll").disabled = !manual;
  $("planBody").innerHTML = S.plan.filter((p) => p.kind !== "same").map((p) => `<tr data-id="${esc(p.id)}" class="${p.kind === "over" ? "warnrow" : ""}">
    <td><input type="checkbox" class="plan-on" ${p.on ? "checked" : ""} ${manual ? "" : "disabled"} /></td>
    <td><span class="tag tag-${p.kind}">${{ new: "Add", fill: "Fill", over: "Overwrite" }[p.kind]}</span></td>
    <td class="mono">${esc(p.id)}</td><td>${esc(p.rec.fullName)}</td><td class="student-sub">${esc(p.details)}</td></tr>`).join("") ||
    `<tr><td colspan="5" class="empty-hint">Nothing to change — Firestore already matches the file.</td></tr>`;
  updateImportBtn();
}
$("planBody").addEventListener("change", (e) => {
  const tr = e.target.closest("tr"); if (!tr) return;
  S.plan.find((p) => p.id === tr.dataset.id).on = e.target.checked; updateImportBtn();
});
$("tickAll").addEventListener("change", (e) => {
  S.plan.forEach((p) => { if (p.kind !== "same") p.on = e.target.checked; });
  document.querySelectorAll(".plan-on").forEach((c) => (c.checked = e.target.checked)); updateImportBtn();
});

/* ---------- backup ---------- */
$("backupBtn").addEventListener("click", () => {
  const obj = Object.fromEntries([...S.existing].sort().map(([id, d]) => [id, d]));
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = `${COL}-backup-${stamp}.json`; S.backupName = a.download;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  S.backedUp = true; $("savedOk").disabled = false;
  $("backupMsg").textContent = `Downloaded ${a.download} (${S.existing.size} students).`;
  updateImportBtn();
});
["savedOk", "typeConfirm", "wipe", "delExtra"].forEach((i) => $(i).addEventListener("input", updateImportBtn));
function updateImportBtn() {
  const todo = S.plan.some((p) => p.on) || (mode() === "replace" && $("delExtra").checked && S.orphans.length);
  const typed = mode() !== "replace" || $("typeConfirm").value.trim() === "REPLACE";
  $("importBtn").disabled = !(S.backedUp && $("savedOk").checked && todo && typed);
}

/* ---------- import ---------- */
$("importBtn").addEventListener("click", async () => {
  const m = mode(), wipe = m === "replace" && $("wipe").checked, del = m === "replace" && $("delExtra").checked;
  const ops = S.plan.filter((p) => p.on).map((p) => ({
    id: p.id, data: p.data, merge: !(p.kind === "new" || wipe),
  }));
  if (wipe) ops.forEach((o) => { if (S.existing.has(o.id)) o.data = { ...S.plan.find((p) => p.id === o.id).rec, ...newDefaults() }; });
  const dels = del ? S.orphans : [];
  const total = ops.length + dels.length;
  if (!confirm(`Write ${ops.length} student(s)${dels.length ? ` and DELETE ${dels.length}` : ""} in "${COL}"?`)) return;

  $("importBtn").disabled = true; $("prog").classList.remove("is-hidden"); $("prog").max = total; $("prog").value = 0;
  let done = 0;
  try {
    const all = [...ops.map((o) => ({ t: "w", ...o })), ...dels.map((id) => ({ t: "d", id }))];
    for (let i = 0; i < all.length; i += BATCH) {
      const b = writeBatch(db);
      all.slice(i, i + BATCH).forEach((o) => {
        const ref = doc(db, COL, o.id);
        if (o.t === "d") b.delete(ref); else b.set(ref, { ...o.data, updatedBy: S.user.email, updatedAt: serverTimestamp() }, o.merge ? { merge: true } : undefined);
      });
      await b.commit();
      done += Math.min(BATCH, all.length - i); $("prog").value = done;
    }
    clearRosterCache();
    try {
      await addDoc(collection(db, LOG_COL), { mode: m, wipe, deleted: dels.length, written: ops.length, source: S.file,
        backupFile: S.backupName || "", by: S.user.email, at: serverTimestamp() });
    } catch (e) { console.warn("Import log not written", e.code); }
    say(`Import complete: ${ops.length} written, ${dels.length} deleted. Reload the roster to see the changes.`, "ok");
  } catch (err) {
    say(`Stopped after ${done} of ${total} writes: ${err.message}. Earlier batches are already saved — restore from the backup if needed.`, "err");
  }
});
function say(t, c) { $("importMsg").className = `plan-msg ${c}`; $("importMsg").textContent = t; }
