import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  workerContractFeaturesHeader,
  workerContractFeaturesOf,
  workerContractHeader,
  workerContractRelease,
  workerContractSessionCapabilitiesNamed,
} from "@chuggy/worker-contract/workerContract";
import { threadTicketWakeSettings } from "@chuggy/worker-contract/sessionPlane";
import {
  workerPoolCapabilitiesMax,
  workerPoolPollSessionCapabilitiesText,
  workerRunnerPollWaitHeader,
  workerRunnerCapabilitiesHeader,
  workerRunnerCapabilitiesOf,
  workerRunnerHeader,
  workerRunnerMemoryCeilingHeader,
  workerRunnerCountOf,
  workerRunnerCredentialsHeader,
  workerRunnerCredentialsOf,
  workerRunnerCredentialsPerAgentMax,
  workerRunnerMemoryRoomHeader,
  workerRunnerOf,
} from "@chuggy/worker-contract/workerPool";

import { planeHeaders, planeNamed, planesDeciding } from "./peer.fixture.mjs";
import {
  checkedPoolPlaneClientSettings,
  poolPlaneAnswerBytesMax,
  poolPlaneClient,
} from "./poolPlane.mjs";
import { workerFeaturesImplemented } from "./transport.mjs";

const planeSettings = {
  baseUrl: "https://pool-plane.invalid",
  pollTimeoutMs: 1_000,
  settleTimeoutMs: 1_000,
};

const assignment = {
  assignment: "assignment-one",
  capabilities: ["linux-containers"],
  cpuMillis: 500,
  memoryMib: 512,
  deadlineSecs: 60,
  callbackUrl: "https://worker-plane.invalid/v1/ticket-execution",
  bearer: "attempt-bearer",
};

/** A session the plane offers, which always names its image. */
const session = {
  ...assignment,
  assignment: "session-one",
  image: "registry.invalid/chuggy/session:1",
  bearer: "session-bearer",
};

/** One answer as the plane would send it, naming its release as every one does, with no server to send it. */
function answered(status, body) {
  return new globalThis.Response(status === 204 ? null : body, {
    status,
    headers: { [workerContractHeader]: workerContractRelease },
  });
}

/** A plane client whose every request is answered `status` and `body`. */
function answering(status, body = "{}", settings = planeSettings) {
  return poolPlaneClient(settings, async () => answered(status, body));
}

test("a poll names what the pool holds and wants of each kind, and carries its own token", async () => {
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (input, init) => {
    seen.push({ url: String(input), init });
    return answered(
      200,
      JSON.stringify({
        assignments: [assignment],
        sessions: [session],
        stop: ["a"],
      }),
    );
  });
  const polled = await plane.poll("pool-token", ["one", "two"], 3, 2);
  assert.equal(
    seen[0].url,
    "https://pool-plane.invalid/v1/assignments?held=one&held=two&wanted=3&wantedSessions=2",
  );
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.headers.authorization, "Bearer pool-token");
  assert.deepEqual(polled, {
    polled: "Reconciled",
    assignments: [assignment],
    sessions: [session],
    stop: ["a"],
  });
});

test("a base address's own path is kept beneath every route", async () => {
  const sent = [];
  const plane = poolPlaneClient(
    { ...planeSettings, baseUrl: "https://gateway.invalid/pools" },
    async (input) => {
      sent.push(String(input));
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      );
    },
  );
  await plane.poll("pool-token", [], 1);
  await plane.settle("pool-token", "one", { outcome: "Accepted" });
  assert.deepEqual(sent, [
    "https://gateway.invalid/pools/v1/assignments?wanted=1&wantedSessions=0",
    "https://gateway.invalid/pools/v1/assignments/one/accepted",
  ]);
});

test("each refusing status is the arm the plane means by it", async () => {
  for (const [status, expected] of [
    [401, "Stale"],
    [404, "Denied"],
    [400, "Denied"],
    [503, "Unavailable"],
    [500, "Unavailable"],
  ]) {
    const polled = await answering(status).poll("pool-token", [], 1);
    assert.equal(polled.polled, expected, `status ${String(status)}`);
  }
});

/** A reconciliation the schema reads, as bytes, with `stop` naming each of `stopped`. */
function reconciliationBytes(stopped) {
  return Buffer.from(
    JSON.stringify({ assignments: [], sessions: [], stop: stopped }),
  );
}

test("an answer this pool cannot read is an outage rather than a refusal", async () => {
  const identity = "x".repeat(256);
  for (const body of [
    "not json",
    JSON.stringify({ assignments: [{}] }),
    Buffer.concat([
      reconciliationBytes(["stop"]).subarray(0, -3),
      Buffer.from([0xff, 0x22, 0x5d, 0x7d]),
    ]),
    reconciliationBytes(
      Array.from(
        { length: Math.ceil(poolPlaneAnswerBytesMax / identity.length) },
        () => identity,
      ),
    ),
  ]) {
    const polled = await answering(200, body).poll("pool-token", [], 1);
    assert.equal(polled.polled, "Unavailable");
  }
});

test("a plane that could not be reached is an outage and raises nothing", async () => {
  const plane = poolPlaneClient(planeSettings, async () => {
    throw new Error("connection refused");
  });
  assert.equal((await plane.poll("pool-token", [], 1)).polled, "Unavailable");
  assert.equal(
    await plane.settle("pool-token", "one", { outcome: "Accepted" }),
    "Unavailable",
  );
});

test("each settlement is the path it is said on and the body it needs", async () => {
  const sent = [];
  const plane = poolPlaneClient(planeSettings, async (input, init) => {
    sent.push({ url: String(input), init });
    return answered(204, "");
  });
  assert.equal(
    await plane.settle("pool-token", "one", { outcome: "Accepted" }),
    "Settled",
  );
  await plane.settle("pool-token", "two", {
    outcome: "Refused",
    evidence: "refused",
  });
  await plane.settle("pool-token", "three", { outcome: "Unavailable" });
  await plane.settle("pool-token", "four", {
    outcome: "Refused",
    evidence: "no git",
    fault: "ImageLacksGit",
  });
  assert.deepEqual(
    sent.map((request) => request.url),
    [
      "https://pool-plane.invalid/v1/assignments/one/accepted",
      "https://pool-plane.invalid/v1/assignments/two/refused",
      "https://pool-plane.invalid/v1/assignments/three/unavailable",
      "https://pool-plane.invalid/v1/assignments/four/refused",
    ],
  );
  assert.deepEqual(
    sent.map((request) => request.init.body),
    [
      "{}",
      '{"evidence":"refused"}',
      "{}",
      '{"evidence":"no git","fault":"ImageLacksGit"}',
    ],
  );
  for (const request of sent) {
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.authorization, "Bearer pool-token");
    assert.equal(request.init.headers["content-type"], "application/json");
  }
});

test("the plane's own 404, empty as it sends one, denies the pool from a poll and from a settlement", async () => {
  const refusing = answering(404, "");
  assert.deepEqual(await refusing.poll("pool-token", [], 1), {
    polled: "Denied",
    evidence: "the plane serves no such pool",
  });
  assert.equal(
    await refusing.settle("pool-token", "one", { outcome: "Accepted" }),
    "Denied",
  );
});

test("a 404 or a 400 naming no release of the plane's is an outage, from a poll and from a settlement", async () => {
  for (const [status, body, headers] of [
    [404, "404 page not found\n", { "content-type": "text/plain" }],
    [400, "400 Bad Request", { "content-type": "text/plain" }],
    [404, "", { [workerContractHeader]: "not a release" }],
  ]) {
    const proxy = poolPlaneClient(
      planeSettings,
      async () => new globalThis.Response(body, { status, headers }),
    );
    assert.deepEqual(await proxy.poll("pool-token", [], 1), {
      polled: "Unavailable",
      evidence: `the plane's address answered ${String(status)}, naming no release`,
    });
    assert.equal(
      await proxy.settle("pool-token", "one", { outcome: "Accepted" }),
      "Unavailable",
      `status ${String(status)}`,
    );
  }
});

test("a settlement the plane will not take says which kind of no it was", async () => {
  for (const [status, expected] of [
    [204, "Settled"],
    [409, "Lost"],
    [401, "Stale"],
    [404, "Denied"],
    [400, "Denied"],
    [503, "Unavailable"],
  ])
    assert.equal(
      await answering(status).settle("pool-token", "one", {
        outcome: "Accepted",
      }),
      expected,
      `status ${String(status)}`,
    );
});

test("a plane address that carries a credential or no web scheme is refused", () => {
  for (const baseUrl of [
    "https://pool:secret@plane.invalid",
    "ftp://plane.invalid",
  ])
    assert.throws(
      () => checkedPoolPlaneClientSettings({ ...planeSettings, baseUrl }),
      RangeError,
    );
});

test("a timeout that is not a positive whole number is refused", () => {
  for (const name of ["pollTimeoutMs", "settleTimeoutMs"])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      assert.throws(
        () => poolPlaneClient({ ...planeSettings, [name]: refused }),
        /timeout must be a positive integer/u,
      );
});

/** The release chuggy pins for a runner's package, as a poll's answer names it. */
const release = {
  package: "chuggy-linux",
  version: "0.14.1",
  url: "https://github.com/kasofsk/chuggy-linux/releases/download/v0.14.1/chuggy-linux-0.14.1.tgz",
  integrity: `sha512-${"A".repeat(86)}==`,
};

test("a runner's poll names its package and version, and the release the answer pins for it is passed on", async () => {
  const headers = [];
  const plane = poolPlaneClient(
    {
      ...planeSettings,
      runner: { package: "chuggy-linux", version: "0.14.0" },
    },
    async (_input, init) => {
      headers.push(init.headers);
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [], release }),
      );
    },
  );
  assert.deepEqual(await plane.poll("pool-token", [], 1), {
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
    release,
  });
  assert.deepEqual(workerRunnerOf(headers[0][workerRunnerHeader]), {
    package: "chuggy-linux",
    version: "0.14.0",
  });
});

test("a client that is no runner names none, and an answer pinning no release passes none on", async () => {
  const headers = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    headers.push(init.headers);
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  const polled = await plane.poll("pool-token", [], 1);
  assert.equal(workerRunnerHeader in headers[0], false);
  assert.equal("release" in polled, false);
});

test("a runner the contract cannot name is refused at once, and a release it cannot read is an outage", async () => {
  for (const runner of [
    { package: "chuggy-linux", version: "0.14.0-rc.1" },
    { package: "Chuggy", version: "0.14.0" },
  ])
    assert.throws(
      () => poolPlaneClient({ ...planeSettings, runner }),
      /pool plane runner must name a package and a plain release version/u,
    );
  const polled = await answering(
    200,
    JSON.stringify({
      assignments: [],
      sessions: [],
      stop: [],
      release: { ...release, url: release.url.replace("https:", "http:") },
    }),
  ).poll("pool-token", [], 1);
  assert.equal(polled.polled, "Unavailable");
});

/**
 * The header each poll of a client given `capabilities` sends under `terms`,
 * as the plane reads it.
 *
 * @param {readonly string[] | undefined} capabilities
 * @param {import("./poolLoop.mjs").WorkerPoolPollTerms} [terms]
 */
async function capabilitiesNamed(capabilities, terms = {}) {
  const headers = [];
  const plane = poolPlaneClient(
    capabilities === undefined
      ? planeSettings
      : { ...planeSettings, capabilities },
    async (_input, init) => {
      headers.push(init.headers);
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      );
    },
  );
  await plane.poll("pool-token", [], 1, 0, terms);
  await plane.poll("pool-token", [], 1, 0, terms);
  return headers.map((sent) => ({
    present: workerRunnerCapabilitiesHeader in sent,
    named: workerRunnerCapabilitiesOf(sent[workerRunnerCapabilitiesHeader]),
  }));
}

/**
 * Catches a duplicate reaching the wire, which the plane refuses with a 400
 * that ends the pool, and a set left off any poll.
 */
test("a runner's every poll names its capabilities as a set the plane reads, each once, and the empty set as one", async () => {
  for (const [given, set] of [
    [
      ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel", "Agent:Claude"],
      ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel"],
    ],
    [[], []],
  ])
    assert.deepEqual(
      await capabilitiesNamed(given),
      Array(2).fill({
        present: true,
        named: { named: "Set", capabilities: set },
      }),
      JSON.stringify(given),
    );
});

/**
 * Catches a withheld capability reaching a poll, one the client was not given
 * added, or a client given none naming a set because its poll withholds one.
 */
test("a poll names the capabilities its client was given less those its terms withhold, and adds none", async () => {
  const given = ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel"];
  for (const [withheld, set] of [
    [["Agent:Claude"], ["Platform:Linux:Amd64", "Tool:Bazel"]],
    [["Agent:Codex"], given],
    [[], given],
    [given, []],
  ])
    assert.deepEqual(
      await capabilitiesNamed(given, { withheld }),
      Array(2).fill({
        present: true,
        named: { named: "Set", capabilities: set },
      }),
      JSON.stringify(withheld),
    );
  assert.deepEqual(
    await capabilitiesNamed(undefined, { withheld: ["Agent:Claude"] }),
    Array(2).fill({ present: false, named: { named: "None" } }),
  );
});

/** Catches a client given no capabilities naming a set, which would replace the one its registration recorded. */
test("a client given no capabilities names none on any poll", async () => {
  assert.deepEqual(
    await capabilitiesNamed(undefined),
    Array(2).fill({ present: false, named: { named: "None" } }),
  );
});

/**
 * Catches a poll's credentials held back from a plane that answered an
 * earlier version or none yet, each of whose polls would then pause its
 * owner's whole agent, or a header the plane reads as other names than the
 * terms', which it would read as naming none.
 */
test("a poll names its terms' credentials as the plane reads them, whatever version it last answered, and none it would not read back as them", async () => {
  const named = { Claude: ["max-1", "key-1"], Codex: ["openai-1"] };
  const seen = [];
  let release = "1.77.0";
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    seen.push(init.headers[workerRunnerCredentialsHeader]);
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      { status: 200, headers: { [workerContractHeader]: release } },
    );
  });
  await plane.poll("pool-token", [], 1, 0, { credentials: named });
  await plane.poll("pool-token", [], 1, 0, { credentials: named });
  release = workerContractRelease;
  await plane.poll("pool-token", [], 1, 0, { credentials: named });
  assert.deepEqual(
    seen.map((header) => workerRunnerCredentialsOf(header)),
    Array(3).fill(named),
  );

  const bound = Array.from(
    { length: workerRunnerCredentialsPerAgentMax + 1 },
    (_, index) => `key-${String(index)}`,
  );
  for (const credentials of [
    undefined,
    {},
    { Claude: [] },
    { Claude: ["max-1", "max-1"] },
    { Claude: ["max-1"], Gemini: ["gemini-1"] },
    { Claude: ["max 1"] },
    { Claude: bound },
  ]) {
    seen.length = 0;
    await plane.poll("pool-token", [], 1, 0, { credentials });
    assert.deepEqual(seen, [undefined], JSON.stringify(credentials));
  }
});

/**
 * Catches an answer's credential outcomes or pauses dropped as the answer is
 * rebuilt, or either made up where the plane left it out.
 */
test("an answer's credential outcomes and pauses are passed on, and none where it names none", async () => {
  const stopping = { assignments: [], sessions: [], stop: ["job-1"] };
  const credentialOutcomes = [
    { assignment: "job-1", outcome: "CreditsExhausted" },
  ];
  const credentialPauses = [
    { agent: "Claude", credential: "max-1", pausedUntil: 1_900_000_000 },
  ];
  const passed = await answering(
    200,
    JSON.stringify({ ...stopping, credentialOutcomes, credentialPauses }),
  ).poll("pool-token", [], 1);
  assert.deepEqual(
    [passed.credentialOutcomes, passed.credentialPauses],
    [credentialOutcomes, credentialPauses],
  );
  const none = await answering(200, JSON.stringify(stopping)).poll(
    "pool-token",
    [],
    1,
  );
  assert.equal(none.polled, "Reconciled");
  assert.ok(!("credentialOutcomes" in none) && !("credentialPauses" in none));
});

/** Catches the threads a chat host keeps workspaces for dropped as the answer is rebuilt, or made up where the plane left them out. */
test("an answer's closed threads and each session's thread are passed on, and none where it names none", async () => {
  const thread = { project: "project-1", session: "thread-1" };
  const session = {
    assignment: "session-1",
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 1_800,
    callbackUrl: "https://worker-plane.invalid/v1/session",
    bearer: "chgs_0123456789abcdef0123456789abcdef",
    image: "registry.invalid/chuggy/chat:1",
    thread,
  };
  const passed = await answering(
    200,
    JSON.stringify({
      assignments: [],
      sessions: [session],
      stop: [],
      threadsClosed: [thread],
    }),
  ).poll("pool-token", [], 0, 1);
  assert.deepEqual(passed.threadsClosed, [thread]);
  assert.deepEqual(passed.sessions?.[0]?.thread, thread);
  const none = await answering(
    200,
    JSON.stringify({ assignments: [], sessions: [], stop: [] }),
  ).poll("pool-token", [], 1);
  assert.equal(none.polled, "Reconciled");
  assert.ok(!("threadsClosed" in none));
});

/**
 * Catches capabilities the plane would refuse reaching a poll, whose 400 ends
 * the pool, and a set bounded before its duplicates are dropped.
 */
test("capabilities the contract cannot read are refused at once, a set past its bound only once its duplicates are dropped", async () => {
  const bounded = Array.from(
    { length: workerPoolCapabilitiesMax },
    (_, index) => `Tool:${String(index)}`,
  );
  for (const capabilities of [
    ["Tool Bazel"],
    ["Tool:Bazel,Agent:Claude"],
    [""],
    [...bounded, "Tool:over"],
  ])
    assert.throws(
      () => poolPlaneClient({ ...planeSettings, capabilities }),
      /pool plane capabilities must be at most \d+ tokens a pool can declare/u,
      JSON.stringify(capabilities),
    );
  const [named] = await capabilitiesNamed([...bounded, bounded[0]]);
  assert.deepEqual(named.named, { named: "Set", capabilities: bounded });
});

/**
 * Catches a room or a ceiling the plane would refuse reaching a poll, whose
 * 400 ends the pool, and a wait sent where none was asked.
 */
test("a poll names the room its pool offers jobs and its ceiling, each only where the contract reads it, and the wait only where one is given", async () => {
  /** @type {Record<string, string>[]} */
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    seen.push(init.headers);
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: 4096, ceilingMib: 12288 },
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: 0 },
    waitSecs: 0,
  });
  await plane.poll("pool-token", [], 1, 0, {
    memory: { roomMib: -1, ceilingMib: 1.5 },
  });
  await plane.poll("pool-token", [], 1);
  assert.deepEqual(
    seen.map((headers) => [
      headers[workerRunnerMemoryRoomHeader],
      headers[workerRunnerMemoryCeilingHeader],
      headers[workerRunnerPollWaitHeader],
    ]),
    [
      ["4096", "12288", undefined],
      ["0", undefined, "0"],
      [undefined, undefined, undefined],
      [undefined, undefined, undefined],
    ],
  );
  for (const sent of ["4096", "12288", "0"])
    assert.equal(workerRunnerCountOf(sent).named, "Count");
});

/**
 * Catches a pool claiming by room from a plane that does not claim so, or
 * that did not say whether a job waits, which would never ask it for one.
 */
test("an answer says whether a job waits only from a plane that claims by room and said, and the client keeps whether its last reconciled answer did, knowing nothing before one", async () => {
  let release = workerContractRelease;
  /** @type {Record<string, unknown>} */
  let body = { assignments: [], sessions: [], stop: [], jobsWaiting: true };
  let status = 200;
  const plane = poolPlaneClient(
    planeSettings,
    async () =>
      new globalThis.Response(JSON.stringify(body), {
        status,
        headers: { [workerContractHeader]: release },
      }),
  );
  assert.equal(plane.claimsByRoom(), undefined);
  status = 503;
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), undefined);
  status = 200;
  const waiting = await plane.poll("pool-token", [], 0);
  assert.equal(waiting.polled === "Reconciled" && waiting.jobsWaiting, true);
  assert.equal(plane.claimsByRoom(), true);
  body = { ...body, jobsWaiting: false };
  const none = await plane.poll("pool-token", [], 0);
  assert.equal(none.polled === "Reconciled" && none.jobsWaiting, false);
  assert.equal(plane.claimsByRoom(), true);
  status = 503;
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), true);
  status = 200;
  release = "1.20.0";
  body = { ...body, jobsWaiting: true };
  assert.deepEqual(await plane.poll("pool-token", [], 0), {
    polled: "Reconciled",
    assignments: [],
    sessions: [],
    stop: [],
  });
  assert.equal(plane.claimsByRoom(), false);
  release = workerContractRelease;
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), true);
  body = { assignments: [], sessions: [], stop: [] };
  await plane.poll("pool-token", [], 0);
  assert.equal(plane.claimsByRoom(), false);
});

test("a poll, every settlement and a report name the release this client speaks and list the features it implements", async () => {
  const named = [];
  const listed = [];
  const plane = poolPlaneClient(planeSettings, async (_input, init) => {
    named.push(init.headers[workerContractHeader]);
    listed.push(
      workerContractFeaturesOf(init.headers[workerContractFeaturesHeader]),
    );
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  await plane.poll("pool-token", [], 1);
  await plane.settle("pool-token", "one", { outcome: "Accepted" });
  await plane.report("pool-token", "{}");
  assert.deepEqual(named, Array(3).fill(workerContractRelease));
  assert.deepEqual(listed, Array(3).fill([...workerFeaturesImplemented]));
});

test("a plane refusing this client's release ends the pool rather than losing an assignment", async () => {
  const refusal = JSON.stringify({
    action: "stop",
    reason: "UnsupportedContractVersion",
    accepted: { min: "1.0", max: "1.0" },
  });
  const refusing = answering(409, refusal);
  const polled = await refusing.poll("pool-token", [], 1);
  assert.equal(polled.polled, "Denied");
  assert.ok(polled.evidence.includes(workerContractRelease));
  assert.equal(
    await refusing.settle("pool-token", "one", { outcome: "Accepted" }),
    "Denied",
  );
  assert.equal(
    await answering(409, "").settle("pool-token", "one", {
      outcome: "Accepted",
    }),
    "Lost",
  );
  assert.equal(
    (await answering(409, "").poll("pool-token", [], 1)).polled,
    "Unavailable",
  );
});

test("a chat host's every poll names how long a session it claims may sit idle, and the image the answer names its sessions is passed on", async () => {
  const seen = [];
  /** @type {Record<string, unknown>} */
  let body = {
    assignments: [],
    sessions: [session],
    stop: [],
    chatImage: `registry.invalid/chuggy/chat@sha256:${"a".repeat(64)}`,
  };
  const plane = poolPlaneClient(
    { ...planeSettings, idleSecs: 600 },
    async (input) => {
      seen.push(String(input));
      return answered(200, JSON.stringify(body));
    },
  );
  assert.deepEqual(await plane.poll("pool-token", ["one"], 0, 1), {
    polled: "Reconciled",
    assignments: [],
    sessions: [session],
    stop: [],
    chatImage: body.chatImage,
  });
  body = { assignments: [], sessions: [], stop: [] };
  const unnamed = await plane.poll("pool-token", [], 0, 0);
  assert.equal("chatImage" in unnamed, false);
  assert.deepEqual(seen, [
    "https://pool-plane.invalid/v1/assignments?held=one&wanted=0&wantedSessions=1&idleSecs=600",
    "https://pool-plane.invalid/v1/assignments?wanted=0&wantedSessions=0&idleSecs=600",
  ]);
});

test("a client given no idle bound names none, and an idle bound that is no positive whole number is refused at once", async () => {
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (input) => {
    seen.push(String(input));
    return answered(
      200,
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
    );
  });
  await plane.poll("pool-token", [], 1, 1);
  assert.equal(seen[0].includes("idleSecs"), false);
  for (const idleSecs of [0, -1, 1.5, Number.NaN, 2 ** 53])
    assert.throws(
      () => checkedPoolPlaneClientSettings({ ...planeSettings, idleSecs }),
      /^RangeError: pool plane idleSecs must be a positive integer$/u,
    );
});

test("a chat host names its threads' capabilities only to a plane whose last answer reads them, and asks any other for no session", async () => {
  const seen = [];
  const { major, minor } = workerContractSessionCapabilitiesNamed;
  const first = `${String(major)}.${String(minor)}.0`;
  const releases = [
    undefined,
    `${String(major)}.${String(minor - 1)}.0`,
    first,
    `${String(major + 1)}.0.0`,
    first,
  ];
  let answers = 0;
  const plane = poolPlaneClient(
    {
      ...planeSettings,
      sessionCapabilities: ["RepositoryRead", "RunCommands"],
    },
    async (input) => {
      seen.push(String(input));
      const release = releases[answers];
      answers += 1;
      return new globalThis.Response(
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
        {
          status: 200,
          headers:
            release === undefined ? {} : { [workerContractHeader]: release },
        },
      );
    },
  );
  for (let poll = 0; poll < releases.length + 1; poll += 1)
    await plane.poll("pool-token", [], 0, 2);
  const asked = "https://pool-plane.invalid/v1/assignments?wanted=0";
  const named = `${asked}&wantedSessions=2&sessionCapabilities=${encodeURIComponent(
    workerPoolPollSessionCapabilitiesText(["RepositoryRead", "RunCommands"]),
  )}`;
  assert.deepEqual(seen, [
    `${asked}&wantedSessions=0`,
    `${asked}&wantedSessions=0`,
    `${asked}&wantedSessions=0`,
    named,
    named,
    named,
  ]);
});

/** The two polls a host on `settings` makes of a plane answering as `decided` does, each asking for two sessions. */
async function planeDecidedPolls(settings, decided) {
  const seen = [];
  const plane = poolPlaneClient(settings, async (input) => {
    seen.push(new globalThis.URL(String(input)));
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      { status: 200, headers: planeHeaders(decided) },
    );
  });
  await plane.poll("pool-token", [], 0, 2);
  await plane.poll("pool-token", [], 0, 2);
  return seen;
}

/**
 * Catches a host's capabilities named to a plane whose list leaves
 * `SessionCapabilitiesNamed` out, which claims it sessions without them, or
 * withheld from one that lists it, and a plane listing nothing read otherwise
 * than by its release.
 */
test("a chat host names its threads' capabilities to a plane listing SessionCapabilitiesNamed, never to one leaving it out, and by its release to one listing nothing", async () => {
  for (const decided of planesDeciding("SessionCapabilitiesNamed")) {
    const seen = await planeDecidedPolls(
      { ...planeSettings, sessionCapabilities: ["RepositoryRead"] },
      decided,
    );
    const named = planeNamed(decided);
    assert.equal(
      seen[1].searchParams.has("sessionCapabilities"),
      decided.takes,
      named,
    );
    assert.equal(
      seen[1].searchParams.get("wantedSessions"),
      decided.takes ? "2" : "0",
      named,
    );
  }
});

/**
 * Catches a host's ticket wakes named to a plane whose list leaves
 * `ThreadTicketWakes` out, which refuses a poll naming a field it cannot read,
 * or withheld from one that lists it, and a host asking such a plane for no
 * session over a setting it only withholds.
 */
test("a chat host names its threads' ticket wakes only to a plane listing ThreadTicketWakes, and asks for its sessions either way", async () => {
  for (const decided of planesDeciding("ThreadTicketWakes"))
    for (const ticketWakes of threadTicketWakeSettings) {
      const seen = await planeDecidedPolls(
        { ...planeSettings, ticketWakes },
        decided,
      );
      const named = planeNamed(decided);
      assert.equal(seen[0].searchParams.has("ticketWakes"), false, named);
      assert.equal(
        seen[1].searchParams.get("ticketWakes"),
        decided.takes ? ticketWakes : null,
        named,
      );
      for (const url of seen)
        assert.equal(url.searchParams.get("wantedSessions"), "2", named);
    }
});

test("a client given no ticket wakes names none, and a setting the contract cannot read is refused at once", async () => {
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (input) => {
    seen.push(new globalThis.URL(String(input)));
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      {
        status: 200,
        headers: planeHeaders({
          release: workerContractRelease,
          features: ["ThreadTicketWakes"],
        }),
      },
    );
  });
  await plane.poll("pool-token", [], 0, 1);
  await plane.poll("pool-token", [], 0, 1);
  for (const url of seen)
    assert.equal(url.searchParams.has("ticketWakes"), false);
  for (const ticketWakes of ["on", "Host", ""])
    assert.throws(
      () => checkedPoolPlaneClientSettings({ ...planeSettings, ticketWakes }),
      /^RangeError: pool plane ticketWakes must be one of On, Off$/u,
    );
});

/**
 * Catches a pool claiming by room from a plane whose list leaves `MemoryRoom`
 * out, or not from one that lists it, and a plane listing nothing read
 * otherwise than by its release.
 */
test("an answer says whether a job waits from a plane listing MemoryRoom, never from one leaving it out, and by its release from one listing nothing", async () => {
  for (const decided of planesDeciding("MemoryRoom")) {
    const plane = poolPlaneClient(
      planeSettings,
      async () =>
        new globalThis.Response(
          JSON.stringify({
            assignments: [],
            sessions: [],
            stop: [],
            jobsWaiting: true,
          }),
          { status: 200, headers: planeHeaders(decided) },
        ),
    );
    const polled = await plane.poll("pool-token", [], 0);
    const named = planeNamed(decided);
    assert.equal(
      polled.polled === "Reconciled" && polled.jobsWaiting === true,
      decided.takes,
      named,
    );
    assert.equal(plane.claimsByRoom(), decided.takes, named);
  }
});

test("a chat host naming no capability for its threads names the empty set, and a set the contract cannot read is refused at once", async () => {
  const seen = [];
  const plane = poolPlaneClient(
    { ...planeSettings, sessionCapabilities: [] },
    async (input) => {
      seen.push(new globalThis.URL(String(input)));
      return answered(
        200,
        JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      );
    },
  );
  await plane.poll("pool-token", [], 0, 1);
  await plane.poll("pool-token", [], 0, 1);
  assert.equal(seen[1].searchParams.get("sessionCapabilities"), "");
  assert.equal(seen[1].searchParams.get("wantedSessions"), "1");
  for (const sessionCapabilities of [["RunCommands", "RunCommands"], ["Root"]])
    assert.throws(
      () =>
        checkedPoolPlaneClientSettings({
          ...planeSettings,
          sessionCapabilities,
        }),
      /^RangeError: pool plane sessionCapabilities must name session capabilities, each once$/u,
    );
});

test("a client given no capabilities for its threads names none and asks for its sessions whatever the plane's release", async () => {
  const seen = [];
  const plane = poolPlaneClient(planeSettings, async (input) => {
    seen.push(new globalThis.URL(String(input)));
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      { status: 200 },
    );
  });
  await plane.poll("pool-token", [], 0, 3);
  await plane.poll("pool-token", [], 0, 3);
  for (const url of seen) {
    assert.equal(url.searchParams.get("wantedSessions"), "3");
    assert.equal(url.searchParams.has("sessionCapabilities"), false);
  }
});

test("an answer naming a chat image the contract cannot read is an outage", async () => {
  for (const chatImage of ["", "i".repeat(4096), 7])
    assert.equal(
      (
        await answering(
          200,
          JSON.stringify({
            assignments: [],
            sessions: [],
            stop: [],
            chatImage,
          }),
        ).poll("pool-token", [], 0)
      ).polled,
      "Unavailable",
    );
});

test("a report is posted to its route as JSON under the token it is given, naming this client's release, and is taken only where the plane answers 204", async () => {
  const seen = [];
  let status = 204;
  const plane = poolPlaneClient(planeSettings, async (input, init) => {
    seen.push({ url: String(input), init });
    return answered(status, "{}");
  });
  assert.deepEqual(await plane.report("pool-token", '{"host":"a"}'), {
    reported: "Reported",
  });
  assert.equal(seen[0].url, "https://pool-plane.invalid/v1/runner-report");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, '{"host":"a"}');
  assert.equal(seen[0].init.headers.authorization, "Bearer pool-token");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.equal(
    seen[0].init.headers[workerContractHeader],
    workerContractRelease,
  );
  for (status of [200, 400, 401, 404, 500])
    assert.deepEqual(await plane.report("pool-token", "{}"), {
      reported: "Failed",
      evidence: `the plane answered ${String(status)}`,
    });
  const unreached = poolPlaneClient(planeSettings, async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await unreached.report("pool-token", "{}"), {
    reported: "Failed",
    evidence: "the plane could not be reached",
  });
});

test("the client keeps the release and features its last poll's answer named, and nothing where that answer named no release or never came", async () => {
  let answer = () =>
    answered(200, '{"assignments":[],"sessions":[],"stop":[]}');
  const plane = poolPlaneClient(planeSettings, async () => answer());
  assert.equal(plane.polledPeer(), undefined);
  await plane.poll("pool-token", [], 1);
  assert.deepEqual(plane.polledPeer(), {
    release: workerContractRelease,
    features: undefined,
  });
  answer = () => new globalThis.Response("bad gateway", { status: 502 });
  await plane.poll("pool-token", [], 1);
  assert.equal(plane.polledPeer(), undefined);
  answer = () =>
    new globalThis.Response("{}", {
      status: 500,
      headers: planeHeaders({ release: "1.27.3", features: ["MemoryRoom"] }),
    });
  await plane.poll("pool-token", [], 1);
  assert.deepEqual(plane.polledPeer(), {
    release: "1.27.3",
    features: ["MemoryRoom"],
  });
  answer = () =>
    new globalThis.Response("bad gateway", {
      status: 502,
      headers: { [workerContractFeaturesHeader]: "MemoryRoom" },
    });
  await plane.poll("pool-token", [], 1);
  assert.equal(plane.polledPeer(), undefined);
  answer = () => {
    throw new TypeError("fetch failed");
  };
  await plane.poll("pool-token", [], 1);
  assert.equal(plane.polledPeer(), undefined);
});
