import * as fs from "./firestore.js";
import { loadStudents, loadMeta } from "./store.js";
import { refreshFilters } from "./team-ui.js";

export async function boot() {
  fs.init();
  await Promise.all([loadStudents(), loadMeta()]);
  await refreshFilters();
}
