/**
 * sports-form.js
 * Pure helpers for the sports results page. No DOM, no network.
 *
 * A match (sports-results/{id}) moves  scheduled -> live -> final.
 * Team identity matches hhs-teams: teamName (the activity) + ageGroup.
 * Scores are always "Hillcrest" (ourScore) against the opponent (theirScore).
 */

export const NOTE_MAX = 300;
export const LABEL_MAX = 40;
export const MAX_SCORE = 999;
export const MAX_TOP = 3;
export const OUTCOME_LABEL = { W: "Won", L: "Lost", D: "Drawn" };

/* ---------- dates (local time) ---------- */
const p2 = (n) => String(n).padStart(2, "0");
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const daysAgoIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
};
export const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
/** Season = calendar year of the match date. */
export const seasonOf = (key) => Number(String(key || "").slice(0, 4)) || new Date().getFullYear();
export const mondayKey = (key) => {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(d);
};

/* ---------- small helpers ---------- */
export const low = (v) => String(v ?? "").trim().toLowerCase();
export const teamKey = (teamName, ageGroup = "") => `${teamName}||${ageGroup || ""}`;
export const teamLabel = (r) => `${r.teamName}${r.ageGroup ? ` · ${r.ageGroup}` : ""}`;
export const outcome = (us, them) => (us > them ? "W" : us < them ? "L" : "D");
export const scoreText = (r) => `${r.ourScore} – ${r.theirScore}`;
const isScore = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_SCORE;
/** Stops spreadsheet formula injection in exports. */
export const safeCell = (v) => (/^[=+\-@\t\r]/.test(String(v ?? "")) ? `'${v}` : (v ?? ""));

/** Matches a typed opponent to one already known (any case), so "kearsney" cannot duplicate "Kearsney". */
export function canonicalOpponent(typed, known = []) {
  const t = String(typed || "").trim();
  return known.find((k) => low(k) === low(t)) || t;
}

/* ---------- live scoring buttons per sport ---------- */
const b = (pts, label = `+${pts}`) => ({ pts, label });
const RULES = [
  { re: /rugby/, buttons: [b(5, "Try +5"), b(2, "Conversion +2"), b(3, "Penalty / drop +3")] },
  { re: /basketball/, buttons: [b(1), b(2), b(3)] },
  { re: /cricket/, buttons: [b(1), b(2), b(4), b(6)] }, // runs; wickets/overs go in the breakdown
  { re: /netball|soccer|football|hockey|handball|water ?polo/, buttons: [b(1, "Goal +1")] },
];
export const buttonsFor = (teamName) => RULES.find((r) => r.re.test(low(teamName)))?.buttons || [b(1)];

/* ---------- fixture ---------- */
/** Returns a list of problems (empty = valid). teamAgeGroups = the chosen team's age groups. */
export function validateFixture(d, teamAgeGroups = []) {
  const p = [];
  if (!d.teamName) p.push("Choose a team");
  if (teamAgeGroups.length && !teamAgeGroups.includes(d.ageGroup)) p.push("Choose an age group");
  const opp = String(d.opponent || "").trim();
  if (!opp) p.push("Enter the opponent");
  if (opp.length > 60) p.push("Opponent must be 60 characters or fewer");
  if (!isIsoDate(d.dayKey)) p.push("Enter a valid date");
  if (typeof d.home !== "boolean") p.push("Choose home or away");
  if (String(d.venue || "").length > 60) p.push("Venue must be 60 characters or fewer");
  return p;
}

export function buildFixture(d) {
  return {
    teamName: d.teamName,
    ageGroup: d.ageGroup || "",
    opponent: String(d.opponent).trim(),
    home: d.home,
    venue: String(d.venue || "").trim(),
    dayKey: d.dayKey,
    season: seasonOf(d.dayKey),
    status: "scheduled",
    ourScore: 0,
    theirScore: 0,
  };
}

/* ---------- result ---------- */
/** d = { ourScore, theirScore, breakdown, notes, topPlayers:[{adminNo,name,label}] } */
export function validateResult(d) {
  const p = [];
  if (!isScore(d.ourScore)) p.push(`Hillcrest score must be a whole number from 0 to ${MAX_SCORE}`);
  if (!isScore(d.theirScore)) p.push(`Opponent score must be a whole number from 0 to ${MAX_SCORE}`);
  if (String(d.breakdown || "").length > NOTE_MAX) p.push(`Breakdown must be ${NOTE_MAX} characters or fewer`);
  if (String(d.notes || "").length > NOTE_MAX) p.push(`Notes must be ${NOTE_MAX} characters or fewer`);
  const tp = d.topPlayers || [];
  if (tp.length > MAX_TOP) p.push(`Choose at most ${MAX_TOP} top players`);
  if (new Set(tp.map((x) => String(x.adminNo))).size !== tp.length) p.push("A player is listed twice");
  if (tp.some((x) => String(x.label || "").length > LABEL_MAX)) p.push(`Player labels must be ${LABEL_MAX} characters or fewer`);
  return p;
}

/** Fields written when a match is finalised or a final is edited. */
export function resultFields(d) {
  return {
    ourScore: d.ourScore,
    theirScore: d.theirScore,
    result: outcome(d.ourScore, d.theirScore),
    breakdown: String(d.breakdown || "").trim(),
    notes: String(d.notes || "").trim(),
    topPlayers: (d.topPlayers || []).map((x) => ({
      adminNo: String(x.adminNo),
      name: String(x.name || ""),
      label: String(x.label || "").trim(),
    })),
  };
}

/** The compact record kept in the season digest (everything the results page shows or edits). */
export const slim = (r) => ({
  teamName: r.teamName,
  ageGroup: r.ageGroup || "",
  opponent: r.opponent,
  home: Boolean(r.home),
  venue: r.venue || "",
  dayKey: r.dayKey,
  season: r.season ?? seasonOf(r.dayKey),
  ourScore: r.ourScore,
  theirScore: r.theirScore,
  result: r.result || outcome(r.ourScore, r.theirScore),
  breakdown: r.breakdown || "",
  notes: r.notes || "",
  topPlayers: r.topPlayers || [],
});

/* ---------- reporting (all client-side from the one season digest) ---------- */
export function filterRows(rows, { team = "", age = "", opponent = "", result = "" } = {}) {
  const o = low(opponent);
  return rows.filter(
    (r) =>
      (!team || r.teamName === team) &&
      (!age || r.ageGroup === age) &&
      (!result || r.result === result) &&
      (!o || low(r.opponent).includes(o)),
  );
}

export function tallies(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const k = teamKey(r.teamName, r.ageGroup);
    const t = m.get(k) || { teamName: r.teamName, ageGroup: r.ageGroup || "", p: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0 };
    t.p++;
    t[r.result.toLowerCase()]++;
    t.pf += r.ourScore;
    t.pa += r.theirScore;
    m.set(k, t);
  });
  return [...m.values()].sort((a, b) => a.teamName.localeCompare(b.teamName) || a.ageGroup.localeCompare(b.ageGroup));
}

export const sortNewest = (rows) =>
  [...rows].sort((a, b) => b.dayKey.localeCompare(a.dayKey) || teamLabel(a).localeCompare(teamLabel(b)));

export const playersText = (r) =>
  (r.topPlayers || []).map((p) => (p.label ? `${p.name} (${p.label})` : p.name)).join(", ");

export function exportRows(rows) {
  return rows.map((r) => ({
    Date: r.dayKey,
    Team: safeCell(r.teamName),
    "Age group": safeCell(r.ageGroup),
    Opponent: safeCell(r.opponent),
    "Home/Away": r.home ? "Home" : "Away",
    Venue: safeCell(r.venue),
    "Hillcrest score": r.ourScore,
    "Opponent score": r.theirScore,
    Result: OUTCOME_LABEL[r.result] || r.result,
    "Top players": safeCell(playersText(r)),
    Breakdown: safeCell(r.breakdown),
    Notes: safeCell(r.notes),
  }));
}