import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { verifyAction } from "../src/email/tokens.js";
import { Mailer } from "../src/email/mailer.js";
import { CallsRepo } from "../src/calls/calls.repo.js";
import { OwnersRepo } from "../src/owners/owners.repo.js";
import { LoadsRepo } from "../src/loads/loads.repo.js";
import { LrsRepo } from "../src/lr/lrs.repo.js";
import { mintLr } from "../src/lr/mint.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!, API_KEY: "k", WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p", MAX_CONCURRENT: "2", MAX_ATTEMPTS: "1",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };

// Captured fake mailer — never hits real SMTP. fail=true drives the
// voice-fallback path the same way fakeInterakt(true) does for WA.
function fakeMailer(fail = false) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = {
    async send(to, subject, text) {
      if (fail) return false;
      sent.push({ to, subject, text });
      return true;
    },
  };
  return { mailer, sent };
}

describe("email channel in the orchestrator", () => {
  it("email-channel owner gets an offer email with a valid accept token", async () => {
    const { pool } = await withTestDb();
    const { mailer, sent } = fakeMailer();
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, mailer });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "E", phone: "+919111111199", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "email", email: "driver@example.com" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(0); // no voice call — email sent instead
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("driver@example.com");
    expect(sent[0].subject).toContain("New load [ATT-");
    expect(sent[0].subject).toContain("Mumbai → Pune");

    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0]).toMatchObject({ channel: "email", status: "IN_PROGRESS" });
    expect(calls[0].elConversationId).toBe(`em_${calls[0].id}`);

    const accMatch = sent[0].text.match(/Accept: \S+\?t=(\S+)/);
    expect(accMatch).toBeTruthy();
    const token = verifyAction(config.webhookSecret, accMatch![1]);
    expect(token).toMatchObject({ a: "acc", id: calls[0].id, p: 13000 });
  });

  it("falls back to a voice call when the mailer send fails", async () => {
    const { pool } = await withTestDb();
    const { mailer } = fakeMailer(true);
    const placed: any[] = [];
    const el = { originateCall: async (a: any) => (placed.push(a), { conversationId: `c${placed.length}` }) };
    const app = buildServer({ pool, config, el, mailer });

    const owner = (await app.inject({ method: "POST", url: "/owners", headers: auth,
      payload: { name: "E2", phone: "+919111111188", vehicleTypes: ["16ft"], lanes: [{ from: "Mumbai", to: "Pune" }], channel: "email", email: "driver2@example.com" } })).json();
    const load = (await app.inject({ method: "POST", url: "/loads", headers: auth,
      payload: { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 13000, createdBy: "t" } })).json();
    await app.inject({ method: "POST", url: `/loads/${load.id}/call`, headers: auth, payload: { ownerIds: [owner.id] } });

    expect(placed).toHaveLength(1); // voice fallback dialed
    const calls = (await app.inject({ method: "GET", url: `/loads/${load.id}/calls`, headers: auth })).json();
    expect(calls[0].channel).toBe("voice");
  });
});

describe("LR mint notify — channel preference", () => {
  it("prefers WA when owner channel is whatsapp, mailer when channel is email with an address set", async () => {
    const { pool } = await withTestDb();
    const ownersRepo = new OwnersRepo(pool);
    const loadsRepo = new LoadsRepo(pool);
    const lrsRepo = new LrsRepo(pool);

    const waOwner = await ownersRepo.createOwner({ name: "WA", phone: "+919000000001", vehicleTypes: ["16ft"], lanes: [], channel: "whatsapp" } as any);
    const emailOwner = await ownersRepo.createOwner({ name: "EM", phone: "+919000000002", vehicleTypes: ["16ft"], lanes: [], channel: "email", email: "owner@example.com" } as any);

    const waLoad = await loadsRepo.createLoad({ fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 100, createdBy: "t" });
    const emailLoad = await loadsRepo.createLoad({ fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 100, createdBy: "t" });

    const demandRepo = {
      findByLoadId: async (loadId: string) =>
        loadId === waLoad.id
          ? { winningOwnerId: waOwner.id, lockedPriceInr: null }
          : { winningOwnerId: emailOwner.id, lockedPriceInr: null },
    } as any;

    const waSent: { phone: string; text: string }[] = [];
    const waSender: any = { sendText: async (phone: string, text: string) => { waSent.push({ phone, text }); } };
    const { mailer, sent: mailSent } = fakeMailer();

    await mintLr({ lrsRepo, loadsRepo, demandRepo, ownersRepo, waSender, mailer }, waLoad.id);
    expect(waSent).toHaveLength(1);
    expect(mailSent).toHaveLength(0);

    await mintLr({ lrsRepo, loadsRepo, demandRepo, ownersRepo, waSender, mailer }, emailLoad.id);
    expect(mailSent).toHaveLength(1);
    expect(mailSent[0].to).toBe("owner@example.com");
    expect(waSent).toHaveLength(1); // unchanged — the email owner never got a WA text
  });
});

describe("watchdog TTL", () => {
  it("expires stale email attempts at the email TTL, not the wa TTL", async () => {
    const { pool } = await withTestDb();
    const repo = new CallsRepo(pool);
    const owners = new OwnersRepo(pool);
    const loads = new LoadsRepo(pool);
    const o = await owners.createOwner({ name: "E", phone: "+919111111177", vehicleTypes: ["16ft"], lanes: [] } as any);
    const l = await loads.createLoad({ fromLocation: "A", toLocation: "B", vehicleType: "16ft", pickupDate: "2026-07-05", fixedPriceInr: 1, createdBy: "t" });
    const a = await repo.create({ loadId: l.id, ownerId: o.id, phone: o.phone, flow: "offer", channel: "email" });
    expect(a.channel).toBe("email");
    await repo.setStatus(a.id, "IN_PROGRESS");
    await pool.query(`UPDATE call_attempts SET created_at = now() - interval '150 minutes' WHERE id=$1`, [a.id]);

    expect(await repo.expireStale(30 * 60_000, "wa")).toEqual([]); // wrong channel: untouched
    expect(await repo.expireStale(200 * 60_000, "email")).toEqual([]); // email TTL not reached yet
    expect(await repo.expireStale(120 * 60_000, "email")).toEqual([a.id]); // default EMAIL_REPLY_TTL_MIN: expired
  });
});
