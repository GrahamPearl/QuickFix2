/**
 * sports-app.js — controller for sports.html.
 * Permissions (json/usertypes.json): "viewResults" opens the page (everyone), "captureResults" adds fixtures,
 * scores live matches and finalises them, "manageResults" corrects or deletes final results.
 * UI only: Firestore Rules enforce the same.
 *
 * Reads: the Results tab is ONE cached document per season; fixtures are one small query; the Live tab is one
 * listener on a tiny collection that is detached while the tab is hidden.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { getAllStudents, getTeamsList } from "./data-service.js";
import { filterStudents, sortStudents } from "./search.js";
import { escapeHtml as esc } from "./html.js";
import { loadLibs } from "./lazy-libs.js";
import * as F from "./sports-form.js";
import * as S from "./sports-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const PAGE = 50;
const DIGEST_WARN_BYTES = 700000; // season digest document limit is 1 MiB

const st = {
  me: null, canCapture: false, canManage: false,
  roster: [], byAdmin: new Map(), teams: [], opponents: [],
  season: new Date().getFullYear(), items: [], loadedAt: 0, shown: PAGE,
  upcoming: [], live: [], unsub: null, undo: new Map(),
  open: null, players: [],
};

/* ---------- startup ---------- */
const g = await guardCurrentPage();
if (g) {
  st.me = g.user;
  st.canCapture = can(g.cfg, g.type, "captureResults");
  st.canManage = can(g.cfg, g.type, "manageResults");
  try {
    st.roster = (await getAllStudents()).filter((s) => s?.adminNo);
    st.roster.forEach((s) => st.byAdmin.set(String(s.adminNo), s));
    const { teams, hidden } = await getTeamsList();
    const hide = new Set(hidden || []);
    st.teams = teams.filter((t) => !hide.has(t.teamName)).sort((a, b) => a.teamName.localeCompare(b.teamName));
    st.opponents = await S.loadOpponents().catch(() => []);

    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    $("userBadge").textContent = g.user.email;
    $("userBadge").classList.remove("is-hidden");
    document.querySelectorAll(".cap-only").forEach((el) => el.classList.toggle("is-hidden", !st.canCapture));

    const year = new Date().getFullYear();
    $("xSeason").innerHTML = Array.from({ length: 6 }, (_, i) => year - i).map((y) => `<option value="${y}">${y}</option>`).join("");
    $("fDate").value = F.dayKey();
    fillTeamSelect();
    fillOpponents();
    startLive();
    await Promise.all([loadUpcoming(), loadResults()]);
  } catch (err) {
    console.error(err);
    $("gate").style.display = "flex";
    $("gate").innerHTML = `<p class="error-text">Could not load sports results: ${esc(err.message)}</p>`;
  }
}

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x.dataset.tab === name));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== name));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

/* ---------- live ---------- */
function startLive() {
  if (st.unsub) return;
  st.unsub = S.watchLive(
    (rows) => { st.live = rows.sort((a, b) => F.teamLabel(a).localeCompare(F.teamLabel(b))); renderLive(); },
    (err) => say("liveMsg", `Live view failed: ${err.message}`, "err"),
  );
}
// Detach while the tab is hidden: no listener, no reads.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { st.unsub?.(); st.unsub = null; } else startLive();
});

function renderLive() {
  if (!st.live.length) {
    $("liveList").innerHTML = `<p class="empty-hint">No matches are being played right now.${st.canCapture ? " Start one from the Fixtures tab." : ""}</p>`;
    return;
  }
  $("liveList").innerHTML = st.live.map((m) => {
    const side = (who, name) => `<div class="sp-side ${who === "them" ? "them" : ""}"><strong>${esc(name)}</strong>
      ${st.canCapture ? `<div class="sp-btns">${F.buttonsFor(m.teamName).map((b) =>
        `<button type="button" class="btn" data-live="${esc(m.id)}" data-side="${who}" data-pts="${b.pts}">${esc(b.label)}</button>`).join("")}</div>` : ""}</div>`;
    return `<article class="sp-live">
      <div class="sp-head"><span>${esc(F.teamLabel(m))} v ${esc(m.opponent)}</span>
        <span class="empty-hint">${m.home ? "Home" : "Away"}${m.venue ? ` · ${esc(m.venue)}` : ""}${m.period ? ` · ${esc(m.period)}` : ""}</span></div>
      <div class="sp-score">${esc(m.ourScore)} – ${esc(m.theirScore)}</div>
      <div class="sp-sides">${side("us", "Hillcrest")}${side("them", m.opponent)}</div>
      ${st.canCapture ? `<div class="sp-foot">
        <input type="text" data-period="${esc(m.id)}" value="${esc(m.period || "")}" maxlength="40" placeholder="Period / half / over (optional)" />
        <button type="button" class="btn btn-ghost" data-undo="${esc(m.id)}">Undo last</button>
        <button type="button" class="btn btn-primary" data-finish="${esc(m.id)}">Finish match</button></div>` : ""}
    </article>`;
  }).join("");
}

$("liveList").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || !st.canCapture) return;
  const id = b.dataset.live || b.dataset.undo || b.dataset.finish;
  const m = st.live.find((x) => x.id === id);
  if (!m) return;
  try {
    if (b.dataset.live) {
      const delta = Number(b.dataset.pts);
      await S.adjustLive(id, b.dataset.side, delta, st.me);
      st.undo.set(id, [...(st.undo.get(id) || []), { side: b.dataset.side, delta }].slice(-30));
    } else if (b.dataset.undo) {
      const stack = st.undo.get(id) || [];
      const last = stack[stack.length - 1];
      if (!last) return say("liveMsg", "Nothing to undo on this device.", "warn");
      const cur = last.side === "us" ? m.ourScore : m.theirScore;
      if (cur < last.delta) return say("liveMsg", "Score cannot go below zero.", "warn");
      stack.pop();
      await S.adjustLive(id, last.side, -last.delta, st.me);
    } else if (b.dataset.finish) {
      openResult({ ...m, id, season: F.seasonOf(m.dayKey), status: "live" }, "finalize");
    }
    say("liveMsg", "");
  } catch (err) { say("liveMsg", `Could not update: ${err.message}`, "err"); }
});
$("liveList").addEventListener("change", async (e) => {
  const id = e.target.dataset.period;
  if (!id || !st.canCapture) return;
  try { await S.setPeriod(id, e.target.value, st.me); } catch (err) { say("liveMsg", `Could not update: ${err.message}`, "err"); }
});

/* ---------- fixtures ---------- */
function fillTeamSelect() {
  $("fTeam").innerHTML = `<option value="">Select a team…</option>` + st.teams.map((t) => `<option value="${esc(t.teamName)}">${esc(t.teamName)}</option>`).join("");
  fillAges();
}
function fillAges() {
  const t = st.teams.find((x) => x.teamName === $("fTeam").value);
  const ages = t ? Object.keys(t.ageGroups || {}).sort() : [];
  $("fAge").innerHTML = ages.length ? `<option value="">Select an age group…</option>` + ages.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("") : `<option value="">No age groups</option>`;
}
function fillOpponents() {
  $("oppList").innerHTML = st.opponents.map((o) => `<option value="${esc(o)}"></option>`).join("");
}
$("fTeam").addEventListener("change", fillAges);

$("fSave").addEventListener("click", async () => {
  if (!st.canCapture) return;
  const team = st.teams.find((t) => t.teamName === $("fTeam").value);
  const d = {
    teamName: $("fTeam").value, ageGroup: $("fAge").value,
    opponent: F.canonicalOpponent($("fOpp").value, st.opponents),
    dayKey: $("fDate").value, home: $("fHome").value === "home", venue: $("fVenue").value,
  };
  const problems = F.validateFixture(d, team ? Object.keys(team.ageGroups || {}) : []);
  if (problems.length) return say("fMsg", problems.join(" · "), "err");
  $("fSave").disabled = true;
  try {
    const rec = await S.createFixture(F.buildFixture(d), st.me);
    st.opponents = (await S.rememberOpponent(rec.opponent).catch(() => st.opponents)) || st.opponents;
    fillOpponents();
    say("fMsg", `Fixture saved: ${F.teamLabel(rec)} v ${rec.opponent}.`, "ok");
    $("fOpp").value = ""; $("fVenue").value = "";
    if ($("fPlayed").checked) { $("fPlayed").checked = false; openResult(rec, "finalize"); }
    await loadUpcoming({ force: true });
  } catch (err) { say("fMsg", `Could not save: ${err.message}`, "err"); }
  finally { $("fSave").disabled = false; }
});

async function loadUpcoming({ force = false } = {}) {
  say("upMsg", "Loading…", "warn");
  try { st.upcoming = await S.listUpcoming({ force }); say("upMsg", ""); renderUpcoming(); }
  catch (err) { say("upMsg", `Could not load fixtures: ${err.message}`, "err"); }
}
$("upRefresh").addEventListener("click", () => loadUpcoming({ force: true }));

function renderUpcoming() {
  $("upBody").innerHTML = st.upcoming.map((r) => {
    const acts = !st.canCapture ? "" : r.status === "live"
      ? `<button type="button" class="btn btn-ghost" data-act="view">Open live</button>`
      : `<button type="button" class="btn btn-ghost" data-act="live">Go live</button>
         <button type="button" class="btn btn-ghost" data-act="result">Enter result</button>
         <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>`;
    return `<tr data-id="${esc(r.id)}"><td>${esc(r.dayKey)}</td><td>${esc(F.teamLabel(r))}</td><td>${esc(r.opponent)}</td>
      <td>${r.home ? "Home" : "Away"}${r.venue ? ` · ${esc(r.venue)}` : ""}</td>
      <td><span class="badge ${r.status === "live" ? "" : "badge-muted"}">${esc(r.status)}</span></td><td class="row-actions">${acts}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty-hint">No upcoming fixtures.</td></tr>`;
}

$("upBody").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !st.canCapture) return;
  const rec = st.upcoming.find((r) => r.id === b.closest("tr").dataset.id);
  if (!rec) return;
  try {
    if (b.dataset.act === "view") return showTab("live");
    if (b.dataset.act === "result") return openResult(rec, "finalize");
    if (b.dataset.act === "live") {
      b.disabled = true;
      await S.goLive(rec, st.me);
      rec.status = "live"; renderUpcoming(); showTab("live");
    }
    if (b.dataset.act === "cancel") {
      if (!confirm(`Cancel the fixture ${F.teamLabel(rec)} v ${rec.opponent} on ${rec.dayKey}?`)) return;
      await S.deleteMatch(rec, st.me);
      st.upcoming = st.upcoming.filter((r) => r.id !== rec.id); renderUpcoming();
    }
  } catch (err) { b.disabled = false; say("upMsg", `Could not update: ${err.message}`, "err"); }
});

/* ---------- result form (finish a match, or correct a final) ---------- */
function openResult(rec, mode) {
  st.open = { rec, mode };
  st.players = (rec.topPlayers || []).map((p) => ({ ...p }));
  $("rTitle").textContent = mode === "edit" ? "Correct result" : "Finish match";
  $("rHead").textContent = `${F.teamLabel(rec)} v ${rec.opponent} · ${rec.home ? "Home" : "Away"} · ${rec.dayKey}`;
  $("rUs").value = rec.ourScore ?? 0; $("rThem").value = rec.theirScore ?? 0;
  $("rBreak").value = rec.breakdown || ""; $("rNotes").value = rec.notes || "";
  $("pSearch").value = ""; $("pMatches").innerHTML = ""; say("rMsg", "");
  renderPlayers();
  $("resultPanel").classList.remove("is-hidden");
  $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeResult() { st.open = null; st.players = []; $("resultPanel").classList.add("is-hidden"); }
$("rCancel").addEventListener("click", closeResult);

const isMember = (s, rec) => (s.teams || []).some((t) => t.teamName === rec.teamName && (!rec.ageGroup || t.ageGroup === rec.ageGroup));
const nameOf = (s) => `${s.firstName || ""} ${s.lastName || ""}`.trim() || String(s.adminNo);

function renderPlayers() {
  const chosen = new Set(st.players.map((p) => String(p.adminNo)));
  $("pChips").innerHTML = st.players.map((p, i) => `<div class="sp-chip"><strong>${esc(p.name)}</strong>
    <span class="mono empty-hint">${esc(p.adminNo)}</span>
    <input type="text" data-plabel="${i}" value="${esc(p.label || "")}" maxlength="${F.LABEL_MAX}" placeholder="e.g. Player of the match" />
    <button type="button" class="chip-remove" data-prem="${i}" aria-label="Remove">&times;</button></div>`).join("")
    || `<span class="empty-hint">No top players chosen.</span>`;
  const rec = st.open?.rec;
  const quick = rec ? sortStudents(st.roster.filter((s) => isMember(s, rec) && !chosen.has(String(s.adminNo)))).slice(0, 40) : [];
  $("pQuick").innerHTML = quick.map((s) => `<span class="pool-chip" data-padd="${esc(s.adminNo)}">${esc(nameOf(s))}</span>`).join("")
    || `<span class="empty-hint">No team members on file. Use the search.</span>`;
}
function addPlayer(adminNo) {
  const s = st.byAdmin.get(String(adminNo));
  if (!s || st.players.some((p) => String(p.adminNo) === String(adminNo))) return;
  if (st.players.length >= F.MAX_TOP) return say("rMsg", `Choose at most ${F.MAX_TOP} top players.`, "warn");
  st.players.push({ adminNo: String(s.adminNo), name: nameOf(s), label: "" });
  say("rMsg", ""); renderPlayers();
}
$("pQuick").addEventListener("click", (e) => { const c = e.target.closest("[data-padd]"); if (c) addPlayer(c.dataset.padd); });
$("pSearch").addEventListener("input", () => {
  const term = $("pSearch").value.trim();
  if (term.length < 2) { $("pMatches").innerHTML = ""; return; }
  $("pMatches").innerHTML = sortStudents(filterStudents(st.roster, { term, field: "auto" })).slice(0, 8).map((s) =>
    `<button type="button" class="btn btn-ghost" data-padd="${esc(s.adminNo)}">${esc(s.lastName)}, ${esc(s.firstName)} · Gr ${esc(s.grade)} · <span class="mono">${esc(s.adminNo)}</span></button>`).join("");
});
$("pMatches").addEventListener("click", (e) => {
  const c = e.target.closest("[data-padd]");
  if (c) { addPlayer(c.dataset.padd); $("pSearch").value = ""; $("pMatches").innerHTML = ""; }
});
$("pChips").addEventListener("click", (e) => {
  const i = e.target.dataset.prem;
  if (i !== undefined) { st.players.splice(Number(i), 1); renderPlayers(); }
});
$("pChips").addEventListener("input", (e) => {
  const i = e.target.dataset.plabel;
  if (i !== undefined) st.players[Number(i)].label = e.target.value;
});

$("rSave").addEventListener("click", async () => {
  const o = st.open;
  if (!o) return;
  if (o.mode === "edit" && !st.canManage) return;
  if (o.mode === "finalize" && !st.canCapture) return;
  if ($("rUs").value === "" || $("rThem").value === "") return say("rMsg", "Enter both scores.", "err");
  const d = { ourScore: Number($("rUs").value), theirScore: Number($("rThem").value),
    breakdown: $("rBreak").value, notes: $("rNotes").value, topPlayers: st.players };
  const problems = F.validateResult(d);
  if (problems.length) return say("rMsg", problems.join(" · "), "err");
  $("rSave").disabled = true;
  try {
    const fields = F.resultFields(d);
    const rec = o.mode === "edit" ? await S.editFinal(o.rec.id, fields, st.me) : await S.finalizeMatch(o.rec.id, fields, st.me);
    st.upcoming = st.upcoming.filter((r) => r.id !== rec.id);
    st.undo.delete(rec.id);
    if (rec.season === st.season) {
      st.items = [...st.items.filter((x) => x.id !== rec.id), { id: rec.id, ...F.slim(rec) }];
    }
    closeResult(); renderUpcoming(); renderResults();
    say("xMeta", `Saved: ${F.teamLabel(rec)} v ${rec.opponent} ${F.scoreText(rec)}.`, "ok");
  } catch (err) {
    say("rMsg", `Could not save: ${err.message}`, "err");
    if (err.stale) { S.clearUpcoming(); loadUpcoming({ force: true }); }
  } finally { $("rSave").disabled = false; }
});

/* ---------- results ---------- */
async function loadResults({ force = false } = {}) {
  say("xMeta", "Loading…", "warn");
  try {
    const r = await S.loadSeason(st.season, { force });
    st.items = r.items; st.loadedAt = r.at; st.shown = PAGE;
    fillResultFilters();
    renderResults();
  } catch (err) { say("xMeta", `Could not load results: ${err.message}`, "err"); }
}

function fillResultFilters() {
  const team = $("xTeam").value;
  const names = [...new Set(st.items.map((r) => r.teamName))].sort();
  $("xTeam").innerHTML = `<option value="">All teams</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  $("xTeam").value = names.includes(team) ? team : "";
  fillResultAges();
}
function fillResultAges() {
  const age = $("xAge").value, team = $("xTeam").value;
  const ages = [...new Set(st.items.filter((r) => !team || r.teamName === team).map((r) => r.ageGroup).filter(Boolean))].sort();
  $("xAge").innerHTML = `<option value="">All age groups</option>` + ages.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  $("xAge").value = ages.includes(age) ? age : "";
}
const filtered = () => F.filterRows(st.items, { team: $("xTeam").value, age: $("xAge").value, opponent: $("xOpp").value, result: $("xRes").value });

function renderResults() {
  const rows = F.sortNewest(filtered());
  const when = new Date(st.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const big = JSON.stringify(st.items).length > DIGEST_WARN_BYTES;
  say("xMeta", `Season ${st.season} · loaded ${when}${big ? " · the season digest is nearly full, ask an administrator to split it" : ""}`, big ? "warn" : "");

  $("tallyBody").innerHTML = F.tallies(rows).map((t) => `<tr><td>${esc(F.teamLabel(t))}</td>
    <td class="num">${t.p}</td><td class="num">${t.w}</td><td class="num">${t.d}</td><td class="num">${t.l}</td>
    <td class="num">${t.pf}</td><td class="num">${t.pa}</td></tr>`).join("") || `<tr><td colspan="7" class="empty-hint">No results for these filters.</td></tr>`;

  const page = rows.slice(0, st.shown);
  let week = "";
  $("xBody").innerHTML = page.map((r) => {
    const wk = F.mondayKey(r.dayKey);
    const head = wk !== week ? `<tr class="sp-week"><td colspan="7">Week of ${esc(wk)}</td></tr>` : "";
    week = wk;
    const acts = st.canManage
      ? `<button type="button" class="btn btn-ghost" data-edit="${esc(r.id)}">Correct</button><button type="button" class="btn btn-ghost" data-del="${esc(r.id)}">Delete</button>` : "";
    return `${head}<tr><td>${esc(r.dayKey)}</td><td>${esc(F.teamLabel(r))}</td>
      <td>${esc(r.opponent)} <span class="empty-hint">${r.home ? "(H)" : "(A)"}</span></td>
      <td class="mono">${esc(F.scoreText(r))}</td><td><span class="sp-badge sp-${esc(r.result)}">${esc(F.OUTCOME_LABEL[r.result] || r.result)}</span></td>
      <td class="student-sub">${esc(F.playersText(r))}${r.breakdown ? `<br>${esc(r.breakdown)}` : ""}</td><td class="row-actions">${acts}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty-hint">No results yet.</td></tr>`;
  $("xCount").textContent = `(${Math.min(st.shown, rows.length)} of ${rows.length})`;
  $("xMore").classList.toggle("is-hidden", rows.length <= st.shown);
}

$("xSeason").addEventListener("change", () => { st.season = Number($("xSeason").value); loadResults(); });
$("xTeam").addEventListener("change", () => { fillResultAges(); st.shown = PAGE; renderResults(); });
["xAge", "xOpp", "xRes"].forEach((i) => $(i).addEventListener("input", () => { st.shown = PAGE; renderResults(); }));
$("xRefresh").addEventListener("click", () => loadResults({ force: true }));
$("xMore").addEventListener("click", () => { st.shown += PAGE; renderResults(); });

$("xBody").addEventListener("click", async (e) => {
  if (!st.canManage) return;
  const id = e.target.dataset.edit || e.target.dataset.del;
  const rec = st.items.find((r) => r.id === id);
  if (!rec) return;
  if (e.target.dataset.edit) return openResult({ ...rec, status: "final" }, "edit");
  if (!confirm(`Permanently delete the result ${F.teamLabel(rec)} v ${rec.opponent} (${rec.dayKey})?`)) return;
  try {
    await S.deleteMatch({ ...rec, status: "final" }, st.me);
    st.items = st.items.filter((r) => r.id !== id); renderResults();
  } catch (err) { say("xMeta", `Could not delete: ${err.message}`, "err"); }
});

$("xExport").addEventListener("click", async () => {
  const rows = F.sortNewest(filtered());
  if (!rows.length) return say("xMeta", "Nothing to export for these filters.", "warn");
  try {
    await loadLibs("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(F.exportRows(rows)), "Results");
    XLSX.writeFile(wb, `sports-results-${st.season}.xlsx`);
    say("xMeta", `${rows.length} result(s) exported.`, "ok");
  } catch (err) { say("xMeta", `Could not export: ${err.message}`, "err"); }
});