/**
 * import-finals.js — page controller for import-finals.html.
 * Excel (ADMNO + EXAMNO) -> finals-candidates/{examNo} = { examNo, adminNo, year, ... }.
 * The exam number is the document ID, so it is unique by construction; each admin no may hold
 * one exam number per year. Names, classes and subjects are NOT copied: seating-finals.js joins
 * them from the roster, so they can never go stale.
 * Permission: "examImport" (usertypes.json + pages.js). Firestore Rules must enforce the same.
 */
import { db, collection, doc, getDocs, writeBatch, serverTimestamp } from "./firebase-init.js";
import { guardCurrentPage } from "./pages.js";
import { getAllStudents } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";
import { logAudit } from "./audit-service.js";

const $ = (id) => document.getElementById(id);
const COL = window.APP_CONFIG.FINALS_COLLECTION || "finals-candidates";
const BATCH = 400;
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEAD = {
  admno: "adm", adminno: "adm", adminnumber: "adm", admin: "adm",
  examno: "exam", examnumber: "exam", candidateno: "exam", candidatenumber: "exam", extexamno: "exam",
};
const cell = (v) => String(v ?? "").trim().replace(/\.0$/, "");

let user, byAdmin = new Map(), existing = new Map(), raw = [], rows = [], file = "";

const g = await guardCurrentPage();
if (g) {
  user = g.user;
  $("gate").style.display = "none";
  $("app").classList.remove("is-hidden");
  try {
    (await getAllStudents()).forEach((s) => byAdmin.set(String(s.adminNo), s));
  } catch (e) { say("loadMsg", `Could not load the roster: ${e.message}`, "err"); }
}

function say(id, t, c = "") { $(id).className = `plan-msg ${c}`; $(id).textContent = t; }

/* ---------- parse ---------- */
function parse(wb) {
  const out = [];
  wb.SheetNames.forEach((name) => {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const hi = data.findIndex((r, i) => i < 20 && r.some((c) => HEAD[norm(c)] === "adm") && r.some((c) => HEAD[norm(c)] === "exam"));
    if (hi < 0) return;
    const col = {};
    data[hi].forEach((c, i) => { const k = HEAD[norm(c)]; if (k && !(k in col)) col[k] = i; });
    data.slice(hi + 1).forEach((r) => {
      const adm = cell(r[col.adm]), exam = cell(r[col.exam]);
      if (adm || exam) out.push({ sheet: name.trim(), adm, exam });
    });
  });
  return out;
}

$("fileIn").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    file = f.name;
    raw = parse(XLSX.read(await f.arrayBuffer(), { type: "array" }));
    if (!raw.length) return say("loadMsg", "No rows found. Check the ADMNO and EXAMNO headers.", "err");
    const snap = await getDocs(collection(db, COL));
    existing = new Map(snap.docs.map((d) => [d.id, d.data()]));
    $("loadMsg").textContent = `${file}: ${raw.length} rows. ${existing.size} candidate link(s) already in Firestore.`;
    classify();
    $("reviewPanel").classList.remove("is-hidden");
  } catch (err) { say("loadMsg", `Could not read file: ${err.message}`, "err"); }
});

/* ---------- classify ---------- */
const year = () => Number($("yearIn").value);

function classify() {
  const yr = year(), over = $("allowOver").checked;
  const byAdm = new Map([...existing].filter(([, d]) => d.year === yr).map(([id, d]) => [d.adminNo, id]));
  const seenAdm = new Map(), seenExam = new Map();
  rows = raw.map((r) => {
    const adm = r.adm.padStart(5, "0"), s = byAdmin.get(adm);
    const x = { ...r, adm, s, status: "new", msg: "", del: null };
    if (!/^\d{5,6}$/.test(adm)) return { ...x, status: "error", msg: "Admin no must be 5 digits" };
    if (!/^\d{6,20}$/.test(r.exam)) return { ...x, status: "error", msg: "Exam no must be 6–20 digits" };
    if (!s) return { ...x, status: "error", msg: "Admin no not on the roster" };
    if (seenAdm.has(adm)) return { ...x, status: "error", msg: `Admin no repeated (${seenAdm.get(adm)})` };
    if (seenExam.has(r.exam)) return { ...x, status: "error", msg: `Exam no repeated (${seenExam.get(r.exam)})` };
    seenAdm.set(adm, r.sheet); seenExam.set(r.exam, r.sheet);

    const ex = existing.get(r.exam), oldId = byAdm.get(adm);
    if (ex && ex.adminNo === adm && ex.year === yr) return { ...x, status: "same", msg: "Already linked" };
    const notes = [];
    if (ex) notes.push(`Exam no already linked to ${ex.adminNo} (${ex.year})`);
    if (oldId && oldId !== r.exam) { notes.push(`Learner already has exam no ${oldId}`); x.del = oldId; }
    if (notes.length) return { ...x, status: over ? "change" : "conflict", msg: notes.join("; ") + (over ? " — will overwrite" : " — skipped") };
    if (Number(s.grade) !== 12) x.msg = `Note: Grade ${s.grade}, not 12`;
    return x;
  });
  render();
}

function render() {
  const q = $("rowFilter").value.trim().toLowerCase(), eo = $("errOnly").checked;
  const c = (st) => rows.filter((r) => r.status === st).length;
  $("sumCount").textContent = `(${c("new")} new · ${c("change")} overwrite · ${c("same")} unchanged · ${c("conflict")} conflicts · ${c("error")} errors)`;
  $("revBody").innerHTML = rows.filter((r) => (!eo || ["error", "conflict"].includes(r.status)) &&
      (!q || `${r.s?.fullName || ""} ${r.adm} ${r.exam}`.toLowerCase().includes(q)))
    .map((r) => `<tr class="${r.status === "error" ? "bad" : ["conflict", "change"].includes(r.status) ? "warnrow" : ""}">
      <td>${esc(r.sheet)}</td><td class="mono">${esc(r.adm)}</td><td>${esc(r.s?.fullName || "—")}</td>
      <td>${r.s ? `${esc(r.s.grade)} · ${esc(r.s.registrationClass || r.s.class)}` : ""}</td>
      <td class="mono">${esc(r.exam)}</td><td>${esc(r.status === "new" ? r.msg || "New" : r.msg)}</td></tr>`).join("");
  $("importBtn").disabled = !rows.some((r) => ["new", "change"].includes(r.status));
}
["rowFilter", "errOnly"].forEach((i) => $(i).addEventListener("input", render));
["allowOver", "yearIn"].forEach((i) => $(i).addEventListener("change", () => raw.length && classify()));

/* ---------- write ---------- */
$("importBtn").addEventListener("click", async () => {
  const todo = rows.filter((r) => ["new", "change"].includes(r.status));
  const dels = [...new Set(todo.map((r) => r.del).filter(Boolean))].filter((id) => !todo.some((r) => r.exam === id));
  if (!confirm(`Link ${todo.length} candidate(s) for ${year()}${dels.length ? ` and remove ${dels.length} superseded link(s)` : ""}?`)) return;

  $("importBtn").disabled = true;
  $("prog").classList.remove("is-hidden");
  const ops = [...todo.map((r) => ({ t: "w", r })), ...dels.map((id) => ({ t: "d", id }))];
  $("prog").max = ops.length; $("prog").value = 0;
  let done = 0;
  try {
    for (let i = 0; i < ops.length; i += BATCH) {
      const b = writeBatch(db);
      ops.slice(i, i + BATCH).forEach((o) => {
        if (o.t === "d") return b.delete(doc(db, COL, o.id));
        const prev = existing.get(o.r.exam);
        b.set(doc(db, COL, o.r.exam), {
          examNo: o.r.exam, adminNo: o.r.adm, year: year(),
          createdBy: prev?.createdBy || user.email, createdAt: prev?.createdAt || serverTimestamp(),
          updatedBy: user.email, updatedAt: serverTimestamp(),
        });
      });
      await b.commit();
      done = Math.min(ops.length, i + BATCH);
      $("prog").value = done;
    }
    todo.forEach((r) => existing.set(r.exam, { examNo: r.exam, adminNo: r.adm, year: year() }));
    dels.forEach((id) => existing.delete(id));
    say("importMsg", `Done: ${todo.length} linked, ${dels.length} superseded link(s) removed.`, "ok");
    await logAudit({
      action: "finals.import", source: file, count: todo.length,
      note: `year ${year()}: ${todo.length} linked, ${dels.length} removed`,
      extra: { adminNos: todo.map((r) => r.adm).slice(0, 200), truncated: todo.length > 200 },
    }).catch((e) => console.warn("Audit not written", e.code));
    classify();
  } catch (err) {
    say("importMsg", `Stopped after ${done} of ${ops.length}: ${err.message}. Earlier batches are saved; re-running is safe.`, "err");
    $("importBtn").disabled = false;
  }
});