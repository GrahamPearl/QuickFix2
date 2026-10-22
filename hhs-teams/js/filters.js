import { $, esc } from "./utils.js";
import { state } from "./store.js";

const isAdmin = () => document.body.dataset.page === "admin";
const options = list => list.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");

export function fillActivities() {
  const sel = $("activitySelect"), prev = sel.value;
  const hidden = new Set(state.meta.hidden || []);
  const list = state.meta.activities.filter(a => isAdmin() || !hidden.has(a));
  sel.innerHTML = options(list);
  if (list.includes(prev)) sel.value = prev;
  fillAges();
}
export function fillAges() {
  const act = $("activitySelect").value, sel = $("agegroupSelect"), prev = sel.value;
  const list = [...(state.meta.ageGroups[act] || [])].sort();
  sel.innerHTML = options(list);
  if (list.includes(prev)) sel.value = prev;
}
export const currentSelection = () => ({ activity: $("activitySelect").value, age: $("agegroupSelect").value });
export function setSelection(activity, age) {
  fillActivities(); $("activitySelect").value = activity; fillAges(); $("agegroupSelect").value = age;
}
