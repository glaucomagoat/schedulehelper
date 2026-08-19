// Telegram inbound webhook: binds technicians to the bot, and handles /today,
// /tomorrow, /thisweek, /board, and /stop.
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
import { summaryLine, personalTelegramLines, personalInlineDetail } from "./_lib/dayboard.mjs";

const OK = new Response("ok", { status: 200 });

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
async function alreadyProcessed(store, updateId) {
  if (updateId == null) return false;
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
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!secretOk(req)) return new Response("Forbidden", { status: 403 });

  let update;
  try { update = await req.json(); } catch (e) { return OK; }

  const store = techStore();
  if (await alreadyProcessed(store, update.update_id)) return OK;

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return OK;               // ignore everything that is not a chat message
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  if (!text) return OK;

  const contactsKey = ADMIN + ":techContacts";

  // Always answer 200 to Telegram regardless of what happens below — a non-200 makes
  // Telegram retry the same update indefinitely.
  try {
    if (text.startsWith("/start")) {
      const payload = text.slice("/start".length).trim();
      if (!payload) {
        await reply(chatId, "Hi! Please use the personal invite link the scheduling coordinator sent you — it links this chat to your name.");
        return OK;
      }
      const LINK_SECRET = process.env.LINK_SECRET;
      if (!LINK_SECRET) { await reply(chatId, "This service is not configured yet. Please tell the scheduling coordinator."); return OK; }

      const contacts = await readJson(store, contactsKey, {});
      const techId = await verifyInviteToken(payload, LINK_SECRET, id => (contacts[id] || {}).linkNonce);
      if (!techId) {
        await reply(chatId, "That invite link is not valid any more. Please ask the scheduling coordinator for a new one.");
        return OK;
      }

      const ctx = await loadContext(store);
      const tech = ctx.techs.find(t => t.id === techId);
      if (!tech) { await reply(chatId, "That technician is no longer on the schedule."); return OK; }

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
        + "plus an alert if anything changes.\n\nSend /today for your assignment, /thisweek for the full week, or /board to see everyone's.");
      return OK;
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
      return OK;
    }

    if (text.startsWith("/today") || text.startsWith("/tomorrow")) {
      const ctx = await loadContext(store);
      const techId = Object.keys(ctx.contacts).find(id => String(ctx.contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return OK; }
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
      return OK;
    }

    if (text.startsWith("/thisweek")) {
      const ctx = await loadContext(store);
      const techId = Object.keys(ctx.contacts).find(id => String(ctx.contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return OK; }

      const today = todayIn(ctx.settings.timezone);
      // Monday-first, matching the week the scheduler itself works in. Saturday is
      // included only when this technician actually has something on it — most
      // weeks don't run a Saturday clinic, and a bare "OFF" line adds nothing.
      const monday = addDays(today, dayOfWeek(today) === 0 ? -6 : 1 - dayOfWeek(today));
      const days = [0, 1, 2, 3, 4, 5].map(i => addDays(monday, i));
      const rows = days
        .map((dk, i) => ({ dk, i, line: summaryLine(ctx, dk, techId), detail: personalInlineDetail(ctx, dk, techId) }))
        .filter(d => d.i < 5 || (d.line !== "OFF" && d.line !== "No assignment"));

      // A full multi-line block per day (as /today gets) would run to 15+ lines for
      // a six-day week — the doctors and duty tag ride inline instead, already
      // escaped by personalInlineDetail.
      const body = rows.map(d => {
        const label = escapeHtml(fmtShort(d.dk));
        const line = escapeHtml(d.line) + (d.detail ? " · " + d.detail : "");
        return d.dk === today ? "<b>" + label + " — " + line + "</b> ◂ today" : label + " — " + line;
      }).join("\n");

      await reply(chatId, "<b>This week</b>\n" + body);
      return OK;
    }

    if (text.startsWith("/board")) {
      const contacts = await readJson(store, contactsKey, {});
      const techId = Object.keys(contacts).find(id => String(contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked to a technician yet. Use your personal invite link first."); return OK; }

      const LINK_SECRET = process.env.LINK_SECRET;
      if (!LINK_SECRET) { await reply(chatId, "This service is not configured yet. Please tell the scheduling coordinator."); return OK; }

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
      return OK;
    }

    await reply(chatId, "Commands: /today, /tomorrow, /thisweek, /board, /stop");
  } catch (e) {
    console.error("telegram-webhook error:", e);
  }
  return OK;
};
