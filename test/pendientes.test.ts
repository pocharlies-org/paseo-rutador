import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PREFIX } from "../shared/contract.ts";
import { marcarFinal, pendientesDe, pendientesDesdeTimeline, ponerPendiente, reconciliar, suscribirPendientes, versionVivo, type ToolCallLike } from "../client/pendientes.ts";

// The pill's registry: what the timeline and `estado` say is pending. The client rehydrates with these (typed API),
// not with a transformer side effect — the transformer only runs on rows the GUI has mounted.

const start = (input: Record<string, unknown>, output: string, status = "completed"): ToolCallLike => ({
  name: `${TOOL_PREFIX}start_session`,
  status,
  detail: { input, output },
});
const dismiss = (taskId: string, output = "Withdrew the proposal (task_id: " + taskId + "); its card no longer starts anything."): ToolCallLike => ({
  name: `${TOOL_PREFIX}dismiss_task`,
  status: "completed",
  detail: { input: { task_id: taskId }, output },
});
const propuesta = (taskId = "task_a", title = "Pulir el README", prompt = "brief"): ToolCallLike =>
  start({ initiation: "own_initiative", title, prompt }, `Proposed "${title}" (task_id: ${taskId}). carry on.`);

test("a proposed card is pending until the history or the server ends it", () => {
  const s = pendientesDesdeTimeline([propuesta()], {});
  assert.deepEqual(s.pendientes.map((p) => [p.kind, p.taskId, p.title]), [["propuesta", "task_a", "Pulir el README"]]);
  assert.equal(s.vioRutador, true);

  assert.deepEqual(pendientesDesdeTimeline([propuesta()], { task_a: "started" }).pendientes, [], "the daemon has it started");
  assert.deepEqual(pendientesDesdeTimeline([propuesta()], { task_a: "dismissed" }).pendientes, [], "the registro has it dismissed");
  assert.deepEqual(pendientesDesdeTimeline([], { task_old: "dismissed" }).finales, [{ taskId: "task_old", final: "dismissed" }], "server finals survive outside the loaded history window");
  assert.deepEqual(pendientesDesdeTimeline([propuesta(), dismiss("task_a")], {}).pendientes, [], "the history has it withdrawn");
  assert.deepEqual(
    pendientesDesdeTimeline([propuesta(), start({ proposal_id: "task_a", title: "Pulir el README", prompt: "b" }, `Started the proposal "Pulir el README" (task_id: task_a) in its own session (agent_id: ag1).`)], {}).pendientes,
    [],
    "started by the agent with its proposal_id",
  );
});

test("an offer is pending only while the server waits for the answer", () => {
  const oferta = start({ initiation: "offer", title: "Revisar el PR" }, "", "running");
  assert.deepEqual(pendientesDesdeTimeline([oferta], { t1: "asking" }).pendientes, [{ taskId: "", title: "Revisar el PR", prompt: "", kind: "oferta" }]);
  assert.deepEqual(pendientesDesdeTimeline([oferta], {}).pendientes, [], "after a restart the pill does not carry it (the timeline card relays the answer)");
  assert.deepEqual(
    pendientesDesdeTimeline([start({ initiation: "offer", title: "Revisar el PR" }, 'The user chose "Hazlo aquí" (Do it here) (task_id: t1): do the task in this session now, as usual.')], { t1: "here" }).pendientes,
    [],
    "answered",
  );
});

test("user_asked rows are never pending; only rutador rows mark the agent as a rutador user", () => {
  const s = pendientesDesdeTimeline([start({ initiation: "user_asked", title: "X", prompt: "y" }, `Started session "X" (agent_id: ag1).`), { name: "Bash", status: "completed", detail: {} }], {});
  assert.deepEqual(s.pendientes, []);
  assert.equal(s.vioRutador, true, "a user_asked call is still a call of the rutador");
  assert.equal(pendientesDesdeTimeline([{ name: "Bash", status: "completed", detail: {} }], {}).vioRutador, false);
});

test("the scan reports the finals so the card can show «Retirada» without its row being mounted", () => {
  const s = pendientesDesdeTimeline([propuesta("task_x"), dismiss("task_x")], {});
  assert.deepEqual(s.finales, [{ taskId: "task_x", final: "dismissed" }]);
});

test("reconciliar fixes what the scan knows and keeps what it does not; a live change wins over an old scan", () => {
  const agent = "ag-reconcilio";
  const s = pendientesDesdeTimeline([propuesta("task_vieja"), propuesta("task_nueva")], {});
  reconciliar(agent, s);
  assert.deepEqual(pendientesDe(agent).map((p) => p.taskId), ["task_vieja", "task_nueva"]);

  // an old pass (version captured before the live change) must not reconcile: the live state stays as the click left it
  const versionAlEmpezar = versionVivo();
  ponerPendiente(agent, { taskId: "task_fuera_de_rango", title: "registrada en vivo", prompt: "b", kind: "propuesta" });
  assert.notEqual(versionVivo(), versionAlEmpezar, "the live registration moves the version");
  const scanViejo = pendientesDesdeTimeline([propuesta("task_vieja"), propuesta("task_nueva"), dismiss("task_nueva")], {});
  if (versionVivo() === versionAlEmpezar) reconciliar(agent, scanViejo);
  assert.deepEqual(pendientesDe(agent).map((p) => p.taskId).sort(), ["task_fuera_de_rango", "task_nueva", "task_vieja"]);

  // a fresh pass does: task_nueva was dismissed in the scan, the unknown one stays
  reconciliar(agent, pendientesDesdeTimeline([propuesta("task_vieja"), propuesta("task_nueva"), dismiss("task_nueva")], {}));
  assert.deepEqual(pendientesDe(agent).map((p) => p.taskId).sort(), ["task_fuera_de_rango", "task_vieja"]);
});

test("a final clears the pill and a finished proposal does not re-register", () => {
  const agent = "ag-final";
  ponerPendiente(agent, { taskId: "task_f", title: "T", prompt: "b", kind: "propuesta" });
  assert.equal(pendientesDe(agent).length, 1);
  marcarFinal("task_f", "started");
  assert.deepEqual(pendientesDe(agent), []);
  ponerPendiente(agent, { taskId: "task_f", title: "T", prompt: "b", kind: "propuesta" });
  assert.deepEqual(pendientesDe(agent), [], "the card of a started proposal does not light the pill again");
});

test("the snapshot is stable while nothing changes, and listeners hear a change", async () => {
  const agent = "ag-estable";
  assert.equal(pendientesDe(agent), pendientesDe(agent), "same array while nothing changes: useSyncExternalStore needs it");
  let avisos = 0;
  const off = suscribirPendientes(() => avisos++);
  ponerPendiente(agent, { taskId: "task_e", title: "T", prompt: "b", kind: "propuesta" });
  const antes = pendientesDe(agent);
  ponerPendiente(agent, { taskId: "task_e", title: "T", prompt: "b", kind: "propuesta" });
  assert.equal(pendientesDe(agent), antes, "the same pendiente changes nothing");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(avisos, 1);
  off();
  ponerPendiente(agent, { taskId: "task_e2", title: "T2", prompt: "b", kind: "propuesta" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(avisos, 1, "unsubscribed");
});
