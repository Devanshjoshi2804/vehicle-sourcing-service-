import { z } from "zod";

export const LoadInputSchema = z.object({
  fromLocation: z.string().min(1),
  toLocation: z.string().min(1),
  vehicleType: z.string().min(1),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fixedPriceInr: z.number().int().positive(),
  createdBy: z.string().min(1),
});
export type LoadInput = z.infer<typeof LoadInputSchema>;
export type LoadStatus = "DRAFT" | "CALLING" | "CLOSED";
export type Load = LoadInput & { id: string; status: LoadStatus; createdAt: string };
