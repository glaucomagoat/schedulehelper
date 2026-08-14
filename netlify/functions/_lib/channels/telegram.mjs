// Telegram Bot API adapter. No SDK — one HTTPS call.
//
// Delivery status here is SYNCHRONOUS, which is the channel's real advantage: a 200
// with a message_id means it reached the device, and a 403 tells us immediately and
// unambiguously that the person is unreachable. Email can only tell us later, and SMS
// carriers often never tell us at all.

const API = "https://api.telegram.org/bot";

export const id = "telegram";
export const label = "Telegram";

export function isConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

// Telegram treats these as permanent: the person blocked the bot, deleted their
// account, or never started the chat. Retrying is pointless — the binding should be
// cleared and the coordinator told.
function isPermanentFailure(description) {
  return /blocked by the user|chat not found|user is deactivated|bot was kicked|PEER_ID_INVALID/i
    .test(String(description || ""));
}

export async function send({ tech, contact, message }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, status: "not_configured", error: "TELEGRAM_BOT_TOKEN not set" };

  const chatId = contact && contact.telegramChatId;
  if (!chatId) return { ok: false, status: "no_target", error: "No Telegram chat linked" };
  if (!message.telegramText) return { ok: false, status: "no_target", error: "Message has no Telegram body" };

  const payload = {
    chat_id: String(chatId),
    text: message.telegramText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (message.link) {
    payload.reply_markup = { inline_keyboard: [[{ text: "📋 View full board", url: message.link }]] };
  }

  let res, data;
  try {
    res = await fetch(API + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json();
  } catch (e) {
    return { ok: false, status: "failed", error: "Network error: " + e.message };
  }

  if (!data || data.ok !== true) {
    const desc = (data && data.description) || ("HTTP " + (res ? res.status : "?"));
    return {
      ok: false,
      status: isPermanentFailure(desc) ? "unreachable" : "failed",
      error: desc,
    };
  }

  return { ok: true, status: "delivered", externalId: String(data.result.message_id) };
}
