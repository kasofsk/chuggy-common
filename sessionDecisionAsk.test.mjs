/**
 * A lead's observation turn that ends with no decision, asked once more for one
 * in the same turn, and every turn that is not asked.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";

import { sessionDecisionAsk } from "./session.mjs";
import {
  facts,
  leadRoster,
  planeOf,
  queryOf,
  rejection,
  result,
  run,
  threadRoster,
} from "./sessionHarness.fixture.mjs";

const leadFacts = { ...facts, capabilities: [...leadRoster] };

const observationTurn = {
  turn: "turn-1",
  ordinal: 1,
  inputKind: "Observation",
  input: JSON.stringify({
    version: 1,
    candidates: [{ ticket: 4, ticketVersion: 2 }],
    handoffNote: { carried: "note" },
    refusals: [],
  }),
};

const init = {
  type: "system",
  subtype: "init",
  session_id: "runtime-1",
  model: "haiku",
};

const spentAfter = (inputTokens) => ({
  haiku: {
    inputTokens,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
});

/** Calls one of the session's chuggy tools as the model would. */
async function called(options, name, args) {
  await options.mcpServers.chuggy.tools
    .find((tool) => tool.name === name)
    .handler(args);
}

/** The session run over one turn, with what the runtime was handed and what the plane was told. */
async function ran(turn, sessionFacts, script) {
  const plane = planeOf([turn], sessionFacts);
  const asked = [];
  const { query } = queryOf((message, index, options) => {
    asked.push(message.message.content);
    return script(index, options);
  });
  await run({ request: plane.request, query });
  const posted = (path) =>
    plane.calls.filter((call) => call.path === path).map(({ body }) => body);
  return {
    asked,
    answers: posted(sessionPlaneRoutes.turnAnswer.path),
    failures: posted(sessionPlaneRoutes.turnFailure.path),
  };
}

test("an observation answered in prose is asked once, and settles one turn on the dispatch it then stages", async () => {
  const { asked, answers, failures } = await ran(
    observationTurn,
    leadFacts,
    (index, options) =>
      index === 0
        ? [
            init,
            result("success", {
              result: "I would dispatch ticket 4.",
              modelUsage: spentAfter(1_000),
              total_cost_usd: 0.03,
              duration_ms: 5_000,
            }),
          ]
        : [
            async () =>
              called(options, "dispatch", {
                ticket: 4,
                expectedTicketVersion: 2,
              }),
            result("success", {
              result: "done",
              modelUsage: spentAfter(1_200),
              total_cost_usd: 0.04,
              duration_ms: 700,
            }),
          ],
  );

  assert.deepEqual(asked, [observationTurn.input, sessionDecisionAsk]);
  assert.deepEqual(failures, []);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].turn, "turn-1");
  assert.deepEqual(JSON.parse(answers[0].result).dispatches, [
    { ticket: 4, expectedTicketVersion: 2 },
  ]);
  assert.deepEqual(
    {
      tokens: answers[0].measured.tokens,
      costMicros: answers[0].measured.costMicros,
      durationMs: answers[0].measured.durationMs,
    },
    { tokens: 1_200, costMicros: 40_000, durationMs: 5_700 },
  );
});

test("an observation answered in prose twice is asked exactly once and settles on its prose", async () => {
  const { asked, answers } = await ran(observationTurn, leadFacts, (index) => [
    init,
    result("success", { result: `prose ${String(index)}` }),
  ]);

  assert.deepEqual(asked, [observationTurn.input, sessionDecisionAsk]);
  assert.deepEqual(
    answers.map(({ turn, result: text }) => ({ turn, text })),
    [{ turn: "turn-1", text: "prose 1" }],
  );
});

test("a turn that staged a refusal on its first result is never asked", async () => {
  const { asked, answers } = await ran(
    observationTurn,
    leadFacts,
    (_index, options) => [
      async () =>
        called(options, "refuse", {
          ticket: 4,
          ticketVersion: 2,
          reason: "blocked on review",
        }),
      result("success", { result: "refused" }),
    ],
  );

  assert.deepEqual(asked, [observationTurn.input]);
  assert.equal(JSON.parse(answers[0].result).refusals.length, 1);
});

test("a spent budget or a rate limit is never asked", async () => {
  const cases = {
    budget: [result("error_max_budget_usd")],
    rateLimited: [rejection, result("success", { result: "prose" })],
  };
  for (const [name, messages] of Object.entries(cases)) {
    const { asked, answers } = await ran(
      observationTurn,
      leadFacts,
      () => messages,
    );

    assert.deepEqual(asked, [observationTurn.input], name);
    assert.deepEqual(answers, [], name);
  }
});

test("a thread's turn that ends in prose is never asked", async () => {
  const { asked, answers } = await ran(
    { ...observationTurn, inputKind: "UserMessage", input: "hello" },
    { ...facts, kind: "Thread", capabilities: [...threadRoster] },
    () => [result("success", { result: "hi" })],
  );

  assert.deepEqual(asked, ["hello"]);
  assert.equal(answers[0].result, "hi");
});

test("a result whose text is a JSON decision is never asked", async () => {
  const decision = JSON.stringify({
    version: 1,
    dispatches: [{ ticket: 4, expectedTicketVersion: 2 }],
    attention: "Monitoring",
    handoffNote: null,
  });
  const { asked, answers } = await ran(observationTurn, leadFacts, () => [
    result("success", { result: decision }),
  ]);

  assert.deepEqual(asked, [observationTurn.input]);
  assert.equal(answers[0].result, decision);
});

test("a turn that saw a mirror_error is never asked, and fails StoreRefused", async () => {
  const mirrorError = {
    type: "system",
    subtype: "mirror_error",
    error: "gave up on batch 3",
  };
  const prose = result("success", { result: "prose" });
  const cases = {
    before: [init, mirrorError, prose],
    after: [init, prose, mirrorError],
  };
  for (const [name, messages] of Object.entries(cases)) {
    const { asked, answers, failures } = await ran(
      observationTurn,
      leadFacts,
      () => messages,
    );

    assert.deepEqual(asked, [observationTurn.input], name);
    assert.deepEqual(answers, [], name);
    assert.deepEqual(
      failures,
      [{ turn: "turn-1", failure: "StoreRefused" }],
      name,
    );
  }
});
