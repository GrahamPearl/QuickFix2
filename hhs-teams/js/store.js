// Application state + mutations. UI listens to `bus` "change" events.

import { CONFIG } from "./config.js";
import { DEFAULT_TEAMS } from "./data/default-teams.js";
import * as fs from "./firestore.js";
import { setSync, showUnsaved, splitKey, toast } from "./utils.js";
import { getAllStudents } from "../../js/data-service.js";

export const bus = new EventTarget();
export const state = {
  students: new Map(),
  teams: { ...DEFAULT_TEAMS }, // key -> [adminNo]
  roles: {}, // key -> {adminNo: role}
  meta: { activities: [], ageGroups: {}, hidden: [] },
  key: null,
  roster: [],
  rolesCur: {},
};
export const emit = () => bus.dispatchEvent(new Event("change"));

export async function loadStudents() {
  try {
    (await getAllStudents()).forEach((s) =>
      state.students.set(String(s.adminNo).trim(), {
        ...s,
        class: s.registrationClass || s.class || "",
        gender: (s.gender || "")[0]?.toUpperCase() || "",
      }),
    );
  } catch (e) {
    console.warn("students not loaded", e);
  }
}

export function metaFromTeams() {
  const m = { activities: [], ageGroups: {}, hidden: state.meta.hidden || [] };
  Object.keys(state.teams).forEach((k) => {
    const [a, g] = splitKey(k);
    const list = (m.ageGroups[a] ||= []);
    if (!list.includes(g)) list.push(g);
  });
  m.activities = Object.keys(m.ageGroups).sort();
  state.meta = m;
}

export async function loadMeta() {
  const remote = await fs.getMeta();
  if (remote?.activities) state.meta = { hidden: [], ...remote };
  else metaFromTeams();
}
export const persistMeta = () => fs.setMeta(state.meta);

export async function selectTeam(key) {
  state.key = key;
  state.roster = [...(state.teams[key] || [])];
  state.rolesCur = { ...(state.roles[key] || {}) };
  emit();
  if (!key || !fs.online()) return;
  setSync("saving");
  const remote = await fs.getTeam(key);
  if (remote && state.key === key) {
    state.roster = [...(remote.members || [])];
    state.rolesCur = { ...(remote.roles || {}) };
    state.teams[key] = [...state.roster];
    state.roles[key] = { ...state.rolesCur };
  }
  setSync("idle");
  emit();
}

/* ── autosave ── */
let timer = null;
export function commit() {
  state.teams[state.key] = [...state.roster];
  state.roles[state.key] = { ...state.rolesCur };
  showUnsaved(true);
  emit();
  clearTimeout(timer);
  timer = setTimeout(flush, CONFIG.AUTOSAVE_MS);
}
export async function flush() {
  clearTimeout(timer);
  if (!state.key) return;
  if (!fs.online()) {
    setSync("offline");
    return;
  }
  setSync("saving");
  try {
    await fs.saveTeam(state.key, {
      members: state.roster,
      roles: state.rolesCur,
    });
    showUnsaved(false);
    setSync("saved");
    setTimeout(() => setSync("idle"), 2000);
  } catch (e) {
    console.error(e);
    setSync("error");
    toast("Cloud save failed: " + e.message, "danger");
  }
}

/* ── roster mutations ── */
export function addMember(admno) {
  admno = String(admno).trim();
  if (!state.key)
    return toast("Select an activity and age group first.", "warn");
  if (!admno) return toast("Enter an Admin No.", "warn");
  if (state.roster.includes(admno))
    return toast(`${admno} is already in this team.`, "warn");
  
  state.roster.push(admno); state.rolesCur[admno] = "Member"; commit();
  fs.syncStudentTeam(admno, state.key, "Member");
  return true;
}

export function removeMember(admno) {
  const i = state.roster.indexOf(admno);
  if (i < 0) return toast(`${admno} is not in this team.`, "warn");
  state.roster.splice(i, 1); delete state.rolesCur[admno]; commit();
  fs.syncStudentTeam(admno, state.key, null);
  toast("Removed from team.", "danger");
}

export function setRole(admno, role) {
  state.rolesCur[admno] = role;
  commit();
  fs.syncStudentTeam(admno, state.key, role);
}

export function bulkAdd(text) {
  let n = 0;
  text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .forEach((t) => {
      if (!state.roster.includes(t)) {
        state.roster.push(t);
        state.rolesCur[t] = "Member";
        n++;
        fs.syncStudentTeam(t, state.key, "Member");
      }
    });
  if (n) commit();
  return n;
}