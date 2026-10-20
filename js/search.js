/**
 * search.js
 * Pure functions: given the roster + current filter state, return the
 * matching subset. No DOM access here, so it's easy to reason about
 * and reuse (e.g. from a future admin export tool).
 */

import { subjectKey } from "./edit-form.js";

function normalize(str) {
  return (str || "").toString().trim().toLowerCase();
}

/**
 * @param {Array} students full roster
 * @param {Object} state { term, field, grade, class, gender, subject, teacher }
 */
export function filterStudents(students, state) {
  const term = normalize(state.term);
  const terms = term.length ? term.split(/\s+/) : [];

  return students.filter((s) => {
    if (state.grade && String(s.grade) !== String(state.grade)) return false;
    if (state.class && s.class !== state.class) return false;
    if (state.gender && s.gender !== state.gender) return false;

    if (state.subject) {
      if (!(s.subjectsSummary || []).includes(state.subject)) return false;
      if (state.teacher) {
        const enr = (s.enrollments || {})[subjectKey(state.subject)];
        if (!enr || enr.teacher !== state.teacher) return false;
      }
    }

    // --- NEW: Team & Age Group Filter ---
    if (state.team) {
      const studentTeams = s.teams || [];
      const isRegisteredInTeam = studentTeams.some((t) => {
        // Compare against teamName or team ID
        const teamMatches = t.teamName === state.team || t.id === state.team;

        // If an age group is specified, both team AND age group must match
        if (state.ageGroup) {
          return teamMatches && String(t.ageGroup) === String(state.ageGroup);
        }

        return teamMatches;
      });

      if (!isRegisteredInTeam) return false;
    }
    // -------------------------------------

    if (!terms.length) return true;

    if (state.field === "admin") {
      return normalize(s.adminNo) === term;
    }

    if (state.field === "class") {
      return (
        normalize(s.registrationClass).includes(term) ||
        normalize(s.class).includes(term)
      );
    }

    if (state.field === "name") {
      return terms.every((t) =>
        (s.searchTokens || []).some((tok) => tok.includes(t))
      );
    }

    // auto: admin exact OR every typed word matches some search token
    return (
      normalize(s.adminNo) === term ||
      terms.every((t) =>
        (s.searchTokens || []).some((tok) => tok.includes(t))
      )
    );
  });
}

/** Sort by surname then first name, for a stable, predictable list order. */
export function sortStudents(students) {
  return [...students].sort((a, b) =>
    normalize(a.lastName).localeCompare(normalize(b.lastName)) ||
    normalize(a.firstName).localeCompare(normalize(b.firstName)),
  );
}
