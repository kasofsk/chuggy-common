import assert from "node:assert/strict";
import test from "node:test";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";

import {
  facts,
  planeOf,
  queryOf,
  result,
  run,
  threadRoster,
  turnOne,
} from "./sessionHarness.fixture.mjs";

const threadFacts = { ...facts, kind: "Thread", capabilities: threadRoster };
const standingPath = sessionPlaneRoutes.standing.path;

/** One session over `plane`, answering every turn, and the lines it warned. */
async function standingRun(plane, chatHost) {
  const warned = [];
  const { query } = queryOf(() => [
    { type: "system", subtype: "init", session_id: "runtime-1" },
    result("success", { result: "ok" }),
  ]);
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query,
    warn: (text) => warned.push(text),
    ...(chatHost ? { chatHost } : {}),
  });
  return { code, warned };
}

function standingCalls(plane) {
  return plane.calls.filter(({ path }) => path === standingPath);
}

test("a chat host's thread reports it is not standing once, before it claims a turn", async () => {
  const plane = planeOf([turnOne, { ...turnOne, turn: "turn-2" }], threadFacts);

  const { code } = await standingRun(plane, true);

  assert.equal(code, 0);
  assert.deepEqual(
    standingCalls(plane).map(({ method, body }) => [method, body]),
    [["PUT", { standing: false }]],
  );
  const paths = plane.calls.map(({ path }) => path);
  assert.ok(
    paths.indexOf(standingPath) < paths.indexOf(sessionPlaneRoutes.turn.path),
  );
});

test("a session that is not a chat host's thread never reports standing", async () => {
  for (const [named, sessionFacts, chatHost] of [
    ["a thread on no chat host", threadFacts, false],
    ["a chat host's lead", facts, true],
    [
      "a chat host's inquiry",
      { ...facts, kind: "Inquiry", forkFrom: "runtime-0" },
      true,
    ],
  ]) {
    const plane = planeOf([turnOne], sessionFacts);

    await standingRun(plane, chatHost);

    assert.deepEqual(standingCalls(plane), [], named);
  }
});

test("a chat host's thread carries on past a standing the plane refuses to read or to hold for it", async () => {
  for (const refusal of [
    { status: 400, body: { action: "stop" } },
    { status: 409, body: { action: "stop", reason: "NotChatHostThread" } },
  ]) {
    const plane = planeOf([turnOne], threadFacts, (path) =>
      path === standingPath ? refusal : undefined,
    );

    const { code, warned } = await standingRun(plane, true);

    const named = `standing answered ${String(refusal.status)}`;
    assert.equal(code, 0, named);
    assert.equal(
      plane.calls.filter(
        ({ path }) => path === sessionPlaneRoutes.turnAnswer.path,
      ).length,
      1,
      named,
    );
    assert.ok(
      warned.some((line) => line.includes(standingPath)),
      `${named} was not warned of`,
    );
  }
});

test("a chat host's thread whose standing is fenced or unauthorized ends before it claims a turn", async () => {
  for (const refusal of [
    { status: 401, body: { action: "stop" } },
    { status: 409, body: { action: "stop", reason: "Fenced" } },
  ]) {
    const plane = planeOf([turnOne], threadFacts, (path) =>
      path === standingPath ? refusal : undefined,
    );

    const { code } = await standingRun(plane, true);

    const named = `standing answered ${String(refusal.status)}`;
    assert.equal(code, 1, named);
    assert.deepEqual(
      plane.calls.filter(({ path }) =>
        path.startsWith(sessionPlaneRoutes.turn.path),
      ),
      [],
      named,
    );
  }
});
