/**
 * render-awards.js
 * Pure string-building render functions for awards.html. No DOM access.
 * All user-supplied text goes through escapeHtml().
 */
import { levelLabel, statusLabel } from "./awards-form.js";
import { escapeHtml } from "./html.js";

const esc = escapeHtml;

function formatTimestamp(ts) {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  return d ? d.toLocaleDateString() : "—";
}

export function renderStudentMatches(students) {
  if (!students.length) return `<p class="empty-hint">No matching students.</p>`;
  return students
    .map(
      (s) => `
    <button type="button" class="match-row" data-admin-no="${esc(s.adminNo)}">
      <span class="match-name">${esc(s.firstName)} ${esc(s.lastName)}</span>
      <span class="match-meta mono">${esc(s.adminNo)} · ${esc(s.registrationClass || s.class)}</span>
    </button>`,
    )
    .join("");
}

export function renderSelectedStudent(student) {
  if (!student) return `<span class="empty-hint">No student selected</span>`;
  return `<span class="chip">${esc(student.firstName)} ${esc(student.lastName)} ·
    <span class="mono">${esc(student.adminNo)}</span> · ${esc(student.registrationClass || student.class)}</span>`;
}

/** teams: [{ teamId, name }]. preferredNames = the student's own teams, listed first. */
export function renderTeamOptions(teams, preferredNames = []) {
  const pref = new Set(preferredNames);
  const opt = (t) => `<option value="${esc(t.teamId)}">${esc(t.name)}</option>`;
  const mine = teams.filter((t) => pref.has(t.name));
  const others = teams.filter((t) => !pref.has(t.name));
  const head = `<option value="">Select a team…</option>`;
  if (!mine.length) return head + others.map(opt).join("");
  return (
    head +
    `<optgroup label="Student's teams">${mine.map(opt).join("")}</optgroup>` +
    `<optgroup label="Other teams">${others.map(opt).join("")}</optgroup>`
  );
}

export function renderAgeGroupOptions(groups, selected = "") {
  return (
    `<option value="">Select an age group…</option>` +
    groups.map((g) => `<option value="${esc(g)}" ${g === selected ? "selected" : ""}>${esc(g)}</option>`).join("")
  );
}

export function renderLevelOptions(levels) {
  return (
    `<option value="">Select a level…</option>` +
    levels.map((l) => `<option value="${esc(l.key)}">${esc(l.label)}</option>`).join("")
  );
}

function statusBadge(status) {
  return `<span class="status-badge status-${esc(status)}">${esc(statusLabel(status))}</span>`;
}

function badges(rec) {
  const out = [];
  if (rec.nonMember) out.push(`<span class="rec-badge rec-badge-warn">Not a member</span>`);
  if (rec.reAward) out.push(`<span class="rec-badge">Re-award${rec.priorCount ? ` · ${esc(rec.priorCount)} prior` : ""}</span>`);
  if (rec.confirmedBy && rec.confirmedBy === rec.recommendedBy) out.push(`<span class="rec-badge">Self-approved</span>`);
  return out.length ? `<p class="rec-badges">${out.join("")}</p>` : "";
}

function outcome(rec) {
  switch (rec.status) {
    case "confirmed":
      return `Confirmed by ${esc(rec.confirmedByEmail)} · issued ${esc(rec.issuedDate)} · school year ${esc(rec.schoolYear)}`;
    case "rejected":
      return `Declined by ${esc(rec.confirmedByEmail)}: ${esc(rec.rejectedReason)}`;
    case "revoked":
      return `Confirmed by ${esc(rec.confirmedByEmail)} (school year ${esc(rec.schoolYear)}) · revoked by ${esc(rec.revokedByEmail)} on ${esc(formatTimestamp(rec.revokedAt))}: ${esc(rec.revokedReason)}`;
    case "withdrawn":
      return `Withdrawn by ${esc(rec.withdrawnByEmail)} on ${esc(formatTimestamp(rec.withdrawnAt))}`;
    default:
      return "";
  }
}

/** @param {{canReview:boolean, canRecommend:boolean, today:string}} opts */
export function renderRecommendationCard(rec, { canReview, canRecommend, today }) {
  const pending = rec.status === "pending";
  const where = `${esc(rec.teamName)}${rec.ageGroup ? ` · ${esc(rec.ageGroup)}` : ""}`;

  let actions = "";
  if (pending && canReview) {
    actions = `<div class="rec-review">
        <div class="rec-approve-fields">
          <label>Issue date
            <input type="date" class="rec-issue-date" value="${esc(today)}" />
          </label>
          <label>School year
            <input type="number" class="rec-school-year" min="2000" max="2100" value="${esc(today.slice(0, 4))}" />
          </label>
        </div>
        ${
          rec.nonMember
            ? `<label class="rec-check"><input type="checkbox" class="rec-nonmember-ok" />
                 I confirm this student is not a member of ${where} and should still receive the award.</label>`
            : ""
        }
        <div class="rec-buttons">
          <button type="button" class="btn btn-primary" data-action="confirm">Accept</button>
          <button type="button" class="btn btn-ghost" data-action="reject">Decline</button>
          ${canRecommend ? `<button type="button" class="btn btn-ghost" data-action="withdraw">Withdraw</button>` : ""}
        </div>
      </div>`;
  } else if (pending && canRecommend) {
    actions = `<div class="rec-review"><div class="rec-buttons">
        <button type="button" class="btn btn-ghost" data-action="withdraw">Withdraw</button></div></div>`;
  } else if (rec.status === "confirmed" && canReview) {
    actions = `<div class="rec-review"><div class="rec-buttons">
        <button type="button" class="btn btn-ghost" data-action="revoke">Revoke</button></div></div>`;
  }

  const out = outcome(rec);
  return `
    <article class="rec-card" data-rec-id="${esc(rec.id)}">
      <header class="rec-head">
        <div>
          <strong>${esc(rec.studentName)}</strong>
          <span class="mono">${esc(rec.adminNo)}</span>
          ${rec.class ? `<span class="rec-class">${esc(rec.class)}</span>` : ""}
        </div>
        ${statusBadge(rec.status)}
      </header>
      <p class="rec-line">${esc(levelLabel(rec.awardLevel))} · ${where}</p>
      ${badges(rec)}
      ${rec.note ? `<p class="rec-note">${esc(rec.note)}</p>` : ""}
      <p class="rec-meta">Recommended by ${esc(rec.recommendedByEmail)} on ${esc(formatTimestamp(rec.recommendedAt))}</p>
      ${out ? `<p class="rec-outcome">${out}</p>` : ""}
      ${actions}
    </article>`;
}

export function renderRecommendationList(recs, opts) {
  if (!recs.length) return `<p class="empty-hint">Nothing here yet.</p>`;
  return recs.map((r) => renderRecommendationCard(r, opts)).join("");
}