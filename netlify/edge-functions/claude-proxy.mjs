// netlify/edge-functions/claude-proxy.mjs
// Edge Function version of the Claude API proxy.
// Edge Functions run on Deno at Netlify's CDN edge and support true streaming —
// bytes flow to the browser token-by-token, so Netlify infrastructure inactivity
// timeouts never fire regardless of how long generation takes.
//
// !! THIS IS THE CORRECT FILE FOR SCHEDULE GENERATION STREAMING !!
// !! netlify/functions/claude-proxy.mjs is the old serverless version — it cannot
//    stream responses and causes "JSON Parse error: Unexpected EOF". Keep it for
//    reference but it is no longer used (netlify.toml routes to this edge function). !!

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Hard cap on tokens per request — prevents a single call from draining budget.
// Schedule generation uses ~4k tokens per batch; chat uses ~1.5k. 16k is generous headroom.
const MAX_TOKENS_LIMIT = 16384;

// Pin the model server-side. Ignoring whatever the client sends prevents a caller
// from switching to a more expensive model.
const PINNED_MODEL = 'claude-sonnet-4-6';

// NOTE: exp in JWT tokens is milliseconds (Date.now() + ms), not JWT standard seconds.
// This is consistent with storage-proxy.mjs — do not change.

// ── JWT verification (same algorithm as storage-proxy.mjs) ───────────────────

function fromB64url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(fromB64url(sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  if (!valid) throw new Error('Invalid token signature');
  const payload = JSON.parse(fromB64url(body));
  // exp is milliseconds (Date.now()-based)
  if (Date.now() > payload.exp) throw new Error('Token expired');
  return payload;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: JSON_HEADERS });
  }

  // Verify session JWT — same SESSION_SECRET used by storage-proxy.
  // Only authenticated users (valid session from login) may call the AI proxy.
  const SESSION_SECRET = Deno.env.get('SESSION_SECRET');
  if (!SESSION_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured — SESSION_SECRET not set' }), { status: 500, headers: JSON_HEADERS });
  }
  const sessionToken = req.headers.get('x-session-token') || '';
  try {
    await verifyToken(sessionToken, SESSION_SECRET);
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Unauthorized — ' + e.message }), { status: 401, headers: JSON_HEADERS });
  }

  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: JSON_HEADERS });
  }

  // Validate messages field
  if (!body.messages || !Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: 'messages must be a non-empty array' }), { status: 400, headers: JSON_HEADERS });
  }

  // Safely parse max_tokens — coerce to number and clamp
  const rawMaxTokens = parseInt(body.max_tokens, 10);
  const maxTokens = Math.min(isNaN(rawMaxTokens) ? 4096 : rawMaxTokens, MAX_TOKENS_LIMIT);

  const anthropicPayload = {
    model:      PINNED_MODEL,   // always server-side; ignore body.model
    max_tokens: maxTokens,
    messages:   body.messages,
  };

  if (body.system) anthropicPayload.system = body.system;
  if (body.stream) anthropicPayload.stream = true;

  // Only pass safe, non-capability-expanding fields. 'tools' and 'tool_choice'
  // are excluded — they enable arbitrary AI tool use that the app doesn't need.
  const passthroughFields = ['temperature', 'top_p', 'top_k', 'stop_sequences'];
  for (const field of passthroughFields) {
    if (body[field] !== undefined) anthropicPayload[field] = body[field];
  }

  try {
    // Add a timeout to avoid hanging indefinitely on upstream failures.
    // Edge functions have a platform-level timeout, but this gives cleaner errors.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (body.stream) {
      // Deno/Edge runtime supports direct body streaming natively —
      // bytes flow immediately from Anthropic to the browser with no buffering.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type':      'text/event-stream',
          'Cache-Control':     'no-cache',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Non-streaming (chat agent): return full JSON response
    const responseText = await upstream.text();
    return new Response(responseText, { status: upstream.status, headers: JSON_HEADERS });

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    const status = isTimeout ? 504 : 502;
    const message = isTimeout ? 'Upstream request timed out' : 'Upstream request failed';
    return new Response(JSON.stringify({ error: message, detail: err.message }), { status, headers: JSON_HEADERS });
  }
}
