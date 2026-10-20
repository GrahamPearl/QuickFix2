/**
 * auth-service.js
 * Wraps Firebase Auth and resolves staff roles from custom claims.
 *
 *   claims.admin           -> isAdmin (edit students)
 *   claims.canRecommend    -> canRecommend (submit award recommendations)
 *   claims.awardsApprover  -> isApprover AND isAdmin (approver implies admin)
 *
 * Claims are set server-side (Admin SDK). A user must sign out/in, or the app
 * must call refreshClaims(), before a newly granted claim is visible.
 */
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "./firebase-init.js";

let state = { user: null, role: null, isAdmin: false, canRecommend: false, isApprover: false, ready: false };
const listeners = new Set();
let seq = 0; // guards against out-of-order async claim lookups

async function resolveRoles(user) {
  if (!user) return { role: null, isAdmin: false, canRecommend: false, isApprover: false };
  const { claims } = await user.getIdTokenResult();
  const isApprover = claims.awardsApprover === true;
  const isAdmin = claims.admin === true || isApprover;
  return {
    role: claims.role || null, // admin | slt | supportStaff | teacherStaff | awardsApprover | headStaff
    isApprover,
    isAdmin,
    canRecommend: claims.canRecommend === true || isAdmin,
  };
}

function publish(next) {
  state = next;
  listeners.forEach((fn) => fn(state));
}

onAuthStateChanged(auth, async (user) => {
  const mine = ++seq;
  const roles = await resolveRoles(user);
  if (mine !== seq) return; // a newer auth event superseded this one
  publish({ user, ...roles, ready: true });
});

/** Subscribe to auth/role changes. Calls fn immediately if state is ready. */
export function onAuthChange(fn) {
  listeners.add(fn);
  if (state.ready) fn(state);
  return () => listeners.delete(fn);
}

export function getAuthState() {
  return state;
}

export function signInStaff(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutStaff() {
  return signOut(auth);
}

/** Force-refreshes the ID token so newly granted claims take effect. */
export async function refreshClaims() {
  const user = auth.currentUser;
  if (!user) return state;
  await user.getIdToken(true);
  const mine = ++seq;
  const roles = await resolveRoles(user);
  if (mine === seq) publish({ user, ...roles, ready: true });
  return state;
}
