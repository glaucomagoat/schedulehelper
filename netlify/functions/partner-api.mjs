// netlify/functions/partner-api.mjs
// Read-only public API for partner sites to access the finalized staff schedule.
// Authentication: x-api-key header must match PARTNER_API_KEY environment variable.
// Usage: GET /.netlify/functions/partner-api?month=2026-03
// Month param is optional — defaults to current month. Format: YYYY-MM (1-indexed).

import { getStore } from "@netlify/blobs";

const STORE_NAME = "schedule-helper";
const ADMIN_USERNAME = "cve"; // The admin whose finalized schedule is exposed

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Authentication ──────────────────────────────────────────────────────────
  const PARTNER_API_KEY = process.env.PARTNER_API_KEY;
  if (!PARTNER_API_KEY) {
    return json({ error: "API not configured — PARTNER_API_KEY missing" }, 500);
  }
  const providedKey = req.headers.get("x-api-key");
  if (!providedKey || providedKey !== PARTNER_API_KEY) {
    return json({ error: "Unauthorized — invalid or missing x-api-key" }, 401);
  }

  // ── Parse month param ───────────────────────────────────────────────────────
  // Partner passes YYYY-MM (1-indexed). Internally months are 0-indexed (JS Date).
  // e.g. partner sends "2026-03" → stored as monthKey "2026-2"
  const url = new URL(req.url);
  let monthParam = url.searchParams.get("month");

  let year, month1indexed;
  if (monthParam) {
    const parts = monthParam.match(/^(\d{4})-(\d{2})$/);
    if (!parts) {
      return json({ error: "Invalid month format — use YYYY-MM e.g. 2026-03" }, 400);
    }
    year = parseInt(parts[1], 10);
    month1indexed = parseInt(parts[2], 10);
    if (month1indexed < 1 || month1indexed > 12) {
      return json({ error: "Invalid month — must be 01-12" }, 400);
    }
  } else {
    // Default to current month
    const now = new Date();
    year = now.getFullYear();
    month1indexed = now.getMonth() + 1;
  }

  // Convert to internal 0-indexed monthKey
  const monthIndex = month1indexed - 1; // 0-indexed
  const monthKey = `${year}-${monthIndex}`;
  const monthDisplay = `${year}-${String(month1indexed).padStart(2, "0")}`;

  try {
    const store = getStore(STORE_NAME);
    const d = async (key) => {
      try {
        const raw = await store.get(`${ADMIN_USERNAME}:${key}`);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    };

    // ── Load required data ────────────────────────────────────────────────────
    const [finalPlans, schedules, staffList, locationsList] = await Promise.all([
      d("finalPlans"),
      d("schedules"),
      d("staff"),
      d("locations"),
    ]);

    if (!finalPlans) {
      return json({ error: "No schedule data found" }, 404);
    }

    // ── Find the finalized plan for this month ────────────────────────────────
    const finalPlan = finalPlans[monthKey] || null;
    if (!finalPlan) {
      return json({
        month: monthDisplay,
        finalPlan: null,
        message: `No finalized plan for ${monthDisplay}. The admin has not yet published a schedule for this month.`,
        days: {},
      });
    }

    // ── Load the schedule for the finalized plan ──────────────────────────────
    const scheduleKey = `schedule-${year}-${monthIndex}-${finalPlan}`;
    const schedule = schedules?.[scheduleKey] || {};

    if (Object.keys(schedule).length === 0) {
      return json({
        month: monthDisplay,
        finalPlan,
        message: `Plan ${finalPlan} is marked as final but has no schedule data yet.`,
        days: {},
      });
    }

    // ── Build location name lookup ────────────────────────────────────────────
    const locationById = {};
    (locationsList || []).forEach((l) => {
      locationById[l.id] = l.name;
    });

    // Build locations map for response (name → id, useful for partner filtering)
    const locationsMap = {};
    (locationsList || []).forEach((l) => {
      locationsMap[l.name] = l.id;
    });

    // ── Build staff name lookup ───────────────────────────────────────────────
    const staffById = {};
    (staffList || []).forEach((s) => {
      staffById[s.id] = s.name;
    });

    // ── Build response days ───────────────────────────────────────────────────
    // Sort dates and build clean output keyed by YYYY-MM-DD
    const days = {};
    const sortedDates = Object.keys(schedule).sort();

    for (const dateKey of sortedDates) {
      const dayAssignments = schedule[dateKey];
      if (!dayAssignments || Object.keys(dayAssignments).length === 0) continue;

      const dayData = {};
      for (const [staffId, periods] of Object.entries(dayAssignments)) {
        const staffName = staffById[staffId];
        if (!staffName) continue; // skip unknown staff IDs

        const amName = periods.am === "OFF" ? "OFF" : (locationById[periods.am] || periods.am);
        const pmName = periods.pm === "OFF" ? "OFF" : (locationById[periods.pm] || periods.pm);

        dayData[staffName] = { am: amName, pm: pmName };
      }

      if (Object.keys(dayData).length > 0) {
        days[dateKey] = dayData;
      }
    }

    // ── Find last updated timestamp ───────────────────────────────────────────
    // Use the most recent plan history entry if available, otherwise omit
    const planHistory = await d("planHistory");
    const historyForPlan = planHistory?.[scheduleKey] || [];
    const lastEntry = historyForPlan[historyForPlan.length - 1];
    const lastUpdated = lastEntry?.ts ? new Date(lastEntry.ts).toISOString() : null;

    // ── Return response ───────────────────────────────────────────────────────
    return json({
      month: monthDisplay,
      finalPlan,
      lastUpdated,
      locations: locationsMap,
      days,
    });

  } catch (err) {
    return json({ error: "Server error", detail: err.message }, 500);
  }
}
