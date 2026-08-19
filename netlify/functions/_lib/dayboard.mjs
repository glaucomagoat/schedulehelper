// One renderer, two surfaces: the public /d page and the inline HTML email body.
//
// Everything is inline-styled and self-contained — no external CSS, fonts, images or
// scripts. That is required twice over: the public page must survive a strict CSP and
// a phone on clinic wifi, and email clients strip <style> blocks and external assets.

import {
  activeTechs, assignmentsFor, doctorCoverage, doctorsAt, DUTY_LABELS, locationName,
  fmtLong, fmtShort, escapeHtml, parseDateKey, dayOfWeek, addDays,
} from "./techdata.mjs";

// The one-line version of a person's day. Used for the email SUBJECT and the
// Telegram body, so it must read correctly with no surrounding context.
export function summaryLine(ctx, dk, techId) {
  const a = assignmentsFor(ctx, dk)[techId];
  if (!a || (!a.am && !a.pm)) return "No assignment";
  const am = a.am || "OFF", pm = a.pm || "OFF";
  if (am === "OFF" && pm === "OFF") return "OFF";
  if (am === pm) return locationName(ctx, am) + " all day";
  if (am === "OFF") return locationName(ctx, pm) + " PM (off AM)";
  if (pm === "OFF") return locationName(ctx, am) + " AM (off PM)";
  return locationName(ctx, am) + " AM, " + locationName(ctx, pm) + " PM";
}

// Grouped by site, so a tech can see who they are working with — the thing a flat
// per-person list can never show.
function groupBySite(ctx, dk) {
  const day = assignmentsFor(ctx, dk);
  const techs = activeTechs(ctx);
  const cov = doctorCoverage(ctx, dk);
  const sites = {};

  techs.forEach(t => {
    const a = day[t.id] || {};
    ["am", "pm"].forEach(period => {
      const lid = a[period];
      if (!lid || lid === "OFF") return;
      if (!sites[lid]) sites[lid] = { am: [], pm: [] };
      sites[lid][period].push(t);
    });
  });
  // A site with doctors but no techs is the most important thing to show, so seed
  // from the doctor plan too rather than only from tech assignments.
  Object.keys(cov).forEach(lid => { if (!sites[lid]) sites[lid] = { am: [], pm: [] }; });

  return Object.keys(sites)
    .sort((a, b) => locationName(ctx, a).localeCompare(locationName(ctx, b)))
    .map(lid => ({ id: lid, name: locationName(ctx, lid), techs: sites[lid], doctors: doctorsAt(ctx, dk, lid) }));
}

// Raw per-technician detail for one day — which doctors share each half with them,
// and any duty tag. Channel-neutral; compose.mjs and the Telegram commands each
// format this their own way rather than duplicating the lookup.
export function personalDetail(ctx, dk, techId) {
  const a = assignmentsFor(ctx, dk)[techId] || {};
  const am = a.am || "OFF", pm = a.pm || "OFF";
  return {
    am, pm,
    amDoctors: am !== "OFF" ? (doctorsAt(ctx, dk, am).am || []) : [],
    pmDoctors: pm !== "OFF" ? (doctorsAt(ctx, dk, pm).pm || []) : [],
    duty: a.duty || null,
    dutyLabel: a.duty ? (DUTY_LABELS[a.duty] || a.duty) : null,
  };
}

// Multi-line block for a single day — who else is at the site, and any duty tag.
// Used by the push notifications and by /today and /tomorrow. Empty array when
// there is nothing to add (OFF, or a period with no doctor on the published plan).
export function personalTelegramLines(ctx, dk, techId) {
  const d = personalDetail(ctx, dk, techId);
  const lines = [];
  if (d.am === d.pm) {
    if (d.amDoctors.length) lines.push("👥 With: " + escapeHtml(d.amDoctors.join(", ")));
  } else {
    const parts = [];
    if (d.amDoctors.length) parts.push("AM: " + escapeHtml(d.amDoctors.join(", ")));
    if (d.pmDoctors.length) parts.push("PM: " + escapeHtml(d.pmDoctors.join(", ")));
    if (parts.length) lines.push("👥 " + parts.join(" · "));
  }
  if (d.dutyLabel) lines.push("🎫 " + escapeHtml(d.dutyLabel));
  return lines;
}

// One compact, escaped fragment for a dense week-view line — no emoji, no line
// breaks. "" when there is nothing to add.
export function personalInlineDetail(ctx, dk, techId) {
  const d = personalDetail(ctx, dk, techId);
  const docs = d.am === d.pm ? d.amDoctors : Array.from(new Set(d.amDoctors.concat(d.pmDoctors)));
  const bits = [];
  if (docs.length) bits.push(docs.join(", "));
  if (d.dutyLabel) bits.push(d.dutyLabel);
  return bits.length ? escapeHtml(bits.join(" · ")) : "";
}

function chip(text, highlight) {
  return '<span style="display:inline-block;font-size:13px;font-weight:600;padding:3px 10px;margin:0 4px 4px 0;'
    + 'border-radius:99px;background:' + (highlight ? '#4f46e5' : '#eef0f7') + ';color:' + (highlight ? '#ffffff' : '#3b4252') + ';">'
    + escapeHtml(text) + '</span>';
}

function periodBlock(ctx, label, techList, doctorList, viewerTechId) {
  const docs = doctorList && doctorList.length
    ? '<div style="font-size:12px;color:#6b7280;margin:2px 0 6px;">' + escapeHtml(doctorList.join(", ")) + '</div>'
    : '<div style="font-size:12px;color:#9ca3af;margin:2px 0 6px;">no doctor</div>';
  const people = techList.length
    ? techList.map(t => chip(t.name, t.id === viewerTechId)).join("")
    : '<span style="font-size:13px;color:#9ca3af;font-style:italic;">no techs assigned</span>';
  return '<div style="margin-bottom:10px;">'
    + '<div style="font-size:11px;font-weight:800;letter-spacing:0.8px;color:#6b7280;">' + label + '</div>'
    + docs + '<div>' + people + '</div></div>';
}

// The board itself, as a fragment. `viewerTechId` highlights that person everywhere.
export function renderBoardHtml(ctx, dk, viewerTechId) {
  const sites = groupBySite(ctx, dk);
  if (!sites.length) {
    return '<div style="padding:20px;text-align:center;color:#6b7280;font-size:14px;">Nothing is scheduled for this day.</div>';
  }
  return sites.map(s =>
    '<div style="border:1px solid #e3e6ef;border-radius:12px;padding:14px;margin-bottom:12px;background:#ffffff;">'
    + '<div style="font-size:15px;font-weight:800;color:#1a1a2e;margin-bottom:10px;">' + escapeHtml(s.name) + '</div>'
    + periodBlock(ctx, "MORNING", s.techs.am, s.doctors.am, viewerTechId)
    + '<div style="border-top:1px solid #eef0f7;padding-top:10px;">'
    + periodBlock(ctx, "AFTERNOON", s.techs.pm, s.doctors.pm, viewerTechId)
    + '</div></div>'
  ).join("");
}

// The "your assignment" card that leads both the page and the email.
export function renderMineHtml(ctx, dk, techId, techName) {
  const line = summaryLine(ctx, dk, techId);
  const off = line === "OFF" || line === "No assignment";
  return '<div style="border-radius:12px;padding:16px;margin-bottom:18px;'
    + 'background:' + (off ? '#f3f4f6' : '#4f46e5') + ';color:' + (off ? '#4b5563' : '#ffffff') + ';">'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:0.8px;opacity:0.85;">'
    + escapeHtml(String(techName || "").toUpperCase()) + ' &middot; ' + escapeHtml(fmtShort(dk)) + '</div>'
    + '<div style="font-size:24px;font-weight:800;margin-top:6px;line-height:1.25;">' + escapeHtml(line) + '</div>'
    + '</div>';
}

// ── Week / month link helpers (Monday-first, to match the rest of the app) ──

// The Monday that starts the week containing dk.
function mondayOf(dk) {
  const offset = (dayOfWeek(dk) + 6) % 7; // Mon=0 ... Sun=6
  return addDays(dk, -offset);
}

// Monday-Friday always, Saturday only if someone actually works it.
function weekDayKeys(ctx, dk) {
  const monday = mondayOf(dk);
  const days = [0, 1, 2, 3, 4].map(i => addDays(monday, i));
  const saturday = addDays(monday, 5);
  const satAssignments = assignmentsFor(ctx, saturday);
  const satWorked = activeTechs(ctx).some(t => {
    const a = satAssignments[t.id];
    return a && ((a.am && a.am !== "OFF") || (a.pm && a.pm !== "OFF"));
  });
  if (satWorked) days.push(saturday);
  return days;
}

// "YYYY-MM" (1-indexed, zero-padded) for a given day — the format the ?m= link
// param uses. Deliberately separate from monthKeyFor, whose "year-month0" shape
// is an internal plan-lookup key, not a URL-safe month string.
function ymOf(dk) {
  const p = parseDateKey(dk);
  return p.year + "-" + String(p.month0 + 1).padStart(2, "0");
}

function parseYm(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return { year: y, month0: m - 1 };
}

function addMonthsYm(ym, n) {
  const p = parseYm(ym);
  const total = p.year * 12 + p.month0 + n;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  return ny + "-" + String(nm + 1).padStart(2, "0");
}

function monthLabel(ym) {
  const p = parseYm(ym);
  const dt = new Date(Date.UTC(p.year, p.month0, 1));
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(dt) + " " + p.year;
}

function daysInMonth(ym) {
  const p = parseYm(ym);
  return new Date(Date.UTC(p.year, p.month0 + 1, 0)).getUTCDate();
}

// Full standalone page for the signed link.
export function renderDayPage(ctx, dk, techId, techName, opts) {
  const o = opts || {};

  const weekDays = weekDayKeys(ctx, dk);
  const weekRow = weekDays.map(wdk => {
    const active = wdk === dk;
    const isToday = wdk === o.todayDk;
    return '<a href="' + escapeHtml(o.linkBase + "&d=" + wdk) + '" style="display:inline-block;text-align:center;padding:7px 10px;border-radius:8px;'
      + 'text-decoration:none;font-size:13px;font-weight:700;margin:0 6px 6px 0;'
      + (active ? 'background:#4f46e5;color:#fff;' : 'background:#eef0f7;color:#4b5563;') + '">'
      + escapeHtml(fmtShort(wdk))
      + (isToday ? '<div style="font-size:9px;font-weight:800;letter-spacing:0.5px;margin-top:1px;opacity:' + (active ? '0.85' : '0.65') + ';">TODAY</div>' : '')
      + '</a>';
  }).join("");

  const curYm = ymOf(dk);
  const nextYm = addMonthsYm(curYm, 1);
  const monthRow = '<div style="margin-bottom:16px;">'
    + '<a href="' + escapeHtml(o.linkBase + "&m=" + curYm) + '" style="display:inline-block;font-size:12px;font-weight:600;color:#6b7280;text-decoration:underline;margin-right:14px;">'
    + escapeHtml(monthLabel(curYm)) + '</a>'
    + '<a href="' + escapeHtml(o.linkBase + "&m=" + nextYm) + '" style="display:inline-block;font-size:12px;font-weight:600;color:#6b7280;text-decoration:underline;">'
    + escapeHtml(monthLabel(nextYm)) + '</a>'
    + '</div>';

  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + escapeHtml(fmtShort(dk)) + ' &middot; Technician Schedule</title>'
    + '</head>'
    + '<body style="margin:0;background:#f0f0f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">'
    + '<div style="max-width:560px;margin:0 auto;padding:18px 14px 40px;">'
    + '<div style="font-size:13px;color:#6b7280;font-weight:600;margin-bottom:4px;">Technician schedule</div>'
    + '<h1 style="font-size:20px;margin:0 0 14px;font-weight:800;">' + escapeHtml(fmtLong(dk)) + '</h1>'
    + '<div style="margin-bottom:8px;">' + weekRow + '</div>'
    + monthRow
    + renderMineHtml(ctx, dk, techId, techName)
    + '<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;color:#6b7280;margin-bottom:8px;">EVERYONE TODAY</div>'
    + renderBoardHtml(ctx, dk, techId)
    + '<div style="margin-top:20px;font-size:12px;color:#9ca3af;line-height:1.6;">'
    + 'This schedule can change. Check back the morning of, or watch for a change alert.'
    + '</div></div></body></html>';
}

// Full standalone page listing every day this month the technician has something
// scheduled — the "whole month" view linked from the day page.
export function renderMonthPage(ctx, ym, techId, techName, opts) {
  const o = opts || {};
  const label = monthLabel(ym);
  const p = parseYm(ym);
  const total = daysInMonth(ym);

  const rows = [];
  for (let day = 1; day <= total; day++) {
    const dk = p.year + "-" + String(p.month0 + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    const line = summaryLine(ctx, dk, techId);
    if (line === "OFF" || line === "No assignment") continue;
    rows.push({ dk, line });
  }

  let listHtml;
  if (!rows.length) {
    listHtml = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:14px;">Nothing scheduled for '
      + escapeHtml(label) + ' yet.</div>';
  } else {
    listHtml = rows.map(r => {
      const isToday = r.dk === o.todayDk;
      const detail = personalInlineDetail(ctx, r.dk, techId); // already escaped
      return '<a href="' + escapeHtml(o.linkBase + "&d=" + r.dk) + '" style="display:block;text-decoration:none;border-radius:10px;'
        + 'padding:10px 12px;margin-bottom:8px;'
        + (isToday ? 'background:#4f46e5;color:#fff;' : 'background:#ffffff;border:1px solid #e3e6ef;color:#1a1a2e;') + '">'
        + '<div style="font-size:13px;font-weight:700;">' + escapeHtml(fmtShort(r.dk)) + (isToday ? ' &middot; today' : '') + '</div>'
        + '<div style="font-size:14px;font-weight:800;margin-top:2px;">' + escapeHtml(r.line) + '</div>'
        + (detail ? '<div style="font-size:12px;margin-top:2px;' + (isToday ? 'opacity:0.85;' : 'color:#6b7280;') + '">' + detail + '</div>' : '')
        + '</a>';
    }).join("");
  }

  const prevYm = addMonthsYm(ym, -1);
  const nextYm = addMonthsYm(ym, 1);
  const backHref = o.todayDk ? (o.linkBase + "&d=" + o.todayDk) : o.linkBase;

  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + escapeHtml(label) + ' &middot; Technician Schedule</title>'
    + '</head>'
    + '<body style="margin:0;background:#f0f0f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">'
    + '<div style="max-width:560px;margin:0 auto;padding:18px 14px 40px;">'
    + '<a href="' + escapeHtml(backHref) + '" style="display:inline-block;font-size:12px;font-weight:700;color:#4f46e5;text-decoration:none;margin-bottom:10px;">&larr; Back to today</a>'
    + '<div style="font-size:13px;color:#6b7280;font-weight:600;margin-bottom:4px;">' + escapeHtml(String(techName || "")) + ' &middot; Full month</div>'
    + '<h1 style="font-size:20px;margin:0 0 14px;font-weight:800;">' + escapeHtml(label) + '</h1>'
    + listHtml
    + '<div style="margin-top:16px;">'
    + '<a href="' + escapeHtml(o.linkBase + "&m=" + prevYm) + '" style="display:inline-block;font-size:12px;font-weight:600;color:#6b7280;text-decoration:underline;margin-right:14px;">'
    + '&larr; ' + escapeHtml(monthLabel(prevYm)) + '</a>'
    + '<a href="' + escapeHtml(o.linkBase + "&m=" + nextYm) + '" style="display:inline-block;font-size:12px;font-weight:600;color:#6b7280;text-decoration:underline;">'
    + escapeHtml(monthLabel(nextYm)) + ' &rarr;</a>'
    + '</div>'
    + '<div style="margin-top:20px;font-size:12px;color:#9ca3af;line-height:1.6;">'
    + 'This schedule can change. Check back closer to the date, or watch for a change alert.'
    + '</div></div></body></html>';
}
