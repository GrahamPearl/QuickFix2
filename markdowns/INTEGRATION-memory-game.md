# Memory game: integration steps

New files (copy as-is): `memory-game.html`, `css/memory-game.css`, `js/memory-game.js`, `js/memory-game-form.js`, `js/memory-game-service.js`.

## 1. `json/usertypes.json`
Add to **every** type's `permissions` (everyone may play):
```json
"playMemoryGame": true
```
Add to `admin` and `staff-head` only (settings and reset):
```json
"manageMemoryGame": true
```

## 2. `js/pages.js` (inside `PAGES`)
```js
{ group: "Students", label: "Memory game", href: "memory-game.html", perm: "playMemoryGame", desc: "Match learner photos to names. Weekly leaderboard." },
```

## 3. `js/config.js`
```js
MEMORY_GAME_COLLECTION: "memory-game-seasons",
```

## 4. Firestore rules (`firebase.rules` and `firestore_rules.md`)
`setting/{id}` already lets admin and staff-head write, so settings and reset need no new rule. Add the helper next to the other helpers and the match block next to the other collections:

```
function memoryGameSeason() {
  return exists(/databases/$(database)/documents/setting/memoryGame)
    ? string(get(/databases/$(database)/documents/setting/memoryGame).data.get('season', 1))
    : '1';
}

match /memory-game-seasons/{season}/scores/{uid} {
  allow read: if canRead();
  allow create, update: if canRead()
    && uid == request.auth.uid
    && season == memoryGameSeason()
    && request.resource.data.keys().hasOnly(['uid','email','name','bestScore','bestTimeMs','bestCorrect',
         'rounds','games','totalPlayMs','sortKey','updatedAt'])
    && request.resource.data.uid == request.auth.uid
    && request.resource.data.email == myEmail()
    && request.resource.data.bestScore is int && request.resource.data.bestScore >= 0 && request.resource.data.bestScore <= 10000
    && request.resource.data.bestTimeMs is int && request.resource.data.bestTimeMs >= 0 && request.resource.data.bestTimeMs <= 3600000
    && request.resource.data.bestCorrect is int && request.resource.data.rounds is int
    && request.resource.data.games is int && request.resource.data.games >= 1
    && request.resource.data.totalPlayMs is int && request.resource.data.sortKey is int
    && request.resource.data.updatedAt == request.time
    && (resource == null || request.resource.data.bestScore >= resource.data.bestScore);
  allow delete: if isAdminOrHead();
}
```
The `memorygame.reset` audit entry is already allowed (admin and staff-head can create audit-log entries).

## 5. Deploy order
1. Rules, then `usertypes.json`, then the code. Test on staging first.
2. First visit: the session document does not exist yet, so the game runs as Session 1. A manager saving settings or pressing "Start a new session" creates `setting/memoryGame`.

## Test checklist
- Ranked game saves one document at `memory-game-seasons/{season}/scores/{uid}`; a lower second game does not lower the best.
- Same score in less time replaces the best time; a slower tie does not.
- A non-manager sees no settings panel and no reset button; the rules reject their write to `setting/memoryGame`.
- Reset: new session starts empty; the old session is still viewable in the Session selector (managers).
- Break one photo filename on a test student: that student is never asked.
- Switch tabs mid-round: the timer pauses.

## Notes
- Scores are client-calculated, so this is "for fun" integrity: the rules cap values and stop a best score from going down, but cannot prove a game was played.
- Separate from this feature: `js/render.js` declares `photoUrl` twice, which is a SyntaxError in a module and stops `app.js` loading. The game does not import `render.js`, but search.html will stay broken until one copy is removed.
