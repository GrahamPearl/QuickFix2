/**
 * firebase-init.js
 * Initializes the Firebase app + Firestore instance used by data-service.js.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";

import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  writeBatch,
  updateDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const firebaseConfig = {
  authDomain: "hhs-students.firebaseapp.com",
  projectId: "hhs-students",
  storageBucket: "hhs-students.firebasestorage.app",
  messagingSenderId: "217061577342",
  appId: "1:217061577342:web:1fba3deb2936325471be2f",
  measurementId: "G-BZ6YMV107L"
};

const app = initializeApp(window.APP_CONFIG.FIREBASE_CONFIG);
export const db = getFirestore(app);
export const auth = getAuth(app);

export {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateDoc,
};
