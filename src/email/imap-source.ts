import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Config } from "../config.js";
import { EmailMsg, normalizeEmail } from "./inbound.js";

export type EmailInbound = { start(onMsg: (m: EmailMsg) => Promise<void>): Promise<void>; stop(): Promise<void> };

// Integration-only — no unit tests (real IMAP is out of reach for a fast test
// suite). Keep it thin: connect, fetch UNSEEN, hand each off to normalizeEmail
// + the router's onMsg, mark \Seen, repeat on a poll timer. Any error (bad
// creds, network blip, a message that fails to parse) just waits and retries;
// it never takes the process down.
export function buildImapSource(config: Config): EmailInbound {
  let stopped = true;
  let timer: NodeJS.Timeout | null = null;

  async function pollOnce(onMsg: (m: EmailMsg) => Promise<void>): Promise<void> {
    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: true,
      auth: { user: config.imapUser!, pass: config.imapPassword! },
      logger: false,
    });
    // ImapFlow emits 'error' asynchronously on a socket timeout / dropped
    // connection. With no listener Node rethrows it as an uncaught exception and
    // kills the whole process — the poll promise's try/catch can't see it. A
    // no-op listener keeps it contained; the next tick reconnects.
    client.on("error", () => {});
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
          try {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            await onMsg(normalizeEmail(parsed as any));
          } finally {
            // Marked \Seen even on a processing failure — a message we can't
            // handle shouldn't be re-fetched forever; it's still in the mailbox.
            await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true }).catch(() => {});
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  function scheduleNext(onMsg: (m: EmailMsg) => Promise<void>, delayMs: number) {
    if (stopped) return;
    timer = setTimeout(() => void tick(onMsg), delayMs);
  }

  async function tick(onMsg: (m: EmailMsg) => Promise<void>): Promise<void> {
    if (stopped) return;
    try {
      await pollOnce(onMsg);
      scheduleNext(onMsg, config.emailPollSeconds * 1000);
    } catch {
      // connect/fetch failure — back off 30s and try again rather than spin.
      scheduleNext(onMsg, 30_000);
    }
  }

  return {
    async start(onMsg) {
      stopped = false;
      void tick(onMsg);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
