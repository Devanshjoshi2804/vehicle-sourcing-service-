import { z } from "zod";

export const LaneSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
export const OwnerInputSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(/^\+\d{10,15}$/, "phone must be E.164 e.g. +9199…"),
  vehicleTypes: z.array(z.string().min(1)).default([]),
  lanes: z.array(LaneSchema).default([]),
  channel: z.enum(["voice", "whatsapp", "both"]).default("voice"),
});
export type OwnerInput = z.infer<typeof OwnerInputSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type OwnerChannel = "voice" | "whatsapp" | "both";
export type Owner = {
  id: string;
  name: string;
  phone: string;
  vehicleTypes: string[];
  lanes: Lane[];
  active: boolean;
  createdAt: string;
  channel: OwnerChannel;
};
