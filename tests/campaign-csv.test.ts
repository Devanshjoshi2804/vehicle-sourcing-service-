import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../src/server.js";
import { withTestDb } from "./helpers/db.js";
import { loadConfig } from "../src/config.js";
import { parseCsv, parseContactCsv, normalisePhone, toCsv } from "../src/campaigns/csv.js";

const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL_TEST!,
  API_KEY: "k",
  WEBHOOK_SECRET: "w",
  PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_SOURCING: "a",
  ELEVENLABS_SIP_PHONE_ID: "p",
} as NodeJS.ProcessEnv);
const auth = { authorization: "Bearer k" };
const csvHeaders = { ...auth, "content-type": "text/csv" };

describe("csv parsing", () => {
  it("handles quotes, embedded commas and CRLF", () => {
    const table = parseCsv('name,city\r\n"Patel, Sneha",Surat\r\n"He said ""hi""",Pune\r\n');
    expect(table).toEqual([
      ["name", "city"],
      ["Patel, Sneha", "Surat"],
      ['He said "hi"', "Pune"],
    ]);
  });

  it("round-trips through toCsv", () => {
    const out = toCsv(["a", "b"], [["x,y", 'q"q']]);
    expect(parseCsv(out)).toEqual([
      ["a", "b"],
      ["x,y", 'q"q'],
    ]);
  });

  it("normalises Indian mobiles and rejects the rest", () => {
    expect(normalisePhone("+91 99786 40219")).toEqual({ digits: "919978640219" });
    expect(normalisePhone("09978640219")).toEqual({ digits: "919978640219" });
    expect(normalisePhone("12345").reason).toBe("phone too short");
    expect(normalisePhone("1234567890").reason).toBe("not a mobile number");
    expect(normalisePhone("").reason).toBe("missing phone");
  });

  it("accepts aliased headers and flags bad rows without dropping them", () => {
    const { rows } = parseContactCsv(
      [
        "Customer Name,Mobile Number,City,Customer ID",
        "Sneha Patel,+91 99786 40219,Surat,C-1",
        ",9820411872,Pune,C-2",
        "Bad Number,123,Delhi,C-3",
        "Sneha Again,99786 40219,Surat,C-4",
      ].join("\n"),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ name: "Sneha Patel", phoneDigits: "919978640219", invalidReason: null });
    expect(rows[1].invalidReason).toBe("missing name");
    expect(rows[2].invalidReason).toBe("phone too short");
    expect(rows[3].invalidReason).toBe("duplicate in file");
  });

  it("rejects a sheet with no phone column", () => {
    expect(parseContactCsv("name,city\nA,Pune").headerError).toMatch(/phone/);
  });
});

describe("campaign upload routes", () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    const { pool } = await withTestDb();
    app = buildServer({ pool, config });
  });

  it("creates a campaign, loads a sheet and reports the rejects", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: auth,
      payload: { name: "Doc verification", createdBy: "ops" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().code).toMatch(/^CMP-\d{4}$/);

    const upload = await app.inject({
      method: "POST",
      url: `/campaigns/${id}/contacts`,
      headers: csvHeaders,
      payload: [
        "name,phone,city",
        "Sneha Patel,9978640219,Surat",
        "Ravi Kulkarni,9820411872,Pune",
        "Broken,abc,Delhi",
      ].join("\n"),
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ received: 3, loaded: 2, invalid: 1 });
    expect(upload.json().rejected[0]).toMatchObject({ name: "Broken", reason: "missing phone" });

    const contacts = await app.inject({ method: "GET", url: `/campaigns/${id}/contacts`, headers: auth });
    const stages = contacts.json().map((c: any) => c.stage).sort();
    expect(stages).toEqual(["INVALID", "UPLOADED", "UPLOADED"]);
  });

  it("re-uploading the same number updates instead of duplicating", async () => {
    const { pool } = await withTestDb();
    const fresh = buildServer({ pool, config });
    const id = (
      await fresh.inject({
        method: "POST",
        url: "/campaigns",
        headers: auth,
        payload: { name: "Re-upload", createdBy: "ops" },
      })
    ).json().id;

    const body = (name: string) => ["name,phone", `${name},9978640219`].join("\n");
    await fresh.inject({ method: "POST", url: `/campaigns/${id}/contacts`, headers: csvHeaders, payload: body("Sneha") });
    await fresh.inject({ method: "POST", url: `/campaigns/${id}/contacts`, headers: csvHeaders, payload: body("Sneha Patel") });

    const contacts = (
      await fresh.inject({ method: "GET", url: `/campaigns/${id}/contacts`, headers: auth })
    ).json();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe("Sneha Patel");
  });

  it("rejects an empty sheet and an unknown campaign", async () => {
    const empty = await app.inject({
      method: "POST",
      url: `/campaigns/${crypto.randomUUID()}/contacts`,
      headers: csvHeaders,
      payload: "name,phone\nA,9978640219",
    });
    expect(empty.statusCode).toBe(404);
  });

  it("requires the api key", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns" });
    expect(res.statusCode).toBe(401);
  });
});
