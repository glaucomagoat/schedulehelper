// Message composition. One assignment in, one channel-neutral message object out;
// each adapter renders the part it needs.
//
// THE SUBJECT LINE IS THE DESIGN. Email is only a weak notification channel if the
// reader has to open it. Putting the whole assignment in the subject means it renders
// in full on a lock screen, in a mail-app list row, and on a watch face — no open
// required. The body then carries what an SMS never could: the entire day's board.

import { summaryLine, renderMineHtml, renderBoardHtml } from "./dayboard.mjs";
import { fmtShort, fmtLong, escapeHtml } from "./techdata.mjs";

function button(url, label) {
  return '<div style="margin:18px 0;"><a href="' + escapeHtml(url) + '" '
    + 'style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;'
    + 'font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;">' + escapeHtml(label) + '</a></div>';
}

function emailShell(inner, link) {
  return '<div style="background:#f0f0f8;padding:20px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">'
    + '<div style="max-width:560px;margin:0 auto;">' + inner
    + (link ? button(link, "Open the live schedule") : "")
    + '<div style="font-size:12px;color:#9ca3af;line-height:1.6;margin-top:18px;border-top:1px solid #e3e6ef;padding-top:12px;">'
    + 'This schedule can change during the day — the link above is always current. '
    + 'To change how you get these, contact the scheduling coordinator.'
    + '</div></div></div>';
}

// `kind`: 'evening' (tomorrow), 'morning' (today), 'change' (an edit after sending),
// 'test' (a dry run to the admin's own contact details).
export function composeDayMessage(ctx, dk, tech, kind, link, prevSummary) {
  const summary = summaryLine(ctx, dk, tech.id);
  const when = kind === "evening" ? "Tomorrow" : kind === "morning" ? "Today" : "";
  const dayLabel = fmtShort(dk);

  let subject, heading;
  if (kind === "change") {
    subject = "⚠ CHANGE " + dayLabel + " — " + summary;
    heading = "Your assignment changed";
  } else if (kind === "test") {
    subject = "[test] " + dayLabel + " — " + summary;
    heading = "Test message";
  } else {
    subject = when + " " + dayLabel + " — " + summary;
    heading = when + "'s assignment";
  }

  // Telegram: short, scannable, with the link as a tappable button rather than a
  // raw URL. HTML parse mode — only <b>/<i>/<a> are used, all values escaped.
  const telegramText =
    "<b>" + escapeHtml(heading) + "</b>\n"
    + escapeHtml(fmtLong(dk)) + "\n\n"
    + "📍 <b>" + escapeHtml(summary) + "</b>"
    + (kind === "change" && prevSummary ? "\n<i>was: " + escapeHtml(prevSummary) + "</i>" : "");

  const changeNote = (kind === "change" && prevSummary)
    ? '<div style="font-size:14px;color:#6b7280;margin:-8px 0 16px;">Previously: <s>'
        + escapeHtml(prevSummary) + '</s></div>'
    : "";

  const emailHtml = emailShell(
    renderMineHtml(ctx, dk, tech.id, tech.name)
    + changeNote
    + '<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;color:#6b7280;margin:0 0 8px;">EVERYONE ON '
    + escapeHtml(dayLabel.toUpperCase()) + '</div>'
    + renderBoardHtml(ctx, dk, tech.id),
    link
  );

  // Plain-text alternative. Required for deliverability and for anyone reading in a
  // text-only client; it is not an afterthought copy of the subject.
  const emailText =
    heading + "\n" + fmtLong(dk) + "\n\n"
    + summary + "\n"
    + (kind === "change" && prevSummary ? "(was: " + prevSummary + ")\n" : "")
    + (link ? "\nFull schedule for everyone: " + link + "\n" : "")
    + "\nThis schedule can change during the day — the link above is always current.";

  return { subject, summary, telegramText, emailHtml, emailText, link, kind, dateKey: dk };
}

export function composeInviteEmail(tech, inviteUrl, practiceName) {
  const name = practiceName || "the practice";
  return {
    subject: "Get your shift assignments on Telegram",
    telegramText: null,
    emailHtml: emailShell(
      '<div style="background:#ffffff;border-radius:12px;padding:20px;">'
      + '<h1 style="font-size:19px;margin:0 0 10px;">Hi ' + escapeHtml(tech.name.split(" ")[0]) + ',</h1>'
      + '<p style="font-size:14px;line-height:1.65;color:#3b4252;margin:0 0 14px;">'
      + 'You can get your daily site assignment on Telegram instead of — or as well as — email. '
      + 'It arrives instantly and is much harder to miss on a busy morning.</p>'
      + '<p style="font-size:14px;line-height:1.65;color:#3b4252;margin:0 0 6px;">'
      + '<b>Two steps:</b> install Telegram, then tap the button below once. That is the whole setup.</p>'
      + '</div>', inviteUrl),
    emailText:
      "Hi " + tech.name.split(" ")[0] + ",\n\n"
      + "You can get your daily site assignment on Telegram instead of (or as well as) email.\n\n"
      + "Two steps: install Telegram, then open this link once:\n" + inviteUrl + "\n\n"
      + "That is the whole setup. — " + name,
    link: inviteUrl,
    kind: "invite",
  };
}
