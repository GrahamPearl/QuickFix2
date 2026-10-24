# HHS Student Lookup: Improvements Plan

Ordered from easiest to hardest, with blockers first. Tick items off as they are completed. Because the site is live and used by staff, test each change on a copy (or a staging Firebase project) before deploying.

**Files reviewed:** `index.html`, `js/app.js`, `js/render.js`, `js/search.js`, `js/data-service.js`, `js/usertypes.js`, `json/usertypes.json`, `js/admin_user.js`, `js/timetable.js`, awards modules, and the `hhs-teams/` folder.
**Not reviewed (not supplied):** Firestore Security Rules, `awards.html`, `sample_teams.json`.

---

## Phase 0: Blockers (do first)

These currently break features for all or most users.

- [ ] **B1. Fix stray code in `hhs-teams/js/store.js`**
  Notes pasted as live code run at module load (`admno` is undefined) and crash the whole Teams module.
  1. Delete the stray lines (`state.roster.push(admno)...` and `fs.syncStudentTeam(admno, state.key, null);`) that sit outside any function.
  2. Put the sync calls inside the functions:
  ```js
  export function addMember(admno) {
    /* ...existing checks... */
    state.roster.push(admno); state.rolesCur[admno] = "Member"; commit();
    fs.syncStudentTeam(admno, state.key, "Member");
    return true;
  }
  export function removeMember(admno) {
    const i = state.roster.indexOf(admno);
    if (i < 0) return toast(`${admno} is not in this team.`, "warn");
    state.roster.splice(i, 1); delete state.rolesCur[admno]; commit();
    fs.syncStudentTeam(admno, state.key, null);
    toast("Removed from team.", "danger");
  }
  ```

- [ ] **B2. Fix user type lookup and missing permissions**
  - `resolveUserType()` lowercases the Firestore `type`, but `usertypes.json` keys are camelCase (`staffHead`, `staffGC`, `staffOffice`). Those users are signed out as "not authorised". Replace the lookup:
  ```js
  const t = String(snap.data().type || "").toLowerCase();
  const key = Object.keys(cfg.types).find((k) => k.toLowerCase() === t);
  if (key) return key;
  ```
  - `boot.js` checks `viewTeams`, `editTeams`, `teamsAdmin`, which no type defines, so every user is redirected away from the Teams pages. Add to `usertypes.json`:

  | Type | `viewTeams` | `editTeams` | `teamsAdmin` |
  |---|---|---|---|
  | `admin`, `staffHead` | true | true | true |
  | `staffGC` | true | true | false |
  | `staffOffice`, `staff`, `slt` | true | false | false |

- [ ] **B3. Fix `hhs-teams/admin.html`**
  - Add `<script src="../js/config.js"></script>` before the module script (without it `window.APP_CONFIG` is undefined and the page crashes).
  - Remove the Firebase 9 compat `<script>` tags (not used; the app uses the 12.x modules).

- [ ] **B4. Delete `js/teams_app.js`**
  It contains a top-level `return` (syntax error) and is replaced by `hhs-teams/`.

---

## Phase 1: Easy (minutes each)

- [ ] **1. Fix `cards.css` avatar rule**: `border-radius: var(--radius) overflow: hidden;` is missing a semicolon, so rounding and clipping fail.
- [ ] **2. Open the drawer from grid/card view**: `app.js` only listens for clicks on `tbody`. Add a click listener on `#resultsGrid` calling `openDrawer(card.dataset.adminNo)` (ignore clicks on the photo, which opens the zoom).
- [ ] **3. Show active filter chips**: import and call `renderActiveFilters()` from `runSearch()` and add a handler for `data-clear-filter` clicks (the `#activeFilters` container already exists).
- [ ] **4. Remove dead code in `app.js`**: `authPopover`, `authToggleBtn`, `authReady`, `resolveAuthReady`, `rosterLoaded`, unused `setDoc` import. Update `showAuthError()` and `focusLogin()` so they no longer depend on the missing popover.
- [ ] **5. Remove other dead code**: `renderUserManagementModal` in `render.js`, unused `edit-form.js` exports (until item 9 uses them), `js/to-update.js` if no longer needed, and the "Not in students.json" label in `roster-view.js`.
- [ ] **6. Fix the duplicate "Grade 9"** in the `renderTeamRow` age group list.
- [ ] **7. Use `STUDENTS_COLLECTION`** from config in `data-service.js` instead of the hardcoded `"students"`.
- [ ] **8. Share one role list**: the Teams modal roles (`member, captain, ...`) don't match `CONFIG.ROLES` ("Awarded KZN", "Awarded SA", "Enrichment" are missing). Define one list and make `syncStudentTeam` and `renderTeamRow` use it consistently.
- [ ] **9. Escape all rendered text**: `render.js` inserts names, subjects and teachers into `innerHTML` and `value="..."` unescaped. Import `escapeHtml` from `render-awards.js` (or move it to a shared `utils`) and apply it everywhere, including inline `onerror` initials.

---

## Phase 2: Medium

- [ ] **10. Make Edit Student save everything**
  Current problems in the `editForm` submit handler:
  - Writes `registrationClass`, but the form edits `class`, so changes are lost.
  - Never saves `subjectsSummary`, so added/removed subjects aren't persisted.
  - Doesn't recompute `fullName` or `searchTokens`, so search goes stale.
  - `agegroup` and `birthdate` have no form fields.
  - Teacher/line/subject dropdowns (`.edit-subject-select`, `.edit-teacher-select`, `.edit-line-input`) have no handlers, so those edits are discarded.

  Plan: use `buildDraft()`, `applyFieldChange()`, `validateDraft()` and `buildUpdatedRecord()` from `edit-form.js` (currently unused), add `change` handlers for the dropdowns/inputs, then `updateDoc` with the merged record. Show validation messages in `#editError`.

- [ ] **11. Stop the edit draft mutating live data**: `currentEditingStudent = { ...student }` is a shallow copy; removing a subject changes the roster object even after Cancel. Use `buildDraft()` (deep clone) and only copy back on a successful save.

- [ ] **12. Store `subject` inside each enrollment**: new subjects are saved as `{teacher, line}` only. That breaks `getTeachersPerSubjectMap()` (falls back to the stripped key) and the timetable's line-to-subject map. Save `{subject, teacher, line}`.

- [ ] **13. Pick one of `class` / `registrationClass`**: the code mixes them (filters use `s.class`, search checks both, bulk update changes only `registrationClass`). Decide on one canonical field, migrate existing docs if needed, and update `search.js`, `render.js`, `app.js` and bulk update together.

- [ ] **14. Make Add Student persist**: step 2 only does `roster.unshift(draft)`, so the student disappears on refresh. Required:
  - Validate admin number with `String(adminNo).padStart(5, "0")` and `/^\d{5}$/`.
  - Check for duplicates in Firestore, not only the cached roster.
  - `setDoc` with `adminNo`, `fullName`, `searchTokens`, numeric `grade`, class field, `gender`, `birthdate`, `subjectsSummary`, `enrollments`, `teams: []`, `photo`, `createdBy`, `createdAt`.
  - Call `patchCachedStudent()` and re-run the search.

- [ ] **15. Harden Bulk Update**
  - Don't mutate `roster` before the commit succeeds (build the updated copies first).
  - Show "N students will be changed" with a confirm step before writing.
  - Update `searchTokens` and the cache after commit.
  - Move `loadRoster()` inside the `try` and call `runSearch()` after it.
  - `subjectLine` ignores the "current value to match" field, so make that field optional or meaningful for that case.

- [ ] **16. Add missing modal and layout CSS**: `style.css` has no rules for `.modal-wrapper`, `.modal-backdrop`, `.modal-card-wide`, `.filter-panel*`, `.tt-*`, `.timetable-toolbar`, `.btn-group`, `.btn-close`, `.btn-outline`, `.btn-secondary`, `.btn-danger-icon`, `.form-control`. The Teams and Timetable modals will be unstyled. (Check whether these live in another stylesheet first.)

- [ ] **17. Keep Teams modal and Teams pages in sync**
  - `syncStudentTeam` copies team changes onto the student, but the drawer's "Manage Teams" saves only to `students.teams`.
  - Make the `teams` collection the source of truth and update both sides from one function.
  - After any sync, call `patchCachedStudent()` so the roster doesn't show stale teams for up to 30 minutes.
  - In `renderTeamRow`, the `<option value>` uses `t.id || t.teamName` but selection compares `teamName`; normalise to one.

---

## Phase 3: Hard

- [ ] **18. Wire up Timetables** (modal and button exist in `index.html`, nothing in `app.js`)
  - Import `timetable.js`; call `initTimetableModule()` once at startup.
  - Add a "View timetable" button to the drawer and call `openStudentTimetableModal(student)`.
  - Add a permission (e.g. `editTimetable`) to `usertypes.json`; show `#ttEditBtn` and `#openTimetableBtn` only for users with it.
  - Escape subject names in `renderGridUI`.
  - Depends on item 12 (subject stored in enrollments).

- [ ] **19. Bring Awards onto the same permission system**
  - `awards-app.js` uses custom claims (`auth-service.js`, `set-claims.js`), while the rest of the site uses `authorized_users`. A `staffGC` user has an Awards link but would be refused.
  - Add `TEAMS_COLLECTION` and `AWARDS_RECOMMENDATIONS_COLLECTION` to `config.js` (currently undefined, so `collection(db, undefined)` throws).
  - `awards-app.js` imports `getAllTeams` from `data-service.js`, which doesn't export it; add it (reading the new `ageGroups` structure).
  - `confirmRecommendation` writes `team.members`; rewrite for `teams/{activity}.ageGroups[age]`.
  - Add `viewAwards`, `recommendAwards`, `approveAwards` permissions to `usertypes.json`.
  - Review `awards.html` (not supplied).

- [ ] **20. Performance: paginate or virtualise results**: every keystroke re-renders the whole roster (1–2k rows; in grid mode, 1–2k photos). Render the first 50–100 results with a "Show more" button, or use windowed rendering.

- [ ] **21. Hall Pass System** (`markdowns/project_specification.md`, Phases 1–3): nothing is implemented yet.
  - Phase 1: overdue badges and 60-second UI refresh.
  - Phase 2: role guard (spec denies SLT; reconcile with `usertypes.json` first).
  - Phase 3: non-returns dashboard, lazy auto-sweep with `writeBatch`, "Force Return".
  - The spec references `renderStudentCard()` and `canAccessNonReturnsDashboard()`, which don't exist; define them against `usertypes.json`, not custom claims.

---

## Multi-user and cross-page improvements

Apply alongside the phases above. Suggested timing is in brackets.

1. **Enforce permissions in Firestore Rules, not just the UI** (do with B2).
   `usertypes.json` only hides buttons. Rules should require:
   - `students` read: any `authorized_users` type; write: `edit`.
   - `teams` write: `editTeams`; `authorized_users` write: `manageUsers`; template doc: `teamsAdmin`.
   - Look up the user by `request.auth.uid` or `request.auth.token.email.lower()` (docs are keyed by lowercase email in `admin_user.js`).

2. **One auth system** (with item 19). Retire custom claims (`auth-service.js`, `set-claims.js`) in favour of `authorized_users` + `usertypes.json`.

3. **Avoid last-write-wins on rosters** (after item 17). `saveTeam` overwrites a whole age group array, so two staff editing at once lose changes. Store members as a map keyed by `adminNo` and write with `updateDoc` field paths (or use `arrayUnion`/`arrayRemove`). Do the same for `enrollments` edits (`enrollments.<key>.teacher`).

4. **Fresher data for multiple users.** The roster cache lasts 30 minutes. Add a visible Refresh button and "last loaded" time first; later consider `onSnapshot` on `teams` or a small "last changed" document that triggers a re-fetch.

5. **Audit trail.** Add `updatedBy` and `updatedAt` to every student/team write; consider an `audit-log` collection for bulk updates and team changes.

6. **Cascade cleanup.** Deleting or renaming an activity or age group in `admin.html` doesn't update `students.teams`. Add a batched update in `structure.js`.

7. **Consistent navigation and guards.** Add one shared `requirePermission(name)` helper in `usertypes.js`, use it on every page, show a clear "no access" message instead of a silent redirect, and share one header. Handle the `loadUserTypes` failure path in `app.js` (currently returns without telling the user).

8. **Auth race guard.** Add the sequence-counter pattern from `auth-service.js` to `onAuthStateChanged` in `app.js` so rapid sign-in/out can't apply a stale user type.

9. **Move the Word template out of Firestore.** `_template_config` stores base64 (1 MB document limit) and a copy in `localStorage`. Use Firebase Storage.

10. **Protect cached student data.** Roster data (names, birthdates) sits in `sessionStorage`. Clear it on sign-out (already done), on user change, and consider a shorter TTL.

---

## Recommended order of work

1. B1 → B2 → B3 → B4
2. Phase 1, items 1–9
3. Phase 2: 10 → 11 → 12 → 13 → 14 → 15 → 17 → 16
4. Phase 3: 18 → 19 → 20 → 21
5. Multi-user items 1–2 early (alongside B2 and item 19); items 3–10 after Phase 2

**Tip:** items 10–15 all depend on the single class field (13) and `subject` in enrollments (12), so do those two first within Phase 2.
