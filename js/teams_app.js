/**
 * teams_app.js — Manages team rosters, activity structures, and live Firestore student metadata.
 */

import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  auth, 
  onAuthStateChanged, 
} from "./firebase-init.js";

const waitForAuth = () => new Promise((resolve) => {
  const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
});

// first line of init():
if (!(await waitForAuth())) { location.href = "index.html"; return; }

import { getAllStudents } from "./data-service.js";

const CONFIG = {
  PHOTO_BASE_URL: "./photos/",
  FIRESTORE_COLLECTION: "teams",
  STUDENTS_COLLECTION: "students"
};

const PREDEFINED_ROLES = [
  "Member",
  "Captain",
  "Vice-Captain",
  "Leadership",
  "Awarded KZN",
  "Awarded SA",
  "Enrichment"
];

let TEAMS_DATA = {};
let TEAMS_ROLES = {}; 
let currentRoles = {}; 

let MASTER_FILTERS = { activities: [], ageGroups: {} };
let HiddenActivities = new Set();
let studentsMap = new Map();
let currentTeamKey = null;
let currentRoster = [];
let autoSaveTimeout = null;
let unsubscribeStudents = null;

// Live Syncing for Student Profiles via Firestore
async function setupStudentsListener() {
  try {
    const studentsColRef = collection(db, CONFIG.STUDENTS_COLLECTION);
    unsubscribeStudents = onSnapshot(studentsColRef, (snapshot) => {
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const adminNo = String(data.adminNo || docSnap.id).trim();
        studentsMap.set(adminNo, {
          adminNo,
          firstName: data.firstName || "",
          lastName: data.lastName || "",
          class: data.registrationClass || data.class || "",
          gender: data.gender || "",
          photo: data.photo || `${adminNo}.jpg`
        });
      });
      renderRoster();
    }, (error) => {
      console.warn("Firestore student listener error, falling back to data-service:", error);
      loadStudentsFallback();
    });
  } catch (e) {
    console.warn("Snapshot setup failed, falling back to single fetch:", e);
    await loadStudentsFallback();
  }
}

async function loadStudentsFallback() {
  try {
    const arr = await getAllStudents();
    arr.forEach(s => {
      const adminNo = String(s.adminNo).trim();
      studentsMap.set(adminNo, {
        adminNo,
        firstName: s.firstName || "",
        lastName: s.lastName || "",
        class: s.registrationClass || s.class || "",
        gender: s.gender || "",
        photo: s.photo || `${adminNo}.jpg`
      });
    });
    renderRoster();
  } catch (err) {
    console.error("Failed to load students profile map:", err);
  }
}

function buildFiltersFromTeamsData() {
  const activitiesSet = new Set();
  MASTER_FILTERS = { activities: [], ageGroups: {} };

  Object.keys(TEAMS_DATA).forEach(key => {
    if (!key.includes("||")) return;
    const [act, age] = key.split("||");
    if (act && age) {
      activitiesSet.add(act);
      if (!MASTER_FILTERS.ageGroups[act]) MASTER_FILTERS.ageGroups[act] = [];
      if (!MASTER_FILTERS.ageGroups[act].includes(age)) MASTER_FILTERS.ageGroups[act].push(age);
    }
  });

  MASTER_FILTERS.activities = Array.from(activitiesSet).sort();

  // Emergency fallback if database has no team records yet
  if (!MASTER_FILTERS.activities || MASTER_FILTERS.activities.length === 0) {
    console.warn("⚠️ TEAMS_DATA has no activities. Applying fallback defaults.");
    MASTER_FILTERS = {
      activities: ["Rugby", "Soccer", "Netball", "Cricket", "Chess"],
      ageGroups: {
        "Rugby": ["U14", "U15", "U16", "Open"],
        "Soccer": ["U14", "U15", "U16", "Open"],
        "Netball": ["U14", "U15", "U16", "Open"],
        "Cricket": ["U14", "U15", "U16", "Open"],
        "Chess": ["Open"]
      }
    };
  }
}

async function syncMasterFiltersFromCloud() {
  try {
    const metaRef = doc(db, CONFIG.FIRESTORE_COLLECTION, "_metadata");
    const metaDoc = await getDoc(metaRef);
    if (metaDoc.exists() && metaDoc.data().activities && metaDoc.data().activities.length > 0) {
      MASTER_FILTERS = metaDoc.data();
    } else {
      buildFiltersFromTeamsData();
    }
  } catch (e) {
    console.warn("Failed to sync filters from cloud metadata, building from team keys:", e);
    buildFiltersFromTeamsData();
  }

  // Double check: if sync returned an empty object, force fallback
  if (!MASTER_FILTERS.activities || MASTER_FILTERS.activities.length === 0) {
    buildFiltersFromTeamsData();
  }
}

function populateFilters() {
  const visibleActivities = (MASTER_FILTERS.activities || []).filter(act => !HiddenActivities.has(act));
  const actSel = document.getElementById("activitySelect");
  if (!actSel) return;

  if (visibleActivities.length === 0) {
    actSel.innerHTML = '<option value="">No Activities Available</option>';
    updateAgeGroupSelect();
    return;
  }

  actSel.innerHTML = visibleActivities
    .map(a => `<option value="${esc(a)}">${esc(a)}</option>`)
    .join("");

  actSel.value = visibleActivities[0];

  // Populate age groups for the currently selected activity
  updateAgeGroupSelect();
}

function updateAgeGroupSelect() {
  const activity = document.getElementById("activitySelect").value;
  const agSel = document.getElementById("agegroupSelect");
  const previous = agSel.value;

  const agegroups = [...(MASTER_FILTERS.ageGroups[activity] || [])].sort();
  agSel.innerHTML = agegroups.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");

  if (agegroups.includes(previous)) {
    agSel.value = previous;
  }
}

function onActivityChange() { updateAgeGroupSelect(); loadTeam(); }
function onAgeGroupChange() { loadTeam(); }

async function loadTeam() {
  const activity = document.getElementById("activitySelect").value;
  const agegroup = document.getElementById("agegroupSelect").value;
  if (!activity || !agegroup) {
    currentTeamKey = null;
    currentRoster = [];
    currentRoles = {};
    renderRoster();
    return;
  }
  currentTeamKey = `${activity}||${agegroup}`;
  currentRoster = [...(TEAMS_DATA[currentTeamKey] || [])];
  currentRoles = TEAMS_ROLES[currentTeamKey] || {};

  setSyncPill("saving");
  try {
    const teamDocRef = doc(db, CONFIG.FIRESTORE_COLLECTION, currentTeamKey.replace("/", "_"));
    const docSnap = await getDoc(teamDocRef);
    if (docSnap.exists() && docSnap.data().members) {
      currentRoster = [...docSnap.data().members];
      currentRoles = docSnap.data().roles || {};
      TEAMS_DATA[currentTeamKey] = [...currentRoster];
      TEAMS_ROLES[currentTeamKey] = { ...currentRoles };
    }
    setSyncPill("idle");
    renderRoster();
  } catch (err) {
    console.warn("Error fetching team data:", err);
    setSyncPill("offline");
    renderRoster();
  }
  document.getElementById("teamHeading").textContent = `${activity} · ${agegroup}`;
}

function triggerAutoSave() {
  markUnsaved();
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    if (!currentTeamKey) return;
    setSyncPill("saving");
    try {
      const teamDocRef = doc(db, CONFIG.FIRESTORE_COLLECTION, currentTeamKey.replace("/", "_"));
      await setDoc(teamDocRef, {
        members: currentRoster,
        roles: currentRoles,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      clearUnsaved();
      setSyncPill("saved");
      setTimeout(() => setSyncPill("idle"), 2000);
    } catch (e) {
      console.error("AutoSave Error:", e);
      setSyncPill("error");
    }
  }, 1500);
}

function renderRoster() {
  const roster = document.getElementById("roster");
  const countEl = document.getElementById("memberCount");
  const searchVal = document.getElementById("rosterSearch").value.toLowerCase().trim();

  if (!currentRoster.length) {
    roster.innerHTML = `<div id="emptyState"><i class="fa-solid fa-users-slash"></i>No students in this team yet.</div>`;
    countEl.style.display = "none";
    document.getElementById("genderStats").innerHTML = "";
    return;
  }

  let maleCount = 0, femaleCount = 0, unknownCount = 0;
  currentRoster.forEach(adm => {
    const s = studentsMap.get(adm);
    if (!s) unknownCount++;
    else if (s.gender === "M") maleCount++;
    else if (s.gender === "F") femaleCount++;
  });

  document.getElementById("genderStats").innerHTML = `
    <span class="stat-pill badge-M">👦 Boys: ${maleCount}</span>
    <span class="stat-pill badge-F">👩 Girls: ${femaleCount}</span>
    ${unknownCount ? `<span class="stat-pill bg-warning text-dark">⚠ Unlisted: ${unknownCount}</span>` : ''}
  `;

  const filteredRoster = currentRoster.filter(admno => {
    if (!searchVal) return true;
    if (admno.toLowerCase().includes(searchVal)) return true;
    const s = studentsMap.get(admno);
    if (s) {
      const fullName = `${s.firstName} ${s.lastName}`.toLowerCase();
      if (fullName.includes(searchVal) || (s.class && s.class.toLowerCase().includes(searchVal))) return true;
    }
    return false;
  });

  countEl.textContent = `${currentRoster.length} allocation${currentRoster.length !== 1 ? "s" : ""}`;
  countEl.style.display = "";

  if (!filteredRoster.length) {
    roster.innerHTML = `<div id="emptyState"><i class="fa-solid fa-magnifying-glass"></i>No matching results found.</div>`;
    return;
  }

  const females = [], males = [], unknown = [];
  filteredRoster.forEach(admno => {
    const s = studentsMap.get(admno);
    if (!s) unknown.push(admno);
    else if (s.gender === "F") females.push(admno);
    else if (s.gender === "M") males.push(admno);
    else unknown.push(admno);
  });

  function sortGroup(list) {
    return [...list].sort((a, b) => {
      const sa = studentsMap.get(a), sb = studentsMap.get(b);
      if (!sa || !sb) return a.localeCompare(b);
      const ln = sa.lastName.localeCompare(sb.lastName);
      return ln !== 0 ? ln : sa.firstName.localeCompare(sb.firstName);
    });
  }

  let html = "";
  const sf = sortGroup(females), sm = sortGroup(males), su = sortGroup(unknown);

  if (sf.length) html += `<div class="group-heading">👩 Girls (${sf.length})</div>` + sf.map(buildCard).join("");
  if (sm.length) html += `<div class="group-heading">👦 Boys (${sm.length})</div>` + sm.map(buildCard).join("");
  if (su.length) html += `<div class="group-heading">⚠ Unknown (${su.length})</div>` + su.map(buildCard).join("");

  roster.innerHTML = html;
}

function buildCard(admno) {
  const s = studentsMap.get(admno);
  const assignedRole = currentRoles[admno] || "Member";

  let specialBadgeHtml = "";
  if (assignedRole === "Captain") {
    specialBadgeHtml = `<span class="special-role-badge badge-captain"><i class="fa-solid fa-star"></i> Captain</span>`;
  } else if (assignedRole === "Vice-Captain") {
    specialBadgeHtml = `<span class="special-role-badge badge-vice-captain"><i class="fa-solid fa-star-half-stroke"></i> Vice-Capt</span>`;
  } else if (assignedRole === "Leadership") {
    specialBadgeHtml = `<span class="special-role-badge badge-leadership"><i class="fa-solid fa-shield-halved"></i> Leadership</span>`;
  }

  const roleOptionsHtml = PREDEFINED_ROLES.map(r => 
    `<option value="${esc(r)}" ${r === assignedRole ? 'selected' : ''}>${esc(r)}</option>`
  ).join("");

  if (!s) {
    return `<div class="student-card unknown-student" id="card-${admno}">
      <button class="remove-btn" data-action="prompt-delete" data-admno="${esc(admno)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
      <div class="photo-wrap"><div class="photo-placeholder"><i class="fa-solid fa-user-slash"></i></div></div>
      <div class="role-badge-container">${specialBadgeHtml}</div>
      <div class="card-info">
        <div class="s-name">Unknown</div><div class="s-admno">${esc(admno)}</div>
        <div class="s-class" style="color:var(--warn); font-size:0.65rem;">Unindexed ID</div>
        <select class="form-select form-select-sm s-role-select" data-action="change-role" data-admno="${esc(admno)}">
          ${roleOptionsHtml}
        </select>
      </div>
    </div>`;
  }

  const photoUrl = `${CONFIG.PHOTO_BASE_URL}${esc(s.photo)}`;
  const initials = ((s.firstName[0] || "") + (s.lastName[0] || "")).toUpperCase();
  const gBadge = s.gender === "M" ? "badge-M" : "badge-F";

  return `<div class="student-card" id="card-${admno}">
    <button class="remove-btn" data-action="prompt-delete" data-admno="${esc(admno)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
    <span class="s-gender ${gBadge}">${esc(s.gender)}</span>
    <div class="photo-wrap">
      <img src="${photoUrl}" alt="${esc(s.firstName)}" data-action="view-photo" data-src="${photoUrl}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <div class="photo-placeholder" style="display:none;"><span style="font-size:1.6rem;font-weight:700;color:#5a7a95;">${esc(initials)}</span></div>
    </div>
    <div class="role-badge-container">${specialBadgeHtml}</div>
    <div class="card-info">
      <div class="s-name">${esc(s.firstName)} ${esc(s.lastName)}</div>
      <div class="s-admno">${esc(admno)}</div><div class="s-class">${esc(s.class || "")}</div>
      <select class="form-select form-select-sm s-role-select" data-action="change-role" data-admno="${esc(admno)}">
        ${roleOptionsHtml}
      </select>
    </div>
  </div>`;
}

function promptDelete(admno) {
  const card = document.getElementById(`card-${admno}`);
  if (!card) return;

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div>Remove profile?</div>
    <div class="d-flex gap-1">
      <button class="btn btn-danger btn-sm py-0 px-2" data-action="confirm-delete" data-admno="${esc(admno)}">Yes</button>
      <button class="btn btn-secondary btn-sm py-0 px-2" data-action="cancel-delete" data-admno="${esc(admno)}">No</button>
    </div>
  `;
  card.appendChild(overlay);
}

function cancelDelete(admno) {
  const card = document.getElementById(`card-${admno}`);
  const overlay = card ? card.querySelector(".confirm-overlay") : null;
  if (overlay) overlay.remove();
}

function updateStudentRole(admno, newRole) {
  if (!currentTeamKey) return;
  
  currentRoles[admno] = newRole;
  TEAMS_ROLES[currentTeamKey] = { ...currentRoles };
  
  triggerAutoSave();
  renderRoster();
  
  const s = studentsMap.get(admno);
  const name = s ? `${s.firstName} ${s.lastName}` : admno;
  showToast(`Updated ${name} to ${newRole}.`, "success");
}

function confirmDelete(admno) {
  const idx = currentRoster.indexOf(admno);
  if (idx !== -1) {
    currentRoster.splice(idx, 1);
    delete currentRoles[admno];
    TEAMS_DATA[currentTeamKey] = [...currentRoster];
    TEAMS_ROLES[currentTeamKey] = { ...currentRoles };
    triggerAutoSave();
    renderRoster();
    showToast(`Removed registration assignment.`, "danger");
  }
}

function addStudent() {
  if (!currentTeamKey) { showToast("Select an activity/age group first.", "warn"); return; }
  const input = document.getElementById("adminInput");
  const admno = input.value.trim();
  if (!admno) { showToast("Enter an Admin No.", "warn"); return; }

  if (currentRoster.includes(admno)) {
    showToast(`${admno} is already assigned here.`, "warn");
    return;
  }

  currentRoster.push(admno);
  currentRoles[admno] = "Member";
  TEAMS_DATA[currentTeamKey] = [...currentRoster];
  TEAMS_ROLES[currentTeamKey] = { ...currentRoles };
  triggerAutoSave();
  renderRoster();
  input.value = "";
  input.focus();
}

function removeStudentByInput() {
  const input = document.getElementById("adminInput");
  const admno = input.value.trim();
  if (!admno) { showToast("Enter an Admin No to remove.", "warn"); return; }
  confirmDelete(admno);
  input.value = "";
}

function openBulkAddModal() {
  if (!currentTeamKey) { showToast("Select a team setup target first.", "warn"); return; }
  document.getElementById("bulkInput").value = "";
  new bootstrap.Modal(document.getElementById('bulkAddModal')).show();
}

function processBulkAdd() {
  const text = document.getElementById("bulkInput").value;
  const tokens = text.split(/[\s,;\n\t]+/);
  let addedCount = 0;

  tokens.forEach(tok => {
    const clean = tok.trim();
    if (clean && !currentRoster.includes(clean)) {
      currentRoster.push(clean);
      currentRoles[clean] = "Member";
      addedCount++;
    }
  });

  if (addedCount > 0) {
    TEAMS_DATA[currentTeamKey] = [...currentRoster];
    TEAMS_ROLES[currentTeamKey] = { ...currentRoles };
    triggerAutoSave();
    renderRoster();
    showToast(`Successfully registered ${addedCount} members to roster.`, "success");
  }
  bootstrap.Modal.getInstance(document.getElementById('bulkAddModal')).hide();
}

function openManageUI() {
  const tbody = document.getElementById("manageTableBody");
  const distinctActivities = [...new Set(Object.keys(TEAMS_DATA).map(k => k.split("||")[0]))].sort();

  tbody.innerHTML = distinctActivities.map(act => {
    const isHidden = HiddenActivities.has(act);
    return `
      <tr style="${isHidden ? 'opacity: 0.5; background: #f8f9fa;' : ''}">
        <td><strong>${esc(act)}</strong> ${isHidden ? '<span class="badge bg-secondary ms-1">Hidden</span>' : ''}</td>
        <td>
          <div class="input-group input-group-sm" style="max-width: 320px;">
            <input type="text" class="form-control" placeholder="New structural name..." id="rename-to-${esc(act)}" ${isHidden ? 'disabled' : ''}>
            <button class="btn btn-primary" type="button" data-action="rename-activity" data-act="${esc(act)}" ${isHidden ? 'disabled' : ''}>Apply</button>
          </div>
        </td>
        <td class="text-end">
          <button class="btn btn-sm ${isHidden ? 'btn-success' : 'btn-outline-danger'}" data-action="toggle-hide-activity" data-act="${esc(act)}">
            <i class="fa-solid ${isHidden ? 'fa-eye' : 'fa-eye-slash'}"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  new bootstrap.Modal(document.getElementById('manageModal')).show();
}

function toggleHideActivity(activity) {
  if (HiddenActivities.has(activity)) {
    HiddenActivities.delete(activity);
  } else {
    HiddenActivities.add(activity);
  }
  populateFilters();
  loadTeam();
  openManageUI();
}

async function executeRename(oldName) {
  const input = document.getElementById(`rename-to-${oldName}`);
  const newName = input.value.trim();
  if (!newName || newName === oldName) return;

  const keys = Object.keys(TEAMS_DATA);
  for (const k of keys) {
    const parts = k.split("||");
    if (parts[0] === oldName) {
      const targetKey = `${newName}||${parts[1]}`;
      TEAMS_DATA[targetKey] = TEAMS_DATA[k];
      delete TEAMS_DATA[k];

      TEAMS_ROLES[targetKey] = TEAMS_ROLES[k] || {};
      delete TEAMS_ROLES[k];

      const newRef = doc(db, CONFIG.FIRESTORE_COLLECTION, targetKey.replace("/", "_"));
      const oldRef = doc(db, CONFIG.FIRESTORE_COLLECTION, k.replace("/", "_"));
      
      await setDoc(newRef, {
        members: TEAMS_DATA[targetKey],
        roles: TEAMS_ROLES[targetKey],
        updatedAt: new Date().toISOString()
      });
      await deleteDoc(oldRef);
    }
  }

  const actIdx = MASTER_FILTERS.activities.indexOf(oldName);
  if (actIdx !== -1) MASTER_FILTERS.activities[actIdx] = newName;
  MASTER_FILTERS.activities.sort();
  MASTER_FILTERS.ageGroups[newName] = MASTER_FILTERS.ageGroups[oldName] || [];
  delete MASTER_FILTERS.ageGroups[oldName];

  const metaRef = doc(db, CONFIG.FIRESTORE_COLLECTION, "_metadata");
  await setDoc(metaRef, MASTER_FILTERS);

  showToast(`Renamed ${oldName} to ${newName}`, "success");
  populateFilters();
  loadTeam();
  openManageUI();
}

function exportToExcel() {
  if (!currentTeamKey) { showToast("No group selection active.", "warn"); return; }
  const outputData = currentRoster.map((adm, index) => {
    const s = studentsMap.get(adm);
    return {
      "Index": index + 1,
      "Admin No": adm,
      "First Name": s ? s.firstName : "Unknown",
      "Last Name": s ? s.lastName : "Unlisted",
      "Class": s ? s.class || "" : "",
      "Gender": s ? s.gender || "" : "",
      "Role": currentRoles[adm] || "Member"
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(outputData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Roster");
  XLSX.writeFile(workbook, `${currentTeamKey.replace(/[^a-z0-9]/gi, "_")}_Roster.xlsx`);
}

function exportTeamJSON() {
  if (!currentTeamKey) { showToast("No team selected.", "warn"); return; }
  const payload = { 
    teamKey: currentTeamKey, 
    members: currentRoster, 
    roles: currentRoles, 
    exportedAt: new Date().toISOString() 
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentTeamKey.replace(/[^a-z0-9]/gi, "_") + ".json";
  a.click();
}

function importTeamJSON() { document.getElementById("importFileInput").click(); }

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.teamKey || !Array.isArray(data.members)) throw new Error("Invalid schema");
      TEAMS_DATA[data.teamKey] = [...data.members];
      TEAMS_ROLES[data.teamKey] = data.roles || {};
      const [activity, agegroup] = data.teamKey.split("||");
      populateFilters();
      document.getElementById("activitySelect").value = activity;
      updateAgeGroupSelect();
      document.getElementById("agegroupSelect").value = agegroup;
      loadTeam();
      showToast(`Imported list config containing ${data.members.length} records.`, "success");
    } catch (err) {
      showToast("Import error encountered: " + err.message, "danger");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function openImageModal(src) {
  const modal = document.getElementById("imageModal");
  if (!modal) return;
  document.getElementById("modalImage").src = src;
  modal.classList.remove("is-hidden");
  modal.style.display = "flex";
}

function closeImageModal() {
  const modal = document.getElementById("imageModal");
  if (!modal) return;
  modal.classList.add("is-hidden");
  modal.style.display = "none";
  document.getElementById("modalImage").src = "";
}

function setSyncPill(state) {
  const el = document.getElementById("syncPill");
  const labels = { idle: "Cloud Sync Ready", saving: "Syncing…", saved: "Saved Successfully", error: "Sync Error", offline: "Local Mode" };
  const classes = { idle: "pill-idle", saving: "pill-saving", saved: "pill-saved", error: "pill-error", offline: "pill-offline" };
  el.className = "syncPill " + (classes[state] || "pill-idle");
  el.textContent = labels[state] || state;
}
function markUnsaved() { document.getElementById("unsavedDot").style.display = ""; }
function clearUnsaved() { document.getElementById("unsavedDot").style.display = "none"; }

function showToast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast-msg toast-${type}`;
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 2800);
}

function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wireEventListeners() {
  document.getElementById("activitySelect")?.addEventListener("change", onActivityChange);
  document.getElementById("agegroupSelect")?.addEventListener("change", onAgeGroupChange);
  document.getElementById("rosterSearch")?.addEventListener("input", renderRoster);
  
  document.getElementById("adminInput")?.addEventListener("keydown", (e) => {
    if (e.key === 'Enter') addStudent();
  });

  document.getElementById("addStudentBtn")?.addEventListener("click", addStudent);
  document.getElementById("removeStudentBtn")?.addEventListener("click", removeStudentByInput);
  document.getElementById("bulkAddBtn")?.addEventListener("click", openBulkAddModal);
  document.getElementById("processBulkAddBtn")?.addEventListener("click", processBulkAdd);

  document.getElementById("openManageBtn")?.addEventListener("click", openManageUI);
  document.getElementById("exportJsonBtn")?.addEventListener("click", exportTeamJSON);
  document.getElementById("importJsonBtn")?.addEventListener("click", importTeamJSON);
  document.getElementById("importFileInput")?.addEventListener("change", handleImportFile);
  document.getElementById("exportExcelBtn")?.addEventListener("click", exportToExcel);

  // Safe binding for optional image modal close button
  document.getElementById("closeImageModalBtn")?.addEventListener("click", closeImageModal);

document.getElementById("imageModal")?.addEventListener("click", (e) => {
  if (e.target.id === "imageModal" || e.target.id === "closeImageModalBtn") {
    closeImageModal();
  }
});

// Close modal when pressing Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeImageModal();
  }
});

  document.addEventListener("click", (e) => {
    const actionTarget = e.target.closest("[data-action]");
    if (!actionTarget) return;

    const action = actionTarget.dataset.action;
    const admno = actionTarget.dataset.admno;
    const act = actionTarget.dataset.act;

    if (action === "prompt-delete") promptDelete(admno);
    if (action === "confirm-delete") confirmDelete(admno);
    if (action === "cancel-delete") cancelDelete(admno);
    if (action === "view-photo") openImageModal(actionTarget.dataset.src);
    if (action === "toggle-hide-activity") toggleHideActivity(act);
    if (action === "rename-activity") executeRename(act);
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset.action === "change-role") {
      updateStudentRole(e.target.dataset.admno, e.target.value);
    }
  });
}

async function loadAllTeamsData() {
  console.log("📡 Querying Firestore collection:", CONFIG.FIRESTORE_COLLECTION);
  try {
    const snapshot = await getDocs(collection(db, CONFIG.FIRESTORE_COLLECTION));
    console.log(`📊 Firestore query returned ${snapshot.size} document(s).`);

    if (snapshot.empty) {
      console.warn("⚠️ No documents found in collection:", CONFIG.FIRESTORE_COLLECTION);
      return;
    }

    snapshot.forEach((docSnap) => {
      const docId = docSnap.id;
      if (docId === "_metadata") return;

      const data = docSnap.data();
      console.log(`📄 Document ID: "${docId}" | Data:`, data);

      let teamKey = data.teamKey || docId;

      if (!teamKey.includes("||")) {
        if (data.activity && data.ageGroup) {
          teamKey = `${data.activity}||${data.ageGroup}`;
        } else if (data.teamName) {
          teamKey = `${data.teamName}||Open`;
        } else if (docId.includes("_")) {
          teamKey = docId.replace("_", "||");
        }
      }

      TEAMS_DATA[teamKey] = data.members || [];
      TEAMS_ROLES[teamKey] = data.roles || {};
    });

    console.log("✅ Parsed TEAMS_DATA keys:", Object.keys(TEAMS_DATA));
  } catch (err) {
    console.error("❌ Error loading team documents from Firestore:", err);
  }
}

// Start Runtime
// Initializer
// Start Runtime
async function init() {
  console.log("🚀 Initializing application...");
  setSyncPill("saving");
  await setupStudentsListener();
  await loadAllTeamsData();
  await syncMasterFiltersFromCloud();
  
  console.log("📋 Final MASTER_FILTERS:", MASTER_FILTERS);
  
  populateFilters();
  loadTeam();
  wireEventListeners();
  console.log("✅ Application successfully initialized.");
}

// Call initializer on DOM load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}