import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Coordinaciones } from "../server/coordinaciones.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const producer = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const row = (type: string, text: string, id = randomUUID()) => ({ item: { type, text, messageId: id, clientMessageId: id }, seqStart: 1, seqEnd: 1, timestamp: "2026-01-01T00:00:00Z" });

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "rutador-coordination-"));
  const pages = new Map([owner, producer, other].map((id) => [id, {
    agent: { id, workspaceId: "w", status: "running", archivedAt: null as string | null, pendingPermissions: [] as unknown[], labels: {} as Record<string, string>, lastUserMessageAt: null as string | null, attentionReason: null as string | null, attentionTimestamp: null as string | null },
    entries: [row("user_message", "Original task")] as any[], error: null, hasOlder: false, startCursor: null, epoch: "one", gap: false, staleCursor: false,
  }]));
  const sent: { id: string; text: string; options: any }[] = [];
  const appended: unknown[] = [];
  const callbacks = new Map<string, (event: any) => void>();
  let failSend = false;
  const api = { agents: { ref: (id: string) => ({
    timeline: {
      refetch: async () => structuredClone(pages.get(id)),
      append: async (item: unknown) => { appended.push(item); return { seq: 1, epoch: "one" }; },
      subscribe: (fn: (event: any) => void) => {
        callbacks.set(id, fn);
        return { ready: Promise.resolve(), release: () => callbacks.delete(id) };
      },
    },
    send: async (text: string, options: any) => {
      sent.push({ id, text, options });
      if (failSend) throw new Error("connection lost after dispatch");
      pages.get(id)!.entries.push({ item: { type: "tool_call", name: "agent_message", callId: `paseo-agent-message:${options.messageId}`, status: "completed", error: null, agentMessage: { event: "message", sender: { id: options.sourceAgentId }, text } }, seqStart: 2, seqEnd: 2 });
      pages.get(id)!.agent.status = "running";
    },
  }) } };
  const coord = new Coordinaciones(home);
  const call = (action: string, extra: object = {}, caller = owner, instance = coord) => instance.tool(caller, { action, agent_id: producer, ...extra }, api as never);
  const snapshot = () => JSON.parse(readFileSync(join(home, "rutador-coordinaciones.json"), "utf8")).delegations[producer];
  const finish = (text: string) => {
    const p = pages.get(producer)!;
    p.entries.push(row("assistant_message", text));
    p.agent.status = "idle"; p.agent.attentionReason = "finished"; p.agent.attentionTimestamp = randomUUID();
  };
  t.after(async () => { await coord.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, pages, sent, appended, callbacks, api, coord, call, snapshot, finish, fail: () => { failSend = true; } };
}

test("a partial result wakes its coordinator; continuing and accepting does not activate worker autopilot", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Deliver alpha and beta" });
  assert.equal(f.sent.length, 0);
  f.finish("Partial: alpha, beta missing");
  await f.coord.ended(producer, "completed", f.api as never);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /Partial: alpha/);
  assert.equal(f.snapshot().state, "result");
  const request_id = randomUUID();
  await f.call("continue", { prompt: "Produce beta", request_id });
  assert.equal(f.sent[1]!.id, producer);
  assert.equal(f.sent[1]!.options.activeTurnBehavior, "steer");
  await f.call("continue", { prompt: "Produce beta", request_id });
  assert.equal(f.sent.length, 2, "same request is not dispatched twice");
  f.finish("Final: alpha and beta");
  await f.coord.ended(producer, "completed", f.api as never);
  assert.match(f.sent[2]!.text, /Final: alpha and beta/);
  await f.call("release");
  assert.equal(f.snapshot(), undefined);
});

test("ownership is exclusive, cannot form cycles, and returning native children use their own channel", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  await assert.rejects(f.call("link", { objective: "Other" }, other), /already has a coordinator/);
  await assert.rejects(f.coord.tool(producer, { action: "link", agent_id: owner, objective: "Cycle" }, f.api as never), /Nested coordination/);
  await assert.rejects(f.call("release", {}, other), /already has a coordinator/);
  await f.call("release");
  f.pages.get(producer)!.agent.labels["paseo.parent-agent-id"] = owner;
  await assert.rejects(f.call("link", { objective: "Child" }), /native returning child/);
});

test("permissions are reported but never approved or used to restart a producer", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  f.pages.get(producer)!.agent.pendingPermissions.push({ id: "permission" });
  await f.coord.permission(producer, f.api as never);
  assert.match(f.sent[0]!.text, /needs permission/);
  assert.equal(f.sent[0]!.id, owner);
  await assert.rejects(f.call("continue", { prompt: "Continue", request_id: randomUUID() }), /pending permissions/);
  assert.equal(f.sent.length, 1);
});

test("producer cancellation pauses the delegation, retaining progress without a worker retry", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  f.finish("Partial progress before cancellation");
  await f.coord.ended(producer, "canceled", f.api as never);
  assert.equal(f.snapshot().state, "paused");
  assert.match(f.sent[0]!.text, /canceled/);
  await assert.rejects(f.call("continue", { prompt: "Retry", request_id: randomUUID() }), /paused/);
  assert.ok(f.sent.every((x) => x.id === owner));
});

test("canceling or archiving the coordinator does not let a later result restart it", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  await f.coord.ended(owner, "canceled", f.api as never);
  f.finish("Finished after cancellation");
  await f.coord.ended(producer, "completed", f.api as never);
  assert.equal(f.sent.length, 0);
  assert.equal(f.snapshot().state, "paused");
  assert.ok(f.appended.length);
});

test("human messages on either participant suspend automation, including after reconnect", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  f.pages.get(owner)!.agent.lastUserMessageAt = "2026-01-01T01:00:00Z";
  f.finish("Result");
  await f.coord.ended(producer, "completed", f.api as never);
  assert.equal(f.sent.length, 0);
  assert.equal(f.snapshot().state, "paused");
});

test("a result completed during plugin downtime is recovered once without re-running the worker", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  await f.coord.close();
  f.finish("Done while disconnected");
  const restored = new Coordinaciones(f.home);
  t.after(() => restored.close());
  await restored.ready(f.api as never);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /Done while disconnected/);
  const restoredAgain = new Coordinaciones(f.home);
  t.after(() => restoredAgain.close());
  await restoredAgain.ready(f.api as never);
  assert.equal(f.sent.length, 1);
});

test("idle with partial text but no completed outcome is not recovered as success", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  f.pages.get(producer)!.entries.push(row("assistant_message", "Partial before process loss"));
  f.pages.get(producer)!.agent.status = "idle";
  await f.coord.close();
  const restored = new Coordinaciones(f.home);
  t.after(() => restored.close());
  await restored.ready(f.api as never);
  assert.equal(f.snapshot().state, "paused");
  assert.match(f.snapshot().reason, /without a proven completed turn/);
  assert.ok(f.sent.every((x) => x.id === owner));
});

test("uncertain prompt admission is never retried, even when request_id is repeated", async (t) => {
  const f = fixture(t);
  await f.call("link", { objective: "Report" });
  f.finish("Partial");
  await f.coord.ended(producer, "completed", f.api as never);
  f.fail();
  const request_id = randomUUID();
  await f.call("continue", { prompt: "Next", request_id });
  const count = f.sent.length;
  assert.equal(f.snapshot().state, "paused");
  await f.call("continue", { prompt: "Next", request_id });
  assert.equal(f.sent.length, count);
});

test("an unregistered session wait gets one correction, not a silent sleep or a loop", async (t) => {
  const f = fixture(t);
  f.pages.get(owner)!.entries.push(row("assistant_message", `ESPERA: sesion ${producer} → integrate`));
  f.pages.get(owner)!.agent.status = "idle";
  await f.coord.ended(owner, "completed", f.api as never);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /UNREGISTERED_SESSION_WAIT/);
  f.pages.get(owner)!.entries.push(row("assistant_message", `ESPERA: sesion ${producer} → integrate`));
  f.pages.get(owner)!.agent.status = "idle";
  await f.coord.ended(owner, "completed", f.api as never);
  assert.equal(f.sent.length, 1);
});

test("an already idle producer is inspectable and explicitly continuable", async (t) => {
  const f = fixture(t);
  f.finish("Partial before link");
  const linked = await f.call("link", { objective: "Finish report" });
  assert.equal(JSON.parse(linked.text).state, "result");
  assert.match(linked.text, /Partial before link/);
  assert.equal(f.sent.length, 0);
  await f.call("continue", { prompt: "Finish it", request_id: randomUUID() });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.id, producer);
});

test("corrupted storage and invalid tool input fail closed", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.coord.tool(owner, { action: "link", agent_id: "not-an-id" }, f.api as never));
  writeFileSync(join(f.home, "rutador-coordinaciones.json"), "{");
  assert.throws(() => new Coordinaciones(f.home));
});
