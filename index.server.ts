import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { empezar, estado, responder, SERVER } from "./shared/contract.ts";
import { Rutador } from "./server/herramientas.ts";
import { startMcpServer } from "./server/mcp.ts";
import { DISMISS_DESCRIPTION, DISMISS_SCHEMA, INSTRUCTIONS, START_DESCRIPTION, START_SCHEMA } from "./server/textos.ts";

// Claude Desktop's way of offering sessions, in Paseo: every Claude session gets this plugin's own MCP server (`rutador`)
// when it opens — created or resumed — with `start_session` and `dismiss_task`, and Desktop's "Starting other sessions"
// guidance as the server's instructions. The client draws the tool calls as cards («Nueva sesión» / «Hazlo aquí»).
export default function contribute(server: PluginServerContext) {
  let paseo: PaseoApi | null = null;
  const rutador = new Rutador(() => paseo);

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
    ],
    call: async (agentId, tool, args, signal) => {
      if (tool === "start_session") return rutador.startSession(agentId, args, signal, watchUserMessages);
      if (tool === "dismiss_task") return rutador.dismissTask(agentId, args);
      return { isError: true, text: `Unknown tool: ${tool}` };
    },
  });
  mcp.catch((error) => console.error("rutador: MCP server did not start", error));

  // Only the claude provider: a provider without MCP support would fail to open with an extra server.
  server.before("agent.session_open", async ({ request }, context) => {
    paseo ??= context.paseo;
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
  });

  server.handle(responder, ({ agentId, choice }) => ({ ok: rutador.sessions.answer(agentId, choice) }));
  server.handle(empezar, async ({ agentId, taskId, title, prompt }, context) => {
    paseo ??= context.paseo;
    return rutador.startFromCard(agentId, taskId, title, prompt);
  });
  server.handle(estado, ({ agentId }) => ({ tasks: rutador.states(agentId) }));

  return () => mcp.then((m) => m.close(), () => {});
}
