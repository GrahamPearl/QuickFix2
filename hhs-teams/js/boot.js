import * as fs from "./firestore.js";
import { auth, onAuthStateChanged } from "../../js/firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "../../js/usertypes.js";
import { loadStudents, loadMeta } from "./store.js";
import { refreshFilters } from "./team-ui.js";

const home = () => location.replace("../index.html");

export async function boot(required = "viewTeams") {
  const user = await new Promise((r) => { const off = onAuthStateChanged(auth, (u) => { off(); r(u); }); });
  if (!user) return home();
  const cfg = await loadUserTypes();
  const type = await resolveUserType(user, cfg);
  if (!can(cfg, type, required)) return home();
  document.body.dataset.canEdit = String(can(cfg, type, "editTeams"));
  fs.init();
  await Promise.all([loadStudents(), loadMeta()]);
  await refreshFilters();
}