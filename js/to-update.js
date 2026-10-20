/**
 * to-update.js — loads student and team data locally from 'to-update.json'
 */

export async function getAllStudents() {
  try {
    const response = await fetch("to-update.json");
    if (!response.ok) {
      throw new Error(`Failed to load to-update.json (${response.status} ${response.statusText})`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : Object.values(data);
  } catch (err) {
    console.error("Error loading local student records from to-update.json:", err);
    throw err;
  }
}

export function collectSubjects(roster) {
  const subjects = new Set();
  roster.forEach((student) => {
    if (student.subjectsSummary && Array.isArray(student.subjectsSummary)) {
      student.subjectsSummary.forEach((sub) => subjects.add(sub));
    }
    if (student.enrollments) {
      Object.keys(student.enrollments).forEach((key) => {
        const enr = student.enrollments[key];
        if (enr && enr.subject) subjects.add(enr.subject);
      });
    }
  });
  return Array.from(subjects).sort();
}

export function collectClasses(roster, gradeFilter = "") {
  const classes = new Set();
  roster.forEach((student) => {
    if (!gradeFilter || String(student.grade) === String(gradeFilter)) {
      if (student.registrationClass) {
        classes.add(String(student.registrationClass).trim());
      }
    }
  });
  return Array.from(classes).sort();
}