import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { empezar, estado, modelos, responder, SERVER, TOOL_PREFIX } from "./shared/contract.ts";
import { Rutador } from "./server/herramientas.ts";
import { Coordinaciones, coordinationInput } from "./server/coordinaciones.ts";
import { z } from "zod";
import { startMcpServer } from "./server/mcp.ts";
import { DISMISS_DESCRIPTION, DISMISS_SCHEMA, INSTRUCTIONS, START_DESCRIPTION, START_SCHEMA } from "./server/textos.ts";

// Claude Desktop's way of offering sessions, in Paseo: every Claude session gets this plugin's own MCP server (`rutador`)
// when it opens — created or resumed — with `start_session` and `dismiss_task`, and Desktop's "Starting other sessions"
// guidance as the server's instructions. The client draws the tool calls as cards («Nueva sesión» / «Hazlo aquí»).
export default function contribute(server: PluginServerContext) {
  let paseo: PaseoApi | null = null;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const rutador = new Rutador(() => paseo, join(home, "rutador-tareas.json"));
  const coordinaciones = new Coordinaciones(home);
  const background = (work: Promise<unknown>) => { void work.catch((error) => console.error("rutador: coordination failed", error)); };

  // While an offer is up, a user message on that agent closes it (Desktop: "they sent a new message instead").
  const watchUserMessages = (agentId: string) => {
    if (!paseo) return () => {};
    const sub = paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (event.type === "timeline" && (event.item as { type?: string }).type === "user_message") rutador.sessions.supersede(agentId);
    });
    return () => void Promise.resolve(sub.release()).catch(() => {});
  };

  const mcp = startMcpServer({
    name: SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [
      { name: "start_session", description: START_DESCRIPTION, inputSchema: START_SCHEMA },
      { name: "dismiss_task", description: DISMISS_DESCRIPTION, inputSchema: DISMISS_SCHEMA },
      { name: "coordinate_session", description: "Coordinate an existing independent producer in this workspace. link records the objective and exclusive coordinator without sending a prompt; continue sends one follow-up with a stable request_id UUID and returns results through events; status reads the retained result; release ends ownership without stopping either session. Never use alongside native notifyOnFinish or producer autopilot. A completed turn is not a verified delivery. Do not poll, override pending permissions, or resume canceled/archived work. Register the link before ESPERA: sesion <agent_id>.", inputSchema: z.toJSONSchema(coordinationInput) },
    ],
    call: async (agentId, tool, args, signal) => {
      if (tool === "start_session") return rutador.startSession(agentId, args, signal, watchUserMessages);
      if (tool === "dismiss_task") return rutador.dismissTask(agentId, args);
      if (tool === "coordinate_session") {
        if (!paseo) throw new Error("Paseo API not ready");
        return coordinaciones.tool(agentId, args, paseo);
      }
      return { isError: true, text: `Unknown tool: ${tool}` };
    },
  }, join(home, "rutador-mcp.json"));
  mcp.catch((error) => console.error("rutador: MCP server did not start", error));

  // Only the claude provider: a provider without MCP support would fail to open with an extra server.
  server.before("agent.session_open", async ({ request }, context) => {
    paseo ??= context.paseo;
    background(coordinaciones.ready(context.paseo));
    if (request.provider !== "claude" || request.purpose !== "interactive") return;
    let url: (agentId: string) => string, token: string;
    try {
      ({ url, token } = await mcp);
    } catch (error) {
      console.error("rutador: no MCP server, the session opens without start_session", error); // never block an open
      return;
    }
    return {
      ...request,
      mcpServers: {
        ...request.mcpServers,
        [SERVER]: { type: "http", url: url(request.agentId), headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true },
      },
    };
  });

  server.on("agent.turn_started", (event, context) => {
    paseo ??= context.paseo;
    rutador.sessions.turnStarted(event.agent.id);
    background(coordinaciones.ready(context.paseo));
  });
  server.on("agent.turn_ended", ({ agent, outcome }, context) => {
    background(coordinaciones.ended(agent.id, outcome.kind, context.paseo));
  });
  server.on("agent.archived", ({ agent }, context) => background(coordinaciones.closed(agent.id, context.paseo)));
  server.on("agent.closed", ({ agent }, context) => background(coordinaciones.closed(agent.id, context.paseo)));

  // Only card tools are pre-approved: their card is the question, not a permission grant for other operations.
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    if (request.name !== `${TOOL_PREFIX}start_session` && request.name !== `${TOOL_PREFIX}dismiss_task`) {
      background(coordinaciones.permission(agent.id, context.paseo));
      return;
    }
    await context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  server.handle(responder, ({ agentId, choice, title, model }, context) => {
    paseo ??= context.paseo;
    return rutador.answer(agentId, choice, title ?? "", model);
  });
  server.handle(empezar, async ({ agentId, taskId, title, prompt, model }, context) => {
    paseo ??= context.paseo;
    return rutador.startFromCard(agentId, taskId, title, prompt, model);
  });
  server.handle(estado, ({ agentId }) => ({ tasks: rutador.states(agentId) }));
  server.handle(modelos, async ({ agentId }, context) => {
    paseo ??= context.paseo;
    return rutador.models(agentId);
  });

  return async () => { await coordinaciones.close(); await mcp.then((m) => m.close(), () => {}); };
}
