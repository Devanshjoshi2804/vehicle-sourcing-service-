import { describe, it, expect } from "vitest";
import { signAction, verifyAction } from "../src/email/tokens.js";

describe("action tokens", () => {
  it("round-trips sign → verify", () => {
    const token = signAction("s3cret", { a: "acc", id: "attempt-1", p: 15000 });
    const t = verifyAction("s3cret", token);
    expect(t).toMatchObject({ a: "acc", id: "attempt-1", p: 15000 });
    expect(typeof t!.x).toBe("number");
  });

  it("rejects an expired token", () => {
    const token = signAction("s3cret", { a: "dec", id: "attempt-1", x: Math.floor(Date.now() / 1000) - 10 });
    expect(verifyAction("s3cret", token)).toBeNull();
  });

  it("rejects a tampered mac", () => {
    const token = signAction("s3cret", { a: "acc", id: "attempt-1" });
    const [body] = token.split(".");
    expect(verifyAction("s3cret", `${body}.deadbeef`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAction("s3cret", { a: "acc", id: "attempt-1" });
    expect(verifyAction("other-secret", token)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyAction("s3cret", "not-a-token")).toBeNull();
    expect(verifyAction("s3cret", "")).toBeNull();
  });
});
