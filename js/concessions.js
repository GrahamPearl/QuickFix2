/**
 * concessions.js — page controller for concessions.html.
 * concessions/{adminNo} = { adminNo, types[], note, createdBy/At, updatedBy/At }.
 * A document EXISTS = the learner has a concession (permanent yes/no); types are optional.
 * Grade and class are NOT stored: they come from the roster, so one learner stays searchable across years.
 * Permission: "markConcession" (usertypes.json + pages.js). Firestore Rules must enforce the same.
 */
import { db, collection, doc, getDocs, setDoc, deleteDoc, writeBatch, serverTimestamp } from "./firebase-init.js";
import { guardCurrentPage } from "./pages.js";
import { getAllStudents } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import { logAudit } from "./audit-service.js";
import { TYPES, typeLabel, parseTypes } from "./concession-types.js";

const $ = (id) => document.getElementById(id);
const COL = window.APP_CONFIG.CONCESSIONS_COLLECTION || "concessions";
const BATCH = 400;
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
const low = (v) => String(v || "").toLowerCase();
const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
const setChecked = (name, vals) => document.querySelectorAll(`input[name="${name}"]`).forEach((i) => (i.checked = vals.includes(i.value)));
const boxes = (name) => TYPES.map((t) => `<label class="imp-inline"><input type="checkbox" name="${name}" value="${t.key}"> ${esc(t.label)}</label>`).join("");

let me, roster = [], byAdmin = new Map(), items = new Map(), pick = null;

const g = await guardCurrentPage();
if (g) {
  me = g.user;
  try {
    roster = (await getAllStudents()).filter((s) => s?.adminNo);
    roster.forEach((s) => byAdmin.set(String(s.adminNo), s));
    $("typeBox").innerHTML = boxes("t");
    $("bulkTypeBox").innerHTML = boxes("bt");
    $("bulkIn").style.cssText = "width:100%;border:1px solid var(--line-strong);border-radius:8px;padding:10px 12px;font:inherit";
    $("fGrade").innerHTML = `<option value="">All grades</option>` + [8, 9, 10, 11, 12].map((x) => `<option value="${x}">Grade ${x}</option>`).join("");
    $("fType").innerHTML = `<option value="">Any type</option><option value="__none">No type recorded</option>` +
      TYPES.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join("");
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    await load();
  } catch (err) { $("gate").innerHTML = `<p class="error-text">Could not load: ${esc(err.message)}</p>`; }
}

async function load() {
  const snap = await getDocs(collection(db, COL));
  items = new Map(snap.docs.map((d) => [d.id, d.data()]));
  render();
}

/* ---------- list + filters ---------- */
function rows() {
  const gr = $("fGrade").value, ty = $("fType").value, q = low($("fText").value).trim();
  return [...items.values()].map((d) => ({ d, s: byAdmin.get(String(d.adminNo)) }))
    .filter(({ d, s }) => (!gr || String(s?.grade) === gr) &&
      (!ty || (ty === "__none" ? !(d.types || []).length : (d.types || []).includes(ty))) &&
      (!q || low(`${s?.fullName || ""} ${d.adminNo}`).includes(q)))
    .sort((a, b) => Number(a.s?.grade || 99) - Number(b.s?.grade || 99) || low(a.s?.lastName).localeCompare(low(b.s?.lastName)));
}

function render() {
  const list = rows();
  $("listCount").textContent = `(${list.length} shown of ${items.size})`;
  $("listBody").innerHTML = list.map(({ d, s }) => `<tr data-id="${esc(d.adminNo)}">
    <td class="mono">${esc(d.adminNo)}</td><td>${s ? esc(`${s.lastName}, ${s.firstName}`) : "(not on roster)"}</td>
    <td>${s ? `${esc(s.grade)} · ${esc(clsOf(s))}` : ""}</td>
    <td>${(d.types || []).map((k) => `<span class="badge">${esc(typeLabel(k))}</span>`).join("") || `<span class="empty-hint">—</span>`}</td>
    <td class="student-sub">${esc(d.note || "")}</td>
    <td class="row-actions"><button type="button" class="btn btn-ghost" data-act="edit">Edit</button>
      <button type="button" class="btn btn-ghost" data-act="del">Remove</button></td></tr>`).join("") ||
    `<tr><td colspan="6" class="empty-hint">No concessions match.</td></tr>`;
}
["fGrade", "fType", "fText"].forEach((i) => $(i).addEventListener("input", render));
$("refreshBtn").addEventListener("click", () => load().catch((e) => say("listMsg", e.message, "err")));

$("listBody").addEventListener("click", async (e) => {
  const act = e.target.dataset.act, id = e.target.closest("tr")?.dataset.id;
  if (!act || !id) return;
  if (act === "edit") return choose(id);
  if (!confirm(`Remove the concession for ${id}?`)) return;
  try { await removeMany([id]); say("listMsg", "Removed.", "ok"); } catch (err) { say("listMsg", err.message, "err"); }
});

/* ---------- write helpers ---------- */
async function audit(action, adminNos, note) {
  await logAudit({ action, source: "concessions-page", count: adminNos.length, note, extra: { adminNos: adminNos.slice(0, 200), truncated: adminNos.length > 200 } })
    .catch((e) => console.warn("Audit not written", e.code));
}

/** entries: [{ adm, types, note? }]  mode: "add" merges types, "replace" overwrites them. */
async function saveMany(entries, mode) {
  for (let i = 0; i < entries.length; i += BATCH) {
    const b = writeBatch(db);
    entries.slice(i, i + BATCH).forEach(({ adm, types, note }) => {
      const prev = items.get(adm);
      const merged = mode === "add" ? [...new Set([...(prev?.types || []), ...types])] : types;
      const data = {
        adminNo: adm, types: merged, note: note ?? prev?.note ?? "",
        updatedBy: me.email, updatedAt: serverTimestamp(),
        ...(prev ? {} : { createdBy: me.email, createdAt: serverTimestamp() }),
      };
      b.set(doc(db, COL, adm), data, { merge: true });
      items.set(adm, { ...prev, ...data });
    });
    await b.commit();
  }
  await audit("concession.set", entries.map((e) => e.adm), `${entries.length} learner(s), mode ${mode}`);
  render();
}

async function removeMany(ids) {
  for (let i = 0; i < ids.length; i += BATCH) {
    const b = writeBatch(db);
    ids.slice(i, i + BATCH).forEach((id) => b.delete(doc(db, COL, id)));
    await b.commit();
  }
  ids.forEach((id) => items.delete(id));
  await audit("concession.remove", ids, `${ids.length} learner(s)`);
  render();
}

/* ---------- 1. single learner ---------- */
function choose(adm) {
  pick = adm;
  const s = byAdmin.get(adm), cur = items.get(adm);
  $("stuPicked").textContent = `${s ? `${s.lastName}, ${s.firstName} · Gr ${s.grade} · ${clsOf(s)}` : "Not on roster"} · ${adm}${cur ? " · has a concession (editing)" : ""}`;
  setChecked("t", cur?.types || []);
  $("noteIn").value = cur?.note || "";
  $("stuMatches").innerHTML = ""; $("stuSearch").value = "";
  $("oneTitle").scrollIntoView({ behavior: "smooth" });
}

$("stuSearch").addEventListener("input", () => {
  const term = $("stuSearch").value.trim();
  if (term.length < 2) { $("stuMatches").innerHTML = ""; return; }
  const hits = sortStudents(filterStudents(roster, { term, field: "auto" })).slice(0, 8);
  $("stuMatches").innerHTML = hits.map((s) => `<button type="button" class="btn btn-ghost" style="display:block;width:100%;text-align:left" data-adm="${esc(s.adminNo)}">
    ${esc(s.lastName)}, ${esc(s.firstName)} · Gr ${esc(s.grade)} · ${esc(clsOf(s))} · <span class="mono">${esc(s.adminNo)}</span>${items.has(String(s.adminNo)) ? " ✓" : ""}</button>`).join("");
});
$("stuMatches").addEventListener("click", (e) => { const b = e.target.closest("[data-adm]"); if (b) choose(b.dataset.adm); });

$("clearOneBtn").addEventListener("click", () => {
  pick = null; setChecked("t", []); $("noteIn").value = ""; $("stuPicked").textContent = "No learner selected."; say("oneMsg", "");
});

$("saveOneBtn").addEventListener("click", async () => {
  if (!pick) return say("oneMsg", "Search for and choose a learner first.", "warn");
  try {
    await saveMany([{ adm: pick, types: checked("t"), note: $("noteIn").value.trim().slice(0, 200) }], "replace");
    say("oneMsg", `Concession saved for ${pick}.`, "ok");
  } catch (err) { say("oneMsg", `Could not save: ${err.message}`, "err"); }
});

/* ---------- 2. bulk ---------- */
const pad = (v) => String(v ?? "").trim().replace(/\.0$/, "").padStart(5, "0");

function split(entries) {
  const ok = [], bad = [];
  entries.forEach((e) => (/^\d{5,6}$/.test(e.adm) && byAdmin.has(e.adm) ? ok : bad).push(e));
  return { ok: [...new Map(ok.map((e) => [e.adm, e])).values()], bad };
}

async function bulkApply(entries) {
  const { ok, bad } = split(entries);
  if (!ok.length) return say("bulkMsg", `No valid learners found${bad.length ? `: ${bad.map((b) => b.adm).join(", ")}` : ""}.`, "err");
  const mode = $("bulkMode").value;
  if (!confirm(`${mode === "add" ? "Add to" : "Replace"} concession types for ${ok.length} learner(s)${bad.length ? `?\n\nNot found, skipped: ${bad.length}` : "?"}`)) return;
  try {
    await saveMany(ok, mode);
    say("bulkMsg", `${ok.length} saved.${bad.length ? ` Not found: ${bad.map((b) => b.adm).join(", ")}.` : ""}`, bad.length ? "warn" : "ok");
  } catch (err) { say("bulkMsg", `Stopped: ${err.message}. Saved batches are kept; re-running is safe.`, "err"); }
}

const pasted = () => $("bulkIn").value.split(/[\s,;]+/).filter(Boolean).map(pad);

$("bulkAddBtn").addEventListener("click", () => {
  const ids = pasted();
  if (!ids.length) return say("bulkMsg", "Paste one or more admin numbers first.", "warn");
  bulkApply(ids.map((adm) => ({ adm, types: checked("bt") })));
});

$("bulkDelBtn").addEventListener("click", async () => {
  const { ok } = split(pasted().map((adm) => ({ adm })));
  const ids = ok.map((e) => e.adm).filter((id) => items.has(id));
  if (!ids.length) return say("bulkMsg", "None of the pasted learners has a concession.", "warn");
  if (!confirm(`Remove the concession for ${ids.length} learner(s)?`)) return;
  try { await removeMany(ids); say("bulkMsg", `${ids.length} removed.`, "ok"); } catch (err) { say("bulkMsg", err.message, "err"); }
});

$("bulkFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
    const out = [], H = { admno: "adm", adminno: "adm", admin: "adm", type: "type", types: "type", concessiontype: "type", note: "note", notes: "note" };
    wb.SheetNames.forEach((name) => {
      const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
      const hi = data.findIndex((r, i) => i < 20 && r.some((c) => H[low(c).replace(/[^a-z]/g, "")] === "adm"));
      if (hi < 0) return;
      const col = {};
      data[hi].forEach((c, i) => { const k = H[low(c).replace(/[^a-z]/g, "")]; if (k && !(k in col)) col[k] = i; });
      data.slice(hi + 1).forEach((r) => {
        if (!String(r[col.adm] ?? "").trim()) return;
        const types = col.type !== undefined ? parseTypes(r[col.type]) : [];
        out.push({ adm: pad(r[col.adm]), types: types.length ? types : checked("bt"), note: col.note !== undefined ? String(r[col.note] || "").trim().slice(0, 200) : undefined });
      });
    });
    if (!out.length) say("bulkMsg", "No rows found. Check the ADMNO header.", "err");
    else await bulkApply(out);
  } catch (err) { say("bulkMsg", `Could not read file: ${err.message}`, "err"); }
  e.target.value = "";
});

/* ---------- 3. export (what the filters show) ---------- */
const cell = (v) => (/^[=+\-@]/.test(String(v ?? "")) ? `'${v}` : (v ?? ""));
const line = ({ d, s }) => ({
  "Admin No": d.adminNo, Surname: cell(s?.lastName), "First name": cell(s?.firstName),
  Grade: s?.grade ?? "", Class: clsOf(s), Types: (d.types || []).map(typeLabel).join("; "), Note: cell(d.note),
});

function exportFile(ext) {
  const list = rows();
  if (!list.length) return say("listMsg", "Nothing to export for these filters.", "warn");
  const wb = XLSX.utils.book_new();
  if (ext === "xlsx" && $("perGrade").checked) {
    [...new Set(list.map(({ s }) => s?.grade ?? "?"))].sort((a, b) => Number(a) - Number(b)).forEach((gr) =>
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(list.filter(({ s }) => (s?.grade ?? "?") === gr).map(line)), `Grade ${gr}`));
  } else XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(list.map(line)), "Concessions");
  const tag = [$("fGrade").value && `gr${$("fGrade").value}`, $("fType").value && $("fType").value.replace("__", "")].filter(Boolean).join("-");
  XLSX.writeFile(wb, `concessions${tag ? `-${tag}` : ""}-${new Date().toISOString().slice(0, 10)}.${ext}`);
  say("listMsg", `${list.length} row(s) exported.`, "ok");
  audit("concession.export", list.map(({ d }) => d.adminNo), `${ext}, ${list.length} rows`);
}
$("xlsxBtn").addEventListener("click", () => exportFile("xlsx"));
$("csvBtn").addEventListener("click", () => exportFile("csv"));