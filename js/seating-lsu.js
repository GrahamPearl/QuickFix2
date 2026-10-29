/**
 * seating-lsu.js — exam seating for a selected group of learners (e.g. LSU)
 * placed in their own venue, apart from their class.
 * Learners come from a bulk list of Admin Nos; each venue has a unique name
 * and is saved in Firestore. S-snake fill, click to move, PNG export with photos.
 * Reads the cached roster (data-service.js). Modelled on seating-class.js.
 */
import {
  auth, onAuthStateChanged, db, collection, doc, getDoc, getDocs, setDoc, serverTimestamp,
} from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";

const $ = (id) => document.getElementById(id);
const { IMAGE_BASE_URL, LSU_SEATING_COLLECTION = "lsuSeatingVenues" } = window.APP_CONFIG;

const S = {
  roster: [], byAdmin: new Map(),
  list: [],                       // learners in this venue
  cols: 4, rows: 6, seats: [], pool: [], poolSel: null,
  venues: [],                     // saved venues [{ key, venue, students, ... }]
  loadedKey: null,                // key of the saved venue being edited (null = new)
  canSave: false, canvas: null,
  blocked: new Set(),             // unusable desks, keyed "row,col"
  blockMode: false,               // true = clicking a desk toggles unusable
};

/* ---------- helpers ---------- */
const id = (s) => String(s.adminNo).trim();
const clsOf = (s) => String(s.registrationClass || s.class || "").trim();
const photoSrc = (f) => (f ? IMAGE_BASE_URL + encodeURI(f) : "");
const ini = (s) => `${(s.firstName || "?")[0]}${(s.lastName || "?")[0]}`.toUpperCase();
const low = (v) => String(v || "").toLowerCase();
const byName = (a, b) => low(a.lastName).localeCompare(low(b.lastName)) || low(a.firstName).localeCompare(low(b.firstName));
const clamp = (v) => Math.min(30, Math.max(1, parseInt(v, 10) || 1));
const safeName = (s) => String(s || "SeatingPlan").replace(/[^\w\-]+/g, "_");
const venueKey = (name) => String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
const at = (r, c) => S.seats[r * S.cols + c];
const key = (r, c) => `${r},${c}`;
const markDirtyPreview = () => { S.canvas = null; $("previewWrap").classList.add("is-hidden"); };

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
    const type = await resolveUserType(user, cfg);
    if (!can(cfg, type, "view")) { deny("Access denied."); return; }
    S.canSave = can(cfg, type, "edit");
    $("saveBtn").disabled = !S.canSave;
    if (!S.canSave) $("saveBtn").title = "Only users who can edit students may save venues.";
    $("userBadge").textContent = user.email;
    $("userBadge").classList.remove("is-hidden");

    S.roster = (await getAllStudents()).filter((s) => s && s.adminNo);
    S.byAdmin = new Map();
    S.roster.forEach((s) => {
      const k = id(s);
      S.byAdmin.set(k, s);
      S.byAdmin.set(k.padStart(5, "0"), s);
    });

    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    buildSeats(); renderAll();
    await loadVenues();
  } catch (err) {
    console.error(err);
    deny(`Could not load data: ${err.message}`);
  }
});

// Broken photos in the learner table become initials.
document.addEventListener("error", (ev) => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("cand-photo")) return;
  const sp = document.createElement("span");
  sp.className = "cand-photo";
  sp.textContent = img.dataset.ini || "?";
  img.replaceWith(sp);
}, true);

/* ---------- saved venues ---------- */
async function loadVenues() {
  try {
    const snap = await getDocs(collection(db, LSU_SEATING_COLLECTION));
    S.venues = snap.docs.map((d) => ({ key: d.id, ...d.data() }))
      .sort((a, b) => String(a.venue || a.key).localeCompare(String(b.venue || b.key)));
  } catch (err) {
    console.warn("venue list failed", err.code);
    say("venueMsg", "Could not load saved venues (check permissions).", "warn");
  }
  fillVenueSelect();
}

function fillVenueSelect() {
  $("venueSel").innerHTML = `<option value="">— Saved venues (${S.venues.length}) —</option>` +
    S.venues.map((v) => `<option value="${esc(v.key)}" ${v.key === S.loadedKey ? "selected" : ""}>${esc(v.venue || v.key)} (${(v.students || []).length})</option>`).join("");
}

$("loadVenueBtn").addEventListener("click", () => {
  const key = $("venueSel").value;
  const v = S.venues.find((x) => x.key === key);
  if (!v) return say("venueMsg", "Choose a saved venue first.", "warn");
  if (S.list.length && !confirm("Replace the current learners and layout with this saved venue?")) return;

  $("venueIn").value = v.venue || "";
  $("sessionIn").value = v.session || "";
  $("colsIn").value = v.cols || 4;
  $("rowsIn").value = v.rows || 6;
  S.blocked = new Set(v.blocked || []);

  const ids = v.students || (v.seated || []).map((x) => x.adminNo);
  const missing = [];
  S.list = [];
  ids.forEach((a) => {
    const st = S.byAdmin.get(String(a));
    st ? S.list.push(st) : missing.push(a);
  });
  S.list.sort(byName);

  S.seats = []; S.pool = []; buildSeats();           // empty grid at saved size
  const byId = new Map(S.list.map((s) => [id(s), s]));
  const placed = new Set();
  (v.seated || []).forEach((x) => {
    const st = byId.get(String(x.adminNo));
    const seat = x.r < S.rows && x.c < S.cols ? at(x.r, x.c) : null;
    if (st && seat && !seat.blocked && !seat.student && !placed.has(id(st))) { seat.student = st; placed.add(id(st)); }
  });
  S.pool = S.list.filter((s) => !placed.has(id(s)));
  S.loadedKey = v.key;
  S.poolSel = null;
  renderAll(); fillVenueSelect();
  say("venueMsg", `Loaded “${esc(v.venue || v.key)}”.` + (missing.length ? ` ${missing.length} Admin No(s) are no longer on the roster: ${esc(missing.join(", "))}.` : ""), missing.length ? "warn" : "ok");
});

$("newVenueBtn").addEventListener("click", () => {
  if (S.list.length && !confirm("Clear the current venue and start a new one?")) return;
  S.list = []; S.seats = []; S.pool = []; S.loadedKey = null; S.poolSel = null; S.blocked = new Set();
  $("venueIn").value = ""; $("sessionIn").value = ""; $("bulkIn").value = "";
  buildSeats(); renderAll(); fillVenueSelect();
  say("venueMsg", "", ""); say("addMsg", "", "");
});

/* ---------- bulk add by Admin No ---------- */
function parseAdminNos(text) {
  const valid = [], invalid = [];
  text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean).forEach((t) => {
    if (!/^\d{1,5}$/.test(t)) return invalid.push(t);
    valid.push(t.padStart(5, "0"));
  });
  return { valid: [...new Set(valid)], invalid };
}

$("addBtn").addEventListener("click", () => {
  const { valid, invalid } = parseAdminNos($("bulkIn").value);
  if (!valid.length && !invalid.length) return say("addMsg", "Paste one or more Admin Nos first.", "warn");

  const have = new Set(S.list.map(id));
  const added = [], dupes = [], notFound = [], elsewhere = [];
  valid.forEach((a) => {
    const st = S.byAdmin.get(a);
    if (!st) return notFound.push(a);
    if (have.has(id(st))) return dupes.push(a);
    have.add(id(st));
    added.push(st);
    S.venues.forEach((v) => {
      if (v.key !== S.loadedKey && (v.students || []).map(String).includes(id(st))) elsewhere.push(`${a} is also in “${v.venue || v.key}”`);
    });
  });

  if (added.length) {
    S.list = [...S.list, ...added].sort(byName);
    S.pool = [...S.pool, ...added];
    autoFitCols();
    buildSeats();                    // keeps seated learners, fills free desks
    renderAll();
  }

  const parts = [];
  if (added.length) parts.push(`<strong>${added.length}</strong> learner(s) added.`);
  if (dupes.length) parts.push(`Already in list: ${esc(dupes.join(", "))}.`);
  if (notFound.length) parts.push(`Not found on roster: ${esc(notFound.join(", "))}.`);
  if (invalid.length) parts.push(`Not valid Admin Nos (1–5 digits): ${esc(invalid.join(", "))}.`);
  let html = parts.join("<br>");
  if (elsewhere.length) html += `<br>Check — already seated in another venue:<ul>${elsewhere.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
  say("addMsg", html, notFound.length || invalid.length || elsewhere.length ? "warn" : "ok");
  if (!notFound.length && !invalid.length) $("bulkIn").value = "";
  else $("bulkIn").value = [...notFound, ...invalid].join(", ");   // leave only the ones to fix
});

$("clearListBtn").addEventListener("click", () => {
  if (!S.list.length || !confirm("Remove all learners from this venue?")) return;
  S.list = []; S.pool = []; S.seats.forEach((s) => (s.student = null)); S.poolSel = null;
  renderAll();
});

function removeLearner(adminNo) {
  S.list = S.list.filter((s) => id(s) !== adminNo);
  S.pool = S.pool.filter((s) => id(s) !== adminNo);
  S.seats.forEach((s) => { if (s.student && id(s.student) === adminNo) s.student = null; });
  if (S.poolSel === adminNo) S.poolSel = null;
  renderAll();
}

$("candBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]");
  if (btn) removeLearner(btn.dataset.remove);
});

/* ---------- layout engine (S-snake) ---------- */
function snakeOrder(cols, rows) {
  const order = [];
  for (let c = 0; c < cols; c++) {
    if (c % 2 === 0) for (let r = 0; r < rows; r++) order.push({ r, c });
    else for (let r = rows - 1; r >= 0; r--) order.push({ r, c });
  }
  return order;
}

// Rebuilds the grid at the current input size, keeping learners where they are.
function buildSeats() {
  const keep = S.seats.filter((s) => s.student);
  S.cols = clamp($("colsIn").value);
  S.rows = clamp($("rowsIn").value);
  S.seats = [];
  for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) S.seats.push({ r, c, no: 0, blocked: S.blocked.has(key(r, c)), student: null });
  renumber();
  keep.forEach((o) => {
    const s = o.r < S.rows && o.c < S.cols ? at(o.r, o.c) : null;
    if (s && !s.blocked) s.student = o.student; else S.pool.push(o.student);
  });
  fillFree();
}

// Numbers usable desks in snake order; unusable desks get no number.
function renumber() {
  let n = 0;
  snakeOrder(S.cols, S.rows).forEach((p) => { const s = at(p.r, p.c); s.no = s.blocked ? 0 : ++n; });
}

function toggleBlocked(seat) {
  const k = key(seat.r, seat.c);
  if (seat.blocked) { seat.blocked = false; S.blocked.delete(k); }
  else {
    seat.blocked = true; S.blocked.add(k);
    if (seat.student) { S.pool.push(seat.student); seat.student = null; }   // learner is re-seated in the next free desk
  }
  S.poolSel = null;
  renumber(); fillFree(); renderAll();
}

function fillFree() {
  S.pool = [...S.pool].sort(byName);
  for (const p of snakeOrder(S.cols, S.rows)) {
    if (!S.pool.length) break;
    const s = at(p.r, p.c);
    if (!s.student && !s.blocked) s.student = S.pool.shift();
  }
}

// Usable desks in a cols × rows room (unusable desks excluded).
function freeDesks(cols, rows) {
  let n = 0;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!S.blocked.has(key(r, c))) n++;
  return n;
}
function colsFor(n, rows) {
  let c = 1;
  while (c < 30 && freeDesks(c, rows) < n) c++;
  return c;
}
function autoFitCols() {
  const rows = clamp($("rowsIn").value);
  if (freeDesks(clamp($("colsIn").value), rows) < S.list.length) $("colsIn").value = colsFor(S.list.length, rows);
}

function reseatAll() {
  S.seats.forEach((s) => (s.student = null));
  S.pool = [...S.list];
  S.poolSel = null;
  buildSeats(); renderAll();
}

$("generateBtn").addEventListener("click", () => {
  if (S.seats.some((s) => s.student) && !confirm("Re-seat everyone in surname order? Manual moves will be reset.")) return;
  reseatAll();
});
["colsIn", "rowsIn"].forEach((i) => $(i).addEventListener("change", () => { buildSeats(); renderAll(); }));
$("fitBtn").addEventListener("click", () => {
  $("colsIn").value = colsFor(S.list.length, clamp($("rowsIn").value));
  buildSeats(); renderAll();
});

/* ---------- rendering ---------- */
function seatHtml(seat, i, forExport) {
  const attr = forExport ? "" : `data-i="${i}"`;
  if (seat.blocked) return `<div ${attr} class="seat blocked"><span>NOT IN USE</span></div>`;
  const s = seat.student;
  if (!s) return `<div ${attr} class="seat empty">${forExport ? "" : "Empty seat"}</div>`;
  const src = photoSrc(s.photo);
  const photo = src
    ? `<img class="seat-photo" crossorigin="anonymous" src="${esc(src)}" data-ini="${esc(ini(s))}" alt="">`
    : `<span class="seat-photo seat-initials">${esc(ini(s))}</span>`;
  return `<div ${attr} class="seat filled" title="${forExport ? "" : "Click to remove from desk"}">
    <span class="seat-no">${seat.no}</span>${photo}
    <div class="seat-text"><div class="seat-sur">${esc(low(s.lastName).toUpperCase())}</div>
      <div class="seat-first">${esc(s.firstName)}</div><div class="seat-adm">${esc(clsOf(s))} · ${esc(id(s))}</div></div></div>`;
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

function renderTable() {
  $("candBody").innerHTML = S.list.map((s) => {
    const src = photoSrc(s.photo);
    const photo = src
      ? `<img class="cand-photo" src="${esc(src)}" data-ini="${esc(ini(s))}" loading="lazy" alt="">`
      : `<span class="cand-photo">${esc(ini(s))}</span>`;
    return `<tr><td>${photo}</td>
      <td>${esc(low(s.lastName).toUpperCase())}, ${esc(s.firstName)}</td>
      <td>Gr ${esc(s.grade)} · ${esc(clsOf(s))}</td>
      <td class="mono">${esc(id(s))}</td>
      <td><button type="button" class="cand-remove" data-remove="${esc(id(s))}" title="Remove from venue" aria-label="Remove">&times;</button></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty-hint">No learners yet — paste Admin Nos above.</td></tr>`;
  $("candCount").textContent = S.list.length ? `(${S.list.length})` : "";
}

function renderGrid() {
  const g = $("seatGrid");
  g.style.gridTemplateColumns = `repeat(${S.cols}, var(--seat-w))`;
  g.classList.toggle("block-mode", S.blockMode);
  g.innerHTML = S.seats.map((s, i) => seatHtml(s, i, false)).join("");
  prepareImages(g);
}

function renderPool() {
  $("poolBadge").textContent = S.pool.length;
  $("pool").innerHTML = S.pool.length
    ? S.pool.map((s) => `<span class="pool-chip ${id(s) === S.poolSel ? "selected" : ""}" data-id="${esc(id(s))}">${esc(low(s.lastName).toUpperCase())}, ${esc(s.firstName)}</span>`).join("")
    : `<span class="empty-hint">No unassigned learners.</span>`;
}

function status() {
  const n = S.list.length, seated = S.seats.filter((s) => s.student).length;
  const usable = S.seats.filter((s) => !s.blocked).length, off = S.seats.length - usable;
  const offTxt = off ? ` · ${off} unusable` : "";
  if (!n) return say("planMsg", `${usable} usable desks (${S.cols} × ${S.rows})${offTxt}. Add learners to seat them.`, "warn");
  if (S.pool.length) say("planMsg", `${usable} usable desks for ${n} learners — ${S.pool.length} unassigned. Add columns/rows, free up desks, or use Auto-fit.`, "warn");
  else say("planMsg", `${seated} learners seated across ${usable} usable desks (${S.cols} × ${S.rows})${offTxt}.`, "ok");
}

function syncBlockUi() {
  const btn = $("blockModeBtn");
  btn.textContent = `Mark unusable desks: ${S.blockMode ? "ON" : "Off"}`;
  btn.classList.toggle("is-on", S.blockMode);
  const off = S.seats.filter((s) => s.blocked).length;
  $("blockedCount").textContent = S.blockMode
    ? "Click a desk to mark / unmark it. Learners on a marked desk move to the next free desk."
    : off ? `${off} desk(s) marked unusable` : "";
  $("clearBlockedBtn").disabled = !S.blocked.size;
}

function renderAll() { renderTable(); renderGrid(); renderPool(); status(); syncBlockUi(); markDirtyPreview(); }

$("seatGrid").addEventListener("click", (e) => {
  const el = e.target.closest("[data-i]");
  if (!el) return;
  const seat = S.seats[+el.dataset.i];
  if (S.blockMode) return toggleBlocked(seat);
  if (seat.blocked) return;
  if (seat.student) {
    S.pool = [...S.pool, seat.student].sort(byName);
    seat.student = null;
  } else if (S.poolSel) {
    const k = S.pool.findIndex((s) => id(s) === S.poolSel);
    if (k < 0) return;
    seat.student = S.pool.splice(k, 1)[0];
    S.poolSel = null;
  } else {
    say("planMsg", "Select a name under “Unassigned”, then click an empty desk.", "warn");
    return;
  }
  renderGrid(); renderPool(); status(); markDirtyPreview();
});

$("pool").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-id]");
  if (!chip) return;
  S.poolSel = S.poolSel === chip.dataset.id ? null : chip.dataset.id;
  renderPool();
});

["venueIn", "sessionIn"].forEach((i) => $(i).addEventListener("input", markDirtyPreview));

/* ---------- save (unique venue name) ---------- */
$("saveBtn").addEventListener("click", async () => {
  if (!S.canSave) return say("exportMsg", "You do not have permission to save venues.", "err");
  const venue = $("venueIn").value.trim();
  if (!venue) return say("exportMsg", "Enter a venue name first.", "warn");
  const key = venueKey(venue);
  if (!key) return say("exportMsg", "The venue name needs at least one letter or number.", "warn");
  if (!S.list.length) return say("exportMsg", "Add at least one learner before saving.", "warn");

  const btn = $("saveBtn");
  btn.disabled = true;
  try {
    const ref = doc(db, LSU_SEATING_COLLECTION, key);
    const isNew = key !== S.loadedKey;
    if (isNew && (await getDoc(ref)).exists()) {
      say("exportMsg", `A venue called “${esc(venue)}” already exists. Choose a different name, or load it from Saved venues to edit it.`, "err");
      return;
    }
    const payload = {
      venue, session: $("sessionIn").value.trim(),
      cols: S.cols, rows: S.rows,
      blocked: [...S.blocked].filter((k) => { const [r, c] = k.split(",").map(Number); return r < S.rows && c < S.cols; }),
      students: S.list.map(id),
      seated: S.seats.filter((s) => s.student).map((s) => ({ r: s.r, c: s.c, adminNo: id(s.student) })),
      updatedBy: auth.currentUser?.email || "", updatedAt: serverTimestamp(),
    };
    if (isNew) { payload.createdBy = payload.updatedBy; payload.createdAt = serverTimestamp(); }
    await setDoc(ref, payload, { merge: true });
    S.loadedKey = key;
    await loadVenues();
    say("exportMsg", `Venue “${esc(venue)}” saved.`, "ok");
  } catch (err) {
    say("exportMsg", `Could not save: ${esc(err.message)}`, "err");
  } finally {
    btn.disabled = !S.canSave;
  }
});

/* ---------- export (one wide image) ---------- */
async function renderCanvas() {
  const placed = S.seats.filter((s) => s.student).length;
  if (!placed) throw new Error("Add learners and seat them first.");
  const venue = $("venueIn").value.trim();
  if (!venue) throw new Error("Enter a venue name first.");
  const stage = document.createElement("div");
  stage.className = "export-stage";
  const sub = [$("sessionIn").value.trim(), `${placed} learners`, new Date().toLocaleDateString()].filter(Boolean).join(" · ");
  stage.innerHTML = `<div class="ex-title">${esc(venue)}</div>
    <div class="ex-sub">${esc(sub)}</div><div class="ex-front">FRONT OF ROOM</div>
    <div class="seat-grid" style="grid-template-columns:repeat(${S.cols},var(--seat-w))">${S.seats.map((s, i) => seatHtml(s, i, true)).join("")}</div>`;
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
    a.download = `${safeName($("venueIn").value)}.png`;
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

/* ---------- unusable desks ---------- */
$("blockModeBtn").addEventListener("click", () => { S.blockMode = !S.blockMode; S.poolSel = null; renderAll(); });
$("clearBlockedBtn").addEventListener("click", () => {
  if (!S.blocked.size || !confirm("Make all unusable desks available again?")) return;
  S.blocked = new Set();
  S.seats.forEach((s) => (s.blocked = false));
  renumber(); fillFree(); renderAll();
});
