/**
 * firebase-init.js
 * Initializes the Firebase app + Firestore/Auth instances.
 * Additive change: also exports deleteDoc, onSnapshot, addDoc, query, where, arrayUnion,
 * which admin_user.js, teams_app.js and awards-service.js import.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";

import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  writeBatch,
  updateDoc,
  runTransaction,
  serverTimestamp,
  onSnapshot,
  query,
  where,
  arrayUnion,
  getCountFromServer,
  deleteField, increment, FieldPath, orderBy, limit, startAfter, getCountFromServer
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  OAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const app = initializeApp(window.APP_CONFIG.FIREBASE_CONFIG);
export const db = getFirestore(app);
export const auth = getAuth(app);

export {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  onSnapshot,
  query,
  where,
  arrayUnion,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateDoc,
  OAuthProvider,
  signInWithPopup,
  getCountFromServer,
  deleteField, increment, FieldPath, orderBy, limit, startAfter, getCountFromServer
};

// firebase-init.js (sketch)
const usage = { reads: {}, writes: {}, hits: 0, misses: 0 };
export const count = (kind, source, n = 1) => (usage[kind][source] = (usage[kind][source] || 0) + n);
// call count("reads", "roster", snap.size) inside fetchAll, count("reads", "teams", ...) in loadAvailableTeams, etc.
// on visibilitychange→hidden: one write to usage/{yyyy-mm-dd}_{uid} with the totals (about 150 writes/day for 50 users)
