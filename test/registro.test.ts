import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registro } from "../server/registro.ts";
import { Sessions } from "../server/sesiones.ts";
import { Rutador } from "../server/herramientas.ts";

test("card endings survive a restart, per agent, and a failed start can be forgotten", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rutador-")), "sub", "tareas.json");
  const r = new Registro(path);
  r.set("a", "task_1", "dismissed");
  r.set("a", "task_2", "started");
  r.set("a", "task_3", "started");
  r.set("a", "task_3", undefined);
  const after = new Registro(path);
  assert.equal(after.get("a", "task_1"), "dismissed");
  assert.equal(after.get("b", "task_1"), undefined, "another agent's card is not this one");
  assert.deepEqual(after.ofAgent("a"), { task_1: "dismissed", task_2: "started" });
});

test("the model picked with «Nueva sesión» stays on the task for the brief", async () => {
  const s = new Sessions();
  const o = s.offer("a", "X");
  assert.ok("task" in o);
  s.answer("a", "new", "qwen38-flash-next");
  await o.outcome;
  assert.equal(s.get(o.task.taskId)!.model, "qwen38-flash-next");
});

test("after a restart, a dismissed or started card does not start from its click", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "rutador-")), "tareas.json");
  new Registro(path).set("a", "task_d", "dismissed");
  new Registro(path).set("a", "task_s", "started");
  const r = new Rutador(() => null, path); // no Paseo: any attempt to create a session would fail differently
  assert.deepEqual(await r.startFromCard("a", "task_d", "T", "brief"), { ok: false, error: "dismissed" });
  assert.deepEqual(await r.startFromCard("a", "task_s", "T", "brief"), { ok: false, error: "started" });
  assert.equal(r.states("a").task_d, "dismissed");
});
