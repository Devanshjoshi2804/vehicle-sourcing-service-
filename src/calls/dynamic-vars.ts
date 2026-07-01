import { Load } from "../loads/loads.schema.js";
import { Owner } from "../owners/owners.schema.js";
import { CallFlow } from "./calls.repo.js";

export function buildDynamicVars(
  load: Load,
  owner: Owner,
  flow: CallFlow,
  companyName: string,
  offerPriceInr?: number, // re-negotiate: offer a price other than the load's fixed one
): Record<string, string> {
  return {
    flow,
    owner_name: owner.name,
    from: load.fromLocation,
    to: load.toLocation,
    vehicle_type: load.vehicleType,
    pickup_date: load.pickupDate,
    fixed_price: String(offerPriceInr ?? load.fixedPriceInr),
    company: companyName,
  };
}
