import { Config } from "../config.js";

export type WaOption = { id: string; title: string };
export type InteraktClient = {
  sendText(to: string, text: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: WaOption[], header?: string): Promise<WaOption[]>;
  sendList(to: string, body: string, buttonLabel: string,
           rows: Array<{ id: string; title: string; description?: string }>, header?: string): Promise<WaOption[]>;
  sendTemplate(to: string, name: string, bodyValues: string[], buttonValues?: Record<string, string[]>): Promise<void>;
};

// Interakt wants countryCode + a 10-digit local number, split from the wa_id digits.
function splitPhone(to: string, defaultCc: string) {
  const digits = (to || "").replace(/\D/g, "");
  const local = digits.slice(-10);
  const isd = digits.slice(0, -10);
  return { countryCode: isd ? `+${isd}` : defaultCc, phoneNumber: local };
}

export function buildInteraktClient(config: Config, fetchImpl: typeof fetch = fetch): InteraktClient {
  if (!config.interaktApiKey) throw new Error("INTERAKT_API_KEY not set");

  async function post(to: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetchImpl(config.interaktBaseUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${config.interaktApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...splitPhone(to, config.interaktCountryCode), ...body }),
    });
    const data = await res.json().catch(() => ({}));
    // Interakt reports logical failures as 200 + result:false.
    if (!res.ok || (data as any)?.result === false) {
      throw new Error(`interakt send failed (${res.status}): ${(data as any)?.message ?? "unknown"}`);
    }
  }

  return {
    async sendText(to, text) {
      await post(to, { type: "Text", data: { message: text } });
    },

    async sendButtons(to, body, buttons, header) {
      const trimmed = buttons.slice(0, 3).map((b) => ({ id: b.id, title: b.title.slice(0, 20) }));
      const message: Record<string, unknown> = {
        type: "button",
        body: { text: body },
        action: { buttons: trimmed.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      };
      if (header) message.header = { type: "text", text: header.slice(0, 60) };
      await post(to, { type: "InteractiveButton", data: { message } });
      return trimmed;
    },

    async sendList(to, body, buttonLabel, rows, header) {
      const trimmedRows = rows.slice(0, 10).map((r) => ({
        id: r.id.slice(0, 200),
        title: r.title.slice(0, 24),
        ...(r.description ? { description: r.description.slice(0, 72) } : {}),
      }));
      const message: Record<string, unknown> = {
        type: "list",
        body: { text: body },
        action: { button: buttonLabel.slice(0, 20), sections: [{ rows: trimmedRows }] },
      };
      if (header) message.header = { type: "text", text: header.slice(0, 60) };
      await post(to, { type: "InteractiveList", data: { message } });
      return trimmedRows.map((r) => ({ id: r.id, title: r.title }));
    },

    // Business-initiated sends (driver offers, out-of-window confirms) must use a
    // pre-approved template. bodyValues fill {{1}}..{{n}}; buttonValues carries
    // quick-reply payloads keyed by button index ("0": ["acc:..."]).
    async sendTemplate(to, name, bodyValues, buttonValues) {
      await post(to, {
        type: "Template",
        template: { name, languageCode: "en", bodyValues, ...(buttonValues ? { buttonValues } : {}) },
      });
    },
  };
}
