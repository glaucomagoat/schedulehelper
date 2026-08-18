// Session verification for technician-side functions.
//
// Same HMAC-SHA256 scheme and the same millisecond `exp` convention as
// storage-proxy.mjs — deliberately not JWT-standard seconds. Keep the two in step.

import { ADMIN, TECH_ADMINS } from "./techdata.mjs";

function fromB64url(str) {
  return atob(String(str).replace(/-/g, "+").replace(/_/g, "/"));
}

export async function verifySession(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  const [header, body, sig] = parts;
  const key = await globalThis.crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sigBytes = Uint8Array.from(fromB64url(sig), c => c.charCodeAt(0));
  const valid = await globalThis.crypto.subtle.verify(
    "HMAC", key, sigBytes, new TextEncoder().encode(header + "." + body)
  );
  if (!valid) throw new Error("Invalid token signature");
  const payload = JSON.parse(fromB64url(body));
  if (Date.now() > payload.exp) throw new Error("Token expired");
  return payload;
}

// Admin-or-dev, scoped to the tenant this deployment serves. A read-only portal
// account must never reach a mutating technician endpoint, and an admin from some
// other tenant must never touch this one's data.
export async function requireAdmin(req) {
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return { error: new Response(JSON.stringify({ error: "Server misconfigured — SESSION_SECRET not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } }) };
  }
  let session;
  try {
    session = await verifySession(req.headers.get("x-session-token") || "", SESSION_SECRET);
  } catch (e) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized — " + e.message }),
      { status: 401, headers: { "Content-Type": "application/json" } }) };
  }
  if (session.type !== "admin" && session.type !== "dev") {
    return { error: new Response(JSON.stringify({ error: "Forbidden — admin account required" }),
      { status: 403, headers: { "Content-Type": "application/json" } }) };
  }
  // Accept the tenant that owns the data, anyone managed under it, and any extra
  // login named in TECH_ADMIN_USERNAME.
  const ns = session.adminUsername || session.sub;
  const permitted = ns === ADMIN
    || TECH_ADMINS.indexOf(ns) !== -1
    || TECH_ADMINS.indexOf(session.sub) !== -1;
  if (session.type !== "dev" && !permitted) {
    return { error: new Response(JSON.stringify({ error: "Forbidden — not this practice's account" }),
      { status: 403, headers: { "Content-Type": "application/json" } }) };
  }
  return { session };
}

// Shared secret for server-to-server calls (cron -> background sender), where no
// user session exists. Compared without early exit.
export function checkInternalSecret(req) {
  const expected = process.env.INTERNAL_SECRET || "";
  const got = req.headers.get("x-internal-secret") || "";
  if (!expected || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
