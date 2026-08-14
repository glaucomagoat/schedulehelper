// The long-running half of the scheduler. The `-background` filename suffix is what
// tells Netlify to answer 202 immediately and allow up to 15 minutes — ample for a
// full roster across two channels, which would not fit the cron's 30-second cap.
//
// Authenticated by a shared secret rather than a user session: no user is present
// when the cron fires. It runs the SAME job as the admin "send now" buttons, so an
// automatic 6pm send and a manual one are indistinguishable in the delivery log.

import { checkInternalSecret } from "./_lib/auth.mjs";
import { techStore, loadContext, isValidDateKey, todayIn } from "./_lib/techdata.mjs";
import { runSendJob } from "./_lib/sendjob.mjs";

const VALID_KINDS = ["evening", "morning", "change"];

// Brevo's free tier allows 300 emails/day. At the projected volume this is never
// reached, but a runaway change-alert loop must degrade to "prefer Telegram and warn"
// rather than silently dropping messages.
const EMAIL_DAILY_CAP = Number(process.env.EMAIL_DAILY_CAP || 300);

function countEmailsSentToday(notifyLog, todayDk) {
  let n = 0;
  Object.keys(notifyLog).forEach(dk => {
    const entry = notifyLog[dk] || {};
    const buckets = [entry.evening, entry.morning].filter(Boolean).concat(entry.changes || []);
    buckets.forEach(b => {
      (b.results || []).forEach(r => {
        if (r.channel !== "email") return;
        // Count by when it was SENT, not which day it was about.
        const at = r.at ? new Date(r.at).toISOString().slice(0, 10) : null;
        if (at === todayDk) n++;
      });
    });
  });
  return n;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!checkInternalSecret(req)) return new Response("Forbidden", { status: 403 });

  const LINK_SECRET = process.env.LINK_SECRET;
  if (!LINK_SECRET) {
    console.error("tech-notify-send-background: LINK_SECRET not set");
    return new Response("misconfigured", { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch (e) { return new Response("bad json", { status: 400 }); }

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (jobs.length === 0) return new Response("no jobs", { status: 200 });

  const base = (process.env.PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const store = techStore();
  const outcomes = [];

  for (const job of jobs) {
    if (!isValidDateKey(job.dateKey) || VALID_KINDS.indexOf(job.kind) === -1) {
      outcomes.push({ job, skipped: "invalid job" });
      continue;
    }

    // Reloaded per job so each one sees the writes the previous job made — otherwise
    // two jobs in one dispatch would race on techNotifyLog and the second would
    // overwrite the first's record.
    const ctx = await loadContext(store);
    const todayDk = todayIn(ctx.settings.timezone);

    const emailsToday = countEmailsSentToday(ctx.notifyLog, todayDk);
    const settings = Object.assign({}, ctx.settings);
    if (emailsToday >= EMAIL_DAILY_CAP * 0.9) {
      // Near the provider's daily ceiling: stop fanning out to email so the remaining
      // quota is kept for people who have no other channel.
      console.warn("tech-notify-send-background: " + emailsToday + " emails sent today, approaching cap " + EMAIL_DAILY_CAP);
      settings.fanout = false;
    }

    try {
      const result = await runSendJob(store, Object.assign({}, ctx, { settings }), {
        dateKey: job.dateKey, kind: job.kind, base, secret: LINK_SECRET,
      });
      outcomes.push({
        job, nothingToSend: !!result.nothingToSend,
        summary: result.summary, changedCount: result.changedCount,
      });
      console.log("tech-notify-send-background: " + job.kind + " " + job.dateKey + " -> "
        + JSON.stringify(result.summary));
    } catch (e) {
      // One failed job must not abandon the others in the same dispatch.
      console.error("tech-notify-send-background: " + job.kind + " " + job.dateKey + " failed", e);
      outcomes.push({ job, error: e.message });
    }
  }

  return new Response(JSON.stringify({ success: true, outcomes }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};
