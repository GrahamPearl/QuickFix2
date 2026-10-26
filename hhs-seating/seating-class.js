/**
 * seating-class.js — Grade 8 & 9 seating plans by registration class.
 * S-snake fill, adjustable room size, manual edit, wide PNG export with a
 * small photo on every card. Reads the cached roster (data-service.js).
 */
import { auth, onAuthStateChanged } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";

const $ = (id) => document.getElementById(id);
const { IMAGE_BASE_URL } = window.APP_CONFIG;

const S = { roster: [], list: [], selected: new Set(), cols: 6, rows: 6, seats: [], pool: [], poolSel: null, canvas: null };

/* ---------- helpers ---------- */
const clsOf = (s) => String(s.registrationClass || s.class || "").trim();
const photoSrc = (f) => (f ? IMAGE_BASE_URL + encodeURI(f) : "");
const ini = (s) => `${(s.firstName || "?")[0]}${(s.lastName || "?")[0]}`.toUpperCase();
const low = (v) => String(v || "").toLowerCase();
const byName = (a, b) => low(a.lastName).localeCompare(low(b.lastName)) || low(a.firstName).localeCompare(low(b.firstName));
const clamp = (v) => Math.min(30, Math.max(1, parseInt(v, 10) || 1));
const safeName = (s) => String(s || "SeatingPlan").replace(/[^\w\-]+/g, "_");

function say(id, html, cls = "") {
  const el = $(id);
  el.className = `plan-msg ${cls}`;
  el.innerHTML = html;
}

/* ---------- access gate ---------- */
function deny(msg) {
  $("app").classList.add("is-hidden");
  $("gate").style.display = "flex";
  $("gate").innerHTML = `<p class="error-text">${esc(msg)} <a href="index.html">Return to the roster</a></p>`;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  try {
    const cfg = await loadUserTypes();
    const type = await resolveUserType(user, cfg);
    if (!can(cfg, type, "view")) { deny("Access denied."); return; }
    $("userBadge").textContent = user.email;
    $("userBadge").classList.remove("is-hidden");
    S.roster = (await getAllStudents()).filter((s) => s && s.adminNo && ["8", "9"].includes(String(s.grade)));
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    fillClasses();
  } catch (err) {
    console.error(err);
    deny(`Could not load data: ${err.message}`);
  }
});

/* ---------- class + learner selection ---------- */
function fillClasses() {
  const g = $("gradeSel").value;
  const classes = [...new Set(S.roster.filter((s) => String(s.grade) === g).map(clsOf).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $("classSel").innerHTML = `<option value="">Select a class…</option>` + classes.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  loadClass();
}

function loadClass() {
  const g = $("gradeSel").value, c = $("classSel").value;
  S.list = c ? S.roster.filter((s) => String(s.grade) === g && clsOf(s) === c).sort(byName) : [];
  S.selected = new Set(S.list.map((s) => String(s.adminNo)));
  $("titleIn").value = c ? `Grade ${g} ${c} — Seating Plan` : "";
  renderTable();
  if (!c) { S.seats = []; S.pool = []; renderGrid(); renderPool(); say("planMsg", ""); return; }
  const rows = clamp($("rowsIn").value);
  if (S.list.length > rows * clamp($("colsIn").value)) $("colsIn").value = Math.min(30, Math.ceil(S.list.length / rows));
  generate();
}

function renderTable() {
  $("candBody").innerHTML = S.list.map((s) => {
    const on = S.selected.has(String(s.adminNo));
    return `<tr class="${on ? "" : "is-unselected"}" data-id="${esc(s.adminNo)}">
      <td><input type="checkbox" class="cand-check" ${on ? "checked" : ""}></td>
      <td>${esc(low(s.lastName).toUpperCase())}, ${esc(s.firstName)}</td>
      <td class="mono">${esc(s.adminNo)}</td></tr>`;
  }).join("") || `<tr><td colspan="3" class="empty-hint">Choose a class.</td></tr>`;
  $("candCount").textContent = S.list.length ? `(${S.selected.size} of ${S.list.length} selected)` : "";
}

$("gradeSel").addEventListener("change", fillClasses);
$("classSel").addEventListener("change", loadClass);
$("candBody").addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = tr.dataset.id;
  e.target.checked ? S.selected.add(id) : S.selected.delete(id);
  tr.classList.toggle("is-unselected", !e.target.checked);
  $("candCount").textContent = `(${S.selected.size} of ${S.list.length} selected)`;
});
$("selAllBtn").addEventListener("click", () => { S.selected = new Set(S.list.map((s) => String(s.adminNo))); renderTable(); });
$("selNoneBtn").addEventListener("click", () => { S.selected = new Set(); renderTable(); });

/* ---------- S-snake ---------- */
// Down the first column, up the next, and so on. cols = desks across, rows = desks deep.
function snakeOrder(cols, rows) {
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) order.push({ r, c });
    else for (let r = rows - 1; r >= 0; r--) order.push({ r, c });
  }
  return order;
}

function generate() {
  if (!S.list.length) return;
  S.cols = clamp($("colsIn").value);
  S.rows = clamp($("rowsIn").value);
  const order = snakeOrder(S.cols, S.rows);
  S.seats = new Array(order.length);
  order.forEach((p, i) => (S.seats[p.r * S.cols + p.c] = { no: i + 1, student: null }));

  const people = S.list.filter((s) => S.selected.has(String(s.adminNo)));
  people.slice(0, order.length).forEach((s, i) => (S.seats[order[i].r * S.cols + order[i].c].student = s));
  S.pool = people.slice(order.length);
  S.poolSel = null;
  renderGrid();
  renderPool();
  hidePreview();

  if (!people.length) say("planMsg", "No learners are ticked — nothing to seat.", "warn");
  else if (S.pool.length) say("planMsg", `${S.seats.length} seats for ${people.length} learners — ${S.pool.length} unassigned. Add columns/rows or use Auto-fit.`, "warn");
  else say("planMsg", `${people.length} learners seated across ${S.seats.length} seats (${S.cols} × ${S.rows}).`, "ok");
}

$("generateBtn").addEventListener("click", generate);
$("colsIn").addEventListener("change", generate);
$("rowsIn").addEventListener("change", generate);
$("fitBtn").addEventListener("click", () => {
  const n = S.selected.size || S.list.length;
  $("colsIn").value = Math.min(30, Math.ceil(n / clamp($("rowsIn").value)) || 1);
  generate();
});

/* ---------- rendering ---------- */
function seatHtml(seat, forExport) {
  const s = seat.student;
  if (!s) return `<div class="seat empty">${forExport ? "" : "Empty seat"}</div>`;
  const src = photoSrc(s.photo);
  const photo = src
    ? `<img class="seat-photo" crossorigin="anonymous" src="${esc(src)}" data-ini="${esc(ini(s))}" alt="">`
    : `<span class="seat-photo seat-initials">${esc(ini(s))}</span>`;
  return `<div class="seat filled" title="${forExport ? "" : "Click to remove"}">
    <span class="seat-no">${seat.no}</span>${photo}
    <div class="seat-text"><div class="seat-sur">${esc(low(s.lastName).toUpperCase())}</div>
      <div class="seat-first">${esc(s.firstName)}</div><div class="seat-adm">${esc(s.adminNo)}</div></div></div>`;
}

// Resolves once every photo has loaded or failed; failed photos become initials.
function prepareImages(root) {
  const jobs = [...root.querySelectorAll("img.seat-photo")].map((img) => new Promise((res) => {
    const fail = () => {
      const sp = document.createElement("span");
      sp.className = "seat-photo seat-initials";
      sp.textContent = img.dataset.ini || "?";
      img.replaceWith(sp);
      res();
    };
    if (img.complete) return img.naturalWidth ? res() : fail();
    img.addEventListener("load", () => res(), { once: true });
    img.addEventListener("error", fail, { once: true });
  }));
  return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 10000))]);
}

function renderGrid() {
  const g = $("seatGrid");
  g.style.gridTemplateColumns = `repeat(${S.cols}, var(--seat-w))`;
  g.innerHTML = S.seats.map((seat, i) => seatHtml(seat, false).replace(/^<div class="seat/, `<div data-i="${i}" class="seat`)).join("");
  prepareImages(g);
}

function renderPool() {
  $("poolBadge").textContent = S.pool.length;
  $("pool").innerHTML = S.pool.length
    ? S.pool.map((s) => `<span class="pool-chip ${String(s.adminNo) === S.poolSel ? "selected" : ""}" data-id="${esc(s.adminNo)}">${esc(low(s.lastName).toUpperCase())}, ${esc(s.firstName)}</span>`).join("")
    : `<span class="empty-hint">No unassigned learners.</span>`;
}

$("seatGrid").addEventListener("click", (e) => {
  const el = e.target.closest("[data-i]");
  if (!el) return;
  const seat = S.seats[+el.dataset.i];
  if (seat.student) {
    S.pool = [...S.pool, seat.student].sort(byName);
    seat.student = null;
  } else if (S.poolSel) {
    const i = S.pool.findIndex((s) => String(s.adminNo) === S.poolSel);
    if (i < 0) return;
    seat.student = S.pool.splice(i, 1)[0];
    S.poolSel = null;
  } else {
    say("planMsg", "Select a name under “Unassigned”, then click an empty seat.", "warn");
    return;
  }
  renderGrid(); renderPool(); hidePreview();
});

$("pool").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-id]");
  if (!chip) return;
  S.poolSel = S.poolSel === chip.dataset.id ? null : chip.dataset.id;
  renderPool();
});

/* ---------- export (one wide image) ---------- */
function hidePreview() {
  S.canvas = null;
  $("previewWrap").classList.add("is-hidden");
}

async function renderCanvas() {
  const placed = S.seats.filter((s) => s.student).length;
  if (!placed) throw new Error("Generate a seating plan first.");
  const stage = document.createElement("div");
  stage.className = "export-stage";
  const sub = [$("roomIn").value.trim(), `${placed} learners`, new Date().toLocaleDateString()].filter(Boolean).join(" · ");
  stage.innerHTML = `<div class="ex-title">${esc($("titleIn").value || "Seating Plan")}</div>
    <div class="ex-sub">${esc(sub)}</div><div class="ex-front">FRONT OF ROOM</div>
    <div class="seat-grid" style="grid-template-columns:repeat(${S.cols},var(--seat-w))">${S.seats.map((s) => seatHtml(s, true)).join("")}</div>`;
  document.body.appendChild(stage);
  try {
    await prepareImages(stage);
    return await html2canvas(stage, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
  } finally {
    stage.remove();
  }
}

async function ensureCanvas() {
  if (!S.canvas) S.canvas = await renderCanvas();
  return S.canvas;
}

$("previewBtn").addEventListener("click", async () => {
  say("exportMsg", "Rendering…", "warn");
  try {
    const c = await ensureCanvas();
    $("previewImg").src = c.toDataURL("image/png");
    $("previewImg").style.width = `${c.width / 2}px`;
    $("previewWrap").classList.remove("is-hidden");
    say("exportMsg", "Preview ready.", "ok");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});

$("downloadBtn").addEventListener("click", async () => {
  say("exportMsg", "Rendering…", "warn");
  try {
    const c = await ensureCanvas();
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = `${safeName($("titleIn").value)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    say("exportMsg", "Image downloaded.", "ok");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});

$("printBtn").addEventListener("click", async () => {
  say("exportMsg", "Rendering…", "warn");
  try {
    const c = await ensureCanvas();
    const w = window.open("", "_blank");
    if (!w) { say("exportMsg", "Pop-up blocked — allow pop-ups or use Download.", "err"); return; }
    w.document.write(`<!doctype html><title>Seating Plan</title><style>@page{size:A4 landscape;margin:8mm}body{margin:0}img{width:100%;display:block}</style><img src="${c.toDataURL("image/png")}" onload="setTimeout(function(){print()},200)">`);
    w.document.close();
    say("exportMsg", "", "");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});

$("titleIn").addEventListener("input", hidePreview);
$("roomIn").addEventListener("input", hidePreview);
