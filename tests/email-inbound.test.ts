import { describe, it, expect } from "vitest";
import { normalizeEmail, ParsedMailLike } from "../src/email/inbound.js";

const base = (over: Partial<ParsedMailLike>): ParsedMailLike => ({
  from: { value: [{ address: "Driver@Example.com" }] },
  messageId: "<m1@example.com>",
  subject: "Re: quote",
  ...over,
});

describe("normalizeEmail", () => {
  it("parses a plain body", () => {
    const msg = normalizeEmail(base({ text: "Line one\nLine two" }));
    expect(msg.from).toBe("driver@example.com");
    expect(msg.text).toBe("Line one\nLine two");
    expect(msg.autoReply).toBe(false);
  });

  it("falls back to html-derived text when .text is missing", () => {
    const msg = normalizeEmail(base({ text: undefined, html: "<p>Hello</p><p>World</p>" }));
    expect(msg.text).toBe("Hello\nWorld");
  });

  it("uses .text directly for html mails (mailparser already fills it)", () => {
    const msg = normalizeEmail(base({ text: "Hello\nWorld", html: "<p>Hello</p><p>World</p>" }));
    expect(msg.text).toBe("Hello\nWorld");
  });

  it("strips quoted reply, keeping only fresh lines", () => {
    const body = [
      "Sure, I can do Tuesday.",
      "Works for me.",
      "On Mon, Jan 5, 2026 at 3:00 PM John Doe <john@x.com> wrote:",
      "> Can you do Tuesday?",
      "> Let me know.",
    ].join("\n");
    const msg = normalizeEmail(base({ text: body }));
    expect(msg.text).toBe("Sure, I can do Tuesday.\nWorks for me.");
  });

  it("strips a --- Original Message --- block and a From: header line", () => {
    const body = [
      "Fresh reply line.",
      "----- Original Message -----",
      "From: someone@x.com",
      "old quoted stuff",
    ].join("\n");
    const msg = normalizeEmail(base({ text: body }));
    expect(msg.text).toBe("Fresh reply line.");
  });

  it("strips a trailing signature block", () => {
    const body = ["Hi there,", "See you soon.", "--", "John Doe", "555-1234"].join("\n");
    const msg = normalizeEmail(base({ text: body }));
    expect(msg.text).toBe("Hi there,\nSee you soon.");
  });

  it("strips a Regards, signature block", () => {
    const body = ["Confirmed for pickup.", "Regards,", "John"].join("\n");
    const msg = normalizeEmail(base({ text: body }));
    expect(msg.text).toBe("Confirmed for pickup.");
  });

  it("flags autoReply via the auto-submitted header", () => {
    const msg = normalizeEmail(base({
      from: { value: [{ address: "someone@x.com" }] },
      headers: new Map([["auto-submitted", "auto-replied"]]),
      text: "Out of office",
    }));
    expect(msg.autoReply).toBe(true);
  });

  it("does not flag autoReply when auto-submitted is 'no'", () => {
    const msg = normalizeEmail(base({
      from: { value: [{ address: "someone@x.com" }] },
      headers: new Map([["auto-submitted", "no"]]),
      text: "Hello",
    }));
    expect(msg.autoReply).toBe(false);
  });

  it("flags autoReply for no-reply-style senders", () => {
    const msg = normalizeEmail(base({ from: { value: [{ address: "no-reply@carrier.com" }] }, text: "hi" }));
    expect(msg.autoReply).toBe(true);
  });

  it("flags autoReply for mailer-daemon senders", () => {
    const msg = normalizeEmail(base({ from: { value: [{ address: "MAILER-DAEMON@x.com" }] }, text: "bounce" }));
    expect(msg.autoReply).toBe(true);
  });

  it("caps attachments at 5 out of 7", () => {
    const attachments = Array.from({ length: 7 }, (_, i) => ({
      content: Buffer.from(`file${i}`),
      contentType: "image/jpeg",
      filename: `f${i}.jpg`,
    }));
    const msg = normalizeEmail(base({ text: "photos attached", attachments }));
    expect(msg.attachments).toHaveLength(5);
    expect(msg.attachments[0]).toMatchObject({ mime: "image/jpeg", filename: "f0.jpg" });
    expect(Buffer.isBuffer(msg.attachments[0].buffer)).toBe(true);
  });

  it("parses tags from the subject", () => {
    const msg = normalizeEmail(base({
      subject: "Update [PIN-abc123] [LOAD-my-load-1] [ATT-0f8a1b2c-1111-2222-3333-444455556666] [DMD-aaaaaaaa-1111-2222-3333-444455556666]",
      text: "body",
    }));
    expect(msg.tags).toEqual({
      lr: "ABC123",
      load: "my-load-1",
      attempt: "0f8a1b2c-1111-2222-3333-444455556666",
      demand: "aaaaaaaa-1111-2222-3333-444455556666",
    });
  });

  it("keeps only the first 10 non-empty lines", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`);
    const msg = normalizeEmail(base({ text: lines.join("\n") }));
    expect(msg.text.split("\n")).toHaveLength(10);
    expect(msg.text.split("\n")[9]).toBe("line 9");
  });
});
