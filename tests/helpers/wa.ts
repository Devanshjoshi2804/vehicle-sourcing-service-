import { InteraktClient } from "../../src/wa/interakt.client.js";

export function fakeInterakt(failTemplates = false) {
  const sent: { kind: string; to: string; args: any[] }[] = [];
  const rec = (kind: string) => async (to: string, ...args: any[]) => {
    if (failTemplates && kind === "template") throw new Error("template not approved");
    sent.push({ kind, to, args });
    return args[2] ?? [];
  };
  const client = {
    sendText: rec("text"), sendButtons: rec("buttons"), sendList: rec("list"), sendTemplate: rec("template"),
  } as unknown as InteraktClient;
  return { client, sent };
}
