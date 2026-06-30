import { Owner } from "../owners/owners.schema.js";

const norm = (s: string) => s.trim().toLowerCase();
// Vehicle types arrive slightly differently ("16ft", "16 ft", "16feet", "16-ft");
// collapse them so a demand still matches a driver despite cosmetic differences.
const normVehicle = (s: string) =>
  s.trim().toLowerCase().replace(/feet/g, "ft").replace(/[\s_-]+/g, "");

export function matchOwners(
  load: { fromLocation: string; toLocation: string; vehicleType: string },
  owners: Owner[],
): { owner: Owner; score: number }[] {
  const from = norm(load.fromLocation);
  const to = norm(load.toLocation);
  const vt = normVehicle(load.vehicleType);

  const scored = owners
    .filter((o) => o.active)
    .map((o) => {
      const vehicleMatch = o.vehicleTypes.some((v) => normVehicle(v) === vt);
      if (!vehicleMatch) return { owner: o, score: 0 };
      let score = 1;
      const exact = o.lanes.some((l) => norm(l.from) === from && norm(l.to) === to);
      const partial = o.lanes.some((l) => norm(l.from) === from || norm(l.to) === to);
      if (exact) score += 2;
      else if (partial) score += 1;
      return { owner: o, score };
    })
    .filter((r) => r.score > 0);

  return scored.sort((a, b) => b.score - a.score);
}
