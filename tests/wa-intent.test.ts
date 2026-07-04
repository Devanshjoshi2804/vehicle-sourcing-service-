import { describe, it, expect } from "vitest";
import { parseIntent, parsePriceText } from "../src/wa/intent.js";

describe("parsePriceText", () => {
  it.each([
    ["14000", 14000], ["₹14,000", 14000], ["14k", 14000], ["14.5k", 14500],
    ["13 hazar", 13000], ["13 hajar chahiye", 13000], ["1.5 lakh", 150000],
    ["rate 15000 hai", 15000], ["16ft", null], ["50", null], ["kal", null],
  ])("%s → %s", (text, want) => {
    expect(parsePriceText(text as string)).toBe(want);
  });
});

describe("parseIntent", () => {
  it.each([
    ["haan", "yes"], ["Haan bhai chalega", "yes"], ["ok done", "yes"], ["theek hai", "yes"],
    ["yes", "yes"], ["pakka", "yes"], ["book karo", "yes"],
    ["nahi", "no"], ["nahi chalega", "no"], ["busy hu", "no"], ["cancel", "no"], ["abhi mat karo", "no"],
    ["15000", "price"], ["haan 15000 me chalega", "price"], ["15 hazar do", "price"],
    ["kahan jana hai", "unknown"], ["", "unknown"],
  ])("%s → %s", (text, kind) => {
    expect(parseIntent(text as string).kind).toBe(kind);
  });
});
