/**
 * edit-form.js
 * Pure state helpers for editing a student. Holds no DOM references and
 * makes no network calls — app.js owns the draft object and calls these
 * to mutate it; render.js turns a draft into markup.
 */

const EDITABLE_FIELDS = ["firstName", "lastName", "grade", "class", "gender", "agegroup", "birthdate"];

export function subjectKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Deep-clones just the editable slice of a student doc into a draft. */
export function buildDraft(student) {
  const draft = { subjectsSummary: [...(student.subjectsSummary || [])], enrollments: {} };
  EDITABLE_FIELDS.forEach((f) => (draft[f] = student[f] ?? ""));
  Object.entries(student.enrollments || {}).forEach(([k, v]) => (draft.enrollments[k] = { ...v }));
  return draft;
}

export function applyFieldChange(draft, field, value) {
  return { ...draft, [field]: field === "grade" ? Number(value) : value };
}

export function addSubject(draft, subjectName, teacher = "", klass = "") {
  const name = subjectName.trim();
  if (!name || draft.subjectsSummary.includes(name)) return draft;
  return {
    ...draft,
    subjectsSummary: [...draft.subjectsSummary, name],
    enrollments: { ...draft.enrollments, [subjectKey(name)]: { teacher, class: klass } },
  };
}

export function removeSubject(draft, subjectName) {
  const key = subjectKey(subjectName);
  const enrollments = { ...draft.enrollments };
  delete enrollments[key];
  return {
    ...draft,
    subjectsSummary: draft.subjectsSummary.filter((s) => s !== subjectName),
    enrollments,
  };
}

function buildSearchTokens(record) {
  const first = (record.firstName || "").toLowerCase();
  const last = (record.lastName || "").toLowerCase();
  return Array.from(new Set([String(record.adminNo), first, last, `${first} ${last}`.trim()]));
}

/** Merges a draft back onto the original doc so untouched fields (flags, academic, etc.) survive. */
export function buildUpdatedRecord(original, draft) {
  const merged = {
    ...original,
    ...Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, draft[f]])),
    fullName: `${draft.firstName} ${draft.lastName}`.trim(),
    subjectsSummary: draft.subjectsSummary,
    enrollments: draft.enrollments,
  };
  merged.searchTokens = buildSearchTokens(merged);
  return merged;
}

/** Basic required-field check before allowing a save. */
export function validateDraft(draft) {
  const problems = [];
  if (!draft.firstName?.trim()) problems.push("First name is required");
  if (!draft.lastName?.trim()) problems.push("Last name is required");
  if (!draft.grade) problems.push("Grade is required");
  if (!draft.class?.trim()) problems.push("Class is required");
  return problems;
}
