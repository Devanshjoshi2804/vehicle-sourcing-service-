import { describe, it, expect } from "vitest";
import { matchOwners } from "../src/matcher/matcher.js";
import { Owner } from "../src/owners/owners.schema.js";

const base: Omit<Owner, "id" | "name" | "phone"> = {
  vehicleTypes: ["16ft"],
  lanes: [{ from: "Mumbai", to: "Pune" }],
  active: true,
  createdAt: "x",
};
const owner = (id: string, o: Partial<Owner>): Owner =>
  ({ id, name: id, phone: "+910000000000", ...base, ...o });

const load = { fromLocation: "Mumbai", toLocation: "Pune", vehicleType: "16ft" };

describe("matchOwners", () => {
  it("excludes owners with no vehicle-type match", () => {
    const res = matchOwners(load, [owner("a", { vehicleTypes: ["32ft"] })]);
    expect(res).toHaveLength(0);
  });

  it("scores exact lane + vehicle highest", () => {
    const res = matchOwners(load, [
      owner("exact", {}),
      owner("partial", { lanes: [{ from: "Mumbai", to: "Delhi" }] }),
      owner("vehicleOnly", { lanes: [{ from: "Surat", to: "Indore" }] }),
    ]);
    expect(res.map((r) => r.owner.id)).toEqual(["exact", "partial", "vehicleOnly"]);
    expect(res[0].score).toBe(3);
    expect(res[1].score).toBe(2);
    expect(res[2].score).toBe(1);
  });

  it("is case/whitespace insensitive on locations", () => {
    const res = matchOwners(load, [owner("a", { lanes: [{ from: " mumbai ", to: "PUNE" }] })]);
    expect(res[0].score).toBe(3);
  });

  it("ignores inactive owners", () => {
    const res = matchOwners(load, [owner("a", { active: false })]);
    expect(res).toHaveLength(0);
  });
});
