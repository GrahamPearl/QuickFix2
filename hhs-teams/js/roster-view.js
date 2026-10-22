// Pure rendering of the roster grid. Events are delegated in team-ui.js.
import { CONFIG } from "./config.js";
import { $, esc } from "./utils.js";
import { state } from "./store.js";

const BADGES = {
  "Captain": ["captain", "fa-star", "Captain"],
  "Vice-Captain": ["vice", "fa-star-half-stroke", "Vice-Capt"],
  "Leadership": ["lead", "fa-shield-halved", "Leadership"]
};

const roleSelect = (admno, current) => `
  <select class="form-select form-select-sm role-select" data-action="role" data-adm="${esc(admno)}">
    ${CONFIG.ROLES.map(r => `<option ${r === current ? "selected" : ""}>${esc(r)}</option>`).join("")}
  </select>`;

function card(admno) {
  const s = state.students.get(admno), role = state.rolesCur[admno] || "Member";
  const b = BADGES[role];
  const badge = b ? `<span class="role-badge role-${b[0]}"><i class="fa-solid ${b[1]}"></i> ${b[2]}</span>` : "";
  const remove = `<button class="remove-btn" data-action="remove" data-adm="${esc(admno)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
  if (!s) return `<div class="student-card is-unknown" data-adm="${esc(admno)}">${remove}
      <div class="avatar"><div class="avatar-fallback"><i class="fa-solid fa-user-slash"></i></div></div>
      <div class="badge-row">${badge}</div>
      <div class="card-info"><div class="s-name">Unknown</div><div class="s-admno">${esc(admno)}</div>
      <div class="s-class">Not in students.json</div>${roleSelect(admno, role)}</div></div>`;
  const photo = `${CONFIG.PHOTO_BASE_URL}${encodeURI(s.photo || "")}`;
  const initials = (s.firstName?.[0] || "") + (s.lastName?.[0] || "");
  return `<div class="student-card" data-adm="${esc(admno)}">${remove}
    <span class="gender gender-${esc(s.gender)}">${esc(s.gender)}</span>
    <div class="avatar">
      <img src="${esc(photo)}" alt="${esc(s.firstName)}" loading="lazy" data-action="zoom" onerror="this.style.display='none';this.nextElementSibling.classList.remove('d-none')">
      <div class="avatar-fallback d-none">${esc(initials)}</div>
    </div>
    <div class="badge-row">${badge}</div>
    <div class="card-info"><div class="s-name">${esc(s.firstName)} ${esc(s.lastName)}</div>
      <div class="s-admno">${esc(admno)}</div><div class="s-class">${esc(s.class || "")}</div>
      ${roleSelect(admno, role)}</div></div>`;
}

const empty = (icon, text) => `<div id="emptyState"><i class="fa-solid ${icon}"></i>${text}</div>`;
const byName = (a, b) => {
  const sa = state.students.get(a), sb = state.students.get(b);
  if (!sa || !sb) return a.localeCompare(b);
  return sa.lastName.localeCompare(sb.lastName) || sa.firstName.localeCompare(sb.firstName);
};

export function renderRoster(search = "") {
  const el = $("roster"), count = $("memberCount"), stats = $("genderStats");
  const q = search.toLowerCase().trim();
  if (!state.key || !state.roster.length) {
    el.innerHTML = state.key ? empty("fa-users-slash", "No students in this team yet.") : empty("fa-users-slash", "Select an activity and age group to view the team.");
    count.classList.add("d-none"); stats.innerHTML = ""; return;
  }
  const g = { F: [], M: [], U: [] };
  state.roster.forEach(a => { const s = state.students.get(a); g[s ? (s.gender === "F" ? "F" : "M") : "U"].push(a); });
  stats.innerHTML = `<span class="stat-pill stat-M">Boys ${g.M.length}</span><span class="stat-pill stat-F">Girls ${g.F.length}</span>` +
    (g.U.length ? `<span class="stat-pill stat-U">Unlisted ${g.U.length}</span>` : "");
  count.textContent = `${state.roster.length} member${state.roster.length === 1 ? "" : "s"}`;
  count.classList.remove("d-none");

  const match = a => {
    if (!q) return true;
    const s = state.students.get(a);
    return a.includes(q) || (s && `${s.firstName} ${s.lastName} ${s.class || ""}`.toLowerCase().includes(q));
  };
  const section = (title, list) => {
    const f = list.filter(match).sort(byName);
    return f.length ? `<div class="group-heading">${title} (${f.length})</div>${f.map(card).join("")}` : "";
  };
  el.innerHTML = (section("Girls", g.F) + section("Boys", g.M) + section("Unknown", g.U)) || empty("fa-magnifying-glass", "No matching results.");
}
