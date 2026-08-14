// One renderer, two surfaces: the public /d page and the inline HTML email body.
//
// Everything is inline-styled and self-contained — no external CSS, fonts, images or
// scripts. That is required twice over: the public page must survive a strict CSP and
// a phone on clinic wifi, and email clients strip <style> blocks and external assets.

import {
  activeTechs, assignmentsFor, doctorCoverage, locationName,
  fmtLong, fmtShort, escapeHtml, parseDateKey,
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
    .map(lid => ({ id: lid, name: locationName(ctx, lid), techs: sites[lid], doctors: cov[lid] || { am: [], pm: [] } }));
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

// Full standalone page for the signed link.
export function renderDayPage(ctx, dk, techId, techName, opts) {
  const o = opts || {};
  const navLink = (targetDk, label, active) =>
    '<a href="' + escapeHtml(o.linkBase + "&d=" + targetDk) + '" style="display:inline-block;padding:7px 14px;border-radius:8px;'
    + 'text-decoration:none;font-size:13px;font-weight:700;margin-right:6px;'
    + (active ? 'background:#4f46e5;color:#fff;' : 'background:#eef0f7;color:#4b5563;') + '">' + escapeHtml(label) + '</a>';

  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + escapeHtml(fmtShort(dk)) + ' &middot; Technician Schedule</title>'
    + '</head>'
    + '<body style="margin:0;background:#f0f0f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;">'
    + '<div style="max-width:560px;margin:0 auto;padding:18px 14px 40px;">'
    + '<div style="font-size:13px;color:#6b7280;font-weight:600;margin-bottom:4px;">Technician schedule</div>'
    + '<h1 style="font-size:20px;margin:0 0 14px;font-weight:800;">' + escapeHtml(fmtLong(dk)) + '</h1>'
    + '<div style="margin-bottom:16px;">'
    + navLink(o.todayDk, "Today", dk === o.todayDk)
    + navLink(o.tomorrowDk, "Tomorrow", dk === o.tomorrowDk)
    + '</div>'
    + renderMineHtml(ctx, dk, techId, techName)
    + '<div style="font-size:12px;font-weight:800;letter-spacing:0.8px;color:#6b7280;margin-bottom:8px;">EVERYONE TODAY</div>'
    + renderBoardHtml(ctx, dk, techId)
    + '<div style="margin-top:20px;font-size:12px;color:#9ca3af;line-height:1.6;">'
    + 'This schedule can change. Check back the morning of, or watch for a change alert.'
    + '</div></div></body></html>';
}
