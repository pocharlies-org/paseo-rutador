import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PREFIX } from "../shared/contract.ts";
import { estadoFinal, finalDe, marcarFinal, suscribirFinales, textOf, type ToolCallLike } from "../client/pendientes.ts";

// What the card reads from the rutador's tool calls. The transformer sees the dismiss_task and the proposal_id start that
// end a proposal, the card does not: they meet in this store and the card shows «Retirada» / «Empezada» at once.

const start = (input: Record<string, unknown>, output: unknown): ToolCallLike => ({
  name: `${TOOL_PREFIX}start_session`,
  status: "completed",
  detail: { input, output },
});
const dismiss = (taskId: string, output = "Withdrew the proposal (task_id: " + taskId + "); its card no longer starts anything."): ToolCallLike => ({
  name: `${TOOL_PREFIX}dismiss_task`,
  status: "completed",
  detail: { input: { task_id: taskId }, output },
});

test("a dismiss_task that withdrew it or a start with its proposal_id ends a proposal; nothing else does", () => {
  assert.deepEqual(finalDe(dismiss("task_a")), { taskId: "task_a", final: "dismissed" });
  assert.deepEqual(
    finalDe(start({ proposal_id: "task_a", title: "Pulir el README", prompt: "b" }, { output: `Started the proposal "Pulir el README" (task_id: task_a) in its own session (agent_id: ag1).` })),
    { taskId: "task_a", final: "started" },
    "the Claude provider hands the result over as { output }",
  );
  assert.equal(finalDe(dismiss("task_a", "The proposal task_a was already started; nothing was withdrawn. Do not retry.")), null, "a dismiss that withdrew nothing");
  assert.equal(finalDe(start({ initiation: "own_initiative", title: "T", prompt: "b" }, `Proposed "T" (task_id: task_a). carry on.`)), null, "the proposal itself");
  assert.equal(finalDe({ name: "Bash", status: "completed", detail: {} }), null);
});

test("the result text arrives as a string, { output }, a content array or { content }", () => {
  assert.equal(textOf("x"), "x");
  assert.equal(textOf({ output: "x" }), "x");
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(textOf({ content: [{ type: "text", text: "c" }] }), "c");
  assert.equal(textOf(undefined), "");
});

test("a final is kept and heard once by the cards, after the transformer's render", async () => {
  let avisos = 0;
  const off = suscribirFinales(() => avisos++);
  marcarFinal("task_f", "started");
  marcarFinal("task_f", "started");
  assert.equal(estadoFinal("task_f"), "started");
  assert.equal(avisos, 0, "not during the transformer's pass: no setState while the timeline renders");
  await Promise.resolve();
  assert.equal(avisos, 1, "the same final notifies once");
  off();
  marcarFinal("task_g", "dismissed");
  await Promise.resolve();
  assert.equal(avisos, 1, "unsubscribed");
  assert.equal(estadoFinal("task_otra"), undefined);
});
