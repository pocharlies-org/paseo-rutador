import { test } from "node:test";
import assert from "node:assert/strict";
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
