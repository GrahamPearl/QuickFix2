// Activities & age-group management (metadata + team documents).
import * as fs from "./firestore.js";
import { state, persistMeta, emit } from "./store.js";
import { teamKey } from "./utils.js";

const ages = a => (state.meta.ageGroups[a] ||= []);
const sortActs = () => state.meta.activities.sort((a, b) => a.localeCompare(b));
async function dropTeam(key) { delete state.teams[key]; delete state.roles[key]; await fs.deleteTeam(key); }

export async function addActivity(name, defaultAge) {
  if (state.meta.activities.includes(name)) return false;
  state.meta.activities.push(name); sortActs();
  state.meta.ageGroups[name] = [defaultAge];
  state.teams[teamKey(name, defaultAge)] = [];
  await fs.saveTeam(teamKey(name, defaultAge), { members: [], roles: {} });
  await persistMeta(); return true;
}
export async function deleteActivity(name) {
  for (const g of [...ages(name)]) await dropTeam(teamKey(name, g));
  await fs.deleteActivity(name);
  state.meta.activities = state.meta.activities.filter(a => a !== name);
  delete state.meta.ageGroups[name];
  state.meta.hidden = (state.meta.hidden || []).filter(a => a !== name);
  await persistMeta();
}
export async function addAgeGroup(activity, age) {
  if (ages(activity).includes(age)) return false;
  ages(activity).push(age); state.teams[teamKey(activity, age)] ||= [];
  await fs.saveTeam(teamKey(activity, age), { members: [], roles: {} });
  await persistMeta(); return true;
}
export async function deleteAgeGroup(activity, age) {
  state.meta.ageGroups[activity] = ages(activity).filter(g => g !== age);
  await dropTeam(teamKey(activity, age)); await persistMeta();
}
export async function renameActivity(oldName, newName) {
  if (!newName || newName === oldName || state.meta.activities.includes(newName)) return false;
  for (const g of ages(oldName)) {
    const from = teamKey(oldName, g), to = teamKey(newName, g);
    state.teams[to] = state.teams[from] || []; state.roles[to] = state.roles[from] || {};
    await fs.saveTeam(to, { members: state.teams[to], roles: state.roles[to] }).catch(console.warn);
    await dropTeam(from);
  }
  await fs.deleteActivity(oldName);
  state.meta.activities = state.meta.activities.map(a => (a === oldName ? newName : a));
  sortActs();
  state.meta.ageGroups[newName] = state.meta.ageGroups[oldName]; delete state.meta.ageGroups[oldName];
  state.meta.hidden = (state.meta.hidden || []).map(a => (a === oldName ? newName : a));
  await persistMeta(); return true;
}
export async function toggleHidden(activity) {
  const h = new Set(state.meta.hidden || []);
  h.has(activity) ? h.delete(activity) : h.add(activity);
  state.meta.hidden = [...h]; await persistMeta(); emit();
}
