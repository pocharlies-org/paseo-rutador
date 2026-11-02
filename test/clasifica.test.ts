import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASSIFY_MODEL, classifyBody, isTask } from "../shared/clasifica.ts";

const answer = (text: string) => ({ content: [{ type: "text", text }] });

test("sí → tarea", () => assert.equal(isTask(answer("sí")), true));
test("Sí con puntuación → tarea", () => assert.equal(isTask(answer("Sí.")), true));
test("no → no es tarea", () => assert.equal(isTask(answer("No.")), false));
test("respuesta vacía o sin content → no es tarea", () => {
  assert.equal(isTask(answer("")), false);
  assert.equal(isTask({}), false);
  assert.equal(isTask(undefined), false);
});
test("el body lleva el modelo, la instrucción y el borrador", () => {
  const body = JSON.parse(classifyBody("hazme un PR con el fix"));
  assert.equal(body.model, CLASSIFY_MODEL);
  assert.equal(body.tools.length, 0);
  assert.match(JSON.stringify(body.messages), /hazme un PR con el fix/);
});
