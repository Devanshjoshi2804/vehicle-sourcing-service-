// Structural subset of mailparser's ParsedMail — keeps fixtures free of real IMAP.
export type ParsedMailLike = {
  from?: { value: { address?: string }[] };
  messageId?: string;
  subject?: string;
  text?: string;
  html?: string | false;
  headers?: Map<string, unknown>;
  attachments?: { content: Buffer; contentType?: string; filename?: string }[];
};

export type EmailAttachment = { buffer: Buffer; mime: string; filename: string };

export type EmailMsg = {
  from: string;
  messageId: string;
  subject: string;
  text: string;
  attachments: EmailAttachment[];
  tags: { lr?: string; load?: string; attempt?: string; demand?: string };
  autoReply: boolean;
};

const AUTO_REPLY_LOCALS = new Set(["mailer-daemon", "no-reply", "noreply", "postmaster"]);

// mailparser stores some headers as plain strings, others as {value, params}.
const headerString = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in (v as any)) return String((v as any).value);
  return undefined;
};

// ponytail: tag-strip only, not a real HTML renderer — mailparser already fills
// .text for html mails in practice, this is just the documented fallback.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const QUOTE_MARKERS = [/^On .{5,80} wrote:$/, /^-{2,}\s*Original Message/i, /^From: /];

// Drop `>` quote lines and anything from the first quote-marker line onward,
// then drop a trailing signature block, then keep the first 10 non-empty lines.
function stripQuoteAndSignature(body: string): string {
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(">")) continue;
    if (QUOTE_MARKERS.some((re) => re.test(line))) break;
    lines.push(line);
  }
  const sigIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t === "--" || /^(Regards,|Thanks,)/.test(t);
  });
  const body2 = sigIdx === -1 ? lines : lines.slice(0, sigIdx);
  return body2
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10)
    .join("\n");
}

function parseTags(subject: string): EmailMsg["tags"] {
  const tags: EmailMsg["tags"] = {};
  const pin = subject.match(/\[PIN-([A-Z0-9]{6})\]/i);
  if (pin) tags.lr = pin[1].toUpperCase();
  const load = subject.match(/\[LOAD-([a-z0-9-]{4,36})\]/i);
  if (load) tags.load = load[1];
  const att = subject.match(/\[ATT-([a-f0-9-]{36})\]/i);
  if (att) tags.attempt = att[1];
  const dmd = subject.match(/\[DMD-([a-f0-9-]{36})\]/i);
  if (dmd) tags.demand = dmd[1];
  return tags;
}

export function normalizeEmail(parsed: ParsedMailLike): EmailMsg {
  const from = (parsed.from?.value?.[0]?.address ?? "").toLowerCase();
  const subject = parsed.subject ?? "";
  const rawBody = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");

  const autoSubmitted = headerString(parsed.headers?.get("auto-submitted"));
  const localPart = from.split("@")[0];
  const autoReply = (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== "no")
    || AUTO_REPLY_LOCALS.has(localPart);

  const attachments: EmailAttachment[] = (parsed.attachments ?? [])
    .slice(0, 5)
    .map((a) => ({ buffer: a.content, mime: a.contentType ?? "application/octet-stream", filename: a.filename ?? "" }));

  return {
    from,
    messageId: parsed.messageId ?? "",
    subject,
    text: stripQuoteAndSignature(rawBody),
    attachments,
    tags: parseTags(subject),
    autoReply,
  };
}
