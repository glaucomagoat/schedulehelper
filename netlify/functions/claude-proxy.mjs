// netlify/functions/claude-proxy.mjs
// Forwards requests to the Anthropic API.
// Supports streaming (stream: true) — pipes SSE response body directly back to the browser,
// which eliminates Netlify infrastructure inactivity timeouts entirely.
// Also supports non-streaming for the AI chat agent.
// !! DO NOT REMOVE STREAMING — it is required to prevent 504 timeouts on schedule generation !!

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: JSON_HEADERS });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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
    model:      body.model      || 'claude-sonnet-4-6',
    max_tokens: body.max_tokens || 4096,
    messages:   body.messages   || [],
  };

  if (body.system) anthropicPayload.system = body.system;
  if (body.stream) anthropicPayload.stream = true;

  const passthroughFields = ['temperature', 'top_p', 'top_k', 'stop_sequences', 'tools', 'tool_choice', 'metadata'];
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
      // Pipe the SSE stream directly — bytes flow immediately, keeping the
      // Netlify infrastructure connection alive for the full generation duration.
      // This is the ONLY reliable fix for 504 timeouts on long schedule generations.
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
