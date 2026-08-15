import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { signAction, verifyAction } from "../email/tokens.js";
import { Contact } from "./campaigns.repo.js";
import { ContactsRepo } from "./contacts.repo.js";
import { CampaignDocsRepo, CampaignEventsRepo } from "./campaign-docs.repo.js";
import { VisionClient } from "../wa/vision.js";

export type UploadDeps = {
  contacts: ContactsRepo;
  docs: CampaignDocsRepo;
  events: CampaignEventsRepo;
  config: Config;
  vision?: VisionClient;
};

// The link we WhatsApp to a contact who prefers a browser. The token is the auth
// (same HMAC scheme as the email magic links) — no login for a one-off upload.
export function uploadUrlFor(config: Config, contact: Contact): string {
  const token = signAction(config.webhookSecret, {
    a: "cup",
    id: contact.id,
    x: Math.floor(Date.now() / 1000) + config.campaignL1WindowMin * 60,
  });
  return `${config.publicBaseUrl}/c/u/${token}`;
}

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
};

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload your document</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f6f8f7;color:#132}
.card{max-width:26rem;margin:6vh auto;background:#fff;border:1px solid #dbe5e0;border-radius:14px;padding:24px}
h1{font-size:19px;margin:0 0 6px}p{color:#5a6b64;margin:0 0 18px}
input[type=file]{display:block;width:100%;margin-bottom:16px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#1c6b53;color:#fff;font-size:16px}
button[disabled]{opacity:.5}.ok{color:#1c6b53;font-weight:600}.err{color:#a3341f}</style>
<div class="card">${body}</div>`;

export function registerCampaignUploadRoutes(app: FastifyInstance, deps: UploadDeps, preHandler: any) {
  // Photos/PDFs arrive as a raw binary body from our own upload page — a
  // content-type parser keeps the bytes intact (the catch-all would stringify
  // them). Cheaper than pulling in a multipart dependency for one form.
  const asBuffer = (_req: any, body: Buffer, done: any) => done(null, body);
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, asBuffer);
  app.addContentTypeParser("application/pdf", { parseAs: "buffer" }, asBuffer);

  app.get<{ Params: { token: string } }>("/c/u/:token", async (req, reply) => {
    const t = verifyAction(deps.config.webhookSecret, req.params.token);
    if (!t || t.a !== "cup") {
      return reply.code(410).type("text/html").send(page(`<h1>This link has expired</h1>
        <p class="err">Please reply to our WhatsApp message and we'll send a fresh one.</p>`));
    }
    const contact = await deps.contacts.get(t.id);
    if (!contact) return reply.code(404).type("text/html").send(page("<h1>Not found</h1>"));

    return reply.type("text/html").send(page(`<h1>Hello ${escapeHtml(contact.name)}</h1>
      <p>Upload a photo of your document (Aadhaar or identity proof).</p>
      <input id="f" type="file" accept="image/*,application/pdf">
      <button id="b">Upload</button>
      <p id="m"></p>
      <script>
        const f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
        b.onclick=async()=>{
          if(!f.files[0]){m.className='err';m.textContent='Choose a file first.';return;}
          b.disabled=true;m.className='';m.textContent='Uploading…';
          try{
            const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':f.files[0].type||'application/octet-stream'},body:f.files[0]});
            if(!r.ok) throw new Error(await r.text());
            m.className='ok';m.textContent='Thank you — document received.';
          }catch(e){m.className='err';m.textContent='Upload failed. Please try again.';b.disabled=false;}
        };
      </script>`));
  });

  app.post<{ Params: { token: string } }>(
    "/c/u/:token",
    { bodyLimit: deps.config.docMaxBytes },
    async (req, reply) => {
      const t = verifyAction(deps.config.webhookSecret, req.params.token);
      if (!t || t.a !== "cup") return reply.code(410).send({ error: "link expired" });
      const contact = await deps.contacts.get(t.id);
      if (!contact) return reply.code(404).send({ error: "not found" });

      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.code(400).send({ error: "send the file as the request body" });
      }
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      const ext = EXT[type] ?? ".bin";

      await mkdir(deps.config.uploadDir, { recursive: true });
      const filePath = join(deps.config.uploadDir, `${contact.id}-${randomUUID()}${ext}`);
      await writeFile(filePath, bytes);

      let extracted: Record<string, unknown> = {};
      if (deps.vision) {
        const res = await deps.vision.extractFromBuffer(bytes, type);
        extracted = res.ok ? (res as unknown as Record<string, unknown>) : { ok: false, reason: (res as any).reason };
      }
      await deps.docs.create({ contactId: contact.id, source: "link", filePath, extracted });
      await deps.contacts.setStage(contact.id, "DOC_RECEIVED");
      await deps.events.log(contact.id, "doc_received", { leg: 1, detail: { source: "link" } });
      return reply.send({ ok: true });
    },
  );

  // Console preview of an uploaded file. Path is rebuilt from the configured
  // upload dir + the stored basename so a poisoned row can't read elsewhere.
  app.get<{ Params: { id: string } }>(
    "/campaigns/docs/:id/file",
    { preHandler },
    async (req, reply) => {
      const doc = await deps.docs.get(req.params.id);
      if (!doc?.filePath) return reply.code(404).send({ error: "not found" });
      const safe = join(deps.config.uploadDir, basename(doc.filePath));
      try {
        const bytes = await readFile(safe);
        const type =
          Object.entries(EXT).find(([, e]) => e === extname(safe))?.[0] ?? "application/octet-stream";
        return reply.type(type).send(bytes);
      } catch {
        return reply.code(404).send({ error: "file missing" });
      }
    },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
