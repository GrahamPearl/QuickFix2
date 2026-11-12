/** textbooks-form.js — pure helpers for the textbook register. No DOM, no network. */
export const GRADES = [8, 9, 10, 11, 12];
export const CONDITIONS = ["new", "good", "fair", "poor"];
export const STATUSES = ["available", "issued", "lost", "damaged", "withdrawn"];
export const OUTCOMES = [
  { key: "good", label: "Returned – good" }, { key: "fair", label: "Returned – fair" },
  { key: "poor", label: "Returned – poor condition" }, { key: "lost", label: "Lost" },
];
export const clsOf = (s) => String(s?.registrationClass || s?.class || "").trim();
export const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** Barcodes are document IDs: upper-case, no spaces or slashes. */
export const normCode = (v) => String(v ?? "").trim().toUpperCase().replace(/[\s/]+/g, "");
export const parseCodes = (t) => [...new Set(String(t).split(/[\s,;]+/).map(normCode).filter(Boolean))];
/** One title per name + grade, so the same book cannot be entered twice. */
export const titleId = (title, grade) =>
  `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}_${grade}`;
export const bookLabel = (b) => `${b.title} (Gr ${b.grade})`;
export const csvSafe = (v) => (/^[=+\-@]/.test(String(v ?? "")) ? `'${v}` : (v ?? ""));

export function validateTitle(t) {
  const p = [];
  if (!String(t.title || "").trim()) p.push("Enter the book title");
  if (!String(t.subject || "").trim()) p.push("Enter the subject");
  if (!GRADES.includes(Number(t.grade))) p.push("Choose the grade");
  if (!titleId(t.title || "", t.grade).replace(/_\d+$/, "")) p.push("The title needs letters or numbers");
  return p;
}

export function validateBooks(codes, title, teacher) {
  const p = [];
  if (!codes.length) p.push("Enter at least one barcode");
  if (codes.some((c) => c.length > 60)) p.push("A barcode is longer than 60 characters");
  if (!title) p.push("Choose the book title");
  if (!String(teacher || "").trim()) p.push("Enter the teacher");
  return p;
}

/**
 * rows: [{adm, code}]. books: Map code -> book|null. byAdmin: Map adminNo -> student.
 * status: ready | same | conflict | error.  Cross-grade loans are allowed and only noted.
 */
export function classifyImport(rows, byAdmin, books) {
  const seen = new Set();
  return rows.map((r) => {
    const s = byAdmin.get(r.adm), b = books.get(r.code), x = { ...r, student: s, book: b, status: "ready", msg: "" };
    if (!s) return { ...x, status: "error", msg: "Admin no not on the roster" };
    if (!b) return { ...x, status: "error", msg: "Barcode not in the book register" };
    if (seen.has(r.code)) return { ...x, status: "conflict", msg: "Barcode repeated in the file" };
    seen.add(r.code);
    if (b.status === "issued")
      return b.currentAdminNo === r.adm ? { ...x, status: "same", msg: "Already issued to this learner" }
        : { ...x, status: "conflict", msg: `Issued to ${b.issuedName} (${b.currentAdminNo})` };
    if (b.status !== "available") return { ...x, status: "error", msg: `Book is ${b.status}` };
    return Number(b.grade) !== Number(s.grade) ? { ...x, msg: `Cross-grade loan (book is Gr ${b.grade})` } : x;
  });
}