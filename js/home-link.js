import { auth, onAuthStateChanged } from "./firebase-init.js";

const home = (location.pathname.includes("/hhs-teams/") ? "../" : "") + "index.html";

function ensureLink() {
  const bar = document.querySelector(".header-inner, .topbar");
  if (!bar) return null;
  let a = bar.querySelector('a[href$="index.html"]');
  if (!a) {
    a = document.createElement("a");
    a.href = home;
    a.textContent = "← Dashboard";
    a.className = bar.classList.contains("topbar") ? "btn btn-sm btn-light" : "staff-link";
    bar.appendChild(a);
  }
  return a;
}

const link = ensureLink();
if (link) onAuthStateChanged(auth, (user) => { link.style.display = user ? "" : "none"; });