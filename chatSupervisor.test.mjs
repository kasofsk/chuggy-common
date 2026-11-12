/**
 * The supervisor's side of the chat host protocol, frame by frame, over
 * sessions a suite prepares and ends by hand: which frame answers each of the
 * host's, and when. The contract's rules are what is held here; how a session
 * is prepared is `./chatSession.test.mjs`'s.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  chatProtocolFrameBytesMax,
  chatProtocolLine,
  chatProtocolVersion,
  parseChatSupervisorFrame,
} from "@chuggy/worker-contract/chatHost";
import { workerContractRelease } from "@chuggy/worker-contract/workerContract";

import {
  chatSupervised,
  chatSupervisorMain,
  chatSupervisorProtocolRefusal,
  chatSupervisorProtocols,
  chatSupervisorSettings,
  chatSupervisorVariables,
} from "./chatSupervisor.mjs";

const bearer = "chgs_fedcba9876543210fedcba9876543210";

const envelope = {
  callbackUrl: "http://pool-plane.test:3002",
  bearer,
  timeoutSecsMax: 1_800,
  outputBytesMax: 4_096,
};

/** A session a suite ends by hand: `stops` counts the asks, `end` ends it in `phase`. */
function runningOf() {
  let end;
  const running = {
    stops: 0,
    stop: () => {
      running.stops += 1;
    },
    ended: new Promise((resolve) => {
      end = resolve;
    }),
    end: (phase = "Succeeded") => end(phase),
  };
  return running;
}

/**
 * A supervisor over sessions whose preparations a suite answers by hand:
 * `preparations` holds each, `frames` every frame it wrote after `Ready`,
 * `send` writes a frame of the host's.
 */
function supervisorOf(sessionsMax = 2, protocol = undefined) {
  const input = new PassThrough();
  const written = [];
  const logged = [];
  const preparations = [];
  const closed = new globalThis.AbortController();
  const done = chatSupervised({
    input,
    output: {
      write: (line) => {
        assert.ok(line.endsWith("\n"));
        written.push(parseChatSupervisorFrame(line.slice(0, -1)));
      },
    },
    log: (text) => logged.push(text),
    sessions: {
      prepared: (assignment, handed, signal, credential) =>
        new Promise((resolve, reject) => {
          preparations.push({
            assignment,
            envelope: handed,
            signal,
            credential,
            resolve,
            reject,
          });
        }),
    },
    sessionsMax,
    closed: closed.signal,
    ...(protocol === undefined ? {} : { protocol }),
  });
  return {
    input,
    written,
    frames: () => written.slice(1),
    logged,
    preparations,
    closed,
    done,
    send: (...frames) => input.write(frames.map(chatProtocolLine).join("")),
  };
}

/** Every pending callback run, so what a frame starts has answered. */
async function settled() {
  for (let turn = 0; turn < 4; turn += 1)
    await new Promise((resolve) => globalThis.setImmediate(resolve));
}

const start = (assignment) => ({ frame: "Start", assignment, envelope });
const stop = (assignment) => ({ frame: "Stop", assignment });
const refused = (assignment, reason) => ({
  frame: "Refused",
  assignment,
  reason,
});

test("the supervisor speaks first, naming both protocols of its window, its sessions and its contract", () => {
  const supervisor = supervisorOf(3);

  assert.equal(chatProtocolVersion, 2);
  assert.deepEqual(supervisor.written, [
    {
      frame: "Ready",
      protocols: [1, 2],
      sessionsMax: 3,
      contractRelease: workerContractRelease,
    },
  ]);
});

test("a session started is answered Started once it is prepared, and Ended once when it ends", async () => {
  const supervisor = supervisorOf();

  supervisor.send(start("a"));
  await settled();
  assert.deepEqual(supervisor.frames(), []);
  assert.equal(supervisor.preparations[0].assignment, "a");
  assert.deepEqual(supervisor.preparations[0].envelope, envelope);
  const running = runningOf();
  supervisor.preparations[0].resolve(running);
  await settled();
  running.end("Failed");
  await settled();

  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "a" },
    { frame: "Ended", assignment: "a", phase: "Failed" },
  ]);
});

const credential = { agent: "Claude", type: "OAuth", name: "team-a" };

/** Catches a session run on a credential other than the one its host chose for it. */
test("a Start naming a credential prepares its session on that credential", async () => {
  const supervisor = supervisorOf();

  supervisor.send({ ...start("a"), credential });
  await settled();

  assert.deepEqual(supervisor.preparations[0].credential, credential);
  supervisor.preparations[0].resolve(runningOf());
  await settled();
  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "a" },
  ]);
});

/** Catches a supervisor of the window that stops serving a host a release behind it. */
test("a host speaking only protocol 1 still gets its session, on no credential named", async () => {
  const supervisor = supervisorOf(2, 1);

  supervisor.send(start("a"));
  await settled();
  assert.equal(supervisor.preparations[0].credential, undefined);
  const running = runningOf();
  supervisor.preparations[0].resolve(running);
  await settled();
  running.end();
  await settled();

  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "a" },
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
  ]);
});

/** Catches a host of protocol 1 whose `Start` is read in a later protocol's shape. */
test("a host speaking protocol 1 that names a credential is not followed, and nothing is prepared", async () => {
  const supervisor = supervisorOf(2, 1);

  supervisor.send({ ...start("a"), credential });

  assert.equal(await supervisor.done, 1);
  assert.equal(supervisor.preparations.length, 0);
  assert.match(supervisor.logged.join(""), /speaks protocol 1/u);
});

/** Catches a second `Start` for one assignment that runs a second session, or answers the first's frames twice. */
test("a Start for an assignment being prepared or run is a Duplicate, and the first is answered as before", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();

  supervisor.send(start("a"));
  await settled();
  const running = runningOf();
  supervisor.preparations[0].resolve(running);
  await settled();
  supervisor.send(start("a"));
  await settled();
  running.end();
  await settled();

  assert.equal(supervisor.preparations.length, 1);
  assert.deepEqual(supervisor.frames(), [
    refused("a", "Duplicate"),
    { frame: "Started", assignment: "a" },
    refused("a", "Duplicate"),
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
  ]);
});

test("a Duplicate is answered ahead of Full and of Draining", async () => {
  const supervisor = supervisorOf(1);
  supervisor.send(start("a"));
  await settled();

  supervisor.send(start("a"), start("b"), { frame: "Drain" });
  await settled();
  supervisor.send(start("a"), start("c"));
  await settled();

  assert.deepEqual(supervisor.frames(), [
    refused("a", "Duplicate"),
    refused("b", "Full"),
    refused("a", "Duplicate"),
    refused("c", "Draining"),
  ]);
});

/** Catches a preparation left out of the count, which lets a host start more sessions than `Ready` said. */
test("a session being prepared counts toward sessionsMax", async () => {
  const supervisor = supervisorOf(1);

  supervisor.send(start("a"), start("b"));
  await settled();

  assert.deepEqual(supervisor.frames(), [refused("b", "Full")]);
  supervisor.preparations[0].reject(new Error("unprepared"));
  await settled();
  supervisor.send(start("c"));
  await settled();
  assert.equal(supervisor.preparations.length, 2);
});

test("a preparation that fails is refused Unprepared, and nothing follows", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();

  supervisor.preparations[0].reject(new Error("no user is free"));
  await settled();

  assert.deepEqual(supervisor.frames(), [refused("a", "Unprepared")]);
});

/** Catches a `Stop` during preparation that is answered before what it made is gone, or answered as a session's end. */
test("a Stop while a session is prepared cancels it, refused Stopped once the preparation has unwound", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();

  supervisor.send(stop("a"));
  await settled();

  const [preparation] = supervisor.preparations;
  assert.equal(preparation.signal.aborted, true);
  assert.deepEqual(supervisor.frames(), []);
  preparation.reject(preparation.signal.reason);
  await settled();
  assert.deepEqual(supervisor.frames(), [refused("a", "Stopped")]);
});

test("a preparation that started its process before its Stop was heard stops it, and is refused Stopped once it ended", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();
  const running = runningOf();

  supervisor.send(stop("a"));
  await settled();
  supervisor.preparations[0].resolve(running);
  await settled();

  assert.equal(running.stops, 1);
  assert.deepEqual(supervisor.frames(), []);
  running.end();
  await settled();
  assert.deepEqual(supervisor.frames(), [refused("a", "Stopped")]);
});

test("a Stop for a running session stops it, and its one Ended follows", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();
  const running = runningOf();
  supervisor.preparations[0].resolve(running);
  await settled();

  supervisor.send(stop("a"));
  await settled();

  assert.equal(running.stops, 1);
  running.end();
  await settled();
  supervisor.send(stop("a"));
  await settled();
  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "a" },
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
  ]);
});

test("a Stop for an assignment neither prepared nor run is answered by nothing", async () => {
  const supervisor = supervisorOf();

  supervisor.send(stop("nobody"));
  await settled();

  assert.deepEqual(supervisor.frames(), []);
});

/**
 * Catches a `Drain` that stops what is running, cancels what is prepared, or
 * says `Drained` before every `Start` read before it has its answer and every
 * `Started` its `Ended`.
 */
test("Drain only waits: Drained once every Start before it is answered and every session has ended, then the supervisor exits", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"), start("b"));
  await settled();
  const [a, b] = supervisor.preparations;
  const runningB = runningOf();
  b.resolve(runningB);
  await settled();

  supervisor.send({ frame: "Drain" });
  await settled();
  assert.equal(a.signal.aborted, false);
  assert.equal(runningB.stops, 0);
  runningB.end();
  await settled();
  const runningA = runningOf();
  a.resolve(runningA);
  await settled();
  assert.ok(!supervisor.frames().some(({ frame }) => frame === "Drained"));
  runningA.end();

  assert.equal(await supervisor.done, 0);
  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "b" },
    { frame: "Ended", assignment: "b", phase: "Succeeded" },
    { frame: "Started", assignment: "a" },
    { frame: "Ended", assignment: "a", phase: "Succeeded" },
    { frame: "Drained" },
  ]);
});

test("a Drain with nothing to wait for is Drained at once", async () => {
  const supervisor = supervisorOf();

  supervisor.send({ frame: "Drain" });

  assert.equal(await supervisor.done, 0);
  assert.deepEqual(supervisor.frames(), [{ frame: "Drained" }]);
});

/** Catches the end of the host's stream leaving a preparation unanswered or a session running. */
test("at the end of its input every preparation is refused Stopped and every session stopped and Ended, and the supervisor exits", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"), start("b"));
  await settled();
  const [a, b] = supervisor.preparations;
  const running = runningOf();
  b.resolve(running);
  await settled();

  supervisor.input.end();
  await settled();

  assert.equal(a.signal.aborted, true);
  assert.equal(running.stops, 1);
  a.reject(a.signal.reason);
  running.end();
  assert.equal(await supervisor.done, 0);
  assert.deepEqual(supervisor.frames(), [
    { frame: "Started", assignment: "b" },
    refused("a", "Stopped"),
    { frame: "Ended", assignment: "b", phase: "Succeeded" },
  ]);
});

test("a signal to end is taken as the end of its input", async () => {
  const supervisor = supervisorOf();
  supervisor.send(start("a"));
  await settled();

  supervisor.closed.abort();
  const [preparation] = supervisor.preparations;
  preparation.reject(preparation.signal.reason);

  assert.equal(await supervisor.done, 0);
  assert.deepEqual(supervisor.frames(), [refused("a", "Stopped")]);
});

/**
 * Catches a supervisor that holds a line it has not seen the end of past a
 * frame's bound, or follows a host past a line it cannot read, or repeats
 * that line — a `Start` carries a bearer — on its log.
 */
test("a line longer than a frame or not a frame ends the host's frames, said without the line, and the supervisor exits non-zero", async () => {
  const unreadable = [
    "x".repeat(chatProtocolFrameBytesMax + 1),
    JSON.stringify({
      frame: "Start",
      assignment: "z",
      envelope,
      extra: bearer,
    }),
    "{",
  ];
  for (const line of unreadable) {
    const supervisor = supervisorOf();
    supervisor.send(start("a"));
    await settled();
    const running = runningOf();
    supervisor.preparations[0].resolve(running);
    await settled();

    supervisor.input.write(`${line}\n${chatProtocolLine(start("b"))}`);
    await settled();

    assert.equal(running.stops, 1);
    running.end();
    assert.equal(await supervisor.done, 1);
    assert.equal(supervisor.preparations.length, 1, "a later frame was read");
    const printed = supervisor.logged.join("");
    assert.ok(!printed.includes(bearer), "the line was repeated");
    assert.ok(printed.length < 200, "the line was repeated");
  }
});

/** Catches an overlong line read whole before it is refused. */
test("a line that never ends is refused once it passes a frame's bound", async () => {
  const supervisor = supervisorOf();

  supervisor.input.write("x".repeat(chatProtocolFrameBytesMax));
  await settled();
  assert.deepEqual(supervisor.logged, []);
  supervisor.input.write("x");

  assert.equal(await supervisor.done, 1);
  assert.equal(supervisor.logged.length, 1);
});

/** What every supervisor is told of its credential, which has no constant. */
const credentialed = {
  [chatSupervisorVariables.credential]:
    "/var/run/chuggy/credentials/provider/claude.json",
  [chatSupervisorVariables.credentialUid]: "1000",
  [chatSupervisorVariables.credentialGid]: "1001",
};

/**
 * Catches a supervisor that reads a host of another protocol's environment as
 * its own, which refuses it for a setting it misnames or, worse, runs it and
 * fails every session it is handed.
 */
test("a supervisor refuses a host that names no protocol or one it does not speak, saying which side to update", () => {
  assert.deepEqual(chatSupervisorProtocols, [1, 2]);
  for (const named of ["1", "2"])
    assert.equal(
      chatSupervisorProtocolRefusal({ CHUG_CHAT_PROTOCOL: named }),
      undefined,
    );
  const spoken = "this image's supervisor speaks protocol(s) [1, 2]";
  for (const [named, said, side] of [
    [undefined, "none", "the host's runner"],
    ["", "none", "the host's runner"],
    ["0", "0", "the host's runner"],
    ["x", "x", "the host's runner"],
    [
      String(chatProtocolVersion + 1),
      String(chatProtocolVersion + 1),
      "this image",
    ],
  ]) {
    const refused = String(
      chatSupervisorProtocolRefusal(
        named === undefined ? {} : { CHUG_CHAT_PROTOCOL: named },
      ),
    );
    assert.ok(
      refused.startsWith(
        `${spoken}; the host speaks ${said}: run matching versions; update ${side}`,
      ),
      refused,
    );
  }
});

test("a supervisor reads the host's protocol before any other setting, and exits saying why", async (t) => {
  const written = [];
  t.mock.method(process.stderr, "write", (text) => written.push(String(text)));
  assert.equal(await chatSupervisorMain({}), 1);
  assert.match(
    written.join(""),
    /the host speaks none: run matching versions/u,
  );
  assert.ok(!written.join("").includes("CHUG_CHAT_CREDENTIAL"));
});

test("a supervisor's places and bounds are its constants unless its environment names others", () => {
  const settings = chatSupervisorSettings(credentialed);
  assert.equal(settings.sessionsMax, settings.uidCount);
  assert.equal(settings.sessionsRoot, "/sessions");
  assert.equal(
    settings.credentialFile,
    "/var/run/chuggy/credentials/provider/claude.json",
  );
  assert.deepEqual(settings.credentialOwner, { uid: 1_000, gid: 1_001 });

  const named = chatSupervisorSettings({
    ...credentialed,
    [chatSupervisorVariables.uidFirst]: "40000",
    [chatSupervisorVariables.uidCount]: "4",
    [chatSupervisorVariables.sessionsMax]: "9",
    [chatSupervisorVariables.sessionsRoot]: "/elsewhere",
  });
  assert.equal(named.uidFirst, 40_000);
  assert.equal(named.sessionsMax, 4);
  assert.equal(named.sessionsRoot, "/elsewhere");
  assert.equal(
    chatSupervisorSettings({
      ...credentialed,
      [chatSupervisorVariables.sessionsMax]: "2",
    }).sessionsMax,
    2,
  );
});

/**
 * Catches a supervisor that starts without the owner its credential is read
 * as, which it would then have to look up on the file, or with an owner a
 * session is run as, who could read the credential where it is mounted.
 */
test("a supervisor is refused without its credential and the owner it is read as, or with an owner a session is run as", () => {
  for (const [changed, why] of [
    [
      { [chatSupervisorVariables.credential]: undefined },
      /CHUG_CHAT_CREDENTIAL /u,
    ],
    [{ [chatSupervisorVariables.credential]: "claude.json" }, /absolute path/u],
    [
      { [chatSupervisorVariables.credentialUid]: undefined },
      /owner the provider credential is read as/u,
    ],
    [
      { [chatSupervisorVariables.credentialGid]: "" },
      /owner the provider credential is read as/u,
    ],
    [
      { [chatSupervisorVariables.credentialUid]: "-1" },
      /CHUG_CHAT_CREDENTIAL_UID/u,
    ],
    [
      { [chatSupervisorVariables.credentialUid]: "20000" },
      /owner 20000 is among the users/u,
    ],
    [
      { [chatSupervisorVariables.credentialUid]: "20031" },
      /owner 20031 is among the users/u,
    ],
    [
      {
        [chatSupervisorVariables.uidFirst]: "40000",
        [chatSupervisorVariables.credentialUid]: "40001",
      },
      /owner 40001 is among the users/u,
    ],
  ])
    assert.throws(
      () =>
        chatSupervisorSettings(
          Object.fromEntries(
            Object.entries({ ...credentialed, ...changed }).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        ),
      why,
    );
  for (const uid of ["0", "19999", "20032"])
    assert.equal(
      chatSupervisorSettings({
        ...credentialed,
        [chatSupervisorVariables.credentialUid]: uid,
      }).credentialOwner.uid,
      Number(uid),
    );
});

/** Catches a session's own group that is a mirror's, which would hand it that repository, or a session run as root. */
test("a supervisor is refused users that overlap its mirrors' groups, or that are root", () => {
  assert.throws(
    () =>
      chatSupervisorSettings({
        ...credentialed,
        [chatSupervisorVariables.uidFirst]: "30000",
      }),
    /overlap/u,
  );
  for (const value of ["0", "-1", "1.5", "x"])
    assert.throws(
      () =>
        chatSupervisorSettings({
          ...credentialed,
          [chatSupervisorVariables.uidFirst]: value,
        }),
      /CHUG_CHAT_UID_FIRST/u,
    );
});

/** What a supervisor handed a set is told of it: Claude's credentials by name, each file in its own directory. */
const handedSet = [
  {
    agent: "Claude",
    type: "OAuth",
    name: "team-a",
    file: "/var/run/chuggy/credentials/team-a/token",
    setting: { kind: "Subscription" },
  },
  {
    agent: "Claude",
    type: "ApiKey",
    name: "key-b",
    file: "/var/run/chuggy/credentials/key-b/key",
    setting: { kind: "ApiKey" },
  },
];

const setHanded = {
  [chatSupervisorVariables.credentials]: JSON.stringify(handedSet),
  [chatSupervisorVariables.credentialUid]: "1000",
  [chatSupervisorVariables.credentialGid]: "1001",
};

test("a supervisor handed a set holds each credential by name, and no one file", () => {
  const settings = chatSupervisorSettings(setHanded);

  assert.deepEqual(settings.credentials, handedSet);
  assert.equal(settings.credentialFile, undefined);
  assert.deepEqual(settings.credentialOwner, { uid: 1_000, gid: 1_001 });
});

/** Catches a set read loosely, which would run a session on a file or kind its host did not name. */
test("a supervisor is refused a set it cannot read, or one beside the one file", () => {
  const withSet = (credentials) => ({
    ...setHanded,
    [chatSupervisorVariables.credentials]: JSON.stringify(credentials),
  });
  for (const [environment, why] of [
    [{ ...setHanded, ...credentialed }, /each name the provider credential/u],
    [
      { ...setHanded, [chatSupervisorVariables.credentials]: "{" },
      /cannot read/u,
    ],
    [withSet([]), /cannot read/u],
    [withSet([handedSet[0], handedSet[0]]), /cannot read/u],
    [
      withSet([{ ...handedSet[0], setting: { kind: "ApiKey" } }]),
      /cannot read/u,
    ],
    [withSet([{ ...handedSet[0], agent: "Codex" }]), /cannot read/u],
    [withSet([{ ...handedSet[0], file: "token" }]), /cannot read/u],
    [withSet([{ ...handedSet[0], name: "a b" }]), /cannot read/u],
  ])
    assert.throws(() => chatSupervisorSettings(environment), why);
});
