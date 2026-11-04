/**
 * scripts/set-claims.js
 * ----------------------------------------------------------------
 * Assigns a staff role to a Firebase Auth user via custom claims.
 *
 * Setup (once):
 *   npm install firebase-admin
 *   Save a service-account key as ./scripts/serviceAccountKey.json
 *   (keep OUT of version control and OUT of /public).
 *
 * Usage:
 *   node scripts/set-claims.js <email> <role>   assign a role
 *   node scripts/set-claims.js <email> --clear  remove all role claims
 *   node scripts/set-claims.js <email>          show current claims
 *   node scripts/set-claims.js --list           list users with a role
 *
 * Roles: admin | slt | supportStaff | teacherStaff | awardsApprover | headStaff
 * After assigning, the user must sign out/in (or the app must call
 * getIdToken(true)) before the new claims take effect.
 * ----------------------------------------------------------------
 */
const path = require("path");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, "serviceAccountKey.json"))),
});

/**
 * SINGLE SOURCE OF TRUTH for permissions. Edit here only.
 *   admin          -> edit students (rules + app gate on this flag)
 *   canRecommend   -> may submit award recommendations
 *   awardsApprover -> may confirm/reject recommendations
 */
const ROLES = {
  admin:          { level: 0, admin: true,  canRecommend: true,  awardsApprover: true  },
  slt:            { level: 1, admin: true,  canRecommend: true,  awardsApprover: false },
  supportStaff:   { level: 2, admin: false, canRecommend: false, awardsApprover: false },
  teacherStaff:   { level: 3, admin: false, canRecommend: true,  awardsApprover: false },
  awardsApprover: { level: 4, admin: true,  canRecommend: true,  awardsApprover: true  },
  headStaff:      { level: 5, admin: true,  canRecommend: true,  awardsApprover: false },
};

// Every key this script owns; others (set elsewhere) are preserved.
const MANAGED = ["role", "roleLevel", "admin", "canRecommend", "awardsApprover"];

function claimsFor(role) {
  const r = ROLES[role];
  return { role, roleLevel: r.level, admin: r.admin, canRecommend: r.canRecommend, awardsApprover: r.awardsApprover };
}

function stripManaged(claims = {}) {
  const out = { ...claims };
  MANAGED.forEach((k) => delete out[k]);
  return out;
}

async function listRoleUsers() {
  let token;
  do {
    const page = await admin.auth().listUsers(1000, token);
    page.users.forEach((u) => {
      const c = u.customClaims || {};
      if (c.role) console.log(`${(u.email || u.uid).padEnd(40)} ${c.role}`);
    });
    token = page.pageToken;
  } while (token);
}

async function main() {
  const [a, b] = process.argv.slice(2);

  if (a === "--list") return listRoleUsers();
  if (!a) {
    console.error("Usage: node scripts/set-claims.js <email> <role|--clear>  |  --list");
    process.exit(1);
  }

  const user = await admin.auth().getUserByEmail(a);
  const existing = user.customClaims || {};

  if (!b) {
    console.log(`${a}:`, existing);
    return;
  }

  let next;
  if (b === "--clear") {
    next = stripManaged(existing);
  } else if (ROLES[b]) {
    next = { ...stripManaged(existing), ...claimsFor(b) };
  } else {
    console.error(`Unknown role "${b}". Valid: ${Object.keys(ROLES).join(", ")}`);
    process.exit(1);
  }

  await admin.auth().setCustomUserClaims(user.uid, next);
  console.log(`✔ ${a} ->`, b === "--clear" ? "(cleared)" : next);
  console.log("User must sign out/in for claims to apply.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
