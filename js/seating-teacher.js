/**
 * seating-teacher.js — Grade 10/11 seating by subject + teacher(s).
 * Combine classes by ticking several teachers; S-snake fill; drag/click to
 * move or swap; pin learners with seating needs; block desks; save per class.
 */
import { auth, onAuthStateChanged, db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { getAllStudents, collectSubjects } from "./data-service.js";
import { subjectKey } from "./edit-form.js";
import { escapeHtml as esc } from "./html.js";
import { loadLibs } from "./lazy-libs.js";

const $ = (i) => document.getElementById(i);
const { IMAGE_BASE_URL, SEATING_COLLECTION = "seatingPlans" } = window.APP_CONFIG;
const COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83", "#c2185b", "#5f6368"];

const S = {
  roster: [], subject: "", teachers: [], selTeachers: new Set(), list: [], selected: new Set(), unticked: new Set(),
  cols: 6, rows: 6, seats: [], pool: [], pins: new Map(), blocked: new Set(), notes: new Map(),
  pick: null, dirty: false, canvas: null, titleEdited: false, checkSeq: 0,
};

/* ---------- helpers ---------- */
const id = (s) => String(s.adminNo);
const low = (v) => String(v || "").toLowerCase();
const clsOf = (s) => String(s.registrationClass || s.class || "").trim();
const ini = (s) => `${(s.firstName || "?")[0]}${(s.lastName || "?")[0]}`.toUpperCase();
const photoSrc = (f) => (f ? IMAGE_BASE_URL + encodeURI(f) : ""); // swap for an authenticated loader later
const clamp = (v) => Math.min(30, Math.max(1, parseInt(v, 10) || 1));
const key = (r, c) => `${r},${c}`;
const safeName = (s) => String(s || "SeatingPlan").replace(/[^\w\-]+/g, "_");
const byName = (a, b) => low(a.lastName).localeCompare(low(b.lastName)) || low(a.firstName).localeCompare(low(b.firstName));
const teacherOf = (s) => String(s.enrollments?.[subjectKey(S.subject)]?.teacher || "").trim() || "Unassigned";
const colorOf = (t) => COLORS[Math.max(0, S.teachers.findIndex((x) => x.name === t)) % COLORS.length];
const grades = () => [...document.querySelectorAll(".grade-chk:checked")].map((x) => x.value).sort();
const at = (r, c) => S.seats[r * S.cols + c];
const nameOf = (s) => `${low(s.lastName).toUpperCase()}, ${s.firstName}`;

function ordered(list) {
  const teacherFirst = $("sortSel").value === "teacher";
  return [...list].sort((a, b) => (teacherFirst ? teacherOf(a).localeCompare(teacherOf(b)) : 0) || byName(a, b));
}
const people = () => S.list.filter((s) => S.selected.has(id(s)));
function say(el, html, cls = "") { $(el).className = `plan-msg ${cls}`; $(el).innerHTML = html; }

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
    if (!can(cfg, await resolveUserType(user, cfg), "view")) { deny("Access denied."); return; }
    $("userBadge").textContent = user.email;
    $("userBadge").classList.remove("is-hidden");
    S.roster = (await getAllStudents()).filter((s) => s && s.adminNo && ["10", "11"].includes(String(s.grade)));
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    fillSubjects();
    resize();
    render();
  } catch (err) { console.error(err); deny(`Could not load data: ${err.message}`); }
});

/* ---------- selection: grades → subject → teachers ---------- */
const inGrades = (s) => grades().includes(String(s.grade));

function fillSubjects() {
  const subs = collectSubjects(S.roster.filter(inGrades));
  if (!subs.includes(S.subject)) S.subject = "";
  $("subjectSel").innerHTML = `<option value="">Select a subject…</option>` + subs.map((s) => `<option ${s === S.subject ? "selected" : ""}>${esc(s)}</option>`).join("");
  computeTeachers();
}

function computeTeachers() {
  const counts = new Map();
  if (S.subject) S.roster.filter((s) => inGrades(s) && (s.subjectsSummary || []).includes(S.subject))
    .forEach((s) => counts.set(teacherOf(s), (counts.get(teacherOf(s)) || 0) + 1));
  S.teachers = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  S.selTeachers = new Set([...S.selTeachers].filter((t) => counts.has(t)));
  renderTeachers();
}

function renderTeachers() {
  $("teacherBox").innerHTML = S.teachers.length ? S.teachers.map((t) => `
    <label class="tch ${S.selTeachers.has(t.name) ? "on" : ""}"><input type="checkbox" value="${esc(t.name)}" ${S.selTeachers.has(t.name) ? "checked" : ""}>
      <span class="dot" style="background:${colorOf(t.name)}"></span>${esc(t.name)} <span class="empty-hint">(${t.count})</span></label>`).join("")
    : `<span class="empty-hint">${S.subject ? "No teachers found." : "Choose a subject first."}</span>`;
}

$("subjectSel").addEventListener("change", (e) => {
  S.subject = e.target.value;
  S.selTeachers = new Set(); S.unticked = new Set(); S.pins.clear(); S.notes.clear(); S.titleEdited = false;
  computeTeachers(); refresh();
});
document.querySelectorAll(".grade-chk").forEach((c) => c.addEventListener("change", () => { fillSubjects(); refresh(); }));
$("teacherBox").addEventListener("change", (e) => {
  e.target.checked ? S.selTeachers.add(e.target.value) : S.selTeachers.delete(e.target.value);
  renderTeachers(); refresh();
});
$("tAllBtn").addEventListener("click", () => { S.selTeachers = new Set(S.teachers.map((t) => t.name)); renderTeachers(); refresh(); });
$("tNoneBtn").addEventListener("click", () => { S.selTeachers = new Set(); renderTeachers(); refresh(); });
$("sortSel").addEventListener("change", () => { S.list = ordered(S.list); renderTable(); });
$("titleIn").addEventListener("input", () => { S.titleEdited = true; hidePreview(); });
$("roomIn").addEventListener("input", hidePreview);

function rebuildList() {
  S.list = S.subject
    ? ordered(S.roster.filter((s) => inGrades(s) && (s.subjectsSummary || []).includes(S.subject) && S.selTeachers.has(teacherOf(s))))
    : [];
  S.selected = new Set(S.list.map(id).filter((x) => !S.unticked.has(x)));
}

function updateTitle() {
  if (S.titleEdited) return;
  const g = grades().join(" & ");
  $("titleIn").value = S.subject && S.selTeachers.size ? `Grade ${g} ${S.subject} — ${[...S.selTeachers].join(" + ")}` : "";
}

function refresh() {
  rebuildList(); renderTable(); updateTitle(); syncSelection(); render(); checkSaved();
}

function renderTable() {
  $("candBody").innerHTML = S.list.map((s) => {
    const on = S.selected.has(id(s)), t = teacherOf(s);
    return `<tr class="${on ? "" : "is-unselected"}" data-id="${esc(id(s))}"><td><input type="checkbox" class="cand-check" ${on ? "checked" : ""}></td>
      <td>${esc(nameOf(s))}</td><td>${esc(clsOf(s))}</td>
      <td><span class="dot" style="background:${colorOf(t)}"></span> ${esc(t)}</td><td class="mono">${esc(id(s))}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty-hint">Choose a subject and tick one or more teachers.</td></tr>`;
}

$("candBody").addEventListener("change", (e) => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const sid = tr.dataset.id;
  if (e.target.checked) { S.selected.add(sid); S.unticked.delete(sid); } else { S.selected.delete(sid); S.unticked.add(sid); }
  tr.classList.toggle("is-unselected", !e.target.checked);
  syncSelection(); markDirty(); render();
});
$("selAllBtn").addEventListener("click", () => { S.unticked.clear(); S.selected = new Set(S.list.map(id)); renderTable(); syncSelection(); markDirty(); render(); });
$("selNoneBtn").addEventListener("click", () => { S.list.forEach((s) => S.unticked.add(id(s))); S.selected.clear(); renderTable(); syncSelection(); markDirty(); render(); });

/* ---------- layout engine ---------- */
function snakeOrder(cols, rows) {
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) order.push({ r, c });
    else for (let r = rows - 1; r >= 0; r--) order.push({ r, c });
  }
  return order;
}

function renumber() {
  let n = 0;
  snakeOrder(S.cols, S.rows).forEach((p) => { const s = at(p.r, p.c); s.no = s.blocked ? 0 : ++n; });
}

function refreshPin(st, seat) { if (S.pins.has(id(st))) S.pins.set(id(st), { r: seat.r, c: seat.c }); }

// Rebuilds the grid at the current input size, keeping learners where they are.
function resize() {
  const keep = S.seats.filter((s) => s.student);
  S.cols = clamp($("colsIn").value); S.rows = clamp($("rowsIn").value);
  S.seats = [];
  for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) S.seats.push({ r, c, no: 0, blocked: S.blocked.has(key(r, c)), student: null });
  renumber();
  keep.forEach((o) => {
    const s = o.r < S.rows && o.c < S.cols ? at(o.r, o.c) : null;
    if (s && !s.blocked) { s.student = o.student; refreshPin(o.student, s); } else { S.pool.push(o.student); S.pins.delete(id(o.student)); }
  });
  fillFree();
}

function fillFree() {
  S.pool = ordered(S.pool);
  for (const p of snakeOrder(S.cols, S.rows)) {
    if (!S.pool.length) break;
    const s = at(p.r, p.c);
    if (!s.blocked && !s.student) { s.student = S.pool.shift(); refreshPin(s.student, s); }
  }
}

// Reconciles the grid with the ticked learners without disturbing anyone already seated.
function syncSelection() {
  const ids = new Set(people().map(id));
  S.seats.forEach((s) => { if (s.student && !ids.has(id(s.student))) { S.pins.delete(id(s.student)); S.notes.delete(id(s.student)); s.student = null; } });
  S.pool = S.pool.filter((p) => ids.has(id(p)));
  const have = new Set([...S.seats.filter((s) => s.student).map((s) => id(s.student)), ...S.pool.map(id)]);
  S.pool.push(...people().filter((p) => !have.has(id(p))));
  S.pick = null;
  fillFree();
}

function generate() {
  S.seats.forEach((s) => { if (s.student && !S.pins.has(id(s.student))) s.student = null; });
  S.pool = [];
  resize(); syncSelection();
  S.dirty = false; render();
}

const markDirty = () => { S.dirty = true; };
$("generateBtn").addEventListener("click", () => {
  if (S.dirty && !confirm("Re-seat everyone in S-snake order? Pinned learners stay where they are; other manual changes are reset.")) return;
  generate();
});
["colsIn", "rowsIn"].forEach((i) => $(i).addEventListener("change", () => { resize(); markDirty(); render(); }));
$("fitBtn").addEventListener("click", () => {
  const n = people().length, rows = clamp($("rowsIn").value);
  let cols = 1;
  for (; cols < 30; cols++) {
    let free = 0;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!S.blocked.has(key(r, c))) free++;
    if (free >= n) break;
  }
  $("colsIn").value = cols; resize(); markDirty(); render();
});

/* ---------- moving learners ---------- */
function place(src, i) {
  const t = S.seats[i];
  if (t.blocked) return;
  let st;
  if (src.kind === "seat") {
    const from = S.seats[src.i];
    if (src.i === i || !from.student) return;
    st = from.student; from.student = t.student; t.student = st;
    if (from.student) refreshPin(from.student, from);
  } else {
    const k = S.pool.findIndex((p) => id(p) === src.id);
    if (k < 0) return;
    st = S.pool.splice(k, 1)[0];
    if (t.student) { S.pool.push(t.student); S.pins.delete(id(t.student)); S.pool = ordered(S.pool); }
    t.student = st;
  }
  refreshPin(st, t);
  S.pick = null; markDirty(); render();
}

function toPool(i) {
  const s = S.seats[i];
  if (!s.student) return;
  S.pins.delete(id(s.student));
  S.pool = ordered([...S.pool, s.student]);
  s.student = null; S.pick = null; markDirty(); render();
}

function onSeatClick(i) {
  const s = S.seats[i], p = S.pick;
  if (!p) { S.pick = { kind: "seat", i }; return render(); }
  if (p.kind === "pool") { if (!s.blocked) place(p, i); return; }
  if (p.i === i) { S.pick = null; return render(); }
  if (S.seats[p.i].student && !s.blocked) place(p, i);
  else { S.pick = { kind: "seat", i }; render(); }
}

/* ---------- rendering ---------- */
function seatHtml(seat, i, ex, showNotes) {
  const attr = ex ? "" : `data-i="${i}"`;
  if (seat.blocked) return `<div ${attr} class="seat blocked${!ex && S.pick?.kind === "seat" && S.pick.i === i ? " picked" : ""}">${ex ? "" : "No desk"}</div>`;
  const st = seat.student;
  const picked = !ex && S.pick?.kind === "seat" && S.pick.i === i;
  if (!st) return `<div ${attr} class="seat empty${picked ? " picked" : ""}">${ex ? "" : `Empty · ${seat.no}`}</div>`;
  const src = photoSrc(st.photo);
  const photo = src
    ? `<img class="seat-photo" crossorigin="anonymous" src="${esc(src)}" data-ini="${esc(ini(st))}" alt="">`
    : `<span class="seat-photo seat-initials">${esc(ini(st))}</span>`;
  const pinned = !ex && S.pins.has(id(st));
  const note = S.notes.get(id(st));
  return `<div ${attr} ${ex ? "" : 'draggable="true"'} class="seat filled${picked ? " picked" : ""}${pinned ? " pinned" : ""}"
      style="border-left:6px solid ${colorOf(teacherOf(st))}">
    <span class="seat-no">${seat.no}</span>${photo}
    <div class="seat-text"><div class="seat-sur">${esc(low(st.lastName).toUpperCase())}</div><div class="seat-first">${esc(st.firstName)}</div>
      <div class="seat-adm">${esc(clsOf(st))} · ${esc(id(st))}</div>
      ${note && (!ex || showNotes) ? `<div class="seat-note">${esc(note)}</div>` : ""}</div>
    ${pinned ? '<span class="seat-pin">📌</span>' : ""}</div>`;
}

function prepareImages(root) {
  const jobs = [...root.querySelectorAll("img.seat-photo")].map((img) => new Promise((res) => {
    const fail = () => { const sp = document.createElement("span"); sp.className = "seat-photo seat-initials"; sp.textContent = img.dataset.ini || "?"; img.replaceWith(sp); res(); };
    if (img.complete) return img.naturalWidth ? res() : fail();
    img.addEventListener("load", () => res(), { once: true });
    img.addEventListener("error", fail, { once: true });
  }));
  return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 10000))]);
}

function legendHtml(small) {
  const counts = new Map();
  people().forEach((s) => counts.set(teacherOf(s), (counts.get(teacherOf(s)) || 0) + 1));
  return [...counts].map(([t, n]) => `<span><span class="dot" style="background:${colorOf(t)}"></span> ${esc(t)} (${n})</span>`).join("");
}

function render() {
  const g = $("seatGrid");
  g.style.gridTemplateColumns = `repeat(${S.cols}, var(--seat-w))`;
  g.innerHTML = S.seats.map((s, i) => seatHtml(s, i, false)).join("");
  prepareImages(g);
  $("legend").innerHTML = legendHtml();
  $("poolBadge").textContent = S.pool.length;
  $("pool").innerHTML = S.pool.length
    ? S.pool.map((s) => `<span class="pool-chip ${S.pick?.kind === "pool" && S.pick.id === id(s) ? "picked" : ""}" draggable="true" data-id="${esc(id(s))}"
        style="border-left:5px solid ${colorOf(teacherOf(s))}">${esc(nameOf(s))}</span>`).join("")
    : `<span class="empty-hint">No unassigned learners.</span>`;
  renderBar(); hidePreview(); status();
}

function status() {
  const n = people().length, seated = S.seats.filter((s) => s.student).length, desks = S.seats.filter((s) => !s.blocked).length;
  $("candCount").textContent = S.list.length ? `(${n} of ${S.list.length} ticked)` : "";
  if (!S.subject || !S.selTeachers.size) say("planMsg", "Choose a subject and tick one or more teachers.", "warn");
  else if (S.pool.length) say("planMsg", `${S.pool.length} learner(s) have no desk (${desks} desks for ${n} learners). Add columns or rows, or use Auto-fit.`, "warn");
  else say("planMsg", `${seated} learners seated · ${desks} desks (${S.cols} × ${S.rows})${S.dirty ? " · unsaved changes" : ""}`, "ok");
}

function renderBar() {
  const bar = $("pickBar"), p = S.pick;
  bar.classList.toggle("is-hidden", !p);
  if (!p) return;
  if (p.kind === "pool") {
    const st = S.pool.find((x) => id(x) === p.id);
    bar.innerHTML = `<span class="grow"><strong>${esc(st ? nameOf(st) : "")}</strong> — click a desk to place (occupied desk = swap)</span><button class="btn" data-act="cancel">Cancel</button>`;
    return;
  }
  const seat = S.seats[p.i], st = seat.student;
  if (st) {
    const pinned = S.pins.has(id(st)), note = S.notes.get(id(st));
    bar.innerHTML = `<span class="grow"><strong>${esc(nameOf(st))}</strong> · desk ${seat.no}${note ? ` · <em>${esc(note)}</em>` : ""} — click another desk to move/swap</span>
      <button class="btn" data-act="pin">${pinned ? "Unpin" : "Pin here"}</button>
      <button class="btn" data-act="note">${note ? "Edit need" : "Seating need…"}</button>
      <button class="btn" data-act="pool">Remove from grid</button><button class="btn btn-ghost" data-act="cancel">Cancel</button>`;
  } else {
    bar.innerHTML = `<span class="grow">${seat.blocked ? "Blocked desk" : `Empty desk ${seat.no}`} — click a learner to move them here</span>
      <button class="btn" data-act="block">${seat.blocked ? "Unblock desk" : "Block desk (aisle / unusable)"}</button><button class="btn btn-ghost" data-act="cancel">Cancel</button>`;
  }
}

$("pickBar").addEventListener("click", (e) => {
  const act = e.target.dataset.act, p = S.pick;
  if (!act || !p) return;
  if (act === "cancel") { S.pick = null; return render(); }
  const seat = S.seats[p.i], st = seat?.student;
  if (act === "pin" && st) { S.pins.has(id(st)) ? S.pins.delete(id(st)) : S.pins.set(id(st), { r: seat.r, c: seat.c }); }
  if (act === "note" && st) {
    const v = prompt("Seating need (keep it practical, e.g. “Front row”, “Near door”). Do not record medical details.", S.notes.get(id(st)) || "");
    if (v === null) return;
    if (v.trim()) { S.notes.set(id(st), v.trim()); S.pins.set(id(st), { r: seat.r, c: seat.c }); } else S.notes.delete(id(st));
  }
  if (act === "pool") return toPool(p.i);
  if (act === "block") {
    seat.blocked = !seat.blocked;
    seat.blocked ? S.blocked.add(key(seat.r, seat.c)) : S.blocked.delete(key(seat.r, seat.c));
    renumber(); fillFree(); S.pick = null;
  }
  markDirty(); render();
});

/* grid + pool interactions (click and drag) */
$("seatGrid").addEventListener("click", (e) => { const el = e.target.closest("[data-i]"); if (el) onSeatClick(+el.dataset.i); });
$("pool").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-id]"); if (!chip) return;
  const same = S.pick?.kind === "pool" && S.pick.id === chip.dataset.id;
  S.pick = same ? null : { kind: "pool", id: chip.dataset.id }; render();
});
const dragSrc = (e) => { try { return JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return null; } };
$("seatGrid").addEventListener("dragstart", (e) => { const el = e.target.closest(".seat.filled"); if (el) e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "seat", i: +el.dataset.i })); });
$("pool").addEventListener("dragstart", (e) => { const el = e.target.closest("[data-id]"); if (el) e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "pool", id: el.dataset.id })); });
$("seatGrid").addEventListener("dragover", (e) => { const el = e.target.closest(".seat:not(.blocked)"); if (el) { e.preventDefault(); el.classList.add("drag-over"); } });
$("seatGrid").addEventListener("dragleave", (e) => e.target.closest(".seat")?.classList.remove("drag-over"));
$("seatGrid").addEventListener("drop", (e) => { e.preventDefault(); const el = e.target.closest("[data-i]"), src = dragSrc(e); if (el && src) place(src, +el.dataset.i); });
$("pool").addEventListener("dragover", (e) => { e.preventDefault(); $("pool").classList.add("drag-over"); });
$("pool").addEventListener("dragleave", () => $("pool").classList.remove("drag-over"));
$("pool").addEventListener("drop", (e) => { e.preventDefault(); $("pool").classList.remove("drag-over"); const src = dragSrc(e); if (src?.kind === "seat") toPool(src.i); });

/* ---------- save / load (Firestore) ---------- */
const planId = () => [grades().join(""), subjectKey(S.subject), [...S.selTeachers].map(subjectKey).sort().join("-")].join("__").slice(0, 200);
const ready = () => S.subject && S.selTeachers.size;

async function checkSaved() {
  const seq = ++S.checkSeq, b = $("loadBtn");
  b.disabled = true; b.textContent = "Load saved plan";
  if (!ready()) return;
  try {
    const snap = await getDoc(doc(db, SEATING_COLLECTION, planId()));
    if (seq === S.checkSeq && snap.exists()) { b.disabled = false; b.textContent = "Load saved plan ✓"; }
  } catch (err) { console.warn("saved plan check failed", err.code); }
}

$("saveBtn").addEventListener("click", async () => {
  if (!ready()) return say("exportMsg", "Choose a subject and teacher(s) first.", "warn");
  try {
    await setDoc(doc(db, SEATING_COLLECTION, planId()), {
      grades: grades(), subject: S.subject, teachers: [...S.selTeachers], title: $("titleIn").value, room: $("roomIn").value,
      cols: S.cols, rows: S.rows, sort: $("sortSel").value,
      seated: S.seats.filter((s) => s.student).map((s) => ({ r: s.r, c: s.c, adminNo: id(s.student) })),
      blocked: [...S.blocked], pins: Object.fromEntries(S.pins), notes: Object.fromEntries(S.notes), unticked: [...S.unticked],
      updatedBy: auth.currentUser?.email || "", updatedAt: serverTimestamp(),
    });
    S.dirty = false; status(); checkSaved();
    say("exportMsg", "Plan saved.", "ok");
  } catch (err) { say("exportMsg", `Could not save: ${esc(err.message)}`, "err"); }
});

$("loadBtn").addEventListener("click", async () => {
  try {
    const snap = await getDoc(doc(db, SEATING_COLLECTION, planId()));
    if (!snap.exists()) return;
    const d = snap.data();
    $("roomIn").value = d.room || ""; $("titleIn").value = d.title || ""; S.titleEdited = true;
    $("colsIn").value = d.cols; $("rowsIn").value = d.rows; $("sortSel").value = d.sort || "teacher";
    S.blocked = new Set(d.blocked || []); S.pins = new Map(Object.entries(d.pins || {}));
    S.notes = new Map(Object.entries(d.notes || {})); S.unticked = new Set(d.unticked || []);
    rebuildList(); renderTable();
    S.seats = []; S.pool = []; resize();
    const byId = new Map(people().map((s) => [id(s), s]));
    (d.seated || []).forEach((x) => {
      const st = byId.get(String(x.adminNo)), s = x.r < S.rows && x.c < S.cols ? at(x.r, x.c) : null;
      if (st && s && !s.blocked) s.student = st;
    });
    syncSelection(); S.dirty = false; render();
    say("exportMsg", "Saved plan loaded. Anyone new to the class has been placed in the first free desks.", "ok");
  } catch (err) { say("exportMsg", `Could not load: ${esc(err.message)}`, "err"); }
});

/* ---------- export ---------- */
function hidePreview() { S.canvas = null; $("previewWrap").classList.add("is-hidden"); }

async function renderCanvas() {
  await loadLibs("html2canvas");
  const placed = S.seats.filter((s) => s.student).length;
  if (!placed) throw new Error("Seat some learners first.");
  const showNotes = $("showNotes").checked;
  const stage = document.createElement("div");
  stage.className = "export-stage";
  const sub = [$("roomIn").value.trim(), `${placed} learners`, new Date().toLocaleDateString()].filter(Boolean).join(" · ");
  stage.innerHTML = `<div class="ex-title">${esc($("titleIn").value || "Seating Plan")}</div><div class="ex-sub">${esc(sub)}</div>
    <div class="ex-legend">${legendHtml()}</div><div class="ex-front">FRONT OF ROOM</div>
    <div class="seat-grid" style="grid-template-columns:repeat(${S.cols},var(--seat-w))">${S.seats.map((s, i) => seatHtml(s, i, true, showNotes)).join("")}</div>`;
  document.body.appendChild(stage);
  try {
    await prepareImages(stage);
    return await html2canvas(stage, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
  } finally { stage.remove(); }
}
const ensureCanvas = async () => (S.canvas ||= await renderCanvas());

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
    const c = await ensureCanvas(), a = document.createElement("a");
    a.href = c.toDataURL("image/png"); a.download = `${safeName($("titleIn").value)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    say("exportMsg", "Image downloaded.", "ok");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});
$("printBtn").addEventListener("click", async () => {
  say("exportMsg", "Rendering…", "warn");
  try {
    const c = await ensureCanvas(), w = window.open("", "_blank");
    if (!w) return say("exportMsg", "Pop-up blocked — allow pop-ups or use Download.", "err");
    w.document.write(`<!doctype html><title>Seating Plan</title><style>@page{size:A4 landscape;margin:8mm}body{margin:0}img{width:100%;display:block}</style><img src="${c.toDataURL("image/png")}" onload="setTimeout(function(){print()},200)">`);
    w.document.close();
    say("exportMsg", "");
  } catch (err) { say("exportMsg", esc(err.message), "err"); }
});
$("showNotes").addEventListener("change", hidePreview);
