import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server.ts";

test("only existing card tools are auto-approved, never new coordination tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "rutador-permissions-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    before: () => {},
    handle: () => {},
  };
  const approved: string[] = [];
  const context = { paseo: { agents: { ref: () => ({ respondToPermission: async ({ requestId }: { requestId: string }) => approved.push(requestId) }) } } };
  const close = contribute(server as never);
  try {
    const handler = handlers.get("agent.permission_requested")!;
    for (const name of ["mcp__rutador__start_session", "mcp__rutador__dismiss_task", "mcp__rutador__coordinate_session", "mcp__other__write"]) {
      await handler({ agent: { id: "a" }, request: { id: name, name } }, context);
    }
    assert.deepEqual(approved, ["mcp__rutador__start_session", "mcp__rutador__dismiss_task"]);
  } finally {
    await close();
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
