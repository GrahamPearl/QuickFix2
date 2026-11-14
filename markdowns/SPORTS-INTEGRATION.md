# Sports results: integration steps

New files (copy as-is): `sports.html`, `css/sports.css`, `js/sports-form.js`, `js/sports-service.js`, `js/sports-app.js`.

## Data model

| Collection | Document | Purpose |
|---|---|---|
| `sports-results` | `{id}` | One match: `teamName`, `ageGroup`, `opponent`, `home`, `venue`, `dayKey`, `season`, `status` (scheduled / live / final), `ourScore`, `theirScore`, `result` (W/L/D), `breakdown`, `notes`, `topPlayers[{adminNo,name,label}]`, audit stamps. Source of truth |
| `sports-live` | `{id}` (same id as the match) | Score and period while a match is in play. Score taps write only here. Deleted on finalise |
| `sports-summary` | `{season}` | One digest per season: `items: { "<id>": "<JSON slim result>" }`. Written in the same transaction as every final result, so it cannot drift |
| `sports-config` | `lists` | `{ opponents: [] }` shared opponent names |

`teamName` + `ageGroup` use the same names as `teams/{activity}.ageGroups`, so results line up with team lists and awards.

## 1. `json/usertypes.json`
Add `"viewResults": true` to **every** type. Add `"captureResults": true` to `admin`, `staff-head`, `staff-gc`, `staff`. Add `"manageResults": true` to `admin` and `staff-head` (correct or delete a finished result).

## 2. `js/pages.js` (inside `PAGES`)
```js
{ group: "Students", label: "Sports results", href: "sports.html", perm: "viewResults", desc: "Live scores, fixtures and results by team." },
```

## 3. `js/config.js` (optional, these are the defaults)
```js
SPORTS_RESULTS_COLLECTION: "sports-results",
SPORTS_LIVE_COLLECTION: "sports-live",
SPORTS_SUMMARY_COLLECTION: "sports-summary",
SPORTS_CONFIG_COLLECTION: "sports-config",
```

## 4. Firestore rules (`firebase.rules` and `firestore_rules.md`)
Add the helper with the other helpers, and the match blocks with the other collections.

```
function canCaptureResults() { return typeIn(['admin','staff-head','staff-gc','staff']); }

match /sports-results/{id} {
  allow read: if canRead();
  allow create: if canCaptureResults()
    && request.resource.data.status == 'scheduled'
    && request.resource.data.dayKey.matches('[0-9]{4}-[0-9]{2}-[0-9]{2}')
    && request.resource.data.teamName is string
    && request.resource.data.opponent is string
    && request.resource.data.opponent.size() > 0 && request.resource.data.opponent.size() <= 60
    && request.resource.data.home is bool
    && request.resource.data.ourScore == 0 && request.resource.data.theirScore == 0
    && request.resource.data.createdBy == request.auth.uid;
  // a finished result can only be corrected by admin / head staff
  allow update: if canCaptureResults()
    && (resource.data.status != 'final' || isAdminOrHead())
    && request.resource.data.status in ['scheduled','live','final']
    && request.resource.data.ourScore is int && request.resource.data.ourScore >= 0 && request.resource.data.ourScore <= 999
    && request.resource.data.theirScore is int && request.resource.data.theirScore >= 0 && request.resource.data.theirScore <= 999
    && (request.resource.data.status != 'final' || request.resource.data.result in ['W','L','D'])
    && request.resource.data.get('breakdown','').size() <= 300
    && request.resource.data.get('notes','').size() <= 300
    && request.resource.data.get('topPlayers', []).size() <= 3;
  allow delete: if isAdminOrHead() || (canCaptureResults() && resource.data.status == 'scheduled');
}

match /sports-live/{id} {
  allow read: if canRead();
  allow create, update: if canCaptureResults()
    && request.resource.data.ourScore is int && request.resource.data.ourScore >= 0 && request.resource.data.ourScore <= 999
    && request.resource.data.theirScore is int && request.resource.data.theirScore >= 0 && request.resource.data.theirScore <= 999
    && request.resource.data.get('period','').size() <= 40;
  allow delete: if canCaptureResults();
}

match /sports-summary/{season} {
  allow read: if canRead();
  allow create, update: if canCaptureResults() && request.resource.data.season is int;
  allow delete: if isAdminOrHead();
}

match /sports-config/{id} {
  allow read: if canRead();
  allow create: if canCaptureResults() && request.resource.data.keys().hasOnly(['opponents']);
  allow update: if canCaptureResults() && onlyChanges(['opponents']);
}
```

Also extend the existing `audit-log` create rule so capturers who cannot edit students can write sports entries:

```
allow create: if (canEditStudents()
                  || (canRecommendAwards() && request.resource.data.action.matches('award[.].*'))
                  || (canCaptureResults() && request.resource.data.action.matches('sports[.].*')))
                 && request.resource.data.by == request.auth.uid;
```

## 5. Index (one, created on first use)
`sports-results`: `status` ASC + `dayKey` ASC (for the upcoming-fixtures query). Firestore prints a one-click link in the browser console the first time the Fixtures tab loads.

## 6. Deploy order
1. Rules, then `usertypes.json` and `pages.js`, then the code. Test on staging first.
2. Create the index from the console link.
3. Nothing to seed: the first fixture creates its season digest and the first opponent creates `sports-config/lists`.

## Read cost

| Action | Reads | Writes |
|---|---|---|
| Open Results tab (current season) | 1, then cached 10 min (past seasons 24 h) | 0 |
| Filter, team records, weekly grouping, Excel export | 0 (all from the cached digest) | 0 |
| Open Fixtures tab | 0 to 100 (only unfinished matches), cached 5 min | 0 |
| Watch live scores | 1 per changed live document; listener detaches when the tab is hidden | 0 |
| Score tap | 0 | 1 |
| Finish a match | 1 | 4 (match, live delete, digest, audit) |

A season digest holds roughly 300 bytes per match, so about 3,000 matches fit under the 1 MiB document limit. The Results tab warns at 700 KB.

## Test checklist
- Create a fixture, go live, tap Try +5 and Conversion +2 for rugby, tap the opponent, undo, and finish: `sports-live` is deleted, the match is `final`, the digest has the item, one audit entry exists.
- Two phones scoring the same live match: both taps count (increment), neither overwrites.
- A viewer-only type (`slt`, `staff-office`) sees live scores and results, sees no capture buttons, and the rules reject their writes.
- A capturer who is not admin or head staff cannot correct a final result (the rules reject it); admin and head staff can, and the digest and cached list update.
- Finishing the same match from two devices: the second shows "already finalised" and reloads.
- Results tab: filter by team and age group, then Export Excel; the tally and the file agree.
- Cancel a scheduled fixture (capturer) works; delete a final result needs admin or head staff.

## Notes
- Cricket uses runs for the score; put wickets and overs in the breakdown text. Swimming is captured as a gala total (our points v theirs); per-race times are a later phase.
- The lineup of who played is not stored (top players only). `students.teams` already lists team members if you add it later.
- Before deploying `firebase.rules`, check the behaviour block near the end: the comment line before `allow update` swallows the rule on one line, and the file ends with an extra closing brace. `firestore_rules.md` has a stray `unction` there too.
