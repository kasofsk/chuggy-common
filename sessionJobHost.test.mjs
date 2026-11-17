import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";
import { chuggyToolPrefix } from "@chuggy/worker-contract/sessionTools";
import { workerWorkspaceVariable } from "@chuggy/worker-contract/workerEnvironment";

import { jobHostPlaces, jobHostToolNames } from "./jobHost.mjs";
import {
  environment,
  facts,
  planeOf,
  queryOf,
  result,
  run,
  threadRoster,
  turnOne,
} from "./sessionHarness.fixture.mjs";

const threadFacts = { ...facts, kind: "Thread", capabilities: threadRoster };
const jobTools = Object.values(jobHostToolNames);
const wakePath = sessionPlaneRoutes.wake.path;
const standingPath = sessionPlaneRoutes.standing.path;

/** A thread's directory of its own, holding `state` as its job host's where given. */
async function threadDirectory(t, state) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-session-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (state !== undefined) {
    const { root, state: path } = jobHostPlaces(directory);
    await mkdir(root);
    await writeFile(path, JSON.stringify(state));
  }
  return directory;
}

/** A plane whose wake route wakes the thread, and every body posted to it, in order. */
function wakingPlane(turns, sessionFacts) {
  const plane = planeOf(turns, sessionFacts, (path) =>
    path === wakePath
      ? { status: 200, body: { woken: "Woken", ordinal: 2 } }
      : undefined,
  );
  const posted = [];
  const request = async (task, bearer, path, init, transport) => {
    if (path === standingPath || path === wakePath)
      posted.push({ path, body: JSON.parse(init.body) });
    return plane.request(task, bearer, path, init, transport);
  };
  return { ...plane, request, posted };
}

/** Every body posted to `path`, in order. */
function postedTo(plane, path) {
  return plane.posted
    .filter((posted) => posted.path === path)
    .map(({ body }) => body);
}

/** One session over `plane` in `directory`, answering every turn, and what its runtime was opened with. */
async function jobRun(plane, directory, services = {}) {
  const { query, seen } = queryOf(() => [
    { type: "system", subtype: "init", session_id: "runtime-1" },
    result("success", { result: "ok" }),
  ]);
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query,
    environment: { ...environment, [workerWorkspaceVariable]: directory },
    ...services,
  });
  return { code, options: seen.options };
}

test("a chat host's thread with a shell is served and allowed the job host's tools, and no other thread is", async (t) => {
  const directory = await threadDirectory(t);
  for (const [named, sessionFacts, chatHost, held] of [
    ["a chat host's thread", threadFacts, true, true],
    ["a thread on no chat host", threadFacts, false, false],
    [
      "a chat host's thread with no shell",
      {
        ...threadFacts,
        capabilities: threadRoster.filter((held) => held !== "RunCommands"),
      },
      true,
      false,
    ],
  ]) {
    const { options } = await jobRun(
      wakingPlane([turnOne], sessionFacts),
      directory,
      chatHost ? { chatHost } : {},
    );

    const served = options.mcpServers.chuggy.tools.map(({ name }) => name);
    for (const tool of jobTools) {
      assert.equal(served.includes(tool), held, `${named}: ${tool} served`);
      assert.equal(
        options.allowedTools.includes(`${chuggyToolPrefix}${tool}`),
        held,
        `${named}: ${tool} allowed`,
      );
    }
  }
});

test("a chat host's thread restores its job host before it claims a turn, posting the wake of a timer that fell due and its standing", async (t) => {
  const directory = await threadDirectory(t, {
    jobs: [],
    watches: [],
    timers: [{ reason: "check the deploy", dueAtMs: 0 }],
  });
  const plane = wakingPlane([turnOne], threadFacts);

  const { code } = await jobRun(plane, directory, { chatHost: true });

  assert.equal(code, 0);
  assert.deepEqual(postedTo(plane, standingPath), [{ standing: false }]);
  assert.deepEqual(
    postedTo(plane, wakePath).map(({ wake, resource }) => [wake, resource]),
    [["TimerDue", "check the deploy"]],
  );
  const paths = plane.calls.map(({ path }) => path);
  assert.ok(
    paths.indexOf(wakePath) < paths.indexOf(sessionPlaneRoutes.turn.path),
  );
  assert.deepEqual(
    JSON.parse(await readFile(jobHostPlaces(directory).state, "utf8")).timers,
    [],
  );
});

test("a chat host's thread whose job host holds a restart job reports it standing, and its idle bound waits while the job runs", async (t) => {
  const directory = await threadDirectory(t, {
    jobs: [
      {
        name: "dispatcher",
        command: "sleep 600",
        cwd: ".",
        restart: true,
        status: "Running",
      },
    ],
    watches: [],
    timers: [],
  });
  const plane = wakingPlane([turnOne], threadFacts);
  const stop = new globalThis.AbortController();
  let empties = 0;
  const request = async (task, bearer, path, init, transport) => {
    const answer = await plane.request(task, bearer, path, init, transport);
    if (path === sessionPlaneRoutes.turn.path && answer.status === 204) {
      empties += 1;
      if (empties === 3) stop.abort();
    }
    return answer;
  };

  const { code } = await jobRun({ ...plane, request }, directory, {
    chatHost: true,
    stopped: stop.signal,
  });

  assert.equal(code, 0);
  assert.equal(
    empties,
    3,
    "the mailbox ended on its idle bound while the job ran",
  );
  assert.deepEqual(postedTo(plane, standingPath), [{ standing: true }]);
  assert.deepEqual(
    postedTo(plane, wakePath).map(({ wake, resource }) => [wake, resource]),
    [],
    "a restore that only started a job again wakes nobody",
  );
  const [job] = JSON.parse(
    await readFile(jobHostPlaces(directory).state, "utf8"),
  ).jobs;
  assert.equal(
    job.status,
    "Running",
    "the attempt's end left it to the next restore",
  );
});

test("a chat host's thread whose plane refuses its wake NotConfigured keeps that refusal as the timer's last wake for its next attempt", async (t) => {
  const directory = await threadDirectory(t, {
    jobs: [],
    watches: [],
    timers: [{ reason: "check the deploy", dueAtMs: 0 }],
  });
  const plane = planeOf([turnOne], threadFacts, (path) =>
    path === wakePath
      ? { status: 404, body: { action: "stop", reason: "NotConfigured" } }
      : undefined,
  );

  const { code } = await jobRun(plane, directory, { chatHost: true });

  assert.equal(code, 0);
  const { wakes } = JSON.parse(
    await readFile(jobHostPlaces(directory).state, "utf8"),
  );
  assert.deepEqual(
    wakes.map(({ wake, resource, outcome, refusal }) => ({
      wake,
      resource,
      outcome,
      refusal,
    })),
    [
      {
        wake: "TimerDue",
        resource: "check the deploy",
        outcome: "Refused",
        refusal: "NotConfigured",
      },
    ],
  );
});
