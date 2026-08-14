// HMAC-signed links for technicians.
//
// Tokens are PER-TECH and LONG-LIVED, not per-day: the same link in tonight's
// message must still open tomorrow's board, and a tech will bookmark it. Rotating
// a tech's `linkNonce` in techContacts invalidates every link they were ever sent.
//
// The signed payload deliberately carries no scheduling data — only the tech id.
// Everything else is looked up server-side, so a token can never be edited into a
// different person's view.

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(str) {
  const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, msg) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return new Uint8Array(sig);
}

// Compare without leaking where the first difference is. Length is not secret
// (tokens are fixed-width), but the bytes are.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newNonce() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return b64url(bytes);
}

// Truncated to 16 bytes (128 bits) — far beyond guessable, and keeps the SMS-era
// habit of short links even though we now send email and Telegram.
export async function makeTechToken(techId, nonce, secret) {
  const sig = await hmac(secret, techId + '|' + nonce);
  return b64url(enc.encode(techId)) + '.' + b64url(sig.slice(0, 16));
}

// Returns the techId when the token is authentic, otherwise null.
// `getNonce(techId)` supplies that tech's current linkNonce; returning null/undefined
// from it means the tech has no link issued and every token must be rejected.
export async function verifyTechToken(token, secret, getNonce) {
  if (!token || typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let techId;
  try { techId = new TextDecoder().decode(fromB64url(parts[0])); }
  catch (e) { return null; }
  if (!techId || !/^[A-Za-z0-9_-]{1,64}$/.test(techId)) return null;

  const nonce = await getNonce(techId);
  if (!nonce) return null;

  const expected = await makeTechToken(techId, nonce, secret);
  return timingSafeEqual(expected, token) ? techId : null;
}

// ── Telegram invite tokens ───────────────────────────────────────────────────
// Separate from day-view tokens on purpose: they are domain-separated by the
// "invite|" prefix, so a day link a tech forwards to a friend can never be replayed
// as a bot-binding invite, and vice versa.
//
// Telegram's /start payload allows only [A-Za-z0-9_-] and at most 64 chars — no
// dot, so the two halves are concatenated and split by the signature's fixed
// 22-character width instead of a separator.

const SIG_B64_LEN = 22; // 16 bytes, base64url, unpadded

export async function makeInviteToken(techId, nonce, secret) {
  const sig = await hmac(secret, "invite|" + techId + "|" + nonce);
  return b64url(enc.encode(techId)) + b64url(sig.slice(0, 16));
}

export async function verifyInviteToken(token, secret, getNonce) {
  if (!token || typeof token !== "string" || token.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  if (token.length <= SIG_B64_LEN) return null;

  const idPart = token.slice(0, token.length - SIG_B64_LEN);
  let techId;
  try { techId = new TextDecoder().decode(fromB64url(idPart)); }
  catch (e) { return null; }
  if (!techId || !/^[A-Za-z0-9_-]{1,64}$/.test(techId)) return null;

  const nonce = await getNonce(techId);
  if (!nonce) return null;

  const expected = await makeInviteToken(techId, nonce, secret);
  return timingSafeEqual(expected, token) ? techId : null;
}

export function inviteLinkFor(botUsername, token) {
  return "https://t.me/" + String(botUsername || "").replace(/^@/, "") + "?start=" + token;
}

export function dayLinkFor(baseUrl, token, dateKey) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base + '/d?t=' + encodeURIComponent(token) + (dateKey ? '&d=' + encodeURIComponent(dateKey) : '');
}
