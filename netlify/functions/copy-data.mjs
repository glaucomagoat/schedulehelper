import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json"
};

export default async (req) => {
  const store = getStore(STORE_NAME);
  const sourceUser = "mike";
  const targetUser = "cve";
  const targetPass = "brandy";

  try {
    // List all keys
    const result = await store.list();
    const allKeys = result.blobs.map(b => b.key);

    // Find all mike: keys
    const sourceKeys = allKeys.filter(k => k.startsWith(sourceUser + ":"));
    const copied = [];

    for (const key of sourceKeys) {
      const value = await store.get(key);
      if (value !== null) {
        const newKey = targetUser + ":" + key.substring(sourceUser.length + 1);
        await store.set(newKey, value);
        copied.push({ from: key, to: newKey });
      }
    }

    // Also ensure user:cve account record exists
    const userRecord = JSON.stringify({
      username: targetUser,
      password: targetPass,
      created: Date.now()
    });
    await store.set("user:" + targetUser, userRecord);

    return new Response(JSON.stringify({
      success: true,
      message: `Copied ${copied.length} keys from ${sourceUser} to ${targetUser}`,
      copied: copied,
      allKeys: allKeys
    }, null, 2), { status: 200, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack
    }), { status: 500, headers: cors });
  }
};
