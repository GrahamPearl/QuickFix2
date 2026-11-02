/**
 * pages.js — single registry of sub-pages and the permission each needs
 * (permissions live in json/usertypes.json). The dashboard shows only pages
 * the user may open; each page calls guardCurrentPage() to re-check on arrival.
 * UI only: Firestore Rules must enforce the same.
 */
import { auth, onAuthStateChanged } from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can } from "./usertypes.js";

export const PAGES = [
  { group: "Students", label: "Student search", href: "search.html", perm: "view", desc: "Look up learners by name, admin number, class, subject or team." },
  { group: "Students", label: "Teams & activities", href: "hhs-teams/teams.html", perm: "viewTeams", desc: "Team lists, captains and age groups." },
  { group: "Students", label: "Awards", href: "awards.html", perm: "viewAwards", desc: "Recommend and review awards." },
  { group: "Classroom", label: "Hall passes", href: "hallpass.html", perm: "hallPass", desc: "Sign learners out and back in." },
  { group: "Classroom", label: "Grade 8–9 seating", href: "seating-class.html", perm: "view", desc: "Seating plans by registration class." },
  { group: "Classroom", label: "Grade 10–11 seating", href: "seating-teacher.html", perm: "view", desc: "Seating plans by subject and teacher." },
  { group: "Classroom", label: "LSU exam seating", href: "seating-lsu.html", perm: "view", desc: "Separate-venue exam seating." },
  { group: "Administration", label: "Allocate subjects", href: "allocate.html", perm: "bulkAllocate", desc: "Enrol whole classes in a subject." },
  { group: "Administration", label: "Import students", href: "admin_import.html", perm: "bulkImport", desc: "Update the roster from the class-list workbook." },
  { group: "Administration", label: "User access", href: "admin_users.html", perm: "manageUsers", desc: "Add staff and set their user type." },
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
