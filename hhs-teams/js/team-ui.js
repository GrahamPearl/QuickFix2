// DOM wiring shared by teams.html and admin.html.
import { $, toast, teamKey } from "./utils.js";
import { state, bus, selectTeam, addMember, removeMember, setRole, bulkAdd, flush } from "./store.js";
import { renderRoster } from "./roster-view.js";
import { fillActivities, fillAges, currentSelection } from "./filters.js";
import { exportExcel, exportJSON, importJSON } from "./exports.js";

export async function loadSelected() {
  const { activity, age } = currentSelection();
  await selectTeam(activity && age ? teamKey(activity, age) : null);
}
export function refreshFilters() { fillActivities(); return loadSelected(); }

const search = () => $("rosterSearch").value;

export function bindTeamToolbar() {
  bus.addEventListener("change", () => {
    renderRoster(search());
    $("teamHeading").textContent = state.key ? state.key.replace("||", " · ") : "";
  });

  $("activitySelect").onchange = () => { fillAges(); loadSelected(); };
  $("agegroupSelect").onchange = loadSelected;
  $("rosterSearch").oninput = () => renderRoster(search());

  const input = $("adminInput");
  const add = () => { if (addMember(input.value)) { input.value = ""; input.focus(); } };
  $("addBtn").onclick = add;
  input.onkeydown = e => e.key === "Enter" && add();
  $("removeBtn").onclick = () => {
    if (input.value.trim()) { removeMember(input.value.trim()); input.value = ""; }
    else toast("Enter an Admin No to remove.", "warn");
  };

  const bulkModal = () => bootstrap.Modal.getOrCreateInstance($("bulkAddModal"));
  $("bulkBtn").onclick = () => { if (!state.key) return toast("Select a team first.", "warn"); $("bulkInput").value = ""; bulkModal().show(); };
  $("bulkConfirm").onclick = () => { const n = bulkAdd($("bulkInput").value); bulkModal().hide(); toast(n ? `Added ${n} members.` : "Nothing new to add.", n ? "success" : "warn"); };

  $("excelBtn").onclick = exportExcel;
  $("jsonExportBtn").onclick = exportJSON;
  $("jsonImportBtn").onclick = () => $("importFileInput").click();
  $("importFileInput").onchange = e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; };
  $("saveBtn")?.addEventListener("click", flush);
  window.addEventListener("beforeunload", () => flush());

  // delegated roster events
  $("roster").addEventListener("click", e => {
    const t = e.target.closest("[data-action]"); if (!t) return;
    const adm = t.dataset.adm || t.closest("[data-adm]")?.dataset.adm;
    if (t.dataset.action === "remove") confirmRemove(adm);
    if (t.dataset.action === "zoom") { $("modalImage").src = t.src; $("imageModal").classList.add("open"); }
    if (t.dataset.action === "confirm-yes") removeMember(adm);
    if (t.dataset.action === "confirm-no") t.closest(".confirm-overlay").remove();
  });
  $("roster").addEventListener("change", e => {
    const t = e.target.closest('[data-action="role"]');
    if (t) setRole(t.dataset.adm, t.value);
  });
  $("imageModal").onclick = () => $("imageModal").classList.remove("open");
}

function confirmRemove(adm) {
  const card = document.querySelector(`.student-card[data-adm="${CSS.escape(adm)}"]`);
  if (!card || card.querySelector(".confirm-overlay")) return;
  card.insertAdjacentHTML("beforeend", `<div class="confirm-overlay"><div>Remove from team?</div>
    <div class="d-flex gap-1"><button class="btn btn-danger btn-sm" data-action="confirm-yes" data-adm="${adm}">Yes</button>
    <button class="btn btn-secondary btn-sm" data-action="confirm-no">No</button></div></div>`);
}
