/**
 * seating-finals.js — Grade 12 Finals seating by exam number and subject.
 * Candidates = finals-candidates/{examNo} (written by import-finals.js) joined to the cached
 * roster by adminNo, so names, classes and subjects always come from `students`.
 * S-snake fill in exam-number order; venues saved to exam-venues/{key}.
 * Permission: "examSeating" (usertypes.json + pages.js). Firestore Rules must enforce the same.
 */
import { auth, db, collection, doc, getDoc, getDocs, setDoc, query, where, serverTimestamp } from "./firebase-init.js";
import { guardCurrentPage } from "./pages.js";
import { getAllStudents } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";
import { TYPES, typeShort } from "./concession-types.js";

const $ = (id) => document.getElementById(id);
const { FINALS_COLLECTION = "finals-candidates", EXAM_VENUES_COLLECTION = "exam-venues", CONCESSIONS_COLLECTION = "concessions" } = window.APP_CONFIG;

const S = { roster: new Map(), conc: new Map(), cands: [], list: [], sel: new Set(), cols: 6, rows: 6, seats: [], pool: [], poolSel: null, venues: [], loaded: null, canvas: null };

/* ---------- helpers ---------- */
const low = (v) => String(v || "").toLowerCase();
const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
const clamp = (v) => Math.min(30, Math.max(1, parseInt(v, 10) || 1));
const byExam = (a, b) => a.examNo.length - b.examNo.length || a.examNo.localeCompare(b.examNo);
const nameOf = (c) => [low(c.s.lastName).toUpperCase(), c.s.firstName].filter(Boolean).join(", ");
const safe = (s) => String(s || "plan").replace(/[^\w-]+/g, "_");
const venueKey = (n) => low(n).trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
const at = (r, c) => S.seats[r * S.cols + c];
const say = (id, html, cls = "") => { $(id).className = `plan-msg ${cls}`; $(id).innerHTML = html; };
const dirty = () => { S.canvas = null; };
const typeTag = (c) => ($("groupSel").value === "only" ? ` · ${esc((S.conc.get(c.adminNo)?.types || []).map(typeShort).join(", ") || "—")}` : "");
const year = () => Number($("yearIn").value);

/* ---------- startup ---------- */
const g = await guardCurrentPage();
if (g) {
  try {
    (await getAllStudents()).forEach((s) => s?.adminNo && S.roster.set(String(s.adminNo), s));
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    await loadYear();
  } catch (err) {
    console.error(err);
    $("gate").innerHTML = `<p class="error-text">Could not load data: ${esc(err.message)}</p>`;
  }
}

async function loadYear() {
  say("loadMsg", "Loading candidates…", "warn");
  const snap = await getDocs(query(collection(db, FINALS_COLLECTION), where("year", "==", year())));
  const missing = [];
  S.cands = [];
  snap.forEach((d) => {
    const { examNo, adminNo } = d.data(), s = S.roster.get(String(adminNo));
    if (s) S.cands.push({ examNo: String(examNo), adminNo: String(adminNo), s });
    else missing.push(examNo);
  });
  S.cands.sort(byExam);
  let concMsg = "";
  try {
    S.conc = new Map((await getDocs(collection(db, CONCESSIONS_COLLECTION))).docs.map((d) => [d.id, d.data()]));
  } catch (e) { S.conc = new Map(); concMsg = " Concessions could not be loaded: do not rely on the venue split."; }
  $("typeSel").innerHTML = `<option value="">Any type</option>` + TYPES.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join("");
  const subs = [...new Set(S.cands.flatMap((c) => c.s.subjectsSummary || []))].sort();
  $("subjectSel").innerHTML = `<option value="">All candidates (${S.cands.length})</option>` + subs.map((x) => `<option>${esc(x)}</option>`).join("");
  say("loadMsg", S.cands.length
    ? `${S.cands.length} candidates for ${year()} (${S.cands.filter((c) => S.conc.has(c.adminNo)).length} with concession).${esc(concMsg)}${missing.length ? ` ${missing.length} exam no(s) have no matching student: ${esc(missing.join(", "))}.` : ""}`
    : `No candidates for ${year()}. Use Import Finals Candidates first.`, missing.length || concMsg || !S.cands.length ? "warn" : "ok");
  applyFilter();
  await loadVenues();
}

/* ---------- candidate list ---------- */
function applyFilter() {
  const sub = $("subjectSel").value;
  const grp = $("groupSel").value, ty = $("typeSel").value;
  $("typeSel").disabled = grp !== "only";
  S.list = S.cands.filter((c) => {
    const k = S.conc.get(c.adminNo);
    return (!sub || (c.s.subjectsSummary || []).includes(sub)) && (grp !== "std" || !k) &&
      (grp !== "only" || (k && (!ty || (k.types || []).includes(ty))));
  });
  S.sel = new Set(S.list.map((c) => c.examNo));
  S.seats = []; S.pool = [];
  renderTable(); generate();
}

function renderTable() {
  $("candBody").innerHTML = S.list.map((c) => {
    const on = S.sel.has(c.examNo);
    return `<tr class="${on ? "" : "is-unselected"}" data-id="${esc(c.examNo)}"><td><input type="checkbox" ${on ? "checked" : ""}></td>
      <td class="mono">${esc(c.examNo)}</td><td>${esc(nameOf(c))}</td><td>${esc(clsOf(c.s))}</td><td class="mono">${esc(c.adminNo)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty-hint">No candidates.</td></tr>`;
  $("candCount").textContent = S.list.length ? `(${S.sel.size} of ${S.list.length} ticked)` : "";
}

["subjectSel", "groupSel", "typeSel"].forEach((i) => $(i).addEventListener("change", applyFilter));
$("yearIn").addEventListener("change", () => loadYear().catch((e) => say("loadMsg", e.message, "err")));
$("candBody").addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  e.target.checked ? S.sel.add(tr.dataset.id) : S.sel.delete(tr.dataset.id);
  tr.classList.toggle("is-unselected", !e.target.checked);
  $("candCount").textContent = `(${S.sel.size} of ${S.list.length} ticked)`;
});
$("selAllBtn").addEventListener("click", () => { S.sel = new Set(S.list.map((c) => c.examNo)); renderTable(); });
$("selNoneBtn").addEventListener("click", () => { S.sel = new Set(); renderTable(); });

/* ---------- layout (S-snake: down column 1, up column 2, …) ---------- */
function snake(cols, rows) {
  const o = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) o.push({ r, c });
    else for (let r = rows - 1; r >= 0; r--) o.push({ r, c });
  }
  return o;
}

function generate() {
  S.cols = clamp($("colsIn").value); S.rows = clamp($("rowsIn").value);
  const order = snake(S.cols, S.rows);
  S.seats = new Array(order.length);
  order.forEach((p, i) => (S.seats[p.r * S.cols + p.c] = { r: p.r, c: p.c, no: i + 1, cand: null }));
  const people = S.list.filter((c) => S.sel.has(c.examNo));
  people.slice(0, order.length).forEach((c, i) => (S.seats[order[i].r * S.cols + order[i].c].cand = c));
  S.pool = people.slice(order.length);
  S.poolSel = null;
  renderAll();
}

$("generateBtn").addEventListener("click", generate);
["colsIn", "rowsIn"].forEach((i) => $(i).addEventListener("change", generate));
$("fitBtn").addEventListener("click", () => {
  $("colsIn").value = Math.min(30, Math.ceil((S.sel.size || 1) / clamp($("rowsIn").value)));
  generate();
});

/* ---------- render ---------- */
function seatHtml(seat, i, ex) {
  const a = ex ? "" : `data-i="${i}"`, c = seat.cand;
  if (!c) return `<div ${a} class="seat empty">${ex ? "" : "Empty desk"}</div>`;
  return `<div ${a} class="seat filled" title="${ex ? "" : "Click to remove"}"><span class="seat-no">${seat.no}</span>
    <div class="seat-text"><div class="seat-sur" style="font-size:.9rem">${esc(c.examNo)}</div>
      <div class="seat-first">${esc(nameOf(c))}</div><div class="seat-adm">${esc(clsOf(c.s))}${typeTag(c)}</div></div></div>`;
}

function renderAll() {
  const g = $("seatGrid");
  g.style.gridTemplateColumns = `repeat(${S.cols}, var(--seat-w))`;
  g.innerHTML = S.seats.map((s, i) => seatHtml(s, i, false)).join("");
  $("poolBadge").textContent = S.pool.length;
  $("pool").innerHTML = S.pool.length
    ? S.pool.map((c) => `<span class="pool-chip ${c.examNo === S.poolSel ? "selected" : ""}" data-id="${esc(c.examNo)}">${esc(c.examNo)} · ${esc(nameOf(c))}</span>`).join("")
    : `<span class="empty-hint">No unassigned candidates.</span>`;
  const n = S.sel.size, seated = S.seats.filter((s) => s.cand).length;
  if (!n) say("planMsg", "No candidates ticked.", "warn");
  else if (S.pool.length) say("planMsg", `${S.seats.length} desks for ${n} candidates — ${S.pool.length} unassigned. Add columns/rows or use Auto-fit.`, "warn");
  else say("planMsg", `${seated} candidates seated across ${S.seats.length} desks (${S.cols} × ${S.rows}).`, "ok");
  dirty();
}

$("seatGrid").addEventListener("click", (e) => {
  const el = e.target.closest("[data-i]");
  if (!el) return;
  const seat = S.seats[+el.dataset.i];
  if (seat.cand) { S.pool = [...S.pool, seat.cand].sort(byExam); seat.cand = null; }
  else if (S.poolSel) {
    const k = S.pool.findIndex((c) => c.examNo === S.poolSel);
    if (k < 0) return;
    seat.cand = S.pool.splice(k, 1)[0]; S.poolSel = null;
  } else return say("planMsg", "Select a name under “Unassigned”, then click an empty desk.", "warn");
  renderAll();
});
$("pool").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-id]");
  if (!chip) return;
  S.poolSel = S.poolSel === chip.dataset.id ? null : chip.dataset.id;
  renderAll();
});

/* ---------- venues ---------- */
async function loadVenues() {
  try {
    const snap = await getDocs(query(collection(db, EXAM_VENUES_COLLECTION), where("year", "==", year())));
    S.venues = snap.docs.map((d) => ({ key: d.id, ...d.data() })).sort((a, b) => String(a.venue).localeCompare(String(b.venue)));
  } catch (err) { console.warn("venues", err.code); S.venues = []; }
  $("venueSel").innerHTML = `<option value="">— Saved venues (${S.venues.length}) —</option>` +
    S.venues.map((v) => `<option value="${esc(v.key)}" ${v.key === S.loaded ? "selected" : ""}>${esc(v.venue)} (${(v.candidates || []).length})</option>`).join("");
}

$("loadVenueBtn").addEventListener("click", () => {
  const v = S.venues.find((x) => x.key === $("venueSel").value);
  if (!v) return say("venueMsg", "Choose a saved venue first.", "warn");
  $("venueIn").value = v.venue; $("sessionIn").value = v.session || "";
  $("subjectSel").value = v.subject || ""; if ($("subjectSel").value !== (v.subject || "")) $("subjectSel").value = "";
  $("groupSel").value = v.group || "all"; $("typeSel").value = v.concType || ""; $("typeSel").disabled = $("groupSel").value !== "only";
  $("colsIn").value = v.cols; $("rowsIn").value = v.rows;
  const byId = new Map(S.cands.map((c) => [c.examNo, c]));
  const people = (v.candidates || []).map((id) => byId.get(String(id))).filter(Boolean);
  const lost = (v.candidates || []).length - people.length;
  S.list = people.sort(byExam); S.sel = new Set(people.map((c) => c.examNo));
  S.cols = clamp(v.cols); S.rows = clamp(v.rows);
  S.seats = snake(S.cols, S.rows).map((p, i) => ({ ...p, no: i + 1, cand: null }))
    .sort((a, b) => a.r * S.cols + a.c - (b.r * S.cols + b.c));
  const placed = new Set();
  (v.seated || []).forEach((x) => {
    const c = byId.get(String(x.examNo)), s = x.r < S.rows && x.c < S.cols ? at(x.r, x.c) : null;
    if (c && s && !s.cand) { s.cand = c; placed.add(c.examNo); }
  });
  S.pool = people.filter((c) => !placed.has(c.examNo));
  S.loaded = v.key; S.poolSel = null;
  renderTable(); renderAll();
  say("venueMsg", `Loaded “${esc(v.venue)}”.${lost ? ` ${lost} candidate(s) no longer exist for ${year()}.` : ""}`, lost ? "warn" : "ok");
});

$("saveBtn").addEventListener("click", async () => {
  const venue = $("venueIn").value.trim(), key = venueKey(venue);
  if (!key) return say("exportMsg", "Enter a venue name first.", "warn");
  if (!S.sel.size) return say("exportMsg", "Tick at least one candidate.", "warn");
  const btn = $("saveBtn"); btn.disabled = true;
  try {
    const ref = doc(db, EXAM_VENUES_COLLECTION, key), isNew = key !== S.loaded;
    if (isNew && (await getDoc(ref)).exists()) return say("exportMsg", `A venue called “${esc(venue)}” already exists. Pick another name or load it to edit.`, "err");
    const email = auth.currentUser?.email || "";
    await setDoc(ref, {
      venue, year: year(), session: $("sessionIn").value.trim(), subject: $("subjectSel").value, group: $("groupSel").value, concType: $("typeSel").value,
      cols: S.cols, rows: S.rows,
      candidates: S.list.filter((c) => S.sel.has(c.examNo)).map((c) => c.examNo),
      seated: S.seats.filter((s) => s.cand).map((s) => ({ r: s.r, c: s.c, examNo: s.cand.examNo })),
      updatedBy: email, updatedAt: serverTimestamp(),
      ...(isNew ? { createdBy: email, createdAt: serverTimestamp() } : {}),
    }, { merge: true });
    S.loaded = key; await loadVenues();
    say("exportMsg", `Venue “${esc(venue)}” saved.`, "ok");
  } catch (err) { say("exportMsg", `Could not save: ${esc(err.message)}`, "err"); }
  finally { btn.disabled = false; }
});

/* ---------- export ---------- */
async function canvas() {
  if (S.canvas) return S.canvas;
  const placed = S.seats.filter((s) => s.cand).length;
  if (!placed) throw new Error("Seat some candidates first.");
  const stage = document.createElement("div");
  stage.className = "export-stage";
  const sub = [$("subjectSel").value, $("sessionIn").value.trim(), `${placed} candidates`, new Date().toLocaleDateString()].filter(Boolean).join(" · ");
  stage.innerHTML = `<div class="ex-title">${esc($("venueIn").value.trim() || "Finals seating plan")}</div><div class="ex-sub">${esc(sub)}</div>
    <div class="ex-front">FRONT OF ROOM</div>
    <div class="seat-grid" style="grid-template-columns:repeat(${S.cols},var(--seat-w))">${S.seats.map((s, i) => seatHtml(s, i, true)).join("")}</div>`;
  document.body.appendChild(stage);
  try { return (S.canvas = await html2canvas(stage, { backgroundColor: "#ffffff", scale: 2 })); }
  finally { stage.remove(); }
}

$("downloadBtn").addEventListener("click", async () => {
  try {
    const c = await canvas(), a = document.createElement("a");
    a.href = c.toDataURL("image/png"); a.download = `${safe($("venueIn").value)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    say("exportMsg", "Image downloaded.", "ok");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});

function popup(html) {
  const w = window.open("", "_blank");
  if (!w) return say("exportMsg", "Pop-up blocked — allow pop-ups or use Download.", "err");
  w.document.write(html); w.document.close();
}

$("printBtn").addEventListener("click", async () => {
  try {
    const c = await canvas();
    popup(`<!doctype html><title>Seating Plan</title><style>@page{size:A4 landscape;margin:8mm}body{margin:0}img{width:100%;display:block}</style><img src="${c.toDataURL("image/png")}" onload="setTimeout(function(){print()},200)">`);
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});

// Signable register in desk order. Concession status is deliberately not shown.
$("registerBtn").addEventListener("click", () => {
  const list = S.seats.filter((s) => s.cand).sort((a, b) => a.no - b.no);
  if (!list.length) return say("exportMsg", "Seat some candidates first.", "warn");
  const title = esc($("venueIn").value.trim() || "Finals register");
  const sub = esc([$("subjectSel").value, $("sessionIn").value.trim(), new Date().toLocaleDateString()].filter(Boolean).join(" · "));
  popup(`<!doctype html><title>Register</title><style>@page{size:A4;margin:12mm}body{font:12px Arial,sans-serif}table{width:100%;border-collapse:collapse}
    td,th{border:1px solid #444;padding:6px;text-align:left}th{background:#eee}td.s{width:150px}</style>
    <h2 style="margin:0">${title}</h2><p>${sub}</p>
    <table><tr><th>Desk</th><th>Exam No</th><th>Name</th><th>Class</th><th>Signature</th></tr>
    ${list.map((s) => `<tr><td>${s.no}</td><td>${esc(s.cand.examNo)}</td><td>${esc(nameOf(s.cand))}</td><td>${esc(clsOf(s.cand.s))}</td><td class="s"></td></tr>`).join("")}</table>
    <script>setTimeout(function(){print()},200)<\/script>`);
});

["venueIn", "sessionIn"].forEach((i) => $(i).addEventListener("input", dirty));