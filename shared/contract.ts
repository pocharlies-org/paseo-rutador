import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The MCP server name the agent sees: its tools are `mcp__rutador__start_session` and `mcp__rutador__dismiss_task`. */
export const SERVER = "rutador";
export const TOOL_PREFIX = `mcp__${SERVER}__`;

/** The card drawn in place of a `start_session` tool call. */
export const CARD_KIND = "rutador-sesion";
export const cardSchema = z.object({
  status: z.enum(["running", "completed", "failed", "canceled"]),
  initiation: z.enum(["offer", "user_asked", "own_initiative", "brief"]),
  title: z.string(),
  prompt: z.string(),
  taskId: z.string().nullable(),
  result: z.string(),
});
export type CardData = z.output<typeof cardSchema>;

/** A model id picked on a card for the new session; absent = the one this session runs. */
const model = z.string().min(1).max(200).optional();

/** The user's click on an offer card: answers the offer the agent's tool call is waiting on. After a restart of Paseo
 * that offer is gone, and the answer goes to the agent as a message instead (`relayed`); the title names it there. */
export const responder = defineRpc({
  name: "rutador.responder",
  input: z.object({ agentId: z.string().min(1), choice: z.enum(["new", "here"]), title: z.string().max(200).optional(), model }).strict(),
  output: z.object({ ok: z.boolean(), relayed: z.boolean().optional() }),
});

/** The user's click on an own-initiative card: starts its session from the brief the agent wrote. */
export const empezar = defineRpc({
  name: "rutador.empezar",
  input: z.object({ agentId: z.string().min(1), taskId: z.string().min(1), title: z.string(), prompt: z.string(), model }).strict(),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** Where each card of an agent stands, so a card can show «Empezada» or «Retirada» instead of its button. */
export const estado = defineRpc({
  name: "rutador.estado",
  input: z.object({ agentId: z.string().min(1) }).strict(),
  output: z.object({ tasks: z.record(z.string(), z.string()) }),
});

/** The models a card offers for the new session: the session's provider's, and the one the session runs now. */
export const modelos = defineRpc({
  name: "rutador.modelos",
  input: z.object({ agentId: z.string().min(1) }).strict(),
  output: z.object({ current: z.string().nullable(), models: z.array(z.object({ id: z.string(), label: z.string() })) }),
});
