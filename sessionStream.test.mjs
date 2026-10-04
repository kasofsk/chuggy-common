/**
 * A thread's session reporting its answer while its model writes it: which
 * session asks the runtime for a stream, what of one reaches the plane, and
 * that nothing a turn is answered with, measures or stores is moved by it.
 *
 * `./sessionStream.fixture.json` is one turn as the pinned runtime emitted it
 * with partial messages on, cut to the fields a session reads and with every
 * identity replaced: text, a tool call and its result, thinking, and text.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { URL } from "node:url";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";
import { sessionTaskVariable } from "@chuggy/worker-contract/workerEnvironment";

import { observeRateLimit, rateLimitSightings } from "./rateLimit.mjs";
import { credentialScrubHead } from "./runEvidence.mjs";
import { sessionMeasure } from "./session.mjs";
import {
  bearer,
  boundEnvironment,
  environment,
  facts,
  mintedCredential,
  planeOf,
  queryOf,
  result,
  run,
  task,
  threadRoster,
  token,
  turnOne,
} from "./sessionHarness.fixture.mjs";
import { sessionLiveBounds } from "./sessionLive.mjs";
import {
  blockStop,
  liveNothing,
  liveReader,
  messageStart,
  messageStop,
  settled,
  streamed,
  textDelta,
  textStart,
} from "./sessionLive.fixture.mjs";

const recorded = JSON.parse(
  readFileSync(new URL("./sessionStream.fixture.json", import.meta.url)),
);
const livePath = sessionPlaneRoutes.turnLive.path;
const threadFacts = {
  ...facts,
  kind: "Thread",
  capabilities: [...threadRoster],
};

/** What the runtime reports it spent, so a turn has a measurement to move. */
const spent = {
  "claude-test": {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 40,
  },
};

/**
 * A turn's messages as a runtime yields them: each one the runtime stores is
 * appended to the session's store before it is yielded, and the plane answers
 * what was posted before the next arrives. `kept` leaves messages out without
 * renaming the entries of those that stay.
 */
function scriptOf(messages, kept = () => true) {
  return (_asked, _index, options) =>
    messages.flatMap((message, at) => {
      if (!kept(message)) return [];
      const stores = message.type === "assistant" || message.type === "user";
      const entry = {
        uuid: `entry-${String(at)}`,
        type: message.type,
        message: message.message,
      };
      return [
        ...(stores
          ? [
              () =>
                options.sessionStore.append({ sessionId: "runtime-1" }, [
                  entry,
                ]),
            ]
          : []),
        message.type === "result"
          ? {
              ...message,
              modelUsage: spent,
              total_cost_usd: 0.25,
              duration_ms: 1_500,
            }
          : message,
        settled,
      ];
    });
}

const isLive = ({ path }) => path === livePath;
const heldPaths = [
  sessionPlaneRoutes.turn.path,
  sessionPlaneRoutes.turnStopped.path,
];
const isHeld = ({ path }) => heldPaths.includes(path);

/**
 * One session run over `script`, and what it asked the plane: its live posts,
 * and everything else but the questions the plane holds for it, which are its
 * polls of the mailbox, repeated as often as an idle session's clock allows,
 * and its watch for a stop of the turn it is answering. `services.query` replaces the runtime
 * `script` drives. Its posts wait out no gap, so that what a script yields is
 * posted as it is read, unless `services.liveBounds` says they do.
 */
async function sessionOver(script, options = {}) {
  const { sessionFacts = threadFacts, refuse, services = {} } = options;
  const plane =
    options.plane ?? planeOf(options.turns ?? [turnOne], sessionFacts, refuse);
  const { seen, query } = queryOf(script);
  const code = await run({
    request: plane.request,
    requestOnce: plane.requestOnce,
    query,
    liveBounds: { postGapMsMin: 0 },
    ...services,
  });
  return {
    code,
    seen,
    asks: plane.calls.filter(isLive).length,
    posts: plane.calls.filter(isLive).map(({ body }) => body),
    settled: plane.calls.filter((call) => !isLive(call) && !isHeld(call)),
  };
}

const isStream = ({ type }) => type === "stream_event";

test("a thread's query asks the runtime for partial messages, and no other session's does", async () => {
  const kinds = {
    Lead: facts,
    Inquiry: {
      ...facts,
      kind: "Inquiry",
      capabilities: ["ProjectRead"],
      forkFrom: "lead-1",
    },
  };

  const thread = await sessionOver(() => [], { turns: [] });
  assert.equal(thread.seen.options.includePartialMessages, true);
  for (const [kind, sessionFacts] of Object.entries(kinds)) {
    const { seen } = await sessionOver(() => [], { sessionFacts, turns: [] });
    assert.ok(!("includePartialMessages" in seen.options), kind);
  }
});

/**
 * Catches a block reported out of order or under another message, text that
 * is not the text the store holds under that message's identity, and a turn
 * that never said it was over.
 */
test("the recorded turn reaches the plane block by block under the identity its stored entries carry, and ends", async () => {
  const { code, posts } = await sessionOver(scriptOf(recorded));
  const reader = liveReader();
  for (const post of posts) reader.posted(post);

  assert.equal(code, 0);
  assert.deepEqual([...new Set(posts.map(({ turn }) => turn))], ["turn-1"]);
  assert.deepEqual(
    posts
      .flatMap(({ events }) => events)
      .filter(({ live }) => live === "Block")
      .map(({ message, index, kind, name }) => [message, index, kind, name]),
    [
      ["message_01", 0, "Text", undefined],
      ["message_01", 1, "ToolUse", "Read"],
      ["message_02", 0, "Thinking", undefined],
      ["message_02", 1, "Text", undefined],
    ],
  );
  const stored = recorded
    .filter(({ type }) => type === "assistant")
    .flatMap(({ message }) =>
      message.content
        .filter(({ type }) => type === "text")
        .map(({ text }) => `${message.id}: ${text}`),
    );
  const written = (message) =>
    reader.states
      .findLast((held) => held.message === message)
      .blocks.filter(({ kind }) => kind === "Text")
      .map(({ text }) => `${message}: ${text}`);
  assert.deepEqual(
    [...written("message_01"), ...written("message_02")],
    stored,
  );
  assert.deepEqual(posts.at(-1).events.at(-1), { live: "End" });
  assert.deepEqual(reader.held(), liveNothing);
});

/**
 * Catches an end held back until the turn is drained or settled, under the gap
 * a session posts with: the runtime is asked for its next message only once
 * the result is read and is held there past the gap, in a drain longer than
 * that, and by then the end is posted and the answer is not.
 */
test("a turn's end is posted while the turn is drained, before it is settled", async () => {
  const { postGapMsMin } = sessionLiveBounds;
  const bounds = { ...task.bounds, resultDrainMs: 4 * postGapMsMin };
  const plane = planeOf([turnOne], threadFacts);
  let seen;
  const script = (...asked) => [
    ...scriptOf(recorded)(...asked),
    async () => {
      await wait(2 * postGapMsMin);
      seen = plane.calls.map(({ path, body }) => [path, body?.events?.at(-1)]);
    },
  ];

  await sessionOver(script, {
    plane,
    services: {
      liveBounds: sessionLiveBounds,
      environment: {
        ...environment,
        [sessionTaskVariable]: JSON.stringify({ ...task, bounds }),
      },
    },
  });

  assert.deepEqual(seen.at(-1), [livePath, { live: "End" }]);
  assert.ok(
    !seen.some(([path]) => path === sessionPlaneRoutes.turnAnswer.path),
    "the turn was settled before its end was read",
  );
});

/**
 * Catches an end that waits out a gap the session does not: a turn with no
 * result is settled at once and the session closes behind it, inside the gap
 * the turn's first post began.
 */
test("a turn the runtime ends without a result still says it is over", async () => {
  const events = [messageStart("message-1"), textStart(0), textDelta(0, "cut")];
  const query = ({ prompt }) =>
    (async function* cutShort() {
      await prompt[Symbol.asyncIterator]().next();
      for (const event of events) yield streamed(event);
      await settled();
    })();

  const { posts, settled: asked } = await sessionOver(undefined, {
    services: { query, liveBounds: sessionLiveBounds },
  });

  assert.deepEqual(
    posts.flatMap(({ events: posted }) => posted).map(({ live }) => live),
    ["Block", "Text", "End"],
  );
  assert.ok(
    asked.some(({ path }) => path === sessionPlaneRoutes.turnFailure.path),
    "the turn was not one the runtime gave no result for",
  );
});

test("a runtime's stream moves nothing a turn is answered with, measures or stores", async () => {
  const streaming = await sessionOver(scriptOf(recorded));
  const plain = await sessionOver(
    scriptOf(recorded, (each) => !isStream(each)),
  );

  assert.ok(streaming.posts.length > 0, "the stream reached no live route");
  assert.deepEqual(plain.posts, []);
  assert.deepEqual(streaming.settled, plain.settled);
  const answer = plain.settled.find(
    ({ path }) => path === sessionPlaneRoutes.turnAnswer.path,
  );
  assert.deepEqual(answer.body.measured.tools, ["Read"]);
  assert.ok(answer.body.batchLast > answer.body.batchFirst);
});

test("a stream event is nothing the measurement or the rate-limit observation reads", () => {
  const events = recorded.filter(isStream);
  const measure = sessionMeasure();
  const sightings = rateLimitSightings();
  const init = { type: "system", subtype: "init", model: "claude-test" };
  const ended = result("success", { modelUsage: spent });

  measure.saw(init);
  for (const event of events) {
    measure.saw(event);
    observeRateLimit(sightings, event);
  }

  const unmoved = sessionMeasure();
  unmoved.saw(init);
  assert.deepEqual(measure.of(ended), unmoved.of(ended));
  assert.deepEqual(sightings, rateLimitSightings());
});

test("a subagent's stream is not the thread's answer, and a session that is not a thread reports none", async () => {
  const under = recorded.map((message) =>
    isStream(message) ? { ...message, parent_tool_use_id: "call_01" } : message,
  );

  const subagent = await sessionOver(scriptOf(under));
  const lead = await sessionOver(scriptOf(recorded), { sessionFacts: facts });

  assert.deepEqual(subagent.posts, []);
  assert.deepEqual(lead.posts, []);
  assert.equal(lead.code, 0);
});

/**
 * No live failure may fail, delay or fence a turn. Each way the live route can
 * fail leaves the session exiting as it did and every other call it made the
 * same, a post that is never answered among them: the turn is answered while
 * that post is still in flight.
 */
test("a live route that fails, however it fails, leaves the turn answered and stored as it was", async () => {
  const healthy = await sessionOver(scriptOf(recorded));
  const refusing = (status) => ({
    refuse: (path) => (path === livePath ? status : undefined),
  });
  const through = (requestOnce) => ({ services: { requestOnce } });
  const failures = {
    "a plane that is down": refusing(503),
    "a refused post": refusing(400),
    "a fenced session": refusing(401),
    "a refused release": refusing(409),
    "a transport that raises": through(() => {
      throw new Error("no transport");
    }),
    "an unreachable plane": through(async () => {
      throw new Error("unreachable");
    }),
    "a post never answered": through(() => new Promise(() => undefined)),
  };

  for (const [named, failure] of Object.entries(failures)) {
    const failed = await sessionOver(scriptOf(recorded), failure);

    assert.equal(failed.code, healthy.code, named);
    assert.deepEqual(failed.settled, healthy.settled, named);
  }
});

/**
 * A post goes through the request that asks once. Catches one sent through
 * the session's own, which would ask a plane that is down again and again
 * while the turn ran, and a session that ended without saying what was lost.
 */
test("a plane that is down is asked once in a turn shorter than the retry wait, and the session says so as it ends", async () => {
  const warned = [];

  const { asks, code } = await sessionOver(scriptOf(recorded), {
    refuse: (path) => (path === livePath ? 503 : undefined),
    services: {
      warn: (text) => warned.push(text),
      liveBounds: { postGapMsMin: 0, postRetryMs: 3_600_000 },
    },
  });

  assert.equal(code, 0);
  assert.equal(asks, 1);
  assert.deepEqual(warned, [
    "the worker plane did not take 1 of 1 live posts\n",
  ]);
});

/** One turn of one text block, written in `deltas`, as the runtime streams and ends it. */
function writtenTurn(deltas, message = "message-1") {
  return [
    ...[
      messageStart(message),
      textStart(0),
      ...deltas.map((delta) => textDelta(0, delta)),
      blockStop(0),
      messageStop,
    ].map((event) => streamed(event)),
    result("success", { result: "held" }),
  ];
}

/**
 * Catches text that left before the scrub could see the whole of a
 * credential: every delta is posted on its own here, so each cut of each
 * credential is a post that could have carried its head. The session holds
 * all three kinds: the one its launcher mounted, its own bearer, and the one
 * the plane minted for its repository.
 */
test("a credential the model writes is never posted, wherever the runtime cuts it", async () => {
  const secrets = [token, bearer, mintedCredential.password];
  const settledHead = credentialScrubHead(secrets);
  const text = `the token ${token}, the bearer ${bearer} and the mint ${mintedCredential.password} are held`;
  const scrubbed =
    "the token [redacted credential], the bearer [redacted credential] and the mint [redacted credential] are held";

  for (const cutChars of [1, 7, 16]) {
    const deltas = text.match(new RegExp(`.{1,${String(cutChars)}}`, "gsu"));
    const { posts } = await sessionOver(
      scriptOf([
        { type: "system", subtype: "init", session_id: "runtime-1" },
        ...writtenTurn(deltas),
      ]),
      {
        plane: planeOf([turnOne], threadFacts, undefined, mintedCredential),
        services: {
          environment: boundEnvironment,
          write: async () => undefined,
          checkout: async () => undefined,
        },
      },
    );
    const reader = liveReader();
    for (const post of posts) reader.posted(post);

    const grown = new Set(
      deltas.map((_, at) => settledHead(deltas.slice(0, at + 1).join(""))),
    );
    assert.ok(posts.length >= grown.size, "the deltas were not posted apart");
    for (const post of posts)
      for (const secret of secrets)
        assert.ok(!JSON.stringify(post).includes(secret.slice(0, 4)));
    for (const held of reader.states)
      for (const block of held.blocks)
        assert.ok(scrubbed.startsWith(block.text), block.text);
    assert.equal(reader.states.at(-2).blocks[0].text, scrubbed);
  }
});

/**
 * Catches a stream event named by a turn it is not of: one read after its
 * turn's result, while the turn is drained and after it is settled, posted
 * under that turn or under the next.
 */
test("a stream read after its turn's result is posted under no turn", async () => {
  const turnTwo = { ...turnOne, turn: "turn-2", ordinal: 2 };
  const late = writtenTurn(["late text"], "message-late").filter(isStream);

  const { code, posts } = await sessionOver(
    (_asked, index) =>
      [
        ...(index === 0
          ? [{ type: "system", subtype: "init", session_id: "runtime-1" }]
          : []),
        ...writtenTurn([`answer ${String(index)}`], `message-${String(index)}`),
        ...late,
      ].flatMap((message) => [message, settled]),
    { turns: [turnOne, turnTwo] },
  );

  assert.equal(code, 0);
  assert.deepEqual(
    posts.map(({ turn, events }) => [turn, events.at(-1).live]),
    [
      ["turn-1", "Block"],
      ["turn-1", "Text"],
      ["turn-1", "End"],
      ["turn-2", "Block"],
      ["turn-2", "Text"],
      ["turn-2", "End"],
    ],
  );
  assert.ok(!JSON.stringify(posts).includes("message-late"));
});
