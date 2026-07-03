// Live smoke: sends one text + one button message to the phone in argv[2].
//   npx tsx scripts/wa-smoke.ts 919888888888

import { loadConfig } from "../src/config.js";
import { buildInteraktClient } from "../src/wa/interakt.client.js";

const to = process.argv[2];
if (!to) throw new Error("usage: npx tsx scripts/wa-smoke.ts <digits>");

const client = buildInteraktClient(loadConfig());
await client.sendText(to, "wa-smoke: text OK");
await client.sendButtons(to, "wa-smoke: pick one", [
  { id: "smoke:a", title: "Option A" },
  { id: "smoke:b", title: "Option B" },
]);
console.log("sent — check the phone");
