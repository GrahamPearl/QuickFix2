/**
 * render-awards.js
 * Pure string-building render functions for awards.html. No DOM access.
 * All user-supplied text goes through escapeHtml().
 */
import { levelLabel } from "./awards-form.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  return d ? d.toLocaleDateString() : "—";
}

export function renderStudentMatches(students) {
  if (!students.length) return `<p class="empty-hint">No matching students.</p>`;
  return students
    .map(
      (s) => `
    <button type="button" class="match-row" data-admin-no="${escapeHtml(s.adminNo)}">
      <span class="match-name">${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</span>
      <span class="match-meta mono">${escapeHtml(s.adminNo)} · ${escapeHtml(s.class)}</span>
    </button>`,
    )
    .join("");
}

export function renderSelectedStudent(student) {
  if (!student) return `<span class="empty-hint">No student selected</span>`;
  return `<span class="chip">${escapeHtml(student.firstName)} ${escapeHtml(student.lastName)} ·
    <span class="mono">${escapeHtml(student.adminNo)}</span> · ${escapeHtml(student.class)}</span>`;
}

export function renderTeamOptions(teams) {
  return (
    `<option value="">Select a team…</option>` +
    teams
      .map((t) => `<option value="${escapeHtml(t.teamId)}">${escapeHtml(t.name)} (${escapeHtml(t.season || "")})</option>`)
      .join("")
  );
}

export function renderLevelOptions(levels) {
  return (
    `<option value="">Select a level…</option>` +
    levels.map((l) => `<option value="${escapeHtml(l.key)}">${escapeHtml(l.label)}</option>`).join("")
  );
}

function statusBadge(status) {
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

/** @param {{canReview:boolean, today:string}} opts */
export function renderRecommendationCard(rec, { canReview, today }) {
  const pending = rec.status === "pending";

  const review =
    pending && canReview
      ? `<div class="rec-review">
          <label>Issue date
            <input type="date" class="rec-issue-date" value="${escapeHtml(today)}" />
          </label>
          <button type="button" class="btn btn-primary" data-action="confirm">Accept</button>
          <button type="button" class="btn btn-ghost" data-action="reject">Decline</button>
        </div>`
      : "";

  let outcome = "";
  if (rec.status === "confirmed") {
    outcome = `<p class="rec-outcome">Confirmed by ${escapeHtml(rec.confirmedByEmail)} · issued ${escapeHtml(rec.issuedDate)}</p>`;
  } else if (rec.status === "rejected") {
    outcome = `<p class="rec-outcome">Declined by ${escapeHtml(rec.confirmedByEmail)}: ${escapeHtml(rec.rejectedReason)}</p>`;
  }

  return `
    <article class="rec-card" data-rec-id="${escapeHtml(rec.id)}">
      <header class="rec-head">
        <div>
          <strong>${escapeHtml(rec.studentName)}</strong>
          <span class="mono">${escapeHtml(rec.adminNo)}</span>
        </div>
        ${statusBadge(rec.status)}
      </header>
      <p class="rec-line">${escapeHtml(levelLabel(rec.awardLevel))} · ${escapeHtml(rec.teamName)}</p>
      ${rec.note ? `<p class="rec-note">${escapeHtml(rec.note)}</p>` : ""}
      <p class="rec-meta">Recommended by ${escapeHtml(rec.recommendedByEmail)} on ${escapeHtml(formatTimestamp(rec.recommendedAt))}</p>
      ${outcome}
      ${review}
    </article>`;
}

export function renderRecommendationList(recs, opts) {
  if (!recs.length) return `<p class="empty-hint">Nothing here yet.</p>`;
  return recs.map((r) => renderRecommendationCard(r, opts)).join("");
}
