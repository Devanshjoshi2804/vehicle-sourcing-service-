import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { CallOrchestrator } from "../src/calls/orchestrator.js";
import { handleCustomerMessage } from "../src/wa/customer-flow.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);
const fakeGeo = { async resolveLocation(text: string) {
  return { raw: text, canonical: text, city: text, state: "MH", lat: 19.1, lng: 72.8, source: "test" };
} };

async function setup(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const demand = new DemandRepo(pool), sessions = new WaSessionsRepo(pool);
  await owners.createOwner({ name: "D", phone: "+919111111144", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }] });
  const el = { originateCall: async () => ({ conversationId: `c${Math.random()}` }) };
  const orchestrator = new CallOrchestrator({ pool, config, el: el as any, ownersRepo: owners, loadsRepo: loads, callsRepo: calls });
  const { client, sent } = fakeInterakt();
  const parsed = { fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 13000, pickupDate: "2026-07-05" };
  const deps = {
    capture: { demandRepo: demand, loadsRepo: loads, ownersRepo: owners, callsRepo: calls, orchestrator, geo: fakeGeo },
    interakt: client, sessions, demandRepo: demand, loadsRepo: loads,
    parseLoad: async () => parsed, config,
  };
  return { deps, sent, sessions, demand, loads, parsed };
}
const msg = (over: any) => ({ from: "919888888833", msgId: `m${Math.random()}`, contactName: "C", ...over });

describe("customer flow", () => {
  it("one-shot parse → confirm summary → sourced demand with channel whatsapp", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions, demand } = await setup(pool);
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "16ft mumbai pune 13000 for 5 july" }) as any, null);
    // summary with confirm buttons
    expect(sent.some((s) => s.kind === "buttons" && /Mumbai/.test(s.args[0]) && /13,000/.test(s.args[0]))).toBe(true);
    const session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: "cfm:yes" }) as any, session);
    const demands = await demand.list();
    expect(demands[0]).toMatchObject({ channel: "whatsapp", status: "SOURCING", offeredPriceInr: 13000 });
    expect(sent.some((s) => s.kind === "text" && /truck/i.test(s.args[0]))).toBe(true);
  });

  it("missing vehicle → asks with a list, fills, then confirms", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions } = await setup(pool);
    (deps as any).parseLoad = async () => ({ fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: 13000, pickupDate: "2026-07-05" });
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai pune 13000" }) as any, null);
    expect(sent.some((s) => s.kind === "list")).toBe(true);
    let session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE");
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: "veh:16ft" }) as any, session);
    session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
  });

  it("booking confirm tap books the demand", async () => {
    const { pool } = await withTestDb();
    const { deps, sessions, demand, loads } = await setup(pool);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888888833", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-05", elConversationId: "wa_test1", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, (await new OwnersRepo(pool).listOwners())[0].id, 14000);
    await demand.approveValue(d.id);
    const session = { phone: "919888888833", role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: d.id }, lastOptions: [] };
    await handleCustomerMessage(deps as any, msg({ kind: "reply", replyId: `bok:${d.id}` }) as any, session as any);
    expect((await demand.getById(d.id))!.status).toBe("BOOKED");
    expect((await loads.getLoad(load.id))!.status).toBe("BOOKED");
  });

  it("free text while CONFIRM_BOOKING is nudged, session stays, no demand created", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions, demand } = await setup(pool);
    const session = await sessions.upsert({
      phone: "919888888833", role: "customer", state: "CONFIRM_BOOKING",
      ctx: { demandId: "00000000-0000-0000-0000-000000000000" }, lastOptions: [],
    });
    const before = await demand.list();
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "yes" }) as any, session);
    const after = await sessions.get("919888888833");
    expect(after!.state).toBe("CONFIRM_BOOKING");
    expect(sent.some((s) => s.kind === "text" && /Confirm booking|Decline/.test(s.args[0]))).toBe(true);
    expect(await demand.list()).toEqual(before);
  });

  it("free text mid-flow does not reset the draft", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions } = await setup(pool);
    let parseCalls = 0;
    // Second call (if the bug still ran parseLoad from scratch) returns a draft
    // missing everything — that would prove the original fields got discarded.
    (deps as any).parseLoad = async () => {
      parseCalls++;
      if (parseCalls === 1) return { fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: 13000, pickupDate: "2026-07-05" };
      return { fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null };
    };
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai pune 13000" }) as any, null);
    let session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE");
    // customer types instead of tapping the list
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "kuch bada wala chahiye bhai" }) as any, session);
    session = await sessions.get("919888888833");
    // mid-flow sentences are parse-MERGED now; an unparseable one must still
    // keep the draft and re-prompt (parseCalls: 1 intake + 1 merge attempt)
    expect(parseCalls).toBe(2);
    expect(session!.state).toBe("ASK_VEHICLE");                    // still asking vehicle
    expect((session!.ctx.draft as any).fromText).toBe("Mumbai");   // draft intact
    expect(sent.filter((s) => s.kind === "list").length).toBe(2);  // list re-sent
  });
});

describe("typed confirmations", () => {
  it('typed "haan" at CONFIRM posts the load', async () => {
    const { pool } = await withTestDb();
    const { deps, sessions, demand } = await setup(pool);
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "16ft mumbai pune 13000" }) as any, null);
    const session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "haan" }) as any, session);
    const demands = await demand.list();
    expect(demands[0]).toMatchObject({ channel: "whatsapp", status: "SOURCING" });
  });

  it('typed "yes" at CONFIRM_BOOKING books', async () => {
    const { pool } = await withTestDb();
    const { deps, sessions, demand, loads } = await setup(pool);
    const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
    const { demand: d } = await demand.upsertByConversation({
      customerPhone: "+919888888833", fromText: "Mumbai", toText: "Pune", vehicleType: "16ft",
      offeredPriceInr: 13000, pickupDate: "2026-07-05", elConversationId: "wa_typed1", channel: "whatsapp",
    } as any);
    await demand.attachLoad(d.id, load.id);
    await demand.setStatus(d.id, "SOURCING");
    await demand.lockDriver(load.id, (await new OwnersRepo(pool).listOwners())[0].id, 14000);
    await demand.approveValue(d.id);
    const session = { phone: "919888888833", role: "customer", state: "CONFIRM_BOOKING", ctx: { demandId: d.id }, lastOptions: [] };
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "haan book karo" }) as any, session as any);
    expect((await demand.getById(d.id))!.status).toBe("BOOKED");
  });
});

describe("mid-flow sentence merge + list fallback", () => {
  it("a full sentence at ASK_VEHICLE fills the draft and reaches the summary", async () => {
    const { pool } = await withTestDb();
    const { deps, sessions } = await setup(pool);
    (deps as any).parseLoad = async (t: string) =>
      t.includes("17000")
        ? { fromText: "Mumbai", toText: "Pune", vehicleType: "16ft", priceInr: 17000, pickupDate: "2026-07-05" }
        : { fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: null, pickupDate: null };
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai to pune bhejna hai" }) as any, null);
    let session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE");
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "16ft mumbai to Pune 17000 tomorrow" }) as any, session);
    session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
    expect(session!.ctx.draft as any).toMatchObject({ vehicleType: "16ft", priceInr: 17000 });
  });

  it("typed vehicle number/name works at ASK_VEHICLE", async () => {
    const { pool } = await withTestDb();
    const { deps, sessions } = await setup(pool);
    (deps as any).parseLoad = async () => ({ fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: 13000, pickupDate: "2026-07-05" });
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai pune 13000" }) as any, null);
    let session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE");
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "3" }) as any, session); // 3 = 16ft
    session = await sessions.get("919888888833");
    expect(session!.state).toBe("CONFIRM");
    expect((session!.ctx.draft as any).vehicleType).toBe("16ft");
  });

  it("falls back to a numbered text menu when the list send fails", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, sessions } = await setup(pool);
    (deps as any).parseLoad = async () => ({ fromText: "Mumbai", toText: "Pune", vehicleType: null, priceInr: 13000, pickupDate: "2026-07-05" });
    (deps.interakt as any).sendList = async () => { throw new Error("title is a required field"); };
    await handleCustomerMessage(deps as any, msg({ kind: "text", text: "mumbai pune 13000" }) as any, null);
    const session = await sessions.get("919888888833");
    expect(session!.state).toBe("ASK_VEHICLE"); // customer not left hanging
    expect(sent.some((s) => s.kind === "text" && /1\. Tata Ace/.test(s.args[0]))).toBe(true);
    expect(session!.lastOptions.length).toBe(7); // typed names still resolve
  });
});
