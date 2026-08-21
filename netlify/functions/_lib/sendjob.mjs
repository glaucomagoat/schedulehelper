// One send job, used identically by the admin "send now" buttons and by the
// scheduled background sender. Keeping this in one place is what guarantees a
// 6pm automatic send and a manual send produce the same message and the same
// log entry — if they drifted, the delivery log would stop being trustworthy.

import { activeTechs, activeAdmins, todayIn, assignmentsFor } from "./techdata.mjs";
import { makeTechToken, dayLinkFor } from "./links.mjs";
import { composeDayMessage, composeAdminSummary } from "./compose.mjs";
import { sendToMany, summarize } from "./notify.mjs";
import { recordSend, buildSnapshot, changedTechs } from "./sendlog.mjs";

export function describeAssignment(ctx, a) {
  const am = (a && a.am) || "OFF", pm = (a && a.pm) || "OFF";
  const name = id => {
    if (!id || id === "OFF") return "OFF";
    const l = ctx.locations.find(x => x.id === id);
    return l ? l.name : id;
  };
  if (am === "OFF" && pm === "OFF") return "OFF";
  if (am === pm) return name(am) + " all day";
  return name(am) + " AM, " + name(pm) + " PM";
}

async function linkFor(tech, contact, base, secret, dk) {
  if (!contact || !contact.linkNonce) return null;
  const token = await makeTechToken(tech.id, contact.linkNonce, secret);
  return dayLinkFor(base, token, dk);
}

// Is anyone actually working? Used to suppress a weekend/holiday send — mailing the
// whole roster to say "OFF" is the fastest way to teach people to ignore these.
export function anyoneWorking(ctx, dk) {
  const day = assignmentsFor(ctx, dk);
  return activeTechs(ctx).some(t => {
    const a = day[t.id];
    return a && ((a.am && a.am !== "OFF") || (a.pm && a.pm !== "OFF"));
  });
}

async function buildRecipients(ctx, dk, kind, base, secret, onlyTechIds, prevSummaries) {
  const wanted = onlyTechIds ? new Set(onlyTechIds) : null;
  const out = [];
  for (const tech of activeTechs(ctx)) {
    if (wanted && !wanted.has(tech.id)) continue;
    const contact = ctx.contacts[tech.id] || {};
    const link = await linkFor(tech, contact, base, secret, dk);
    const message = composeDayMessage(
      ctx, dk, tech, kind, link, prevSummaries ? prevSummaries[tech.id] : null
    );
    out.push({ tech, contact, message });
  }
  return out;
}

// Administrators receive the whole-practice summary on a scheduled send only —
// never on a change alert, which is a per-person reassignment that means nothing
// to a manager (callers pass kind === "change" here too, so this filters it out
// rather than relying on every caller to remember). No day-view link is minted:
// /d (tech-day.mjs) resolves its token against ctx.techs only, so there is no
// working per-admin link — composeAdminSummary is built to carry the schedule in
// the body instead.
function buildAdminRecipients(ctx, dk, kind) {
  if (kind === "change") return [];
  return activeAdmins(ctx).map(admin => {
    const contact = ctx.contacts[admin.id] || {};
    const message = composeAdminSummary(ctx, dk, admin, kind, null);
    return { tech: admin, contact, message };
  });
}

// `kind`: 'evening' | 'morning' | 'change'.
export async function runSendJob(store, ctx, opts) {
  const { dateKey, kind, base, secret } = opts;
  let onlyTechIds = null, prevSummaries = null;

  if (kind === "change") {
    const changed = changedTechs(ctx, dateKey);
    if (changed.length === 0) {
      return { nothingToSend: true, dateKey, kind, changedCount: 0, summary: summarize([]), results: [] };
    }
    onlyTechIds = changed.map(c => c.techId);
    prevSummaries = {};
    changed.forEach(c => { prevSummaries[c.techId] = describeAssignment(ctx, c.from); });
  }

  const recipients = await buildRecipients(ctx, dateKey, kind, base, secret, onlyTechIds, prevSummaries);
  const adminRecipients = buildAdminRecipients(ctx, dateKey, kind);
  if (recipients.length === 0 && adminRecipients.length === 0) {
    return { nothingToSend: true, dateKey, kind, changedCount: 0, summary: summarize([]), results: [] };
  }

  const techResults = recipients.length ? await sendToMany(recipients, ctx.settings) : [];
  const adminResults = adminRecipients.length ? await sendToMany(adminRecipients, ctx.settings) : [];
  // Tag every admin delivery attempt so the log can never be misread as a
  // technician's, even though an admin id already carries a distinct "a" prefix
  // (techIds are "t...") — belt and braces for any reader that checks a flag
  // rather than sniffing the id shape.
  adminResults.forEach(r => { r.isAdmin = true; });

  const results = techResults.concat(adminResults);
  const snapshot = buildSnapshot(ctx, dateKey);
  await recordSend(store, dateKey, kind, results, snapshot, todayIn(ctx.settings.timezone));

  return {
    dateKey, kind,
    changedCount: onlyTechIds ? onlyTechIds.length : recipients.length,
    summary: summarize(results),
    results,
  };
}
