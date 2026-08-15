import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";
import { signAttempt } from "../src/campaigns/ivr.client.js";
import { parseCsv } from "../src/campaigns/csv.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  INTERAKT_API_KEY: "ik",
  PLIVO_AUTH_ID: "MA1",
  PLIVO_AUTH_TOKEN: "t",
  PLIVO_CALLER_ID: "+918065951377",
  MAX_CONCURRENT: "4",
  CAMPAIGN_IVR_ATTEMPTS: "2",
} as unknown as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const csvH = { ...auth, "content-type": "text/csv" };

// 6 people, mirroring the prototype's shape: some say 1 on WhatsApp, the rest
// say 2 and get called, and the double-refusals land with a human.
const PEOPLE = [
  { name: "Ravi", phone: "9820411872" },
  { name: "Sneha", phone: "9978640219" },
  { name: "Imran", phone: "9833077641" },
  { name: "Meera", phone: "9745520088" },
  { name: "Devendra", phone: "9415163307" },
  { name: "Fatima", phone: "9004591123" },
];

async function setup() {
  const { pool } = await withTestDb();
  const dialed: { attemptId: string; to: string }[] = [];
  const app = buildServer({
    pool,
    config,
    interakt: fakeInterakt().client,
    ivrDialer: {
      async dial(attemptId: string, to: string) {
        dialed.push({ attemptId, to });
        return { callRef: attemptId };
      },
    },
  });
  const id = (
    await app.inject({ method: "POST", url: "/campaigns", headers: auth, payload: { name: "Docs", createdBy: "ops" } })
  ).json().id;
  await app.inject({
    method: "POST",
    url: `/campaigns/${id}/contacts`,
    headers: csvH,
    payload: ["name,phone", ...PEOPLE.map((p) => `${p.name},${p.phone}`)].join("\n"),
  });
  const summary = async () =>
    (await app.inject({ method: "GET", url: `/campaigns/${id}/summary`, headers: auth })).json();
  return { app, pool, id, dialed, summary };
}

const waReply = (app: any, phone: string, text: string) =>
  app.inject({
    method: "POST",
    url: "/wa/inbound",
    payload: JSON.stringify({
      type: "message_received",
      data: {
        customer: { channel_phone_number: `+91${phone}`, traits: { name: "x" } },
        message: { id: `m${phone}${text}${Math.random()}`, message_content_type: "Text", message: text },
      },
    }),
    headers: { "content-type": "application/json" },
  });

const press = (app: any, attemptId: string, digit: string | null) =>
  app.inject({
    method: "POST",
    url: `/ivr/digit?cid=${attemptId}&sig=${signAttempt("w", attemptId)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `Digits=${digit ?? ""}&Duration=30`,
  });

describe("campaign funnel end to end", () => {
  it("walks upload → WhatsApp → IVR → manual and reconciles every leg", async () => {
    const { app, id, dialed, summary } = await setup();

    // Leg 1: everyone gets the template
    await app.inject({ method: "POST", url: `/campaigns/${id}/fire-leg1`, headers: auth });
    expect((await summary()).leg1.sent).toBe(6);

    // 2 press 1 (interested), 4 press 2 (refusals)
    await waReply(app, "9820411872", "1");
    await waReply(app, "9004591123", "1");
    for (const p of ["9978640219", "9833077641", "9745520088", "9415163307"]) await waReply(app, p, "2");
    await new Promise((r) => setTimeout(r, 400));

    let s = await summary();
    expect(s.leg1).toMatchObject({ sent: 6, interested: 2, declined: 4, noReply: 0 });
    expect(s.reconciliation[0]).toMatchObject({ leg: "L1", entered: 6, key1: 2, key2: 4, noAnswer: 0, balances: true });

    // Leg 2: exactly the 4 refusals are dialed
    const dial = await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    expect(dial.json()).toMatchObject({ queued: 4, dialed: 4, failed: 0 });
    expect(dialed).toHaveLength(4);

    // 1 says yes, 2 say no, 1 presses nothing (and then exhausts its retry)
    await press(app, dialed[0].attemptId, "1");
    await press(app, dialed[1].attemptId, "2");
    await press(app, dialed[2].attemptId, "2");
    await press(app, dialed[3].attemptId, null);
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    await press(app, dialed[4].attemptId, null);

    s = await summary();
    expect(s.reconciliation[1]).toMatchObject({ leg: "L2", entered: 4, key1: 1, key2: 2, balances: true });
    expect(s.leg3.queued).toBe(3); // 2 refusals + 1 unreachable

    // Leg 3: a human works the queue
    const queue = (await app.inject({ method: "GET", url: `/campaigns/${id}/queue`, headers: auth })).json();
    expect(queue).toHaveLength(3);
    expect(queue[0].leg1Result).toBe("2 · declined");
    expect(queue[0].history.length).toBeGreaterThan(0); // caller opens with context

    await app.inject({
      method: "POST",
      url: `/campaigns/contacts/${queue[0].id}/disposition`,
      headers: auth,
      payload: { outcome: "CONFIRMED", note: "Took the document on the call", ownerAgent: "Asha" },
    });
    await app.inject({
      method: "POST",
      url: `/campaigns/contacts/${queue[1].id}/disposition`,
      headers: auth,
      payload: { outcome: "CLOSED_LOST", note: "Already applied elsewhere" },
    });

    s = await summary();
    expect(s.leg3).toMatchObject({ confirmed: 1, closedLost: 1, queued: 1 });
    expect(s.reconciliation[2]).toMatchObject({ leg: "L3", entered: 3, key1: 1, key2: 1, noAnswer: 1, balances: true });

    // The headline metric: 3 human calls instead of 6
    expect(s.closedByAutomation).toBe(3); // 2 on WhatsApp + 1 on IVR
    expect(s.manualCalls).toBe(3);
    expect(s.manualReductionPct).toBe(50);
    expect(s.reconciliation.every((r: any) => r.balances)).toBe(true);
  });

  it("exports a CSV per leg and a combined every-person view", async () => {
    const { app, id, dialed } = await setup();
    await app.inject({ method: "POST", url: `/campaigns/${id}/fire-leg1`, headers: auth });
    await waReply(app, "9978640219", "2");
    await new Promise((r) => setTimeout(r, 500));
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    await press(app, dialed[0].attemptId, "2");

    const all = await app.inject({ method: "GET", url: `/campaigns/${id}/export?leg=all`, headers: auth });
    expect(all.headers["content-type"]).toContain("text/csv");
    expect(all.headers["content-disposition"]).toContain("attachment;");
    const table = parseCsv(all.body);
    expect(table[0]).toEqual([
      "name", "phone", "city", "ref", "stage", "leg1", "leg2_key",
      "attempts", "documents", "owner", "note", "invalid_reason",
    ]);
    expect(table).toHaveLength(7); // header + 6 people

    const leg2 = parseCsv((await app.inject({ method: "GET", url: `/campaigns/${id}/export?leg=2`, headers: auth })).body);
    expect(leg2[0]).toContain("key");
    expect(leg2).toHaveLength(2); // header + the one dialed contact
    expect(leg2[1]).toContain("2"); // the pressed key

    const leg3 = parseCsv((await app.inject({ method: "GET", url: `/campaigns/${id}/export?leg=3`, headers: auth })).body);
    expect(leg3).toHaveLength(2);
  });

  it("invalid upload rows never enter any leg", async () => {
    const { pool } = await withTestDb();
    const app = buildServer({ pool, config, interakt: fakeInterakt().client });
    const id = (
      await app.inject({ method: "POST", url: "/campaigns", headers: auth, payload: { name: "D", createdBy: "o" } })
    ).json().id;
    await app.inject({
      method: "POST",
      url: `/campaigns/${id}/contacts`,
      headers: csvH,
      payload: "name,phone\nGood,9978640219\nBad,123\n,9820411872",
    });
    const fired = await app.inject({ method: "POST", url: `/campaigns/${id}/fire-leg1`, headers: auth });
    expect(fired.json()).toEqual({ sent: 1, failed: 0 });

    const s = (await app.inject({ method: "GET", url: `/campaigns/${id}/summary`, headers: auth })).json();
    expect(s.totals).toMatchObject({ uploaded: 3, invalid: 2, contacts: 1 });
    expect(s.leg1.sent).toBe(1);
  });
});
