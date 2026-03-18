import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";

// storage-proxy is called exclusively from the same Netlify origin as the app.
// Same-origin requests don't need CORS headers, so we omit Allow-Origin entirely.
// This prevents any cross-origin site from making authenticated storage calls.
const cors = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-storage-secret",
  "Content-Type": "application/json"
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: cors
    });
  }

  // Verify shared secret — must match STORAGE_SECRET env var set in Netlify dashboard
  const STORAGE_SECRET = process.env.STORAGE_SECRET;
  if (!STORAGE_SECRET) {
    return new Response(JSON.stringify({ error: "Server misconfigured — STORAGE_SECRET not set" }), {
      status: 500, headers: cors
    });
  }
  const providedSecret = req.headers.get("x-storage-secret");
  if (!providedSecret || providedSecret !== STORAGE_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: cors
    });
  }

  try {
    const body = await req.json();
    const { action, key, value, prefix } = body;
    const store = getStore(STORE_NAME);

    switch (action) {
      case "get": {
        const data = await store.get(key);
        if (data === null) {
          return new Response(JSON.stringify({ error: "Key not found", key }), {
            status: 404, headers: cors
          });
        }
        return new Response(JSON.stringify({ key, value: data }), {
          status: 200, headers: cors
        });
      }

      case "set": {
        await store.set(key, value);
        return new Response(JSON.stringify({ key, value, success: true }), {
          status: 200, headers: cors
        });
      }

      case "delete": {
        await store.delete(key);
        return new Response(JSON.stringify({ key, deleted: true }), {
          status: 200, headers: cors
        });
      }

      case "list": {
        const result = await store.list();
        let keys = result.blobs.map(b => b.key);
        // Filter by prefix if provided
        if (prefix) {
          keys = keys.filter(k => k.startsWith(prefix));
        }
        return new Response(JSON.stringify({ keys, prefix: prefix || null }), {
          status: 200, headers: cors
        });
      }

      case "set-batch": {
        // Bulk set for migration: body.entries = [{key, value}, ...]
        const entries = body.entries || [];
        for (const entry of entries) {
          await store.set(entry.key, entry.value);
        }
        return new Response(JSON.stringify({ success: true, count: entries.length }), {
          status: 200, headers: cors
        });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action: " + action }), {
          status: 400, headers: cors
        });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: "Storage error: " + err.message }), {
      status: 500, headers: cors
    });
  }
};
