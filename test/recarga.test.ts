import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server.ts";

test("the app's state RPC initializes the MCP API after reload, without a new agent turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "rutador-reload-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = {
    on: () => {}, before: () => {},
    handle: (contract: { name: string }, handler: (...args: any[]) => any) => handlers.set(contract.name, handler),
  };
  const close = contribute(server as never);
  try {
    // The RPC is installed synchronously, while the MCP listener binds asynchronously.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handlers.get("rutador.estado")!({ agentId: "00000000-0000-4000-8000-000000000001" }, { paseo: {} });
    const saved = JSON.parse(readFileSync(join(home, "rutador-mcp.json"), "utf8"));
    const r = await fetch(`http://127.0.0.1:${saved.port}/mcp/00000000-0000-4000-8000-000000000001`, {
      method: "POST", headers: { Authorization: `Bearer ${saved.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "coordinate_session", arguments: { action: "status", agent_id: "00000000-0000-4000-8000-000000000002" } } }),
    });
    const text = await r.text();
    assert.match(text, /No registered delegation/);
    assert.doesNotMatch(text, /Paseo API not ready/);
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
