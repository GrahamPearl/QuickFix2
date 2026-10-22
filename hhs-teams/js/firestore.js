// All Firestore access lives here, using the shared connection from js/firebase-init.js.
import { db, doc, getDoc, setDoc, deleteDoc, updateDoc } from "../../js/firebase-init.js";
import { CONFIG } from "./config.js";
import { docId, setSync } from "./utils.js";

export const online = () => true;
export const init = () => setSync("idle");

const ref = (id) => doc(db, CONFIG.COLLECTION, id);
const safe = async (fn, fallback = null) => { try { return await fn(); } catch (e) { console.warn(e); return fallback; } };
const read = (id) => safe(async () => { const d = await getDoc(ref(id)); return d.exists() ? d.data() : null; });

export const getMeta = () => read(CONFIG.META_DOC);
export const setMeta = (meta) => safe(() => setDoc(ref(CONFIG.META_DOC), meta));
export const getTeam = (key) => read(docId(key));
export const deleteTeam = (key) => safe(() => deleteDoc(ref(docId(key))));
export const getTemplate = async () => (await read(CONFIG.TEMPLATE_DOC))?.templateBase64 ?? null;
export const setTemplate = (b64) =>
  safe(() => setDoc(ref(CONFIG.TEMPLATE_DOC), { templateBase64: b64, updatedAt: new Date().toISOString() }));

export async function saveTeam(key, { members, roles }) {
  await setDoc(ref(docId(key)), { members, roles, updatedAt: new Date().toISOString() }, { merge: true });
  return true;
}

/** Keeps students/{adminNo}.teams in step with team rosters. role=null removes the entry. */
export async function syncStudentTeam(adminNo, key, role) {
  const [teamName, ageGroup] = key.split("||");
  const sref = doc(db, "students", String(adminNo));
  try {
    const snap = await getDoc(sref);
    if (!snap.exists()) return; // "Unknown" admin numbers have no student doc
    const rest = (snap.data().teams || []).filter((t) => !(t.teamName === teamName && t.ageGroup === ageGroup));
    await updateDoc(sref, { teams: role ? [...rest, { teamName, ageGroup, role: role.toLowerCase() }] : rest });
  } catch (e) { console.warn("syncStudentTeam", adminNo, e); }
}