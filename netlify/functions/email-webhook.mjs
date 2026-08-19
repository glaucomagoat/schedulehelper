// Brevo delivery-event webhook.
//
// This is what turns "we called the API" into "it actually arrived". The case that
// matters most is the hard bounce: a technician whose address has quietly gone stale
// would otherwise appear to be notified every single day while receiving nothing.
// Flagging it here is how that surfaces before it costs someone their assignment.
//
// Configure in Brevo as: https://<site>/.netlify/functions/email-webhook?s=<EMAIL_WEBHOOK_SECRET>

import { techStore, readJson, writeJson, ADMIN } from "./_lib/techdata.mjs";
import { updateDeliveryStatus } from "./_lib/sendlog.mjs";

// A Response body can be read only once, so this MUST build a new object per
// return. Netlify reuses the module across invocations in a warm container, so a
// single shared instance works for the first request and then throws
// "Response body object should not be disturbed or locked" on every one after —
// surfacing to Telegram as a 502 and an endlessly retried update.
const ok = () => new Response("ok", { status: 200 });

function secretOk(req) {
  const expected = process.env.EMAIL_WEBHOOK_SECRET || "";
  if (!expected) return false;
  let got = "";
  try { got = new URL(req.url).searchParams.get("s") || ""; } catch (e) { return false; }
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Brevo event names -> our status vocabulary.
const STATUS = {
  delivered: "delivered",
  opened: "opened",
  uniqueOpened: "opened",
  click: "opened",
  soft_bounce: "failed",
  hard_bounce: "unreachable",
  blocked: "unreachable",
  spam: "unreachable",
  invalid_email: "unreachable",
  deferred: "queued",
  error: "failed",
};

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!secretOk(req)) return new Response("Forbidden", { status: 403 });

  let evt;
  try { evt = await req.json(); } catch (e) { return ok(); }

  const events = Array.isArray(evt) ? evt : [evt];
  const store = techStore();

  for (const e of events) {
    const raw = String(e.event || "");
    const status = STATUS[raw];
    if (!status) continue;

    const externalId = e["message-id"] || e.messageId || null;
    if (externalId) {
      await updateDeliveryStatus(store, externalId, status, status === "unreachable" ? raw : null);
    }

    // Permanent failures are recorded against the contact, not just the send, so the
    // email adapter can refuse to keep sending to a dead address.
    if (status === "unreachable" && e.email) {
      try {
        const contactsKey = ADMIN + ":techContacts";
        const contacts = await readJson(store, contactsKey, {});
        const techId = Object.keys(contacts).find(
          id => String(contacts[id].email || "").toLowerCase() === String(e.email).toLowerCase()
        );
        if (techId) {
          contacts[techId] = Object.assign({}, contacts[techId], {
            emailBounced: true, emailBounceReason: raw, emailBouncedAt: Date.now(),
          });
          await writeJson(store, contactsKey, contacts);
        }
      } catch (err) {
        console.error("email-webhook: could not flag bounce", err.message);
      }
    }
  }

  return ok();
};
