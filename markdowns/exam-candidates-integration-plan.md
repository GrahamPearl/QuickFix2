# Exam Candidates Integration Plan: concession students and external candidates (Grade 12 Trials / Finals)

*Reviewed: the two uploaded legacy tools (`index.html` = "Grade 12 Exam Seating Plan Generator", `external-capture.html` = "External Candidate Capture") against the current site (roster snapshot, `student-write-service.js`, `seating-lsu.js`, `usertypes.json`, `firebase.rules`). No code has been changed. Items marked **[verify]** could not be confirmed from the files supplied.*

---

## 1. What the legacy tools do

| Tool | Data source | Behaviour worth keeping |
|---|---|---|
| `index.html` (seating generator) | Static `students.json`, `external.json`, `subjects.json` (`{subject: [adminNo]}`) | Grade 12 only; subject filter; concession filter (all / only / none); tick candidates; **internal candidates fill whole S-snake columns, external candidates always start at the top of a new column**; amber "EXT" marker on screen and in exports; unassigned pool with manual placement; PNG export (5 columns per picture or one image); JSON save / load; class register (printable, signature column); save to Firebase |
| `external-capture.html` | `list_of_subjects.txt`, `external.json` | Capture exam number, "Surname, Firstname" and subjects; bulk paste ("ExamNo, Full Name"); remove; **download a merged `external.json` and upload it to the server by hand** |

### Defects and risks found
1. **Privacy:** `students.json` / `external.json` are plain static files. Anyone with the URL can read names and concession flags without signing in. Remove them from hosting once migrated.
2. **Manual file hand-off:** externals only exist in a downloaded `external.json`; two people capturing at once overwrite each other, and there is no audit trail.
3. **Concession cannot be set on externals:** capture always writes `Concession: "False"`, yet the seating tool filters on it. No edit either (remove and re-add only).
4. **Name display bug:** `index.html` `candNameLine` prints `"JOHN SMITH, "` (trailing comma) when first name is empty, which is the case for every bulk-pasted external. It appears on seats, pool chips and the class register.
5. **Subject mismatch:** external subjects come from `list_of_subjects.txt`, internal subjects from `subjects.json`; the filter is an exact string match, so a spelling difference silently drops a candidate.
6. **Firebase:** placeholder config, a second SDK copy (compat 10.12.2), no sign-in, and it writes to `seatingPlans`, which `seating-teacher.js` already uses with a different document shape. Under the current rules unauthenticated writes fail.
7. **Selection resets** to "everyone ticked" on every filter change.
8. Exam number falls back to `adminNo` for internals when missing, with no warning.

---

## 2. Gap analysis against the current site

| Need | Current site | Gap |
|---|---|---|
| Concession flag | `students/{adminNo}.flags.concession` exists (default `false` on new students and imports) **[verify the path matches your 'concession': true]** | Not in the compact roster (`toCompact` in `snapshot-service.js` keeps only listed fields), so no page can filter or show it from the cache. No UI to mark or unmark it |
| Exam numbers | `academic.candidateNo` / `academic.examNo` exist but default to `null`; not in the compact roster | Probably unpopulated; no import path; not available to pages |
| Subject lists | Roster has `subjectsSummary` and `enrollments` | Replaces `subjects.json`; Grade 12 subject filter can come from `collectSubjects()` |
| External candidates | None | New collection and capture page needed |
| Separate concession venue | `seating-lsu.html` does "selected learners, separate venue" with S-snake, blocked desks, save / load, PNG, print | No concession filter, no externals, no subject filter, no class register, no "externals start a new column" rule |
| Permissions | `usertypes.json`, `firebase.rules` | New flags and rules needed (section 4) |
| Audit | `student-write-service.js` writes audit-log per batch | Concession changes will be audited automatically if saved through `saveStudents()` |

---

## 3. Proposed design

### 3.1 Concession flag (internal students)
- Keep `students/{adminNo}.flags.concession` as the single source of truth (you already store it there).
- Add to `toCompact` (snapshot) a top-level `concession: true` **only when true** (negligible size) and, for Grade 12, `examNo` / `candidateNo`. Update `fromCompact` accordingly. One snapshot **republish** (admin button, about 1,500 reads, out of hours) is needed after deploy. Until then pages see no flags.
- Marking UI, two entry points, both saving through `saveStudents()` (field path `flags.concession`, snapshot written in the same batch, audit action `student.concession`):
  1. **Drawer:** a "Concession" toggle in Edit Student for users with `markConcession`.
  2. **Exam candidates page (new):** Grade 12 list with exam number, class, subjects and a concession tick box, plus filters and bulk tick (up to 450 per batch). Reads come from the cached roster, so no extra reads.
- Roster badge and the existing "concession" search filter later (separate item).

### 3.2 External candidates
- **New collection `external-candidates/{examNo}`** (recommended) holding `examNo`, `firstName`, `lastName`, `grade: 12`, `subjects[]`, `concession` (bool), `session` / `year` **[Q5]**, `createdBy/At`, `updatedBy/At`.
- Not stored in `students/*`: externals have 13-digit exam numbers, no admin number or class, and would otherwise leak into search, hall passes, seating by class, the snapshot and the 5-digit rules.
- **Capture page (replaces `external-capture.html`):** same fields plus a concession tick, edit in place, delete, bulk paste, subjects picked from the roster's Grade 12 subject names (no `list_of_subjects.txt`). Writes go straight to Firestore (one document per candidate, audit entry per batch). One-off import of the existing `external.json`.
- Loading cost: one read per external (dozens), cached in `sessionStorage` for a few minutes.

### 3.3 Exam seating page (new `seating-exam.html` / `js/seating-exam.js`)
- Built from the `seating-lsu.js` engine (S-snake, blocked desks, click-to-move, save / load venue, PNG, print) plus the legacy features that matter:
  - Grade 12 only; subject filter (from roster subjects); concession filter (all / only / none)
  - internal and external lists with ticking, **external block starts on a new column**, amber "EXT" marker in exports
  - class register (signable list) and plan JSON export
- Venues saved to a **new collection** `exam-venues` (not `seatingPlans`). A venue carries `session` (e.g. "Trials 2026"), `subject`, `concessionVenue` (bool), seated list as `{type: "internal"|"external", id}`.
- Fix legacy defects 4, 5, 7 in the port.

### 3.4 Permissions (proposed; `usertypes.json`)
| Flag | Purpose | Default types |
|---|---|---|
| `viewExamCandidates` | Open the candidate / seating pages, see concession flags | admin, staff-head, staff-gc |
| `markConcession` | Set / clear `flags.concession` | admin, staff-head, staff-gc |
| `manageExternal` | Create / edit / delete external candidates | admin, staff-head, staff-gc |
| `examSeating` | Create and save exam venues | admin, staff-head, staff-gc |

Pages are registered in `pages.js` (group "Administration" or "Classroom").

---

## 4. Firestore rules (sketch, not final)

```
function canExam() { return typeIn(['admin','staff-head','staff-gc']); }   // keep in step with usertypes.json

match /external-candidates/{examNo} {
  allow read:   if canExam();
  allow create, update: if canExam()
    && examNo.matches('[0-9]{6,20}')
    && request.resource.data.examNo == examNo
    && request.resource.data.grade == 12
    && request.resource.data.concession is bool
    && request.resource.data.subjects is list;
  allow delete: if canExam();
}
match /exam-venues/{id} {
  allow read:  if canExam();
  allow write: if canExam();
}
```
- `students` updates for `flags.concession` are already allowed for `canEditStudents()` (admin, staff-head, staff-gc). A Firestore rule cannot hide a single field of a readable document: today **every type that can read students (including `slt`) can read `flags.concession`**. See Q2.
- Add the new collections to audit coverage via `logAudit` / `buildAudit`.
- Test with the emulator (no staging project), additive deploy, as for awards.

---

## 5. Performance
1. Concession and exam numbers ride on the existing roster snapshot: no new reads for seating or marking.
2. Marking 40 students = 1 batch, 1 snapshot chunk write (Grade 12), 1 audit write.
3. Externals: tens of reads, cached; writes per capture only.
4. Seating pages use the cached roster; saved venues are 1 document each.
5. The old `students.json` / `subjects.json` fetches disappear.

---

## 6. Open questions (answer before coding)

| ID | Question | My default |
|---|---|---|
| Q1 | Is the concession field `students/{id}.flags.concession` (a boolean)? Your message says `'concession': true` | Yes, `flags.concession` |
| Q2 | **Privacy of concession status.** Option A: keep it on the student document and in the shared roster cache (simple; visible to every staff type that can read students). Option B: a separate `concessions` collection readable only by exam staff (private, but a second source to keep in step and one extra read per page). Which? | A, with the UI showing it only to `viewExamCandidates` users |
| Q3 | What does "mark for later recording" mean: a **permanent flag** that applies to Trials and Finals, or a **per-session** list (a student may have a concession for Finals but not Trials)? Do you need a **type** (extra time, reader, scribe, separate venue)? | Permanent boolean now; per-session / type later if needed |
| Q4 | Who may mark concessions, manage externals and build exam venues? | admin, staff-head, staff-gc |
| Q5 | External candidates: separate collection (recommended), and do they belong to a session / year (a fresh list for Trials and for Finals), or one standing list? | Separate collection; a `session` field |
| Q6 | Are `academic.examNo` / `candidateNo` populated for Grade 12? Which number prints on plans and registers? How should they be loaded (Excel import)? | Print `examNo`; add an import step |
| Q7 | New `seating-exam` page (recommended) or extend `seating-lsu`? | New page reusing the LSU engine |
| Q8 | Venues: do you want named sessions ("Trials 2026 – Maths P1 – Hall A") saved, with a concession venue per session? | Yes |
| Q9 | Externals' subjects chosen from the roster's Grade 12 subject names (retire `list_of_subjects.txt` and `subjects.json`)? | Yes |
| Q10 | Please upload the current `external.json` for a one-off import, and confirm the legacy folder (with `students.json`) can be removed from hosting afterwards | Yes |

---

## 7. Work order (S < 1 h, M 1-4 h, L 4-10 h)
1. **Decisions** (Q1-Q10) and read the real `students` document shape **[verify flags and academic fields]** (S).
2. **Roster fields (M):** `toCompact` / `fromCompact` additions, `usertypes.json` flags, snapshot republish out of hours.
3. **Concession marking (M):** drawer toggle + exam candidates page (internal list, bulk tick) via `saveStudents()`.
4. **External candidates (M-L):** collection, rules + emulator tests, capture page, one-off import of `external.json`.
5. **Exam seating page (L):** port legacy features onto the LSU engine; `exam-venues`; register; external-column rule.
6. **Retire legacy (S):** remove `students.json`, `external.json`, legacy pages from hosting.
7. **Later:** concession badge and search filter in the roster, per-session concessions, reports.

## 8. Acceptance checks
- Marking a student concession (drawer or bulk) changes `flags.concession`, the snapshot entry and writes one audit entry; other users see it after their next roster refresh.
- "Concessions only" lists exactly the flagged Grade 12 students; "No concessions" excludes them.
- An external added on one device appears on another without any file transfer; delete and edit work.
- Externals always start on a new column; the EXT marker appears in PNG and print.
- Register shows `SURNAME, Firstname` with no stray comma; exam number shown; concession is not printed on the register unless you decide otherwise.
- Types without the new flags cannot open the pages or write the collections (emulator tests pass).
- Legacy static data files are no longer reachable without sign-in.
