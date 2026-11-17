import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  sessionApiOriginVariable,
  sessionBearerVariable,
  sessionProjectVariable,
  sessionTenantVariable,
} from "@chuggy/worker-contract/workerEnvironment";

import { chuggyCommandExits } from "./chuggyCommand.mjs";

const command = fileURLToPath(new URL("./chuggyCommand.mjs", import.meta.url));
const bearer = "chgs_shell";

/** A fake API answering every request with `answer`, recording each it was sent. */
async function fakeApi(answer) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      const { status, json } = answer(request);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    seen,
    origin: `http://127.0.0.1:${String(server.address().port)}`,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

function variablesOf(api) {
  return {
    [sessionApiOriginVariable]: api.origin,
    [sessionBearerVariable]: bearer,
    [sessionTenantVariable]: "shell-tenant",
    [sessionProjectVariable]: "shell-project",
  };
}

/** The command run as a shell runs it, on `variables` alone of the session's. */
async function ran(argv, variables) {
  const child = spawn(process.execPath, [command, ...argv], {
    env: { PATH: process.env.PATH, ...variables },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const [exit] = await once(child, "close");
  return { exit, out, err };
}

test("the command answers a tool from the session its four variables name", async (t) => {
  const api = await fakeApi(() => ({ status: 200, json: { ticket: 7 } }));
  t.after(api.close);

  const answer = await ran(["read_ticket", '{"ticket":7}'], variablesOf(api));

  assert.equal(answer.exit, chuggyCommandExits.answered, answer.err);
  assert.equal(answer.out, 'HTTP 200\n{"ticket":7}\n');
  assert.equal(api.seen.length, 1);
  assert.equal(
    api.seen[0].url,
    "/api/v1/tenants/shell-tenant/projects/shell-project/tickets/7",
  );
  assert.equal(api.seen[0].headers.authorization, `Bearer ${bearer}`);
});

test("the command exits non-zero on the API's refusal and prints it", async (t) => {
  const api = await fakeApi(() => ({
    status: 403,
    json: { error: { code: "Forbidden" } },
  }));
  t.after(api.close);

  const answer = await ran(["read_ticket", '{"ticket":7}'], variablesOf(api));

  assert.equal(answer.exit, chuggyCommandExits.refused);
  assert.match(answer.out, /^HTTP 403\n/u);
});

test("the command exits non-zero on a call that fails to reach the API", async () => {
  const api = await fakeApi(() => ({ status: 200, json: {} }));
  await api.close();

  const answer = await ran(["revoke_ticket", '{"ticket":7}'], variablesOf(api));

  assert.equal(answer.exit, chuggyCommandExits.refused);
  assert.equal(api.seen.length, 0);
});

test("the command exits non-zero on input the tool's schema refuses, and asks nothing", async (t) => {
  const api = await fakeApi(() => ({ status: 200, json: {} }));
  t.after(api.close);

  const answer = await ran(
    ["read_ticket", '{"ticket":"seven"}'],
    variablesOf(api),
  );

  assert.equal(answer.exit, chuggyCommandExits.refused);
  assert.equal(api.seen.length, 0);
});

test("each submitted command is an operation of its own turn", async (t) => {
  const api = await fakeApi(() => ({
    status: 202,
    json: { state: "Pending" },
  }));
  t.after(api.close);

  for (let call = 0; call < 2; call += 1) {
    const answer = await ran(
      ["revoke_ticket", '{"ticket":7}'],
      variablesOf(api),
    );
    assert.equal(answer.exit, chuggyCommandExits.answered, answer.err);
  }

  const [first, second] = api.seen.map((sent) => JSON.parse(sent.body));
  assert.deepEqual(first.mutation, { mutation: "RevokeTicket", ticket: 7 });
  assert.match(first.operation, /^session-/u);
  assert.notEqual(first.operation, second.operation);
  assert.equal(api.seen[0].headers["idempotency-key"], first.operation);
});

for (const variable of [
  sessionApiOriginVariable,
  sessionBearerVariable,
  sessionTenantVariable,
  sessionProjectVariable,
])
  test(`the command is a usage error saying why the shell holds no credential where ${variable} is unset, and asks nothing`, async (t) => {
    const api = await fakeApi(() => ({ status: 200, json: {} }));
    t.after(api.close);
    const variables = variablesOf(api);
    delete variables[variable];

    const answer = await ran(["read_ticket", '{"ticket":7}'], variables);

    assert.equal(answer.exit, chuggyCommandExits.misused);
    assert.match(
      answer.err,
      new RegExp(
        `^chuggy: ${variable} unset: this shell was handed no credential, and a thread's shell is handed one only where its chat host's settings name sessionCapabilities$`,
        "mu",
      ),
    );
    assert.equal(answer.out, "");
    assert.equal(api.seen.length, 0);
  });

for (const [what, argv] of [
  ["the tool is unknown", ["no_such_tool", "{}"]],
  [
    "the tool is an owner's offer",
    ["offer_release", '{"ticket":7,"authoringVersion":1}'],
  ],
  ["the tool is a navigation offer", ["navigate", "{}"]],
  ["the tool is a revoked offer", ["offer_revoke", "{}"]],
  ["the input does not parse", ["read_ticket", "{ticket:7"]],
  ["no tool is named", []],
])
  test(`the command is a usage error where ${what}, and asks nothing`, async (t) => {
    const api = await fakeApi(() => ({ status: 200, json: {} }));
    t.after(api.close);

    const answer = await ran(argv, variablesOf(api));

    assert.equal(answer.exit, chuggyCommandExits.misused);
    assert.match(answer.err, /^chuggy: /u);
    assert.equal(api.seen.length, 0);
  });
