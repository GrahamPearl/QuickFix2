/**
 * memory-game-service.js — Firestore access for the memory game.
 *
 *  setting/memoryGame                          { season, startedAt, config, resetBy, resetAt, ... }
 *  memory-game-seasons/{season}/scores/{uid}   one personal-best document per user per session
 *      { uid, email, name, bestScore, bestTimeMs, bestCorrect, rounds, games, totalPlayMs, sortKey, updatedAt }
 *
 * A session ("season") is a number. Resetting adds 1; old sessions are never deleted.
 * The leaderboard is one query on a single field (sortKey) inside the session's sub-collection,
 * so no composite index is needed.
 * Cost: 1 read per page load (settings) + 1 per game start (fresh settings) + up to 25 per leaderboard view;
 *       1 transaction (2 reads + 1 write) per finished game.
 */
import {
  auth, db, collection, doc, getDoc, getDocs, setDoc, runTransaction, query, orderBy, limit, serverTimestamp,
} from "./firebase-init.js";
import { meter } from "./usage-meter.js";
import { logAudit } from "./audit-service.js";
import { normaliseConfig, mergeBest, sortKey, emailName } from "./memory-game-form.js";

const { SETTINGS_COLLECTION = "setting", MEMORY_GAME_COLLECTION = "memory-game-seasons" } = window.APP_CONFIG;

const settingRef = () => doc(db, SETTINGS_COLLECTION, "memoryGame");
const scoresCol = (season) => collection(db, MEMORY_GAME_COLLECTION, String(season), "scores");
const seasonOf = (snap) => (snap.exists() && Number(snap.data().season)) || 1;
const emailOf = (u) => String(u?.email || "").toLowerCase();

/** @returns {{season:number, startedAt:Date|null, config:Object, resetBy:string, exists:boolean}} */
export async function loadGameSettings() {
  const snap = await getDoc(settingRef());
  meter.read("memorygame-setting", 1);
  const d = snap.exists() ? snap.data() : {};
  return {
    season: seasonOf(snap),
    startedAt: d.startedAt?.toDate?.() || null,
    config: normaliseConfig(d.config),
    resetBy: d.resetBy || "",
    exists: snap.exists(),
  };
}

/** Managers only (Rules: setting/* write = admin or staff-head). Applies to games started afterwards. */
export function saveConfig(config, user) {
  const cfg = normaliseConfig(config);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(settingRef());
    const patch = { config: cfg, configUpdatedBy: emailOf(user), configUpdatedAt: serverTimestamp() };
    if (!snap.exists() || !snap.data().season) patch.season = 1;
    if (!snap.exists() || !snap.data().startedAt) patch.startedAt = serverTimestamp();
    tx.set(settingRef(), patch, { merge: true });
    return cfg;
  });
}

/** Managers only. Starts the next session; earlier sessions stay in Firestore. */
export async function resetSession(user) {
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(settingRef());
    const from = seasonOf(snap);
    const to = from + 1;
    tx.set(
      settingRef(),
      { season: to, startedAt: serverTimestamp(), resetBy: emailOf(user), resetAt: serverTimestamp() },
      { merge: true },
    );
    return { from, to };
  });
  await logAudit({
    action: "memorygame.reset",
    source: "memory-game-page",
    note: `session ${result.from} -> ${result.to}`,
  }).catch((e) => console.warn("Audit not written", e.code));
  return result;
}

/**
 * Saves a finished game into the CURRENT session (read inside the transaction, so a reset that
 * happened mid-game cannot write into an old session). Only the personal best is replaced.
 * game = { score, correct, totalMs, rounds }
 */
export function submitGame(game, user = auth.currentUser) {
  if (!user) throw new Error("You are signed out.");
  return runTransaction(db, async (tx) => {
    const s = await tx.get(settingRef());
    const season = seasonOf(s);
    const ref = doc(db, MEMORY_GAME_COLLECTION, String(season), "scores", user.uid);
    const prevSnap = await tx.get(ref);
    const { improved, ...best } = mergeBest(prevSnap.exists() ? prevSnap.data() : null, game);
    tx.set(ref, {
      uid: user.uid,
      email: emailOf(user),
      name: emailName(emailOf(user)),
      ...best,
      rounds: game.rounds,
      sortKey: sortKey(best.bestScore, best.bestTimeMs),
      updatedAt: serverTimestamp(),
    });
    return { season, improved, best };
  }).then((r) => {
    meter.read("memorygame-submit", 2);
    meter.write("memorygame", 1);
    return r;
  });
}

/** Top players of one session: score high to low, then total time low to high. */
export async function listScores(season, n = 25) {
  const snap = await getDocs(query(scoresCol(season), orderBy("sortKey", "desc"), limit(n)));
  meter.read("memorygame-board", snap.size);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}