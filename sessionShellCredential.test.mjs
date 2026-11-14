import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionApiOriginVariable,
  sessionBearerVariable,
} from "@chuggy/worker-contract/workerEnvironment";

import {
  bearer,
  environment,
  facts,
  planeOf,
  queryOf,
  run,
  task,
  threadRoster,
} from "./sessionHarness.fixture.mjs";

const thread = { ...facts, kind: "Thread", capabilities: [...threadRoster] };

async function environmentOf(sessionFacts, services = {}) {
  const plane = planeOf([], sessionFacts);
  const { seen, query } = queryOf(() => []);
  await run({ request: plane.request, query, ...services });
  return seen.options.env;
}

test("a session its facts mark shellCredentialHanded hands its shell the API's origin and its own bearer", async () => {
  const env = await environmentOf({ ...thread, shellCredentialHanded: true });

  assert.equal(env[sessionApiOriginVariable], task.api.url);
  assert.equal(env[sessionBearerVariable], bearer);
});

test("a session told nothing hands its shell neither, and the fact changes nothing else of its environment", async () => {
  const handed = await environmentOf({
    ...thread,
    shellCredentialHanded: true,
  });
  const told = await environmentOf(thread);

  assert.ok(!(sessionApiOriginVariable in told));
  assert.ok(!(sessionBearerVariable in told));
  const handedOnly = [sessionApiOriginVariable, sessionBearerVariable];
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(handed).filter(([name]) => !handedOnly.includes(name)),
    ),
    told,
  );
});

test("a session told nothing hands its shell neither even where the pod inherited them", async () => {
  const told = await environmentOf(thread, {
    environment: {
      ...environment,
      [sessionApiOriginVariable]: "http://elsewhere.test",
      [sessionBearerVariable]: "chgs_inherited",
    },
  });

  assert.ok(!(sessionApiOriginVariable in told));
  assert.ok(!(sessionBearerVariable in told));
});
