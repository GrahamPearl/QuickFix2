/** behaviour-form.js — pure helpers for the behaviour page. No DOM, no network. */
export const TYPES = [
  { key: "uniform", label: "Uniform infringement" },
  { key: "merit", label: "Merit" },
  { key: "demerit", label: "Demerit" },
  { key: "incident", label: "Incident" },
];
export const SEVERITIES = [
  { key: "minor", label: "Minor" },
  { key: "moderate", label: "Moderate" },
  { key: "serious", label: "Serious (head staff and admin only)" },
];
export const CATEGORIES = {
  uniform: ["Shoes", "Blazer", "Tie", "Socks", "Hair", "Jewellery", "Other"],
  merit: ["Effort", "Helpfulness", "Leadership", "Excellence", "Other"],
  demerit: ["Late to class", "Disruption", "Homework", "Disrespect", "Other"],
  incident: ["Bullying", "Fighting", "Property damage", "Substance", "Other"],
};
export const DETENTION_STATUS = ["scheduled", "served", "absent", "excused", "cancelled"];
export const NOTE_MAX = 300;

export const label = (list, k) => list.find((x) => x.key === k)?.label ?? k;
export const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const todayIso = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const daysAgoIso = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function validateEntry(d, student) {
  const p = [];
  if (!student) p.push("Choose a learner");
  if (!TYPES.some((t) => t.key === d.type)) p.push("Choose a type");
  if (!(CATEGORIES[d.type] || []).includes(d.category)) p.push("Choose a category");
  if (!SEVERITIES.some((s) => s.key === d.severity)) p.push("Choose a severity");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.occurredOn || "")) p.push("Enter a valid date");
  if ((d.note || "").length > NOTE_MAX) p.push(`Note must be ${NOTE_MAX} characters or fewer`);
  if (d.type === "incident" && !(d.note || "").trim()) p.push("Describe the incident in the note");
  return p;
}

/** Fields written to behaviour-entries (the service adds recorder + timestamp). Name/grade/class are copied so history survives class moves. */
export function buildEntry(d, student) {
  return {
    adminNo: String(student.adminNo),
    studentName: student.fullName || `${student.firstName} ${student.lastName}`.trim(),
    grade: Number(student.grade) || null,
    class: clsOf(student),
    type: d.type, category: d.category, severity: d.severity,
    note: (d.note || "").trim(), occurredOn: d.occurredOn,
    status: "active",
  };
}

/** Frequency per learner: number of active events (no points). rows = ledger entries. */
export function frequency(rows, { type = "", category = "", min = 1 } = {}) {
  const by = new Map();
  rows.filter((r) => r.status === "active" && (!type || r.type === type) && (!category || r.category === category))
    .forEach((r) => {
      const x = by.get(r.adminNo) || { adminNo: r.adminNo, name: r.studentName, cls: r.class, total: 0, cats: {} };
      x.total++; x.cats[r.category] = (x.cats[r.category] || 0) + 1;
      by.set(r.adminNo, x);
    });
  return [...by.values()].filter((x) => x.total >= min).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}