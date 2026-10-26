# HHS Student Roster — Teams & Awards Extension (v2)

*Revised 25 Oct 2026 against the current repo. v1 was written before the `hhs-teams/` integration and before the two-stage awards workflow existed; large parts of it are now superseded. Items marked **[verify]** could not be confirmed from the files supplied.*

---

## 1. Where the project actually stands

| Area | v1 plan assumed | Repo today |
|---|---|---|
| Teams storage | New `teams/{teamId}` with flat `members[]` | **Already live:** `teams/{docId(activity)}` = `{ id, teamName, ageGroups: { "<age>": [{ adminNo, role }] }, updatedAt }` (`hhs-teams/js/firestore.js`) |
| Student ↔ team link | New `teamsSummary` + `teamMemberships` on student | **Already live:** `students/{adminNo}.teams = [{ teamName, ageGroup, role }]`, kept in step by `syncStudentTeam()` |
| Team search | To be built | **Built:** `#filterTeam`, `#filterAgeGroup`, `state.team/ageGroup` in `search.js`, filter chips, drawer "Teams & Activities" table |
| Team editing UI | To be built | **Built, two paths:** `hhs-teams/teams.html` + `admin.html`, and the drawer "Manage Teams" modal |
| Awards storage | New `teamMembers/{teamId}_{adminNo}` join docs | **Different design built:** `awards-recommendations` collection (pending → confirmed/rejected) + `students.awards[]` ledger + `students.teamMemberships` counts (`awards-service.js`) |
| Awards workflow | Direct grant/revoke | **Two-stage:** recommend (admin/approver) → approve/decline (approver only) |
| Awards auth | Custom claims | `awards-app.js` uses custom claims (`auth-service.js`, `set-claims.js`); rest of site uses `authorized_users` + `usertypes.json` |
| Student edit service | `student-edit-service.js`, `auditLog`, transactions | **[verify]** Not in supplied files. `app.js` edits via plain `updateDoc`; `edit-form.js` is unused. No audit log seen |
| Migration console | `migrate-*.js` | **[verify]** Not supplied |
| Paths | `public/js/...` | Files supplied at `js/...` **[verify deploy root]** |

**Conclusion:** the original must-have list (config, search filter, drawer section, filter wiring) is mostly done. The remaining work is (a) reconciling two competing data models, (b) fixing defects that stop Awards loading at all, (c) making membership and award writes consistent, and (d) one permission system.

---

## 2. Defects blocking Awards / Teams (found in code review)

| # | File | Problem | Fix |
|---|---|---|---|
| 1 | `js/render.js` `renderTeamRow` | Stray line `r.toLowerCase() === selectedRole.toLowerCase();` throws `ReferenceError: r is not defined`; also `roles = window.APP_CONFIG.TEAM_ROLES` is undefined. **Manage Teams modal cannot open.** | Delete the stray line; define `TEAM_ROLES` in `js/config.js`; compare roles case-insensitively (`"Member"` vs `"member"`); the computed `groups` is unused — decide whether the hard-coded list or real age groups drive the dropdown |
| 2 | `js/config.js` | `TEAM_ROLES`, `TEAMS_COLLECTION`, `AWARDS_RECOMMENDATIONS_COLLECTION` missing → `collection(db, undefined)` throws in `awards-service.js`; `hhs-teams/js/config.js` sets `ROLES: window.APP_CONFIG.TEAM_ROLES` (undefined) so `roster-view.js` `CONFIG.ROLES.map` crashes | Add the keys once in `js/config.js`; point `hhs-teams` `ROLES` at its own `TEAM_ROLES` or the shared one — one list only |
| 3 | `js/awards-app.js` | `import … from ".js/html.js"` (bad path); `escapeHtml` imported twice, and `render-awards.js` does not export it → module fails to load | Single `import { escapeHtml } from "./html.js"`; remove it from the `render-awards.js` import list |
| 4 | `js/data-service.js` | `getAllTeams()` imported by `awards-app.js` but not exported | Add (see §5) |
| 5 | `js/awards-service.js` / `render-awards.js` | Expect team fields `name`, `category`, `season`, `members`, `teamId`; live docs have `teamName`, `ageGroups`. `tx.update(teamRef, { members: arrayUnion(...) })` would add a stray `members` field to live docs | Adapt to live shape (§4); stop writing `members` |
| 6 | `json/usertypes.json` | `viewTeams` missing for `staff-head`, `staff-office`, `staff`, `slt` → redirected from Teams; `admin` lacks `editTeams`/`teamsAdmin` → cannot open `hhs-teams/admin.html`; no awards permissions; Awards link shown to `staff-gc`/`staff-office` but page gates on claims | Add permissions per §6 |
| 7 | `app.js` Manage Teams submit | Writes only `students.teams`; the `teams` collection is not updated → drift. `syncStudentTeam` is non-transactional and swallows errors | Single transactional membership writer (§5) |
| 8 | Roster cache | 30-min `sessionStorage` cache; award/team changes only patch the acting user's cache | Visible "Refresh / last loaded" control; patch cache after every write |

Verify after fixes: `improvements-plan` items B1 (store.js stray code), B3 (admin.html config script) and B4 (`teams_app.js`) appear already resolved in the supplied files — tick them off.

---

## 3. Decisions needed before coding (decision log)

| ID | Question | Recommendation |
|---|---|---|
| **D1** | Which data model wins: v1 (`teamMembers`, `teamsSummary`, `teams.members`) or what is live? | **Live model.** Keep `teams/{activity}.ageGroups` as membership source of truth and `students.teams[]` as its derived copy. Drop `teamMembers`, `teamsSummary`, `teams.members` |
| **D2** | Where do awards live? | `students.awards[]` ledger (as `awards-service.js` already does) + `awards-recommendations` as workflow/audit record. Derive per-team counts **client-side** at load instead of storing `teamMemberships` counts — one fewer copy to drift |
| **D3** | Must a student be a team member to receive an award? | **Yes.** Validate membership (team + age group) at recommend *and* confirm time; never auto-add members as a side effect of approval |
| **D4** | Are awards per team (activity) or per team + age group? | Record `teamId`, `teamName` **and `ageGroup`**; display both; filter by team (age group optional) |
| **D5** | Can an award be revoked? | Yes, by approver only, as a status change (`revoked`, reason, who/when) on the ledger entry and recommendation — never delete history. Counts exclude revoked entries |
| **D6** | One auth system? | `authorized_users` + `usertypes.json`; retire custom claims for Awards (`auth-service.js`, `set-claims.js`) |
| **D7** | Is there an `auditLog` / transactional student edit service? | **[verify]** If not, awards ledger + recommendations are the audit trail for awards; add `updatedBy/updatedAt` on team writes |

---

## 4. Revised data model

```jsonc
// teams/{docId(activity)} — UNCHANGED (live)
{ "id": "Netball", "teamName": "Netball",
  "ageGroups": { "U16": [{ "adminNo": "15623", "role": "Captain" }] },
  "updatedAt": "2026-…" }

// students/{adminNo} — existing fields plus:
{
  "teams":  [{ "teamName": "Netball", "ageGroup": "U16", "role": "Captain" }],   // derived from teams docs
  "awards": [{                                                                  // ledger, append-only
    "recommendationId": "…", "teamId": "Netball", "teamName": "Netball",
    "ageGroup": "U16", "level": "merits|halfColours|fullColours",
    "note": "", "issuedDate": "2026-11-20", "confirmedBy": "a@school",
    "status": "active|revoked"                                                  // new (D5)
  }]
}

// awards-recommendations/{auto} — as built, plus ageGroup
{ "adminNo", "studentName", "teamId", "teamName", "ageGroup", "awardLevel", "note",
  "status": "pending|confirmed|rejected|revoked",
  "recommendedBy/Email/At", "confirmedBy/Email/At", "issuedDate", "rejectedReason" }
```

Team-centric award list = query `awards-recommendations` where `teamName == X` and `status == confirmed` (no join collection needed). Student-centric view = `student.awards`.

**Revised consistency rules** (replace v1's three-place rule):
1. Membership change → `teams/{activity}` **and** `students/{adminNo}.teams` in one `runTransaction`. Replaces `syncStudentTeam`.
2. Award confirm / revoke → `students/{adminNo}.awards` **and** `awards-recommendations/{id}` in one transaction; `teams` doc is read-only (membership check).
3. Never write a whole student record with `setDoc` from a draft (`buildUpdatedRecord` spreads the original and would overwrite concurrent awards/teams) — use `updateDoc` with an explicit field list.

---

## 5. Files — revised change list

**New**
| File | Purpose |
|---|---|
| `js/team-edit-service.js` | `addMember`, `removeMember`, `setRole` as transactions over `teams/{activity}` + `students/{adminNo}`; returns the patched student for `patchCachedStudent()`. Used by both `hhs-teams` pages and the drawer modal |
| `js/team-form.js` | Pure helpers (draft, validation, role list) — only if the drawer modal keeps its draft state; otherwise skip |
| `scripts/backfill-teams.js` (or admin-only page) | One-off **drift report** (teams docs vs `students.teams`) with optional repair; run on staging first |

**Edit**
| File | Change |
|---|---|
| `js/config.js` | Add `TEAM_ROLES`, `TEAMS_COLLECTION`, `AWARDS_RECOMMENDATIONS_COLLECTION` |
| `json/usertypes.json` | Add `viewTeams/editTeams/teamsAdmin` per type; add `viewAwards`, `recommendAwards`, `approveAwards` |
| `js/usertypes.js` | Add shared `requirePermission(name)` guard used by every page |
| `js/data-service.js` | Add `getAllTeams({forceRefresh})` (same cache pattern, key `hhs_teams_cache_v1`, reading the live `ageGroups` shape, skipping `_`-prefixed docs and hidden activities); add `collectAwardCounts(student)` |
| `js/awards-service.js` | Adapt to live team shape; add `ageGroup`; membership validation; remove `members` write; add `revokeAward`; read permission from usertypes, not claims |
| `js/awards-form.js`, `js/render-awards.js` | Team options from `teamName`; add age group select; show age group on cards |
| `js/awards-app.js` | Fix imports (defect 3); swap claims gate for `can(cfg, type, …)`; refresh `getAllTeams` after confirm |
| `js/search.js` | Add `award` (level) filter using `s.awards` (active entries); keep `team`/`ageGroup` |
| `js/render.js` | Fix defect 1; drawer "Awards" section (counts by level + ledger rows); `renderActiveFilters` label for `award` |
| `js/app.js` | Route drawer "Manage Teams" save through `team-edit-service.js`; wire `#filterAward`; refresh control |
| `index.html` | `#filterAward` select in the filter panel |
| `hhs-teams/js/store.js`, `firestore.js`, `config.js` | Use `team-edit-service.js` instead of `syncStudentTeam`; one role list |
| `awards.html` | **[verify]** not supplied — review against new payload and permissions |

**Dropped from v1:** `TEAM_MEMBERS_COLLECTION`, `teamMembers` docs, `teamsSummary`, `teamMemberships`, migration-console teams import (re-evaluate only if a bulk teams file is needed; `hhs-teams` already has JSON/Excel import-export).

---

## 6. Permissions (proposed)

| Type | viewTeams | editTeams | teamsAdmin | viewAwards | recommendAwards | approveAwards |
|---|---|---|---|---|---|---|
| admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| staff-head | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ **[confirm]** |
| staff-gc | ✔ | ✔ | – | ✔ | ✔ | – |
| staff-office | ✔ | – | – | ✔ | – | – |
| staff, slt | ✔ | – | – | ✔ **[confirm]** | – | – |

The role matrix in `set-claims.js` (teacherStaff, awardsApprover, etc.) does not map onto `usertypes.json`; the business owner must confirm who approves awards. This is the single biggest open policy question.

**Firestore Rules (not supplied — must be reviewed, not just UI-gated):** `teams` write → `editTeams`; template doc → `teamsAdmin`; `awards-recommendations` create → `recommendAwards`, update (status) → `approveAwards`; `students.awards` writable only by approvers. Rules look up `authorized_users` by uid or lower-cased email. Rules also need to permit the specific fields touched in each transaction.

---

## 7. Gaps in the original plan (what to improve in how this is planned)

1. **No baseline check** — v1 listed files that don't exist here and missed files that do. Start each phase with a 30-minute "verify the plan against the repo" step.
2. **No decision log** — data-model choices (D1–D7) were implicit. Resolve and record them first.
3. **No source-of-truth statement** for membership; now explicit (`teams` docs).
4. **Identity strategy undefined** — v1 used slugs (`u16-netball-a`); live uses activity doc IDs with age group inside. Fixed in D4.
5. **No migration/backfill step** for existing `students.teams` vs `teams` data.
6. **No permissions design** or Firestore Rules work item.
7. **No staging/rollback plan** for a live system used daily by staff.
8. **No acceptance criteria or test checklist** (added below).
9. **Awards edge cases missing:** duplicates (allowed, per `awards-service.js`), revocation, award year/season, concurrent approvals (transaction guards pending status).
10. **Stale cache and multi-user conflicts** not addressed.
11. **No estimates or calendar** (added in §9).
12. **Single-session scope was unrealistic**; split into four weekly increments, each independently deployable.

---

## 8. Acceptance criteria & test checklist

- Manage Teams modal opens, saves, and both `teams/{activity}` and `students/{adminNo}.teams` change (or neither does on failure).
- Adding/removing a member from `teams.html` shows in the student drawer after refresh; drift report shows 0 mismatches.
- Recommend → Approve → drawer shows the award; recommendation shows confirmed; second approve click fails cleanly ("already confirmed").
- Recommending for a non-member is rejected with a clear message.
- Decline requires a reason; revoke removes the award from counts but keeps history.
- Each user type sees only the links/actions its permissions allow; direct URL access without permission shows a "no access" message and Rules reject the write.
- Award filter + team filter combine correctly; filter chips and badge count update.
- Smoke test on a staging Firebase project before every production deploy; keep the previous deploy ready to roll back.

---

## 9. Schedule — November 2026

*Assumptions: about four working sessions of ~2 hours per week; one developer; staging Firebase project available (create in Week 1 if not); each week ends with a deployable state. Adjust around Term 4 exams and staff peak periods — avoid deploying on exam-day mornings.*

### Week 1 · Mon 2 – Fri 6 Nov — Verify, decide, unblock
| Day | Task | Size |
|---|---|---|
| Mon 2 | Resolve D1–D7; answer **[verify]** items (deploy root, `student-edit-service.js`, `auditLog`, rules, `awards.html`) | S |
| Tue 3 | Defects 1–3: `config.js` keys, `renderTeamRow`, `awards-app.js` imports, `hhs-teams` roles | S |
| Wed 4 | `usertypes.json` permissions + `requirePermission()`; confirm approver policy | M |
| Thu 5 | Stand up/refresh staging Firebase; draft Firestore Rules changes | M |
| Fri 6 | Smoke test on staging; deploy defect fixes to production | S |

### Week 2 · Mon 9 – Fri 13 Nov — Membership data layer
| Day | Task | Size |
|---|---|---|
| Mon 9 | `getAllTeams()` + `collectAwardCounts()` in `data-service.js` | S |
| Tue 10 | `team-edit-service.js` (transactional add/remove/setRole) | L |
| Wed 11 | Rewire drawer modal and `hhs-teams` store to the service; remove `syncStudentTeam` | M |
| Thu 12 | Drift report/backfill script; run on staging, then review production report | M |
| Fri 13 | Tests per §8 (membership items); deploy | S |

### Week 3 · Mon 16 – Fri 20 Nov — Awards workflow
| Day | Task | Size |
|---|---|---|
| Mon 16 | Adapt `awards-service.js` + `awards-form.js` to live team shape, add `ageGroup` and membership validation | L |
| Tue 17 | Replace claims gate with `usertypes`; update `render-awards.js`; review `awards.html` | M |
| Wed 18 | `revokeAward` + status handling; Rules for `awards-recommendations` / `students.awards` | M |
| Thu 19 | End-to-end test on staging (recommend → approve → decline → revoke, concurrent approve) | M |
| Fri 20 | Fix findings; deploy to production behind approver-only access | S |

### Week 4 · Mon 23 – Fri 27 Nov — Search, display, release
| Day | Task | Size |
|---|---|---|
| Mon 23 | `search.js` award filter; `index.html` `#filterAward`; `app.js` wiring; filter chip label | M |
| Tue 24 | Drawer "Awards" section in `render.js`; refresh/last-loaded control | M |
| Wed 25 | Full regression per §8 on staging | M |
| Thu 26 | Production deploy; monitor reads/errors | S |
| Fri 27 | Update this document, README and `HHS-Improvements-Plan.md` (tick completed items) | S |

**Mon 30 Nov:** buffer for slippage/hotfixes. Anything unfinished moves to December.

### Deferred (not in November)
Awards-level reporting/export, bulk teams import via a migration console, a dedicated "edit whole team roster" admin view, pagination of results (Improvements Plan #20), Hall Pass system (#21), moving the Word template to Firebase Storage.

### Principal risks
| Risk | Mitigation |
|---|---|
| Approver policy unresolved | Decide in Week 1; ship Awards approver-only until confirmed |
| Existing `students.teams` and `teams` docs already disagree | Drift report before enabling transactional writes |
| Rules not reviewed (unsupplied) | Share rules in Week 1; test with staging users of each type |
| Live use during exams | Small, reversible weekly deploys; roll back via previous hosting release |

---

## 10. Key invariant (replaces v1)

Membership truth is `teams/{activity}.ageGroups`; `students.teams` is its derived copy and must change in the **same transaction**. Awards truth is `students.awards` + `awards-recommendations`, written together, and an award can only exist for a current member. No code path may write a whole student document from a stale draft.
