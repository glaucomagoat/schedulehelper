// netlify/functions/claude-proxy.mjs
// Forwards requests to the Anthropic API.
// Uses the Web API Response format required by .mjs Netlify functions.
// Supports the top-level `system` field for the system/user prompt split.

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

  if (body.system) {
    anthropicPayload.system = body.system;
  }

  const passthroughFields = ['temperature', 'top_p', 'top_k', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'metadata'];
  for (const field of passthroughFields) {
    if (body[field] !== undefined) {
      anthropicPayload[field] = body[field];
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });

    const responseText = await response.text();
    return new Response(responseText, { status: response.status, headers: JSON_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upstream request failed', detail: err.message }), { status: 502, headers: JSON_HEADERS });
  }
}
