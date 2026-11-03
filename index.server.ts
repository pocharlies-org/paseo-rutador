import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clasificar } from "./shared/contract.ts";
import { classifyBody, isTask } from "./shared/clasifica.ts";
import { residentRequest } from "./server/residente.ts";

// The server's whole job: answer the client's "is this a task?" with one resident call (LiteLLM). No state, no settings — the pill is
// driven entirely by the client reading the composer. A route that is down or refuses answers `task: false` (no pill), never an error.
export default function contribute(server: PluginServerContext) {
  server.handle(clasificar, async ({ text }) => {
    try {
      const answer = await residentRequest(classifyBody(text));
      const task = answer.status === 200 ? isTask(JSON.parse(answer.text)) : false;
      console.log(`rutador: clasificar status=${answer.status} task=${task} texto=${JSON.stringify(text.slice(0, 60))}`);
      return { task };
    } catch (error) {
      console.warn(`rutador: clasificar falló (${error instanceof Error ? error.message : "unknown"}) → task=false`);
      return { task: false };
    }
  });
  return () => {};
}
