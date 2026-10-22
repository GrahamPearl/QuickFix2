// admin.html – everything in teams.html plus structure CRUD and reports.
import { $, toast } from "./utils.js";
import { CONFIG } from "./config.js";
import { boot } from "./boot.js";
import { bindTeamToolbar, refreshFilters } from "./team-ui.js";
import { currentSelection, setSelection } from "./filters.js";
import { addActivity, deleteActivity, addAgeGroup, deleteAgeGroup } from "./structure.js";
import * as reports from "./reports.js";

const after = async (act, age) => { act ? setSelection(act, age || $("agegroupSelect").value) : null; await refreshFilters(); };

function bindStructure() {
  $("addActivityBtn").onclick = async () => {
    const name = prompt("New activity name:")?.trim(); if (!name) return;
    if (await addActivity(name, CONFIG.DEFAULT_AGE_GROUP)) { await after(name); toast(`Added ${name}`); } else toast("Activity already exists.", "warn");
  };
  $("delActivityBtn").onclick = async () => {
    const { activity } = currentSelection(); if (!activity) return;
    if (!confirm(`Delete "${activity}" and all of its team lists?`)) return;
    await deleteActivity(activity); await refreshFilters(); toast(`Deleted ${activity}`, "danger");
  };
  $("addAgeBtn").onclick = async () => {
    const { activity } = currentSelection(); if (!activity) return toast("Select an activity first.", "warn");
    const age = prompt(`New age group for ${activity}:`)?.trim(); if (!age) return;
    if (await addAgeGroup(activity, age)) { await after(activity, age); toast(`Added ${age}`); } else toast("Age group already exists.", "warn");
  };
  $("delAgeBtn").onclick = async () => {
    const { activity, age } = currentSelection(); if (!activity || !age) return;
    if (!confirm(`Delete age group "${age}" from ${activity}?`)) return;
    await deleteAgeGroup(activity, age); await refreshFilters(); toast(`Deleted ${age}`, "danger");
  };
}

function bindReports() {
  const fmt = () => $("reportFormat").value;
  $("activityReportBtn").onclick = reports.exportActivitiesExcel;
  $("templateBtn").onclick = () => $("templateFileInput").click();
  $("templateFileInput").onchange = async e => { if (e.target.files[0]) await reports.uploadTemplate(e.target.files[0]); e.target.value = ""; };
  $("printOneBtn").onclick = () => reports.printStudent($("adminInput").value.trim(), fmt());
  $("printAllBtn").onclick = () => reports.printAll($("gradeFilter").value, fmt());
}

bindTeamToolbar();
bindStructure();
bindReports();
boot().then(reports.loadTemplate);
