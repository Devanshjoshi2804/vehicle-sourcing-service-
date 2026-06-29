import { describe, it, expect } from "vitest";
import { buildDynamicVars } from "../src/calls/dynamic-vars.js";

const load: any = {
  fromLocation: "Mumbai",
  toLocation: "Pune",
  vehicleType: "16ft",
  pickupDate: "2026-07-01",
  fixedPriceInr: 13000,
};
const owner: any = { name: "Ramesh" };

describe("buildDynamicVars", () => {
  it("maps load+owner into agent variables (all strings)", () => {
    const v = buildDynamicVars(load, owner, "offer", "Pinified");
    expect(v).toEqual({
      flow: "offer",
      owner_name: "Ramesh",
      from: "Mumbai",
      to: "Pune",
      vehicle_type: "16ft",
      pickup_date: "2026-07-01",
      fixed_price: "13000",
      company: "Pinified",
    });
  });
});
