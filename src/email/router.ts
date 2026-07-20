import { EmailMsg } from "./inbound.js";
import { EmailSessionsRepo } from "./email-sessions.repo.js";
import { OwnersRepo } from "../owners/owners.repo.js";
import { DriverFlowDeps, handleDriverMessage } from "./driver-flow.js";
import { CustomerFlowDeps, handleCustomerMessage } from "./customer-flow.js";
import { Config } from "../config.js";

export type EmailRouterDeps = {
  sessions: EmailSessionsRepo;
  ownersRepo: OwnersRepo;
  driver: DriverFlowDeps;
  customer: CustomerFlowDeps;
  config: Config;
};

// pulls the bare address out of a "Name <addr@x.com>" header value; falls
// back to the raw string when there's no angle-bracket form.
function bareAddress(v: string): string {
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1] : v).toLowerCase();
}

// Entry point the IMAP source (and tests) drive directly: skip auto-replies,
// dedupe by Message-ID, then split by whether the sender is a known active
// driver (owners.email) or a customer.
export function buildEmailRouter(deps: EmailRouterDeps): { handle(msg: EmailMsg): Promise<void> } {
  return {
    async handle(m: EmailMsg): Promise<void> {
      if (m.autoReply) return;

      // self-loop guard: a shared mailbox with BCC-to-self would otherwise have
      // us process (and reply to) our own outbound sends forever.
      const self = bareAddress(deps.config.smtpUser ?? deps.config.imapUser ?? "");
      const selfFrom = deps.config.smtpFrom ? bareAddress(deps.config.smtpFrom) : "";
      const from = bareAddress(m.from);
      if (self && (from === self || (selfFrom && from === selfFrom))) return;

      // first-time senders need a session row before markProcessed can dedupe
      // (mirrors wa.routes.ts) — role is best-effort, decisions below always
      // re-check the owner match fresh rather than trusting the stored role.
      const existing = await deps.sessions.get(m.from);
      if (!existing) {
        const owner = await deps.ownersRepo.findByEmail(m.from);
        await deps.sessions.upsert({ address: m.from, role: owner ? "driver" : "customer", state: "IDLE" });
      }
      if (!(await deps.sessions.markProcessed(m.from, m.messageId))) return; // duplicate delivery

      const session = await deps.sessions.get(m.from);
      const owner = await deps.ownersRepo.findByEmail(m.from);

      if (owner) await handleDriverMessage(deps.driver, m, session, owner);
      else await handleCustomerMessage(deps.customer, m, session);
    },
  };
}
