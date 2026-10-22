// Excel / JSON import-export for the current team.
import { state, commit, persistMeta, selectTeam, metaFromTeams } from "./store.js";
import { download, splitKey, toast } from "./utils.js";
import { setSelection } from "./filters.js";
import { CONFIG } from "./config.js";

const safeName = s => s.replace(/[^a-z0-9_-]/gi, "_");

export function exportExcel() {
  if (!state.key || !state.roster.length) return toast("Select a team with members first.", "warn");
  const [activity, age] = splitKey(state.key);
  const rows = state.roster.map((adm, i) => {
    const s = state.students.get(adm);
    return { "#": i + 1, "Admin No": adm, "First Name": s?.firstName ?? "Unknown", "Surname": s?.lastName ?? "Unlisted",
      "Gender": s?.gender ?? "", "Class": s?.class ?? "", "Role": state.rolesCur[adm] || "Member", "Activity": activity, "Age Group": age };
  });
  const ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
  ws["!cols"] = [5, 10, 16, 16, 8, 8, 14, 18, 16].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "Roster");
  XLSX.writeFile(wb, `${safeName(`${activity}_${age}`)}_Roster.xlsx`);
  toast(`Exported ${rows.length} students.`);
}

export function exportJSON() {
  if (!state.key) return toast("No team selected.", "warn");
  const blob = new Blob([JSON.stringify({ teamKey: state.key, members: state.roster, roles: state.rolesCur, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
  download(blob, safeName(state.key) + ".json");
}

export async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.teamKey || !Array.isArray(data.members)) throw new Error("Invalid file");
    const [activity, age] = splitKey(data.teamKey);
    state.teams[data.teamKey] = [...data.members]; state.roles[data.teamKey] = data.roles || {};
    const { activities, ageGroups } = state.meta;
    if (!activities.includes(activity)) { activities.push(activity); activities.sort(); }
    const list = (ageGroups[activity] ||= []);
    if (!list.includes(age)) list.push(age);
    await persistMeta();
    setSelection(activity, age);
    await selectTeam(data.teamKey);
    commit();                       // push imported data to Firestore
    toast(`Imported ${data.members.length} members into ${activity} · ${age}.`);
  } catch (e) { toast("Import failed: " + e.message, "danger"); }
}
