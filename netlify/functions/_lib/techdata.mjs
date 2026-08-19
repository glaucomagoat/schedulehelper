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
  changeAlertsEnabled: true,
};

// One round trip for everything a day view or a send needs.
export async function loadContext(store) {
  const ns = ADMIN + ":";
  const [techs, contacts, techSchedules, staffing, locations, doctors, finalPlans, docSchedules, settings, notifyLog, timeOff, techSites, techFinalPlans] =
    await Promise.all([
      readJson(store, ns + "techs", []),
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
    ]);
  return {
    ns, techs, contacts, techSchedules, staffing, locations, doctors,
    finalPlans, docSchedules, timeOff, notifyLog, techSites, techFinalPlans,
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

// ── Domain lookups ───────────────────────────────────────────────────────────

export function assignmentsFor(ctx, dk) {
  const key = techScheduleKeyFor(dk, ctx);
  const day = key ? Object.assign({}, (ctx.techSchedules[key] || {})[dk] || {}) : {};
  // Approved time off overrides the stored assignment, so a technician on holiday is
  // told OFF rather than "No assignment", and the weekend/holiday send-suppression
  // check does not count them as working.
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

// Mirrors the DUTIES constant in techs.html — keep the two in step.
export const DUTY_LABELS = { S: "Scribe", T: "Testing", TR: "Training Refraction" };

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
    if (!doc || doc.active === false) return;
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

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
