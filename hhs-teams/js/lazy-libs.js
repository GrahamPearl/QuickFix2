/**
 * lazy-libs.js: loads third-party browser libraries on first use.
 * Versions match the ones previously pinned in the HTML files.
 */
const CDN = "https://cdn.jsdelivr.net/npm/";

const LIBS = {
  xlsx:        { src: CDN + "xlsx@0.18.5/dist/xlsx.full.min.js",            ready: () => window.XLSX },
  jszip:       { src: CDN + "jszip@3.10.1/dist/jszip.min.js",               ready: () => window.JSZip },
  mammoth:     { src: CDN + "mammoth@1.8.0/mammoth.browser.min.js",         ready: () => window.mammoth },
  html2canvas: { src: CDN + "html2canvas@1.4.1/dist/html2canvas.min.js",    ready: () => window.html2canvas },
  // jsPDF's html() uses html2canvas, so make sure it is present first
  jspdf:       { src: CDN + "jspdf@2.5.1/dist/jspdf.umd.min.js",            ready: () => window.jspdf, deps: ["html2canvas"] },
};

const pending = new Map(); // name -> in-flight promise (prevents duplicate <script> tags)

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`Failed to load ${src}`)); };
    document.head.appendChild(s);
  });
}

function load(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error(`Unknown library "${name}"`));
  if (lib.ready()) return Promise.resolve();
  if (!pending.has(name)) {
    const p = Promise.all((lib.deps || []).map(load))
      .then(() => injectScript(lib.src))
      .catch((err) => {
        pending.delete(name); // allow a retry on the next click
        throw new Error(`Could not load the ${name} library. Check your connection and try again. (${err.message})`);
      });
    pending.set(name, p);
  }
  return pending.get(name);
}

/** await loadLibs("xlsx")  or  await loadLibs("jszip", "mammoth", "jspdf") */
export const loadLibs = (...names) => Promise.all(names.map(load));