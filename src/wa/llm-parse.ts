import { Config } from "../config.js";

export type ParsedLoad = {
  fromText: string | null;
  toText: string | null;
  vehicleType: string | null;
  priceInr: number | null;
  pickupDate: string | null;
};

const EMPTY: ParsedLoad = { fromText: null, toText: null, vehicleType: null, priceInr: null, pickupDate: null };

const PROMPT = (today: string) => `You extract truck-load requests from short WhatsApp messages (English/Hindi/Hinglish).
Today is ${today}. Reply ONLY with JSON: {"fromText": string|null, "toText": string|null, "vehicleType": string|null, "priceInr": number|null, "pickupDate": "YYYY-MM-DD"|null}.
vehicleType examples: "Tata Ace","14ft","16ft","17ft","19ft","22ft","Container". Resolve relative dates ("kal"/"tomorrow") to a date. Use null for anything not stated.`;

// Best-effort: any failure returns EMPTY and the guided flow asks instead.
export function buildLoadParser(config: Config, fetchImpl: typeof fetch = fetch) {
  return async function parseLoad(text: string, today: string): Promise<ParsedLoad> {
    if (!config.groqApiKey) return EMPTY;
    try {
      const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: PROMPT(today) },
            { role: "user", content: text },
          ],
        }),
      });
      if (!res.ok) return EMPTY;
      const data: any = await res.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
      const price = Number(parsed.priceInr);
      return {
        fromText: typeof parsed.fromText === "string" && parsed.fromText ? parsed.fromText : null,
        toText: typeof parsed.toText === "string" && parsed.toText ? parsed.toText : null,
        vehicleType: typeof parsed.vehicleType === "string" && parsed.vehicleType ? parsed.vehicleType : null,
        priceInr: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
        pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.pickupDate ?? "") ? parsed.pickupDate : null,
      };
    } catch {
      return EMPTY;
    }
  };
}
