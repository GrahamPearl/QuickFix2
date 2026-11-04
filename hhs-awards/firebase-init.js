/**
 * firebase-init.js
 * Initializes the Firebase app + Firestore/Auth instances. Every other module
 * imports Firebase functions from HERE ONLY, so the whole app runs on one SDK
 * version (never import from gstatic URLs elsewhere).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  arrayUnion,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  arrayUnion,
  increment,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
};
