# HHS Student Lookup: Improvements Plan (v2)

*Re-verified against the repo files on 25 Oct 2026. The site is live and used daily by staff, so test every change on a staging Firebase project (or a copy) before deploying.*

**How to read this document**

| Marker | Meaning |
|---|---|
| ✅ | Done: confirmed in the files supplied (tick it off, no work needed) |
| 🟡 | Partly done: remaining work is stated on the item |
| ⬜ | Not started |
| 🆕 | New in v2 (found during this review) |

**Effort:** **S** = under 1 h · **M** = 1–4 h · **L** = 4–10 h · **XL** = more than 10 h (estimates for one developer who knows the code).
**IDs:** Blockers are `B#`, phase items are `1–21`, multi-user items are `M1–M10` (they were previously numbered 1–10 and clashed with the phase items). Related plan: `teams-and-awards-plan.md` (items 17 and 19 overlap with it; see "Shared work" below).

**Files reviewed:** `index.html`, `admin_users.html`, `js/*` (app, render, search, data-service, usertypes, admin_user, timetable, awards modules, auth-service, set-claims), `json/usertypes.json`, `css/*`, `hhs-teams/*`.
**Not reviewed (not supplied):** Firestore Security Rules, `awards.html`, `sample_teams.json`, the deployed Hosting config. Anything that depends on these is marked **[verify]**.

---

## 1. Status snapshot

| Item | Status | Note |
|---|---|---|
| B1 stray code in `store.js` | ✅ | Sync calls now sit inside `addMember`, `removeMember`, `setRole`, `bulkAdd` |
| B2 user type lookup | 🟡 | Case-insensitive lookup is in. **Permissions still missing** (see B2 below) |
| B3 `hhs-teams/admin.html` | ✅ | `config.js` script present; compat tags gone |
| B4 delete `teams_app.js` | ✅ **[verify]** | Not among supplied files; confirm it is gone from the repo and Hosting |
| B5 Manage Teams modal crash | 🆕 ⬜ | Blocker (below) |
| B6 Awards page cannot load | 🆕 ⬜ | Blocker (below) |
| 1 `cards.css` semicolon | ✅ | |
| 2 drawer from grid view | ✅ | `#resultsGrid` click listener exists |
| 3 active filter chips | ✅ | |
| 4 dead code in `app.js` | 🟡 | `authPopover` / `authToggleBtn` still in `els` |
| 5 other dead code | 🟡 | `renderUserManagementModal` gone; `js/to-update.js` still present and unused |
| 6 duplicate "Grade 9" | ✅ | But the list is now hard-coded and ignores real age groups (see 17) |
| 7 `STUDENTS_COLLECTION` | 🟡 | Done in `data-service.js`; `"students"` / `"teams"` still hard-coded in `app.js` and `hhs-teams/js/firestore.js` |
| 8 one role list | ⬜ | Worse than before: `TEAM_ROLES` is undefined (B5) |
| 9 escape rendered text | ⬜ | Use `js/html.js` (not `render-awards.js`, which does not export it) |
| 10–15 | ⬜ | Unchanged |
| 16 modal/layout CSS | ⬜ | `.modal-wrapper`, `.modal-backdrop`, `.filter-panel`, `.tt-*` etc. still undefined in `style.css` |
| 17–21 | ⬜ | Unchanged |
| M1–M10 | ⬜ | M10 partly done (cache cleared on sign-out) |

---

## 2. Where the common work is (do related items together)

Items that touch the same files or share a prerequisite should be scheduled in one block; doing them separately means re-reading and re-testing the same code.

| Cluster | Items | Shared code | Why together |
|---|---|---|---|
| **A. Config and wiring fixes** | B5, B6, 4, 5, 7, 8 | `js/config.js`, `render.js`, `awards-app.js`, `hhs-teams/js/config.js` | Mostly one-line fixes; one config pass defines `TEAM_ROLES`, `TEAMS_COLLECTION`, `AWARDS_RECOMMENDATIONS_COLLECTION` |
| **B. Permissions** | B2 (rest), M1, M2, M7, 19 (permissions part), 18 (permission) | `json/usertypes.json`, `js/usertypes.js`, Firestore Rules | One edit of the permission matrix and one `requirePermission()` helper serves Teams, Awards and Timetables |
| **C. Student record model** | 13 → 10 → 11 → 12 → 14 → 15 | `app.js` edit/add/bulk handlers, `render.js` edit form, `edit-form.js`, `search.js` | All depend on one canonical class field (13) and `subject` inside enrollments (12); `edit-form.js` already holds the pure helpers |
| **D. Teams and awards data sync** | 17, M3, M5, M6, 19 (data part) | `hhs-teams/js/firestore.js`, `store.js`, `structure.js`, `awards-service.js` | One transactional membership writer (`team-edit-service.js`) fixes drift, last-write-wins and awards membership checks |
| **E. Rendering safety and styling** | 9, 16 | `render.js`, `render-awards.js`, `timetable.js`, `style.css` | Mechanical, repo-wide; do before adding more UI |
| **F. Freshness and session safety** | M4, M8, M10 | `app.js`, `data-service.js` | Small, independent, low risk |
| **G. New features** | 18, 20, 21 | `timetable.js`, `app.js`, new files | Build on the clusters above; defer |

---

## 3. Cost ranking: lowest cost first

| Rank | Item | Effort | Why it is cheap / what it unblocks |
|---|---|---|---|
| 1 | **B5** delete the stray line `r.toLowerCase() === selectedRole.toLowerCase();` in `renderTeamRow`; define `TEAM_ROLES` | S | Restores the Manage Teams modal |
| 2 | **B6** fix `awards-app.js` imports (`".js/html.js"` → `"./html.js"`; one `escapeHtml` import) | S | Awards page loads again |
| 3 | **B2** (rest): permission flags in `usertypes.json` | S | JSON-only; unblocks Teams for most users |
| 4 | **N1** stopgap: set `addStudent: false` in `usertypes.json` until item 14 ships | S | Stops silent data loss (new students vanish on refresh) |
| 5 | **1–7 leftovers**: remove `authPopover`/`authToggleBtn`, delete `to-update.js` (after a repo-wide search), swap remaining `"students"`/`"teams"` literals for config | S | Housekeeping |
| 6 | **8** one role list | S–M | Follows from B5; used by `renderTeamRow`, `roster-view.js`, `syncStudentTeam` |
| 7 | **M8** auth race guard (copy the sequence counter from `auth-service.js`) | S | Pattern already exists |
| 8 | **M10** shorter roster cache TTL | S | One config value |
| 9 | **M4** Refresh button and "last loaded" time | S–M | `clearRosterCache` + `loadRoster` already exist |
| 10 | **M7** `requirePermission()` helper | M | Then reuse on every page |
| 11 | **9** escape rendered text | M | Mechanical; security value (names and subjects go into `innerHTML`) |
| 12 | **16** missing modal/layout CSS | M | Needed before the Teams and Timetable modals look right |
| 13 | **11 + 12** deep-clone draft; store `subject` in enrollments | M | Small, but 12 needs a backfill script for existing docs |
| 14 | **13** canonical class field | M | Small code change, but needs a data decision and migration |
| 15 | **10** Edit Student saves everything | M–L | Uses ready-made `edit-form.js` helpers |
| 16 | **14** Add Student persists | M | Needs 12 and 13 first |
| 17 | **20** paginate results | M | "Show more" button is simplest |
| 18 | **15** harden Bulk Update | M | After 13 |
| 19 | **17** team sync via one service | L | Shared with the awards plan |
| 20 | **19** Awards on one permission system | L | Needs B6, B2, 17 |
| 21 | **18** Timetables | M–L | Needs 12 and a permission |
| 22 | **21** Hall Pass system | XL | Defer; spec needs reconciling first |

---

## 4. Suggested order of work

1. **Stop the bleeding (cluster A + stopgap):** B5 → B6 → B2 (rest) → N1.
2. **One permission pass (cluster B):** M7 helper, awards and timetable permissions in the same `usertypes.json` edit.
3. **Safe housekeeping:** items 4, 5, 7, 8, then 9 and 16.
4. **Student record integrity (cluster C):** 13 → 11 → 12 (with backfill) → 10 → 14 → 15.
5. **Teams sync and Awards (cluster D):** 17 → 19 (see `teams-and-awards-plan.md`).
6. **Small safety wins at any point:** M4, M8, M10.
7. **Later:** 18 → 20 → 21, and M3, M5, M6, M9.

---

## 5. November 2026 schedule

*Assumptions: about 8–10 working hours a week; one developer; a staging Firebase project (set up in Week 1 if it does not exist). Deploy on Thursday after a staging smoke test; Friday is for fixes and notes. Avoid deploying on exam mornings.*

### Week 1 · 2–6 Nov: Unblock and quick wins (≈8 h)
- Tick off ✅ items; decide the canonical class field (13) and awards approver policy.
- B5, B6, item 8, config keys (`TEAM_ROLES`, `TEAMS_COLLECTION`, `AWARDS_RECOMMENDATIONS_COLLECTION`).
- B2 permissions + N1 stopgap + `requirePermission()` (M7); add `viewAwards`, `recommendAwards`, `approveAwards`, `editTimetable` flags now so later weeks do not re-edit the matrix.
- Items 4, 5, 7 leftovers; start item 9 (escaping) in `render.js`.
- Staging project; deploy Thursday.

### Week 2 · 9–13 Nov: Student record integrity (≈9–10 h)
- 13 (class field + migration dry-run) → 11 → 12 (+ enrollment backfill) → 10 (Edit Student saves all fields, recomputes `fullName` and `searchTokens`).
- Finish item 9 if not done. Deploy Thursday.

### Week 3 · 16–20 Nov: Teams sync (≈9 h)
- Item 16 CSS first (so the modal can be tested), then item 17 (`team-edit-service.js`, transactional membership, cache patching, role/age group dropdown fix).
- M8 auth race guard, M4 refresh button. Deploy Thursday.

### Week 4 · 23–27 Nov: Awards and release (≈9–10 h)
- Item 19 core: `getAllTeams`, adapt `awards-service.js`, permissions instead of claims, approve flow tested on staging.
- Regression pass; update this file and the README. Deploy Thursday; **Mon 30 Nov** is buffer.

### Stretch / December
14 Add Student persistence (until then N1 hides it), 15 Bulk Update, 18 Timetables, 20 pagination, awards filter and drawer section, M3, M5, M6, M9, 21 Hall Pass.

**Capacity warning:** the core items above total roughly 36–40 h. If hours fall short, drop (in this order) item 9's second half, M4, then the awards approve-flow polish; do not drop B5, B6, B2, 13, 10 or 17, because they fix live breakage or silent data loss.

### Shared work with `teams-and-awards-plan.md`
That plan's Week 2 (membership layer) and Week 3 (awards) map to items 17 and 19 here; this calendar is the combined view. Its award filter and drawer section are stretch items.

---

## Phase 0: Blockers

- [x] **B1. Stray code in `hhs-teams/js/store.js`** ✅ Fixed.
- [ ] **B2. User types and permissions** 🟡
  - ✅ `resolveUserType()` is case-insensitive and finds the key whatever its casing. **Correction:** the keys in `usertypes.json` are hyphenated (`staff-head`, `staff-gc`, `staff-office`), not camelCase as v1 stated.
  - ⬜ `boot.js` requires `viewTeams`, `editTeams`, `teamsAdmin`. Currently only `admin` and `staff-gc` define `viewTeams`, and no type defines `teamsAdmin` as true, so `admin` cannot open `hhs-teams/admin.html` and `staff`, `slt`, `staff-office`, `staff-head` are bounced from Teams. Set:

  | Type | `viewTeams` | `editTeams` | `teamsAdmin` |
  |---|---|---|---|
  | `admin`, `staff-head` | true | true | true |
  | `staff-gc` | true | true | false |
  | `staff-office`, `staff`, `slt` | true | false | false |

  Done when: each type can open exactly the pages its table row allows.
- [x] **B3. `hhs-teams/admin.html`** ✅ Fixed.
- [x] **B4. Delete `js/teams_app.js`** ✅ **[verify]** it is gone from the repo and the deployed site.
- [ ] **B5. 🆕 Manage Teams modal crashes** (S)
  - `renderTeamRow` in `render.js` contains a stray expression `r.toLowerCase() === selectedRole.toLowerCase();` that throws `ReferenceError: r is not defined`. Delete it.
  - `window.APP_CONFIG.TEAM_ROLES` is not defined in `js/config.js`, so `roles.map` also fails; `hhs-teams/js/config.js` sets `ROLES: window.APP_CONFIG.TEAM_ROLES` (undefined), so `roster-view.js` fails too. Define one list in `js/config.js` and use it in both places.
  - Compare roles case-insensitively: stored roles are `"Member"`, the dropdown default is `"member"`.
  - Done when: the drawer's Manage Teams modal opens, and `teams.html` role dropdowns render.
- [ ] **B6. 🆕 Awards page cannot load** (S)
  - `awards-app.js` imports from `".js/html.js"` (bad path) and imports `escapeHtml` twice, including from `render-awards.js`, which does not export it. Use one `import { escapeHtml } from "./html.js"`.
  - `awards-service.js` reads `TEAMS_COLLECTION` and `AWARDS_RECOMMENDATIONS_COLLECTION`, which are undefined in `config.js` (see cluster A).
  - Done when: the module loads without console errors on staging.

---

## Phase 1: Easy

- [x] **1. `cards.css` avatar rule** ✅
- [x] **2. Open the drawer from grid view** ✅
- [x] **3. Active filter chips** ✅
- [ ] **4. Remove remaining dead code in `app.js`** 🟡 (S): `authPopover`, `authToggleBtn` in `els`.
- [ ] **5. Remove other dead code** 🟡 (S): delete `js/to-update.js` after a repo-wide search shows nothing imports it; remove `edit-form.js` exports only if item 10 will not use them (it will; keep them).
- [x] **6. Duplicate "Grade 9"** ✅ (the age group list is now hard-coded and ignores a team's real age groups; fixed under item 17).
- [ ] **7. Use collection names from config** 🟡 (S): `data-service.js` is done; replace `"students"` in `app.js` and `hhs-teams/js/firestore.js`, and `"teams"` in `app.js`, with `STUDENTS_COLLECTION` / `TEAMS_COLLECTION`.
- [ ] **8. One role list** ⬜ (S–M): single `TEAM_ROLES` in `js/config.js`; `renderTeamRow`, `roster-view.js`, `syncStudentTeam` and the Teams pages all read it.
- [ ] **9. Escape all rendered text** ⬜ (M): `render.js` inserts names, subjects, teachers into `innerHTML` and `value="..."` unescaped (including the inline `onerror` initials). Import `escapeHtml` from `js/html.js`. Also escape in `timetable.js` `renderGridUI`. Done when: a student named `<b>x"` displays literally in list, card, drawer and edit form.

---

## Phase 2: Medium

Do in this order: **13 → 11 → 12 → 10 → 14 → 15**, then 17 and 16 as scheduled above.

- [ ] **13. Pick one of `class` / `registrationClass`** ⬜ (M, needs a data decision first)
  Current mix: filters use `s.class`, search checks both, `edit-form.js` edits `class`, Edit Student writes `registrationClass`, bulk update changes only `registrationClass`.
  Steps: decide the canonical field (recommended: `registrationClass`, because Firestore docs already hold it); dry-run a migration that copies the other field and reports mismatches; update `search.js`, `render.js`, `edit-form.js`, `app.js`, `collectClasses`.
  Done when: editing a class in the drawer changes the filter list, search and the saved doc consistently.
- [ ] **11. Stop the edit draft mutating live data** ⬜ (S–M): replace `{ ...student }` with `buildDraft()` (deep clone); copy back only after a successful save.
- [ ] **12. Store `subject` inside each enrollment** ⬜ (M): save `{ subject, teacher, line }`. Include a one-off backfill for existing docs (derive `subject` from `subjectsSummary` by `subjectKey`). Required by timetables (18).
- [ ] **10. Make Edit Student save everything** ⬜ (M–L)
  - Problems today: writes `registrationClass` but the form edits `class`; never saves `subjectsSummary`; does not recompute `fullName` / `searchTokens`; `agegroup` and `birthdate` have no form fields; the subject/teacher/line dropdowns have no handlers.
  - Plan: `buildDraft()` → `applyFieldChange()` → `validateDraft()` → `buildUpdatedRecord()`, add `change` handlers for the dropdowns, show messages in `#editError`.
  - **Caution (new):** `buildUpdatedRecord()` spreads the whole original document. Save with `updateDoc` and an explicit field list, not `setDoc`, so a concurrent award or team change is not overwritten.
- [ ] **14. Make Add Student persist** ⬜ (M)
  - **Stopgap now (N1):** set `addStudent: false` in `usertypes.json`. Today step 2 only does `roster.unshift(draft)`, so the student disappears on refresh.
  - Validate admin number (`String(adminNo).padStart(5, "0")`, `/^\d{5}$/`); check duplicates in Firestore, not only the cache; `setDoc` with `adminNo`, `fullName`, `searchTokens`, numeric `grade`, class field, `gender`, `birthdate`, `subjectsSummary`, `enrollments` (with `subject`), `teams: []`, `photo`, `createdBy`, `createdAt`; then `patchCachedStudent()` and re-run the search.
- [ ] **15. Harden Bulk Update** ⬜ (M)
  - Build updated copies first; mutate `roster` only after commit succeeds.
  - Show "N students will be changed" and require confirmation.
  - Update `searchTokens` and the cache after commit; move `loadRoster()` inside the `try` and call `runSearch()` after it.
  - `subjectLine` ignores "current value to match": make the field optional or meaningful.
- [ ] **16. Add missing modal and layout CSS** ⬜ (M): `style.css` has no rules for `.modal-wrapper`, `.modal-backdrop`, `.modal-card-wide`, `.filter-panel*`, `.tt-*`, `.timetable-toolbar`, `.btn-group`, `.btn-close`, `.btn-outline`, `.btn-secondary`, `.btn-danger-icon`, `.form-control`. First check whether any other stylesheet defines them. Note `style.css` has `.modal` / `.modal-card` rules but the markup uses `.modal-wrapper`.
- [ ] **17. One writer for team membership** ⬜ (L). Overlaps `teams-and-awards-plan.md`.
  - `syncStudentTeam` copies team changes onto the student, but the drawer's Manage Teams saves only `students.teams`. Make `teams/{activity}.ageGroups` the source of truth and update both sides in one transaction from one function (`team-edit-service.js`).
  - Call `patchCachedStudent()` after every write.
  - `renderTeamRow`: option `value` uses `t.id || t.teamName` while selection compares `teamName`; normalise. Build the age group dropdown from the team's real age groups (it currently shows a hard-coded list and computes `groups` without using it).

---

## Phase 3: Hard

- [ ] **18. Wire up Timetables** ⬜ (M–L): import `timetable.js`, call `initTimetableModule()` once, add a "View timetable" drawer button calling `openStudentTimetableModal(student)`, add `editTimetable` permission and show `#ttEditBtn` / `#openTimetableBtn` only with it, escape subject names. Depends on 12.
- [ ] **19. Awards on one permission system** ⬜ (L). Overlaps `teams-and-awards-plan.md`.
  - Sub-tasks: B6 and the config keys first; add `getAllTeams` to `data-service.js` (live `ageGroups` shape); rewrite `confirmRecommendation` for the live team shape and stop writing `team.members`; add `viewAwards`, `recommendAwards`, `approveAwards`; replace the claims gate in `awards-app.js` with `can(cfg, type, …)`; review `awards.html` **[verify]**.
  - Policy question to settle first: who may approve awards.
- [ ] **20. Paginate results** ⬜ (M): render the first 50–100 with a "Show more" button; every keystroke currently re-renders 1–2k rows (and 1–2k photos in grid mode).
- [ ] **21. Hall Pass System** ⬜ (XL, backlog) per `markdowns/project_specification.md`. The spec references `renderStudentCard()` and `canAccessNonReturnsDashboard()`, which do not exist; define them against `usertypes.json`, not custom claims, and reconcile the spec's "deny SLT" rule with the permission matrix first.

---

## Multi-user and cross-page improvements (M1–M10)

- [ ] **M1. Enforce permissions in Firestore Rules, not only the UI** (L, **[verify]** current rules). `students` read: any `authorized_users` type; write: `edit`. `teams` write: `editTeams`; `authorized_users` write: `manageUsers`; template doc: `teamsAdmin`; awards collections per the awards plan. Look up the user by `request.auth.uid` or lower-cased `request.auth.token.email` (docs are keyed by lowercase email in `admin_user.js`).
- [ ] **M2. One auth system** (with 19): retire custom claims (`auth-service.js`, `set-claims.js`) in favour of `authorized_users` + `usertypes.json`.
- [ ] **M3. Avoid last-write-wins on rosters** (M–L, after 17): `saveTeam` overwrites a whole age group array. Use a transaction, or a members map written with field paths. Do the same for `enrollments` edits.
- [ ] **M4. Fresher data** (S–M): visible Refresh button and "last loaded" time first; consider `onSnapshot` on a small "last changed" doc later.
- [ ] **M5. Audit trail** (S–M): add `updatedBy` / `updatedAt` to every student/team write as each write path is touched; an `audit-log` collection for bulk updates and team changes later.
- [ ] **M6. Cascade cleanup** (M): deleting or renaming an activity or age group in `admin.html` does not update `students.teams`; add a batched update in `structure.js`.
- [ ] **M7. Consistent guards** (M): shared `requirePermission(name)` in `usertypes.js`, a clear "no access" message instead of a silent redirect, one shared header. The `loadUserTypes` failure path in `app.js` now shows an error; check it renders in the login gate.
- [ ] **M8. Auth race guard** (S): sequence counter from `auth-service.js` in the `onAuthStateChanged` handler in `app.js`.
- [ ] **M9. Move the Word template out of Firestore** (M): `_template_config` stores base64 (1 MB document limit) plus a `localStorage` copy; use Firebase Storage.
- [ ] **M10. Protect cached student data** 🟡 (S): cache is cleared on sign-out; also clear on user change and shorten the TTL (`CACHE_TTL_MS`).

---

## Notes on this revision

- Statuses were checked against the supplied code; anything marked **[verify]** needs a look in the repo or Firebase console.
- Items are now sized, ranked, and grouped; each item should have a "done when" line (added where the outcome was unclear; add the rest as you pick them up).
- Multi-user items were renumbered `M1–M10` to remove the clash with Phase items 1–10.
- Corrections to v1: user type keys are hyphenated; `escapeHtml` lives in `js/html.js`.
