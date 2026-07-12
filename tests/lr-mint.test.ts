import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { genLrNumber } from "../src/lr/mint.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", GOOGLE_MAPS_API_KEY: "",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const hook = { "x-webhook-secret": "w" };
const fakeGeo = { async resolveLocation(text: string) {
  return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "test" };
} };

describe("LR minting on book", () => {
  // Note: the brief mentions "/loads/:id/call" for the direct-call path, but that
  // route only creates call_attempts — it never produces a demand_requests row, so
  // /demand/:id/approve-driver and /demand/:id/book (which operate on a demand)
  // have nothing to act on afterward. The full domino chain that actually reaches
  // /demand/:id/book (as in tests/side-a-flow.test.ts) starts from
  // /webhooks/report-demand instead — using that here.
  it("demand /book route mints an LR mapped to the winning owner, idempotent on re-book attempts", async () => {
    const { pool } = await withTestDb();
    const placed: { conv: string }[] = [];
    let n = 0;
    const el = { originateCall: async () => { const conv = `conv_${++n}`; placed.push({ conv }); return { conversationId: conv }; } };
    const app = buildServer({ pool, config, geo: fakeGeo as any, el: el as any });

    // voice-channel driver (default channel) on the lane
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Ramesh", phone: "+919111100022", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }] } });

    const cap = (await app.inject({ method: "POST", url: "/webhooks/report-demand", headers: hook,
      payload: { conversationId: "lrmint_1", customerPhone: "+919888800001", fromText: "Mumbai", toText: "Pune",
        vehicleType: "16ft", offeredPriceInr: 14000, pickupDate: "2026-07-20" } })).json();
    const demandId = cap.demandId;

    await app.inject({ method: "POST", url: "/webhooks/report-availability", headers: hook,
      payload: { conversationId: placed[0].conv, available: "YES", acceptsFixed: true, quotedPriceInr: 14000 } });

    let d = (await app.inject({ method: "GET", url: `/demand/${demandId}`, headers: auth })).json();
    expect(d.status).toBe("DRIVER_LOCKED");
    const winner = d.winningOwnerId;

    await app.inject({ method: "POST", url: `/demand/${demandId}/approve-driver`, headers: auth });

    const book1 = await app.inject({ method: "POST", url: `/demand/${demandId}/book`, headers: auth });
    expect(book1.statusCode).toBe(200);

    const lrsRepo = new LrsRepo(pool);
    const lr = await lrsRepo.getByLoad(d.loadId);
    expect(lr).toBeTruthy();
    expect(lr!.lrNumber).toMatch(/^PIN-[A-Z0-9]{6}$/);
    expect(lr!.ownerId).toBe(winner);
    expect(lr!.status).toBe("UNPAID");

    // re-book attempt: demand is already BOOKED → 409, no second LR
    const book2 = await app.inject({ method: "POST", url: `/demand/${demandId}/book`, headers: auth });
    expect(book2.statusCode).toBe(409);
    expect((await lrsRepo.listByOwner(winner)).length).toBe(1);
  });

  it("WA bok: tap mints + notifies the driver", async () => {
    const { pool } = await withTestDb();
    const { client, sent } = fakeInterakt();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `v${placed.length}` }) };
    const app = buildServer({ pool, config, geo: fakeGeo as any, el: el as any, interakt: client });

    // WA-preference driver on the lane
    await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "Ramesh", phone: "+919111111122", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "whatsapp" } });

    const waMsg = (phone: string, message: any, id: string) => {
      const body = JSON.stringify({ type: "message_received",
        data: { customer: { channel_phone_number: phone, traits: { name: "X" } },
                message: { id, message_content_type: "Text", message } } });
      const sig = "sha256=" + crypto.createHmac("sha256", "sekrit").update(body).digest("hex");
      return app.inject({ method: "POST", url: "/wa/inbound", payload: body,
        headers: { "content-type": "application/json", "interakt-signature": sig } });
    };
    const settle = () => new Promise((r) => setTimeout(r, 150));

    await waMsg("+919888888811", "need a truck", "m1");
    await settle();
    await waMsg("+919888888811", "Mumbai", "m2"); await settle();
    await waMsg("+919888888811", "Pune", "m3"); await settle();
    await waMsg("+919888888811", JSON.stringify({ type: "list_reply", list_reply: { id: "veh:16ft", title: "16ft" } }), "m4"); await settle();
    await waMsg("+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "date:tomorrow", title: "Tomorrow" } }), "m5"); await settle();
    await waMsg("+919888888811", "13000", "m6"); await settle();
    await waMsg("+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: "cfm:yes", title: "✅ Confirm" } }), "m7"); await settle();

    const demands = (await app.inject({ method: "GET", url: "/demand", headers: auth })).json();
    const offer = sent.find((s) => (s.kind === "buttons" || s.kind === "template") && s.to === "919111111122");
    const offerButtons = offer!.kind === "buttons" ? offer!.args[1] : null;
    const attemptId = (offerButtons ? (offerButtons[0].id as string) : (offer!.args[2]["0"][0] as string)).split(":")[1];

    await waMsg("+919111111122", JSON.stringify({ type: "button_reply", button_reply: { id: `acc:${attemptId}:13000`, title: "Accept" } }), "m8");
    await settle();

    let d = (await app.inject({ method: "GET", url: `/demand/${demands[0].id}`, headers: auth })).json();
    await app.inject({ method: "POST", url: `/demand/${d.id}/approve-driver`, headers: auth });

    await waMsg("+919888888811", JSON.stringify({ type: "button_reply", button_reply: { id: `bok:${d.id}`, title: "Confirm booking" } }), "m9");
    await settle();

    d = (await app.inject({ method: "GET", url: `/demand/${d.id}`, headers: auth })).json();
    expect(d.status).toBe("BOOKED");

    expect(sent.some((s) => s.kind === "text" && s.to === "919111111122" && /Your LR: PIN-/.test(s.args[0]))).toBe(true);
  });

  it("genLrNumber never contains O or I across 200 generations and always matches /^PIN-[A-Z0-9]{6}$/", () => {
    for (let i = 0; i < 200; i++) {
      const n = genLrNumber();
      expect(n).toMatch(/^PIN-[A-Z0-9]{6}$/);
      expect(n.slice(4)).not.toMatch(/[OI]/);
    }
  });

  it("mintLr never throws — a failing lrs insert returns null", async () => {
    const { pool } = await withTestDb();
    const { mintLr } = await import("../src/lr/mint.js");
    const deps: any = {
      lrsRepo: { getByLoad: async () => null, create: async () => { throw new Error("db down"); } },
      loadsRepo: { getLoad: async () => ({ id: "x", fromLocation: "A", toLocation: "B", fixedPriceInr: 1 }) },
      demandRepo: { findByLoadId: async () => null },
      ownersRepo: { getActiveOwners: async () => [] },
    };
    await expect(mintLr(deps, "00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });
});
