// Branded HTML for every outbound email + the magic-link result pages.
// Rules for email HTML: inline styles only (Gmail strips <style>/<head>), table
// layout for Outlook, no external images/CSS/fonts (nothing to host), emoji as
// iconography. Each builder returns { subject, text, html } — text is the
// plaintext fallback and is what our own inbound parser reads on replies.

const BRAND = "#0B6E4F"; // Pinified green
const DEEP = "#08301F";
const AMBER = "#E08600";
const PAPER = "#F4F1EA";
const CARD = "#FFFFFF";
const INK = "#1C2B24";
const MUTE = "#6B7A72";
const LINE = "#E7E3D8";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Bulletproof table button (renders in Outlook + Gmail + Apple Mail).
function button(label: string, href: string, bg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0;">
    <tr><td align="center" bgcolor="${bg}" style="border-radius:10px;">
      <a href="${esc(href)}" target="_blank"
         style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">
        ${esc(label)}</a>
    </td></tr></table>`;
}

// Outer shell: warm paper bg, wordmark header, white card, footer.
function shell(innerHtml: string, preheader = ""): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${PAPER};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 6px 16px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:${DEEP};letter-spacing:.5px;">🚚 Pinified</span>
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${MUTE};text-transform:uppercase;letter-spacing:2px;padding-left:8px;">Freight Dispatch</span>
        </td></tr>
        <tr><td style="background:${CARD};border:1px solid ${LINE};border-radius:16px;padding:26px 26px 22px;">
          ${innerHtml}
        </td></tr>
        <tr><td style="padding:16px 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:${MUTE};">
          You're receiving this because you work loads with Pinified. Reply to this email to reach our team.<br>
          © Pinified · Freight sourcing, automated.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// A route "card" strip reused by offer + confirm.
function routeCard(from: string, to: string, vehicle: string, date: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border-radius:12px;padding:14px 16px;margin:4px 0 18px;">
    <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:${INK};">
      ${esc(from)} <span style="color:${AMBER};">→</span> ${esc(to)}
    </td></tr>
    <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${MUTE};padding-top:6px;">
      ${esc(vehicle)} &nbsp;·&nbsp; pickup ${esc(date)}
    </td></tr>
  </table>`;
}

function priceRow(label: string, value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 20px;">
    <tr>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${MUTE};text-transform:uppercase;letter-spacing:1px;">${esc(label)}</td>
      <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;color:${BRAND};">${esc(value)}</td>
    </tr></table>`;
}

const h = (t: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:${INK};margin:0 0 4px;">${esc(t)}</div>`;
const p = (t: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${INK};margin:0 0 14px;">${esc(t)}</div>`;
const hint = (t: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.6;color:${MUTE};margin:14px 0 0;">${esc(t)}</div>`;

export type Built = { subject: string; text: string; html: string };

// ---- driver offer ----
export function offerEmail(a: {
  from: string; to: string; vehicle: string; date: string; priceInr: string;
  accHref: string; decHref: string; attemptTag: string;
}): Built {
  const subject = `New load [${a.attemptTag}] — ${a.from} → ${a.to} · ${a.priceInr}`;
  const text =
    `New load — Pinified\n${a.from} → ${a.to} · ${a.vehicle} · pickup ${a.date}\nFreight: ${a.priceInr}\n\n` +
    `Accept: ${a.accHref}\nNot available: ${a.decHref}\nCounter: reply to this email with your price (e.g. 16500)\n`;
  const html = shell(
    h("New load available") +
      routeCard(a.from, a.to, a.vehicle, a.date) +
      priceRow("Freight", a.priceInr) +
      button("✅ Accept this load", a.accHref, BRAND) +
      button("❌ Not available", a.decHref, "#8A9691") +
      hint('Want a different rate? Just reply to this email with your price (e.g. "16500") and our team will review it.'),
    `${a.from} → ${a.to} · ${a.priceInr}`,
  );
  return { subject, text, html };
}

// ---- booking confirm (customer) ----
export function confirmEmail(a: {
  from: string; to: string; vehicle: string; date: string; priceInr: string;
  driver: string; bokHref: string; nbkHref: string; demandTag: string;
}): Built {
  const subject = `Confirm booking [${a.demandTag}] — ${a.from} → ${a.to}`;
  const text =
    `Driver found for your load!\n${a.from} → ${a.to} · ${a.vehicle} · ${a.date}\n` +
    `Agreed price: ${a.priceInr}\nDriver: ${a.driver}\n\n` +
    `Confirm booking: ${a.bokHref}\nDecline: ${a.nbkHref}\n`;
  const html = shell(
    h("🚛 Driver found for your load") +
      routeCard(a.from, a.to, a.vehicle, a.date) +
      priceRow("Agreed price", a.priceInr) +
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${MUTE};margin:-10px 0 18px;">Driver: <b style="color:${INK};">${esc(a.driver)}</b></div>` +
      button("✅ Confirm booking", a.bokHref, BRAND) +
      button("❌ Decline", a.nbkHref, "#8A9691") +
      hint("Confirming books the trip and notifies the driver. You can reply to this email anytime with questions."),
    `Driver found · ${a.priceInr} · confirm to book`,
  );
  return { subject, text, html };
}

// ---- generic notice (LR mint, payment released, load filled, acks) ----
// Wraps a plain message in the brand shell; preserves line breaks, linkifies urls.
export function noticeEmail(subject: string, title: string, body: string): Built {
  const bodyHtml = esc(body)
    .replace(/(https?:\/\/[^\s]+)/g, `<a href="$1" style="color:${BRAND};">$1</a>`)
    .replace(/\n/g, "<br>");
  const html = shell(
    (title ? h(title) : "") +
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:${INK};">${bodyHtml}</div>`,
    title || subject,
  );
  return { subject, text: body, html };
}

// ---- the tiny standalone page shown after a magic-link click ----
export function resultPage(emoji: string, title: string, sub: string, tone: "ok" | "warn" = "ok"): string {
  const accent = tone === "ok" ? BRAND : AMBER;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pinified</title></head>
  <body style="margin:0;background:${PAPER};font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:440px;margin:12vh auto;padding:0 20px;text-align:center;">
      <div style="font-size:16px;font-weight:bold;color:${DEEP};letter-spacing:.5px;margin-bottom:28px;">🚚 Pinified</div>
      <div style="background:${CARD};border:1px solid ${LINE};border-radius:18px;padding:36px 26px;">
        <div style="font-size:52px;line-height:1;margin-bottom:14px;">${emoji}</div>
        <div style="font-size:21px;font-weight:bold;color:${INK};margin-bottom:8px;">${esc(title)}</div>
        <div style="font-size:14px;line-height:1.6;color:${MUTE};">${esc(sub)}</div>
        <div style="height:4px;width:56px;background:${accent};border-radius:4px;margin:22px auto 0;"></div>
      </div>
      <div style="font-size:12px;color:${MUTE};margin-top:18px;">You can close this tab.</div>
    </div>
  </body></html>`;
}
