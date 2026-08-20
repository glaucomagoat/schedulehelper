// The scheduler. Runs every 5 minutes and decides whether anything needs sending.
//
// Netlify scheduled functions have two constraints this design works around:
//
//   1. They run in UTC ONLY. Rather than hardcoding a UTC hour that would drift an
//      hour every daylight-saving change, this ticks frequently and asks
//      Intl.DateTimeFormat what the wall-clock time is where the practice is. Correct
//      across DST with no code change and no twice-yearly edit.
//
//   2. They are capped at 30 SECONDS. So this function only DECIDES; the actual
//      sending is handed to tech-notify-send-background, which gets 15 minutes.
//      Thirty techs across two channels would otherwise sail past the cap.
//
// Everything here is idempotent against techNotifyLog, so an overlapping or retried
// tick can never double-notify anyone.

import {
  techStore, loadContext, todayIn, addDays, isValidDateKey,
} from "./_lib/techdata.mjs";
import { wasNotified } from "./_lib/sendlog.mjs";
import { anyoneWorking } from "./_lib/sendjob.mjs";

export const config = { schedule: "*/5 * * * *" };

// How long after the configured hour we will still fire. Without a cap, enabling the
// feature at noon would immediately trigger "this morning's" 6am send. With it, a
// tick missed to a cold start or a deploy still gets caught up.
const CATCHUP_HOURS = 2;

function localHour(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "numeric", hour12: false,
    }).formatToParts(new Date());
    const h = parts.find(p => p.type === "hour");
    // Some ICU versions render midnight as 24 in hour12:false.
    return h ? (parseInt(h.value, 10) % 24) : new Date().getUTCHours();
  } catch (e) {
    return new Date().getUTCHours();
  }
}

function withinWindow(hourNow, targetHour) {
  return hourNow >= targetHour && hourNow < targetHour + CATCHUP_HOURS;
}

function baseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  try { return new URL(req.url).origin; } catch (e) { return ""; }
}

async function dispatch(base, jobs) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) { console.error("tech-notify-cron: INTERNAL_SECRET not set — cannot dispatch"); return false; }
  try {
    // Background functions answer 202 immediately and keep running, so this returns
    // long before the 30s cap regardless of how many people are being messaged.
    const res = await fetch(base + "/.netlify/functions/tech-notify-send-background", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ jobs }),
    });
    if (!res.ok && res.status !== 202) {
      console.error("tech-notify-cron: dispatch returned " + res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error("tech-notify-cron: dispatch failed", e.message);
    return false;
  }
}

export default async (req) => {
  const store = techStore();
  const ctx = await loadContext(store);
  const s = ctx.settings;

  if (!s.enabled) return new Response("disabled", { status: 200 });

  const tz = s.timezone || "America/Los_Angeles";
  const today = todayIn(tz);
  if (!isValidDateKey(today)) {
    console.error("tech-notify-cron: could not resolve today in " + tz);
    return new Response("bad timezone", { status: 200 });
  }
  const tomorrow = addDays(today, 1);
  const hour = localHour(tz);
  const jobs = [];

  // Night-before: tomorrow's assignments, recorded against tomorrow's date.
  if (withinWindow(hour, Number(s.eveningHour))
      && !wasNotified(ctx, tomorrow, "evening")
      && anyoneWorking(ctx, tomorrow)) {
    jobs.push({ dateKey: tomorrow, kind: "evening" });
  }

  // Morning-of: today's assignments, recorded against today.
  if (withinWindow(hour, Number(s.morningHour))
      && !wasNotified(ctx, today, "morning")
      && anyoneWorking(ctx, today)) {
    jobs.push({ dateKey: today, kind: "morning" });
  }

  if (jobs.length === 0) return new Response("nothing to do", { status: 200 });

  const base = baseUrl(req);
  const ok = await dispatch(base, jobs);
  const summary = jobs.map(j => j.kind + ":" + j.dateKey).join(", ");
  console.log("tech-notify-cron: " + (ok ? "dispatched " : "FAILED to dispatch ") + summary + " (local hour " + hour + " " + tz + ")");
  return new Response(ok ? "dispatched " + summary : "dispatch failed", { status: 200 });
};
