import assert from "node:assert/strict";
import test from "node:test";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";
import { chuggyToolPrefix } from "@chuggy/worker-contract/sessionTools";
import {
  workerContractFeaturesHeader,
  workerContractFeaturesText,
} from "@chuggy/worker-contract/workerContract";

import {
  facts,
  planeOf,
  queryOf,
  result,
  run,
  threadRoster,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import { workerFeaturesImplemented } from "./transport.mjs";

const factsPath = sessionPlaneRoutes.facts.path;
const ticketWakesPath = sessionPlaneRoutes.ticketWakes.path;
const threadFacts = {
  ...facts,
  kind: "Thread",
  capabilities: threadRoster,
  ticketWakes: { host: "On", effective: "On" },
};
const listing = [...workerFeaturesImplemented];
const unlisting = workerFeaturesImplemented.filter(
  (feature) => feature !== "ThreadTicketWakes",
);

/**
 * A plane listing `features` on every answer, whose ticket wakes route
 * answers as `chosen` says, and every body put to that route, in order.
 */
function wakesPlane(sessionFacts, features, chosen) {
  const plane = planeOf([turnOne], sessionFacts, (path) =>
    path === ticketWakesPath ? chosen : undefined,
  );
  const put = [];
  const request = async (task, bearer, path, init, transport) => {
    if (path === ticketWakesPath) put.push(JSON.parse(init.body));
    const answer = await plane.request(task, bearer, path, init, transport);
    answer.headers.set(
      workerContractFeaturesHeader,
      workerContractFeaturesText(features),
    );
    return answer;
  };
  return { ...plane, request, put };
}

/** One session over `plane`, answering every turn, and what its runtime was opened with. */
async function wakesRun(plane, services = {}) {
  const { query, seen } = queryOf(() => [
    { type: "system", subtype: "init", session_id: "runtime-1" },
    result("success", { result: "ok" }),
  ]);
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query,
    ...services,
  });
  return { code, options: seen.options };
}

/** The session's `ticket_wakes`, as its server registered it. */
function ticketWakesOf(options) {
  return options.mcpServers.chuggy.tools.find(
    ({ name }) => name === "ticket_wakes",
  );
}

test("every thread is served and allowed ticket_wakes by a plane listing ThreadTicketWakes, whatever runs it and whatever it holds, and no other session is", async () => {
  for (const [named, sessionFacts, features, services, held] of [
    ["a chat host's thread", threadFacts, listing, { chatHost: true }, true],
    ["a pod's thread", threadFacts, listing, {}, true],
    [
      "a thread holding no capability",
      { ...threadFacts, capabilities: [] },
      listing,
      { chatHost: true },
      true,
    ],
    ["a thread on a plane not listing it", threadFacts, unlisting, {}, false],
    ["a lead", facts, listing, {}, false],
  ]) {
    const { code, options } = await wakesRun(
      wakesPlane(sessionFacts, features),
      services,
    );

    assert.equal(code, 0, named);
    assert.equal(ticketWakesOf(options) !== undefined, held, named);
    assert.equal(
      options.allowedTools.includes(`${chuggyToolPrefix}ticket_wakes`),
      held,
      named,
    );
  }
});

test("ticket_wakes with no choice answers the thread's wakes as its facts carry them, read again, and puts nothing", async () => {
  const plane = wakesPlane(threadFacts, listing);
  const { options } = await wakesRun(plane);
  const reads = plane.calls.filter(({ path }) => path === factsPath).length;

  const answer = await ticketWakesOf(options).handler({});

  assert.equal(answer.isError, undefined);
  assert.deepEqual(JSON.parse(answer.content[0].text), threadFacts.ticketWakes);
  assert.equal(
    plane.calls.filter(({ path }) => path === factsPath).length,
    reads + 1,
  );
  assert.deepEqual(plane.put, []);
});

test("ticket_wakes puts On and Off as the thread's own choice and Host as none, and answers what the plane answers", async () => {
  for (const [choice, thread] of [
    ["On", "On"],
    ["Off", "Off"],
    ["Host", null],
  ]) {
    const answered = {
      ...(thread === null ? {} : { thread }),
      host: "On",
      effective: thread ?? "On",
    };
    const plane = wakesPlane(threadFacts, listing, {
      status: 200,
      body: answered,
    });
    const { options } = await wakesRun(plane);

    const answer = await ticketWakesOf(options).handler({ choice });

    assert.equal(answer.isError, undefined, choice);
    assert.deepEqual(JSON.parse(answer.content[0].text), answered, choice);
    assert.deepEqual(plane.put, [{ thread }], choice);
  }
});

test("ticket_wakes answers the plane's refusal of a choice as its reason, and refuses one the contract cannot carry before asking", async () => {
  for (const reason of ["Fenced", "NotThread"]) {
    const plane = wakesPlane(threadFacts, listing, {
      status: 409,
      body: { action: "stop", reason },
    });
    const { options } = await wakesRun(plane);
    const tool = ticketWakesOf(options);

    const refused = await tool.handler({ choice: "Off" });

    assert.equal(refused.isError, true, reason);
    assert.equal(
      refused.content[0].text,
      `the worker plane refused the choice: ${reason}`,
    );

    const unread = await tool.handler({ choice: "off" });

    assert.equal(unread.isError, true);
    assert.equal(plane.put.length, 1, reason);
  }
});
