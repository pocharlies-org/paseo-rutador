import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rutador } from "../server/herramientas.ts";
import { Sessions } from "../server/sesiones.ts";

const ids = () => {
  let n = 0;
  return () => `task_${String(++n).padStart(8, "0")}`;
};

test("an offer waits for the click: «Hazlo aquí» ends it here", async () => {
  const s = new Sessions(ids());
  const o = s.offer("a", "Revisar X");
  assert.ok("task" in o);
  assert.equal(s.answer("a", "here"), true);
  assert.deepEqual(await o.outcome, { kind: "here" });
  assert.equal(s.get(o.task.taskId)!.state, "here");
  assert.equal(s.answer("a", "new"), false, "an answered card takes no second answer");
  assert.deepEqual(s.claim("a", o.task.taskId), { refused: "here" }, "and starts no session");
});

test("«Subagente» and «Workflow» keep the task here, each with its own instruction, live and relayed", async () => {
  const sent: string[] = [];
  const paseo = { agents: { ref: () => ({ send: async (t: string) => void sent.push(t) }) } };
  const r = new Rutador(() => paseo as never, join(mkdtempSync(join(tmpdir(), "rutador-")), "t.json"));
  const call = r.startSession("a", { initiation: "offer", title: "X" }, new AbortController().signal, () => () => {});
  assert.deepEqual(await r.answer("a", "subagent", "X"), { ok: true });
  const out = await call;
  assert.match(out.text, /chose "Subagente".*one Agent tool call/);
  assert.equal(r.sessions.ofAgent("a")[0]!.state, "here", "and starts no session");

  assert.deepEqual(await r.answer("a", "workflow", "Y"), { ok: true, relayed: true });
  assert.match(sent[0]!, /Paseo se reinició.*chose "Workflow".*explicit opt-in to the Workflow tool/);
});

test("«Nueva sesión» waits for the brief, which starts it once", async () => {
  const s = new Sessions(ids());
  const o = s.offer("a", "Revisar X");
  assert.ok("task" in o);
  s.answer("a", "new");
  assert.deepEqual(await o.outcome, { kind: "new" });
  assert.deepEqual(s.claim("b", o.task.taskId), { refused: "unknown" }, "another agent cannot start it");
  const c = s.claim("a", o.task.taskId);
  assert.ok("task" in c && c.was === "awaiting_brief");
  s.started(o.task.taskId, "child");
  assert.deepEqual(s.claim("a", o.task.taskId), { refused: "started" });
});

test("a failed start puts the task back; a new user message or a dropped call closes the offer", async () => {
  const s = new Sessions(ids());
  const o = s.offer("a", "X");
  assert.ok("task" in o);
  assert.ok("busy" in s.offer("a", "Y"), "one offer at a time per agent");
  assert.ok("task" in s.offer("b", "Y"), "other agents are free");
  assert.equal(s.supersede("a"), true);
  assert.deepEqual(await o.outcome, { kind: "superseded" });
  assert.equal(s.answer("a", "here"), false);

  const o2 = s.offer("a", "Z");
  assert.ok("task" in o2);
  s.withdraw("a");
  assert.deepEqual(await o2.outcome, { kind: "withdrawn" });

  const o3 = s.offer("a", "W");
  assert.ok("task" in o3);
  s.answer("a", "new");
  await o3.outcome;
  const c = s.claim("a", o3.task.taskId);
  assert.ok("task" in c);
  s.release(o3.task.taskId, c.was);
  assert.equal(s.get(o3.task.taskId)!.state, "awaiting_brief");
});

test("own-initiative cards: three per turn, dismissable until started", () => {
  const s = new Sessions(ids());
  const p = [1, 2, 3].map((i) => s.propose("a", `t${i}`, "brief"));
  assert.ok(p.every((x) => "task" in x));
  assert.deepEqual(s.propose("a", "t4", "brief"), { limit: true });
  s.turnStarted("a");
  assert.ok("task" in s.propose("a", "t4", "brief"));

  const [first, second] = p as { task: { taskId: string } }[];
  assert.equal(s.dismiss("a", first!.task.taskId), "pending");
  assert.deepEqual(s.claim("a", first!.task.taskId), { refused: "dismissed" });
  assert.ok("task" in s.claim("a", second!.task.taskId));
  assert.equal(s.dismiss("a", second!.task.taskId), "started");
  assert.equal(s.dismiss("b", second!.task.taskId), "unknown");
});

test("after a restart a click on the card still answers: the agent gets it as a message, with the picked model", async () => {
  const sent: { agentId: string; text: string }[] = [];
  const created: unknown[] = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        send: async (text: string) => void sent.push({ agentId, text }),
        refresh: async () => ({ agent: { id: agentId, provider: "claude", model: "opus", workspaceId: "w" } }),
      }),
    },
    workspaces: { ref: () => ({ agents: { create: async (o: unknown) => (created.push(o), { id: "child" }) } }) },
  };
  const r = new Rutador(() => paseo as never, join(mkdtempSync(join(tmpdir(), "rutador-")), "t.json"));

  assert.deepEqual(await r.answer("a", "new", "Gemini en LiteLLM", "qwen38"), { ok: true, relayed: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Paseo se reinició/);
  const id = /proposal_id "(task_[a-z0-9]+)"/.exec(sent[0]!.text)![1]!;
  assert.deepEqual(await r.answer("a", "new", "Gemini en LiteLLM"), { ok: false }, "a second click sends nothing twice");
  assert.equal(sent.length, 1);

  const out = await r.startSession("a", { proposal_id: id, prompt: "brief" }, new AbortController().signal, () => () => {});
  assert.match(out.text, /now runs in its own session/);
  assert.equal((created[0] as { config: { provider: string } }).config.provider, "claude/qwen38", "the model picked on the card");

  assert.deepEqual(await r.answer("a", "here", "Otra"), { ok: true, relayed: true });
  assert.match(sent[1]!.text, /Hazlo aquí/);
  assert.deepEqual(await r.answer("a", "here", ""), { ok: false }, "an old client without the title gets the old answer");
});

test("a live offer is answered as always, without a message", async () => {
  const sent: string[] = [];
  const paseo = { agents: { ref: () => ({ send: async (t: string) => void sent.push(t) }) } };
  const r = new Rutador(() => paseo as never, join(mkdtempSync(join(tmpdir(), "rutador-")), "t.json"));
  const o = r.sessions.offer("a", "X");
  assert.ok("task" in o);
  assert.deepEqual(await r.answer("a", "here", "X"), { ok: true });
  assert.deepEqual(await o.outcome, { kind: "here" });
  assert.deepEqual(sent, []);

  const o2 = r.sessions.offer("a", "Y");
  assert.ok("task" in o2);
  r.sessions.withdraw("a"); // the agent's process died while the card waited
  assert.deepEqual(await r.answer("a", "new", "Y"), { ok: true, relayed: true });
  assert.equal(sent.length, 1);
});
