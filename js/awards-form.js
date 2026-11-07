/**
 * awards-form.js
 * Pure helpers for the awards page. No DOM, no network.
 */

export const AWARD_LEVELS = [
  { key: "merits", label: "Merit" },
  { key: "halfColours", label: "Half Colours" },
  { key: "fullColours", label: "Full Colours" },
];

export const NOTE_MAX = 300;

export const STATUS_LABELS = {
  pending: "Pending",
  confirmed: "Confirmed",
  rejected: "Declined",
  revoked: "Revoked",
  withdrawn: "Withdrawn",
};

export const levelLabel = (key) => AWARD_LEVELS.find((l) => l.key === key)?.label ?? key;
export const statusLabel = (s) => STATUS_LABELS[s] ?? s;

export const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
/** School year = the number, e.g. 2026. Default is the year of the issue date; the approver may change it. */
export const schoolYearOf = (iso) => {
  const y = Number(String(iso || "").slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
};

/* ---------------- recommend form ---------------- */

export function buildRecommendationDraft() {
  return { adminNo: "", teamId: "", ageGroup: "", awardLevel: "", note: "" };
}

/** Choosing another student clears the team (its options depend on the student). */
export function applySelection(draft, student) {
  return { ...draft, adminNo: student ? String(student.adminNo) : "", teamId: "", ageGroup: "" };
}

export function applyTeamChange(draft, teamId) {
  return { ...draft, teamId, ageGroup: "" };
}

export function applyDraftChange(draft, field, value) {
  return { ...draft, [field]: value };
}

/**
 * Advisory only (cached roster, up to 24 h old): is the student recorded in this team / age group?
 * No age group chosen = any age group of the team counts.
 */
export function isNonMember(student, team, ageGroup = "") {
  if (!student || !team) return false;
  return !(student.teams || []).some(
    (t) => t.teamName === team.name && (!ageGroup || t.ageGroup === ageGroup),
  );
}

/** Age groups the student already has in this team (used to pre-select the dropdown). */
export function memberAgeGroups(student, team) {
  if (!student || !team) return [];
  return (student.teams || []).filter((t) => t.teamName === team.name && t.ageGroup).map((t) => t.ageGroup);
}

/** team = { teamId, name, ageGroups: [] }. Returns a list of problems (empty = valid). */
export function validateRecommendation(draft, student, team) {
  const problems = [];
  if (!student) problems.push("Select a student");
  if (!team) problems.push("Select a team");
  if (team && team.ageGroups?.length) {
    if (!draft.ageGroup) problems.push("Select an age group");
    else if (!team.ageGroups.includes(draft.ageGroup)) problems.push("Age group is not part of this team");
  }
  if (!AWARD_LEVELS.some((l) => l.key === draft.awardLevel)) problems.push("Select an award level");
  if ((draft.note || "").length > NOTE_MAX) problems.push(`Note must be ${NOTE_MAX} characters or fewer`);
  return problems;
}

/** Fields written to awards-recommendations (the service adds status + audit stamps). */
export function buildRecommendationPayload(draft, student, team, { nonMember = false, priorCount = 0 } = {}) {
  return {
    adminNo: String(student.adminNo),
    studentName: student.fullName || `${student.firstName} ${student.lastName}`.trim(),
    grade: Number(student.grade) || null,
    class: clsOf(student),
    teamName: team.name,
    ageGroup: draft.ageGroup || "",
    awardLevel: draft.awardLevel,
    note: (draft.note || "").trim(),
    nonMember: Boolean(nonMember),
    reAward: priorCount > 0,
    priorCount: Number(priorCount) || 0,
  };
}

/* ---------------- approval ---------------- */

/** Approver input check; also used by the service so the rules and the UI agree. */
export function validateApproval({ issuedDate, schoolYear, nonMember = false, nonMemberConfirmed = false }) {
  const p = [];
  if (!isIsoDate(issuedDate)) p.push("Enter a valid issue date");
  const y = Number(schoolYear);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) p.push("School year must be a number such as 2026");
  if (nonMember && !nonMemberConfirmed) {
    p.push("Tick the confirmation: this student is not a member of the team / age group");
  }
  return p;
}