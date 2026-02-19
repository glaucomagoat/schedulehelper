// netlify/functions/claude-proxy.mjs
// Forwards requests to the Anthropic API.
// Supports the top-level `system` field for the system/user prompt split.

export default async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Forward the full body as-is — the Anthropic API accepts:
  //   { model, max_tokens, system, messages, ... }
  // The `system` field is a top-level string and is passed straight through.
  const anthropicPayload = {
    model:      body.model      || 'claude-sonnet-4-6',
    max_tokens: body.max_tokens || 4096,
    messages:   body.messages   || [],
  };

  // Only include system if provided (avoids sending empty string)
  if (body.system) {
    anthropicPayload.system = body.system;
  }

  // Pass through any other optional Anthropic fields (temperature, tools, etc.)
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

    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: responseText,
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Upstream request failed', detail: err.message }),
    };
  }
};
