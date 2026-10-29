/**
 * hallpass-app.js — page controller for hallpass.html.
 * Permissions come from usertypes.json: "hallPass" (log passes) and
 * "hallPassReview" (history tables + force return). Rules must enforce the same.
 */
import { auth, db, doc, getDoc, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import { escapeHtml as esc } from "./html.js";
import * as hp from "./hallpass-service.js";
import { renderWeekly, renderTrend, renderLearnerLog } from "./hallpass-report.js";

const $ = (id) => document.getElementById(id);
const say = (id, text, cls = "") => { $(id).className = `plan-msg ${cls}`; $(id).textContent = text; };

let me = "";
let canReview = false;
const studentCache = new Map(); // adminNo -> student doc (1 read per learner, not the whole roster)
let seq = 0;
let rows = []; // docs from active-hall-passes
let monday = hp.mondayOf();
let unsub = null;
let sweeping = false;

/* ---------- sign in / access gate ---------- */
const AUTH_ERRORS = {
  "auth/invalid-credential": "Invalid email address or password.",
  "auth/user-not-found": "Invalid email address or password.",
  "auth/wrong-password": "Invalid email address or password.",
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/too-many-requests": "Too many failed attempts. Try again later.",
};
const authMsg = (t) => { $("authError").textContent = t; };
const showLogin = (on) => $("loginGate").classList.toggle("is-hidden", !on);
function setBusy(b) {
  const btn = $("authSubmit");
  btn.disabled = b;
  btn.classList.toggle("is-busy", b);
  btn.textContent = b ? "Signing in…" : "Sign in";
}
function gateMsg(html) { $("app").classList.add("is-hidden"); $("gate").style.display = "flex"; $("gate").innerHTML = html; }
const deny = (msg) => gateMsg(`<p class="error-text">${esc(msg)} Use Sign out (top right) to switch account.</p>`);

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg("");
  const email = $("authEmail").value.trim(), pw = $("authPassword").value;
  if (!email || !pw) return authMsg("Please enter both email and password.");
  setBusy(true);
  try { await signInWithEmailAndPassword(auth, email, pw); $("authForm").reset(); }
  catch (err) { authMsg(AUTH_ERRORS[err.code] || `Sign-in failed: ${err.message}`); }
  finally { setBusy(false); }
});
$("signOutBtn").addEventListener("click", () => signOut(auth).catch((e) => console.error("sign-out", e)));

onAuthStateChanged(auth, async (user) => {
  const mine = ++seq;
  unsub?.(); unsub = null;
  rows = []; data = null; studentCache.clear();
  $("signOutBtn").classList.toggle("is-hidden", !user);

  if (!user) { // signed out: wipe cached history, show the sign-in form
    try { Object.keys(sessionStorage).filter((k) => k.startsWith("hhs_hp_")).forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ }
    $("app").classList.add("is-hidden");
    $("userBadge").classList.add("is-hidden");
    $("gate").style.display = "none";
    showLogin(true);
    $("authEmail").focus();
    return;
  }

  showLogin(false);
  gateMsg(`<span class="spinner" aria-hidden="true"></span><span>Checking your access…</span>`);
  try {
    const cfg = await loadUserTypes();
    const type = await resolveUserType(user, cfg);
    if (mine !== seq) return;
    if (!type) { await signOut(auth); authMsg("This account is not authorised."); return; }
    if (!can(cfg, type, "hallPass")) { deny("Hall passes are not enabled for your account."); return; }
    me = user.email.toLowerCase();
    canReview = can(cfg, type, "hallPassReview");
    $("userBadge").textContent = user.email;
    $("userBadge").classList.remove("is-hidden");
    $("reviewPanel").classList.toggle("is-hidden", !canReview);
    $("reason").innerHTML = hp.REASONS.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join("");
    $("vDate").value = hp.dayKey(monday);
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    unsub = hp.watchActive(onRows, (err) => say("formMsg", `Live view failed: ${err.message}`, "err"));
    $("adminNo").focus();
  } catch (err) { console.error(err); if (mine === seq) deny(`Could not load: ${err.message}.`); }
});

/* one single-document read per learner, remembered for the session */
async function findStudent(adminNo) {
  if (studentCache.has(adminNo)) return studentCache.get(adminNo);
  const snap = await getDoc(doc(db, "students", adminNo));
  if (!snap.exists()) return null; // not cached, so a newly added learner is found next time
  const s = { adminNo, ...snap.data() };
  studentCache.set(adminNo, s);
  return s;
}

/* ---------- live data ---------- */
function onRows(next) {
  rows = next;
  render();
  if (sweeping) return;
  const mineOrAll = canReview ? rows : rows.filter((r) => r.email === me);
  sweeping = true;
  hp.sweepStale(mineOrAll).catch((e) => console.warn("sweep", e.code || e.message)).finally(() => { sweeping = false; });
}

const flat = () => rows
  .flatMap((r) => (r.activeStudents || []).map((e) => ({ ...e, teacher: r.email })))
  .sort((a, b) => a.leaveTime.toMillis() - b.leaveTime.toMillis());

function render() {
  const now = Date.now();
  const all = flat();
  const mine = all.filter((e) => e.teacher === me);

  $("slotInfo").textContent = `(${mine.length} of ${hp.MAX_OUT} out)`;
  $("outBtn").disabled = mine.length >= hp.MAX_OUT;
  $("allCount").textContent = all.length ? `(${all.length})` : "";

  const line = (e, withTeacher) => {
    const m = hp.minutesOut(e.leaveTime, now);
    const over = m >= hp.OVERDUE_MIN;
    const stale = hp.dayKey(e.leaveTime.toDate()) < hp.dayKey();
    const canReturn = e.teacher === me || canReview;
    return `<tr class="${over ? "hp-overdue" : ""}">
      <td class="hp-who">${hp.avatar(e.studentName, e.photo)}<span>${esc(e.studentName)} <span class="empty-hint mono">${esc(e.adminNo)}</span></span></td><td>${esc(e.class)}</td>
      ${withTeacher ? `<td>${esc(e.teacher)}</td>` : ""}
      <td>${esc(hp.reasonLabel(e.reason))}${e.note ? ` <span class="empty-hint">· ${esc(e.note)}</span>` : ""}</td>
      <td>${esc(e.leaveTime.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</td>
      <td class="hp-mins">${stale ? "Yesterday" : `${over ? "⚠️ " : ""}${m}m`}</td>
      <td>${canReturn ? `<button type="button" class="btn" data-adm="${esc(e.adminNo)}" data-teacher="${esc(e.teacher)}">${e.teacher === me ? "Returned" : "Force return"}</button>` : ""}</td></tr>`;
  };
  const tbl = (list, withTeacher) => list.length
    ? `<div class="hp-scroll"><table><thead><tr><th>Learner</th><th>Class</th>${withTeacher ? "<th>Venue / teacher</th>" : ""}<th>Reason</th><th>Left</th><th>Out</th><th></th></tr></thead><tbody>${list.map((e) => line(e, withTeacher)).join("")}</tbody></table></div>`
    : `<p class="empty-hint">Nobody is out.</p>`;
  $("mine").innerHTML = tbl(mine, false);
  $("all").innerHTML = tbl(all, true);
}
setInterval(() => { if (rows.length) render(); }, 60000); // refresh minute counters; no reads

/* ---------- sign out ---------- */
$("adminNo").addEventListener("input", async () => {
  const v = $("adminNo").value.trim();
  $("preview").innerHTML = "";
  if (!/^\d{5}$/.test(v)) return;
  try {
    const s = await findStudent(v);
    if ($("adminNo").value.trim() === v) {
      $("preview").innerHTML = s
        ? `<div class="hp-preview">${hp.avatar(`${s.firstName} ${s.lastName}`, s.photo, true)}<div><strong>${esc(s.firstName)} ${esc(s.lastName)}</strong><br>Grade ${esc(s.grade)} · ${esc(s.registrationClass || s.class || "")}<br><span class="mono">${esc(v)}</span></div></div>`
        : "No learner with that number.";
    }
  } catch (err) { console.warn("lookup", err.code || err.message); }
});

$("outForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("formMsg", "");
  try {
    const adminNo = hp.normaliseAdminNo($("adminNo").value);
    $("outBtn").disabled = true;
    const student = await findStudent(adminNo);
    if (!student) throw new Error(`No learner found with admin number ${adminNo}.`);
    const elsewhere = flat().find((x) => x.adminNo === adminNo);
    if (elsewhere) throw new Error(`${student.firstName} is already out (${elsewhere.teacher}).`);
    await hp.signOutStudent({ teacherEmail: me, student, reason: $("reason").value, note: $("note").value });
    say("formMsg", `${student.firstName} ${student.lastName} signed out.`, "ok");
    $("outForm").reset(); $("preview").innerHTML = ""; $("adminNo").focus();
  } catch (err) {
    say("formMsg", err.message.startsWith("Venue Limit") ? err.message : err.message || "Network/Permission Error: Unable to complete operation.", "err");
  } finally { render(); }
});

/* ---------- return / force return ---------- */
$("app").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-adm]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await hp.returnStudent({ teacherEmail: btn.dataset.teacher, adminNo: btn.dataset.adm, returnedBy: me, forced: btn.dataset.teacher !== me });
  } catch (err) {
    btn.disabled = false;
    say("formMsg", err.message || "Network/Permission Error: Unable to complete operation.", "err");
  }
});

/* ---------- history review ---------- */
let data = null; // last loaded history: { view, weeks:[rows per week], mondays:[Date] }
const teacherFilter = () => $("vTeacher").value;
const byTeacher = (rows) => (teacherFilter() ? rows.filter((r) => r.teacher === teacherFilter()) : rows);

function fillTeachers() {
  const cur = teacherFilter();
  const all = [...new Set(data.weeks.flat().map((r) => r.teacher).filter(Boolean))].sort();
  $("vTeacher").innerHTML = `<option value="">All teachers</option>` + all.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  $("vTeacher").value = all.includes(cur) ? cur : "";
}

function draw() { // client-side only: changing the teacher filter costs no reads
  if (!data) return;
  const weeks = data.weeks.map(byTeacher);
  $("reviewOut").innerHTML = (data.view === "week" ? renderWeekly(weeks[0], data.mondays[0]) : renderTrend(weeks, data.mondays))
    + `<p class="empty-hint">Click a learner to see each pass, who signed them out and who returned them.</p>`;
}

async function loadReview() {
  say("vMsg", "Loading…", "warn");
  const grade = $("vGrade").value, view = $("vView").value;
  try {
    const mondays = view === "week" ? [monday] : [3, 2, 1, 0].map((i) => hp.addDays(monday, -7 * i));
    const weeks = await Promise.all(mondays.map((m) => hp.fetchWeek(m, grade)));
    data = { view, weeks, mondays };
    fillTeachers();
    draw();
    say("vMsg", "");
  } catch (err) {
    console.error(err);
    say("vMsg", `Could not load history: ${err.message}`, "err");
  }
}
$("vTeacher").addEventListener("change", draw);

/* open a learner's passes */
$("reviewOut").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-adm]");
  if (!tr || !data) return;
  const rows = byTeacher(data.weeks.flat()).filter((r) => r.adminNo === tr.dataset.adm);
  if (!rows.length) return;
  const f = rows[0];
  $("logHead").innerHTML = `${hp.avatar(f.name, f.photo, true)}<div><h2 class="modal-title">${esc(f.name)}</h2>
    <p class="modal-subtitle">${esc(f.cls)} · <span class="mono">${esc(f.adminNo)}</span> · ${rows.length} pass${rows.length === 1 ? "" : "es"}${teacherFilter() ? ` · ${esc(teacherFilter())} only` : ""}</p></div>`;
  $("logBody").innerHTML = renderLearnerLog(rows);
  $("logModal").classList.remove("is-hidden");
});
const closeLog = () => $("logModal").classList.add("is-hidden");
$("logClose").addEventListener("click", closeLog);
$("logScrim").addEventListener("click", closeLog);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLog(); });

const setWeek = (d) => { monday = hp.mondayOf(d); $("vDate").value = hp.dayKey(monday); };
$("vLoad").addEventListener("click", () => { if ($("vDate").value) setWeek(hp.dateOfKey($("vDate").value)); loadReview(); });
$("vPrev").addEventListener("click", () => { setWeek(hp.addDays(monday, -7)); loadReview(); });
$("vNext").addEventListener("click", () => { setWeek(hp.addDays(monday, 7)); loadReview(); });
