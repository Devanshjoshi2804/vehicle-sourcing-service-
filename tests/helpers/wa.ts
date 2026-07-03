import { InteraktClient } from "../../src/wa/interakt.client.js";

// failSends: buttons + template sends throw (drives the offer → voice fallback path).
export function fakeInterakt(failSends = false) {
  const sent: { kind: string; to: string; args: any[] }[] = [];
  const rec = (kind: string) => async (to: string, ...args: any[]) => {
    if (failSends && (kind === "template" || kind === "buttons")) throw new Error("send failed");
    sent.push({ kind, to, args });
    return args[2] ?? [];
  };
  const client = {
    sendText: rec("text"), sendButtons: rec("buttons"), sendList: rec("list"), sendTemplate: rec("template"),
  } as unknown as InteraktClient;
  return { client, sent };
}
