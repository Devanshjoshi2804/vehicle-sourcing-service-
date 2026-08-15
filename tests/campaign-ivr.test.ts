import { describe, it, expect } from "vitest";
import { withTestDb } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeInterakt } from "./helpers/wa.js";
import { signAttempt, buildIvrDialer } from "../src/campaigns/ivr.client.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
  INTERAKT_API_KEY: "ik",
  PLIVO_AUTH_ID: "MA123",
  PLIVO_AUTH_TOKEN: "tok",
  PLIVO_CALLER_ID: "+918065951377",
  MAX_CONCURRENT: "2",
  CAMPAIGN_IVR_ATTEMPTS: "2",
} as unknown as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const csv = { ...auth, "content-type": "text/csv" };

// Records what would have been dialed instead of calling Plivo.
function fakeDialer() {
  const dialed: { attemptId: string; to: string }[] = [];
  return {
    dialed,
    dialer: {
      async dial(attemptId: string, to: string) {
        dialed.push({ attemptId, to });
        return { callRef: `ref_${attemptId}` };
      },
    },
  };
}

async function setup(opts: { decline?: string[] } = {}) {
  const { pool } = await withTestDb();
  const { dialed, dialer } = fakeDialer();
  const app = buildServer({ pool, config, interakt: fakeInterakt().client, ivrDialer: dialer });
  const id = (
    await app.inject({ method: "POST", url: "/campaigns", headers: auth, payload: { name: "Docs", createdBy: "ops" } })
  ).json().id;
  await app.inject({
    method: "POST",
    url: `/campaigns/${id}/contacts`,
    headers: csv,
    payload: ["name,phone", "Sneha,9978640219", "Imran,9833077641", "Ravi,9820411872"].join("\n"),
  });
  await app.inject({ method: "POST", url: `/campaigns/${id}/fire-leg1`, headers: auth });

  // Mark the requested contacts as leg-1 refusals (what "pressed 2" produces).
  const contacts = (await app.inject({ method: "GET", url: `/campaigns/${id}/contacts`, headers: auth })).json();
  for (const name of opts.decline ?? []) {
    const c = contacts.find((x: any) => x.name === name);
    await pool.query(`UPDATE campaign_contacts SET stage='L1_DECLINED' WHERE id=$1`, [c.id]);
  }
  const stages = async () =>
    Object.fromEntries(
      (await app.inject({ method: "GET", url: `/campaigns/${id}/contacts`, headers: auth }))
        .json()
        .map((c: any) => [c.name, c.stage]),
    );
  return { app, pool, id, dialed, stages, contacts };
}

const digitPost = (app: any, attemptId: string, digits: string | null) =>
  app.inject({
    method: "POST",
    url: `/ivr/digit?cid=${attemptId}&sig=${signAttempt("w", attemptId)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `Digits=${digits ?? ""}&Duration=42`,
  });

describe("campaign leg 2 (DTMF IVR)", () => {
  it("dials exactly the leg-1 refusals and nobody else", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha", "Imran"] });

    const res = await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    expect(res.json()).toMatchObject({ queued: 2, dialed: 2, failed: 0 });
    expect(dialed.map((d) => d.to).sort()).toEqual(["919833077641", "919978640219"]);

    const s = await stages();
    expect(s.Ravi).toBe("L1_SENT"); // never answered → never dialed
  });

  it("serves signed answer XML and refuses a forged signature", async () => {
    const { app, id, dialed } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    const attemptId = dialed[0].attemptId;

    const ok = await app.inject({ method: "GET", url: `/ivr/answer?cid=${attemptId}&sig=${signAttempt("w", attemptId)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("xml");
    expect(ok.body).toContain("<GetDigits");
    expect(ok.body).toContain("numDigits=\"1\"");
    expect(ok.body).toContain("&amp;sig="); // the action URL must be XML-escaped

    const forged = await app.inject({ method: "GET", url: `/ivr/answer?cid=${attemptId}&sig=deadbeef` });
    expect(forged.statusCode).toBe(403);
  });

  it("key 1 keeps the number in automation", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });

    const res = await digitPost(app, dialed[0].attemptId, "1");
    expect(res.statusCode).toBe(200);
    expect((await stages()).Sneha).toBe("L2_INTERESTED");
  });

  it("key 2 escalates to the manual queue — refused on both legs", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });

    await digitPost(app, dialed[0].attemptId, "2");
    expect((await stages()).Sneha).toBe("L3_QUEUED");
  });

  it("no key schedules one retry, then escalates", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });

    await digitPost(app, dialed[0].attemptId, null);
    expect((await stages()).Sneha).toBe("L2_QUEUED"); // still automation's problem

    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    expect(dialed).toHaveLength(2); // the retry dial
    await digitPost(app, dialed[1].attemptId, null);
    expect((await stages()).Sneha).toBe("L3_QUEUED"); // budget spent → a human takes it
  });

  it("ignores a replayed digit webhook", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });

    await digitPost(app, dialed[0].attemptId, "1");
    await digitPost(app, dialed[0].attemptId, "2"); // duplicate delivery, different key
    expect((await stages()).Sneha).toBe("L2_INTERESTED");
  });

  it("closes an unanswered call from the hangup callback", async () => {
    const { app, id, dialed, stages } = await setup({ decline: ["Sneha"] });
    await app.inject({ method: "POST", url: `/campaigns/${id}/dial-leg2`, headers: auth });
    const attemptId = dialed[0].attemptId;

    await app.inject({
      method: "POST",
      url: `/ivr/hangup?cid=${attemptId}&sig=${signAttempt("w", attemptId)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "CallStatus=busy&Duration=0",
    });
    expect((await stages()).Sneha).toBe("L2_QUEUED"); // one retry still owed
  });

  it("builds a Plivo request with signed answer and hangup urls", async () => {
    const posted: any[] = [];
    const dialer = buildIvrDialer(config, async (url, body) => {
      posted.push({ url, body });
      return { request_uuid: "plivo-123" };
    });
    const { callRef } = await dialer.dial("attempt-1", "919978640219");

    expect(callRef).toBe("plivo-123");
    expect(posted[0].url).toBe("https://api.plivo.com/v1/Account/MA123/Call/");
    expect(posted[0].body).toMatchObject({ from: "+918065951377", to: "919978640219", answer_method: "GET" });
    expect(posted[0].body.answer_url).toContain(`/ivr/answer?cid=attempt-1&sig=${signAttempt("w", "attempt-1")}`);
    expect(posted[0].body.hangup_url).toContain("/ivr/hangup?cid=attempt-1");
  });
});
