import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { VisionClient } from "../src/wa/vision.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik", INTERAKT_WEBHOOK_SECRET: "sekrit",
  MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

const inbound = (text: string, phone = "+919888888822") => ({
  type: "message_received",
  data: { customer: { channel_phone_number: phone, traits: { name: "C" } },
          message: { id: `m_${text}`, message_content_type: "Text", message: text } },
});
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", "sekrit").update(body).digest("hex");
const post = (app: any, payload: any, sig?: string) => {
  const body = JSON.stringify(payload);
  return app.inject({ method: "POST", url: "/wa/inbound", payload: body,
    headers: { "content-type": "application/json", "interakt-signature": sig ?? sign(body) } });
};

describe("POST /wa/inbound", () => {
  it("rejects a bad signature", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, interakt: fakeInterakt().client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    const res = await post(app, inbound("hi"), "sha256=deadbeef");
    expect(res.statusCode).toBe(401);
  });

  it("acks 200 and drives the customer flow", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    const res = await post(app, inbound("hello"));
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // async processing
    expect(sent.length).toBeGreaterThan(0); // greeted / prompted
  });

  it("is idempotent on message id", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    await post(app, inbound("same"));
    await new Promise((r) => setTimeout(r, 100));
    const n = sent.length;
    await post(app, inbound("same")); // identical msg id m_same
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(n);
  });

  it("routes a known owner phone to the driver flow", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "R", phone: "+919111111133", vehicleTypes: ["16ft"], lanes: [] } });
    await post(app, inbound("hello", "+919111111133"));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.some((s) => s.kind === "text" && /load matches your route/i.test(s.args[0]))).toBe(true);
  });
});

describe("double-delivery dedup", () => {
  it("processes one button tap only once across two events with different msg ids", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    // seed a session so the tap has context (title irrelevant — id carries the action)
    const reply = JSON.stringify({ type: "button_reply", button_reply: { id: "veh:16ft", title: "16ft" } });
    const payload = (id: string) => ({
      type: "message_received",
      data: { customer: { channel_phone_number: "+919888888844", traits: { name: "C" } },
              message: { id, message_content_type: "Text", message: reply } },
    });
    await post(app, payload("dup_a"));
    await new Promise((r) => setTimeout(r, 120));
    const n = sent.length;
    await post(app, payload("dup_b")); // same tap, different message id (Interakt double delivery)
    await new Promise((r) => setTimeout(r, 120));
    expect(sent.length).toBe(n); // second delivery ignored
  });
});

describe("driver document intake (media)", () => {
  it("a signed media webhook from a driver phone runs the doc pipeline with the injected vision stub and stores a row", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const stubVision: VisionClient = {
      async extract() {
        return {
          ok: true,
          doc: {
            docType: "other", lrNumber: null, billedTotalInr: null, vehicleNo: null,
            from: null, to: null, docDate: null, paidStampSeen: false, confidence: 0.9,
          },
        };
      },
      async extractFromBuffer() {
        return {
          ok: true,
          doc: {
            docType: "other", lrNumber: null, billedTotalInr: null, vehicleNo: null,
            from: null, to: null, docDate: null, paidStampSeen: false, confidence: 0.9,
          },
        };
      },
    };
    const app = buildServer({
      pool, config, interakt: client, vision: stubVision,
      el: { originateCall: async () => ({ conversationId: "c" }) } as any,
    });
    const phone = "+919111111199";
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Driver", phone, vehicleTypes: ["16ft"], lanes: [] } });

    const payload = {
      type: "message_received",
      data: {
        customer: { channel_phone_number: phone, traits: { name: "Driver" } },
        message: { id: "m_doc1", message_content_type: "Image", media_url: "https://ik.media/lr.jpg" },
      },
    };
    const res = await post(app, payload);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // async processing

    expect(sent.some((s) => s.kind === "text" && /doesn't look like an LR or invoice/.test(s.args[0]))).toBe(true);
    const { rows } = await pool.query(`SELECT * FROM driver_docs WHERE phone=$1`, [phone.replace(/\D/g, "")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("other");
  });

  it("two media messages with different media_urls within the dedup window are BOTH processed (not collapsed to one action key)", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const stubVision: VisionClient = {
      async extract() {
        return {
          ok: true,
          doc: {
            docType: "other", lrNumber: null, billedTotalInr: null, vehicleNo: null,
            from: null, to: null, docDate: null, paidStampSeen: false, confidence: 0.9,
          },
        };
      },
      async extractFromBuffer() {
        return {
          ok: true,
          doc: {
            docType: "other", lrNumber: null, billedTotalInr: null, vehicleNo: null,
            from: null, to: null, docDate: null, paidStampSeen: false, confidence: 0.9,
          },
        };
      },
    };
    const app = buildServer({
      pool, config, interakt: client, vision: stubVision,
      el: { originateCall: async () => ({ conversationId: "c" }) } as any,
    });
    const phone = "+919111111188";
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Driver2", phone, vehicleTypes: ["16ft"], lanes: [] } });

    const mediaPayload = (id: string, url: string) => ({
      type: "message_received",
      data: {
        customer: { channel_phone_number: phone, traits: { name: "Driver2" } },
        message: { id, message_content_type: "Image", media_url: url },
      },
    });

    await post(app, mediaPayload("m_photo1", "https://ik.media/photo1.jpg"));
    await new Promise((r) => setTimeout(r, 100));
    await post(app, mediaPayload("m_photo2", "https://ik.media/photo2.jpg")); // different msg id + url, within 45s window
    await new Promise((r) => setTimeout(r, 100));

    const { rows } = await pool.query(`SELECT * FROM driver_docs WHERE phone=$1`, [phone.replace(/\D/g, "")]);
    expect(rows).toHaveLength(2); // both photos processed — not deduped against each other
  });
});

describe("role follows owner active state", () => {
  it("a deactivated driver's number routes to the customer flow", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const app = buildServer({ pool, config, interakt: client, el: { originateCall: async () => ({ conversationId: "c" }) } as any });
    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "R2", phone: "+919111111132", vehicleTypes: ["16ft"], lanes: [] } })).json();
    // first message routes as driver
    await post(app, inbound("hello", "+919111111132"));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.some((s) => /load matches your route/i.test(String(s.args[0])))).toBe(true);
    // deactivate → same number is now a customer
    await app.inject({ method: "PATCH", url: `/owners/${owner.id}`, headers: auth, payload: { active: false } });
    await post(app, inbound("need a truck", "+919111111132"));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.some((s) => /Tell me your load|route, vehicle and price|Pickup city/i.test(String(s.args[0])))).toBe(true);
  });
});
