/**
 * memory-game-form.js
 * Pure helpers for the photo memory game. No DOM, no network.
 *
 * Ranking: best score first, then the lowest total time of that best game.
 * Time per round shrinks linearly from startSeconds (round 1) to minSeconds (last round).
 */

export const ALL_GRADES = [8, 9, 10, 11, 12];

export const DEFAULTS = Object.freeze({
  rounds: 20,
  options: 4,
  startSeconds: 8,
  minSeconds: 3,
  previewSeconds: 0, // 0 = photo and options are shown together; >0 = photo alone first, then hidden
  gapSeconds: 1.2, // feedback pause between rounds
  distractors: "sameGrade", // "sameGrade" | "random"
  grades: ALL_GRADES,
});

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** Always returns a complete, in-range config (missing or bad values fall back to the defaults). */
export function normaliseConfig(c = {}) {
  const startSeconds = round1(clamp(num(c.startSeconds, DEFAULTS.startSeconds), 2, 30));
  const grades = [...new Set((Array.isArray(c.grades) ? c.grades : ALL_GRADES).map(Number))]
    .filter((g) => ALL_GRADES.includes(g))
    .sort((a, b) => a - b);
  return {
    rounds: Math.round(clamp(num(c.rounds, DEFAULTS.rounds), 5, 50)),
    options: Math.round(clamp(num(c.options, DEFAULTS.options), 2, 6)),
    startSeconds,
    minSeconds: round1(clamp(num(c.minSeconds, DEFAULTS.minSeconds), 1, startSeconds)),
    previewSeconds: round1(clamp(num(c.previewSeconds, DEFAULTS.previewSeconds), 0, 10)),
    gapSeconds: round1(clamp(num(c.gapSeconds, DEFAULTS.gapSeconds), 0.5, 5)),
    distractors: c.distractors === "random" ? "random" : "sameGrade",
    grades: grades.length ? grades : [...ALL_GRADES],
  };
}

/** Validates raw form input (before normalising) so the manager sees what is wrong. */
export function configProblems(raw) {
  const p = [];
  const r = Number(raw.rounds), o = Number(raw.options), s = Number(raw.startSeconds);
  const m = Number(raw.minSeconds), pv = Number(raw.previewSeconds), g = Number(raw.gapSeconds);
  if (!Number.isInteger(r) || r < 5 || r > 50) p.push("Rounds must be a whole number from 5 to 50");
  if (!Number.isInteger(o) || o < 2 || o > 6) p.push("Options must be a whole number from 2 to 6");
  if (!(s >= 2 && s <= 30)) p.push("Starting seconds must be from 2 to 30");
  if (!(m >= 1 && m <= s)) p.push("Minimum seconds must be at least 1 and no more than the starting seconds");
  if (!(pv >= 0 && pv <= 10)) p.push("Preview seconds must be from 0 to 10");
  if (!(g >= 0.5 && g <= 5)) p.push("Pause between rounds must be from 0.5 to 5 seconds");
  if (!(raw.grades || []).length) p.push("Choose at least one grade");
  return p;
}

/** Seconds allowed to answer in round n (1-based). */
export function choiceSeconds(cfg, n) {
  if (cfg.rounds <= 1) return cfg.startSeconds;
  const frac = clamp((n - 1) / (cfg.rounds - 1), 0, 1);
  return round1(cfg.startSeconds - frac * (cfg.startSeconds - cfg.minSeconds));
}

/** Photo-only preview shrinks in step with the answer time. 0 when previews are off. */
export function previewSecondsFor(cfg, n) {
  if (!cfg.previewSeconds) return 0;
  return round1((cfg.previewSeconds * choiceSeconds(cfg, n)) / cfg.startSeconds);
}

/* ---------- questions ---------- */
export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const nameOf = (s) => `${s.firstName || ""} ${s.lastName || ""}`.trim() || String(s.adminNo);

/** What the player sees on an option: name, grade, class. */
export function labelOf(s) {
  return [nameOf(s), s.grade ? `Gr ${s.grade}` : "", clsOf(s)].filter(Boolean).join(" · ");
}

/**
 * correct = the student in the photo; pool = students distractors may come from.
 * "sameGrade" prefers same grade and gender, then same grade, then anyone.
 * Labels are unique, so two options can never look identical. Returns null if there are too few distractors.
 */
export function buildQuestion(correct, pool, cfg, rng = Math.random) {
  const need = cfg.options - 1;
  const id = String(correct.adminNo);
  const others = pool.filter((s) => String(s.adminNo) !== id);
  const sameGrade = (s) => String(s.grade) === String(correct.grade);
  const tiers =
    cfg.distractors === "sameGrade"
      ? [others.filter((s) => sameGrade(s) && s.gender === correct.gender), others.filter(sameGrade), others]
      : [others];

  const seen = new Set([labelOf(correct)]);
  const picked = [];
  for (const tier of tiers) {
    for (const s of shuffle(tier, rng)) {
      if (picked.length >= need) break;
      const l = labelOf(s);
      if (seen.has(l)) continue;
      seen.add(l);
      picked.push(s);
    }
  }
  if (picked.length < need) return null;
  return {
    adminNo: id,
    options: shuffle([correct, ...picked], rng).map((s) => ({
      adminNo: String(s.adminNo),
      label: labelOf(s),
      correct: String(s.adminNo) === id,
    })),
  };
}

/* ---------- scoring ---------- */
/** 100 for a correct answer, up to 50 for speed, up to 50 for a streak (10 per previous correct answer in a row, max 5). */
export function points({ remainingMs, limitMs, streak }) {
  const speed = Math.round(50 * clamp(remainingMs / limitMs, 0, 1));
  return 100 + speed + Math.min(Math.max(streak, 0), 5) * 10;
}

/** results: [{ correct, ms, points }]. A timeout counts as the full time limit. */
export function summarise(results) {
  return {
    score: results.reduce((n, r) => n + r.points, 0),
    correct: results.filter((r) => r.correct).length,
    totalMs: Math.round(results.reduce((n, r) => n + r.ms, 0)),
  };
}

/* ---------- personal best per session ---------- */
/** One number that orders the leaderboard: higher score first, then lower time. Integer, safe for Firestore. */
export const sortKey = (score, timeMs) => score * 10_000_000 + (9_999_999 - Math.min(Math.round(timeMs), 9_999_999));

/**
 * prev = the user's score document for this session (or null); game = { score, correct, totalMs }.
 * Best = higher score, or the same score in less time. games and totalPlayMs always accumulate.
 */
export function mergeBest(prev, game) {
  const better =
    !prev || game.score > prev.bestScore || (game.score === prev.bestScore && game.totalMs < prev.bestTimeMs);
  return {
    bestScore: better ? game.score : prev.bestScore,
    bestTimeMs: better ? game.totalMs : prev.bestTimeMs,
    bestCorrect: better ? game.correct : prev.bestCorrect,
    games: (prev?.games || 0) + 1,
    totalPlayMs: (prev?.totalPlayMs || 0) + game.totalMs,
    improved: better,
  };
}

/* ---------- display ---------- */
export const emailName = (email) => String(email || "").split("@")[0] || "unknown";
export const formatMs = (ms) => `${(Number(ms || 0) / 1000).toFixed(1)} s`;
export const daysSince = (date, now = Date.now()) => (date ? Math.floor((now - date.getTime()) / 86400000) : null);