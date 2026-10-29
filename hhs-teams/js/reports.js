// Student activity reports: Excel summary + Word/PDF mail-merge. Admin only.
import { CONFIG } from "./config.js";
import * as fs from "./firestore.js";
import { state } from "./store.js";
import { download, esc, setSync, splitKey, toast } from "./utils.js";
import { loadLibs } from "../../js/lazy-libs.js";

// Word output needs JSZip; PDF output additionally needs mammoth + jsPDF (+ html2canvas, pulled in by jspdf)
const loadReportLibs = (format) =>
  format === "docx" ? loadLibs("jszip") : loadLibs("jszip", "mammoth", "jspdf");

let TEMPLATE_B64 = null;
let watermark = null;

export async function loadTemplate() {
  TEMPLATE_B64 = localStorage.getItem("hhs_template_b64");
  const remote = await fs.getTemplate();
  if (remote) { TEMPLATE_B64 = remote; localStorage.setItem("hhs_template_b64", remote); }
}
export async function uploadTemplate(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ""; bytes.forEach(b => (bin += String.fromCharCode(b)));
    TEMPLATE_B64 = btoa(bin);
    localStorage.setItem("hhs_template_b64", TEMPLATE_B64);
    await fs.setTemplate(TEMPLATE_B64);
    toast("Template uploaded.");
  } catch (e) { toast("Template upload failed: " + e.message, "danger"); }
}

/* ── data ── */
export async function getAllRows() {
  const keys = Object.entries(state.meta.ageGroups).flatMap(([a, gs]) => gs.map(g => `${a}||${g}`));
  if (fs.online()) {
    setSync("saving");
    await Promise.all(keys.map(async k => {
      const d = await fs.getTeam(k); if (!d) return;
      state.teams[k] = d.members || []; state.roles[k] = d.roles || {};
    }));
    setSync("idle");
  }
  return keys.flatMap(k => {
    const [activity, age] = splitKey(k);
    return (state.teams[k] || []).map(adm => {
      const s = state.students.get(adm);
      return { adminNo: adm, first: s?.firstName ?? "Unknown", last: s?.lastName ?? "Unlisted", grade: String(s?.grade ?? ""),
        cls: s?.class ?? "", activity, age, role: state.roles[k]?.[adm] || "Member" };
    });
  });
}

export async function exportActivitiesExcel() {
  try { await loadLibs("xlsx"); } catch (e) { return toast(e.message, "danger"); }
  const rows = (await getAllRows()).sort((a, b) => a.adminNo.localeCompare(b.adminNo) || a.activity.localeCompare(b.activity));
  if (!rows.length) return toast("No assignments found.", "warn");
  const out = rows.map(r => ({ "Admin No": r.adminNo, "First Name": r.first, "Last Name": r.last, Grade: r.grade, Class: r.cls, Activity: r.activity, "Age Group": r.age, Role: r.role }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), "Student Activities");
  XLSX.writeFile(wb, "Student_Activities_Report.xlsx");
  toast(`Report generated: ${rows.length} assignments.`);
}

/* ── Word merge ── */
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

async function mergeDocx(rows, name, adminNo) {
  const zip = await JSZip.loadAsync(b64ToBytes(TEMPLATE_B64));
  const BR = "@@BR@@", lines = list => list.map(esc).join(BR);
  const files = Object.keys(zip.files).filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  for (const f of files) {
    let xml = await zip.file(f).async("string");
    xml = xml.replace(/Field-Name/g, esc(name)).replace(/Field-Admin/g, esc(adminNo))
      .replace(/Field-Activity/g, lines(rows.map(r => r.activity))).replace(/Field-Team/g, lines(rows.map(r => r.age)))
      .replace(/Field-Leadership/g, lines(rows.map(r => r.role)))
      .split(BR).join('</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">');
    zip.file(f, xml);
  }
  return zip.generateAsync({ type: "blob" });
}

async function loadWatermark() {
  if (watermark !== null) return watermark;
  try {
    const blob = await (await fetch(CONFIG.WATERMARK_URL)).blob();
    watermark = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  } catch { watermark = ""; }
  return watermark;
}

async function docxToPdf(docxBlob) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await docxBlob.arrayBuffer() });
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:0;top:0;width:700px;min-height:800px;padding:24px;font:12px Arial,sans-serif;z-index:-1;overflow:hidden;background:#fff";
  const wm = await loadWatermark();
  if (wm) box.insertAdjacentHTML("beforeend", `<img src="${wm}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:90%;opacity:.15;pointer-events:none">`);
  box.insertAdjacentHTML("beforeend", `<div style="position:relative;z-index:1">${html}</div>`);
  document.body.appendChild(box);
  try {
    const pdf = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    await new Promise((resolve, reject) => {
      pdf.html(box, { margin: [40, 40, 40, 40], autoPaging: "text", x: 0, y: 0, html2canvas: { scale: 0.75, scrollY: 0, useCORS: true }, callback: resolve });
      setTimeout(() => reject(new Error("PDF render timed out")), 20000);
    });
    return pdf.output("blob");
  } finally { box.remove(); }
}

async function build(rows, format, sink) {
  const name = `${rows[0].first} ${rows[0].last}`, base = `${rows[0].adminNo}_${name.replace(/\s+/g, "_")}`;
  const docx = await mergeDocx(rows, name, rows[0].adminNo);
  if (format !== "pdf") sink(`${base}.docx`, docx);
  if (format !== "docx") sink(`${base}.pdf`, await docxToPdf(docx));
  return name;
}

export async function printStudent(adminNo, format) {
  if (!adminNo) return toast("Enter an Admin No to print.", "warn");
  if (!TEMPLATE_B64) return toast("Upload a template first.", "warn");
  const rows = (await getAllRows()).filter(r => r.adminNo === adminNo);
  if (!rows.length) return toast(`No activities found for ${adminNo}.`, "warn");
  try {
    await loadReportLibs(format);
    const n = await build(rows, format, download);
    toast(`Generated report for ${n}.`);
  } catch (e) { toast("Report failed: " + e.message, "danger"); }
}

export async function printAll(grade, format) {
  if (!TEMPLATE_B64) return toast("Upload a template first.", "warn");
  try { await loadReportLibs(format); } catch (e) { return toast(e.message, "danger"); }
  const byAdmin = {};
  (await getAllRows()).filter(r => grade === "ALL" || r.grade === grade).forEach(r => (byAdmin[r.adminNo] ||= []).push(r));
  const ids = Object.keys(byAdmin);
  if (!ids.length) return toast("No assignments found for that grade.", "warn");
  const zip = new JSZip(); let ok = 0;
  for (const id of ids) {
    try { await build(byAdmin[id], format, (n, b) => zip.file(n, b)); ok++; } catch (e) { console.warn("Skipped", id, e); }
  }
  download(await zip.generateAsync({ type: "blob" }), `Student_Reports_${grade === "ALL" ? "All_Grades" : "Grade_" + grade}_${format}.zip`);
  toast(`Generated ${ok} of ${ids.length} reports.`);
}
