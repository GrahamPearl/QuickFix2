/**
 * textbooks-service.js — Firestore access for the textbook register.
 *  textbook-titles/{title-slug_grade} { title, subject, grade, active, createdBy/At }
 *  textbooks/{BARCODE}  { barcode, titleId, title, subject, grade, teacher, condition, status,
 *                         currentAdminNo, issuedName, issuedGrade, issuedClass, issuedOn, issuedBy }
 *  textbook-loans/{auto} append-only history: { type: issue|return, barcode, adminNo, by, at, ... }
 * Cost: a scan = 1 read + 2 writes. Lists are single-field equality queries with a limit (no composite index).
 */
import { auth, db, collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, runTransaction, query, where, orderBy, limit, serverTimestamp } from "./firebase-init.js";
import { meter } from "./usage-meter.js";
import { titleId, today } from "./textbooks-form.js";

const T = () => collection(db, "textbook-titles");
const bookRef = (c) => doc(db, "textbooks", c);
const email = (u) => String(u?.email || "").toLowerCase();
const stamp = (u) => ({ updatedBy: email(u), updatedAt: serverTimestamp() });

export async function listTitles() {
  const snap = await getDocs(query(T(), orderBy("title"), limit(1000)));
  meter.read("textbook-titles", snap.size);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.title.localeCompare(b.title) || a.grade - b.grade);
}

export async function addTitle({ title, subject, grade }, user = auth.currentUser) {
  const id = titleId(title, grade), ref = doc(db, "textbook-titles", id);
  if ((await getDoc(ref)).exists()) throw new Error("That title and grade is already in the collection.");
  await setDoc(ref, { title: title.trim(), subject: subject.trim(), grade: Number(grade), active: true, createdBy: email(user), createdAt: serverTimestamp() });
  meter.write("textbooks", 1);
  return id;
}

export async function getBook(code) {
  const s = await getDoc(bookRef(code));
  meter.read("textbook-get", 1);
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/** Adds new barcodes under one title; existing barcodes are skipped and reported. */
export async function addBooks(codes, title, { teacher, condition }, user = auth.currentUser) {
  const exist = await Promise.all(codes.map((c) => getBook(c)));
  const fresh = codes.filter((_, i) => !exist[i]), skipped = codes.filter((_, i) => exist[i]);
  for (let i = 0; i < fresh.length; i += 400) {
    const b = writeBatch(db);
    fresh.slice(i, i + 400).forEach((c) => b.set(bookRef(c), {
      barcode: c, titleId: title.id, title: title.title, subject: title.subject, grade: title.grade,
      teacher: teacher.trim(), condition, status: "available", currentAdminNo: null, issuedClass: null,
      createdBy: email(user), createdAt: serverTimestamp(), ...stamp(user),
    }));
    await b.commit();
  }
  meter.write("textbooks", fresh.length);
  return { added: fresh.length, skipped };
}

export async function listBooks(mode, value, max = 400) {
  const field = { teacher: "teacher", title: "titleId", status: "status", learner: "currentAdminNo", class: "issuedClass" }[mode];
  const snap = await getDocs(query(collection(db, "textbooks"), where(field, "==", value), limit(max)));
  meter.read("textbook-list", snap.size);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.title.localeCompare(b.title) || a.barcode.localeCompare(b.barcode));
}

export function issueBook(code, student, user = auth.currentUser) {
  const ref = bookRef(code), adm = String(student.adminNo);
  return runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`Barcode ${code} is not in the register.`);
    const b = s.data();
    if (b.status === "issued") throw new Error(b.currentAdminNo === adm ? "Already issued to this learner." : `Already issued to ${b.issuedName} (${b.currentAdminNo}).`);
    if (b.status !== "available") throw new Error(`This book is marked ${b.status}.`);
    const name = student.fullName || `${student.firstName} ${student.lastName}`.trim();
    const cls = String(student.registrationClass || student.class || "").trim();
    const patch = { status: "issued", currentAdminNo: adm, issuedName: name, issuedGrade: Number(student.grade) || null, issuedClass: cls, issuedOn: today(), issuedBy: email(user), ...stamp(user) };
    tx.update(ref, patch);
    tx.set(doc(collection(db, "textbook-loans")), { type: "issue", barcode: code, titleId: b.titleId, bookGrade: b.grade, teacher: b.teacher, adminNo: adm, studentName: name, learnerGrade: patch.issuedGrade, class: cls, by: email(user), at: serverTimestamp() });
    meter.write("textbooks", 2);
    return { ...b, ...patch };
  }).then((r) => { meter.read("textbook-tx", 1); return r; });
}

/** outcome: good | fair | poor (returned) or lost. */
export function returnBook(code, outcome, user = auth.currentUser) {
  const ref = bookRef(code);
  return runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`Barcode ${code} is not in the register.`);
    const b = s.data();
    if (b.status !== "issued") throw new Error("This book is not currently issued.");
    const patch = { status: outcome === "lost" ? "lost" : "available", condition: outcome === "lost" ? b.condition : outcome,
      currentAdminNo: null, issuedName: null, issuedGrade: null, issuedClass: null, ...stamp(user) };
    tx.update(ref, patch);
    tx.set(doc(collection(db, "textbook-loans")), { type: "return", outcome, barcode: code, titleId: b.titleId, bookGrade: b.grade, adminNo: b.currentAdminNo, studentName: b.issuedName, by: email(user), at: serverTimestamp() });
    meter.write("textbooks", 2);
    return { ...b, ...patch, formerAdminNo: b.currentAdminNo, formerName: b.issuedName };
  });
}

/** Managers: correct status, condition or teacher. */
export const updateBook = (code, patch, user = auth.currentUser) => updateDoc(bookRef(code), { ...patch, ...stamp(user) });