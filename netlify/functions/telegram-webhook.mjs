// Telegram inbound webhook: binds technicians to the bot, and handles /today,
// /tomorrow, /week (alias /thisweek), /board, and /stop.
//
// This is the ONLY way a chat_id can ever be learned — Telegram bots cannot message
// someone who has not started the conversation. That constraint is the whole reason
// the invite link exists, and why email has to bootstrap Telegram rather than the
// other way round.

import {
  techStore, loadContext, readJson, writeJson, ADMIN, todayIn,
  addDays, dayOfWeek, fmtShort, escapeHtml,
} from "./_lib/techdata.mjs";
import { verifyInviteToken, makeTechToken, newNonce, dayLinkFor } from "./_lib/links.mjs";
import { summaryLine, personalTelegramLines } from "./_lib/dayboard.mjs";

// A Response body can be read only once, so this MUST build a new object per
// return. Netlify reuses the module across invocations in a warm container, so a
// single shared instance works for the first request and then throws
// "Response body object should not be disturbed or locked" on every one after —
// surfacing to Telegram as a 502 and an endlessly retried update.
const ok = () => new Response("ok", { status: 200 });

async function reply(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const payload = { chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("telegram-webhook: reply failed", e.message);
  }
}

// Same PUBLIC_BASE_URL-first, request-origin-fallback rule tech-notify.mjs uses for
// every other link it builds — kept in step so a link minted from a chat command
// never points somewhere different than one that rode along with a push.
function baseUrlFor(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  try { return new URL(req.url).origin; } catch (e) { return ""; }
}

function secretOk(req) {
  // Telegram echoes back the secret configured with setWebhook. Without this check
  // anyone who learns the URL could post fake updates and bind themselves to a
  // technician's notifications.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

const SEEN_UPDATES_KEY = ADMIN + ":telegramSeenUpdates";
const SEEN_TTL_MS = 24 * 60 * 60 * 1000; // comfortably longer than Telegram ever keeps retrying
const SEEN_MAX = 500;

// Telegram retries a delivery whenever it does not get a fast 200 back — a cold
// function (e.g. right after a deploy) is exactly the case that trips this. Without
// claiming the update_id first, every retry re-runs the same command, which is what
// turned one /today into six replies. Claiming happens before any other work so a
// fast retry sees it already taken even if the original request is still in flight.
// Fails OPEN: if the store is unreachable this returns false and the command runs
// anyway. The worst case is a repeated reply; throwing here would take the whole bot
// down, which is far worse and is exactly what a 502 in this function looks like.
async function alreadyProcessed(store, updateId) {
  if (updateId == null) return false;
  try {
    const now = Date.now();
    const seen = await readJson(store, SEEN_UPDATES_KEY, {});
    Object.keys(seen).forEach(id => { if (now - seen[id] > SEEN_TTL_MS) delete seen[id]; });
    if (seen[updateId] != null) return true;
    seen[updateId] = now;
    const ids = Object.keys(seen);
    if (ids.length > SEEN_MAX) {
      ids.sort((a, b) => seen[a] - seen[b])
         .slice(0, ids.length - SEEN_MAX)
         .forEach(id => delete seen[id]);
    }
    await writeJson(store, SEEN_UPDATES_KEY, seen);
    return false;
  } catch (e) {
    console.error("telegram-webhook: dedup store unavailable, processing anyway:", e.message);
    return false;
  }
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!secretOk(req)) return new Response("Forbidden", { status: 403 });

  // Everything below is inside one try. A webhook must answer 200 even when it fails
  // internally: any other status makes Telegram retry the same update on a timer, and
  // a persistent error becomes a retry storm that looks, from the outside, like the
  // bot has simply stopped responding.
  try {
    let update;
    try { update = await req.json(); } catch (e) { return ok(); }

    const store = techStore();
    if (await alreadyProcessed(store, update.update_id)) return ok();

    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return ok();             // ignore everything that is not a chat message
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();
    if (!text) return ok();

    const contactsKey = ADMIN + ":techContacts";

    if (text.startsWith("/start")) {
      const payload = text.slice("/start".length).trim();
      if (!payload) {
        await reply(chatId, "Hi! Please use the personal invite link the scheduling coordinator sent you — it links this chat to your name.");
        return ok();
      }
      const LINK_SECRET = process.env.LINK_SECRET;
      if (!LINK_SECRET) { await reply(chatId, "This service is not configured yet. Please tell the scheduling coordinator."); return ok(); }

      const contacts = await readJson(store, contactsKey, {});
      const techId = await verifyInviteToken(payload, LINK_SECRET, id => (contacts[id] || {}).linkNonce);
      if (!techId) {
        await reply(chatId, "That invite link is not valid any more. Please ask the scheduling coordinator for a new one.");
        return ok();
      }

      const ctx = await loadContext(store);
      const tech = ctx.techs.find(t => t.id === techId);
      if (!tech) { await reply(chatId, "That technician is no longer on the schedule."); return ok(); }

      contacts[techId] = Object.assign({}, contacts[techId] || {}, {
        telegramChatId: String(chatId),
        telegramLinkedAt: Date.now(),
        telegramUnreachable: false,
      });
      // Opt them in to Telegram without silently dropping email — belt and braces
      // until the coordinator decides otherwise.
      const chans = contacts[techId].channels || ctx.settings.defaultChannels || ["telegram", "email"];
      if (!chans.includes("telegram")) contacts[techId].channels = ["telegram"].concat(chans);
      await writeJson(store, contactsKey, contacts);

      await reply(chatId,
        "✅ Linked, " + tech.name.split(" ")[0] + ".\n\n"
        + "You'll get your site assignment here the night before and again in the morning, "
        + "plus an alert if anything changes.\n\nSend /today for your assignment, /week for the full week, or /board to see everyone's.");
      return ok();
    }

    if (text.startsWith("/stop")) {
      const contacts = await readJson(store, contactsKey, {});
      const techId = Object.keys(contacts).find(id => String(contacts[id].telegramChatId) === String(chatId));
      if (techId) {
        delete contacts[techId].telegramChatId;
        contacts[techId].channels = (contacts[techId].channels || []).filter(c => c !== "telegram");
        await writeJson(store, contactsKey, contacts);
      }
      await reply(chatId, "Stopped. You will not get schedule messages on Telegram any more. Email still works if it is on file — contact the scheduling coordinator to change that.");
      return ok();
    }

    if (text.startsWith("/today") || text.startsWith("/tomorrow")) {
      const ctx = await loadContext(store);
      const techId = Object.keys(ctx.contacts).find(id => String(ctx.contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return ok(); }
      const tech = ctx.techs.find(t => t.id === techId);
      const today = todayIn(ctx.settings.timezone);
      const isTomorrow = text.startsWith("/tomorrow");
      const dk = isTomorrow
        ? new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)
        : today;
      const summary = summaryLine(ctx, dk, tech.id);
      const detailLines = personalTelegramLines(ctx, dk, tech.id);
      await reply(chatId, "<b>" + (isTomorrow ? "Tomorrow" : "Today") + "</b>\n📍 " + escapeHtml(summary)
        + (detailLines.length ? "\n" + detailLines.join("\n") : ""));
      return ok();
    }

    if (text.startsWith("/thisweek") || text.startsWith("/week")) {
      const ctx = await loadContext(store);
      const techId = Object.keys(ctx.contacts).find(id => String(ctx.contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return ok(); }

      const today = todayIn(ctx.settings.timezone);
      // Monday-first, matching the week the scheduler itself works in. Saturday is
      // included only when this technician actually has something on it — most
      // weeks don't run a Saturday clinic, and a bare "OFF" line adds nothing.
      const monday = addDays(today, dayOfWeek(today) === 0 ? -6 : 1 - dayOfWeek(today));
      const days = [0, 1, 2, 3, 4, 5].map(i => addDays(monday, i));
      const rows = days
        .map((dk, i) => ({ dk, i, line: summaryLine(ctx, dk, techId) }))
        .filter(d => d.i < 5 || (d.line !== "OFF" && d.line !== "No assignment"));

      // One small block per day separated by a blank line. Packing each day onto a
      // single line fits more on screen but wraps into a wall of text on a phone,
      // which is the opposite of what someone glancing at their week needs.
      const body = rows.map(d => {
        const off = d.line === "OFF" || d.line === "No assignment";
        const head = "<b>" + escapeHtml(fmtShort(d.dk)) + "</b>"
          + (d.dk === today ? " ◂ today" : "");
        if (off) return head + "\n<i>Off</i>";
        return [head, "📍 " + escapeHtml(d.line)]
          .concat(personalTelegramLines(ctx, d.dk, techId))
          .join("\n");
      }).join("\n\n");

      const range = escapeHtml(fmtShort(rows.length ? rows[0].dk : days[0])
        + " – " + fmtShort(rows.length ? rows[rows.length - 1].dk : days[4]));
      await reply(chatId, "<b>This week</b>\n<i>" + range + "</i>\n\n" + body);
      return ok();
    }

    if (text.startsWith("/board")) {
      const contacts = await readJson(store, contactsKey, {});
      const techId = Object.keys(contacts).find(id => String(contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return ok(); }

      const LINK_SECRET = process.env.LINK_SECRET;
      if (!LINK_SECRET) { await reply(chatId, "This service is not configured yet. Please tell the scheduling coordinator."); return ok(); }

      // A tech who was bound before ever receiving an invite-links refresh could in
      // principle lack a linkNonce — mint one on the spot rather than dead-ending.
      if (!contacts[techId].linkNonce) {
        contacts[techId].linkNonce = newNonce();
        await writeJson(store, contactsKey, contacts);
      }
      const token = await makeTechToken(techId, contacts[techId].linkNonce, LINK_SECRET);
      const url = dayLinkFor(baseUrlFor(req), token);

      await reply(chatId, "📋 Today's board — everyone, every site.",
        { inline_keyboard: [[{ text: "View full board", url }]] });
      return ok();
    }

    await reply(chatId, "Commands: /today, /tomorrow, /week, /board, /stop");
  } catch (e) {
    console.error("telegram-webhook error:", e);
  }
  return ok();
};
