// Brevo transactional email adapter. No SDK — one HTTPS call.
//
// Brevo over Resend because of the DAILY cap, not the monthly one: Resend's free tier
// is 3,000/month but only 100/day, and this app's load sits right on that cliff
// (~30 techs x 2 scheduled sends = 60/day, and a day with a dozen reassignments goes
// past 100). Brevo's free tier is 300/day. SendGrid retired its free plan in 2025.
//
// Swapping providers means rewriting this one file — nothing above it knows the
// difference.

const API = "https://api.brevo.com/v3/smtp/email";

export const id = "email";
export const label = "Email";

export function isConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.EMAIL_FROM);
}

export async function send({ tech, contact, message }) {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return { ok: false, status: "not_configured", error: "BREVO_API_KEY / EMAIL_FROM not set" };

  const to = contact && contact.email;
  if (!to) return { ok: false, status: "no_target", error: "No email address on file" };
  if (contact.emailBounced) {
    // A hard bounce already proved this address is dead. Sending again would burn
    // sender reputation for no chance of delivery.
    return { ok: false, status: "unreachable", error: "Address previously hard-bounced" };
  }

  const payload = {
    sender: { email: from, name: process.env.EMAIL_FROM_NAME || "Scheduling" },
    to: [{ email: to, name: tech.name }],
    subject: message.subject,
    htmlContent: message.emailHtml,
    textContent: message.emailText,
    tags: ["tech-schedule", message.kind || "day"],
  };

  let res, data;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  } catch (e) {
    return { ok: false, status: "failed", error: "Network error: " + e.message };
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.code)) || ("HTTP " + res.status);
    // 400 on a malformed recipient is permanent; 429/5xx are worth retrying.
    return { ok: false, status: res.status === 400 ? "unreachable" : "failed", error: String(msg) };
  }

  // Accepted, not yet delivered — the real outcome arrives at email-webhook.mjs.
  return { ok: true, status: "queued", externalId: (data && data.messageId) || null };
}
