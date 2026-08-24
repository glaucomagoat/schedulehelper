// One send job, used identically by the admin "send now" buttons and by the
// scheduled background sender. Keeping this in one place is what guarantees a
// 6pm automatic send and a manual send produce the same message and the same
// log entry — if they drifted, the delivery log would stop being trustworthy.

import { activeTechs, activeAdmins, notifiableDoctors, todayIn, assignmentsFor, doctorAssignmentFor } from "./techdata.mjs";
import { makeTechToken, dayLinkFor } from "./links.mjs";
import { composeDayMessage, composeAdminSummary, composeDoctorMessage } from "./compose.mjs";
import { sendToMany, summarize } from "./notify.mjs";
import { recordSend, buildSnapshot, changedTechs, buildDoctorSnapshot, changedDoctors } from "./sendlog.mjs";

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
// rather than relying on every caller to remember).
//
// They get the same signed day-view link technicians get: the token carries an id,
// not a role, and tech-day resolves an administrator's id to the whole-practice
// view. Async for that reason — minting the token is a crypto call.
async function buildAdminRecipients(ctx, dk, kind, base, secret) {
  if (kind === "change") return [];
  const out = [];
  for (const admin of activeAdmins(ctx)) {
    const contact = ctx.contacts[admin.id] || {};
    const link = await linkFor(admin, contact, base, secret, dk);
    out.push({ tech: admin, contact, message: composeAdminSummary(ctx, dk, admin, kind, link) });
  }
  return out;
}

// Doctors receive the evening/morning sends unscoped, plus — when `onlyDoctorIds` is
// given — a scoped `kind === "change"` send for exactly those doctors. An UNSCOPED
// change alert (onlyDoctorIds null, the technician path's own change send) is a
// technician's reassignment; it means nothing to a doctor's own day, so that case
// still returns [] itself rather than relying on every caller to remember (same
// defensive pattern buildAdminRecipients uses) — this is what keeps the technician
// page's and the cron's change sends from ever reaching a doctor.
//
// Every doctor from ctx.doctors is a candidate — no separate roster, and NOT filtered
// on `active` (see notifiableDoctors' comment: that flag gates AI generation, not
// presence). They get the same signed day-view link technicians and administrators
// get: the token carries an id, not a role.
//
// A doctor with no assignment at all that day — neither an am nor a pm site — is
// skipped entirely rather than sent a message that just says "Not scheduled", EXCEPT
// on a change send: a doctor whose assignment was removed has no site today and is
// precisely who needs the message, so that skip rule does not apply when
// `kind === "change"`.
async function buildDoctorRecipients(ctx, dk, kind, base, secret, onlyDoctorIds) {
  if (kind === "change" && !onlyDoctorIds) return [];
  const wanted = onlyDoctorIds ? new Set(onlyDoctorIds) : null;
  const out = [];
  for (const doctor of notifiableDoctors(ctx)) {
    if (wanted && !wanted.has(doctor.id)) continue;
    if (kind !== "change") {
      const a = doctorAssignmentFor(ctx, dk, doctor.id);
      const hasAmSite = !!(a.am && a.am !== "OFF");
      const hasPmSite = !!(a.pm && a.pm !== "OFF");
      if (!hasAmSite && !hasPmSite) continue;
    }
    const contact = ctx.contacts[doctor.id] || {};
    const link = await linkFor(doctor, contact, base, secret, dk);
    out.push({ tech: doctor, contact, message: composeDoctorMessage(ctx, dk, doctor, kind, link) });
  }
  return out;
}

// `kind`: 'evening' | 'morning' | 'change'.
// `opts.audience === 'doctors'` scopes the send to doctors ONLY — technicians and
// administrators are never built, let alone messaged. This exists so the doctor
// panel's own "send now" buttons can never fan out to the whole practice roster.
// Anything else (including undefined) is the original, unscoped behaviour, and the
// cron path must remain byte-for-byte identical to before this option existed.
export async function runSendJob(store, ctx, opts) {
  const { dateKey, kind, base, secret, audience } = opts;
  const doctorsOnly = audience === "doctors";
  let onlyTechIds = null, prevSummaries = null, onlyDoctorIds = null;

  if (kind === "change" && !doctorsOnly) {
    const changed = changedTechs(ctx, dateKey);
    if (changed.length === 0) {
      return { nothingToSend: true, dateKey, kind, changedCount: 0, summary: summarize([]), results: [] };
    }
    onlyTechIds = changed.map(c => c.techId);
    prevSummaries = {};
    changed.forEach(c => { prevSummaries[c.techId] = describeAssignment(ctx, c.from); });
  }

  // The doctor-side parallel to the block above: a doctors-only change send is
  // scoped to exactly the doctors whose own published assignment moved since
  // doctors were last told.
  if (kind === "change" && doctorsOnly) {
    const changed = changedDoctors(ctx, dateKey);
    if (changed.length === 0) {
      return { nothingToSend: true, dateKey, kind, changedCount: 0, summary: summarize([]), results: [] };
    }
    onlyDoctorIds = changed.map(c => c.doctorId);
  }

  const recipients = doctorsOnly ? [] : await buildRecipients(ctx, dateKey, kind, base, secret, onlyTechIds, prevSummaries);
  const adminRecipients = doctorsOnly ? [] : await buildAdminRecipients(ctx, dateKey, kind, base, secret);
  const doctorRecipients = await buildDoctorRecipients(ctx, dateKey, kind, base, secret, onlyDoctorIds);
  if (recipients.length === 0 && adminRecipients.length === 0 && doctorRecipients.length === 0) {
    return { nothingToSend: true, dateKey, kind, changedCount: 0, summary: summarize([]), results: [] };
  }

  const techResults = recipients.length ? await sendToMany(recipients, ctx.settings) : [];
  const adminResults = adminRecipients.length ? await sendToMany(adminRecipients, ctx.settings) : [];
  const doctorResults = doctorRecipients.length ? await sendToMany(doctorRecipients, ctx.settings) : [];
  // Tag every admin/doctor delivery attempt so the log can never be misread as a
  // technician's, even though their ids already carry distinct "a"/"s" prefixes
  // (techIds are "t...") — belt and braces for any reader that checks a flag
  // rather than sniffing the id shape.
  adminResults.forEach(r => { r.isAdmin = true; });
  doctorResults.forEach(r => { r.isDoctor = true; });

  const results = techResults.concat(adminResults).concat(doctorResults);
  // A doctors-only send must not satisfy the cron's idempotency guard (wasNotified
  // reads the bare `kind` key) and must not overwrite the technician change-detection
  // snapshot. Namespacing the log kind is what keeps a manual doctor send from ever
  // being confused with — or accidentally satisfying — the technician kind's record;
  // for kind === "change" this yields exactly "change:doctors", its own log bucket
  // (see recordSend).
  const logKind = doctorsOnly ? kind + ":doctors" : kind;
  const snapshot = doctorsOnly ? null : buildSnapshot(ctx, dateKey);
  // The doctor snapshot is the baseline the NEXT doctors-only change send diffs
  // against, so it must be refreshed by any send whose audience included doctors —
  // every kind !== "change" (the ordinary evening/morning sends, scoped or not, all
  // of which do reach doctors) OR any audience === "doctors" send (including this
  // doctors-only change send itself). It must NOT be refreshed by an unscoped
  // kind === "change" send (the technician path): that send tells doctors nothing,
  // so refreshing it there would silently swallow a real doctor change before
  // anyone was ever told about it.
  const doctorSnapshot = (kind !== "change" || doctorsOnly) ? buildDoctorSnapshot(ctx, dateKey) : null;
  await recordSend(store, dateKey, logKind, results, snapshot, todayIn(ctx.settings.timezone), doctorSnapshot);

  return {
    dateKey, kind,
    changedCount: onlyTechIds ? onlyTechIds.length : (onlyDoctorIds ? onlyDoctorIds.length : recipients.length),
    summary: summarize(results),
    results,
  };
}
