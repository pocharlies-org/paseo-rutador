// A minimal MCP server over Streamable HTTP on 127.0.0.1, one URL per agent (`/mcp/<agentId>`), bearer-protected.
// Why not a Paseo plugin tool: the daemon cuts those at 10 minutes, and an offer waits for the user as long as it takes.
// `tools/call` answers as an SSE stream that sends a comment every few seconds, so no HTTP client times the wait out;
// everything else answers plain JSON. No sessions, no server-initiated messages: Claude Code needs neither.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}
export interface McpToolResult {
  text: string;
  isError?: boolean;
}
export interface McpHandler {
  name: string;
  version: string;
  instructions: string;
  tools: McpTool[];
  call(agentId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult>;
}

const KEEPALIVE_MS = 15_000;
const MAX_BODY = 1024 * 1024;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export async function startMcpServer(handler: McpHandler): Promise<{ url: (agentId: string) => string; token: string; close: () => Promise<void> }> {
  const token = randomBytes(24).toString("hex");
  const calls = new Map<string, AbortController>(); // `${agentId}\0${rpcId}` -> the call, for notifications/cancelled

  const server = createServer((req, res) => {
    void serve(req, res).catch((error) => {
      console.error("rutador: mcp request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec((req.url ?? "").split("?")[0]!);
    if (!match) return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const agentId = match[1]!;

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return void res.writeHead(413).end();
    }
    let msg: Rpc;
    try {
      msg = JSON.parse(body);
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } });
    }

    if (msg.id === undefined || msg.id === null) {
      // A notification: only a cancellation matters.
      if (msg.method === "notifications/cancelled") calls.get(`${agentId}\0${String(msg.params?.requestId)}`)?.abort();
      return void res.writeHead(202).end();
    }

    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return json(res, 200, reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: handler.name, version: handler.version },
          instructions: handler.instructions,
        }));
      case "ping":
        return json(res, 200, reply({}));
      case "tools/list":
        return json(res, 200, reply({ tools: handler.tools }));
      case "tools/call":
        return callTool(agentId, msg, res);
      default:
        return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }

  async function callTool(agentId: string, msg: Rpc, res: ServerResponse) {
    const key = `${agentId}\0${String(msg.id)}`;
    const controller = new AbortController();
    calls.set(key, controller);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(); // the client went away (turn interrupted, process gone)
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": open\n\n");
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    try {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      let out: McpToolResult;
      try {
        out = await handler.call(agentId, name, args, controller.signal);
      } catch (error) {
        out = { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
      if (controller.signal.aborted) return;
      const payload = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: out.text }], isError: out.isError === true } };
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } finally {
      clearInterval(keepalive);
      calls.delete(key);
      if (!res.writableEnded) res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  console.log(`rutador: mcp on 127.0.0.1:${port}`);
  return {
    token,
    url: (agentId) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(agentId)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of calls.values()) c.abort();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
