/**
 * dashboard.js — controller for index.html (dashboard only; no student reads).
 * Reads on load: authorized_users doc (cached 10 min by usertypes.js) + notices/current (cached 5 min).
 */
import { auth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can, getTypeDef, typeKeys } from "./usertypes.js";
import { visiblePages } from "./pages.js";
import { loadNotices, postNotice, removeNotice, visibleNotices } from "./notices-service.js";
import { getRosterSettings, requestRosterRefresh, estimateRefreshCost, DAILY_READ_QUOTA } from "./settings-service.js";
import { rebuildIndex } from "./roster-index.js";
import { escapeHtml as esc } from "./html.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
let cfg = null, me = null, seq = 0;

/* ---------- sign in ---------- */
const AUTH_ERRORS = {
  "auth/invalid-credential": "Invalid email address or password.",
  "auth/user-not-found": "Invalid email address or password.",
  "auth/wrong-password": "Invalid email address or password.",
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/too-many-requests": "Too many failed attempts. Try again later.",
};
const authMsg = (t) => { $("authError").textContent = t; };

$("rosterBtn").addEventListener("click", async () => {
  if (!me || !can(cfg, me.type, "refreshRoster")) return;
  const urgent = $("rosterUrgent").checked;
  $("rosterBtn").disabled = true;
  say("rosterMsg", "Estimating cost…", "");
  try {
    const { students, users, reads } = await estimateRefreshCost(cfg.collection);
    const pct = Math.round((reads / DAILY_READ_QUOTA) * 100);
    const detail = `${users} users × ${students} students ≈ ${reads.toLocaleString()} reads (about ${pct}% of the free daily quota of ${DAILY_READ_QUOTA.toLocaleString()}).`;

    if (urgent && pct >= 50) {
      const typed = prompt(`${detail}\n\nAn urgent refresh could use up today's quota and lock everyone out until the daily reset (about 10:00 SA time).\n\nType REFRESH to continue.`);
      if ((typed || "").trim() !== "REFRESH") return say("rosterMsg", "Cancelled.", "");
    } else {
      const msg = urgent
        ? `Urgent: every user reloads on their next search.\n\n${detail}\n\nContinue?`
        : `Ask all users to refresh? Each reloads only when their copy is older than the minimum age.\nWorst case: ${detail}\n\nContinue?`;
      if (!confirm(msg)) return say("rosterMsg", "Cancelled.", "");
    }

    await requestRosterRefresh({ user: me.user, urgent, reason: "manual" });
    say("rosterMsg", "Refresh requested.", "ok");
    await setupRoster();
  } catch (err) {
    say("rosterMsg", `Could not request refresh: ${err.message}`, "err");
  } finally {
    $("rosterBtn").disabled = false;
  }
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault(); authMsg("");
  const email = $("authEmail").value.trim(), pw = $("authPassword").value;
  if (!email || !pw) return authMsg("Please enter both email and password.");
  $("authSubmit").disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pw); $("authForm").reset(); }
  catch (err) { authMsg(AUTH_ERRORS[err.code] || `Sign-in failed: ${err.message}`); }
  finally { $("authSubmit").disabled = false; }
});
$("signOutBtn").addEventListener("click", () => signOut(auth).catch(console.error));

/* ---------- access gate: the user type must resolve before anything is shown ---------- */
onAuthStateChanged(auth, async (user) => {
  const mine = ++seq;
  me = null;
  $("signOutBtn").classList.toggle("is-hidden", !user);
  if (!user) {
    $("app").classList.add("is-hidden"); $("userBadge").classList.add("is-hidden");
    $("gate").style.display = "none"; $("loginGate").classList.remove("is-hidden");
    $("authEmail").focus();
    return;
  }
  $("loginGate").classList.add("is-hidden");
  $("gate").style.display = "flex";
  try {
    cfg = await loadUserTypes();
    const type = await resolveUserType(user, cfg);
    if (mine !== seq) return;
    if (!type) { await signOut(auth); authMsg("This account is not authorised."); return; }
    me = { user, type };
    $("userBadge").textContent = `${getTypeDef(cfg, type).label}: ${user.email}`;
    $("userBadge").classList.remove("is-hidden");
    $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
    showDenied(); renderTiles(); setupComposer(); setupRoster();
    await refreshNotices();
  } catch (err) {
    console.error(err);
    if (mine === seq) $("gate").innerHTML = `<p class="error-text">Could not verify your access: ${esc(err.message)}</p>`;
  }
});

function showDenied() {
  const p = new URLSearchParams(location.search).get("denied");
  if (!p) return;
  $("deniedMsg").textContent = `Your account does not have access to ${p}.`;
  $("deniedMsg").classList.remove("is-hidden");
  history.replaceState(null, "", location.pathname);
}

/* ---------- tiles (only pages this user type may open) ---------- */
function renderTiles() {
  const groups = new Map();
  visiblePages(cfg, me.type).forEach((p) => groups.set(p.group, [...(groups.get(p.group) || []), p]));
  $("tiles").innerHTML = groups.size
    ? [...groups].map(([g, list]) => `<div class="tile-group"><h2>${esc(g)}</h2><div class="tile-row">${
        list.map((p) => `<a class="tile" href="${esc(p.href)}"><strong>${esc(p.label)}</strong><span>${esc(p.desc)}</span></a>`).join("")
      }</div></div>`).join("")
    : `<p class="empty-hint">No pages are enabled for your account. Ask an administrator.</p>`;
}

$("quickForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("quickQ").value.trim();
  location.href = q ? `search.html?q=${encodeURIComponent(q)}` : "search.html";
});

/* ---------- notices ---------- */
const canPost = () => can(cfg, me.type, "postNotices");

async function refreshNotices(force = false) {
  $("noticeList").innerHTML = `<p class="empty-hint">Loading…</p>`;
  try {
    const { items, at } = await loadNotices({ force });
    const list = visibleNotices(items, me.type);
    $("noticeMeta").textContent = `Updated ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    $("noticeList").innerHTML = list.length
      ? list.map((n) => `<article class="notice lvl-${esc(n.level || "info")}">
          ${canPost() ? `<button type="button" class="notice-del" data-del="${esc(n.id)}">Delete</button>` : ""}
          <h3>${esc(n.title)}</h3>${n.body ? `<p>${esc(n.body)}</p>` : ""}
          <small>${esc(new Date(n.publishedAt).toLocaleDateString())} · ${esc(n.postedBy || "")}</small></article>`).join("")
      : `<p class="empty-hint">No notices right now.</p>`;
  } catch (err) {
    $("noticeList").innerHTML = `<p class="error-text">Could not load notices: ${esc(err.message)}</p>`;
  }
}
$("noticeRefresh").addEventListener("click", () => refreshNotices(true));

$("noticeList").addEventListener("click", async (e) => {
  const id = e.target.dataset.del;
  if (!id || !canPost() || !confirm("Delete this notice for everyone?")) return;
  try { await removeNotice(id); await refreshNotices(true); }
  catch (err) { alert(`Could not delete: ${err.message}`); }
});

function setupComposer() {
  $("noticeForm").classList.toggle("is-hidden", !canPost());
  $("nAudience").innerHTML = typeKeys(cfg)
    .map((k) => `<label><input type="checkbox" value="${esc(k)}" /> ${esc(cfg.types[k].label)}</label>`).join("");
}

$("noticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canPost()) return;
  const title = $("nTitle").value.trim();
  if (!title) return say("noticeMsg", "Enter a title.", "err");
  const audience = [...document.querySelectorAll("#nAudience input:checked")].map((i) => i.value);
  const notice = { title, body: $("nBody").value.trim(), level: $("nLevel").value, audience, expiresAt: $("nExpires").value || null };
  $("noticeBtn").disabled = true;
  try {
    await postNotice(notice, me.user);
    $("noticeForm").reset(); say("noticeMsg", "Notice posted.", "ok");
    await refreshNotices(true);
  } catch (err) { say("noticeMsg", `Could not post: ${err.message}`, "err"); }
  finally { $("noticeBtn").disabled = false; }
});

/* ---------- student data refresh (setting/roster) ---------- */
async function setupRoster() {
  const allowed = can(cfg, me.type, "refreshRoster");
  $("rosterPanel").classList.toggle("is-hidden", !allowed);
  if (!allowed) return;
  try {
    const s = await getRosterSettings();
    $("rosterInfo").textContent = s.forceRefreshAt
      ? `Last refresh requested ${new Date(s.forceRefreshAt).toLocaleString()}${s.updatedBy ? ` by ${s.updatedBy}` : ""}. Users reload on their next search; a normal request waits until their copy is ${s.minIntervalHours} hours old.`
      : "No refresh has been requested yet.";
    const built = s.indexBuiltAt?.toMillis ? new Date(s.indexBuiltAt.toMillis()).toLocaleString() : null;
    $("rosterInfo").textContent += s.indexChunks
      ? ` Roster index: ${s.indexCount ?? "?"} students in ${s.indexChunks} chunk(s), fully rebuilt ${built || "—"}.`
      : " No roster index built yet: every user load reads every student.";
  } catch (err) { $("rosterInfo").textContent = `Could not read settings: ${err.message}`; }
}

$("indexBtn").addEventListener("click", async () => {
  if (!me || !can(cfg, me.type, "refreshRoster")) return;
  if (!confirm("Rebuild the roster index? This reads every student once and replaces the index for all users.")) return;
  $("indexBtn").disabled = true; say("rosterMsg", "Rebuilding… (reading all students)", "warn");
  try {
    const r = await rebuildIndex({ user: me.user });
    say("rosterMsg", `Index rebuilt: ${r.students} students in ${r.chunks} chunk(s). Users reload on their next search.`, "ok");
    await setupRoster();
  } catch (err) { say("rosterMsg", `Rebuild failed: ${err.message}`, "err"); }
  finally { $("indexBtn").disabled = false; }
});
