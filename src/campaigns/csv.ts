// Minimal CSV in/out. The upload format is a handful of flat columns, so a
// hand-rolled parser beats a dependency — it handles quoted fields, embedded
// commas/quotes and CRLF, which is all a spreadsheet export produces.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
}

export type ParsedContactRow = {
  name: string;
  phoneDigits: string;
  city: string | null;
  refId: string | null;
  invalidReason: string | null;
};

// Header aliases, because every client's export names these columns differently.
const COLUMNS: Record<keyof Omit<ParsedContactRow, "invalidReason">, string[]> = {
  name: ["name", "customer name", "contact name", "customer"],
  phoneDigits: ["phone", "mobile", "number", "phone number", "mobile number", "msisdn"],
  city: ["city", "location", "town"],
  refId: ["ref", "ref id", "reference", "customer id", "customer ref", "id"],
};

function headerIndex(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, " "));
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const at = norm.findIndex((h) => aliases.includes(h));
    if (at >= 0) idx[field] = at;
  }
  return idx;
}

// India mobile: keep the last 10 digits and store them country-coded, matching
// the digits WhatsApp reports inbound. Anything that isn't a plausible mobile
// is flagged rather than silently dropped — the BRD wants invalid rows visible.
export function normalisePhone(raw: string, countryCode = "91"): { digits?: string; reason?: string } {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return { reason: "missing phone" };
  const last10 = d.slice(-10);
  if (last10.length < 10) return { reason: "phone too short" };
  if (!/^[6-9]/.test(last10)) return { reason: "not a mobile number" };
  return { digits: countryCode + last10 };
}

// Rows whose number could not be parsed are keyed `invalid:<raw>:<n>` so they
// stay visible and unique; anything user-facing shows the raw text instead.
export const displayPhone = (digits: string): string =>
  digits?.startsWith("invalid:") ? digits.split(":")[1] || "" : digits;

export type CsvIngest = {
  rows: ParsedContactRow[];
  headerError?: string;
};

// Parses and validates, but does not touch the database: duplicates *within the
// file* are flagged here, duplicates against the campaign are caught by the
// unique index at insert time.
export function parseContactCsv(text: string, countryCode = "91"): CsvIngest {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], headerError: "empty file" };
  const idx = headerIndex(table[0]);
  if (idx.name === undefined || idx.phoneDigits === undefined) {
    return { rows: [], headerError: "csv needs a name column and a phone/mobile column" };
  }

  const seen = new Set<string>();
  const rows: ParsedContactRow[] = [];
  for (const cells of table.slice(1)) {
    const at = (i?: number) => (i === undefined ? "" : (cells[i] ?? "").trim());
    const name = at(idx.name);
    const phone = normalisePhone(at(idx.phoneDigits), countryCode);
    const city = at(idx.city) || null;
    const refId = at(idx.refId) || null;

    let invalidReason: string | null = null;
    if (!name) invalidReason = "missing name";
    else if (phone.reason) invalidReason = phone.reason!;
    else if (seen.has(phone.digits!)) invalidReason = "duplicate in file";

    // A row with no usable phone still gets recorded (flagged) so the operator
    // can see and fix it; we key it on the raw text so it can't collide.
    const digits = phone.digits ?? `invalid:${at(idx.phoneDigits)}:${rows.length}`;
    if (phone.digits && !invalidReason) seen.add(phone.digits);
    rows.push({ name: name || "(no name)", phoneDigits: digits, city, refId, invalidReason });
  }
  return { rows };
}
