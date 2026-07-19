import nodemailer, { Transporter } from "nodemailer";
import { Config } from "../config.js";

// Thin best-effort wrapper: send() never throws, callers branch on the boolean
// (e.g. orchestrator's voice fallback when an offer email fails to send).
export type Mailer = {
  send(to: string, subject: string, text: string, html?: string): Promise<boolean>;
};

export function buildMailer(config: Config, transportFactory?: () => Transporter): Mailer {
  const transport =
    transportFactory?.() ??
    nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });

  return {
    async send(to, subject, text, html) {
      try {
        await transport.sendMail({ from: config.smtpFrom ?? config.smtpUser, to, subject, text, html });
        return true;
      } catch {
        return false;
      }
    },
  };
}
