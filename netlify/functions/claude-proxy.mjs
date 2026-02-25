// netlify/functions/claude-proxy.mjs
// Forwards requests to the Anthropic API.
// Supports streaming (stream: true) — actively pipes SSE via TransformStream,
// which keeps the Netlify infrastructure connection alive and eliminates 504 timeouts.
// !! DO NOT revert to `new Response(upstream.body)` — passive body pass-through does NOT
// work reliably in Netlify serverless functions and returns an empty 200 body, causing
// "JSON Parse error: Unexpected EOF" on the client. TransformStream is the correct fix. !!
// Also supports non-streaming for the AI chat agent.

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
      // !! USE TransformStream active pipe — NOT `new Response(upstream.body)` !!
      // Passive body pass-through returns an empty 200 in Netlify serverless functions,
      // causing "JSON Parse error: Unexpected EOF" on the client side.
      // TransformStream drives the pipe explicitly so bytes flow reliably to the browser.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { await writer.close(); break; }
            await writer.write(value);
          }
        } catch (e) {
          await writer.abort(e);
        }
      })();

      return new Response(readable, {
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
