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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: JSON_HEADERS });
  }

  // Verify shared secret — same value as STORAGE_SECRET, set in Netlify env vars.
  // This prevents the proxy from being called by anyone outside the app.
  const STORAGE_SECRET = Deno.env.get('STORAGE_SECRET');
  if (!STORAGE_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured — STORAGE_SECRET not set' }), { status: 500, headers: JSON_HEADERS });
  }
  const providedSecret = req.headers.get('x-storage-secret');
  if (!providedSecret || providedSecret !== STORAGE_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
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

  const anthropicPayload = {
    model:      PINNED_MODEL,   // always server-side; ignore body.model
    max_tokens: Math.min(body.max_tokens || 4096, MAX_TOKENS_LIMIT),
    messages:   body.messages   || [],
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
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });

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
    return new Response(JSON.stringify({ error: 'Upstream request failed', detail: err.message }), { status: 502, headers: JSON_HEADERS });
  }
}
