import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workerContractCredentialBundles,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";

import {
  heldCredentialRefreshBackoffMsMax,
  heldCredentialRefreshDelayMs,
  heldCredentialRefreshIntervalMsMin,
  heldCredentialRefreshLeadMs,
  heldCredentialRefreshRetriesMax,
  heldCredentialRefreshRetryDelayMs,
  keepHeldCredentialsFresh,
} from "./heldCredentialRefresh.mjs";
import { heldCredentials } from "./heldCredentials.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const directory = "/m";
const hourMs = 3_600_000;

/** The release just before the plane serves bundles, whose answers serve single secrets. */
const releaseBeforeBundles = `${String(workerContractCredentialBundles.major)}.${String(workerContractCredentialBundles.minor - 1)}.0`;

/** A single secret served for `track-record`, expiring at `expiresAtMs` where it is given. */
function trackRecord(secret, expiresAtMs) {
  return {
    credential: "track-record",
    variable: "TRACK_RECORD_TOKEN_FILE",
    secret,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

/** What `track-record`, served as a single secret, hands a job's shells. */
const trackRecordHeld = [
  {
    credential: "track-record",
    variable: "TRACK_RECORD_TOKEN_FILE",
    value: join(directory, "held-track-record"),
  },
];

/**
 * A plane answering the nth held-credentials ask with the nth of `answers`,
 * each a status and a body, under the release before bundles unless the
 * answer names its own.
 */
function refreshPlane(answers) {
  const plane = planeFetch(planes.job, (route, asked) => {
    assert.equal(route, "heldCredentials");
    const answer = answers[plane.asked.length - 1];
    assert.ok(answer !== undefined, `no answer for ask ${asked.path}`);
    return { release: releaseBeforeBundles, ...answer };
  });
  return {
    asked: plane.asked,
    request: overPlane(workerRequest, plane.fetch),
  };
}

/**
 * An injected clock and timers: `fire()` moves the clock to the earliest
 * timer, runs it, and waits for the ask it begins; `delays()` is each timer
 * set and not yet run or cleared.
 */
function pausedTimers(startMs = 0) {
  let nowMs = startMs;
  let made = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => {
      made += 1;
      timers.set(made, { callback, atMs: nowMs + delayMs, delayMs });
      return made;
    },
    clearTimeout: (handle) => timers.delete(handle),
    delays: () => [...timers.values()].map((each) => each.delayMs),
    fire: async () => {
      const [handle, timer] = [...timers].sort(
        ([, one], [, other]) => one.atMs - other.atMs,
      )[0];
      timers.delete(handle);
      nowMs = timer.atMs;
      await timer.callback();
    },
  };
}

/** A refresher over `plane` and `timers` for `expiring`, each write, keep and warning recorded in order. */
function refresher(expiring, plane, timers, seams = {}) {
  const order = [];
  const warned = [];
  const stop = keepHeldCredentialsFresh(
    expiring,
    {
      task,
      bearer: "capability",
      directory,
      keep: (secret) => order.push(["kept", secret]),
    },
    {
      request: plane.request,
      write: async (file, content) => order.push(["written", file, content]),
      makeDirectory: async (made) => order.push(["made", made]),
      warn: (text) => warned.push(text),
      ...timers,
      ...seams,
    },
  );
  return { order, warned, stop };
}

test("the first ask waits until the lead before expiry, and never less than the shortest interval", () => {
  assert.equal(
    heldCredentialRefreshDelayMs(hourMs, 0),
    hourMs - heldCredentialRefreshLeadMs,
  );
  assert.equal(
    heldCredentialRefreshDelayMs(heldCredentialRefreshLeadMs, 0),
    heldCredentialRefreshIntervalMsMin,
  );
  assert.equal(
    heldCredentialRefreshDelayMs(0, hourMs),
    heldCredentialRefreshIntervalMsMin,
  );
});

test("a failed refresh waits longer each time, up to a bound, and is not asked again past its expiry or its retries", () => {
  const delays = [];
  for (let failures = 1; ; failures += 1) {
    const delayMs = heldCredentialRefreshRetryDelayMs(
      failures,
      100 * hourMs,
      0,
    );
    if (delayMs === undefined) break;
    delays.push(delayMs);
  }
  assert.equal(delays.length, heldCredentialRefreshRetriesMax);
  assert.equal(delays[0], heldCredentialRefreshIntervalMsMin);
  for (const [at, delayMs] of delays.entries())
    assert.ok(delayMs >= (delays[at - 1] ?? 0));
  assert.equal(delays.at(-1), heldCredentialRefreshBackoffMsMax);
  assert.ok(
    delays.reduce((sum, delayMs) => sum + delayMs, 0) <
      heldCredentialRefreshLeadMs,
    "the retries run out before the expiry of a credential asked at its lead",
  );
  assert.equal(
    heldCredentialRefreshRetryDelayMs(1, heldCredentialRefreshIntervalMsMin, 0),
    undefined,
  );
});

test("only a credential served with an expiry is handed on to be refreshed", async () => {
  const expiring = [];
  const plane = refreshPlane([
    {
      status: 200,
      body: {
        credentials: [
          trackRecord("track-record-first", hourMs),
          {
            credential: "registry",
            variable: "REGISTRY_TOKEN_FILE",
            secret: "registry-secret",
          },
        ],
      },
    },
  ]);
  await heldCredentials({
    task,
    bearer: "capability",
    listed: ["track-record", "registry"],
    credentialFiles: {},
    directory,
    keep: () => undefined,
    request: plane.request,
    write: async () => undefined,
    expiring: (each) => expiring.push(each),
  });
  assert.deepEqual(expiring, [
    { credential: "track-record", expiresAtMs: hourMs, held: trackRecordHeld },
  ]);
  const timers = pausedTimers();
  const { stop } = refresher(expiring, refreshPlane([]), timers);
  assert.deepEqual(timers.delays(), [hourMs - heldCredentialRefreshLeadMs]);
  await stop();
});

test("a credential is asked for again ahead of its expiry, its new secret kept before its file is rewritten, and then again ahead of the new one", async () => {
  const plane = refreshPlane([
    { status: 200, body: { credentials: [trackRecord("second", 2 * hourMs)] } },
    { status: 200, body: { credentials: [trackRecord("third")] } },
  ]);
  const timers = pausedTimers();
  const { order, warned, stop } = refresher(
    [
      {
        credential: "track-record",
        expiresAtMs: hourMs,
        held: trackRecordHeld,
      },
    ],
    plane,
    timers,
  );
  await timers.fire();
  assert.deepEqual(plane.asked[0].body, { credentials: ["track-record"] });
  assert.deepEqual(order, [
    ["kept", "second"],
    ["written", join(directory, "held-track-record"), "second"],
  ]);
  assert.deepEqual(timers.delays(), [hourMs]);
  await timers.fire();
  assert.equal(order.at(-1)[2], "third");
  assert.deepEqual(timers.delays(), [], "one served with no expiry is done");
  assert.deepEqual(warned, []);
  await stop();
});

test("a refreshed file is replaced by a rename, at the path the job was handed", async () => {
  const minted = await mkdtemp(join(tmpdir(), "held-refresh-"));
  try {
    const plane = refreshPlane([
      { status: 200, body: { credentials: [trackRecord("first", hourMs)] } },
      { status: 200, body: { credentials: [trackRecord("second")] } },
    ]);
    const expiring = [];
    const [handed] = await heldCredentials({
      task,
      bearer: "capability",
      listed: ["track-record"],
      credentialFiles: {},
      directory: minted,
      keep: () => undefined,
      request: plane.request,
      expiring: (each) => expiring.push(each),
    });
    const timers = pausedTimers();
    const stop = keepHeldCredentialsFresh(
      expiring,
      { task, bearer: "capability", directory: minted, keep: () => undefined },
      { request: plane.request, ...timers },
    );
    await timers.fire();
    await stop();
    assert.equal(await readFile(handed.value, "utf8"), "second");
    assert.deepEqual(await readdir(minted), ["held-track-record"]);
  } finally {
    await rm(minted, { recursive: true, force: true });
  }
});

test("a bundle is rewritten into its own directory, its secrets kept first", async () => {
  const bundle = (secret, expiresAtMs) => ({
    credential: "cloud",
    files: [{ file: "key", content: { kind: "Secret", secret } }],
    variables: [{ kind: "Path", variable: "CLOUD_KEY_FILE", file: "key" }],
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  });
  const held = [
    {
      credential: "cloud",
      variable: "CLOUD_KEY_FILE",
      value: join(directory, "held-cloud", "key"),
    },
  ];
  const plane = refreshPlane([
    {
      status: 200,
      body: { credentials: [bundle("renewed")] },
      release: workerContractRelease,
    },
  ]);
  const timers = pausedTimers();
  const { order, stop } = refresher(
    [{ credential: "cloud", expiresAtMs: hourMs, held }],
    plane,
    timers,
  );
  await timers.fire();
  assert.deepEqual(order, [
    ["kept", "renewed"],
    ["made", join(directory, "held-cloud")],
    ["written", join(directory, "held-cloud", "key"), "renewed"],
  ]);
  await stop();
});

/**
 * The one line a refresh of `track-record` answered with `answer` warns,
 * where it writes nothing and leaves no timer, so it is not asked again.
 */
async function refreshStopped(answer) {
  const timers = pausedTimers();
  const { order, warned, stop } = refresher(
    [
      {
        credential: "track-record",
        expiresAtMs: hourMs,
        held: trackRecordHeld,
      },
    ],
    refreshPlane([answer]),
    timers,
  );
  await timers.fire();
  await stop();
  assert.deepEqual(order, []);
  assert.deepEqual(timers.delays(), []);
  assert.equal(warned.length, 1);
  return warned[0];
}

test("a refresh handing a variable another value than the job was started with writes nothing and is not asked again", async () => {
  const warned = await refreshStopped({
    status: 200,
    body: {
      credentials: [
        { ...trackRecord("second", 2 * hourMs), variable: "OTHER_FILE" },
      ],
    },
  });
  assert.match(warned, /track-record/u);
});

test("a refresh answered with an absence is logged once with its reason and not asked again, and ends nothing", async () => {
  const warned = await refreshStopped({
    status: 200,
    body: {
      credentials: [],
      absent: [{ credential: "track-record", reason: "IssuerRefused" }],
    },
    release: workerContractRelease,
  });
  assert.match(warned, /track-record.*IssuerRefused/u);
});

test("a refresh that keeps failing is retried with a growing pause until its expiry, then logged once with what the plane answered", async () => {
  const expiresAtMs = heldCredentialRefreshLeadMs;
  const plane = refreshPlane(
    Array.from({ length: heldCredentialRefreshRetriesMax + 1 }, () => ({
      status: 409,
    })),
  );
  const timers = pausedTimers();
  const { order, warned, stop } = refresher(
    [{ credential: "track-record", expiresAtMs, held: trackRecordHeld }],
    plane,
    timers,
  );
  const pauses = [];
  while (timers.delays().length > 0) {
    pauses.push(timers.delays()[0]);
    await timers.fire();
  }
  assert.ok(timers.now() < expiresAtMs, "no ask falls after the expiry");
  assert.equal(plane.asked.length, pauses.length);
  assert.ok(plane.asked.length > 2);
  assert.ok(plane.asked.length <= heldCredentialRefreshRetriesMax + 1);
  assert.ok(pauses[2] > pauses[1]);
  assert.deepEqual(order, []);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /track-record.*409/u);
  await stop();
});

test("a refresh that keeps failing ahead of a long expiry is retried no more than the bound", async () => {
  const plane = refreshPlane(
    Array.from({ length: heldCredentialRefreshRetriesMax + 1 }, () => ({
      status: 409,
    })),
  );
  const timers = pausedTimers();
  const { warned, stop } = refresher(
    [
      {
        credential: "track-record",
        expiresAtMs: 100 * hourMs,
        held: trackRecordHeld,
      },
    ],
    plane,
    timers,
  );
  while (timers.delays().length > 0) await timers.fire();
  assert.equal(plane.asked.length, heldCredentialRefreshRetriesMax + 1);
  assert.equal(warned.length, 1);
  await stop();
});

test("a refresh that fails once and then succeeds is written and logs nothing", async () => {
  const plane = refreshPlane([
    { status: 409 },
    { status: 200, body: { credentials: [trackRecord("second")] } },
  ]);
  const timers = pausedTimers();
  const { order, warned, stop } = refresher(
    [
      {
        credential: "track-record",
        expiresAtMs: hourMs,
        held: trackRecordHeld,
      },
    ],
    plane,
    timers,
  );
  await timers.fire();
  assert.deepEqual(timers.delays(), [heldCredentialRefreshIntervalMsMin]);
  await timers.fire();
  assert.equal(order.at(-1)[2], "second");
  assert.deepEqual(warned, []);
  await stop();
});

test("stopping clears every timer, waits for an ask in flight, and writes nothing it answers", async () => {
  let answer;
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  let asked;
  const askedSignal = new Promise((resolve) => {
    asked = resolve;
  });
  const plane = planeFetch(planes.job, async () => {
    asked();
    await answered;
    return {
      status: 200,
      body: { credentials: [trackRecord("late", 2 * hourMs)] },
      release: releaseBeforeBundles,
    };
  });
  const timers = pausedTimers();
  const { order, warned, stop } = refresher(
    [
      {
        credential: "track-record",
        expiresAtMs: hourMs,
        held: trackRecordHeld,
      },
      {
        credential: "registry",
        expiresAtMs: 2 * hourMs,
        held: [
          {
            credential: "registry",
            variable: "REGISTRY_TOKEN_FILE",
            value: join(directory, "held-registry"),
          },
        ],
      },
    ],
    { request: overPlane(workerRequest, plane.fetch) },
    timers,
  );
  const firing = timers.fire();
  await askedSignal;
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  assert.deepEqual(timers.delays(), [], "no timer outlives the stop");
  await Promise.resolve();
  assert.equal(stopped, false, "the stop waits for the ask in flight");
  answer();
  await stopping;
  await firing;
  assert.deepEqual(order, []);
  assert.deepEqual(warned, []);
  assert.deepEqual(timers.delays(), []);
});
