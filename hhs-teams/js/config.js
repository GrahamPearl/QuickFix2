// ─── Single place to change the backend / paths ───────────────────────────
// Replace FIREBASE_CONFIG with the NEW Firestore project's web config.
export const CONFIG = {
  PHOTO_BASE_URL: window.APP_CONFIG.IMAGE_BASE_URL,
  WATERMARK_URL: "./assets/watermark.png", // used for PDF reports (optional)

  COLLECTION: "teams", // one doc per team: "Activity||Age group"
  META_DOC: "_metadata", // { activities, ageGroups, hidden }
  TEMPLATE_DOC: "_template_config",
  AUTOSAVE_MS: 1500,
  DEFAULT_AGE_GROUP: "All - No Age Group",
  ROLES: window.APP_CONFIG.TEAM_ROLES
};
