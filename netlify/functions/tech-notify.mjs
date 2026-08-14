// Admin-authenticated technician operations: link management now, message sending
// in the notification phase. Every action requires an admin session JWT.

import { requireAdmin } from "./_lib/auth.mjs";
import {
  techStore, loadContext, readJson, writeJson, ADMIN,
  isValidDateKey, todayIn,
} from "./_lib/techdata.mjs";
import {
  makeTechToken, newNonce, dayLinkFor, makeInviteToken, inviteLinkFor,
} from "./_lib/links.mjs";
import { composeDayMessage, composeInviteEmail } from "./_lib/compose.mjs";
import { sendToTech, configuredChannels } from "./_lib/notify.mjs";
import { runSendJob } from "./_lib/sendjob.mjs";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: JSON_HEADERS });
}

// The public origin to build links against. PUBLIC_BASE_URL wins; otherwise fall
// back to the origin of the request itself, which is correct for both `netlify dev`
// and deploy previews without needing a per-environment variable.
function baseUrlFor(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  try { return new URL(req.url).origin; } catch (e) { return ""; }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const LINK_SECRET = process.env.LINK_SECRET;
  if (!LINK_SECRET) return json({ error: "Server misconfigured — LINK_SECRET not set" }, 500);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "Invalid JSON body" }, 400); }

  const store = techStore();
  const ctx = await loadContext(store);
  const base = baseUrlFor(req);
  const contactsKey = ADMIN + ":techContacts";

  switch (body.action) {
    // Mint a linkNonce for any tech that lacks one, then hand back every active
    // tech's day-view link. Idempotent: techs that already have a nonce keep it, so
    // calling this repeatedly never invalidates links already in someone's inbox.
    case "ensure-links": {
      const contacts = await readJson(store, contactsKey, {});
      let minted = 0;
      for (const t of ctx.techs) {
        if (t.active === false) continue;
        if (!contacts[t.id]) contacts[t.id] = {};
        if (!contacts[t.id].linkNonce) { contacts[t.id].linkNonce = newNonce(); minted++; }
      }
      if (minted) await writeJson(store, contactsKey, contacts);

      const links = {};
      for (const t of ctx.techs) {
        if (t.active === false) continue;
        const token = await makeTechToken(t.id, contacts[t.id].linkNonce, LINK_SECRET);
        links[t.id] = { token, url: dayLinkFor(base, token, null) };
      }
      return json({ success: true, minted, links });
    }

    // Cut off every link previously sent to one tech — the lost-phone case.
    case "rotate-link": {
      const techId = String(body.techId || "");
      if (!ctx.techs.some(t => t.id === techId)) return json({ error: "Unknown technician" }, 404);
      const contacts = await readJson(store, contactsKey, {});
      contacts[techId] = Object.assign({}, contacts[techId] || {}, { linkNonce: newNonce() });
      await writeJson(store, contactsKey, contacts);
      const token = await makeTechToken(techId, contacts[techId].linkNonce, LINK_SECRET);
      return json({ success: true, techId, token, url: dayLinkFor(base, token, null) });
    }

    // Notify everyone about one day. `kind` is 'evening' (tomorrow's assignments,
    // sent the night before) or 'morning' (today's, sent the morning of).
    case "send-day": {
      const kind = body.kind === "morning" ? "morning" : "evening";
      const dk = isValidDateKey(body.dateKey) ? body.dateKey : null;
      if (!dk) return json({ error: "A valid dateKey (YYYY-MM-DD) is required" }, 400);
      const out = await runSendJob(store, ctx, { dateKey: dk, kind, base, secret: LINK_SECRET });
      return json(Object.assign({ success: true }, out));
    }

    // Notify ONLY the technicians whose own assignment changed since the last send.
    // Messaging the whole roster for one person's change is how people learn to
    // ignore the notifications.
    case "send-changes": {
      const dk = isValidDateKey(body.dateKey) ? body.dateKey : null;
      if (!dk) return json({ error: "A valid dateKey (YYYY-MM-DD) is required" }, 400);
      const out = await runSendJob(store, ctx, { dateKey: dk, kind: "change", base, secret: LINK_SECRET });
      return json(Object.assign({ success: true }, out));
    }

    // Dry run to one technician. Deliberately does NOT touch the log or the snapshot —
    // a test must never make the system think the roster has been notified.
    case "send-test": {
      const techId = String(body.techId || "");
      const tech = ctx.techs.find(t => t.id === techId);
      if (!tech) return json({ error: "Unknown technician" }, 404);
      const dk = isValidDateKey(body.dateKey) ? body.dateKey : todayIn(ctx.settings.timezone);

      const contact = ctx.contacts[techId] || {};
      const link = await linkFor(tech, contact, base, LINK_SECRET, dk);
      const message = composeDayMessage(ctx, dk, tech, "test", link, null);
      const results = await sendToTech(tech, contact, message, ctx.settings);
      return json({ success: true, test: true, subject: message.subject, results });
    }

    // Every active technician's Telegram invite link, plus whether they have already
    // linked. A bot cannot message someone first, so these links are the ONLY route
    // into the channel — and when email is not configured they have to be delivered
    // by hand (QR code, printout, forwarded text). The admin UI renders them.
    case "invite-links": {
      const botUsername = process.env.TELEGRAM_BOT_USERNAME;
      if (!botUsername) return json({ error: "TELEGRAM_BOT_USERNAME is not set" }, 500);

      const contacts = await readJson(store, contactsKey, {});
      let minted = 0;
      for (const t of ctx.techs) {
        if (t.active === false) continue;
        if (!contacts[t.id]) contacts[t.id] = {};
        if (!contacts[t.id].linkNonce) { contacts[t.id].linkNonce = newNonce(); minted++; }
      }
      if (minted) await writeJson(store, contactsKey, contacts);

      const invites = {};
      for (const t of ctx.techs) {
        if (t.active === false) continue;
        const token = await makeInviteToken(t.id, contacts[t.id].linkNonce, LINK_SECRET);
        invites[t.id] = {
          url: inviteLinkFor(botUsername, token),
          linked: !!contacts[t.id].telegramChatId,
          linkedAt: contacts[t.id].telegramLinkedAt || null,
        };
      }
      return json({ success: true, botUsername, minted, invites });
    }

    // Email a technician their invite. Kept working for when email is configured, but
    // NOT an error when it isn't — it returns the link so the coordinator can deliver
    // it another way rather than failing with nothing to show for it.
    case "send-telegram-invite": {
      const techId = String(body.techId || "");
      const tech = ctx.techs.find(t => t.id === techId);
      if (!tech) return json({ error: "Unknown technician" }, 404);

      const botUsername = process.env.TELEGRAM_BOT_USERNAME;
      if (!botUsername) return json({ error: "TELEGRAM_BOT_USERNAME is not set" }, 500);

      const contacts = await readJson(store, contactsKey, {});
      if (!contacts[techId]) contacts[techId] = {};
      if (!contacts[techId].linkNonce) {
        contacts[techId].linkNonce = newNonce();
        await writeJson(store, contactsKey, contacts);
      }
      const inviteToken = await makeInviteToken(techId, contacts[techId].linkNonce, LINK_SECRET);
      const inviteUrl = inviteLinkFor(botUsername, inviteToken);

      if (!configuredChannels().includes("email")) {
        return json({ success: true, inviteUrl, emailUnavailable: true, results: [] });
      }

      const message = composeInviteEmail(tech, inviteUrl, process.env.EMAIL_FROM_NAME);
      // Force the email channel — inviting someone to Telegram over Telegram is circular.
      const results = await sendToTech(tech, contacts[techId], message,
        Object.assign({}, ctx.settings, { defaultChannels: ["email"], fanout: false }));
      return json({ success: true, inviteUrl, results });
    }

    case "channel-status": {
      return json({
        success: true,
        configured: configuredChannels(),
        botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
        baseUrl: base,
      });
    }

    default:
      return json({ error: "Unknown action: " + body.action }, 400);
  }
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function linkFor(tech, contact, base, secret, dk) {
  if (!contact || !contact.linkNonce) return null;
  const token = await makeTechToken(tech.id, contact.linkNonce, secret);
  return dayLinkFor(base, token, dk);
}
