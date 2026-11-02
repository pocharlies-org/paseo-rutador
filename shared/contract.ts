import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Is this draft a task worth its own session/subagent? The client asks on a settled composer draft; the server answers with one
 * cheap resident call. `task: false` on any failure — a classify that cannot run simply shows no pill. */
export const clasificar = defineRpc({
  name: "rutador.clasificar",
  input: z.object({ text: z.string().min(1).max(4000) }).strict(),
  output: z.object({ task: z.boolean() }),
});
