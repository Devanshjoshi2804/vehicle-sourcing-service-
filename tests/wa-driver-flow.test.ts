import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { QuotesRepo } from "../src/quotes/quotes.repo.js";
import { DemandRepo } from "../src/demand/demand.repo.js";
import { WaSessionsRepo } from "../src/wa/wa-sessions.repo.js";
import { handleDriverMessage } from "../src/wa/driver-flow.js";
import { fakeInterakt } from "./helpers/wa.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", INTERAKT_API_KEY: "ik",
} as NodeJS.ProcessEnv);

async function setup(pool: any) {
  const owners = new OwnersRepo(pool), loads = new LoadsRepo(pool), calls = new CallsRepo(pool);
  const quotes = new QuotesRepo(pool), demand = new DemandRepo(pool), sessions = new WaSessionsRepo(pool);
  const owner = await owners.createOwner({ name: "R", phone: "+919111111155", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp" } as any);
  const load = await loads.createLoad({ fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" });
  await loads.setStatus(load.id, "CALLING");
  const attempt = await calls.create({ loadId: load.id, ownerId: owner.id, phone: owner.phone, flow: "offer", channel: "wa" });
  await calls.setConversationId(attempt.id, `wa_${attempt.id}`);
  await calls.setStatus(attempt.id, "IN_PROGRESS");
  const { client, sent } = fakeInterakt();
  let filled = 0;
  const deps = {
    availability: {
      quotesRepo: quotes, callsRepo: calls, loadsRepo: loads, demandRepo: demand,
      orchestrator: { notifyFilled: async () => { filled++; } },
    },
    interakt: client, sessions, callsRepo: calls, loadsRepo: loads, config,
  };
  return { deps, sent, owner, load, attempt, calls, quotes, sessions, getFilled: () => filled };
}
const msg = (from: string, over: any) => ({ from, msgId: `m${Math.random()}`, contactName: "R", ...over });

describe("driver flow", () => {
  it("accept locks the load and confirms to the driver", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, load, attempt, calls, getFilled } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `acc:${attempt.id}:13000` }) as any, null);
    expect((await calls.getById(attempt.id))!.status).toBe("DONE");
    const { LoadsRepo } = await import("../src/loads/loads.repo.js");
    expect((await new LoadsRepo(pool).getLoad(load.id))!.status).toBe("LOCKED");
    expect(sent.some((s) => s.kind === "text" && /yours/i.test(s.args[0]))).toBe(true);
    expect(getFilled()).toBe(1);
  });

  it("counter asks for the amount, then records the quote", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, attempt, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `ctr:${attempt.id}` }) as any, null);
    expect(sent.some((s) => s.kind === "text" && /price/i.test(s.args[0]))).toBe(true);
    const session = { phone: "919111111155", role: "driver", state: "AWAIT_PRICE", ctx: { attemptId: attempt.id }, lastOptions: [] };
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "14,000 rs" }) as any, session as any);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0]).toMatchObject({ available: "YES", acceptsFixed: false, quotedPriceInr: 14000 });
  });

  it("no marks unavailable", async () => {
    const { pool } = await withTestDb();
    const { deps, attempt, quotes, load } = await setup(pool);
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "reply", replyId: `no:${attempt.id}` }) as any, null);
    const qs = await quotes.listByLoad(load.id);
    expect(qs[0].available).toBe("NO");
  });

  it("unparseable price re-asks once", async () => {
    const { pool } = await withTestDb();
    const { deps, sent, attempt } = await setup(pool);
    const session = { phone: "919111111155", role: "driver", state: "AWAIT_PRICE", ctx: { attemptId: attempt.id }, lastOptions: [] };
    await handleDriverMessage(deps as any, msg("919111111155", { kind: "text", text: "hmm thinking" }) as any, session as any);
    expect(sent.filter((s) => s.kind === "text").length).toBe(1); // re-ask, no quote
  });
});
