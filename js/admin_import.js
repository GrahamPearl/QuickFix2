/**
 * admin_import.js — page controller for admin_import.html.
 * Excel class lists (one sheet per registration class) -> students collection.
 * Flow: parse + review (flagged rows need confirmation) -> compare with Firestore
 *       (new / fill / overwrite / CLASS MOVES / LEAVERS) -> mandatory backup -> batched write.
 * Moves and leavers are never applied unless ticked. Deleting needs the word DELETE typed.
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
// Changing these on an existing student is a "move" and always needs a tick.
const MOVE = ["registrationClass", "class", "grade"];
const OTHER = OWNED.filter((f) => !MOVE.includes(f));
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEAD = { admno: "adminNo", surname: "lastName", preferredname: "firstName", g: "gender", bdate: "birthdate", agegroup: "agegroup" };

const S = {
  user: null, file: "", rows: [], sheets: [], existing: new Map(), plan: [],
  backedUp: false, source: "xlsx", note: "",
};

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
  const errors = [], warnings = [];
  if (/^\d{6}$/.test(adminNo)) warnings.push("6-digit admin no (temporary / foreign student?). Confirm it is correct");
  else if (!/^\d{5}$/.test(adminNo)) errors.push("Admin no must be 5 digits (6 for temporary students)");
  if (!firstName) errors.push("Missing preferred name");
  if (!lastName) errors.push("Missing surname");
  if (!/^[MF]/.test(g)) errors.push("Gender must be M or F");
  if (!birthdate) errors.push("Invalid birthdate");
  if (!grade || !cls) errors.push("Cannot read grade/class from sheet name");
  const low = (x) => x.toLowerCase();
  return {
    errors, warnings,
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

// A row is imported when it has no errors and, if flagged, has been confirmed.
const usable = (r) => !r.errors.length && (!r.warnings.length || r.confirmed);

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
      const { rec, errors, warnings } = buildRecord(sh.name, raw);
      if (seen.has(rec.id)) errors.push(`Duplicate of ${seen.get(rec.id)}`); else seen.set(rec.id, sh.name);
      rows.push({ sheet: sh.name, rowNo: hi + k + 2, rec, errors, warnings, confirmed: false });
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
      S.rows = list.filter((s) => s && s.adminNo).map((s) => ({
        sheet: s.registrationClass || "backup", rowNo: 0, rec: { ...s, id: String(s.adminNo) }, errors: [], warnings: [], confirmed: false,
      }));
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
const flagged = () => S.rows.filter((r) => !r.errors.length && r.warnings.length);

function renderWarnings() {
  const warns = S.sheets.filter((s) => s.issues.length);
  const fl = flagged(), ok = fl.filter((r) => r.confirmed).length;
  $("sheetWarn").innerHTML =
    warns.map((s) => `<div class="warn-box"><strong>${esc(s.name)}:</strong> ${esc(s.issues.join("; "))}</div>`).join("") +
    (fl.length
      ? `<div class="warn-box"><strong>${fl.length} flagged row(s)</strong> (e.g. 6-digit admin numbers) are skipped unless confirmed: ${ok} confirmed.
         <button type="button" id="okAllWarn" class="btn btn-ghost">Confirm all flagged rows</button></div>`
      : "");
}

function showReview() {
  const bad = S.rows.filter((r) => r.errors.length).length, fl = flagged().length;
  $("loadMsg").textContent = `${S.file}: ${S.sheets.length} worksheets, ${S.rows.length} students, ${bad} with problems, ${fl} flagged for confirmation.`;
  $("sheetSel").innerHTML = `<option value="">All worksheets (${S.rows.length})</option>` +
    S.sheets.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.count})${s.issues.length ? " ⚠" : ""}</option>`).join("");
  renderWarnings();
  $("revCount").textContent = `(${S.rows.length} rows)`;
  $("reviewPanel").classList.remove("is-hidden");
  renderReview();
}

function renderReview() {
  const sh = $("sheetSel").value, q = $("rowFilter").value.trim().toLowerCase(), eo = $("errOnly").checked;
  $("revBody").innerHTML = S.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (!sh || r.sheet === sh) && (!eo || r.errors.length || r.warnings.length) &&
      (!q || `${r.rec.fullName} ${r.rec.adminNo}`.toLowerCase().includes(q)))
    .map(({ r, i }) => {
      const s = r.rec, hasErr = r.errors.length > 0, hasWarn = r.warnings.length > 0;
      const status = hasErr ? r.errors.join("; ") : hasWarn ? r.warnings.join("; ") : "OK";
      const confirm = !hasErr && hasWarn
        ? `<input type="checkbox" class="warn-ok" data-i="${i}" ${r.confirmed ? "checked" : ""} title="Tick to confirm these details are correct" />` : "";
      return `<tr class="${hasErr ? "bad" : hasWarn ? "warnrow" : ""}"><td>${esc(r.sheet)}</td><td class="mono">${esc(s.adminNo)}</td>
        <td>${esc(s.firstName)}</td><td>${esc(s.lastName)}</td><td>${esc(s.grade)}</td><td>${esc(s.class)}</td><td>${esc(s.gender)}</td>
        <td>${esc(s.birthdate)}</td><td>${esc(s.agegroup)}</td><td>${esc(status)}</td><td>${confirm}</td></tr>`;
    }).join("");
}
["sheetSel", "rowFilter", "errOnly"].forEach((i) => $(i).addEventListener("input", renderReview));

// Confirming or un-confirming a flagged row changes what will be compared, so restart from step 3.
function onConfirmChange() {
  resetFrom("mode");
  $("modePanel").classList.toggle("is-hidden", !$("reviewed").checked);
  renderWarnings();
}
$("revBody").addEventListener("change", (e) => {
  const cb = e.target.closest(".warn-ok");
  if (!cb) return;
  S.rows[Number(cb.dataset.i)].confirmed = cb.checked;
  onConfirmChange();
});
$("sheetWarn").addEventListener("click", (e) => {
  if (e.target.id !== "okAllWarn") return;
  flagged().forEach((r) => (r.confirmed = true));
  renderReview(); onConfirmChange();
});
$("reviewed").addEventListener("change", () => { resetFrom("mode"); $("modePanel").classList.toggle("is-hidden", !$("reviewed").checked); });

function resetFrom(step) {
  S.backedUp = false; S.plan = [];
  const order = ["review", "mode", "plan", "go"];
  order.slice(order.indexOf(step)).forEach((s) => $(s + "Panel").classList.add("is-hidden"));
  if (step === "review") $("reviewed").checked = false;
  $("planPanel").classList.add("is-hidden"); $("goPanel").classList.add("is-hidden");
  $("backupMsg").textContent = "Not downloaded yet."; $("savedOk").checked = false; $("savedOk").disabled = true;
  $("delConfirm").value = ""; $("typeConfirm").value = "";
  $("importMsg").textContent = ""; updateImportBtn();
}

/* ---------- compare ---------- */
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const hidePlan = () => { $("planPanel").classList.add("is-hidden"); $("goPanel").classList.add("is-hidden"); };
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
  $("replaceOpts").classList.toggle("is-hidden", mode() !== "replace");
  $("typeRow").classList.toggle("is-hidden", mode() !== "replace");
  hidePlan();
}));
$("limitGrades").addEventListener("change", hidePlan);
const blank = (v) => v === undefined || v === null || v === "";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

$("compareBtn").addEventListener("click", async () => {
  $("compareBtn").disabled = true; $("cmpMsg").textContent = "Reading current students from Firestore…";
  try {
    const snap = await getDocs(collection(db, COL));
    S.existing = new Map(snap.docs.map((d) => [d.id, d.data()]));
    buildPlan();
    $("cmpMsg").textContent = `Firestore currently holds ${S.existing.size} students. ${S.note}`;
    $("planPanel").classList.remove("is-hidden"); $("goPanel").classList.remove("is-hidden");
    S.backedUp = false; $("savedOk").checked = false; $("savedOk").disabled = true; $("backupMsg").textContent = "Not downloaded yet.";
    updateImportBtn();
  } catch (err) { $("cmpMsg").textContent = `Could not read Firestore: ${err.message}`; }
  finally { $("compareBtn").disabled = false; }
});

// Class/grade code of the stored student vs the spreadsheet (compares the short code, e.g. "9B").
const codeOf = (d) => norm(d.class || d.registrationClass);
function hasMoved(old, rec) {
  const oc = codeOf(old);
  const classMoved = oc && oc !== norm(rec.class);
  const gradeMoved = !blank(old.grade) && Number(old.grade) !== Number(rec.grade);
  return Boolean(classMoved || gradeMoved);
}
const classLabel = (d) => `${d.registrationClass || d.class || "no class"} (Gr ${blank(d.grade) ? "?" : d.grade})`;

function buildPlan() {
  const m = mode(), isJson = S.source === "json";
  const good = S.rows.filter(usable);
  // Every id in the file counts as "still here", even rows with problems or unconfirmed flags.
  const inFile = new Set(S.rows.map((r) => r.rec.id));
  const plan = [];

  good.forEach(({ rec }) => {
    const old = S.existing.get(rec.id);
    if (!old) {
      plan.push({ id: rec.id, rec, kind: "new", data: { ...rec, ...(isJson ? {} : newDefaults()) }, details: "New student", on: true });
      return;
    }
    const moved = hasMoved(old, rec);
    const fields = moved ? OTHER : OWNED; // a move is handled by its own row, never auto-applied
    const diffs = fields.filter((f) => !same(old[f], rec[f]) && rec[f] !== undefined);
    let main;
    if (m === "replace") {
      main = { id: rec.id, rec, kind: diffs.length ? "over" : "same", data: pick(rec, fields),
        details: diffs.map((f) => `${f}: ${show(old[f])} → ${show(rec[f])}`).join("; "), on: diffs.length > 0 };
    } else {
      const fillF = diffs.filter((f) => blank(old[f]));
      const data = pick(rec, fillF);
      Object.entries(newDefaults()).forEach(([k, v]) => { if (!isJson && old[k] === undefined) { data[k] = v; fillF.push(k); } });
      const conflicts = diffs.filter((f) => !blank(old[f])).map((f) => `${f}: ${show(old[f])} ≠ ${show(rec[f])}`);
      main = { id: rec.id, rec, kind: fillF.length ? "fill" : "same", data,
        details: [fillF.length ? `Fills: ${fillF.join(", ")}` : "", conflicts.length ? `Not changed (differs): ${conflicts.join("; ")}` : ""].filter(Boolean).join(" · "),
        on: fillF.length > 0 };
    }
    if (main.kind !== "same" || !moved) plan.push(main);
    if (moved) {
      plan.push({ id: rec.id, rec, kind: "move", data: pick(rec, MOVE), on: false,
        details: `${classLabel(old)} → ${classLabel(rec)}` });
    }
  });

  // Leavers: in Firestore, not in the file.
  const skippedSheets = S.sheets.filter((s) => s.issues.some((i) => /skipped/i.test(i)));
  const gradesInFile = new Set(S.rows.map((r) => Number(r.rec.grade)).filter(Boolean));
  const limit = $("limitGrades").checked;
  S.note = "";
  if (skippedSheets.length) {
    S.note = `Leaver detection is OFF: ${skippedSheets.length} worksheet(s) were skipped, so their students would look like leavers.`;
  } else {
    const leavers = [...S.existing].filter(([id, d]) => !inFile.has(id) && (!limit || gradesInFile.has(Number(d.grade))));
    leavers.forEach(([id, d]) => plan.push({
      id, kind: "leave", data: null, on: false,
      rec: { fullName: d.fullName || `${d.firstName || ""} ${d.lastName || ""}`.trim() || id },
      details: `${classLabel(d)} · not in the spreadsheet`,
    }));
    if (S.existing.size && leavers.length / S.existing.size > 0.1) {
      S.note = `Warning: ${leavers.length} of ${S.existing.size} students look like leavers. Check you loaded the complete file.`;
    }
  }

  const ord = { new: 0, fill: 1, over: 2, move: 3, leave: 4, same: 5 };
  plan.sort((a, b) => ord[a.kind] - ord[b.kind] || String(a.rec.fullName).localeCompare(String(b.rec.fullName)));
  S.plan = plan;
  renderPlan();
}
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const show = (v) => (blank(v) ? "(empty)" : Array.isArray(v) ? v.join(",") : String(v));

// New / fill / overwrite follow the import mode; moves and leavers can always be ticked individually.
const alwaysManual = (p) => p.kind === "move" || p.kind === "leave";
const locked = (p) => !alwaysManual(p) && mode() !== "confirm";
const TAGS = { new: "Add", fill: "Fill", over: "Overwrite", move: "Class move", leave: "Leaver · delete" };
const ROWCLS = { over: "warnrow", move: "warnrow", leave: "bad" };

function renderPlan() {
  const c = (k) => S.plan.filter((p) => p.kind === k).length;
  $("planCount").textContent = `(${c("new")} new · ${c("move")} class moves · ${c("leave")} leavers · ${c("fill") + c("over")} to update · ${c("same")} unchanged)`;
  $("tickAll").disabled = mode() !== "confirm";
  $("planBody").innerHTML = S.plan.filter((p) => p.kind !== "same").map((p) => `<tr data-id="${esc(p.id)}" data-kind="${p.kind}" class="${ROWCLS[p.kind] || ""}">
    <td><input type="checkbox" class="plan-on" ${p.on ? "checked" : ""} ${locked(p) ? "disabled" : ""} /></td>
    <td><span class="tag tag-${p.kind}">${TAGS[p.kind]}</span></td>
    <td class="mono">${esc(p.id)}</td><td>${esc(p.rec.fullName)}</td><td class="student-sub">${esc(p.details)}</td></tr>`).join("") ||
    `<tr><td colspan="5" class="empty-hint">Nothing to change. Firestore already matches the file.</td></tr>`;
  updateImportBtn();
}

function setTicks(test, on) {
  S.plan.forEach((p) => { if (test(p) && !locked(p)) p.on = on; });
  document.querySelectorAll("#planBody tr").forEach((tr) => {
    const p = S.plan.find((x) => x.id === tr.dataset.id && x.kind === tr.dataset.kind);
    const cb = tr.querySelector(".plan-on");
    if (p && cb && !cb.disabled) cb.checked = p.on;
  });
  updateImportBtn();
}
$("planBody").addEventListener("change", (e) => {
  const tr = e.target.closest("tr"); if (!tr) return;
  S.plan.find((p) => p.id === tr.dataset.id && p.kind === tr.dataset.kind).on = e.target.checked; updateImportBtn();
});
$("tickAll").addEventListener("change", (e) => setTicks((p) => p.kind !== "same" && p.kind !== "leave", e.target.checked));
$("tickMoves").addEventListener("click", () => setTicks((p) => p.kind === "move", true));
$("untickMoves").addEventListener("click", () => setTicks((p) => p.kind === "move", false));
$("tickLeavers").addEventListener("click", () => {
  const n = S.plan.filter((p) => p.kind === "leave").length;
  if (n && confirm(`Tick all ${n} leaver(s) for DELETION? Check the list first.`)) setTicks((p) => p.kind === "leave", true);
});
$("untickLeavers").addEventListener("click", () => setTicks((p) => p.kind === "leave", false));

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
["savedOk", "typeConfirm", "wipe", "delConfirm"].forEach((i) => $(i).addEventListener("input", updateImportBtn));
function updateImportBtn() {
  const todo = S.plan.some((p) => p.on);
  const dels = S.plan.filter((p) => p.kind === "leave" && p.on).length;
  $("delRow").classList.toggle("is-hidden", !dels);
  $("delLabel").textContent = `Type DELETE to permanently remove ${dels} student(s)`;
  const typedReplace = mode() !== "replace" || $("typeConfirm").value.trim() === "REPLACE";
  const typedDelete = !dels || $("delConfirm").value.trim() === "DELETE";
  $("importBtn").disabled = !(S.backedUp && $("savedOk").checked && todo && typedReplace && typedDelete);
}

/* ---------- import ---------- */
$("importBtn").addEventListener("click", async () => {
  const m = mode(), wipe = m === "replace" && $("wipe").checked;
  const ticked = S.plan.filter((p) => p.on);
  const dels = ticked.filter((p) => p.kind === "leave").map((p) => p.id);
  const moves = ticked.filter((p) => p.kind === "move");
  const ops = ticked.filter((p) => p.kind !== "leave").map((p) => {
    // "wipe" only applies to overwritten students, never to moved ones
    if (wipe && p.kind === "over" && S.existing.has(p.id)) return { id: p.id, data: { ...p.rec, ...newDefaults() }, merge: false };
    return { id: p.id, data: p.data, merge: p.kind !== "new" };
  });
  const total = ops.length + dels.length;
  if (!confirm(`Write ${ops.length} student(s) (${moves.length} class move(s))${dels.length ? ` and DELETE ${dels.length}` : ""} in "${COL}"?`)) return;

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
      await addDoc(collection(db, LOG_COL), { mode: m, wipe, deleted: dels.length, deletedIds: dels, moved: moves.length, movedIds: moves.map((p) => p.id),
        written: ops.length, source: S.file, backupFile: S.backupName || "", by: S.user.email, at: serverTimestamp() });
    } catch (e) { console.warn("Import log not written", e.code); }
    say(`Import complete: ${ops.length} written (${moves.length} class moves), ${dels.length} deleted. Reload the roster to see the changes.`, "ok");
  } catch (err) {
    say(`Stopped after ${done} of ${total} writes: ${err.message}. Earlier batches are already saved. Restore from the backup if needed.`, "err");
  }
});
function say(t, c) { $("importMsg").className = `plan-msg ${c}`; $("importMsg").textContent = t; }