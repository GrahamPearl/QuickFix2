/**
 * awards-form.js
 * Pure draft helpers for the "recommend an award" form. No DOM, no network.
 */

export const AWARD_LEVELS = [
  { key: "merits", label: "Merit" },
  { key: "halfColours", label: "Half Colours" },
  { key: "fullColours", label: "Full Colours" },
];

export const NOTE_MAX = 300;

export const levelLabel = (key) => AWARD_LEVELS.find((l) => l.key === key)?.label ?? key;

export function buildRecommendationDraft() {
  return { adminNo: "", teamId: "", awardLevel: "", note: "" };
}

export function applySelection(draft, student) {
  return { ...draft, adminNo: student ? String(student.adminNo) : "" };
}

export function applyDraftChange(draft, field, value) {
  return { ...draft, [field]: value };
}

/** Returns a list of problems (empty = valid). Same award level twice per team is allowed. */
export function validateRecommendation(draft, student, team) {
  const problems = [];
  if (!student) problems.push("Select a student");
  if (!team) problems.push("Select a team");
  if (!AWARD_LEVELS.some((l) => l.key === draft.awardLevel)) problems.push("Select an award level");
  if ((draft.note || "").length > NOTE_MAX) problems.push(`Note must be ${NOTE_MAX} characters or fewer`);
  return problems;
}

/** Fields written to awards-recommendations (service adds status + audit stamps). */
export function buildRecommendationPayload(draft, student, team) {
  return {
    adminNo: String(student.adminNo),
    studentName: student.fullName || `${student.firstName} ${student.lastName}`.trim(),
    teamId: team.teamId,
    teamName: team.name,
    awardLevel: draft.awardLevel,
    note: (draft.note || "").trim(),
  };
}
