import crypto from "node:crypto";

// HMAC magic-link tokens for the /e/:action email routes: the token itself is
// the auth (no session, no login) — sign with webhookSecret, 7-day expiry.
export type ActionToken = { a: "acc" | "dec" | "bok" | "nbk"; id: string; p?: number; x: number };

const b64u = (b: Buffer) => b.toString("base64url");

export function signAction(secret: string, t: Omit<ActionToken, "x"> & { x?: number }): string {
  const payload = { ...t, x: t.x ?? Math.floor(Date.now() / 1000) + 7 * 86400 };
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyAction(secret: string, token: string): ActionToken | null {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!t?.a || !t?.id || typeof t.x !== "number" || t.x < Date.now() / 1000) return null;
    return t;
  } catch {
    return null;
  }
}
