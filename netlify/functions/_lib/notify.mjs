// The pluggable notification layer.
//
// Everything upstream — the admin "send now" buttons, the cron, the background
// sender, the delivery table — calls sendToTech() and nothing else. Adding SMS later
// means dropping one file into channels/ and adding it to REGISTRY; no caller changes.

import * as telegram from "./channels/telegram.mjs";
import * as email from "./channels/email.mjs";

const REGISTRY = { telegram, email };

export function channelIds() { return Object.keys(REGISTRY); }

export function configuredChannels() {
  return Object.keys(REGISTRY).filter(id => REGISTRY[id].isConfigured());
}

// Resolve the ordered channel preference for one tech.
//
// An EXPLICIT empty array means "do not notify this person" and must not fall back
// to the defaults — an admin who unticks every channel has said something deliberate,
// and the UI reports that tech as unreachable. Only an ABSENT `channels` field
// inherits the practice defaults.
export function channelsFor(contact, settings) {
  const prefs = (contact && Array.isArray(contact.channels))
    ? contact.channels
    : ((settings && settings.defaultChannels) || ["telegram", "email"]);
  return prefs.filter(id => REGISTRY[id] && REGISTRY[id].isConfigured());
}

// Try channels in preference order. Stops at the first accepted send unless
// `fanout`, in which case every configured channel is used.
//
// EVERY attempt is recorded, including the ones that failed before a fallback
// succeeded. A delivery table that only shows the winning channel hides exactly the
// information a coordinator needs when someone says they never got the message.
export async function sendToTech(tech, contact, message, settings) {
  const opts = settings || {};
  const ids = channelsFor(contact, opts);
  const attempts = [];

  if (ids.length === 0) {
    return [{
      techId: tech.id, channel: null, ok: false, status: "no_channel",
      error: "No configured channel for this technician", at: Date.now(),
    }];
  }

  for (const id of ids) {
    let r;
    try {
      r = await REGISTRY[id].send({ tech, contact, message });
    } catch (e) {
      r = { ok: false, status: "failed", error: "Adapter threw: " + e.message };
    }
    attempts.push({
      techId: tech.id, channel: id, ok: !!r.ok, status: r.status,
      externalId: r.externalId || null, error: r.error || null, at: Date.now(),
    });
    if (r.ok && !opts.fanout) break;
  }

  return attempts;
}

// Send to many techs. Sequential rather than Promise.all: both providers rate-limit,
// and a burst of 30 parallel requests is how you get throttled into partial delivery.
// At this roster size the wall-clock cost is a few seconds inside a 15-minute
// background function.
export async function sendToMany(recipients, settings) {
  const results = [];
  for (const r of recipients) {
    const attempts = await sendToTech(r.tech, r.contact, r.message, settings);
    results.push.apply(results, attempts);
  }
  return results;
}

export function summarize(results) {
  // Counts people, not attempts: one tech who failed Telegram then succeeded on
  // email is one delivered person, not one failure plus one success.
  const out = { total: 0, delivered: 0, queued: 0, failed: 0, unreachable: 0, no_channel: 0 };
  const byTech = {};
  results.forEach(r => {
    if (!byTech[r.techId]) byTech[r.techId] = [];
    byTech[r.techId].push(r);
  });
  Object.keys(byTech).forEach(techId => {
    out.total++;
    const attempts = byTech[techId];
    const win = attempts.find(a => a.ok);
    if (win) { if (win.status === "delivered") out.delivered++; else out.queued++; }
    else if (attempts.some(a => a.status === "no_channel")) out.no_channel++;
    else if (attempts.every(a => a.status === "unreachable")) out.unreachable++;
    else out.failed++;
  });
  return out;
}
