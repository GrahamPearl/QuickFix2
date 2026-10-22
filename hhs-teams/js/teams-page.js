// teams.html – viewer/editor + rename/hide of activities.
import { $, esc, toast } from "./utils.js";
import { state } from "./store.js";
import { boot } from "./boot.js";
import { bindTeamToolbar, refreshFilters } from "./team-ui.js";
import { renameActivity, toggleHidden } from "./structure.js";

function renderManage() {
  const hidden = new Set(state.meta.hidden || []);
  $("manageTableBody").innerHTML = state.meta.activities.map(a => {
    const h = hidden.has(a);
    return `<tr class="${h ? "row-hidden" : ""}"><td><strong>${esc(a)}</strong> ${h ? '<span class="badge bg-secondary ms-1">Hidden</span>' : ""}</td>
      <td><div class="input-group input-group-sm" style="max-width:320px">
        <input class="form-control" placeholder="New name…" data-rename-input="${esc(a)}" ${h ? "disabled" : ""}>
        <button class="btn btn-primary" data-rename="${esc(a)}" ${h ? "disabled" : ""}>Apply</button></div></td>
      <td class="text-end"><button class="btn btn-sm ${h ? "btn-success" : "btn-outline-danger"}" data-toggle="${esc(a)}">
        <i class="fa-solid ${h ? "fa-eye" : "fa-eye-slash"}"></i></button></td></tr>`;
  }).join("");
}

function bindManage() {
  $("manageBtn").onclick = () => { renderManage(); bootstrap.Modal.getOrCreateInstance($("manageModal")).show(); };
  $("manageTableBody").onclick = async e => {
    const rename = e.target.closest("[data-rename]"), toggle = e.target.closest("[data-toggle]");
    if (rename) {
      const old = rename.dataset.rename;
      const name = $("manageTableBody").querySelector(`[data-rename-input="${CSS.escape(old)}"]`).value.trim();
      if (await renameActivity(old, name)) { toast(`Renamed ${old} → ${name}`); await refreshFilters(); }
      else toast("Enter a new, unused name.", "warn");
    }
    if (toggle) { await toggleHidden(toggle.dataset.toggle); await refreshFilters(); }
    renderManage();
  };
}

bindTeamToolbar();
bindManage();
boot();
