// The delivery log and the change-detection snapshot.
//
// The snapshot is what replaces the doctor scheduler's "published final plan": the
// technician board is always live, so "what did we last tell people?" is the only
// meaningful baseline for deciding who needs a change alert.

import { activeTechs, assignmentsFor, readJson, writeJson, ADMIN } from "./techdata.mjs";

const LOG_KEY = ADMIN + ":techNotifyLog";
const RETAIN_DAYS = 90;

// What each active tech's day looks like right now.
export function buildSnapshot(ctx, dk) {
  const day = assignmentsFor(ctx, dk);
  const snap = {};
  activeTechs(ctx).forEach(t => {
    const a = day[t.id] || {};
    snap[t.id] = { am: a.am || "", pm: a.pm || "" };
  });
  return snap;
}

export function snapshotFor(ctx, dk) {
  return (ctx.notifyLog[dk] || {}).snapshot || null;
}

export function wasNotified(ctx, dk, kind) {
  const entry = ctx.notifyLog[dk] || {};
  return !!(entry[kind] && entry[kind].sentAt);
}

// Who has a different assignment now than when we last told them.
// Returns [] when nothing was ever sent for this day — a day nobody has been
// notified about has no "change" to report, only a first send.
export function changedTechs(ctx, dk) {
  const prev = snapshotFor(ctx, dk);
  if (!prev) return [];
  const cur = buildSnapshot(ctx, dk);
  const out = [];
  Object.keys(cur).forEach(techId => {
    const p = prev[techId] || { am: "", pm: "" };
    const c = cur[techId];
    if (p.am !== c.am || p.pm !== c.pm) out.push({ techId, from: p, to: c });
  });
  return out;
}

function prune(log, todayDk) {
  // One entry per day would otherwise accumulate forever in a single blob.
  const cutoff = new Date(todayDk + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - RETAIN_DAYS);
  const cutoffDk = cutoff.toISOString().slice(0, 10);
  Object.keys(log).forEach(dk => { if (dk < cutoffDk) delete log[dk]; });
  return log;
}

// Read-modify-write of the whole log blob.
//
// Netlify Blobs has no compare-and-set, so a manual send landing in the same instant
// as a cron tick could drop one of the two records. The window is milliseconds and
// the consequence is a missing audit row (never a missed message, since sending
// already happened), so this is accepted rather than locked around.
export async function recordSend(store, dk, kind, results, snapshot, todayDk) {
  const log = await readJson(store, LOG_KEY, {});
  const entry = log[dk] || {};

  if (kind === "change") {
    entry.changes = (entry.changes || []).concat([{ at: Date.now(), results }]).slice(-20);
  } else {
    entry[kind] = { sentAt: Date.now(), results };
  }
  if (snapshot) entry.snapshot = snapshot;

  log[dk] = entry;
  await writeJson(store, LOG_KEY, prune(log, todayDk || dk));
  return entry;
}

// Update one delivery record in place when a provider webhook reports the real
// outcome. Scans recent days only — a receipt for a 90-day-old message is not worth
// rewriting the blob for.
export async function updateDeliveryStatus(store, externalId, status, detail) {
  if (!externalId) return false;
  const log = await readJson(store, LOG_KEY, {});
  const days = Object.keys(log).sort().slice(-14);
  let found = false;

  for (const dk of days) {
    const entry = log[dk];
    const buckets = [entry.evening, entry.morning].filter(Boolean)
      .concat(entry.changes || []);
    for (const b of buckets) {
      for (const r of (b.results || [])) {
        if (r.externalId && String(r.externalId) === String(externalId)) {
          r.status = status;
          r.ok = (status === "delivered" || status === "opened" || status === "queued");
          if (detail) r.error = detail;
          r.updatedAt = Date.now();
          found = true;
        }
      }
    }
  }
  if (found) await writeJson(store, LOG_KEY, log);
  return found;
}
