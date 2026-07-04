// Drivers and customers type anything — "haan bhai chalega", "nahi", "15k",
// "13 hazar chahiye" — instead of tapping buttons. Classify the message into
// the three intents the flows act on. Keyword-based on purpose: free, instant,
// works offline in tests; the LLM stays reserved for full load-intake parsing.

export type Intent =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "price"; priceInr: number }
  | { kind: "unknown" };

const YES = new Set([
  "yes", "y", "ya", "yaa", "yep", "haan", "haa", "han", "ha", "hn", "hanji", "haanji",
  "ok", "okay", "okey", "k", "thik", "theek", "thike", "tik", "chalega", "chalegi",
  "done", "accept", "accepted", "confirm", "confirmed", "pakka", "book", "sahi", "manzoor", "mangur",
]);
const NO = new Set([
  "no", "n", "nahi", "nhi", "nahin", "nako", "not", "busy", "cancel", "cancelled",
  "decline", "reject", "mat", "unavailable", "nope", "na",
]);

// "15k" → 15000 · "13 hazar" → 13000 · "1.5 lakh" → 150000 · "₹14,000" → 14000.
// Plain numbers under 100 are never freight (they're "16ft", "2 gadi", etc).
export function parsePriceText(raw: string): number | null {
  // strip currency + thousands separators WITHOUT splitting the number ("14,000" → "14000")
  const s = (raw || "").toLowerCase().replace(/[₹,]/g, "");
  const scaled = s.match(/(\d+(?:\.\d+)?)\s*(k|hazar|hajar|hazaar|thousand|lakh|lac|lakhs)\b/);
  if (scaled) {
    const n = parseFloat(scaled[1]);
    const mult = /lakh|lac/.test(scaled[2]) ? 100_000 : 1_000;
    const v = Math.round(n * mult);
    return v >= 100 ? v : null;
  }
  const plain = s.match(/\d{3,7}/);
  if (plain) {
    const v = Number(plain[0]);
    return v >= 100 ? v : null;
  }
  return null;
}

export function parseIntent(raw: string): Intent {
  const words = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return { kind: "unknown" };

  // a price anywhere means they're quoting one — "haan 15000 me chalega" is a counter
  const price = parsePriceText(raw);
  if (price) return { kind: "price", priceInr: price };
  // negatives beat positives: "nahi chalega" is a NO even though it contains "chalega"
  if (words.some((w) => NO.has(w))) return { kind: "no" };
  if (words.some((w) => YES.has(w))) return { kind: "yes" };
  return { kind: "unknown" };
}
