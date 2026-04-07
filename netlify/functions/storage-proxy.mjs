import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";

// storage-proxy is called exclusively from the same Netlify origin as the app.
// Same-origin requests don't need CORS headers, so we omit Allow-Origin entirely.
const cors = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-session-token",
  "Content-Type": "application/json"
};

// ── Rate limiting (in-memory, resets on cold start) ──────────────────────────
// Keyed by IP address. Tracks attempt counts per action type per window.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMITS = {
  login:            { max: 10 },
  register:         { max: 5  },
  'forgot-password':{ max: 5  },
  'reset-password': { max: 5  },
};

function checkRateLimit(ip, action) {
  const limit = RATE_LIMITS[action];
  if (!limit) return false; // no limit for this action
  const key = `${ip}:${action}`;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry = { start: now, count: 0 };
  }
  entry.count++;
  rateLimitStore.set(key, entry);
  return entry.count > limit.max;
}

// ── JWT / crypto helpers ─────────────────────────────────────────────────────
// NOTE: exp is stored as milliseconds (Date.now() + ms), not JWT standard seconds.
// This is consistent throughout this file and the edge function — do not change.

function b64url(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function createToken(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig    = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigB64}`;
}

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const key = await globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(fromB64url(sig), c => c.charCodeAt(0));
  const valid = await globalThis.crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  if (!valid) throw new Error('Invalid token signature');
  const payload = JSON.parse(fromB64url(body));
  // exp is milliseconds (Date.now()-based)
  if (Date.now() > payload.exp) throw new Error('Token expired');
  return payload;
}

async function hashPassword(pw) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function issueToken(username, userType, adminUsername, secret) {
  return createToken({
    sub:           username,
    type:          userType,
    adminUsername: adminUsername || null,
    exp:           Date.now() + 24 * 60 * 60 * 1000  // 24 hours in milliseconds
  }, secret);
}

// ── Key authorization helpers ─────────────────────────────────────────────────
// isKeyReadable: can this session READ the given key?
// isKeyWritable: can this session WRITE (set/delete) the given key?
// Staff users may read admin data but can only write their own user: record.

function isKeyReadable(key, session) {
  if (!key || typeof key !== 'string') return false;
  const { sub: username, type: userType, adminUsername } = session;
  if (userType === 'dev') return true;
  if (userType === 'staff') {
    const adminNs = adminUsername || username;
    return (
      key === `user:${username}` ||
      key.startsWith(`${adminNs}:`) ||
      key.startsWith('staffPortal:')
    );
  }
  // Admin
  return (
    key === `user:${username}` ||
    key.startsWith(`${username}:`) ||
    key.startsWith('user:') ||
    key.startsWith('staffPortal:') ||
    key.startsWith('managers:')
  );
}

function isKeyWritable(key, session) {
  if (!key || typeof key !== 'string') return false;
  const { sub: username, type: userType, adminUsername } = session;
  if (userType === 'dev') return true;
  // Staff users can ONLY write their own user record (e.g. password change)
  if (userType === 'staff') {
    return key === `user:${username}`;
  }
  // Admin: same as read permissions — admins can write anything they can read
  return isKeyReadable(key, session);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
  }

  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    return new Response(JSON.stringify({ error: "Server misconfigured — SESSION_SECRET not set" }), { status: 500, headers: cors });
  }

  let body;
  try {
    body = await req.json();
  } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: cors });
  }

  const { action } = body;
  const store = getStore(STORE_NAME);

  // Derive client IP for rate limiting
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                   req.headers.get('x-real-ip') || 'unknown';

  // ── Public actions — no session required ──────────────────────────────────

  if (action === 'login') {
    if (checkRateLimit(clientIp, 'login')) {
      return new Response(JSON.stringify({ error: "Too many login attempts. Please wait a minute." }), { status: 429, headers: cors });
    }
    const { username, password } = body;
    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password required" }), { status: 400, headers: cors });
    }
    try {
      const raw = await store.get(`user:${username}`);
      if (raw == null) {
        return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401, headers: cors });
      }
      const record = JSON.parse(raw);
      const h = await hashPassword(password);
      if (record.password !== h) {
        // Plaintext legacy account — migrate hash on the fly
        if (record.password !== password) {
          return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401, headers: cors });
        }
        record.password = h;
        await store.set(`user:${username}`, JSON.stringify(record));
      }
      const u = {
        username,
        email:         record.email        || '',
        userType:      record.userType      || 'admin',
        adminUsername: record.adminUsername || null,
        staffId:       record.staffId       || null,
      };
      const token = await issueToken(username, u.userType, u.adminUsername, SESSION_SECRET);
      return new Response(JSON.stringify({ token, user: u }), { status: 200, headers: cors });
    } catch(e) {
      console.error('Login error:', e);
      return new Response(JSON.stringify({ error: "Login failed" }), { status: 500, headers: cors });
    }
  }

  if (action === 'register') {
    if (checkRateLimit(clientIp, 'register')) {
      return new Response(JSON.stringify({ error: "Too many registration attempts. Please wait a minute." }), { status: 429, headers: cors });
    }
    const { username, password, email, userType } = body;
    if (!username || !password || !email) {
      return new Response(JSON.stringify({ error: "Username, password, and email required" }), { status: 400, headers: cors });
    }
    // Validate username: alphanumeric, underscores, dots, hyphens; 2–50 chars
    if (!/^[a-zA-Z0-9_.-]{2,50}$/.test(username)) {
      return new Response(JSON.stringify({ error: "Username must be 2-50 characters and contain only letters, numbers, underscores, dots, or hyphens" }), { status: 400, headers: cors });
    }
    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), { status: 400, headers: cors });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: cors });
    }
    if (password.length > 128) {
      return new Response(JSON.stringify({ error: "Password must be 128 characters or fewer" }), { status: 400, headers: cors });
    }
    try {
      const existing = await store.get(`user:${username}`);
      if (existing != null) {
        return new Response(JSON.stringify({ error: "Username already taken" }), { status: 409, headers: cors });
      }
      const record = {
        username,
        email,
        userType: userType || 'admin',
        created:  Date.now(),
        password: await hashPassword(password),
      };
      await store.set(`user:${username}`, JSON.stringify(record));
      const u = { username, email, userType: record.userType, adminUsername: null, staffId: null };
      const token = await issueToken(username, u.userType, null, SESSION_SECRET);
      return new Response(JSON.stringify({ token, user: u }), { status: 200, headers: cors });
    } catch(e) {
      console.error('Register error:', e);
      return new Response(JSON.stringify({ error: "Registration failed" }), { status: 500, headers: cors });
    }
  }

  if (action === 'dev-auth') {
    if (checkRateLimit(clientIp, 'login')) {
      return new Response(JSON.stringify({ error: "Too many attempts. Please wait a minute." }), { status: 429, headers: cors });
    }
    const DEV_PASSWORD = process.env.DEV_PASSWORD;
    const DEV_USERNAME = process.env.DEV_USERNAME;
    if (!DEV_PASSWORD || !DEV_USERNAME) {
      return new Response(JSON.stringify({ error: "Dev credentials not configured" }), { status: 500, headers: cors });
    }
    if (body.password !== DEV_PASSWORD) {
      return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers: cors });
    }
    const token = await issueToken(DEV_USERNAME, 'dev', null, SESSION_SECRET);
    return new Response(JSON.stringify({ username: DEV_USERNAME, token }), { status: 200, headers: cors });
  }

  if (action === 'forgot-password') {
    if (checkRateLimit(clientIp, 'forgot-password')) {
      return new Response(JSON.stringify({ error: "Too many requests. Please wait a minute." }), { status: 429, headers: cors });
    }
    const { email } = body;
    if (!email) return new Response(JSON.stringify({ error: "Email required" }), { status: 400, headers: cors });
    try {
      // Always generate a token's worth of random bytes regardless of whether
      // email exists — prevents timing attacks that reveal registered emails.
      const tokenBytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
      const dummyToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      const result = await store.list();
      const userKeys = (result.blobs || []).map(b => b.key).filter(k => k.startsWith('user:'));
      let foundUsername = null;
      for (const key of userKeys) {
        const raw = await store.get(key);
        if (raw != null) {
          let rec;
          try { rec = JSON.parse(raw); } catch(e) { continue; }
          if (rec.email && rec.email.toLowerCase() === email.toLowerCase()) {
            foundUsername = rec.username;
            break;
          }
        }
      }
      if (!foundUsername) {
        // Always perform a dummy store write to equalize response timing.
        // Without this, a fast "not found" response leaks whether an email is registered.
        try { await store.set(`reset:${dummyToken}:dummy`, 'x'); } catch(e) {}
        try { await store.delete(`reset:${dummyToken}:dummy`); } catch(e) {}
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
      }
      const realTokenBytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
      const resetToken = Array.from(realTokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await store.set(`reset:${resetToken}`, JSON.stringify({ username: foundUsername, expiry: Date.now() + 60 * 60 * 1000 }));
      return new Response(JSON.stringify({ success: true, resetToken }), { status: 200, headers: cors });
    } catch(e) {
      console.error('Forgot-password error:', e);
      return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: cors });
    }
  }

  if (action === 'reset-password') {
    if (checkRateLimit(clientIp, 'reset-password')) {
      return new Response(JSON.stringify({ error: "Too many requests. Please wait a minute." }), { status: 429, headers: cors });
    }
    const { resetToken, newPassword } = body;
    if (!resetToken || !newPassword) {
      return new Response(JSON.stringify({ error: "Reset token and new password required" }), { status: 400, headers: cors });
    }
    if (newPassword.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: cors });
    }
    if (newPassword.length > 128) {
      return new Response(JSON.stringify({ error: "Password must be 128 characters or fewer" }), { status: 400, headers: cors });
    }
    try {
      const tokenData = await store.get(`reset:${resetToken}`);
      if (tokenData == null) return new Response(JSON.stringify({ error: "Invalid or expired reset link" }), { status: 400, headers: cors });
      let tokenRecord;
      try { tokenRecord = JSON.parse(tokenData); } catch(e) {
        await store.delete(`reset:${resetToken}`);
        return new Response(JSON.stringify({ error: "Invalid reset token" }), { status: 400, headers: cors });
      }
      const { username, expiry } = tokenRecord;
      // Invalidate on first use — delete before doing anything else.
      // Any concurrent request will get null from store.get and return 400.
      await store.delete(`reset:${resetToken}`);
      if (Date.now() > expiry) {
        return new Response(JSON.stringify({ error: "Reset link has expired" }), { status: 400, headers: cors });
      }
      const userRaw = await store.get(`user:${username}`);
      if (userRaw == null) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: cors });
      const record = JSON.parse(userRaw);
      record.password = await hashPassword(newPassword);
      await store.set(`user:${username}`, JSON.stringify(record));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
    } catch(e) {
      console.error('Reset-password error:', e);
      return new Response(JSON.stringify({ error: "Reset failed" }), { status: 500, headers: cors });
    }
  }

  // ── Authenticated actions — verify session JWT first ──────────────────────

  const tokenHeader = req.headers.get('x-session-token') || '';
  let session;
  try {
    session = await verifyToken(tokenHeader, SESSION_SECRET);
  } catch(e) {
    return new Response(JSON.stringify({ error: "Unauthorized — " + e.message }), { status: 401, headers: cors });
  }

  try {
    const { key, value, prefix } = body;

    switch (action) {
      case "get": {
        if (!key) return new Response(JSON.stringify({ error: "Key required" }), { status: 400, headers: cors });
        if (!isKeyReadable(key, session)) {
          return new Response(JSON.stringify({ error: "Forbidden — you do not have access to this key" }), { status: 403, headers: cors });
        }
        const data = await store.get(key);
        if (data == null) {
          return new Response(JSON.stringify({ error: "Key not found", key }), { status: 404, headers: cors });
        }
        return new Response(JSON.stringify({ key, value: data }), { status: 200, headers: cors });
      }

      case "set": {
        if (!key) return new Response(JSON.stringify({ error: "Key required" }), { status: 400, headers: cors });
        if (!isKeyWritable(key, session)) {
          return new Response(JSON.stringify({ error: "Forbidden — you do not have write access to this key" }), { status: 403, headers: cors });
        }
        await store.set(key, value);
        return new Response(JSON.stringify({ key, value, success: true }), { status: 200, headers: cors });
      }

      case "delete": {
        if (!key) return new Response(JSON.stringify({ error: "Key required" }), { status: 400, headers: cors });
        if (!isKeyWritable(key, session)) {
          return new Response(JSON.stringify({ error: "Forbidden — you do not have write access to this key" }), { status: 403, headers: cors });
        }
        await store.delete(key);
        return new Response(JSON.stringify({ key, deleted: true }), { status: 200, headers: cors });
      }

      case "list": {
        const result = await store.list();
        let keys = result.blobs.map(b => b.key);
        if (prefix) {
          keys = keys.filter(k => k.startsWith(prefix));
        }
        // Filter list results to only keys the session is authorized to see
        keys = keys.filter(k => isKeyReadable(k, session));
        return new Response(JSON.stringify({ keys, prefix: prefix || null }), { status: 200, headers: cors });
      }

      case "set-batch": {
        const entries = Array.isArray(body.entries) ? body.entries : [];
        if (entries.length > 200) {
          return new Response(JSON.stringify({ error: "set-batch limit is 200 entries per call" }), { status: 400, headers: cors });
        }
        // Two-pass: authorize ALL entries before writing ANY
        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string') continue;
          if (!isKeyWritable(entry.key, session)) {
            return new Response(JSON.stringify({ error: `Forbidden — not authorized to write key: ${entry.key}` }), { status: 403, headers: cors });
          }
          if (entry.value && typeof entry.value === 'string' && entry.value.length > 512 * 1024) {
            return new Response(JSON.stringify({ error: `Value too large for key: ${entry.key} (max 512KB)` }), { status: 400, headers: cors });
          }
        }
        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string') continue;
          await store.set(entry.key, entry.value);
        }
        return new Response(JSON.stringify({ success: true, count: entries.length }), { status: 200, headers: cors });
      }

      case "ensure-cve-account": {
        // Create the CVE admin account if it doesn't exist.
        // Restricted to dev accounts — regular users have no business calling this.
        if (session.type !== 'dev') {
          return new Response(JSON.stringify({ error: "Forbidden — dev account required" }), { status: 403, headers: cors });
        }
        const CVE_USER = process.env.CVE_USER;
        const CVE_PASS = process.env.CVE_PASS;
        const DEV_USERNAME = process.env.DEV_USERNAME;
        if (!CVE_USER || !CVE_PASS) {
          return new Response(JSON.stringify({ error: "CVE credentials not configured" }), { status: 500, headers: cors });
        }
        const existing = await store.get(`user:${CVE_USER}`);
        if (existing != null) {
          return new Response(JSON.stringify({ success: true, existed: true }), { status: 200, headers: cors });
        }
        const hash = await hashPassword(CVE_PASS);
        await store.set(`user:${CVE_USER}`, JSON.stringify({ username: CVE_USER, password: hash, userType: 'admin', created: Date.now() }));
        if (DEV_USERNAME) {
          const dataKeys = ['staff', 'locations', 'rules', 'holidays', 'vacations', 'schedules', 'finalPlans'];
          for (const k of dataKeys) {
            try {
              const data = await store.get(`${DEV_USERNAME}:${k}`);
              if (data != null) await store.set(`${CVE_USER}:${k}`, data);
            } catch(e) {}
          }
        }
        return new Response(JSON.stringify({ success: true, existed: false }), { status: 200, headers: cors });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action: " + action }), { status: 400, headers: cors });
    }
  } catch (err) {
    console.error('Storage error:', err);
    return new Response(JSON.stringify({ error: "Storage error: " + err.message }), { status: 500, headers: cors });
  }
};
