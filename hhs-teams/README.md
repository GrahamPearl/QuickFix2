# HHS Activity Teams (teams.html + admin.html)
Static, no build step. Serve over http(s) (ES modules). Put `students.json`, `photos/` and optionally `assets/watermark.png` beside the html files.
- js/config.js - Firebase config, paths, roles (change backend here only)
- js/firestore.js - all Firestore calls; js/store.js - state + autosave; js/structure.js - activities/age groups
- js/roster-view.js - card rendering; js/team-ui.js - shared event wiring; js/exports.js - Excel/JSON
- js/reports.js - Word/PDF merge (admin); js/teams-page.js, js/admin-page.js - page entry points
- css/theme.css - design tokens (re-skin from QuickFix2 here), layout.css, cards.css
