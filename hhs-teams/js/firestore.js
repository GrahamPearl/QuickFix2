// All Firestore access. New structure: teams/{activity} = { id, teamName, ageGroups: { age: [{adminNo, role}] }, updatedAt }
import { db, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc } from "../../js/firebase-init.js";
import { CONFIG } from "./config.js";
import { docId, setSync, splitKey } from "./utils.js";

export const online = () => true;
export const init = () => setSync("idle");

const ref = (id) => doc(db, CONFIG.COLLECTION, id);
const safe = async (fn, fallback = null) => { try { return await fn(); } catch (e) { console.warn(e); return fallback; } };
const isTeamDoc = (id) => !id.startsWith("_") && !id.includes("||"); // skip _metadata, _template_config, legacy docs
const toTeam = (arr = []) => ({
  members: arr.map((m) => String(m.adminNo)),
  roles: Object.fromEntries(arr.map((m) => [String(m.adminNo), m.role || "Member"])),
});
const toArr = ({ members, roles }) => members.map((adminNo) => ({ adminNo, role: roles[adminNo] || "Member" }));

/** Activities, age groups (from the team docs) and the hidden list (from _metadata). */
export const getMeta = () => safe(async () => {
  const [snap, metaSnap] = await Promise.all([getDocs(collection(db, CONFIG.COLLECTION)), getDoc(ref(CONFIG.META_DOC))]);
  const meta = { activities: [], ageGroups: {}, hidden: metaSnap.exists() ? metaSnap.data().hidden || [] : [] };
  snap.forEach((d) => {
    if (!isTeamDoc(d.id)) return;
    const x = d.data(), act = x.teamName || d.id;
    meta.activities.push(act);
    meta.ageGroups[act] = Object.keys(x.ageGroups || {});
  });
  meta.activities.sort((a, b) => a.localeCompare(b));
  return meta;
});
export const setMeta = (meta) => safe(() => setDoc(ref(CONFIG.META_DOC), { hidden: meta.hidden || [] }, { merge: true }));

export const getTeam = (key) => safe(async () => {
  const [act, age] = splitKey(key);
  const d = await getDoc(ref(docId(act)));
  const arr = d.exists() ? d.data().ageGroups?.[age] : null;
  return arr ? toTeam(arr) : null;
});

export async function saveTeam(key, team) {
  const [act, age] = splitKey(key);
  await setDoc(ref(docId(act)),
    { id: docId(act), teamName: act, ageGroups: { [age]: toArr(team) }, updatedAt: new Date().toISOString() },
    { merge: true });
  return true;
}

/** Removes one age group from its activity doc. */
export const deleteTeam = (key) => safe(async () => {
  const [act, age] = splitKey(key);
  const r = ref(docId(act)), d = await getDoc(r);
  if (!d.exists()) return;
  const { [age]: _gone, ...rest } = d.data().ageGroups || {};
  await setDoc(r, { ...d.data(), ageGroups: rest, updatedAt: new Date().toISOString() });
});
export const deleteActivity = (name) => safe(() => deleteDoc(ref(docId(name))));

export const getTemplate = async () => (await safe(async () => { const d = await getDoc(ref(CONFIG.TEMPLATE_DOC)); return d.exists() ? d.data() : null; }))?.templateBase64 ?? null;
export const setTemplate = (b64) =>
  safe(() => setDoc(ref(CONFIG.TEMPLATE_DOC), { templateBase64: b64, updatedAt: new Date().toISOString() }));

/** Keeps students/{adminNo}.teams in step with team rosters. role=null removes the entry. */
export async function syncStudentTeam(adminNo, key, role) {
  const [teamName, ageGroup] = splitKey(key);
  const sref = doc(db, "students", String(adminNo));
  try {
    const snap = await getDoc(sref);
    if (!snap.exists()) return;
    const rest = (snap.data().teams || []).filter((t) => !(t.teamName === teamName && t.ageGroup === ageGroup));
    await updateDoc(sref, { teams: role ? [...rest, { teamName, ageGroup, role: role }] : rest });
  } catch (e) { console.warn("syncStudentTeam", adminNo, e); }
}