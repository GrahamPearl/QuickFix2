/** concession-types.js — the one list of concession types (pure; no DOM, no network). */
export const TYPES = [
  { key: "extraTime", label: "Extra time", short: "ET" },
  { key: "reader", label: "Reader", short: "R" },
  { key: "scribe", label: "Scribe", short: "S" },
  { key: "separateVenue", label: "Separate venue", short: "SV" },
  { key: "other", label: "Other", short: "O" },
];

const n = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const typeLabel = (k) => TYPES.find((t) => t.key === k)?.label ?? k;
export const typeShort = (k) => TYPES.find((t) => t.key === k)?.short ?? k;

/** "Extra time; Reader" / "ET, R" / "scribe" -> ["extraTime","reader"]. Unknown words are ignored. */
export function parseTypes(text) {
  const out = new Set();
  String(text ?? "").split(/[,;/|]+/).forEach((w) => {
    const t = TYPES.find((x) => [x.key, x.label, x.short].some((v) => n(v) === n(w)));
    if (t) out.add(t.key);
  });
  return [...out];
}