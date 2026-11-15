import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionApiOriginVariable,
  sessionBearerVariable,
  sessionProjectVariable,
  sessionTenantVariable,
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

const handedOnly = [
  sessionApiOriginVariable,
  sessionBearerVariable,
  sessionTenantVariable,
  sessionProjectVariable,
];

async function environmentOf(sessionFacts, services = {}) {
  const plane = planeOf([], sessionFacts);
  const { seen, query } = queryOf(() => []);
  await run({ request: plane.request, query, ...services });
  return seen.options.env;
}

test("a session its facts mark shellCredentialHanded hands its shell the API's origin, its own bearer and its facts' tenant and project", async () => {
  const env = await environmentOf({
    ...thread,
    tenant: "shell-tenant",
    project: "shell-project",
    shellCredentialHanded: true,
  });

  assert.equal(env[sessionApiOriginVariable], task.api.url);
  assert.equal(env[sessionBearerVariable], bearer);
  assert.equal(env[sessionTenantVariable], "shell-tenant");
  assert.equal(env[sessionProjectVariable], "shell-project");
});

test("a session told nothing hands its shell none of them, and the fact changes nothing else of its environment", async () => {
  const handed = await environmentOf({
    ...thread,
    shellCredentialHanded: true,
  });
  const told = await environmentOf(thread);

  for (const name of handedOnly) assert.ok(!(name in told), name);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(handed).filter(([name]) => !handedOnly.includes(name)),
    ),
    told,
  );
});

test("a session told nothing hands its shell none of them even where the pod inherited them", async () => {
  const told = await environmentOf(thread, {
    environment: {
      ...environment,
      [sessionApiOriginVariable]: "http://elsewhere.test",
      [sessionBearerVariable]: "chgs_inherited",
      [sessionTenantVariable]: "inherited-tenant",
      [sessionProjectVariable]: "inherited-project",
    },
  });

  for (const name of handedOnly) assert.ok(!(name in told), name);
});

test("a session handed its shell credential hands its facts' tenant and project over what the pod inherited", async () => {
  const handed = await environmentOf(
    { ...thread, shellCredentialHanded: true },
    {
      environment: {
        ...environment,
        [sessionTenantVariable]: "inherited-tenant",
        [sessionProjectVariable]: "inherited-project",
      },
    },
  );

  assert.equal(handed[sessionTenantVariable], thread.tenant);
  assert.equal(handed[sessionProjectVariable], thread.project);
});
