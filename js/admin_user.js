/**
 * admin_user.js — page controller for admin_users.html.
 * Verifies the signed-in user is an admin (usertypes.json "manageUsers"),
 * then lets them view / add / edit / delete docs in authorized_users.
 * Client checks are UI only: Firestore Rules must also restrict writes to admins.
 */
import {
  auth, db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  serverTimestamp, onAuthStateChanged, signOut,
} from "./firebase-init.js";
import { loadUserTypes, resolveUserType, can, getTypeDef, typeKeys } from "./usertypes.js";

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gateMessage"), gateText: $("gateText"), content: $("adminContent"),
  badge: $("adminBadge"), signOut: $("signOutBtn"),
  form: $("userForm"), formTitle: $("formTitle"), email: $("userEmail"), type: $("userType"),
  typeHint: $("typeHint"), saveBtn: $("saveUserBtn"), cancelBtn: $("cancelEditBtn"),
  error: $("formError"), ok: $("formOk"),
  body: $("usersBody"), count: $("userCount"), refresh: $("refreshUsersBtn"),
};

let cfg = null;
let me = null;
let users = [];
let editingId = null;

const escapeHtml = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const colRef = () => collection(db, cfg.collection);
const isSelf = (u) =>
  u.id === me.uid ||
  u.id === (me.email || "").toLowerCase() ||
  String(u.email || "").toLowerCase() === (me.email || "").toLowerCase();

/* ---------------- Access gate ---------------- */

function deny(message) {
  els.content.classList.add("is-hidden");
  els.gate.style.display = "flex";
  els.gate.innerHTML = `<p class="error-text">${escapeHtml(message)} <a href="index.html">Return to the roster</a></p>`;
}

els.signOut.addEventListener("click", async () => {
  await signOut(auth);
  location.replace("index.html");
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("index.html"); // index.html shows the login gate
    return;
  }
  try {
    cfg = await loadUserTypes();
    const type = await resolveUserType(user, cfg);
    if (!can(cfg, type, "manageUsers")) {
      deny("Access denied: this page is for administrators only.");
      return;
    }
    me = user;
    els.badge.textContent = `${getTypeDef(cfg, type).label}: ${user.email}`;
    els.badge.classList.remove("is-hidden");
    els.signOut.classList.remove("is-hidden");
    els.type.innerHTML = typeKeys(cfg)
      .map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(cfg.types[k].label)} (${escapeHtml(k)})</option>`)
      .join("");
    updateTypeHint();
    els.gate.style.display = "none";
    els.content.classList.remove("is-hidden");
    await loadUsers();
  } catch (err) {
    console.error(err);
    deny(`Could not verify access: ${err.message}`);
  }
});

/* ---------------- List ---------------- */

async function loadUsers() {
  els.body.innerHTML = `<tr><td colspan="4" class="empty-hint">Loading…</td></tr>`;
  try {
    const snap = await getDocs(colRef());
    users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));
    renderUsers();
  } catch (err) {
    els.body.innerHTML = `<tr><td colspan="4" class="error-text">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderUsers() {
  els.count.textContent = `(${users.length})`;
  if (!users.length) {
    els.body.innerHTML = `<tr><td colspan="4" class="empty-hint">No authorized users yet.</td></tr>`;
    return;
  }
  els.body.innerHTML = users.map((u) => {
    const known = Boolean(cfg.types[u.type]);
    const self = isSelf(u);
    return `
      <tr data-id="${escapeHtml(u.id)}">
        <td><span class="mono">${escapeHtml(u.email || u.id)}</span>${self ? ' <span class="badge badge-muted">you</span>' : ""}
          ${u.email && u.email.toLowerCase() !== u.id ? `<span class="student-sub">ID: ${escapeHtml(u.id)}</span>` : ""}</td>
        <td><span class="badge ${known ? "" : "badge-muted"}">${escapeHtml(known ? cfg.types[u.type].label : (u.type || "none") + " (unknown)")}</span></td>
        <td class="student-sub">${escapeHtml(u.updatedBy || "—")}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-ghost" data-action="edit">Edit</button>
          <button type="button" class="btn btn-ghost" data-action="delete" ${self ? 'disabled title="You cannot delete your own access"' : ""}>Delete</button>
        </td>
      </tr>`;
  }).join("");
}

els.body.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const id = btn.closest("[data-id]").dataset.id;
  if (btn.dataset.action === "edit") startEdit(id);
  if (btn.dataset.action === "delete") removeUser(id);
});
els.refresh.addEventListener("click", loadUsers);

/* ---------------- Add / edit ---------------- */

function updateTypeHint() {
  els.typeHint.textContent = getTypeDef(cfg, els.type.value)?.description || "";
}
els.type.addEventListener("change", updateTypeHint);

function resetForm() {
  editingId = null;
  els.form.reset();
  els.email.disabled = false;
  els.formTitle.textContent = "Add user";
  els.saveBtn.textContent = "Add user";
  els.cancelBtn.classList.add("is-hidden");
  els.error.textContent = "";
  updateTypeHint();
}

function startEdit(id) {
  const u = users.find((x) => x.id === id);
  if (!u) return;
  editingId = id;
  els.email.value = u.email || u.id;
  els.email.disabled = true; // the doc ID is derived from the email; delete + re-add to change it
  if (cfg.types[u.type]) els.type.value = u.type;
  els.formTitle.textContent = "Edit user";
  els.saveBtn.textContent = "Save changes";
  els.cancelBtn.classList.remove("is-hidden");
  els.error.textContent = "";
  els.ok.textContent = "";
  updateTypeHint();
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}
els.cancelBtn.addEventListener("click", resetForm);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.error.textContent = "";
  els.ok.textContent = "";

  const type = els.type.value;
  if (!cfg.types[type]) { els.error.textContent = "Choose a valid user type."; return; }

  els.saveBtn.disabled = true;
  try {
    const stamp = { type, updatedAt: serverTimestamp(), updatedBy: me.email };

    if (editingId) {
      const target = users.find((u) => u.id === editingId);
      if (target && isSelf(target) && type !== "admin") {
        throw new Error("You cannot remove your own admin access.");
      }
      await updateDoc(doc(db, cfg.collection, editingId), stamp);
      els.ok.textContent = "User updated.";
    } else {
      const email = els.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
      const ref = doc(db, cfg.collection, email);
      if ((await getDoc(ref)).exists()) throw new Error("That user already exists. Use Edit instead.");
      await setDoc(ref, { email, ...stamp });
      els.ok.textContent = "User added.";
    }
    resetForm();
    await loadUsers();
  } catch (err) {
    els.error.textContent = err.message;
  } finally {
    els.saveBtn.disabled = false;
  }
});

/* ---------------- Delete ---------------- */

async function removeUser(id) {
  const u = users.find((x) => x.id === id);
  if (!u || isSelf(u)) return;
  if (!window.confirm(`Remove access for ${u.email || u.id}? They will no longer be able to view the roster.`)) return;
  try {
    await deleteDoc(doc(db, cfg.collection, id));
    if (editingId === id) resetForm();
    els.ok.textContent = "User removed.";
    await loadUsers();
  } catch (err) {
    els.error.textContent = `Could not delete: ${err.message}`;
  }
}
