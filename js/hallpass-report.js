/**
 * hallpass-report.js — pure functions: history rows in, HTML table strings out.
 * Rows are the slim objects from hallpass-service.fetchWeek().
 */
import { escapeHtml as esc } from "./html.js";
import { OVERDUE_MIN, reasonLabel, dateOfKey, addDays, avatar } from "./hallpass-service.js";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const FLAG_WEEK = 5; // passes in one week that highlight a learner
const FLAG_4WK = 8; // passes in four weeks that highlight a learner
const fmt = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : "–");
const dayIdx = (key, monday) => Math.round((dateOfKey(key) - monday) / 86400000);

function table(heads, rows) {
  const body = rows.join("") || `<tr><td colspan="${heads.length}" class="empty-hint">No passes recorded for this period.</td></tr>`;
  return `<div class="hp-scroll"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const cell = (v, cls = "") => `<td class="${cls}">${esc(v)}</td>`;
const who = (name, photo) => `<td class="hp-who">${avatar(name, photo)}<span>${esc(name)}</span></td>`;
const num = (v, hot) => `<td class="num${hot ? " hp-hot" : ""}${v === 0 ? " hp-zero" : ""}">${esc(v)}</td>`;

/* ---------- one week ---------- */
export function renderWeekly(rows, monday) {
  const by = new Map();
  rows.forEach((r) => {
    const i = dayIdx(r.day, monday);
    if (i < 0 || i > 4) return;
    const s = by.get(r.adminNo) || { adm: r.adminNo, name: r.name, photo: r.photo, cls: r.cls, days: [0, 0, 0, 0, 0], total: 0, mins: [], longest: 0, over: 0, auto: 0 };
    s.days[i]++; s.total++;
    if (r.auto) s.auto++;
    if (typeof r.min === "number") { s.mins.push(r.min); s.longest = Math.max(s.longest, r.min); if (r.min >= OVERDUE_MIN) s.over++; }
    by.set(r.adminNo, s);
  });
  const list = [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const perDay = [0, 0, 0, 0, 0];
  list.forEach((s) => s.days.forEach((n, i) => (perDay[i] += n)));
  const reasons = {};
  rows.forEach((r) => (reasons[r.reason] = (reasons[r.reason] || 0) + 1));

  const head = `<p class="empty-hint">Week of ${esc(fmt(monday))} – ${esc(fmt(addDays(monday, 4)))} · ${rows.length} passes · ${list.length} learners · highlighted = ${FLAG_WEEK}+ passes or any pass of ${OVERDUE_MIN}+ min</p>`;
  const main = table(
    ["Learner", "Class", ...DAYS, "Total", "Avg min", "Longest", `${OVERDUE_MIN}+ min`, "Auto-closed"],
    list.map((s) => `<tr class="hp-click" data-adm="${esc(s.adm)}" title="Open passes">${who(s.name, s.photo)}${cell(s.cls)}${s.days.map((n) => num(n)).join("")}
      ${num(s.total, s.total >= FLAG_WEEK)}${num(avg(s.mins))}${num(s.longest || "–")}${num(s.over, s.over > 0)}${num(s.auto, s.auto > 0)}</tr>`)
      .concat(list.length ? [`<tr class="hp-total"><td colspan="2">All learners</td>${perDay.map((n) => num(n)).join("")}${num(rows.length)}<td colspan="4"></td></tr>`] : []),
  );
  const why = table(["Reason", "Passes"], Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr>${cell(reasonLabel(k))}${num(n)}</tr>`));
  return head + main + `<h3 class="pool-title">By reason</h3>` + why;
}

/* ---------- four weeks (oldest → newest) ---------- */
export function renderTrend(weeks, mondays) {
  const wk = mondays.map((m) => `Wk ${fmt(m)}`);
  const by = new Map();
  weeks.forEach((rows, w) => rows.forEach((r) => {
    const s = by.get(r.adminNo) || { adm: r.adminNo, name: r.name, photo: r.photo, cls: r.cls, c: [0, 0, 0, 0], total: 0, over: 0 };
    s.c[w]++; s.total++;
    if (typeof r.min === "number" && r.min >= OVERDUE_MIN) s.over++;
    by.set(r.adminNo, s);
  }));
  const list = [...by.values()].map((s) => {
    const prior = (s.c[0] + s.c[1] + s.c[2]) / 3;
    return { ...s, delta: Math.round((s.c[3] - prior) * 10) / 10 };
  }).sort((a, b) => b.total - a.total || b.delta - a.delta);

  const arrow = (d) => (d >= 1 ? `▲ +${d}` : d <= -1 ? `▼ ${d}` : "▬");
  const learners = table(
    ["Learner", "Class", ...wk, "Total", "Latest vs prior 3 wks", `${OVERDUE_MIN}+ min`],
    list.map((s) => `<tr class="hp-click" data-adm="${esc(s.adm)}" title="Open passes">${who(s.name, s.photo)}${cell(s.cls)}${s.c.map((n) => num(n, n >= FLAG_WEEK)).join("")}
      ${num(s.total, s.total >= FLAG_4WK)}<td class="num${s.delta >= 2 ? " hp-hot" : ""}">${esc(arrow(s.delta))}</td>${num(s.over, s.over > 0)}</tr>`),
  );

  // weekday × week: spots "every Monday" patterns
  const grid = weeks.map((rows, w) => {
    const d = [0, 0, 0, 0, 0];
    rows.forEach((r) => { const i = dayIdx(r.day, mondays[w]); if (i >= 0 && i <= 4) d[i]++; });
    return `<tr>${cell(wk[w])}${d.map((n) => num(n)).join("")}${num(d.reduce((a, b) => a + b, 0))}</tr>`;
  });
  const days = table(["Week", ...DAYS, "Total"], grid);

  // reason × week
  const keys = [...new Set(weeks.flat().map((r) => r.reason))];
  const reasons = table(["Reason", ...wk, "Total"], keys.map((k) => {
    const c = weeks.map((rows) => rows.filter((r) => r.reason === k).length);
    return `<tr>${cell(reasonLabel(k))}${c.map((n) => num(n)).join("")}${num(c.reduce((a, b) => a + b, 0))}</tr>`;
  }));

  return `<p class="empty-hint">Four weeks ending ${esc(fmt(addDays(mondays[3], 4)))} · highlighted = ${FLAG_WEEK}+ in a week, ${FLAG_4WK}+ in total, or rising by 2+</p>`
    + learners + `<h3 class="pool-title">Passes by weekday</h3>` + days + `<h3 class="pool-title">Passes by reason</h3>` + reasons;
}

/* ---------- one learner's passes (opened from a row) ---------- */
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–");
const dayLabel = (key) => dateOfKey(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

export function renderLearnerLog(rows) {
  const list = [...rows].sort((a, b) => (b.t || 0) - (a.t || 0));
  return table(
    ["Date", "Out", "Back", "Mins", "Signed out by", "Reason", "Outcome"],
    list.map((r) => {
      const outcome = r.auto ? "Auto-closed (never signed back in)"
        : r.forced ? `Force-returned by ${r.by || "reviewer"}`
        : "Returned";
      const over = typeof r.min === "number" && r.min >= OVERDUE_MIN;
      return `<tr>${cell(dayLabel(r.day))}${cell(clock(r.t))}${cell(r.auto ? "–" : clock(r.back))}
        ${num(typeof r.min === "number" ? r.min : "–", over)}${cell(r.teacher || "–")}
        <td>${esc(reasonLabel(r.reason))}${r.note ? ` <span class="empty-hint">· ${esc(r.note)}</span>` : ""}</td>
        <td class="${r.auto || r.forced ? "hp-warn" : ""}">${esc(outcome)}</td></tr>`;
    }),
  );
}
