/**
 * config.js
 * ----------------------------------------------------------------
 * Single place to adjust environment-specific settings after the
 * site is deployed (e.g. on Firebase Hosting). Nothing else in the
 * app hardcodes these values, so editing this file is enough —
 * no rebuild step required.
 * ----------------------------------------------------------------
 */
window.APP_CONFIG = {
  // Where student photos live. Point this at a GitHub raw path,
  // Firebase Storage bucket, or any static host. Must end in "/".
  // Example (GitHub):
  //   "https://raw.githubusercontent.com/<org>/<repo>/main/photos/"
  // Example (Firebase Storage, public bucket):
  //   "https://storage.googleapis.com/<bucket-name>/photos/"
  IMAGE_BASE_URL: "https://grahampearl.github.io/hhs_lookup/photos/",

  // Shown when a student has no photo on file, or the image 404s.
  FALLBACK_IMAGE: "assets/no-photo.svg",

  // Firestore project config (safe to expose client-side; access is
  // controlled by Firestore Security Rules, not by hiding this).
  FIREBASE_CONFIG: {
    apiKey: "AIzaSyDcKn9snvMN9TJSK9XMNXz2cULHhw7DxdE",
    authDomain: "hhs-students.firebaseapp.com",
    projectId: "hhs-students",
    storageBucket: "hhs-students.firebasestorage.app",
    messagingSenderId: "217061577342",
    appId: "1:217061577342:web:1fba3deb2936325471be2f",
    measurementId: "G-BZ6YMV107L",
  },

  // Firestore collection holding one document per student, keyed by adminNo.
  STUDENTS_COLLECTION: "students",

  // How long the in-browser student cache stays fresh before a
  // silent Firestore re-fetch (keeps read costs down; see js/students.js).
  CACHE_TTL_MS: 30 * 60 * 1000,
};
