/**
 * The readings of its context window a session's turn answers with: what the
 * runtime said its window held as the turn ended, and each compaction the
 * turn's stream marked, offered only to a plane that takes them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import {
  runContextItemsMax,
  runContextPathCharsMax,
} from "@chuggy/worker-contract/workerPlane";
import { workerContractHeader } from "@chuggy/worker-contract/workerContract";

import { contextUsage } from "./contextUsage.fixture.mjs";
import { sessionContextUsageWaitMs } from "./session.mjs";
import {
  facts,
  planeOf,
  queryOf,
  result,
  run,
  turnOne,
} from "./sessionHarness.fixture.mjs";

const answerOf = (plane) =>
  plane.calls.find(({ path }) => path === "/v1/session/turn/answer").body;

const initialized = {
  type: "system",
  subtype: "init",
  session_id: "runtime-1",
  model: "haiku",
};

const compactBoundary = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: {
    trigger: "manual",
    pre_tokens: 40_000,
    post_tokens: 3_000,
  },
};

/** A runtime scripted by `script` whose query answers `getContextUsage` as `usage` does, and records each ask. */
function usageQueryOf(script, usage) {
  const asked = [];
  const built = queryOf(script);
  return {
    asked,
    query: (options) =>
      Object.assign(built.query(options), {
        getContextUsage: (detail) => {
          asked.push(detail);
          return usage(detail);
        },
      }),
  };
}

/** A plane's request whose every answer names `release` instead of this pod's. */
function answeringUnder(request, release) {
  return async (...asked) => {
    const answer = await request(...asked);
    const headers = new globalThis.Headers(answer.headers);
    headers.set(workerContractHeader, release);
    return new globalThis.Response(answer.body, {
      status: answer.status,
      headers,
    });
  };
}

const answered = () => [initialized, result("success", { result: "ok" })];

test("an answered turn carries the window the runtime said it ended with, asked at summary detail", async () => {
  const plane = planeOf([turnOne], facts);
  const { query, asked } = usageQueryOf(answered, async () => contextUsage);

  assert.equal(await run({ request: plane.request, query }), 0);

  const { readings, result: text } = answerOf(plane);
  assert.equal(text, "ok");
  assert.deepEqual(asked, [{ detail: "summary" }]);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].cause, "End");
  assert.equal(readings[0].window.totalTokens, contextUsage.totalTokens);
});

test("each compaction the turn's stream marked is a reading, ahead of the turn's end", async () => {
  const plane = planeOf([turnOne], facts);
  const { query } = usageQueryOf(
    () => [initialized, compactBoundary, result("success", { result: "ok" })],
    async () => contextUsage,
  );

  assert.equal(await run({ request: plane.request, query }), 0);

  assert.deepEqual(
    answerOf(plane).readings.map(({ cause, compaction }) => ({
      cause,
      compaction,
    })),
    [
      {
        cause: "Compaction",
        compaction: {
          trigger: "Manual",
          tokensBefore: 40_000,
          tokensAfter: 3_000,
        },
      },
      { cause: "End", compaction: undefined },
    ],
  );
});

test("a plane from before session readings is answered with none, and the runtime is not asked", async () => {
  const plane = planeOf([turnOne], facts);
  const { query, asked } = usageQueryOf(
    () => [initialized, compactBoundary, result("success", { result: "ok" })],
    async () => contextUsage,
  );

  assert.equal(
    await run({ request: answeringUnder(plane.request, "1.44.0"), query }),
    0,
  );

  const answer = answerOf(plane);
  assert.equal(answer.result, "ok");
  assert.equal(Object.hasOwn(answer, "readings"), false);
  assert.deepEqual(asked, []);
});

test("a runtime that fails to say what its window holds still answers the turn", async () => {
  const plane = planeOf([turnOne], facts);
  const { query } = usageQueryOf(answered, async () => {
    throw new Error("the control request failed");
  });

  assert.equal(await run({ request: plane.request, query }), 0);

  const answer = answerOf(plane);
  assert.equal(answer.result, "ok");
  assert.equal(Object.hasOwn(answer, "readings"), false);
});

test("a runtime that does not answer within the wait still answers the turn, keeping its compactions", async () => {
  const plane = planeOf([turnOne], facts);
  const { query } = usageQueryOf(
    () => [initialized, compactBoundary, result("success", { result: "ok" })],
    () => new Promise(() => undefined),
  );
  const pause = (milliseconds) =>
    milliseconds === sessionContextUsageWaitMs
      ? Promise.resolve()
      : wait(milliseconds, undefined, { ref: false });

  assert.equal(await run({ request: plane.request, query, pause }), 0);

  assert.deepEqual(
    answerOf(plane).readings.map(({ cause }) => cause),
    ["Compaction"],
  );
});

test("a breakdown longer than the contract holds is trimmed to it and sent", async () => {
  const plane = planeOf([turnOne], facts);
  const tools = Array.from({ length: runContextItemsMax + 1 }, (_, index) => ({
    name: `tool_${String(index)}`,
    serverName: "chuggy",
    tokens: 1,
  }));
  const { query } = usageQueryOf(answered, async () => ({
    ...contextUsage,
    mcpTools: tools,
  }));

  assert.equal(await run({ request: plane.request, query }), 0);

  assert.equal(
    answerOf(plane).readings[0].window.mcpTools.length,
    runContextItemsMax,
  );
});

test("a breakdown the contract refuses whatever is trimmed is left out, and the turn is still answered", async () => {
  const plane = planeOf([turnOne], facts);
  const { query } = usageQueryOf(answered, async () => ({
    ...contextUsage,
    memoryFiles: [{ path: "/".repeat(runContextPathCharsMax + 1), tokens: 1 }],
  }));

  assert.equal(await run({ request: plane.request, query }), 0);

  const answer = answerOf(plane);
  assert.equal(answer.result, "ok");
  assert.equal(Object.hasOwn(answer, "readings"), false);
});
