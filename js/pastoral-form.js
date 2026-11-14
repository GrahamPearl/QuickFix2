/** pastoral-form.js — pure helpers for the pastoral page. No DOM, no network. */
export const KINDS = [
  { key: "referral", label: "Counselling / referral" },
  { key: "medical", label: "Medical or allergy alert" },
  { key: "atrisk", label: "At-risk / support flag" },
];
export const CATEGORIES = {
  referral: ["Emotional wellbeing", "Family circumstances", "Bullying", "Substance", "Peer relationships", "Other"],
  medical: ["Allergy", "Asthma / inhaler", "Epilepsy", "Diabetes", "Mobility", "Other"],
  atrisk: ["Academic", "Attendance", "Behaviour", "Social / emotional", "Financial", "Other"],
};
export const URGENCY = ["routine", "urgent"];
export const STATUSES = ["open", "in-progress", "closed"];
export const NOTE_MAX = 300;
export const label = (list, k) => list.find((x) => x.key === k)?.label ?? k;
export const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const todayIso = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

export function validateEntry(d, student) {
  const p = [];
  if (!student) p.push("Choose a learner");
  if (!KINDS.some((k) => k.key === d.kind)) p.push("Choose a type");
  if (!(CATEGORIES[d.kind] || []).includes(d.category)) p.push("Choose a category");
  if (!URGENCY.includes(d.urgency)) p.push("Choose an urgency");
  if (!(d.note || "").trim()) p.push(d.kind === "medical" ? "Describe the practical action staff must take" : "Add a short factual note");
  if ((d.note || "").length > NOTE_MAX) p.push(`Note must be ${NOTE_MAX} characters or fewer`);
  if (d.kind === "atrisk" && !isoDate(d.reviewDate)) p.push("Set a review date");
  return p;
}

/** Name/grade/class are copied so history survives class moves. */
export function buildEntry(d, student) {
  return {
    adminNo: String(student.adminNo),
    studentName: student.fullName || `${student.firstName} ${student.lastName}`.trim(),
    grade: Number(student.grade) || null, class: clsOf(student),
    kind: d.kind, category: d.category, urgency: d.urgency,
    note: d.note.trim(), reviewDate: d.kind === "atrisk" ? d.reviewDate : "", status: "open",
  };
}