import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";

// storage-proxy is called exclusively from the same Netlify origin as the app.
// Same-origin requests don't need CORS headers, so we omit Allow-Origin entirely.
const cors = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-session-token",
  "Content-Type": "application/json"
};

// ── JWT / crypto helpers ─────────────────────────────────────────────────────

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
    exp:           Date.now() + 24 * 60 * 60 * 1000  // 24 hours
  }, secret);
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

  // ── Public actions — no session required ──────────────────────────────────
  // These are the only entry points for unauthenticated users.
  // All return a signed JWT on success so the client can authenticate further calls.

  if (action === 'login') {
    const { username, password } = body;
    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password required" }), { status: 400, headers: cors });
    }
    try {
      const raw = await store.get(`user:${username}`);
      if (!raw) return new Response(JSON.stringify({ error: "User not found" }), { status: 401, headers: cors });
      const record = JSON.parse(raw);
      const h = await hashPassword(password);
      if (record.password !== h) {
        // Plaintext legacy account — migrate hash on the fly
        if (record.password !== password) {
          return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 401, headers: cors });
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
      return new Response(JSON.stringify({ error: "Login failed" }), { status: 500, headers: cors });
    }
  }

  if (action === 'register') {
    const { username, password, email, userType } = body;
    if (!username || !password || !email) {
      return new Response(JSON.stringify({ error: "Username, password, and email required" }), { status: 400, headers: cors });
    }
    if (!email.includes('@')) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), { status: 400, headers: cors });
    }
    try {
      const existing = await store.get(`user:${username}`);
      if (existing !== null) {
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
      return new Response(JSON.stringify({ error: "Registration failed" }), { status: 500, headers: cors });
    }
  }

  if (action === 'dev-auth') {
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
    const { email } = body;
    if (!email) return new Response(JSON.stringify({ error: "Email required" }), { status: 400, headers: cors });
    try {
      const result = await store.list();
      const userKeys = (result.blobs || []).map(b => b.key).filter(k => k.startsWith('user:'));
      let foundUsername = null;
      for (const key of userKeys) {
        const raw = await store.get(key);
        if (raw) {
          const rec = JSON.parse(raw);
          if (rec.email && rec.email.toLowerCase() === email.toLowerCase()) {
            foundUsername = rec.username;
            break;
          }
        }
      }
      if (!foundUsername) {
        // Don't reveal whether the email is registered
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
      }
      const tokenBytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
      const resetToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await store.set(`reset:${resetToken}`, JSON.stringify({ username: foundUsername, expiry: Date.now() + 60 * 60 * 1000 }));
      return new Response(JSON.stringify({ success: true, resetToken }), { status: 200, headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: cors });
    }
  }

  if (action === 'reset-password') {
    const { resetToken, newPassword } = body;
    if (!resetToken || !newPassword) {
      return new Response(JSON.stringify({ error: "Reset token and new password required" }), { status: 400, headers: cors });
    }
    if (newPassword.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: cors });
    }
    try {
      const tokenData = await store.get(`reset:${resetToken}`);
      if (!tokenData) return new Response(JSON.stringify({ error: "Invalid or expired reset link" }), { status: 400, headers: cors });
      const { username, expiry } = JSON.parse(tokenData);
      if (Date.now() > expiry) {
        await store.delete(`reset:${resetToken}`);
        return new Response(JSON.stringify({ error: "Reset link has expired" }), { status: 400, headers: cors });
      }
      const userRaw = await store.get(`user:${username}`);
      if (!userRaw) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: cors });
      const record = JSON.parse(userRaw);
      record.password = await hashPassword(newPassword);
      await store.set(`user:${username}`, JSON.stringify(record));
      await store.delete(`reset:${resetToken}`);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
    } catch(e) {
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
        const data = await store.get(key);
        if (data === null) {
          return new Response(JSON.stringify({ error: "Key not found", key }), { status: 404, headers: cors });
        }
        return new Response(JSON.stringify({ key, value: data }), { status: 200, headers: cors });
      }

      case "set": {
        await store.set(key, value);
        return new Response(JSON.stringify({ key, value, success: true }), { status: 200, headers: cors });
      }

      case "delete": {
        await store.delete(key);
        return new Response(JSON.stringify({ key, deleted: true }), { status: 200, headers: cors });
      }

      case "list": {
        const result = await store.list();
        let keys = result.blobs.map(b => b.key);
        if (prefix) {
          keys = keys.filter(k => k.startsWith(prefix));
        }
        return new Response(JSON.stringify({ keys, prefix: prefix || null }), { status: 200, headers: cors });
      }

      case "set-batch": {
        const entries = body.entries || [];
        for (const entry of entries) {
          await store.set(entry.key, entry.value);
        }
        return new Response(JSON.stringify({ success: true, count: entries.length }), { status: 200, headers: cors });
      }

      case "ensure-cve-account": {
        // Create the CVE admin account if it doesn't exist.
        // Called after dev login, so a valid session JWT is already present.
        const CVE_USER = process.env.CVE_USER;
        const CVE_PASS = process.env.CVE_PASS;
        const DEV_USERNAME = process.env.DEV_USERNAME;
        if (!CVE_USER || !CVE_PASS) {
          return new Response(JSON.stringify({ error: "CVE credentials not configured" }), { status: 500, headers: cors });
        }
        const existing = await store.get(`user:${CVE_USER}`);
        if (existing !== null) {
          return new Response(JSON.stringify({ success: true, existed: true }), { status: 200, headers: cors });
        }
        const hash = await hashPassword(CVE_PASS);
        await store.set(`user:${CVE_USER}`, JSON.stringify({ username: CVE_USER, password: hash, userType: 'admin', created: Date.now() }));
        if (DEV_USERNAME) {
          const dataKeys = ['staff', 'locations', 'rules', 'holidays', 'vacations', 'schedules', 'finalPlans'];
          for (const k of dataKeys) {
            try {
              const data = await store.get(`${DEV_USERNAME}:${k}`);
              if (data !== null) await store.set(`${CVE_USER}:${k}`, data);
            } catch(e) {}
          }
        }
        return new Response(JSON.stringify({ success: true, existed: false }), { status: 200, headers: cors });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action: " + action }), { status: 400, headers: cors });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: "Storage error: " + err.message }), { status: 500, headers: cors });
  }
};
