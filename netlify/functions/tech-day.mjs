// Public, unauthenticated day view for technicians: GET /d?t=<token>&d=YYYY-MM-DD
//
// No login on purpose. A tech opening a link at 6am on a phone should see their
// assignment instantly; a password prompt is the thing that makes people stop
// reading the notification. What makes that acceptable here is the content: staff
// names and clinic site names only, never any patient information.
//
// The token is HMAC-signed and per-tech (see _lib/links.mjs). It is not a bearer
// credential for anything else — it grants read access to this one page and nothing
// in the app.

import { verifyTechToken } from "./_lib/links.mjs";
import {
  techStore, loadContext, todayIn, addDays, isValidDateKey, escapeHtml,
} from "./_lib/techdata.mjs";
import { renderDayPage, renderMonthPage } from "./_lib/dayboard.mjs";

const HTML = {
  "Content-Type": "text/html; charset=utf-8",
  // Never let a signed link get cached by a proxy or indexed.
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

// Same "a mangled link should still show something useful" principle as the `d`
// param: only a well-formed, real month routes to the month page.
function isValidYm(s) {
  if (!/^\d{4}-\d{2}$/.test(String(s || ""))) return false;
  const m = Number(String(s).slice(5, 7));
  return m >= 1 && m <= 12;
}

function errorPage(status, message) {
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Unavailable</title></head>'
    + '<body style="margin:0;background:#f0f0f8;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">'
    + '<div style="max-width:420px;margin:60px auto;padding:28px;background:#fff;border-radius:12px;text-align:center;">'
    + '<div style="font-size:30px;margin-bottom:10px;">🔒</div>'
    + '<h1 style="font-size:18px;margin:0 0 8px;color:#1a1a2e;">' + escapeHtml(message) + '</h1>'
    + '<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0;">'
    + 'Ask the scheduling coordinator for a new link.</p></div></body></html>',
    { status, headers: HTML }
  );
}

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  }

  const LINK_SECRET = process.env.LINK_SECRET;
  if (!LINK_SECRET) {
    console.error("tech-day: LINK_SECRET is not configured");
    return errorPage(500, "This link service is not configured yet");
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  const requested = url.searchParams.get("d") || "";
  const requestedYm = url.searchParams.get("m") || "";

  const store = techStore();
  const ctx = await loadContext(store);

  // Resolve the nonce from the tech's contact record. A tech with no nonce has never
  // had a link issued, so every token for them is rejected.
  const techId = await verifyTechToken(token, LINK_SECRET, id => (ctx.contacts[id] || {}).linkNonce);
  if (!techId) return errorPage(403, "This link is no longer valid");

  const tech = ctx.techs.find(t => t.id === techId);
  if (!tech) return errorPage(404, "This technician is no longer on the schedule");

  const todayDk = todayIn(ctx.settings.timezone);
  const tomorrowDk = addDays(todayDk, 1);

  // Only honour a date that parses; anything else quietly falls back to today rather
  // than erroring, because a mangled link should still show something useful.
  const dk = isValidDateKey(requested) ? requested : todayDk;

  const linkBase = url.pathname + "?t=" + encodeURIComponent(token);

  // A well-formed, real `m` wins and renders the month page; anything else (absent,
  // malformed, out-of-range) falls through to the normal day view rather than erroring.
  const html = isValidYm(requestedYm)
    ? renderMonthPage(ctx, requestedYm, techId, tech.name, { linkBase, todayDk })
    : renderDayPage(ctx, dk, techId, tech.name, { linkBase, todayDk, tomorrowDk });

  return new Response(req.method === "HEAD" ? null : html, { status: 200, headers: HTML });
};
