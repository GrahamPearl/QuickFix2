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
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
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
};
