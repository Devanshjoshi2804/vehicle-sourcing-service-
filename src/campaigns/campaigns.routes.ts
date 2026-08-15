import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Config } from "../config.js";
import { CampaignsRepo } from "./campaigns.repo.js";
import { ContactsRepo } from "./contacts.repo.js";
import { CampaignEventsRepo } from "./campaign-docs.repo.js";
import { parseContactCsv } from "./csv.js";
import { Leg1Deps, fireLeg1 } from "./leg1.js";
import { Leg2Deps, enrolLeg2, dialLeg2 } from "./leg2.js";
import { listManualQueue } from "./leg3.js";
import { campaignSummary, exportCsv, ExportLeg } from "./summary.js";

const CreateSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).optional(),
  createdBy: z.string().min(1),
});

const AssignSchema = z.object({ ownerAgent: z.string().min(1) });

const DispositionSchema = z.object({
  outcome: z.enum(["CONFIRMED", "CLOSED_LOST"]),
  note: z.string().optional(),
  ownerAgent: z.string().optional(),
});

export type CampaignRouteDeps = {
  pool: import("pg").Pool;
  campaigns: CampaignsRepo;
  contacts: ContactsRepo;
  events: CampaignEventsRepo;
  config: Config;
  // Absent when WhatsApp is disabled (no Interakt key) — the leg-1 route then
  // 503s instead of the whole module failing to register.
  leg1?: Leg1Deps;
  // Absent when Plivo credentials are missing.
  leg2?: Leg2Deps;
};

// CMP-0412 style, matching the code the console and the client's BRD show.
function nextCode(): string {
  return `CMP-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}

export function registerCampaignRoutes(
  app: FastifyInstance,
  deps: CampaignRouteDeps,
  preHandler: any,
) {
  app.post("/campaigns", { preHandler }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const created = await deps.campaigns.create({
      code: parsed.data.code ?? nextCode(),
      name: parsed.data.name,
      createdBy: parsed.data.createdBy,
    });
    return reply.code(201).send(created);
  });

  app.get("/campaigns", { preHandler }, async () => deps.campaigns.list());

  app.get<{ Params: { id: string } }>("/campaigns/:id", { preHandler }, async (req, reply) => {
    const c = await deps.campaigns.get(req.params.id);
    if (!c) return reply.code(404).send({ error: "not found" });
    return c;
  });

  // The CSV arrives as a raw text/csv body — the console reads the file and
  // posts its text, which avoids a multipart dependency for a flat sheet.
  app.post<{ Params: { id: string } }>(
    "/campaigns/:id/contacts",
    { preHandler },
    async (req, reply) => {
      const campaign = await deps.campaigns.get(req.params.id);
      if (!campaign) return reply.code(404).send({ error: "not found" });

      const body = req.body;
      const text = typeof body === "string" ? body : String((body as any)?.csv ?? "");
      if (!text.trim()) return reply.code(400).send({ error: "empty csv" });

      const { rows, headerError } = parseContactCsv(text, deps.config.interaktCountryCode.replace(/\D/g, ""));
      if (headerError) return reply.code(400).send({ error: headerError });

      let loaded = 0;
      let invalid = 0;
      const rejected: { name: string; reason: string }[] = [];
      for (const r of rows) {
        const contact = await deps.contacts.upsert({
          campaignId: campaign.id,
          name: r.name,
          phoneDigits: r.phoneDigits,
          city: r.city,
          refId: r.refId,
          stage: r.invalidReason ? "INVALID" : "UPLOADED",
          invalidReason: r.invalidReason,
        });
        if (r.invalidReason) {
          invalid++;
          rejected.push({ name: r.name, reason: r.invalidReason });
        } else {
          loaded++;
          await deps.events.log(contact.id, "uploaded", { detail: { campaign: campaign.code } });
        }
      }
      return reply.code(201).send({ received: rows.length, loaded, invalid, rejected });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { stage?: string } }>(
    "/campaigns/:id/contacts",
    { preHandler },
    async (req) => {
      const stages = req.query.stage ? (req.query.stage.split(",") as any) : undefined;
      return deps.contacts.listByCampaign(req.params.id, stages);
    },
  );

  // Leg 1: WhatsApp template to everyone still at UPLOADED.
  app.post<{ Params: { id: string } }>(
    "/campaigns/:id/fire-leg1",
    { preHandler },
    async (req, reply) => {
      const campaign = await deps.campaigns.get(req.params.id);
      if (!campaign) return reply.code(404).send({ error: "not found" });
      if (!deps.leg1) return reply.code(503).send({ error: "whatsapp channel not configured" });
      const result = await fireLeg1(deps.leg1, campaign.id);
      await deps.campaigns.setStatus(campaign.id, "RUNNING");
      return result;
    },
  );

  // Leg 2: enrol exactly the leg-1 refusals, then dial them.
  app.post<{ Params: { id: string } }>(
    "/campaigns/:id/dial-leg2",
    { preHandler },
    async (req, reply) => {
      const campaign = await deps.campaigns.get(req.params.id);
      if (!campaign) return reply.code(404).send({ error: "not found" });
      if (!deps.leg2) return reply.code(503).send({ error: "plivo not configured" });
      const { queued } = await enrolLeg2(deps.leg2, campaign.id);
      const dial = await dialLeg2(deps.leg2, campaign.id);
      return { queued, ...dial };
    },
  );

  // Leg 3: the human queue — only the double refusals, each with its history.
  app.get<{ Params: { id: string } }>("/campaigns/:id/queue", { preHandler }, async (req) =>
    listManualQueue(deps.pool, req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    "/campaigns/contacts/:id/assign",
    { preHandler },
    async (req, reply) => {
      const parsed = AssignSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const contact = await deps.contacts.get(req.params.id);
      if (!contact) return reply.code(404).send({ error: "not found" });
      await deps.contacts.assign(contact.id, parsed.data.ownerAgent);
      await deps.events.log(contact.id, "assigned", { leg: 3, detail: { to: parsed.data.ownerAgent } });
      return deps.contacts.get(contact.id);
    },
  );

  // The caller's outcome. CONFIRMED and CLOSED_LOST are terminal — nothing
  // re-enters automation from here.
  app.post<{ Params: { id: string } }>(
    "/campaigns/contacts/:id/disposition",
    { preHandler },
    async (req, reply) => {
      const parsed = DispositionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const contact = await deps.contacts.get(req.params.id);
      if (!contact) return reply.code(404).send({ error: "not found" });

      const updated = await deps.contacts.setDisposition(contact.id, {
        stage: parsed.data.outcome,
        note: parsed.data.note,
        ownerAgent: parsed.data.ownerAgent,
      });
      await deps.events.log(contact.id, "disposition", {
        leg: 3,
        detail: { outcome: parsed.data.outcome, note: parsed.data.note ?? null },
      });
      return updated;
    },
  );

  // The funnel + per-leg reconciliation behind the Journey screen.
  app.get<{ Params: { id: string } }>("/campaigns/:id/summary", { preHandler }, async (req, reply) => {
    const campaign = await deps.campaigns.get(req.params.id);
    if (!campaign) return reply.code(404).send({ error: "not found" });
    return { campaign, ...(await campaignSummary(deps.pool, campaign.id)) };
  });

  app.get<{ Params: { id: string }; Querystring: { leg?: string } }>(
    "/campaigns/:id/export",
    { preHandler },
    async (req, reply) => {
      const campaign = await deps.campaigns.get(req.params.id);
      if (!campaign) return reply.code(404).send({ error: "not found" });
      const leg = (["1", "2", "3", "all"].includes(req.query.leg ?? "") ? req.query.leg : "all") as ExportLeg;
      const csv = await exportCsv(deps.pool, campaign.id, leg);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${campaign.code}-leg${leg}.csv"`)
        .send(csv);
    },
  );

  // One contact's full cross-channel history — the BRD's "Customer Timeline".
  app.get<{ Params: { id: string } }>(
    "/campaigns/contacts/:id/timeline",
    { preHandler },
    async (req, reply) => {
      const contact = await deps.contacts.get(req.params.id);
      if (!contact) return reply.code(404).send({ error: "not found" });
      return { contact, events: await deps.events.listByContact(contact.id) };
    },
  );
}
