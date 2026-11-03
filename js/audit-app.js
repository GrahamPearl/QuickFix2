import { guardCurrentPage } from "./pages.js";
import { can } from "./usertypes.js";
import { listAudit, logAudit, dayKey } from "./audit-service.js";
import { checkSnapshot, publishSnapshot } from "./snapshot-service.js";
import { db, doc, getDoc, getDocs, collection, query, where } from "./firebase-init.js";
import { escapeHtml as esc } from "./html.js";

const $ = (id) => document.getElementById(id);
const say = (id, t, c = "") => { $(id).className = `plan-msg ${c}`; $(id).textContent = t; };
const { USAGE_COLLECTION = "usage-daily", USAGE_SUMMARY_COLLECTION = "usage-summary" } = window.APP_CONFIG;
const QUOTA = 50000;
let rows = [], last = null, cfg, type;

const g = await guardCurrentPage();
if (g) {
  ({ cfg, type } = g);
  $("gate").style.display = "none"; $("app").classList.remove("is-hidden");
  const today = dayKey(), week = dayKey(new Date(Date.now() - 6 * 864e5));
  $("aFrom").value = week; $("aTo").value = today; $("uDay").value = today;
  $("sPublish").classList.toggle("is-hidden", !can(cfg, type, "publishSnapshot"));
}

/* tabs */
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== t.dataset.tab));
}));

/* ---------- changes ---------- */
const when = (r) => (r.at?.toDate ? r.at.toDate().toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : r.day);
const opts = (id, label, vals) => { const cur = $(id).value; $(id).innerHTML = `<option value="">${label}</option>` + [...new Set(vals)].sort().map((v) => `<option>${esc(v)}</option>`).join(""); $(id).value = cur; };
const visible = () => {
  const u = $("fUser").value, a = $("fAction").value, adm = $("fAdm").value.trim();
  return rows.filter((r) => (!u || r.byEmail === u) && (!a || r.action === a) && (!adm || (r.adminNos || []).includes(adm)));
};
function renderChanges() {
  opts("fUser", "All users", rows.map((r) => r.byEmail)); opts("fAction", "All actions", rows.map((r) => r.action));
  const list = visible();
  $("aBody").innerHTML = list.map((r) => {
    const det = (r.changes || []).slice(0, 4).map((c) => `${esc(c.adminNo)} · ${esc(c.field)}: ${esc(c.from)} → ${esc(c.to)}`).join("<br>");
    const more = r.count > 1 ? `<br><span class="empty-hint">${r.count} learner(s)${r.truncated ? ", first 200 listed" : ""}${r.note ? ` · ${esc(r.note)}` : ""}</span>` : (r.note ? `<br><span class="empty-hint">${esc(r.note)}</span>` : "");
    return `<tr><td>${esc(when(r))}</td><td>${esc(r.byEmail)}</td><td>${esc(r.action)}</td><td>${esc(r.source)}</td><td class="num">${esc(r.count)}</td><td class="student-sub">${det}${more}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty-hint">No entries.</td></tr>`;
  say("aMsg", `${list.length} of ${rows.length} entries shown.`);
  renderSummary();
}
async function load(more = false) {
  say("aMsg", "Loading…", "warn");
  try {
    const res = await listAudit({ fromDay: $("aFrom").value, toDay: $("aTo").value, after: more ? last : null });
    rows = more ? [...rows, ...res.rows] : res.rows; last = res.last;
    $("aMore").classList.toggle("is-hidden", !res.full);
    renderChanges();
  } catch (e) { say("aMsg", `Could not load: ${e.message}`, "err"); }
}
$("aLoad").addEventListener("click", () => load(false));
$("aMore").addEventListener("click", () => load(true));
["fUser", "fAction", "fAdm"].forEach((i) => $(i).addEventListener("input", renderChanges));

$("aCsv").addEventListener("click", () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["When", "User", "Action", "Source", "Count", "AdminNo", "Field", "From", "To", "Note"].map(q).join(",")];
  visible().forEach((r) => {
    const cs = r.changes?.length ? r.changes : [{}];
    cs.forEach((c) => lines.push([when(r), r.byEmail, r.action, r.source, r.count, c.adminNo, c.field, c.from, c.to, r.note].map((v) => q(/^[=+\-@]/.test(String(v ?? "")) ? `'${v}` : v)).join(",")));
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" }));
  a.download = `audit-${$("aFrom").value}_${$("aTo").value}.csv`; a.click();
});

/* ---------- summary ---------- */
const tally = (list, f) => { const m = new Map(); list.forEach((x) => [].concat(f(x)).forEach((k) => k && m.set(k, (m.get(k) || 0) + 1))); return [...m].sort((a, b) => b[1] - a[1]); };
const tbl = (pairs) => `<table><tbody>${pairs.slice(0, 15).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td></tr>`).join("") || `<tr><td class="empty-hint">No data</td></tr>`}</tbody></table>`;
function renderSummary() {
  $("sAction").innerHTML = tbl(tally(rows, (r) => r.action));
  $("sUser").innerHTML = tbl(tally(rows, (r) => r.byEmail));
  $("sDay").innerHTML = tbl(tally(rows, (r) => r.day).sort((a, b) => b[0].localeCompare(a[0])));
  $("sField").innerHTML = tbl(tally(rows, (r) => r.fields || []));
  const per = tally(rows.filter((r) => r.action.startsWith("student.") || r.action.startsWith("teams.")), (r) => r.adminNos || []).filter(([, n]) => n >= 3);
  $("sRepeat").innerHTML = tbl(per);
}

/* ---------- usage ---------- */
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(", ");
const gauge = (reads) => { const p = Math.min(100, Math.round((reads / QUOTA) * 100)); return `<div class="bar ${p >= 80 ? "hot" : ""}"><i style="width:${p}%"></i></div><small>${reads.toLocaleString()} of ${QUOTA.toLocaleString()} reads (${p}%)</small>`; };

$("uLoad").addEventListener("click", async () => {
  const day = $("uDay").value;
  try {
    const [s, u] = await Promise.all([getDoc(doc(db, USAGE_SUMMARY_COLLECTION, day)), getDocs(query(collection(db, USAGE_COLLECTION), where("day", "==", day)))]);
    $("uGauge").innerHTML = s.exists() ? `<h3 class="pool-title">Reads for ${esc(day)} · top sources: ${top(s.data().reads)}</h3>${gauge(sum(s.data().reads))}` : `<p class="empty-hint">No usage recorded for ${esc(day)}.</p>`;
    $("uBody").innerHTML = u.docs.map((d) => d.data()).sort((a, b) => sum(b.reads) - sum(a.reads)).map((x) => {
      const hit = x.cache?.hit || 0, miss = x.cache?.miss || 0, t = x.timing || {};
      return `<tr><td>${esc(x.email)}</td><td class="num">${sum(x.reads)}</td><td class="student-sub">${top(x.reads)}</td><td class="num">${sum(x.writes)}</td>
        <td class="num">${hit + miss ? Math.round((hit / (hit + miss)) * 100) + "%" : "–"}</td>
        <td class="num">${t["roster.load_n"] ? Math.round(t["roster.load_ms"] / t["roster.load_n"]) + " ms" : "–"}</td><td class="student-sub">${top(x.errors) || "–"}</td></tr>`;
    }).join("");
  } catch (e) { $("uGauge").innerHTML = `<p class="error-text">${esc(e.message)}</p>`; }
});
$("uTrend").addEventListener("click", async () => {
  const days = Array.from({ length: 14 }, (_, i) => dayKey(new Date(Date.now() - (13 - i) * 864e5)));
  const snaps = await Promise.all(days.map((d) => getDoc(doc(db, USAGE_SUMMARY_COLLECTION, d))));
  $("uTrendOut").innerHTML = `<h3 class="pool-title">Last 14 days</h3><table><tbody>${snaps.map((s, i) => `<tr><td>${days[i]}</td><td style="width:70%">${gauge(s.exists() ? sum(s.data().reads) : 0)}</td><td class="num">${s.exists() ? sum(s.data().writes) + " writes" : ""}</td></tr>`).join("")}</tbody></table>`;
});

/* ---------- snapshot ---------- */
$("sCheck").addEventListener("click", async () => {
  say("sMsg", "Checking…", "warn");
  try {
    const r = await checkSnapshot();
    say("sMsg", r.ok ? `OK: ${r.inSnapshot} of ${r.students} students in the snapshot.` : !r.ready ? "No published snapshot yet. Clients are using the full read." : `MISMATCH: ${r.students} students, ${r.inSnapshot} in the snapshot. Publish again.`, r.ok ? "ok" : "err");
    $("sOut").innerHTML = `<table><thead><tr><th>Chunk</th><th>Students</th><th>Size</th></tr></thead><tbody>${r.chunks.map((c) => `<tr><td>${esc(c.id)}</td><td class="num">${c.count}</td><td class="num ${c.kb > 700 ? "err" : ""}">${c.kb} KB${c.kb > 700 ? " ⚠ near 1024 KB limit" : ""}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) { say("sMsg", e.message, "err"); }
});
$("sPublish").addEventListener("click", async () => {
  if (!confirm("Publish the snapshot? This reads every student once (about 1,500 reads) and writes a few documents. Do it out of hours.")) return;
  say("sMsg", "Publishing…", "warn");
  try {
    const r = await publishSnapshot();
    await logAudit({ action: "snapshot.publish", source: "audit-page", count: r.students, note: `${r.chunks} chunks` });
    say("sMsg", `Published ${r.students} students in ${r.chunks} chunks.`, "ok");
  } catch (e) { say("sMsg", e.message, "err"); }
});