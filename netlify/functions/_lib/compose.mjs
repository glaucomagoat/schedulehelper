// Message composition. One assignment in, one channel-neutral message object out;
// each adapter renders the part it needs.
//
// THE SUBJECT LINE IS THE DESIGN. Email is only a weak notification channel if the
// reader has to open it. Putting the whole assignment in the subject means it renders
// in full on a lock screen, in a mail-app list row, and on a watch face — no open
// required. The body then carries what an SMS never could: the entire day's board.

import {
  summaryLine, renderMineHtml, renderBoardHtml, personalTelegramLines, renderPracticeSummaryTelegram,
} from "./dayboard.mjs";
import {
  fmtShort, fmtLong, escapeHtml, todayIn, dayNoteFor,
  doctorAssignmentFor, techsWithDoctor, locationName,
} from "./techdata.mjs";

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
//
// `prevSummary` is still accepted and still computed by the caller, but is
// deliberately NOT rendered: a change message names only where to go now. Please do
// not "restore" it — showing both sites is how someone reads the wrong one.
export function composeDayMessage(ctx, dk, tech, kind, link, prevSummary) {
  const summary = summaryLine(ctx, dk, tech.id);
  const when = kind === "evening" ? "Tomorrow" : kind === "morning" ? "Today" : "";
  const dayLabel = fmtShort(dk);

  // Change messages must explain themselves — a technician who gets a second message
  // about the same day with no context assumes something is wrong on their end. The
  // read-receipt request is deliberate: a reassignment nobody acknowledges is the one
  // that ends with a room unstaffed.
  const CHANGE_EXPLAINER = "This is a scheduling change due to last-minute staffing changes. "
    + "Please send a text to your Technician Supervisor to confirm you've received this notification.";

  // Change messages state the NEW location only. Naming the old one alongside it is
  // the fastest way to have someone read the wrong half and drive to the wrong site.
  const isOff = summary === "OFF" || summary === "No assignment";
  const whenWord = dk === todayIn((ctx.settings || {}).timezone) ? "today" : "on " + dayLabel;

  let subject, heading;
  if (kind === "change") {
    subject = "⚠ CHANGE " + dayLabel + " — " + summary;
    heading = "Schedule change";
  } else if (kind === "test") {
    subject = "[test] " + dayLabel + " — " + summary;
    heading = "Test message";
  } else {
    subject = when + " " + dayLabel + " — " + summary;
    heading = when + "'s assignment";
  }

  // Telegram: short, scannable, with the link as a tappable button rather than a
  // raw URL. HTML parse mode — only <b>/<i>/<a> are used, all values escaped.
  // Who else is at the site and any duty tag ride along right under the location —
  // the two things a technician actually needs before walking in.
  const detailLines = personalTelegramLines(ctx, dk, tech.id);

  // A change spells out that the site moved and where to go now; the routine
  // evening/morning message just states the assignment.
  const assignmentBlock = kind === "change"
    ? escapeHtml("Your site assignment " + whenWord + " has been changed.") + "\n"
        + (isOff
            ? "<b>" + escapeHtml("You are no longer scheduled " + whenWord + ".") + "</b>"
            : "<b>New location: " + escapeHtml(summary) + "</b>")
        + (detailLines.length ? "\n" + detailLines.join("\n") : "")
    : "📍 <b>" + escapeHtml(summary) + "</b>"
        + (detailLines.length ? "\n" + detailLines.join("\n") : "");

  // A note on the day is exactly the kind of thing someone writes because people
  // need to know it — a 7:45 meeting, a doctor leaving early — so it rides with the
  // assignment rather than living only on the printed sheet.
  const dayNote = dayNoteFor(ctx, dk);

  const telegramText =
    "<b>" + escapeHtml(heading) + "</b>\n"
    + escapeHtml(fmtLong(dk)) + "\n\n"
    + assignmentBlock
    + (dayNote ? "\n📌 " + escapeHtml(dayNote) : "")
    + (kind === "change" ? "\n\n" + escapeHtml(CHANGE_EXPLAINER) : "")
    + "\n\n<i>Commands: /today /tomorrow /week /board</i>";


  const changeExplainerHtml = (kind === "change")
    ? '<div style="font-size:14px;font-weight:700;color:#b91c1c;background:#fef2f2;'
        + 'border:1px solid #fecaca;border-radius:8px;padding:10px 12px;margin:0 0 16px;">'
        + escapeHtml(CHANGE_EXPLAINER) + '</div>'
    : "";

  const noteHtml = dayNote
    ? '<div style="font-size:14px;color:#8a5a00;background:#fff8e6;border:1px solid #f0b429;'
        + 'border-radius:8px;padding:9px 12px;margin:0 0 16px;">📌 ' + escapeHtml(dayNote) + '</div>'
    : "";

  const emailHtml = emailShell(
    renderMineHtml(ctx, dk, tech.id, tech.name)
    + noteHtml
    + changeExplainerHtml
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
    + (dayNote ? "Note: " + dayNote + "\n" : "")
    + (kind === "change" ? "\n" + CHANGE_EXPLAINER + "\n" : "")
    + (link ? "\nFull schedule for everyone: " + link + "\n" : "")
    + "\nThis schedule can change during the day — the link above is always current.";

  return { subject, summary, telegramText, emailHtml, emailText, link, kind, dateKey: dk };
}

// Whole-practice summary for an administrator — every site's doctors AND
// technicians, never a personal assignment (administrators are not scheduled).
// Returns the exact same shape composeDayMessage does, so sendToTech/the channel
// adapters — which only ever look at subject/telegramText/emailHtml/emailText/
// link/kind — need no changes to handle an administrator recipient.
//
// `link` is the same signed day-view link technicians receive. The token carries an
// id rather than a role, and tech-day resolves an administrator's id to the
// whole-practice board — so the button works without any per-role plumbing.
export function composeAdminSummary(ctx, dk, admin, kind, link) {
  const dayLabel = fmtShort(dk);
  const heading = kind === "test" ? "Test message" : "Practice schedule";
  const subject = (kind === "test" ? "[test] " : "") + "Practice schedule — " + dayLabel;

  const telegramText =
    renderPracticeSummaryTelegram(ctx, dk)
    + "\n\n<i>Commands: /today /tomorrow /week /board</i>";

  const headerHtml = '<div style="border-radius:12px;padding:16px;margin-bottom:18px;background:#4f46e5;color:#ffffff;">'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:0.8px;opacity:0.85;">'
    + escapeHtml(String((admin && admin.name) || "Administrator").toUpperCase()) + ' &middot; ' + escapeHtml(dayLabel) + '</div>'
    + '<div style="font-size:20px;font-weight:800;margin-top:6px;line-height:1.25;">Whole-practice schedule</div>'
    + '</div>';

  const emailHtml = emailShell(
    headerHtml
    + '<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;color:#6b7280;margin:0 0 8px;">EVERYONE ON '
    + escapeHtml(dayLabel.toUpperCase()) + '</div>'
    + renderBoardHtml(ctx, dk, null),
    link
  );

  const emailText =
    heading + "\n" + fmtLong(dk) + "\n\n"
    + "Whole-practice schedule — every site with its doctors and technicians."
    + (link ? "\nFull schedule: " + link + "\n" : "")
    + "\nThis schedule can change during the day.";

  return { subject, telegramText, emailHtml, emailText, link, kind, dateKey: dk };
}

// A doctor's own message — their own site(s) plus who is working with them there.
// Doctors get the evening/morning sends only, NEVER a change alert (callers must
// filter `kind === "change"` out before reaching here — see buildDoctorRecipients
// in sendjob.mjs). Returns the exact same shape composeDayMessage does, so the
// channel adapters need no changes to handle a doctor recipient.
//
// `link` is the same signed day-view link technicians and administrators receive —
// the token carries an id, not a role.
export function composeDoctorMessage(ctx, dk, doctor, kind, link) {
  const dayLabel = fmtShort(dk);
  const when = kind === "evening" ? "Tomorrow" : kind === "morning" ? "Today" : "";

  const a = doctorAssignmentFor(ctx, dk, doctor.id);
  const amOff = !a.am || a.am === "OFF";
  const pmOff = !a.pm || a.pm === "OFF";
  const isOff = amOff && pmOff;

  // Mirrors summaryLine's "state both halves when they differ" rule exactly — the
  // single most important requirement here. A doctor working Manteca AM and
  // Stockton PM must never see a summary that only names one of them.
  let summary;
  if (isOff) {
    summary = "Not scheduled";
  } else if (a.am === a.pm) {
    summary = locationName(ctx, a.am) + " all day";
  } else if (amOff) {
    summary = locationName(ctx, a.pm) + " PM (off AM)";
  } else if (pmOff) {
    summary = locationName(ctx, a.am) + " AM (off PM)";
  } else {
    summary = locationName(ctx, a.am) + " AM, " + locationName(ctx, a.pm) + " PM";
  }

  let subject, heading;
  if (kind === "test") {
    subject = "[test] " + dayLabel + " — " + summary;
    heading = "Test message";
  } else {
    subject = when + " " + dayLabel + " — " + summary;
    heading = when + "'s assignment";
  }

  // Who is working WITH the doctor, at their own site(s) — resolved through
  // techsWithDoctor so a technician borrowed into a sub-room still counts.
  const amTechs = amOff ? [] : techsWithDoctor(ctx, dk, a.am, "am");
  const pmTechs = pmOff ? [] : techsWithDoctor(ctx, dk, a.pm, "pm");
  const sameAllDay = !isOff && a.am === a.pm;

  // A doctor at one site all day can still have DIFFERENT technicians morning and
  // afternoon — half-days are normal. Collapsing to one list would silently drop the
  // PM-only technician from the message, so the halves are only merged when the
  // rosters genuinely match.
  const sameTechsBothHalves = amTechs.length === pmTechs.length
    && amTechs.every((n, i) => n === pmTechs[i]);

  const telegramDetailLines = [];
  if (!isOff) {
    if (sameAllDay && sameTechsBothHalves) {
      if (amTechs.length) telegramDetailLines.push("👥 With: " + escapeHtml(amTechs.join(", ")));
    } else {
      const parts = [];
      if (!amOff) parts.push("AM: " + (amTechs.length ? escapeHtml(amTechs.join(", ")) : "no techs assigned"));
      if (!pmOff) parts.push("PM: " + (pmTechs.length ? escapeHtml(pmTechs.join(", ")) : "no techs assigned"));
      if (parts.length) telegramDetailLines.push("👥 " + parts.join(" · "));
    }
  }

  const dayNote = dayNoteFor(ctx, dk);

  const telegramText =
    "<b>" + escapeHtml(heading) + "</b>\n"
    + escapeHtml(fmtLong(dk)) + "\n\n"
    + (isOff ? "<b>" + escapeHtml(summary) + "</b>" : "📍 <b>" + escapeHtml(summary) + "</b>")
    + (telegramDetailLines.length ? "\n" + telegramDetailLines.join("\n") : "")
    + (dayNote ? "\n📌 " + escapeHtml(dayNote) : "")
    + "\n\n<i>Commands: /today /tomorrow /week /board</i>";

  const cardHtml = '<div style="border-radius:12px;padding:16px;margin-bottom:18px;'
    + 'background:' + (isOff ? '#f3f4f6' : '#4f46e5') + ';color:' + (isOff ? '#4b5563' : '#ffffff') + ';">'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:0.8px;opacity:0.85;">'
    + escapeHtml(String(doctor.name || "").toUpperCase()) + ' &middot; ' + escapeHtml(dayLabel) + '</div>'
    + '<div style="font-size:22px;font-weight:800;margin-top:6px;line-height:1.25;">' + escapeHtml(summary) + '</div>'
    + '</div>';

  let techsHtml = "";
  if (!isOff) {
    if (sameAllDay) {
      if (amTechs.length) {
        techsHtml = '<div style="font-size:14px;color:#3b4252;margin:0 0 16px;"><b>With:</b> ' + escapeHtml(amTechs.join(", ")) + '</div>';
      }
    } else {
      const rows = [];
      if (!amOff) rows.push('<div style="margin-bottom:4px;"><b>AM:</b> ' + (amTechs.length ? escapeHtml(amTechs.join(", ")) : '<span style="color:#9ca3af;">no techs assigned</span>') + '</div>');
      if (!pmOff) rows.push('<div><b>PM:</b> ' + (pmTechs.length ? escapeHtml(pmTechs.join(", ")) : '<span style="color:#9ca3af;">no techs assigned</span>') + '</div>');
      if (rows.length) techsHtml = '<div style="font-size:14px;color:#3b4252;margin:0 0 16px;">' + rows.join("") + '</div>';
    }
  }

  const noteHtml = dayNote
    ? '<div style="font-size:14px;color:#8a5a00;background:#fff8e6;border:1px solid #f0b429;'
        + 'border-radius:8px;padding:9px 12px;margin:0 0 16px;">📌 ' + escapeHtml(dayNote) + '</div>'
    : "";

  const emailHtml = emailShell(cardHtml + techsHtml + noteHtml, link);

  let techsText = "";
  if (!isOff) {
    if (sameAllDay) {
      if (amTechs.length) techsText = "With: " + amTechs.join(", ") + "\n";
    } else {
      if (!amOff) techsText += "AM: " + (amTechs.length ? amTechs.join(", ") : "no techs assigned") + "\n";
      if (!pmOff) techsText += "PM: " + (pmTechs.length ? pmTechs.join(", ") : "no techs assigned") + "\n";
    }
  }

  const emailText =
    heading + "\n" + fmtLong(dk) + "\n\n"
    + summary + "\n"
    + techsText
    + (dayNote ? "Note: " + dayNote + "\n" : "")
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
