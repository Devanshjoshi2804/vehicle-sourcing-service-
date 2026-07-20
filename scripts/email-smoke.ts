// Live smoke: sends one offer-style email to the address in argv[2], prints the accept link.
//   npx tsx scripts/email-smoke.ts user@example.com

import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { buildMailer } from "../src/email/mailer.js";
import { signAction } from "../src/email/tokens.js";

const to = process.argv[2];
if (!to) throw new Error("usage: npx tsx scripts/email-smoke.ts <email>");

const config = loadConfig();
const mailer = buildMailer(config);

// Fake attempt id for demo
const attemptId = crypto.randomUUID();

// Sign an accept token
const accToken = signAction(config.webhookSecret, {
  a: "acc",
  id: attemptId,
  p: 15000,
});

// Build the magic link
const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
const acceptLink = `${baseUrl}/e/accept?token=${accToken}`;

// Compose the email
const subject = "New load [ATT-001] — Mumbai → Pune · ₹15000";
const text = `
A new load is available.

Route: Mumbai → Pune
Vehicle: 16ft
Pickup: 2026-07-20
Price: ₹15000 (fixed)

Accept this load:
${acceptLink}

Reply "YES" to this email or click the link above.
`;

const html = `
<h2>New load [ATT-001]</h2>
<p><strong>Route:</strong> Mumbai → Pune<br/>
<strong>Vehicle:</strong> 16ft<br/>
<strong>Pickup:</strong> 2026-07-20<br/>
<strong>Price:</strong> ₹15000 (fixed)</p>
<p><a href="${acceptLink}">Accept this load</a></p>
<p>Reply "YES" to this email or click the link above.</p>
`;

// Send (but catch for smoke testing)
const sent = await mailer.send(to, subject, text, html);
console.log(`Email ${sent ? "sent" : "FAILED"} to ${to}`);
console.log(`\nAccept magic link:\n${acceptLink}`);
