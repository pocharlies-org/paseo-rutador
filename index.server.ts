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
      if (answer.status !== 200) return { task: false };
      return { task: isTask(JSON.parse(answer.text)) };
    } catch {
      return { task: false };
    }
  });
  return () => {};
}
