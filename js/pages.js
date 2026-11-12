/**
 * pages.js — single registry of sub-pages and the permission each needs
 * (permissions live in json/usertypes.json). The dashboard shows only pages
 * the user may open; each page calls guardCurrentPage() to re-check on arrival.
 * UI only: Firestore Rules must enforce the same.
 */
import { auth, onAuthStateChanged } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";
import "./home-link.js";

export const PAGES = [
  { group: "Students", label: "Student search", href: "search.html", perm: "view", desc: "Look up learners by name, admin number, class, subject or team." },
  { group: "Students", label: "Teams & activities", href: "hhs-teams/teams.html", perm: "viewTeams", desc: "Team lists, captains and age groups." },
  { group: "Students", label: "Awards", href: "awards.html", perm: "viewAwards", desc: "Recommend and review awards." },
  { group: "Students", label: "Memory game", href: "memory-game.html", perm: "playMemoryGame", desc: "Match learner photos to names. Weekly leaderboard." },
  { group: "Classroom", label: "Hall passes", href: "hallpass.html", perm: "hallPass", desc: "Sign learners out and back in." },
  { group: "Classroom", label: "Grade 8–9 seating", href: "seating-class.html", perm: "view", desc: "Seating plans by registration class." },
  { group: "Classroom", label: "Grade 10–11 seating", href: "seating-teacher.html", perm: "view", desc: "Seating plans by subject and teacher." },
  { group: "Classroom", label: "Custom seating", href: "seating-lsu.html", perm: "view", desc: "Custom-venue seating." },
  { group: "Classroom", label: "Finals seating", href: "seating-finals.html", perm: "examSeating", desc: "Grade 12 exam seating by subject." },
  { group: "Classroom", label: "Concessions", href: "concessions.html", perm: "markConcession", desc: "Grade 8-12 Concession students." },
  { group: "Administration", label: "Import finals candidates", href: "import-finals.html", perm: "examImport", desc: "Link admin numbers to exam numbers from Excel." },
  { group: "Administration", label: "Allocate subjects", href: "allocate.html", perm: "bulkAllocate", desc: "Enrol whole classes in a subject." },
  { group: "Administration", label: "Import students", href: "admin_import.html", perm: "bulkImport", desc: "Update the roster from the class-list workbook." },
  { group: "Administration", label: "User access", href: "admin_users.html", perm: "manageUsers", desc: "Add staff and set their user type." },
  { group: "Administration", label: "Audit & usage", href: "audit.html", perm: "viewAudit", desc: "Who changed what, read/write usage and snapshot health." },
];

export const visiblePages = (cfg, type) => PAGES.filter((p) => can(cfg, type, p.perm));

/** Call at the top of any sub-page. Resolves {user,cfg,type}, or null after redirecting to the dashboard. */
export function guardCurrentPage() {
  const page = PAGES.find((p) => location.pathname.endsWith("/" + p.href));
  const home = (location.pathname.includes("/hhs-teams/") ? "../" : "") + "index.html";
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, async (user) => {
      off();
      if (!user) { location.replace(home); return resolve(null); }
      try {
        const cfg = await loadUserTypes(), type = await resolveUserType(user, cfg);
        if (!type || (page && !can(cfg, type, page.perm))) {
          location.replace(`${home}?denied=${encodeURIComponent(page?.label || "that page")}`);
          return resolve(null);
        }
        resolve({ user, cfg, type });
      } catch { location.replace(home); resolve(null); }
    });
  });
}
