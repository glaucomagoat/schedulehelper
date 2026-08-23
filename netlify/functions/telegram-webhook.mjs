// Telegram inbound webhook: binds technicians to the bot, and handles /today,
// /tomorrow, /week (alias /thisweek), /board, and /stop.
//
// This is the ONLY way a chat_id can ever be learned — Telegram bots cannot message
// someone who has not started the conversation. That constraint is the whole reason
// the invite link exists, and why email has to bootstrap Telegram rather than the
// other way round.

import {
  techStore, loadContext, readJson, writeJson, ADMIN, todayIn,
  addDays, dayOfWeek, fmtShort, fmtLong, escapeHtml, activeTechs, assignmentsFor, dayNoteFor,
  doctorAssignmentFor, techsWithDoctor, locationName,
} from "./_lib/techdata.mjs";
import { verifyInviteToken, makeTechToken, newNonce, dayLinkFor } from "./_lib/links.mjs";
import { summaryLine, personalTelegramLines, renderPracticeSummaryTelegram } from "./_lib/dayboard.mjs";

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

// A doctor's own day, in the shape /today, /tomorrow and /week all need: the
// location summary (both halves stated when they differ — see compose.mjs's
// composeDoctorMessage, which this mirrors) plus who is working with them there.
// Kept local rather than reusing composeDoctorMessage because that also builds the
// subject/heading/footer a push notification needs, none of which belongs in a
// direct reply to a command someone just typed.
function doctorDaySummary(ctx, dk, doctor) {
  const a = doctorAssignmentFor(ctx, dk, doctor.id);
  const amOff = !a.am || a.am === "OFF";
  const pmOff = !a.pm || a.pm === "OFF";
  const isOff = amOff && pmOff;

  let summary;
  if (isOff) summary = "Not scheduled";
  else if (a.am === a.pm) summary = locationName(ctx, a.am) + " all day";
  else if (amOff) summary = locationName(ctx, a.pm) + " PM (off AM)";
  else if (pmOff) summary = locationName(ctx, a.am) + " AM (off PM)";
  else summary = locationName(ctx, a.am) + " AM, " + locationName(ctx, a.pm) + " PM";

  const amTechs = amOff ? [] : techsWithDoctor(ctx, dk, a.am, "am");
  const pmTechs = pmOff ? [] : techsWithDoctor(ctx, dk, a.pm, "pm");
  const sameAllDay = !isOff && a.am === a.pm;

  const lines = [];
  if (!isOff) {
    if (sameAllDay) {
      if (amTechs.length) lines.push("👥 With: " + escapeHtml(amTechs.join(", ")));
    } else {
      const parts = [];
      if (!amOff) parts.push("AM: " + (amTechs.length ? escapeHtml(amTechs.join(", ")) : "no techs assigned"));
      if (!pmOff) parts.push("PM: " + (pmTechs.length ? escapeHtml(pmTechs.join(", ")) : "no techs assigned"));
      if (parts.length) lines.push("👥 " + parts.join(" · "));
    }
  }
  return { isOff, summary, lines };
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
      // The nonce getter is id-agnostic — it just looks up whatever id the token
      // names in the shared contacts map — so the same verifyInviteToken call binds
      // either a technician's or an administrator's invite with no branching here.
      const techId = await verifyInviteToken(payload, LINK_SECRET, id => (contacts[id] || {}).linkNonce);
      if (!techId) {
        await reply(chatId, "That invite link is not valid any more. Please ask the scheduling coordinator for a new one.");
        return ok();
      }

      const ctx = await loadContext(store);
      const tech = ctx.techs.find(t => t.id === techId);
      // Administrators are NOT technicians (never scheduled, never on the grid) —
      // resolved separately, and only when techId did not match a technician.
      const admin = tech ? null : (ctx.techAdmins || []).find(a => a.id === techId);
      // Doctors are neither — resolved last, from ctx.doctors (the `staff` blob).
      // Their id prefix ("s...") can never collide with a technician's ("t...") or
      // an administrator's ("a..."), so this chain never has to guess.
      // NOT filtered on `active`: that flag gates AI generation, not presence (see
      // notifiableDoctors in techdata.mjs). Filtering here told an inactive-but-
      // scheduled doctor their account was gone and refused to bind them, which
      // made them permanently unreachable no matter what the admin panel showed.
      const doctor = (tech || admin) ? null : (ctx.doctors || []).find(d => d.id === techId);
      const person = tech || admin || doctor;
      if (!person) { await reply(chatId, "That account is no longer on the schedule."); return ok(); }

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
        "✅ Linked, " + person.name.split(" ")[0] + ".\n\n"
        + (admin
            ? "You'll get the whole practice's schedule here the night before and again in the morning.\n\nSend /today for today's schedule, /week for the full week, or /board to see it now."
            : doctor
              ? "You'll get your own site assignment here the night before and again in the morning, along with who is working with you there.\n\nSend /today for your assignment, /week for the full week, or /board to see everyone's."
              : "You'll get your site assignment here the night before and again in the morning, "
                + "plus an alert if anything changes.\n\nSend /today for your assignment, /week for the full week, or /board to see everyone's."));
      return ok();
    }

    if (text.startsWith("/stop")) {
      // Works unchanged for an administrator too: this scans the shared contacts
      // map by chatId, never by technician-specific lookup, so no branching is
      // needed here at all.
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
      if (!techId) { await reply(chatId, "This chat is not linked yet. Use your personal invite link first."); return ok(); }
      const today = todayIn(ctx.settings.timezone);
      const isTomorrow = text.startsWith("/tomorrow");
      const dk = isTomorrow
        ? new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)
        : today;

      // Administrators are not scheduled — they get the whole-practice view. Its
      // header already names the actual date (fmtLong via renderPracticeSummaryTelegram),
      // which is exactly the "name the date, not just Today" rule the personal
      // reply below follows too.
      const admin = (ctx.techAdmins || []).find(a => a.id === techId);
      if (admin) {
        await reply(chatId, renderPracticeSummaryTelegram(ctx, dk));
        return ok();
      }

      // A doctor gets their own location(s) and who is working with them there —
      // never a technician's personal assignment line.
      const doctor = (ctx.doctors || []).find(d => d.id === techId);
      if (doctor) {
        const d = doctorDaySummary(ctx, dk, doctor);
        const note = dayNoteFor(ctx, dk);
        await reply(chatId,
          "<b>" + (isTomorrow ? "Tomorrow" : "Today") + "</b>\n"
          + escapeHtml(fmtLong(dk)) + "\n\n"
          + (d.isOff ? "<b>" + escapeHtml(d.summary) + "</b>" : "📍 " + escapeHtml(d.summary))
          + (d.lines.length ? "\n" + d.lines.join("\n") : "")
          + (note ? "\n📌 " + escapeHtml(note) : ""));
        return ok();
      }

      const tech = ctx.techs.find(t => t.id === techId);
      const summary = summaryLine(ctx, dk, tech.id);
      const detailLines = personalTelegramLines(ctx, dk, tech.id);
      // Name the actual date, not just "Today". Someone reading a notification hours
      // later, or scrolling back through the chat, cannot tell which day a bare
      // "Today" referred to.
      const note = dayNoteFor(ctx, dk);
      await reply(chatId,
        "<b>" + (isTomorrow ? "Tomorrow" : "Today") + "</b>\n"
        + escapeHtml(fmtLong(dk)) + "\n\n"
        + "📍 " + escapeHtml(summary)
        + (detailLines.length ? "\n" + detailLines.join("\n") : "")
        + (note ? "\n📌 " + escapeHtml(note) : ""));
      return ok();
    }

    if (text.startsWith("/thisweek") || text.startsWith("/week")) {
      const ctx = await loadContext(store);
      const techId = Object.keys(ctx.contacts).find(id => String(ctx.contacts[id].telegramChatId) === String(chatId));
      if (!techId) { await reply(chatId, "This chat is not linked yet. Use your personal invite link first."); return ok(); }

      const today = todayIn(ctx.settings.timezone);
      // Monday-first, matching the week the scheduler itself works in.
      const monday = addDays(today, dayOfWeek(today) === 0 ? -6 : 1 - dayOfWeek(today));

      // Administrators are not scheduled — they get the whole-practice view for
      // each day of the week rather than a personal line, sent as one message per
      // day (renderPracticeSummaryTelegram's output can already run long for a
      // single day; stacking every site for 5-6 days into one Telegram message
      // risks the 4096-char limit, so this reuses the exact same per-day renderer
      // the /today command uses instead of inventing a condensed week format).
      // "Does this week run a Saturday" is asked the same way the personal /week
      // view below asks it — whether ANY active technician actually works it —
      // rather than introducing a second definition of a working Saturday.
      const admin = (ctx.techAdmins || []).find(a => a.id === techId);
      if (admin) {
        const satDk = addDays(monday, 5);
        const satAssignments = assignmentsFor(ctx, satDk);
        const satWorked = activeTechs(ctx).some(t => {
          const a = satAssignments[t.id];
          return a && ((a.am && a.am !== "OFF") || (a.pm && a.pm !== "OFF"));
        });
        const weekDays = [0, 1, 2, 3, 4].map(i => addDays(monday, i)).concat(satWorked ? [satDk] : []);
        await reply(chatId, "<b>This week — whole practice</b>");
        for (const wdk of weekDays) {
          await reply(chatId, renderPracticeSummaryTelegram(ctx, wdk));
        }
        return ok();
      }

      // A doctor gets their own week — same per-day shape /today uses, never a
      // technician's personal line. Saturday is included only when they actually
      // have something on it that week, same rule the technician view below uses.
      const doctor = (ctx.doctors || []).find(dr => dr.id === techId);
      if (doctor) {
        const days = [0, 1, 2, 3, 4, 5].map(i => addDays(monday, i));
        const rows = days
          .map((dk, i) => ({ dk, i, d: doctorDaySummary(ctx, dk, doctor) }))
          .filter(r => r.i < 5 || !r.d.isOff);

        const body = rows.map(r => {
          const head = "<b>" + escapeHtml(fmtShort(r.dk)) + "</b>" + (r.dk === today ? " ◂ today" : "");
          if (r.d.isOff) return head + "\n<i>" + escapeHtml(r.d.summary) + "</i>";
          const dnote = dayNoteFor(ctx, r.dk);
          return [head, "📍 " + escapeHtml(r.d.summary)]
            .concat(r.d.lines)
            .concat(dnote ? ["📌 " + escapeHtml(dnote)] : [])
            .join("\n");
        }).join("\n\n");

        const range = escapeHtml(fmtShort(rows.length ? rows[0].dk : days[0])
          + " – " + fmtShort(rows.length ? rows[rows.length - 1].dk : days[4]));
        await reply(chatId, "<b>This week</b>\n<i>" + range + "</i>\n\n" + body);
        return ok();
      }

      // Saturday is included only when this technician actually has something on
      // it — most weeks don't run a Saturday clinic, and a bare "OFF" line adds
      // nothing.
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
        const dnote = dayNoteFor(ctx, d.dk);
        return [head, "📍 " + escapeHtml(d.line)]
          .concat(personalTelegramLines(ctx, d.dk, techId))
          .concat(dnote ? ["📌 " + escapeHtml(dnote)] : [])
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
      if (!techId) { await reply(chatId, "This chat is not linked yet. Use your personal invite link first."); return ok(); }

      // Cheap admin check (no full loadContext) so the technician path below keeps
      // its original cost when the chat is not an administrator's.
      const admins = await readJson(store, ADMIN + ":techAdmins", []);
      const isPracticeAdmin = admins.some(a => a.id === techId);

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

      // Identical affordance either way: the signed link resolves by id, and
      // tech-day renders an administrator the whole-practice view.
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
