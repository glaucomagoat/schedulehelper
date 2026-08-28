// Shared blob access for every technician-side function.
//
// These functions run without a user session (public link, cron, webhook), so they
// read the store directly rather than going through storage-proxy — the same pattern
// partner-api.mjs already uses. Single-tenant by design: TECH_ADMIN_USERNAME names
// the one admin namespace this deployment serves.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";

// TECH_ADMIN_USERNAME may be a single login or a comma-separated list.
//
// The FIRST entry is the namespace the technician data actually lives in — every
// blob is written as "<ADMIN>:tech*", and there is exactly one copy. The remaining
// entries are additional logins permitted to administer it.
//
// Note this only widens the SERVER's check. storage-proxy independently allows an
// account to touch its own namespace or its parent tenant's, so for a second person
// to edit the same schedule from the browser they must be a managed user under the
// tenant named first here. Listing an unrelated top-level admin here lets them call
// the technician endpoints but will not let them load the data.
const TECH_ADMIN_LIST = String(process.env.TECH_ADMIN_USERNAME || "cve")
  .split(",").map(s => s.trim()).filter(Boolean);

export const ADMIN = TECH_ADMIN_LIST[0] || "cve";
export const TECH_ADMINS = TECH_ADMIN_LIST;

export function techStore() { return getStore(STORE_NAME); }

export async function readJson(store, key, fallback) {
  try {
    const raw = await store.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export async function writeJson(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

export const DEFAULT_SETTINGS = {
  enabled: false,
  timezone: "America/Los_Angeles",
  eveningHour: 18,
  morningHour: 6,
  defaultChannels: ["telegram", "email"],
  fanout: false,
};

// One round trip for everything a day view or a send needs.
export async function loadContext(store) {
  const ns = ADMIN + ":";
  const [techs, contacts, techSchedules, staffing, locations, doctors, finalPlans, docSchedules, settings, notifyLog, timeOff, techSites, techFinalPlans, techPublished, techAdmins, techDayNotes, docDayNotes, techDuties] =
    await Promise.all([
      readJson(store, ns + "techs", []),
      // Contact/notification state for every notifiable person, keyed by id:
      // technicians ("t..."), administrators ("a..."), AND doctors ("s...", the
      // `staff` blob's id prefix). The three prefixes can never collide, so one map
      // is enough — there is no separate doctor-contacts blob and never should be.
      readJson(store, ns + "techContacts", {}),
      readJson(store, ns + "techSchedules", {}),
      readJson(store, ns + "techStaffing", {}),
      readJson(store, ns + "locations", []),
      readJson(store, ns + "staff", []),
      readJson(store, ns + "finalPlans", {}),
      readJson(store, ns + "schedules", {}),
      readJson(store, ns + "techNotifySettings", {}),
      readJson(store, ns + "techNotifyLog", {}),
      readJson(store, ns + "techTimeOff", []),
      readJson(store, ns + "techSites", []),
      readJson(store, ns + "techFinalPlans", {}),
      readJson(store, ns + "techPublished", {}),
      // Practice managers / higher-level admins. NOT technicians: never scheduled,
      // never assigned, never counted toward coverage — they only ever receive the
      // whole-practice summary. Contacts for them live in the SAME techContacts map
      // above, keyed by their id (which carries an "a" prefix so it can never
      // collide with a technician's "t" id).
      readJson(store, ns + "techAdmins", []),
      // Day notes, both sides. The technician board keys them by date; the doctor
      // scheduler keys them by schedule key first, then date.
      readJson(store, ns + "techDayNotes", {}),
      readJson(store, ns + "dayNotes", {}),
      // User-managed duty/role definitions ({id, label, abbr}). id is permanent and
      // is what assignments store, so it must never be derived from the abbreviation —
      // see dutyLabelFor below for the fallback chain a deleted/never-saved role uses.
      readJson(store, ns + "techDuties", []),
    ]);
  return {
    ns, techs, contacts, techSchedules, staffing, locations, doctors,
    finalPlans, docSchedules, timeOff, notifyLog, techSites, techFinalPlans, techPublished, techAdmins,
    techDayNotes, docDayNotes, duties: techDuties || [],
    // Anywhere a technician can be assigned = real locations + tech-only sub-rooms.
    // Doctors only ever appear at real locations, which is why the two differ.
    allSites: (locations || []).concat(techSites || []),
    settings: Object.assign({}, DEFAULT_SETTINGS, settings || {}),
  };
}

// ── Date helpers (must match techs.html exactly) ─────────────────────────────

export function parseDateKey(dk) {
  const [y, m, d] = String(dk).split("-").map(Number);
  return { year: y, month0: m - 1, day: d };
}

export function isValidDateKey(dk) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dk || ""))) return false;
  const p = parseDateKey(dk);
  const dt = new Date(Date.UTC(p.year, p.month0, p.day));
  return dt.getUTCFullYear() === p.year && dt.getUTCMonth() === p.month0 && dt.getUTCDate() === p.day;
}

// Wall-clock "today" where the practice is, never where the server is.
// en-CA formats as YYYY-MM-DD, which is exactly the dateKey format.
export function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(dk, n) {
  const p = parseDateKey(dk);
  const dt = new Date(Date.UTC(p.year, p.month0, p.day));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function dayOfWeek(dk) {
  const p = parseDateKey(dk);
  return new Date(Date.UTC(p.year, p.month0, p.day)).getUTCDay();
}
export function fmtLong(dk)  { const p = parseDateKey(dk); return DAY_NAMES[dayOfWeek(dk)] + ", " + MONTHS[p.month0] + " " + p.day; }
export function fmtShort(dk) { const p = parseDateKey(dk); return DAY_SHORT[dayOfWeek(dk)] + " " + (p.month0 + 1) + "/" + p.day; }

// Technicians only ever see the FINAL plan. A month with no final plan resolves to
// null, and assignmentsFor returns {} — nothing half-finished can reach anyone.
export function techScheduleKeyFor(dk, ctx) {
  const p = parseDateKey(dk);
  const plan = ctx && ctx.techFinalPlans ? ctx.techFinalPlans[p.year + "-" + p.month0] : null;
  if (!plan) return null;
  return "tech-" + p.year + "-" + p.month0 + "-" + plan;
}

export function monthKeyFor(dk) {
  const p = parseDateKey(dk);
  return p.year + "-" + p.month0;
}

// ── Domain lookups ───────────────────────────────────────────────────────────

// What technicians actually see is the PUBLISHED snapshot, not the live plan. Editing
// a finalised month therefore changes nothing for anyone until the coordinator presses
// Publish Changes — which is the whole point: a half-finished reshuffle at 4pm must not
// reach phones one assignment at a time.
//
// Legacy fallback: months finalised before publishing existed have no snapshot. Those
// fall through to reading the live final plan, exactly as before, so nobody goes dark
// in the window between this deploying and the first publish. The fallback stops
// applying for a month as soon as it has been published once.
export function publishedDayFor(ctx, dk) {
  const ym = monthKeyFor(dk);
  const finalPlan = (ctx.techFinalPlans || {})[ym] || null;
  // Unsetting Final still blacks the month out, snapshot or not — the snapshot is
  // what technicians see, never a reason for them to keep seeing a withdrawn month.
  if (!finalPlan) return {};

  const pub = (ctx.techPublished || {})[ym];
  // Only serve a snapshot that belongs to the plan currently marked Final. A snapshot
  // left over from a different letter is stale by definition.
  if (pub && pub.days && (!pub.plan || pub.plan === finalPlan)) {
    return Object.assign({}, pub.days[dk] || {});
  }
  const key = techScheduleKeyFor(dk, ctx);
  return key ? Object.assign({}, (ctx.techSchedules[key] || {})[dk] || {}) : {};
}

export function assignmentsFor(ctx, dk) {
  const day = publishedDayFor(ctx, dk);
  // Approved time off overrides the stored assignment, so a technician on holiday is
  // told OFF rather than "No assignment", and the weekend/holiday send-suppression
  // check does not count them as working. This sits outside the publish gate on
  // purpose — approved leave takes effect immediately, without waiting on a publish.
  (ctx.timeOff || []).forEach(v => {
    if (dk >= v.startDate && dk <= v.endDate) day[v.techId] = { am: "OFF", pm: "OFF" };
  });
  return day;
}

export function locationName(ctx, id) {
  if (!id || id === "OFF") return "OFF";
  const all = ctx.allSites || ctx.locations || [];
  const l = all.find(x => x.id === id);
  return l ? l.name : id;
}

export function activeTechs(ctx) {
  return ctx.techs.filter(t => t.active !== false);
}

// Administrators eligible to receive the whole-practice summary. Mirrors
// activeTechs on purpose — same "active !== false" convention — but this list must
// never be merged into ctx.techs or activeTechs: administrators are not scheduled,
// do not appear on the grid/OFF list/PDF/coverage counts, and are not technicians.
export function activeAdmins(ctx) {
  return (ctx.techAdmins || []).filter(a => a.active !== false);
}

// Doctors present at a specific site on a specific day, resolving a sub-room's
// borrowed parent doctors — someone assigned to "Stockton - Suite 2" should see the
// Stockton doctors, not none. Kept here so every caller (the shared day-board
// renderer, the Telegram messages) resolves borrowing the same way.
export function doctorsAt(ctx, dk, lid) {
  if (!lid || lid === "OFF") return { am: [], pm: [] };
  const cov = doctorCoverage(ctx, dk);
  const all = ctx.allSites || ctx.locations || [];
  const site = all.find(s => s.id === lid);
  const sourceId = (site && site.parentLocationId) ? site.parentLocationId : lid;
  return cov[sourceId] || { am: [], pm: [] };
}

// The note attached to one day, from either scheduler. A coordinator writes these
// for exactly the reason they belong in a notification — "staff meeting 7:45",
// "Dr Kim out after 3" — so they ride along with the assignment rather than living
// only on the printed sheet. Both sides are included, deduplicated when identical.
export function dayNoteFor(ctx, dk) {
  const out = [];
  const techNote = (ctx.techDayNotes || {})[dk];
  if (techNote && String(techNote).trim()) out.push(String(techNote).trim());

  const p = parseDateKey(dk);
  const plan = (ctx.finalPlans || {})[p.year + "-" + p.month0];
  if (plan) {
    const key = "schedule-" + p.year + "-" + p.month0 + "-" + plan;
    const docNote = ((ctx.docDayNotes || {})[key] || {})[dk];
    if (docNote && String(docNote).trim() && out.indexOf(String(docNote).trim()) === -1) {
      out.push(String(docNote).trim());
    }
  }
  return out.join(" · ");
}

// Fallback only, for a site that has never saved a techDuties blob (or one that was
// seeded before this migration ran). Mirrors DEFAULT_DUTIES in techs.html — keep the
// two in step. Once a practice edits its roles, ctx.duties is the source of truth and
// this is never consulted for their ids.
export const DUTY_LABELS = { S: "Scribe", T: "Testing", A: "A scan", L: "LASIK", TR: "Training Refraction" };

// Resolves a stored duty CODE to a display label: the practice's own definition
// first (ctx.duties, from the techDuties blob), then the hardcoded fallback above,
// then the raw code itself — so a role deleted out from under an old assignment (or
// a site that has never saved the blob at all) still shows something instead of
// throwing or going blank.
export function dutyLabelFor(ctx, code) {
  if (!code) return null;
  const d = (ctx.duties || []).find(x => x.id === code);
  if (d) return d.label;
  return DUTY_LABELS[code] || code;
}

// Which doctors are at which site on a given day, from the PUBLISHED plan.
export function doctorCoverage(ctx, dk) {
  const p = parseDateKey(dk);
  const plan = ctx.finalPlans[p.year + "-" + p.month0];
  if (!plan) return {};
  const day = (ctx.docSchedules["schedule-" + p.year + "-" + p.month0 + "-" + plan] || {})[dk];
  if (!day) return {};
  const out = {};
  Object.keys(day).forEach(staffId => {
    const doc = ctx.doctors.find(x => x.id === staffId);
    // Deliberately NOT filtered on doc.active. In the doctor scheduler `active` means
    // "include this doctor when generating future schedules" — not "no longer here".
    // A doctor who is on the published plan for this day is in the building that day,
    // and the technicians working alongside them need the name. Filtering on it
    // silently deleted a real, scheduled doctor from the board.
    if (!doc) return;
    const per = day[staffId] || {};
    ["am", "pm"].forEach(period => {
      const lid = per[period];
      if (!lid || lid === "OFF") return;
      if (!out[lid]) out[lid] = { am: [], pm: [] };
      out[lid][period].push(doc.name);
    });
  });
  return out;
}

// Every doctor (ctx.doctors, the `staff` blob) is a notification candidate — there is
// no separate roster to maintain. Deliberately NOT filtered on `d.active`: in the
// doctor scheduler `active` means "include this doctor when the AI generates future
// schedules", not "no longer here". A doctor who is `active: false` can still be on
// the published plan and physically in clinic, so filtering on it here would make
// them unreachable for notifications even though they're the one working that day.
// Named "notifiable", not "active", so the name itself can't be misread the same way
// the old filter was. Kept here so sendjob.mjs and tech-notify.mjs never diverge on
// who counts.
export function notifiableDoctors(ctx) {
  return ctx.doctors || [];
}

// One doctor's own PUBLISHED assignment for a day — site ids or "OFF"/"" per period.
// Deliberately reads the FINAL plan only, exactly like doctorCoverage: a doctor must
// never be notified about a draft that could still change before publish. No final
// plan for the month, or no entry for this doctor on this day, resolves to
// { am: "", pm: "" } rather than throwing — "nothing to report" is a valid answer.
export function doctorAssignmentFor(ctx, dk, doctorId) {
  const p = parseDateKey(dk);
  const plan = ctx.finalPlans[p.year + "-" + p.month0];
  if (!plan) return { am: "", pm: "" };
  const key = "schedule-" + p.year + "-" + p.month0 + "-" + plan;
  const day = (ctx.docSchedules[key] || {})[dk];
  const per = (day || {})[doctorId] || {};
  return { am: per.am || "", pm: per.pm || "" };
}

// Technicians working AT a given site in a given period ("am"/"pm"), by name.
// Resolves sub-rooms the same way doctorsAt does: a technician assigned to
// "Stockton - Suite 2" is working WITH the Stockton doctor, so they count toward
// that site too. Excludes OFF. Built on assignmentsFor/activeTechs so this can never
// drift from what the technician board itself shows.
export function techsWithDoctor(ctx, dk, siteId, period) {
  if (!siteId || siteId === "OFF") return [];
  const day = assignmentsFor(ctx, dk);
  const all = ctx.allSites || ctx.locations || [];
  return activeTechs(ctx)
    .filter(t => {
      const lid = (day[t.id] || {})[period];
      if (!lid || lid === "OFF") return false;
      if (lid === siteId) return true;
      const site = all.find(x => x.id === lid);
      return !!(site && site.parentLocationId === siteId);
    })
    .map(t => t.name);
}

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
