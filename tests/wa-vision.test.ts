import { describe, it, expect, vi } from "vitest";
import { buildVisionClient } from "../src/wa/vision.js";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://x", API_KEY: "k", WEBHOOK_SECRET: "w", PUBLIC_BASE_URL: "https://h",
  ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_SOURCING: "a", ELEVENLABS_SIP_PHONE_ID: "p",
};

const MEDIA_URL = "https://media.example.com/doc123.jpg";

const FULL_RAW_DOC = {
  doc_type: "lr",
  lr_number: "LR12345",
  billed_total_inr: 15000,
  vehicle_no: "MH12AB1234",
  from: "Mumbai",
  to: "Pune",
  doc_date: "2026-07-01",
  paid_stamp_seen: true,
  confidence: 0.92,
};

const EXPECTED_DOC = {
  docType: "lr",
  lrNumber: "LR12345",
  billedTotalInr: 15000,
  vehicleNo: "MH12AB1234",
  from: "Mumbai",
  to: "Pune",
  docDate: "2026-07-01",
  paidStampSeen: true,
  confidence: 0.92,
};

function makeFetch(opts: {
  mediaStatus?: number;
  mediaContentType?: string;
  mediaContentLength?: number;
  geminiStatus?: number;
  geminiText?: string;
  mistralStatus?: number;
  mistralText?: string;
} = {}) {
  const {
    mediaStatus = 200,
    mediaContentType = "image/jpeg",
    mediaContentLength,
    geminiStatus = 200,
    geminiText = "{}",
    mistralStatus = 200,
    mistralText = "{}",
  } = opts;
  return vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: geminiText }] } }] }),
        { status: geminiStatus }
      );
    }
    if (u.includes("api.mistral.ai")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: mistralText } }] }),
        { status: mistralStatus }
      );
    }
    const headers: Record<string, string> = { "content-type": mediaContentType };
    if (mediaContentLength !== undefined) headers["content-length"] = String(mediaContentLength);
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: mediaStatus, headers });
  }) as unknown as typeof fetch;
}

describe("vision client", () => {
  it("extracts via Gemini on happy path", async () => {
    const f = makeFetch({ geminiText: JSON.stringify(FULL_RAW_DOC) });
    const client = buildVisionClient(loadConfig({ ...baseEnv, GEMINI_API_KEY: "g" } as any), f);
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: true, doc: EXPECTED_DOC });
  });

  it("falls back to Mistral when Gemini fails", async () => {
    const f = makeFetch({ geminiStatus: 500, mistralText: JSON.stringify(FULL_RAW_DOC) });
    const client = buildVisionClient(
      loadConfig({ ...baseEnv, GEMINI_API_KEY: "g", MISTRAL_API_KEY: "m" } as any),
      f
    );
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: true, doc: EXPECTED_DOC });
  });

  it("returns extract_failed when both providers fail", async () => {
    const f = makeFetch({ geminiStatus: 500, mistralStatus: 500 });
    const client = buildVisionClient(
      loadConfig({ ...baseEnv, GEMINI_API_KEY: "g", MISTRAL_API_KEY: "m" } as any),
      f
    );
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: false, reason: "extract_failed" });
  });

  it("returns too_large without calling any provider when media exceeds docMaxBytes", async () => {
    const f = makeFetch({ mediaContentLength: 999_999 });
    const client = buildVisionClient(
      loadConfig({ ...baseEnv, GEMINI_API_KEY: "g", MISTRAL_API_KEY: "m", DOC_MAX_BYTES: "1000" } as any),
      f
    );
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(f).toHaveBeenCalledTimes(1); // only the media fetch
  });

  it("rejects a non-https media url as fetch_failed without calling fetch at all (SSRF guard)", async () => {
    const f = makeFetch();
    const client = buildVisionClient(loadConfig({ ...baseEnv, GEMINI_API_KEY: "g" } as any), f);
    const result = await client.extract("http://media.example.com/doc123.jpg");
    expect(result).toEqual({ ok: false, reason: "fetch_failed" });
    expect(f).not.toHaveBeenCalled();
  });

  it("returns no_provider and makes no fetches without any API key", async () => {
    const f = makeFetch();
    const client = buildVisionClient(loadConfig({ ...baseEnv } as any), f);
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: false, reason: "no_provider" });
    expect(f).not.toHaveBeenCalled();
  });

  it("rounds a fractional billed_total_inr from the OCR provider (avoids a 22P02 on an integer column)", async () => {
    const f = makeFetch({ geminiText: JSON.stringify({ ...FULL_RAW_DOC, billed_total_inr: 16500.5 }) });
    const client = buildVisionClient(loadConfig({ ...baseEnv, GEMINI_API_KEY: "g" } as any), f);
    const result = await client.extract(MEDIA_URL);
    expect(result.ok).toBe(true);
    expect((result as any).doc.billedTotalInr).toBe(16501);
  });

  it("returns extract_failed for a PDF with only a Mistral key (pixtral is images-only)", async () => {
    const f = makeFetch({ mediaContentType: "application/pdf" });
    const client = buildVisionClient(loadConfig({ ...baseEnv, MISTRAL_API_KEY: "m" } as any), f);
    const result = await client.extract(MEDIA_URL);
    expect(result).toEqual({ ok: false, reason: "extract_failed" });
  });

  it("extractFromBuffer: extracts via Gemini given raw bytes + mime, no media fetch", async () => {
    const f = makeFetch({ geminiText: JSON.stringify(FULL_RAW_DOC) });
    const client = buildVisionClient(loadConfig({ ...baseEnv, GEMINI_API_KEY: "g" } as any), f);
    const result = await client.extractFromBuffer(Buffer.from([1, 2, 3, 4]), "image/jpeg");
    expect(result).toEqual({ ok: true, doc: EXPECTED_DOC });
    expect(f).toHaveBeenCalledTimes(1); // only the Gemini call — no media fetch for a buffer entry
  });

  it("extractFromBuffer: returns too_large for an oversized buffer without calling any provider", async () => {
    const f = makeFetch();
    const client = buildVisionClient(
      loadConfig({ ...baseEnv, GEMINI_API_KEY: "g", DOC_MAX_BYTES: "3" } as any),
      f
    );
    const result = await client.extractFromBuffer(Buffer.from([1, 2, 3, 4]), "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(f).not.toHaveBeenCalled();
  });
});
