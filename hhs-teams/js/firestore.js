// All Firestore access. New structure: teams/{activity} = { id, teamName, ageGroups: { age: [{adminNo, role}] }, updatedAt }
import { db, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc } from "../../js/firebase-init.js";
import { CONFIG } from "./config.js";
import { docId, setSync, splitKey } from "./utils.js";
import { getTeamsList } from "../../js/data-service.js";

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
  const { teams, hidden } = await getTeamsList();
  const activities = teams.map((t) => t.teamName).sort((a, b) => a.localeCompare(b));
  const ageGroups = Object.fromEntries(teams.map((t) => [t.teamName, Object.keys(t.ageGroups)]));
  return { activities, ageGroups, hidden };     // hidden activities included: the admin page needs them
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

import { saveStudents } from "../../js/student-write-service.js";
import { patchCachedStudent } from "../../js/data-service.js";

export async function syncStudentTeam(adminNo, key, role) {
  const [teamName, ageGroup] = splitKey(key);
  const id = String(adminNo);
  try {
    const snap = await getDoc(doc(db, "students", id));      // fresh read so the teams array is never stale
    if (!snap.exists()) return;
    const before = { ...snap.data(), adminNo: id };
    const rest = (before.teams || []).filter((t) => !(t.teamName === teamName && t.ageGroup === ageGroup));
    const teams = role ? [...rest, { teamName, ageGroup, role }] : rest;
    const after = { ...before, teams };
    await saveStudents([{ adminNo: id, before, after, fields: { teams } }],
      { action: "teams.member", source: "hhs-teams", note: `${key} → ${role || "removed"}` });
    patchCachedStudent(after);
  } catch (e) { console.warn("syncStudentTeam", adminNo, e); }
}