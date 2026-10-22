export const $ = id => document.getElementById(id);
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ENT[c]);
export const teamKey = (activity, age) => `${activity}||${age}`;
export const splitKey = key => key.split("||");
export const docId = key => key.replace(/\//g, "_");

export function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast-msg toast-${type}`;
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 2800);
}

const SYNC = {
  idle: ["Cloud ready", "pill-idle"], saving: ["Syncing…", "pill-saving"],
  saved: ["Saved", "pill-saved"], error: ["Sync error", "pill-error"], offline: ["Local mode", "pill-offline"]
};
export function setSync(state) {
  const el = $("syncPill"); if (!el) return;
  const [label, cls] = SYNC[state] || SYNC.idle;
  el.className = `sync-pill ${cls}`; el.textContent = label;
}
export const showUnsaved = on => $("unsavedDot")?.classList.toggle("d-none", !on);

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
