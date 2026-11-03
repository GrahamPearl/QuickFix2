# Roster index — integration steps

New/changed files: `js/roster-index.js` (new), `js/data-service.js`, `js/settings-service.js`, `js/dashboard.js`,
`index.html`, `firebase.rules`. Add to `config.js` (optional, these are the defaults): `ROSTER_INDEX_COLLECTION: "rosterIndex"`.

## A. app.js — fix these first (the page will not load / Add Student still fails)

1. **Two `loadRoster` functions exist** (one near `applyRoster`, one after `onAuthStateChanged`). Duplicate top-level
   declarations are a SyntaxError in a module, so app.js currently fails to load. Delete the second one
   (`async function loadRoster({ forceRefresh = false } = {}) { … }`).
2. **Missing imports**: `runTransaction, serverTimestamp` (firebase-init.js); `addCachedStudent, patchCachedStudents`
   (data-service.js); `validateDraft` (edit-form.js); `indexApply` (roster-index.js).
3. **Add Student step 2**: `runTransaction(...)` is not awaited, so the success path runs before the save and errors are lost.
   Use `await runTransaction(...)`, then `await indexApply({ upserts: [rec] }).catch(warnIndex)` before `roster.unshift(rec)`.
4. **`addNewSubjectBtn` handler**: `newStudentDraft.enrollments[subKey] = …` runs before `subKey` is declared (ReferenceError).
   Replace the whole block with:
   ```js
   if (e.target.id === "addNewSubjectBtn") {
     const select = document.getElementById("newSubjectSelect");
     const sub = select.value;
     if (sub && !newStudentDraft.subjectsSummary.includes(sub)) {
       const subKey = sub.toLowerCase().replace(/[^a-z0-9]/g, "");
       newStudentDraft.subjectsSummary.push(sub);
       newStudentDraft.enrollments ||= {};
       newStudentDraft.enrollments[subKey] = { subject: sub, teacher: "", line: "" };
       document.getElementById("newSubjectsList").innerHTML =
         newStudentDraft.subjectsSummary.map((s) => `<span class="chip">${esc(s)}</span>`).join("");
       select.value = "";
     }
   }
   ```
   (import `escapeHtml as esc` from `./html.js`.)
5. **"Clear all" still re-reads everything** (`clearRosterCache()` then `loadRoster`). Make it only reset the filters and call `runSearch()`.

## B. Keep the index in step with writes (all no-ops until the first rebuild)

`const warnIndex = (e) => { console.warn("index", e); alert("Saved, but the search index could not be updated. Ask an admin to rebuild the roster index."); };`

| Where | After the Firestore write succeeds |
|---|---|
| app.js Edit Student submit | `await indexApply({ upserts: [currentEditingStudent] }).catch(warnIndex)` |
| app.js Manage Teams submit | `await indexApply({ patches: [{ adminNo: String(currentTeamsStudentAdminNo), fields: { teams: updatedTeams } }] }).catch(warnIndex)` |
| app.js Add Student | see A3 |
| app.js Bulk Update | collect each changed `student` in an array `touched`; after the commit loop: `patchCachedStudents(touched); await indexApply({ upserts: touched }).catch(warnIndex);` and **delete** the trailing `await loadRoster(...)` |
| allocate-app.js `confirmAllocation` | after `patchCachedStudents(...)`: `await indexApply({ upserts: [...done.values()] }).catch(console.warn)` |
| hhs-teams/js/firestore.js `syncStudentTeam` | `const next = role ? [...rest, { teamName, ageGroup, role }] : rest; await updateDoc(sref, { teams: next }); queueIndexPatch(adminNo, { teams: next });` (import `queueIndexPatch` from `../../js/roster-index.js`) |
| admin_import.js after the commit loop | `const next = new Map(S.existing); dels.forEach((id) => next.delete(id)); ops.forEach((o) => next.set(o.id, o.merge ? { ...(next.get(o.id) \|\| {}), ...o.data } : { ...o.data })); await rebuildIndexFrom([...next].map(([id, d]) => ({ id, ...d })), { user: S.user });` (import from `./roster-index.js`; costs no extra reads) |

## C. Roll-out order

1. Deploy `firebase.rules` (check the type names match your `authorized_users` values).
2. Deploy the code. Until an index exists everything behaves as before (full read fallback).
3. Dashboard (Admin/Head Staff) → **Rebuild roster index** (one full read, ~6 writes). Users switch on their next search.
4. Rebuild again after any change made outside the app (console edits, scripts) and as a periodic safety net (weekly).
5. With the index live, loads are cheap, so you may lower `minIntervalHours` in `setting/roster` (e.g. 1) so edits reach other users sooner.

Cost: a user reload = 1 (setting) + about 5 (chunks) + 1 (rules lookup) reads instead of ~2,000.
