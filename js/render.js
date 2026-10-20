/**
 * render.js
 * All DOM-building lives here, kept separate from data/search logic.
 */
const { IMAGE_BASE_URL, FALLBACK_IMAGE } = window.APP_CONFIG;

export function photoUrl(filename) {
  if (!filename) return FALLBACK_IMAGE;
  return IMAGE_BASE_URL + filename;
}

function openPhotoModal(imageUrl) {
  const existing = document.getElementById("photoZoomModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "photoZoomModal";

  const backdrop = document.createElement("div");
  backdrop.className = "photo-modal-backdrop";

  const content = document.createElement("div");
  content.className = "photo-modal-content";

  const img = document.createElement("img");
  img.src = imageUrl;
  img.alt = "Student photo";
  img.className = "photo-modal-image";

  content.appendChild(img);
  backdrop.appendChild(content);
  modal.appendChild(backdrop);

  document.body.appendChild(modal);

  backdrop.addEventListener("click", () => modal.remove());
  content.addEventListener("click", e => e.stopPropagation());
}

function initials(s) {
  return `${(s.firstName || "?")[0] || ""}${(s.lastName || "?")[0] || ""}`.toUpperCase();
}

function subjectBadges(subjects, max = 3) {
  if (!subjects || !subjects.length) {
    return `<span class="badge badge-muted">No subjects on file</span>`;
  }
  const shown = subjects.slice(0, max).map((s) => `<span class="badge">${s}</span>`).join("");
  const overflow = subjects.length > max
    ? `<span class="badge badge-muted">+${subjects.length - max} more</span>`
    : "";
  return shown + overflow;
}

export function renderRow(student) {
  const tr = document.createElement("tr");
  tr.className = "roster-row";
  tr.dataset.adminNo = student.adminNo;
  tr.innerHTML = `
    <td class="cell-photo">
      <div class="avatar">
        <img src="${photoUrl(student.photo)}" alt=""
             loading="lazy"
             onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar-fallback',textContent:'${initials(student)}'}))" />
      </div>
    </td>
    <td class="cell-name">
      <span class="student-name">${student.firstName} ${student.lastName}</span>
      <span class="student-sub">${student.registrationClass || ""}</span>
    </td>
    <td class="cell-admin"><span class="mono">${student.adminNo}</span></td>
    <td class="cell-grade">
      <span class="pill pill-grade">Gr ${student.grade}</span>
      <span class="pill pill-class">${student.class}</span>
    </td>
    <td class="cell-gender">${student.gender || ""}</td>
    <td class="cell-subjects">${subjectBadges(student.subjectsSummary)}</td>
  `;
  return tr;
}

export function renderRows(tbody, students) {
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  students.forEach((s) => frag.appendChild(renderRow(s)));
  tbody.appendChild(frag);
}

/** Compact card for grid layouts: photo, admin no, full name only. */
export function renderCard(student) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "student-card";
  card.dataset.adminNo = student.adminNo;

  const imageUrl = photoUrl(student.photo);

  card.innerHTML = `
    <div class="avatar avatar-card"
         style="width: 90px; height: 120px; overflow: hidden; margin: 0 auto;">
      <img
        class="student-photo-preview"
        src="${imageUrl}"
        alt=""
        loading="lazy"
        data-full-image="${imageUrl}"
        style="width: 150%; height: 150%; object-fit: cover; cursor: zoom-in;"
        onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar-fallback',textContent:'${initials(student)}'}))"
      />
    </div>

    <span class="card-name" style="display:block; margin-top:8px;">
      ${student.firstName} ${student.lastName}
    </span>
    <span class="card-admin mono" style="display: block;">${student.registrationClass}</span>
    <span class="card-admin mono" style="display: block;">${student.adminNo}</span>
  `;

  const img = card.querySelector(".student-photo-preview");

  img?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    openPhotoModal(imageUrl); // <--- Updated here
});

  return card;
}

export function renderCards(container, students) {
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  students.forEach((s) => frag.appendChild(renderCard(s)));
  container.appendChild(frag);
}

export function renderEmptyCards(container) {
  container.innerHTML = `
    <div class="empty-state empty-state-grid">
      <p>No students match those filters.</p>
      <p class="empty-hint">Try a different name, admin number, or clear a filter.</p>
    </div>`;
}

/** Renders removable chips for each active filter; returns nothing, just paints the DOM. */
export function renderActiveFilters(el, filters) {
  const labels = {
    grade: (v) => `Grade ${v}`,
    class: (v) => `Class ${v}`,
    gender: (v) => v,
    subject: (v) => v,
    teacher: (v) => `Taught by ${v}`,
  };
  const chips = Object.entries(filters)
    .filter(([, v]) => v)
    .map(
      ([key, value]) => `
      <span class="chip chip-filter">
        ${labels[key] ? labels[key](value) : value}
        <button type="button" class="chip-remove" data-clear-filter="${key}" aria-label="Clear ${key} filter">&times;</button>
      </span>`,
    )
    .join("");
  el.innerHTML = chips;
}

export function renderResultCount(el, count, total) {
  el.textContent = count === total
    ? `${total} student${total === 1 ? "" : "s"}`
    : `${count} of ${total} students`;
}

export function renderEmptyState(tbody, colSpan) {
  tbody.innerHTML = `
    <tr class="empty-row">
      <td colspan="${colSpan}">
        <div class="empty-state">
          <p>No students match those filters.</p>
          <p class="empty-hint">Try a different name, admin number, or clear a filter.</p>
        </div>
      </td>
    </tr>`;
}

export function renderDrawerHeader(student) {
  return `
    <div class="avatar avatar-lg">
      <img src="${photoUrl(student.photo)}" alt=""
           onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar-fallback avatar-fallback-lg',textContent:'${initials(student)}'}))" />
    </div>
    <div>
      <h2 class="drawer-name">${student.firstName} ${student.lastName}</h2>
      <p class="drawer-meta">Admin No <span class="mono">${student.adminNo}</span> · Grade ${student.grade} · ${student.class}</p>
    </div>
  `;
}

/**
 * Formats role titles into clean UI badges (e.g. captain -> Captain).
 */
/**
 * Helper to format role names cleanly (e.g., "vice-captain" -> "Vice-Captain")
 */
function formatRoleLabel(role) {
  if (!role) return "Member";
  return role
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("-");
}

/**
 * Helper to render visual badges for student team roles
 */
function renderRoleBadge(role) {
  if (!role || role.toLowerCase() === "member") return "";

  const formattedRole = formatRoleLabel(role);
  const normalizedRole = role.toLowerCase();

  // Highlight leadership/captain roles differently from volunteer/other roles
  let badgeStyle = "background-color: #f1f3f4; color: #5f6368; border: 1px solid #dadce0;";

  if (normalizedRole === "captain" || normalizedRole === "vice-captain") {
    badgeStyle = "background-color: #e8f0fe; color: #1a73e8; border: 1px solid #aecbfa;";
  } else if (normalizedRole === "leadership") {
    badgeStyle = "background-color: #fce8e6; color: #c5221f; border: 1px solid #fad2cf;";
  } else if (normalizedRole === "volunteer") {
    badgeStyle = "background-color: #e6f4ea; color: #137333; border: 1px solid #ceead6;";
  }

  return `
    <span class="role-badge" style="
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      margin-left: 6px;
      ${badgeStyle}
    ">
      ${formattedRole}
    </span>
  `;
}

/**
 * Renders the complete read-only view inside the student drawer,
 * displaying Basic Info, Enrolled Subjects, and Team Memberships.
 */
export function renderDrawerView(student, isAdmin) {
  // 1. Sort subjects by line number (Line 1, Line 2, etc.)
  const summaries = student.subjectsSummary || [];
  const sortedSummaries = [...summaries].sort((a, b) => {
    const keyA = a.toLowerCase().replace(/[^a-z0-9]/g, "");
    const keyB = b.toLowerCase().replace(/[^a-z0-9]/g, "");
    const lineA = Number((student.enrollments || {})[keyA]?.line) || 99;
    const lineB = Number((student.enrollments || {})[keyB]?.line) || 99;
    return lineA - lineB;
  });

  // 2. Build Subject Table Rows
  const subjectRows = sortedSummaries.length
    ? sortedSummaries
        .map((name) => {
          const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
          const enr = (student.enrollments || {})[key];
          return `
            <tr>
              <td>${name}</td>
              <td>${enr?.teacher || "—"}</td>
              <td>${enr?.line ?? "—"}</td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="empty-hint">No subjects on file</td></tr>`;

  // 3. Build Team Table Rows (Splitting TEAM and GROUP on '||')
  const teams = Array.isArray(student.teams) ? student.teams : [];
  const teamRows = teams.length
    ? teams
        .map((t) => {
          const rawTeam = t.teamName || t.team || "";
          
          // Split on '||'
          const parts = rawTeam.split("||").map((s) => s.trim());
          const teamName = parts[0] || rawTeam || "—";
          const groupName = parts[1] || t.ageGroup || "—";

          const formattedRole = t.role
            ? t.role.charAt(0).toUpperCase() + t.role.slice(1)
            : "Member";

          return `
            <tr>
              <td>${teamName}</td>
              <td>${groupName}</td>
              <td>${formattedRole}</td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="empty-hint">No teams on file</td></tr>`;

  return `
    ${
      isAdmin
        ? `
      <div class="admin-drawer-actions" style="display: flex; gap: 8px; margin-bottom: 16px;">
        <button type="button" id="editStudentBtn" class="btn btn-primary" style="flex: 1;">Edit Student</button>
        <button type="button" id="openTeamsModalBtn" class="btn btn-outline" style="flex: 1;">⚽ Manage Teams</button>
      </div>
    `
        : ""
    }

    <dl class="drawer-facts">
      <div><dt>Registration class</dt><dd>${student.registrationClass || "—"}</dd></div>
      <div><dt>Gender</dt><dd>${student.gender || "—"}</dd></div>
      <div><dt>Age group</dt><dd>${student.agegroup || "—"}</dd></div>
      <div><dt>Birthdate</dt><dd>${student.birthdate || "—"}</dd></div>
    </dl>

    <h3 class="drawer-subheading">Subjects</h3>
    <table class="drawer-table">
      <thead>
        <tr>
          <th>Subject</th>
          <th>Teacher</th>
          <th>Line</th>
        </tr>
      </thead>
      <tbody>${subjectRows}</tbody>
    </table>

    <h3 class="drawer-subheading" style="margin-top: 20px;">Teams & Activities</h3>
    <table class="drawer-table">
      <thead>
        <tr>
          <th>Team</th>
          <th>Group</th>
          <th>Role</th>
        </tr>
      </thead>
      <tbody>${teamRows}</tbody>
    </table>
  `;
}

/** Editable form: field inputs + removable subject chips + add-subject row. */
// Helper inside render.js to extract unique teachers for a given subject from global roster if needed, 
// or you can pass a teacher lookup map. For simplicity, we can generate options dynamically.

export function renderDrawerEdit(draft, subjectOptions, allTeachersBySubject = {}) {
  const subjectRows = (draft.subjectsSummary || []).length
    ? draft.subjectsSummary
        .map((currentSub, index) => {
          const key = currentSub.toLowerCase().replace(/[^a-z0-9]/g, "");
          const currentEnr = (draft.enrollments || {})[key] || {};
          const currentTeacher = currentEnr.teacher || "";
          const currentLine = currentEnr.line ?? "";

          // Options for swapping the subject
          const subjectOptionsHtml = subjectOptions
            .map((s) => `<option value="${s}" ${s === currentSub ? "selected" : ""}>${s}</option>`)
            .join("");

          // Get teachers available for this specific subject
          const teachersList = allTeachersBySubject[currentSub] || [currentTeacher].filter(Boolean);
          const teacherOptionsHtml = teachersList
            .map((t) => `<option value="${t}" ${t === currentTeacher ? "selected" : ""}>${t}</option>`)
            .join("");

          return `
            <div class="edit-subject-row" data-index="${index}" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
              <!-- (a) Swap Subject Dropdown -->
              <select class="edit-subject-select" data-old-subject="${currentSub}" style="flex: 2;">
                ${subjectOptionsHtml}
              </select>

              <!-- (b) Swap Teacher Dropdown -->
              <select class="edit-teacher-select" data-subject-key="${key}" style="flex: 2;">
                <option value="">Select teacher...</option>
                ${teacherOptionsHtml}
              </select>

              <!-- (c) Change Subject Line Input -->
              <input type="number" class="edit-line-input" data-subject-key="${key}" value="${currentLine}" min="1" max="10" placeholder="Line" style="width: 70px;" title="Subject Line Number" />

              <button type="button" class="btn btn-ghost btn-sm chip-remove" data-remove-subject="${currentSub}" title="Remove subject">&times;</button>
            </div>`;
        })
        .join("")
    : `<p class="empty-hint">No subjects assigned.</p>`;

  const availableToAdd = subjectOptions.filter((s) => !draft.subjectsSummary.includes(s));
  const addOptionsHtml = availableToAdd.map((s) => `<option value="${s}">${s}</option>`).join("");

  return `
    <form id="editForm" class="edit-form">
      <div class="edit-grid">
        <div>
          <label for="editFirstName">First name</label>
          <input id="editFirstName" data-field="firstName" type="text" value="${draft.firstName}" required />
        </div>
        <div>
          <label for="editLastName">Last name</label>
          <input id="editLastName" data-field="lastName" type="text" value="${draft.lastName}" required />
        </div>
        <div>
          <label for="editGrade">Grade</label>
          <select id="editGrade" data-field="grade">
            ${[8, 9, 10, 11, 12].map((g) => `<option value="${g}" ${Number(draft.grade) === g ? "selected" : ""}>${g}</option>`).join("")}
          </select>
        </div>
        <div>
          <label for="editClass">Class</label>
          <input id="editClass" data-field="class" type="text" value="${draft.class}" required />
        </div>
        <div>
          <label for="editGender">Gender</label>
          <select id="editGender" data-field="gender">
            <option value="Female" ${draft.gender === "Female" ? "selected" : ""}>Female</option>
            <option value="Male" ${draft.gender === "Male" ? "selected" : ""}>Male</option>
          </select>
        </div>
      </div>

      <h3 class="drawer-subheading">Subjects & Teachers</h3>
      <div class="subjects-edit-container">
        ${subjectRows}
      </div>

      <div class="add-subject-row" style="margin-top: 12px; display: flex; gap: 8px;">
        <select id="addSubjectSelect" style="flex: 1;">
          <option value="">Add a new subject…</option>
          ${addOptionsHtml}
        </select>
        <button type="button" id="addSubjectBtn" class="btn btn-ghost" ${availableToAdd.length ? "" : "disabled"}>Add</button>
      </div>

      <p id="editError" class="error-text"></p>
      <div class="edit-actions" style="margin-top: 16px;">
        <button type="submit" id="saveEditBtn" class="btn btn-primary">Save changes</button>
        <button type="button" id="cancelEditBtn" class="btn btn-ghost">Cancel</button>
      </div>
    </form>
  `;
}

export function renderAddStudentForm(step = 1, adminNoValue = "", studentData = {}, subjectOptions = []) {
  if (step === 1) {
    return `
      <form id="addStudentStep1Form" class="edit-form">
        <h3 class="drawer-subheading">Add New Student: Step 1</h3>
        <p class="empty-hint">Enter the student's Admin Number to check for existing records.</p>
        
        <div style="margin-bottom: 16px;">
          <label for="newAdminNo">Admin Number</label>
          <input id="newAdminNo" type="text" value="${adminNoValue}" required autocomplete="off" />
        </div>

        <p id="step1Error" class="error-text"></p>
        <div class="edit-actions">
          <button type="submit" class="btn btn-primary">Check Admin No & Continue</button>
          <button type="button" id="cancelAddBtn" class="btn btn-ghost">Cancel</button>
        </div>
      </form>
    `;
  }

  // Step 2: Capture remaining details & subjects
  const availableSubjectsHtml = subjectOptions
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");

  return `
    <form id="addStudentStep2Form" class="edit-form">
      <h3 class="drawer-subheading">Add New Student: Step 2</h3>
      <p class="drawer-meta">Admin No: <span class="mono"><strong>${adminNoValue}</strong></span></p>

      <div class="edit-grid">
        <div>
          <label for="newFirstName">First name</label>
          <input id="newFirstName" data-field="firstName" type="text" required />
        </div>
        <div>
          <label for="newLastName">Last name</label>
          <input id="newLastName" data-field="lastName" type="text" required />
        </div>
        <div>
          <label for="newGrade">Grade</label>
          <select id="newGrade" data-field="grade">
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10">10</option>
            <option value="11">11</option>
            <option value="12">12</option>
          </select>
        </div>
        <div>
          <label for="newClass">Class / Registration Class</label>
          <input id="newClass" data-field="class" type="text" required />
        </div>
        <div>
          <label for="newGender">Gender</label>
          <select id="newGender" data-field="gender">
            <option value="Female">Female</option>
            <option value="Male">Male</option>
          </select>
        </div>
        <div>
          <label for="newBirthdate">Birthdate</label>
          <input id="newBirthdate" data-field="birthdate" type="date" />
        </div>
      </div>

      <h3 class="drawer-subheading" style="margin-top: 16px;">Initial Subject Selection</h3>
      <div class="add-subject-row" style="display: flex; gap: 8px;">
        <select id="newSubjectSelect" style="flex: 1;">
          <option value="">Select a subject to add...</option>
          ${availableSubjectsHtml}
        </select>
        <button type="button" id="addNewSubjectBtn" class="btn btn-ghost">Add Subject</button>
      </div>
      <div id="newSubjectsList" class="chip-row" style="margin-top: 8px;">
        <span class="empty-hint">No subjects added yet</span>
      </div>

      <p id="step2Error" class="error-text"></p>
      <div class="edit-actions" style="margin-top: 16px;">
        <button type="submit" class="btn btn-primary">Save New Student</button>
        <button type="button" id="cancelAddBtn" class="btn btn-ghost">Cancel</button>
      </div>
    </form>
  `;
}

export function renderBulkUpdateModal(subjectsList = [], classesList = []) {
  return `
    <div id="bulkUpdateModal" class="modal-overlay" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
      <div class="modal-card" style="background: white; padding: 24px; border-radius: 8px; width: 100%; max-width: 500px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <h3 style="margin-top: 0;">Bulk Data Editor</h3>
        <p class="empty-hint" style="margin-bottom: 16px;">Perform mass updates across student records securely.</p>
        
        <form id="bulkUpdateForm">
          <!-- 1. Select Field to Update -->
          <div style="margin-bottom: 12px;">
            <label for="bulkTargetField"><strong>1. What would you like to change?</strong></label>
            <select id="bulkTargetField" class="form-control" style="width: 100%; margin-top: 4px;" required>
              <option value="">Select field to update...</option>
              <option value="registrationClass">Registration Class</option>
              <option value="grade">Grade</option>
              <option value="subjectTeacher">Subject Teacher (Specific Subject)</option>
              <option value="subjectLine">Subject Line (Specific Subject)</option>
            </select>
          </div>

          <!-- Dynamic Context Container (populated via JS depending on field choice) -->
          <div id="bulkContextContainer" style="margin-bottom: 12px;"></div>

          <!-- 2. Target Filter Criteria -->
          <div style="margin-bottom: 12px;">
            <label for="bulkMatchValue"><strong>2. Current Value to Match (Filter)</strong></label>
            <input id="bulkMatchValue" type="text" class="form-control" placeholder="e.g., Old Teacher Name or Class 10A" style="width: 100%; margin-top: 4px;" required />
            <small class="empty-hint">Only students matching this current value will be updated.</small>
          </div>

          <!-- 3. New Replacement Value -->
          <div style="margin-bottom: 16px;">
            <label for="bulkNewValue"><strong>3. New Replacement Value</strong></label>
            <input id="bulkNewValue" type="text" class="form-control" placeholder="e.g., New Teacher Name or Class 10B" style="width: 100%; margin-top: 4px;" required />
          </div>

          <div id="bulkUpdateError" class="error-text" style="margin-bottom: 12px;"></div>

          <div class="edit-actions" style="display: flex; gap: 8px; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary">Apply Bulk Update</button>
            <button type="button" id="closeBulkModalBtn" class="btn btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/**
 * Renders a single team editing row for a student.
 */
export function renderTeamRow(studentTeam = {}, availableTeams = []) {
  const selectedTeamName = studentTeam.teamName || "";
  const selectedAgeGroup = studentTeam.ageGroup || "";
  const selectedRole = studentTeam.role || "member";

  const roles = ["member", "captain", "vice-captain", "leadership", "volunteer"];
  const ageGroups = ["1st", "2nd", "Grade 8", "Grade 9", "Grade 9", "Grade 10", "Grade 11", "Grade 12", "U14", "U15", "U16", "U17", "U18", "U19", "Open", "Junior", "Senior"];

  return `
    <div class="team-edit-row" style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
      
      <!-- Team Name Select -->
      <div style="flex: 2;">
        <label style="font-size: 0.75rem; font-weight: 600;">Team</label>
        <select class="form-control team-select" required style="width: 100%;">
          <option value="">Select Team...</option>
          ${availableTeams.map(t => `
            <option value="${t.id || t.teamName}" ${t.teamName === selectedTeamName ? "selected" : ""}>
              ${t.teamName}
            </option>
          `).join("")}
        </select>
      </div>

      <!-- Age Group / Group Select -->
      <div style="flex: 1;">
        <label style="font-size: 0.75rem; font-weight: 600;">Group</label>
        <select class="form-control team-group-select" required style="width: 100%;">
          <option value="">Select Group...</option>
          ${ageGroups.map(g => `
            <option value="${g}" ${g === selectedAgeGroup ? "selected" : ""}>${g}</option>
          `).join("")}
        </select>
      </div>

      <!-- Role Select -->
      <div style="flex: 1.5;">
        <label style="font-size: 0.75rem; font-weight: 600;">Role</label>
        <select class="form-control student-role-select" required style="width: 100%;">
          ${roles.map(r => `
            <option value="${r}" ${r === selectedRole ? "selected" : ""}>
              ${r.charAt(0).toUpperCase() + r.slice(1)}
            </option>
          `).join("")}
        </select>
      </div>

      <!-- Delete Button -->
      <div style="margin-top: 18px;">
        <button type="button" class="btn btn-danger-icon remove-team-row-btn" title="Remove Team">
          &times;
        </button>
      </div>

    </div>
  `;
}