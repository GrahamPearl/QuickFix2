/**
 * memory-game.js — page controller for memory-game.html.
 * Permissions (json/usertypes.json): "playMemoryGame" to play, "manageMemoryGame" to change settings / reset.
 * UI only: Firestore Rules enforce the same.
 *
 * Fair timing
 *  - Every photo is fully loaded AND decoded before its round is shown (a student whose photo is missing
 *    or broken is skipped and never asked), and the next 3 are loaded in the background.
 *  - The clock starts only after the photo and options have been painted (two animation frames).
 *  - The answer time is the click's own timestamp, not when the code got around to running.
 *  - If the tab is hidden mid-round, the clock is paused.
 */
import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { getAllStudents } from "./data-service.js";
import { escapeHtml as esc } from "./html.js";
import {
  ALL_GRADES, normaliseConfig, configProblems, choiceSeconds, previewSecondsFor, buildQuestion,
  shuffle, nameOf, points, summarise, formatMs, daysSince,
} from "./memory-game-form.js";
import { loadGameSettings, saveConfig, resetSession, submitGame, listScores } from "./memory-game-service.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const { IMAGE_BASE_URL, PHOTO_VERSION = "" } = window.APP_CONFIG;
const ver = PHOTO_VERSION ? `?v=${encodeURIComponent(PHOTO_VERSION)}` : "";
const photoUrl = (f) => IMAGE_BASE_URL + encodeURI(f) + ver;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : r()); f(n); });
const AHEAD = 3; // photos kept ready in the background

let me, isManager = false, roster = [], settings = null, lastGame = null;
const G = { token: 0, running: false, bad: new Set() };

/* ---------- startup ---------- */
const g = await guardCurrentPage();
if (g) {
  me = g.user;
  isManager = can(g.cfg, g.type, "manageMemoryGame");
  try {
    roster = (await getAllStudents()).filter((s) => s && s.adminNo);
    settings = await loadGameSettings();
    $("gate").style.display = "none";
    $("app").classList.remove("is-hidden");
    $("userBadge").textContent = me.email;
    $("userBadge").classList.remove("is-hidden");
    $("managePanel").classList.toggle("is-hidden", !isManager);
    $("resetBtn").classList.toggle("is-hidden", !isManager);
    $("lbSeasonWrap").classList.toggle("is-hidden", !isManager);
    $("pracGrade").innerHTML = `<option value="">All grades in the game settings</option>` +
      ALL_GRADES.map((x) => `<option value="${x}">Grade ${x}</option>`).join("");
    $("gradeBox").innerHTML = ALL_GRADES.map((x) => `<label class="imp-inline"><input type="checkbox" name="cg" value="${x}"> Grade ${x}</label>`).join("");
    renderSession();
    fillConfigForm();
    await showBoard();
  } catch (err) {
    console.error(err);
    $("gate").innerHTML = `<p class="error-text">Could not load the game: ${esc(err.message)}</p>`;
  }
}

/* ---------- session + settings ---------- */
function renderSession() {
  const days = daysSince(settings.startedAt);
  const when = settings.startedAt ? settings.startedAt.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "not started yet";
  $("sessionInfo").textContent = `Session ${settings.season} · started ${when}${days === null ? "" : days === 0 ? " (today)" : ` (${days} day${days === 1 ? "" : "s"} ago)`}`;
  const old = days !== null && days >= 7;
  $("sessionWarn").textContent = old && isManager ? "This session is a week old or more. You can start a new one." : "";
  $("sessionWarn").classList.toggle("is-hidden", !(old && isManager));
  const c = settings.config;
  $("ruleInfo").textContent = `${c.rounds} rounds · ${c.options} options · ${c.startSeconds} s down to ${c.minSeconds} s · grades ${c.grades.join(", ")}`;
}

function fillConfigForm() {
  const c = settings.config;
  $("cfgRounds").value = c.rounds; $("cfgOptions").value = c.options;
  $("cfgStart").value = c.startSeconds; $("cfgMin").value = c.minSeconds;
  $("cfgPreview").value = c.previewSeconds; $("cfgGap").value = c.gapSeconds;
  $("cfgDistract").value = c.distractors;
  document.querySelectorAll('input[name="cg"]').forEach((i) => (i.checked = c.grades.includes(Number(i.value))));
}

$("cfgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isManager) return;
  const raw = {
    rounds: $("cfgRounds").value, options: $("cfgOptions").value, startSeconds: $("cfgStart").value,
    minSeconds: $("cfgMin").value, previewSeconds: $("cfgPreview").value, gapSeconds: $("cfgGap").value,
    distractors: $("cfgDistract").value, grades: [...document.querySelectorAll('input[name="cg"]:checked')].map((i) => Number(i.value)),
  };
  const problems = configProblems(raw);
  if (problems.length) return say("cfgMsg", problems.join(" · "), "err");
  try {
    settings.config = await saveConfig(raw, me);
    renderSession(); fillConfigForm();
    say("cfgMsg", "Settings saved. They apply to games started from now on. To keep scores comparable, start a new session after changing them.", "ok");
  } catch (err) { say("cfgMsg", `Could not save: ${err.message}`, "err"); }
});

$("resetBtn").addEventListener("click", async () => {
  if (!isManager) return;
  if (!confirm(`Start a new session for all staff?\n\nThe leaderboard starts empty. Session ${settings.season} scores are kept and managers can still view them.`)) return;
  $("resetBtn").disabled = true;
  try {
    const r = await resetSession(me);
    settings = await loadGameSettings();
    renderSession();
    await showBoard();
    say("startMsg", `Session ${r.to} started.`, "ok");
  } catch (err) { say("startMsg", `Could not reset: ${err.message}`, "err"); }
  finally { $("resetBtn").disabled = false; }
});

/* ---------- leaderboard ---------- */
async function showBoard() {
  const season = isManager && $("lbSeason").value ? Number($("lbSeason").value) : settings.season;
  if (isManager) {
    $("lbSeason").innerHTML = Array.from({ length: Math.min(settings.season, 30) }, (_, i) => settings.season - i)
      .map((s) => `<option value="${s}" ${s === season ? "selected" : ""}>Session ${s}${s === settings.season ? " (current)" : ""}</option>`).join("");
  }
  $("lbBody").innerHTML = `<tr><td colspan="6" class="empty-hint">Loading…</td></tr>`;
  try {
    const rows = await listScores(season);
    $("lbBody").innerHTML = rows.map((r, i) => `<tr class="${r.uid === me.uid ? "mg-me" : ""}">
      <td class="num">${i + 1}</td><td>${esc(r.name)}${r.uid === me.uid ? ' <span class="badge badge-muted">you</span>' : ""}</td>
      <td class="num">${esc(r.bestScore)}</td><td class="num">${esc(formatMs(r.bestTimeMs))}</td>
      <td class="num">${esc(r.bestCorrect)}/${esc(r.rounds)}</td><td class="num">${esc(r.games)}</td></tr>`).join("") ||
      `<tr><td colspan="6" class="empty-hint">No scores in this session yet. Be the first.</td></tr>`;
  } catch (err) { $("lbBody").innerHTML = `<tr><td colspan="6" class="error-text">${esc(err.message)}</td></tr>`; }
}
$("lbRefresh").addEventListener("click", showBoard);
$("lbSeason").addEventListener("change", showBoard);
$("modeSel").addEventListener("change", () => $("pracBox").classList.toggle("is-hidden", $("modeSel").value !== "practice"));

/* ---------- photos: only students whose photo really loads are ever asked ---------- */
function loadImage(url, ms = 8000) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const fin = (ok) => { if (done) return; done = true; clearTimeout(timer); resolve(ok ? img : null); };
    const timer = setTimeout(() => fin(false), ms);
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => fin(img.naturalWidth > 0));
    img.onerror = () => fin(false);
    img.src = url;
  });
}

/** Returns an async function that yields { student, q, url, img } for the next student with a working photo, or null when none are left. */
function makeSource(cfg, inGrades, withPhoto) {
  const remaining = shuffle(withPhoto); // random order, no repeats within a game
  return async function next() {
    while (remaining.length) {
      const s = remaining.pop();
      const q = buildQuestion(s, inGrades, cfg);
      if (!q) continue;
      const url = photoUrl(s.photo);
      const img = await loadImage(url);
      if (!img) { G.bad.add(String(s.adminNo)); continue; }
      return { student: s, q, url, img };
    }
    return null;
  };
}

/* ---------- one game ---------- */
async function startGame() {
  if (G.running) return;
  const practice = $("modeSel").value === "practice";
  say("startMsg", "Getting ready…", "warn");
  $("startBtn").disabled = true;
  try {
    if (!practice) settings = await loadGameSettings(); // latest rules and session before a ranked game
    renderSession();
    const cfg = { ...settings.config };
    const grade = practice ? $("pracGrade").value : "";
    const grades = new Set((grade ? [Number(grade)] : cfg.grades).map(String));
    const inGrades = roster.filter((s) => grades.has(String(s.grade)));
    const withPhoto = inGrades.filter((s) => s.photo && String(s.photo).trim() && !G.bad.has(String(s.adminNo)));
    if (inGrades.length < cfg.options || !withPhoto.length) {
      return say("startMsg", "Not enough learners with photos in those grades to play.", "err");
    }
    cfg.rounds = Math.min(cfg.rounds, withPhoto.length);
    await run(cfg, inGrades, withPhoto, practice);
  } catch (err) {
    console.error(err);
    say("startMsg", `Something went wrong: ${err.message}`, "err");
    showMenu();
  } finally { $("startBtn").disabled = false; }
}

function showMenu() {
  $("menuBox").classList.remove("is-hidden");
  $("gameBox").classList.add("is-hidden");
}

async function run(cfg, inGrades, withPhoto, practice) {
  const token = ++G.token;
  G.running = true;
  const next = makeSource(cfg, inGrades, withPhoto);
  const queue = [];
  let asked = 0, extra = 0;
  const fill = () => { while (queue.length < AHEAD && asked < cfg.rounds + extra) { asked++; queue.push(next()); } };
  const alive = () => token === G.token;

  $("menuBox").classList.add("is-hidden");
  $("resultBox").classList.add("is-hidden");
  $("gameBox").classList.remove("is-hidden");
  say("startMsg", "");
  const results = [];
  let streak = 0;
  hud(0, cfg.rounds, 0, 0);
  fill();

  for (let n = 1; n <= cfg.rounds; n++) {
    setStage({ loading: true });
    const item = await queue.shift();
    if (!alive()) return;
    fill();
    if (!item) break; // no more students with a working photo

    const photo = $("photo");
    photo.classList.remove("is-masked");
    photo.src = item.url;
    try { await photo.decode(); } catch { /* checked next */ }
    if (!photo.naturalWidth) { G.bad.add(String(item.student.adminNo)); extra++; fill(); n--; continue; }

    $("mgOpts").innerHTML = item.q.options.map((o, i) =>
      `<button type="button" class="mg-opt" data-id="${esc(o.adminNo)}"><span class="mg-key">${i + 1}</span><span>${esc(o.label)}</span></button>`).join("");
    hud(n, cfg.rounds, results.reduce((a, r) => a + r.points, 0), streak);

    const limitMs = choiceSeconds(cfg, n) * 1000;
    const preview = previewSecondsFor(cfg, n);
    if (preview > 0) {
      setStage({ photoOnly: true });
      await frames(2);
      await sleep(preview * 1000);
      if (!alive()) return;
      photo.classList.add("is-masked");
    }
    setStage({ playing: true });
    await frames(2); // photo and options are on screen: only now does the clock start
    if (!alive()) return;

    const ans = await awaitAnswer(limitMs, item.q.options.length, alive);
    if (!alive()) return;

    const correct = ans.id === item.q.adminNo;
    const pts = correct ? points({ remainingMs: limitMs - ans.ms, limitMs, streak }) : 0;
    streak = correct ? streak + 1 : 0;
    results.push({ correct, ms: ans.id === null ? limitMs : ans.ms, points: pts });
    hud(n, cfg.rounds, results.reduce((a, r) => a + r.points, 0), streak);

    photo.classList.remove("is-masked");
    document.querySelectorAll(".mg-opt").forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === item.q.adminNo) { b.classList.add("mg-right"); b.insertAdjacentHTML("beforeend", `<span class="mg-mark">✓ Correct</span>`); }
      else if (b.dataset.id === ans.id) { b.classList.add("mg-wrong"); b.insertAdjacentHTML("beforeend", `<span class="mg-mark">✗ Not this one</span>`); }
    });
    $("mgMsg").textContent = ans.id === null ? `Time's up. It was ${nameOf(item.student)}.` : correct ? `+${pts} points` : `It was ${nameOf(item.student)}.`;
    await sleep(cfg.gapSeconds * 1000 + (correct ? 0 : 600));
    if (!alive()) return;
  }

  G.running = false;
  if (!results.length) { say("startMsg", "No photos could be loaded. Check your connection and try again.", "err"); return showMenu(); }
  await finish({ ...summarise(results), rounds: results.length }, practice);
}

function hud(n, total, score, streak) {
  $("hudRound").textContent = `Round ${Math.max(n, 1)} of ${total}`;
  $("hudScore").textContent = `Score ${score}`;
  $("hudStreak").textContent = streak > 1 ? `Streak ${streak}` : "";
}

function setStage({ loading = false, photoOnly = false, playing = false }) {
  $("mgLoading").classList.toggle("is-hidden", !loading);
  $("photoWrap").classList.toggle("is-hidden", loading);
  $("mgOpts").classList.toggle("is-hidden", !playing);
  $("timerWrap").classList.toggle("is-hidden", !playing);
  if (loading || photoOnly) $("mgMsg").textContent = loading ? "" : "Look closely. The photo will be hidden.";
  if (playing) $("mgMsg").textContent = "";
}

/** Resolves { id, ms } (id = null on timeout). ms is measured from the moment the round was painted. */
function awaitAnswer(limitMs, count, alive) {
  return new Promise((resolve) => {
    const bar = $("timerBar"), box = $("mgOpts");
    const t0Ref = { t: performance.now() };
    let hiddenAt = 0, raf = 0, done = false;
    const stamp = (e) => (e && e.timeStamp && e.timeStamp < 1e11 ? e.timeStamp : performance.now());
    const finish = (id, ms) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      box.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      resolve({ id, ms: Math.min(Math.max(ms, 0), limitMs) });
    };
    const onClick = (e) => { const b = e.target.closest(".mg-opt"); if (b && !b.disabled) finish(b.dataset.id, stamp(e) - t0Ref.t); };
    const onKey = (e) => {
      const i = Number(e.key) - 1;
      const b = Number.isInteger(i) && i >= 0 && i < count ? box.children[i] : null;
      if (b) finish(b.dataset.id, stamp(e) - t0Ref.t);
    };
    const onVis = () => {
      if (document.hidden) hiddenAt = performance.now();
      else if (hiddenAt) { t0Ref.t += performance.now() - hiddenAt; hiddenAt = 0; } // pause while away
    };
    const tick = () => {
      if (done || !alive()) return;
      const left = limitMs - (performance.now() - t0Ref.t);
      bar.style.width = `${Math.max(0, (left / limitMs) * 100)}%`;
      bar.classList.toggle("is-low", left / limitMs < 0.25);
      if (left <= 0) return finish(null, limitMs);
      raf = requestAnimationFrame(tick);
    };
    box.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    bar.style.width = "100%"; bar.classList.remove("is-low");
    t0Ref.t = performance.now(); // photo and options are already painted
    raf = requestAnimationFrame(tick);
  });
}

/* ---------- result + save ---------- */
async function finish(game, practice) {
  lastGame = { game, practice };
  $("gameBox").classList.add("is-hidden");
  $("resultBox").classList.remove("is-hidden");
  $("resScore").textContent = String(game.score);
  $("resDetail").textContent = `${game.correct} of ${game.rounds} correct · total time ${formatMs(game.totalMs)}`;
  $("retryBtn").classList.add("is-hidden");
  if (practice) { say("resMsg", "Practice game: not saved to the leaderboard.", ""); return; }
  await save();
}

async function save() {
  say("resMsg", "Saving your score…", "warn");
  $("retryBtn").classList.add("is-hidden");
  try {
    const r = await submitGame(lastGame.game, me);
    say("resMsg", r.improved
      ? `New personal best for session ${r.season}.`
      : `Saved. Your best this session is still ${r.best.bestScore} points in ${formatMs(r.best.bestTimeMs)}.`, "ok");
    await showBoard();
  } catch (err) {
    say("resMsg", `Your score was not saved: ${err.message}`, "err");
    $("retryBtn").classList.remove("is-hidden");
  }
}

$("startBtn").addEventListener("click", startGame);
$("again").addEventListener("click", () => { $("resultBox").classList.add("is-hidden"); showMenu(); startGame(); });
$("menuBtn").addEventListener("click", () => { $("resultBox").classList.add("is-hidden"); showMenu(); });
$("retryBtn").addEventListener("click", save);
$("quitBtn").addEventListener("click", () => {
  if (!confirm("Quit this game? Your score will not be saved.")) return;
  G.token++; G.running = false;
  showMenu();
});