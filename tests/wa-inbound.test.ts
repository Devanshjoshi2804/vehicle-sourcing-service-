import { describe, it, expect } from "vitest";
import { parseInbound } from "../src/wa/inbound.js";

const base = (message: any, extra: any = {}) => ({
  type: "message_received",
  timestamp: "2026-07-03T10:00:00Z",
  data: {
    customer: { channel_phone_number: "+91 98888 88888", traits: { name: "Ramesh" } },
    message: { id: "m1", message_content_type: "Text", message, ...extra },
  },
});

describe("parseInbound", () => {
  it("ignores non-message events", () => {
    expect(parseInbound({ type: "message_delivered" }, [])).toBeNull();
  });

  it("parses interactive reply JSON in the message field (id wins)", () => {
    const r = parseInbound(base(JSON.stringify({ type: "button_reply", button_reply: { id: "acc:a1:13000", title: "✅ Accept ₹13,000" } })), []);
    expect(r).toMatchObject({ from: "919888888888", kind: "reply", replyId: "acc:a1:13000", msgId: "m1", contactName: "Ramesh" });
  });

  it("parses list_reply JSON", () => {
    const r = parseInbound(base(JSON.stringify({ type: "list_reply", list_reply: { id: "veh:16ft", title: "16ft" } })), []);
    expect(r).toMatchObject({ kind: "reply", replyId: "veh:16ft" });
  });

  it("resolves a title-only echo against lastOptions (emoji-insensitive)", () => {
    const r = parseInbound(base("Accept ₹13,000"), [{ id: "acc:a1:13000", title: "✅ Accept ₹13,000" }]);
    expect(r).toMatchObject({ kind: "reply", replyId: "acc:a1:13000" });
  });

  it("falls through to free text when nothing matches", () => {
    const r = parseInbound(base("16ft mumbai to pune 13000"), [{ id: "x", title: "Confirm" }]);
    expect(r).toMatchObject({ kind: "text", text: "16ft mumbai to pune 13000" });
  });

  it("classifies an image message as media", () => {
    const r = parseInbound(base("", { media_url: "https://ik.media/x.jpg", message_content_type: "Image" }), []);
    expect(r).toMatchObject({ kind: "media", mediaUrl: "https://ik.media/x.jpg" });
  });

  it("classifies a document/pdf message as media", () => {
    const r = parseInbound(base("", { media_url: "https://ik.media/x.pdf", message_content_type: "Document" }), []);
    expect(r).toMatchObject({ kind: "media", mediaUrl: "https://ik.media/x.pdf" });
  });
});
