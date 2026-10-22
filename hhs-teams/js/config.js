// ─── Single place to change the backend / paths ───────────────────────────
// Replace FIREBASE_CONFIG with the NEW Firestore project's web config.
export const CONFIG = {
  PHOTO_BASE_URL: "./photos/",
  STUDENTS_JSON_URL: "./students.json",
  WATERMARK_URL: "./assets/watermark.png",   // used for PDF reports (optional)
  FIREBASE_CONFIG: {
    apiKey: "REPLACE_ME",
    authDomain: "REPLACE_ME.firebaseapp.com",
    projectId: "REPLACE_ME",
    storageBucket: "REPLACE_ME.appspot.com",
    messagingSenderId: "REPLACE_ME",
    appId: "REPLACE_ME"
  },
  COLLECTION: "teams",            // one doc per team: "Activity||Age group"
  META_DOC: "_metadata",          // { activities, ageGroups, hidden }
  TEMPLATE_DOC: "_template_config",
  AUTOSAVE_MS: 1500,
  DEFAULT_AGE_GROUP: "All - No Age Group",
  ROLES: ["Member", "Captain", "Vice-Captain", "Leadership", "Awarded KZN", "Awarded SA", "Enrichment"]
};
