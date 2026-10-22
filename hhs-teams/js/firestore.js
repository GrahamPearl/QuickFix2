// All Firestore access lives here. Every call degrades to a no-op offline.
import { CONFIG } from "./config.js";
import { docId, setSync } from "./utils.js";

let db = null;
export const online = () => !!db;

export function init() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(CONFIG.FIREBASE_CONFIG);
    db = firebase.firestore(); setSync("idle");
  } catch (e) { console.warn("Firebase init failed", e); db = null; setSync("offline"); }
}

const col = () => db.collection(CONFIG.COLLECTION);
const safe = async (fn, fallback = null) => {
  if (!db) return fallback;
  try { return await fn(); } catch (e) { console.warn(e); return fallback; }
};

export const getMeta = () => safe(async () => { const d = await col().doc(CONFIG.META_DOC).get(); return d.exists ? d.data() : null; });
export const setMeta = meta => safe(() => col().doc(CONFIG.META_DOC).set(meta));
export const getTeam = key => safe(async () => { const d = await col().doc(docId(key)).get(); return d.exists ? d.data() : null; });
export const deleteTeam = key => safe(() => col().doc(docId(key)).delete());
export const getTemplate = () => safe(async () => { const d = await col().doc(CONFIG.TEMPLATE_DOC).get(); return d.exists ? d.data().templateBase64 : null; });
export const setTemplate = b64 => safe(() => col().doc(CONFIG.TEMPLATE_DOC).set({ templateBase64: b64, updatedAt: new Date().toISOString() }));

export async function saveTeam(key, { members, roles }) {
  if (!db) return false;
  await col().doc(docId(key)).set({ members, roles, updatedAt: new Date().toISOString() });
  return true;
}
