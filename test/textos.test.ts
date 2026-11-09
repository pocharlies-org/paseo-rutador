import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS, START_DESCRIPTION } from "../server/textos.ts";

test("dependent work uses a returning worker, not an independent session", () => {
  assert.match(INSTRUCTIONS, /If this task needs the result/);
  assert.match(INSTRUCTIONS, /create_agent/);
  assert.match(INSTRUCTIONS, /notifyOnFinish/);
  assert.match(START_DESCRIPTION, /independent work/);
});

test("an existing producer is continued rather than duplicated or treated as delivered", () => {
  assert.match(INSTRUCTIONS, /coordinate_session/);
  assert.match(INSTRUCTIONS, /ESPERA: sesion/);
  assert.match(INSTRUCTIONS, /Do not also use `send_agent_prompt` or `notifyOnFinish`/);
  assert.match(INSTRUCTIONS, /A finished turn is not a verified deliverable/);
  assert.match(INSTRUCTIONS, /Never wait for your own ticket to close/);
  assert.match(INSTRUCTIONS, /Do not poll/);
});
