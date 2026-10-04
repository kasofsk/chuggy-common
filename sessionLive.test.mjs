/**
 * The live sender held to the contract's events and to the reader the plane
 * folds them with: what a post holds, what the plane's answers leave, and that
 * no cut of a text sends what the store would have redacted.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionLiveText,
  jsonTextBytes,
  sessionLiveBlockCharsMax,
  sessionLiveBlocksMax,
  sessionLiveEventsMax,
  sessionLiveMessageCharsMax,
  sessionLiveTextBytesMax,
  sessionPlaneRoutes,
  sessionTurnToolNameCharsMax,
} from "@chuggy/worker-contract/sessionPlane";

import {
  drawnBelow,
  drawnCuts,
  drawnSecrets,
  drawnText,
  seeded,
} from "./credentialText.fixture.mjs";
import {
  credentialScrub,
  credentialScrubbing,
  credentialScrubCharsMin,
  credentialScrubHead,
} from "./runEvidence.mjs";
import {
  sessionLiveAcknowledged,
  sessionLiveBounds,
  sessionLiveEnded,
  sessionLiveHeard,
  sessionLivePost,
  sessionLiveSender,
  sessionLiveState,
} from "./sessionLive.mjs";
import {
  blockStart,
  blockStop,
  liveClock,
  liveNothing,
  livePlane,
  liveReader,
  messageStart,
  messageStop,
  settled,
  textDelta,
  textStart,
} from "./sessionLive.fixture.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const bearer = "chgs_0123456789abcdef0123456789abcdef";
const secret = "sk-ant-oat01-0123456789abcdefghijklmnop";

/** A session that holds no credential. */
const clear = { scrub: (text) => text, scrubHead: (text) => text };

/** A session holding `secrets`, scrubbing as its store does. */
const holding = (...secrets) => ({
  scrub: credentialScrub(secrets),
  scrubHead: credentialScrubHead(secrets),
});

const begun = (index, kind, message = "message-1") => ({
  live: "Block",
  message,
  index,
  kind,
});
const written = (index, offset, text, message = "message-1") => ({
  live: "Text",
  message,
  index,
  offset,
  text,
});
const end = { live: "End" };

function hear(state, turn, events, held = clear) {
  for (const event of events) sessionLiveHeard(state, turn, event, held.scrub);
}

/** The events of the post `state` makes, taken by the plane. */
function taken(state, held = clear) {
  const post = sessionLivePost(state, held);
  if (post !== undefined) sessionLiveAcknowledged(state, post);
  return post?.events;
}

/** More posts than any turn a case writes is sent in, so a sender that never finishes fails rather than runs on. */
const postsMax = 1_000;

/** Every post `state` makes until the plane holds all of it, each shown to `reader`. */
function drained(state, reader, held = clear) {
  const posts = [];
  for (let post = taken(state, held); post !== undefined;) {
    assert.ok(posts.length < postsMax, "the plane was never left holding it");
    posts.push(post);
    reader.posted({ turn: state.turn, events: post });
    post = taken(state, held);
  }
  return posts;
}

/** A state holding one text block of one message, with `texts` written to it. */
function writing(texts, held = clear) {
  const state = sessionLiveState(undefined);
  hear(
    state,
    "turn-1",
    [
      messageStart("message-1"),
      textStart(0),
      ...texts.map((text) => textDelta(0, text)),
    ],
    held,
  );
  return state;
}

test("a message's blocks are reported in the order they began, each by its kind, and only a text block's text", () => {
  const state = sessionLiveState(undefined);
  const delta = (index, body) => ({
    type: "content_block_delta",
    index,
    delta: body,
  });
  hear(state, "turn-1", [
    messageStart("message-1"),
    blockStart(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "a thought" }),
    textDelta(0, "text for a block that is not text"),
    blockStop(0),
    textStart(1),
    textDelta(1, "one "),
    delta(1, { type: "citations_delta", text: "a delta that is not text" }),
    delta(1, { type: "text_delta" }),
    textDelta(1, "two"),
    blockStop(1),
    blockStart(2, { type: "tool_use", id: "call-1", name: "Read", input: {} }),
    delta(2, { type: "input_json_delta", partial_json: '{"file_path":' }),
    blockStop(2),
    blockStart(3, {
      type: "redacted_thinking",
      data: "",
      text: "not text",
      name: "not a tool",
    }),
    blockStart(4, { type: "server_tool_use", id: "call-2", name: "search" }),
    blockStart(5, { type: "mcp_tool_use", id: "call-3", name: "mcp__draft" }),
  ]);
  for (const unreported of [
    blockStart(6, { type: "web_search_tool_result", content: [] }),
    textDelta(6, "a block that is not reported writes nothing"),
    blockStop(6),
  ])
    assert.equal(
      sessionLiveHeard(state, "turn-1", unreported, clear.scrub),
      false,
      unreported.type,
    );

  assert.deepEqual(sessionLivePost(state, clear).events, [
    begun(0, "Thinking"),
    begun(1, "Text"),
    written(1, 0, "one two"),
    { ...begun(2, "ToolUse"), name: "Read" },
    begun(3, "Thinking"),
    { ...begun(4, "ToolUse"), name: "search" },
    { ...begun(5, "ToolUse"), name: "mcp__draft" },
  ]);
});

test("a text block that begins with text is sent from that text on", () => {
  const state = sessionLiveState(undefined);
  hear(state, "turn-1", [
    messageStart("message-1"),
    blockStart(0, { type: "text", text: "one " }),
    textDelta(0, "two"),
    blockStart(1, { type: "text" }),
    textDelta(1, "three"),
  ]);

  assert.deepEqual(taken(state), [
    begun(0, "Text"),
    written(0, 0, "one two"),
    begun(1, "Text"),
    written(1, 0, "three"),
  ]);
});

test("a post carries only what the plane has not acknowledged, and one it did not take is sent again from there", () => {
  const state = writing(["one "]);
  assert.deepEqual(taken(state), [begun(0, "Text"), written(0, 0, "one ")]);

  hear(state, "turn-1", [textDelta(0, "two ")]);
  const lost = sessionLivePost(state, clear);
  hear(state, "turn-1", [textDelta(0, "three")]);

  assert.deepEqual(lost.events, [written(0, 4, "two ")]);
  assert.deepEqual(taken(state), [written(0, 4, "two three")]);
  assert.equal(sessionLivePost(state, clear), undefined);
});

test("a block the plane never acknowledged begins again in the next post", () => {
  const state = writing(["one "]);
  sessionLivePost(state, clear);
  hear(state, "turn-1", [textDelta(0, "two")]);

  assert.deepEqual(taken(state), [begun(0, "Text"), written(0, 0, "one two")]);
});

/**
 * Catches a cut made by units or by bytes rather than by whole characters, an
 * event heavier than the contract takes, and a post holding more events than
 * the route does.
 */
test("a long text is cut on whole characters into events the contract takes, a bounded number to a post", () => {
  const bird = "\u{1f426}";
  const text = `a${bird.repeat(5_000)}${"\u0001".repeat(3_000)}é`;
  const state = writing([text]);
  const reader = liveReader();
  const posts = drained(state, reader);

  assert.ok(posts.length > 1, "the text fitted one post");
  for (const post of posts.slice(0, -1))
    assert.equal(post.length, sessionLiveEventsMax);
  const texts = posts.flat().filter(({ live }) => live === "Text");
  const heaviest = jsonTextBytes("\u0001");
  for (const event of texts.slice(0, -1)) {
    assert.ok(isSessionLiveText(event.text));
    assert.ok(
      jsonTextBytes(event.text) > sessionLiveTextBytesMax - heaviest,
      "an event was cut short of what it may weigh",
    );
  }
  assert.equal(reader.held().blocks[0].text, text);
});

test("a block longer than a live block holds stops where it passed the bound, and the turn goes on", () => {
  const head = "a".repeat(sessionLiveBlockCharsMax - 1);
  const state = writing([head]);
  const reader = liveReader();
  drained(state, reader);
  assert.equal(reader.held().blocks[0].text, head);
  const sent = reader.states.length;

  const full = "n".repeat(sessionLiveBlockCharsMax);
  hear(state, "turn-1", [textDelta(0, "bc"), textStart(1)]);
  drained(state, reader);
  hear(state, "turn-1", [textDelta(0, "d"), blockStop(0)]);
  drained(state, reader);
  assert.equal(reader.states.length, sent + 1, "a stopped block went on");

  hear(state, "turn-1", [textDelta(1, full)]);
  drained(state, reader);
  assert.equal(reader.held().blocks[0].text, head);
  assert.equal(reader.held().blocks[1].text, full);
  sessionLiveEnded(state, "turn-1");
  assert.deepEqual(taken(state), [end]);
});

/**
 * Catches a stopped block treated as whole once it ends: what it holds is cut
 * short of the block, so scrubbing it as the whole block would send the head
 * of a credential the cut fell in.
 */
test("a block stopped past its bound releases nothing it held back for a credential", () => {
  const held = holding(secret);
  const head = "a".repeat(sessionLiveBlockCharsMax - 20);
  const state = writing([head, secret.slice(0, 20)], held);
  const reader = liveReader();
  drained(state, reader, held);
  assert.equal(reader.held().blocks[0].text, head);

  hear(state, "turn-1", [
    textDelta(0, secret.slice(20)),
    blockStop(0),
    messageStop,
  ]);

  assert.equal(taken(state, held), undefined);
});

test("text the scrub lengthens past what a live block holds is sent as far as the contract takes it", () => {
  const short = secret.slice(0, credentialScrubCharsMin);
  const held = holding(short);
  const text = `${short} `.repeat(
    sessionLiveBlockCharsMax / (short.length + 1),
  );
  const state = writing([text], held);
  const reader = liveReader();
  hear(state, "turn-1", [blockStop(0)]);
  sessionLiveEnded(state, "turn-1");
  drained(state, reader, held);

  const sent = reader.states.at(-2).blocks[0].text;
  assert.ok(held.scrub(text).length > sessionLiveBlockCharsMax);
  assert.ok(held.scrub(text).startsWith(sent));
  assert.ok(
    sent.length > sessionLiveBlockCharsMax - sessionLiveTextBytesMax,
    "the block stopped short of the last event it could send",
  );
  assert.deepEqual(reader.held(), liveNothing);
});

test("a message holds no more blocks than a live event can name", () => {
  const state = sessionLiveState(undefined);
  hear(state, "turn-1", [messageStart("message-1")]);
  for (const index of [-1, 0.5, sessionLiveBlocksMax, 2 ** 60, "0", undefined])
    hear(state, "turn-1", [textStart(index), textDelta(index, "unheld")]);
  for (let index = 0; index < sessionLiveBlocksMax; index += 1)
    hear(state, "turn-1", [textStart(index)]);

  assert.equal(state.blocks.size, sessionLiveBlocksMax);
  assert.ok(
    [...state.blocks.values()].every((block) => block.raw === ""),
    "text of a block that is not held was kept",
  );
});

test("a block a live event cannot name is not reported, and its neighbours are", () => {
  const long = "n".repeat(sessionTurnToolNameCharsMax + 1);
  const held = holding(secret);
  const state = sessionLiveState(undefined);
  hear(
    state,
    "turn-1",
    [
      messageStart("message-1"),
      blockStart(0, { type: "tool_use", id: "call-1", name: long, input: {} }),
      blockStart(1, { type: "tool_use", id: "call-2", input: {} }),
      textStart(sessionLiveBlocksMax),
      textDelta(sessionLiveBlocksMax, "past the last index"),
      textStart(sessionLiveBlocksMax - 1),
      textDelta(sessionLiveBlocksMax - 1, "kept"),
    ],
    held,
  );

  assert.deepEqual(taken(state, held), [
    begun(sessionLiveBlocksMax - 1, "Text"),
    written(sessionLiveBlocksMax - 1, 0, "kept"),
  ]);
  assert.equal(
    taken(state, held),
    undefined,
    "a refused block was offered again",
  );
});

test("a message whose identity a live event cannot carry reports nothing, and the next message does", () => {
  const held = holding(secret);
  for (const id of [
    "",
    "m".repeat(sessionLiveMessageCharsMax + 1),
    undefined,
  ]) {
    const state = sessionLiveState(undefined);
    hear(
      state,
      "turn-1",
      [messageStart(id), textStart(0), textDelta(0, "unnamed")],
      held,
    );
    assert.equal(taken(state, held), undefined, String(id));

    hear(
      state,
      "turn-1",
      [messageStart("message-2"), textStart(0), textDelta(0, "named")],
      held,
    );
    assert.deepEqual(taken(state, held), [
      begun(0, "Text", "message-2"),
      written(0, 0, "named", "message-2"),
    ]);
  }
});

test("text the contract refuses stops its block, keeping what was sent and nothing after", () => {
  for (const refused of ["\u0000", "\ud83d and on", "\udc26"]) {
    const state = writing(["sent "]);
    assert.deepEqual(taken(state), [begun(0, "Text"), written(0, 0, "sent ")]);

    hear(state, "turn-1", [textDelta(0, refused), textStart(1)]);
    assert.deepEqual(taken(state), [begun(1, "Text")], refused);
    hear(state, "turn-1", [textDelta(0, "later"), textDelta(1, "next")]);
    sessionLiveEnded(state, "turn-1");
    assert.deepEqual(taken(state), [written(1, 0, "next"), end], refused);
  }
});

test("a text that weighs exactly what an event may is one event", () => {
  const text = "a".repeat(sessionLiveTextBytesMax - jsonTextBytes(""));
  const state = writing([text, "b"]);

  assert.deepEqual(taken(state), [
    begun(0, "Text"),
    written(0, 0, text),
    written(0, text.length, "b"),
  ]);
});

test("a character cut between two deltas is sent once it is whole", () => {
  const state = writing(["a\ud83d"]);
  assert.deepEqual(taken(state), [begun(0, "Text"), written(0, 0, "a")]);

  hear(state, "turn-1", [textDelta(0, "\udc26b")]);
  assert.deepEqual(taken(state), [written(0, 1, "\u{1f426}b")]);
});

test("a turn's end follows whatever text remains, and nothing follows it", () => {
  const state = writing(["one "]);
  taken(state);
  hear(state, "turn-1", [textDelta(0, "two"), blockStop(0), messageStop]);

  assert.equal(sessionLiveEnded(state, "turn-1"), true);
  assert.equal(sessionLiveEnded(state, "turn-1"), false);
  hear(state, "turn-1", [textDelta(0, " heard after the end")]);
  assert.deepEqual(taken(state), [written(0, 4, "two"), end]);
  assert.equal(taken(state), undefined);
  hear(state, "turn-1", [messageStart("message-2"), textStart(0)]);
  assert.equal(taken(state), undefined, "an ended turn was reported again");
});

test("a turn's end waits for the post that carries the last of its text", () => {
  const state = writing(["\u0001".repeat(sessionLiveBlockCharsMax / 8)]);
  sessionLiveEnded(state, "turn-1");

  const first = taken(state);
  const rest = taken(state);

  assert.equal(first.length, sessionLiveEventsMax);
  assert.ok(!first.some(({ live }) => live === "End"));
  assert.deepEqual(rest.at(-1), end);
  assert.equal(rest.filter(({ live }) => live === "End").length, 1);
});

test("a turn's end takes the next post where this one is full", () => {
  const state = sessionLiveState(undefined);
  const tool = { type: "tool_use", id: "call-1", name: "Read", input: {} };
  const tools = (count) =>
    Array.from({ length: count }, (_, index) => blockStart(index, tool));
  hear(state, "turn-1", [
    messageStart("message-1"),
    ...tools(sessionLiveEventsMax + 1),
  ]);
  sessionLiveEnded(state, "turn-1");

  assert.equal(taken(state).length, sessionLiveEventsMax);
  assert.deepEqual(taken(state), [
    { ...begun(sessionLiveEventsMax, "ToolUse"), name: "Read" },
    end,
  ]);

  hear(state, "turn-2", [
    messageStart("message-1"),
    ...tools(sessionLiveEventsMax),
  ]);
  sessionLiveEnded(state, "turn-2");
  assert.ok(!taken(state).some(({ live }) => live === "End"));
  assert.deepEqual(taken(state), [end]);
});

test("a turn nothing was heard of has no end to post", () => {
  const state = writing(["one"]);
  taken(state);

  assert.equal(sessionLiveEnded(state, "turn-2"), false);
  assert.equal(sessionLiveEnded(sessionLiveState(undefined), "turn-1"), false);
  assert.equal(sessionLiveEnded(sessionLiveState(undefined), undefined), false);
  assert.equal(sessionLivePost(sessionLiveState(undefined), clear), undefined);
  assert.equal(sessionLivePost(state, clear), undefined);
});

/**
 * Catches a queue that outlives its turn: the last turn's unsent text posted
 * under the new turn, and a late answer to the last turn's post acknowledging
 * or ending the new one.
 */
test("a new turn starts from nothing, whatever the last turn left unsent or in flight", () => {
  const state = writing(["old"]);
  hear(state, "turn-1", [textDelta(0, " and unsent")]);
  sessionLiveEnded(state, "turn-1");
  const flying = sessionLivePost(state, clear);
  assert.equal(flying.ending, true);

  hear(state, "turn-2", [
    messageStart("message-1"),
    textStart(0),
    textDelta(0, "new"),
  ]);
  sessionLiveAcknowledged(state, flying);

  const post = sessionLivePost(state, clear);
  assert.equal(post.turn, "turn-2");
  assert.deepEqual(post.events, [begun(0, "Text"), written(0, 0, "new")]);
  assert.equal(sessionLiveHeard(state, undefined, textDelta(0, "x")), false);
  assert.equal(state.turn, "turn-2", "an event of no turn replaced the turn");
});

test("a new message replaces the blocks of the last, and a block that begins again is emptied", () => {
  const state = writing(["of the first message"]);
  taken(state);
  hear(state, "turn-1", [
    textDelta(0, " and unsent"),
    messageStart("message-2"),
    textStart(0),
    textDelta(0, "of the second"),
    textStart(0),
    textDelta(0, "begun again"),
  ]);

  assert.deepEqual(taken(state), [
    begun(0, "Text", "message-2"),
    written(0, 0, "begun again", "message-2"),
  ]);

  hear(state, "turn-1", [
    blockStart(0, { type: "web_search_tool_result", content: [] }),
    textDelta(0, " and replaced by a block that is not reported"),
  ]);
  assert.equal(taken(state), undefined);
});

test("a credential cut across deltas is never posted, and text held back for one is sent when it is not one", () => {
  const held = holding(secret);
  const state = writing([`the key is ${secret.slice(0, 20)}`], held);
  assert.deepEqual(taken(state, held), [
    begun(0, "Text"),
    written(0, 0, "the key is "),
  ]);

  hear(state, "turn-1", [textDelta(0, `${secret.slice(20)} and it work`)]);
  assert.deepEqual(taken(state, held), [
    written(0, 11, "[redacted credential] and it work"),
  ]);

  hear(state, "turn-1", [textDelta(0, secret.slice(0, 1))]);
  assert.equal(taken(state, held), undefined, "a credential's head was sent");
  hear(state, "turn-1", [blockStop(0)]);
  assert.deepEqual(taken(state, held), [written(0, 44, secret.slice(0, 1))]);
});

test("a message that stops releases what each of its blocks held back", () => {
  const held = holding(secret);
  const state = writing([`it work${secret.slice(0, 1)}`], held);
  assert.deepEqual(taken(state, held), [
    begun(0, "Text"),
    written(0, 0, "it work"),
  ]);

  hear(state, "turn-1", [messageStop]);
  assert.deepEqual(taken(state, held), [written(0, 7, secret.slice(0, 1))]);
});

test("a message's identity and a tool's name pass the scrub the store passes them through", () => {
  const held = holding(secret);
  const state = sessionLiveState(undefined);
  hear(
    state,
    "turn-1",
    [
      messageStart(`message-${secret}`),
      blockStart(0, { type: "tool_use", id: "call-1", name: `mcp__${secret}` }),
    ],
    held,
  );

  assert.deepEqual(taken(state, held), [
    {
      ...begun(0, "ToolUse", "message-[redacted credential]"),
      name: "mcp__[redacted credential]",
    },
  ]);
});

/**
 * A credential the session learns of is scrubbed from the next post on. Text
 * of it the plane already holds cannot be taken back, so its block begins
 * again and the reader is left holding what the store will.
 */
test("a credential learned mid-block is left out of every later post, and its block begins again", () => {
  const scrubbing = credentialScrubbing([]);
  const state = writing([`saw ${secret} once`], scrubbing);
  assert.deepEqual(taken(state, scrubbing), [
    begun(0, "Text"),
    written(0, 0, `saw ${secret} once`),
  ]);

  hear(state, "turn-1", [textDelta(0, ` and ${secret.slice(0, 20)}`)]);
  scrubbing.keepSecret({ kind: "minted", value: secret });

  assert.deepEqual(taken(state, scrubbing), [
    begun(0, "Text"),
    written(0, 0, "saw [redacted credential] once and "),
  ]);
});

/** A sender over a plane and a clock the case holds, and what it warned. `services` replaces any of what it is built on. */
function senderOf(services = {}) {
  const plane = livePlane();
  const clock = liveClock();
  const warned = [];
  const sender = sessionLiveSender(task, bearer, {
    request: plane.request,
    now: clock.now,
    pause: clock.pause,
    ...clear,
    warn: (text) => warned.push(text),
    ...services,
  });
  const hearing = (turn, events) => {
    for (const event of events) sender.heard(turn, event);
  };
  return { plane, clock, warned, sender, hearing };
}

const opening = [messageStart("message-1"), textStart(0)];

test("one post is in flight at a time, asked once under its own deadline, and the next carries all that was heard meanwhile", async () => {
  const { plane, hearing } = senderOf({ bounds: { postGapMsMin: 0 } });

  hearing("turn-1", [...opening, textDelta(0, "one ")]);
  hearing("turn-1", [textDelta(0, "two "), textDelta(0, "three")]);
  assert.deepEqual(plane.posts, [
    { turn: "turn-1", events: [begun(0, "Text")] },
  ]);
  assert.deepEqual(plane.asked, [
    {
      task,
      bearer,
      path: sessionPlaneRoutes.turnLive.path,
      method: "POST",
      transport: { deadlineMs: sessionLiveBounds.postDeadlineMs },
    },
  ]);

  await plane.answer();

  assert.deepEqual(plane.posts.slice(1), [
    { turn: "turn-1", events: [written(0, 0, "one two three")] },
  ]);
  await plane.answer();
  assert.equal(plane.flying(), 0, "a post was made of nothing");
});

test("an answer's body is released unread, whatever the plane answered", async () => {
  for (const status of [204, 400, 503]) {
    let released = 0;
    const body = {
      cancel: async () => {
        released += 1;
      },
    };
    const { hearing } = senderOf({ request: async () => ({ status, body }) });

    hearing("turn-1", opening);
    await settled();

    assert.equal(released, 1, String(status));
  }
});

test("two posts start no closer than the gap, an ended turn's last among them", async () => {
  const { plane, clock, sender, hearing } = senderOf();
  const { postGapMsMin } = sessionLiveBounds;

  hearing("turn-1", opening);
  await plane.answer();
  hearing("turn-1", [textDelta(0, "one "), textDelta(0, "two ")]);
  await clock.advance(postGapMsMin - 1);
  assert.equal(plane.posts.length, 1, "a post started inside the gap");
  assert.deepEqual(clock.waiting(), [1], "more than one wait was running");

  await clock.advance(1);
  assert.deepEqual(plane.posts[1].events, [written(0, 0, "one two ")]);
  await plane.answer();

  hearing("turn-1", [textDelta(0, "three")]);
  sender.ended("turn-1");
  await clock.advance(postGapMsMin - 1);
  assert.equal(plane.posts.length, 2, "an ended turn's post did not wait");

  await clock.advance(1);
  assert.deepEqual(plane.posts[2].events, [written(0, 8, "three"), end]);
});

/**
 * The most a plane is sent: one post a gap, each as many events as the route
 * takes, with the plane answering at once and the turn already over.
 */
test("a backlog is caught up one full post a gap, however quickly the plane answers", async () => {
  const { plane, clock, sender, hearing } = senderOf();
  const text = "a".repeat(sessionLiveBlockCharsMax);
  hearing("turn-1", [...opening, textDelta(0, text), blockStop(0)]);
  sender.ended("turn-1");

  let gaps = 0;
  while (plane.flying() > 0) {
    assert.ok(gaps < postsMax, "the backlog was never caught up");
    await plane.answer();
    assert.equal(plane.flying(), 0, "a post started inside the gap");
    await clock.advance(sessionLiveBounds.postGapMsMin);
    gaps += 1;
  }

  const sizes = plane.posts.map(({ events }) => events.length);
  assert.equal(plane.posts.length, gaps);
  assert.deepEqual(sizes.slice(0, 3), [
    1,
    sessionLiveEventsMax,
    sessionLiveEventsMax,
  ]);
  assert.deepEqual(plane.posts.at(-1).events.at(-1), end);
});

test("a post the plane could not take is sent again after the retry wait, from what it acknowledged", async () => {
  const { postGapMsMin, postRetryMs } = sessionLiveBounds;
  for (const refusal of [503, new Error("the plane is unreachable")]) {
    const { plane, clock, sender, hearing, warned } = senderOf();
    const reader = liveReader();

    hearing("turn-1", [...opening, textDelta(0, "one ")]);
    await plane.answer();
    await clock.advance(postGapMsMin);
    await plane.answer();
    hearing("turn-1", [textDelta(0, "two ")]);
    await clock.advance(postGapMsMin);
    assert.deepEqual(plane.posts[2].events, [written(0, 4, "two ")]);
    await plane.answer(refusal);
    hearing("turn-1", [textDelta(0, "three")]);
    await clock.advance(postRetryMs - 1);
    assert.equal(plane.posts.length, 3, "the retry did not wait");

    await clock.advance(1);
    assert.deepEqual(plane.posts[3].events, [written(0, 4, "two three")]);
    await plane.answer();
    for (const post of plane.posts) reader.posted(post);
    assert.equal(reader.held().blocks[0].text, "one two three");

    sender.close();
    assert.deepEqual(warned, [
      "the worker plane did not take 1 of 4 live posts\n",
    ]);
  }
});

/** A turn every post of which the plane cannot take, heard until the sender gives it up. */
async function unavailable({ plane, clock, hearing }, turn) {
  hearing(turn, opening);
  for (let post = 0; post < sessionLiveBounds.postFailuresMax; post += 1) {
    await plane.answer(503);
    await clock.advance(sessionLiveBounds.postRetryMs);
  }
}

test("a plane that takes no post for the bound is left alone for the turn, and asked once more in the next", async () => {
  const driven = senderOf();
  const { plane, clock, sender, hearing } = driven;

  await unavailable(driven, "turn-1");
  hearing("turn-1", [textDelta(0, "unsent")]);
  sender.ended("turn-1");
  await clock.advance(sessionLiveBounds.postRetryMs);
  assert.equal(plane.posts.length, sessionLiveBounds.postFailuresMax);
  assert.equal(plane.flying(), 0);

  hearing("turn-2", [...opening, textDelta(0, "next")]);
  assert.equal(plane.posts.at(-1).turn, "turn-2");
  await plane.answer(503);
  await clock.advance(sessionLiveBounds.postRetryMs);
  assert.equal(plane.flying(), 0, "a plane still down was asked again");

  hearing("turn-3", opening);
  await plane.answer();
  hearing("turn-3", [textDelta(0, "taken")]);
  await clock.advance(sessionLiveBounds.postGapMsMin);
  assert.deepEqual(plane.posts.at(-1).events, [written(0, 0, "taken")]);
  await plane.answer(503);
  await clock.advance(sessionLiveBounds.postRetryMs);
  assert.equal(
    plane.flying(),
    1,
    "a post the plane took did not clear the count",
  );
});

test("an ended turn's end is sent again after the retry wait where the plane could not take it", async () => {
  const { plane, clock, sender, hearing } = senderOf();

  hearing("turn-1", opening);
  await plane.answer();
  sender.ended("turn-1");
  await clock.advance(sessionLiveBounds.postGapMsMin);
  assert.deepEqual(plane.posts[1].events, [end]);
  await plane.answer(503);
  await clock.advance(sessionLiveBounds.postRetryMs - 1);
  assert.equal(plane.posts.length, 2, "the retry did not wait");

  await clock.advance(1);
  assert.deepEqual(plane.posts[2].events, [end]);
  await plane.answer();
  await clock.advance(sessionLiveBounds.postRetryMs);
  assert.equal(plane.posts.length, 3, "an end the plane took was sent again");
});

test("a post the plane refuses stops the turn's stream, and the next turn's is sent", async () => {
  const { plane, clock, sender, hearing, warned } = senderOf();

  hearing("turn-1", opening);
  await plane.answer(400);
  hearing("turn-1", [textDelta(0, "unsent")]);
  sender.ended("turn-1");
  await clock.advance(sessionLiveBounds.postRetryMs);
  assert.equal(plane.posts.length, 1, "a refused turn went on being sent");

  hearing("turn-2", opening);
  assert.deepEqual(plane.posts[1], {
    turn: "turn-2",
    events: [begun(0, "Text")],
  });
  await plane.answer();
  sender.close();
  assert.deepEqual(warned, [
    "the worker plane did not take 1 of 2 live posts\n",
  ]);
});

test("a late refusal of the last turn's post leaves the turn that followed it streaming", async () => {
  const { plane, sender, hearing } = senderOf({ bounds: { postGapMsMin: 0 } });

  hearing("turn-1", opening);
  hearing("turn-2", [...opening, textDelta(0, "next")]);
  await plane.answer(400);

  assert.deepEqual(plane.posts[1], {
    turn: "turn-2",
    events: [begun(0, "Text"), written(0, 0, "next")],
  });
  await plane.answer();
  sender.ended("turn-2");
  assert.deepEqual(plane.posts[2], { turn: "turn-2", events: [end] });
});

/**
 * Catches a stop read only where an act begins: the answer that stops the
 * session arrives with the gap already passed and more to send, in a turn
 * still written and in one that has ended, and the step after it posts.
 */
test("a plane that stops the session is posted nothing more, in this turn or any other", async () => {
  for (const status of [401, 409]) {
    for (const over of [false, true]) {
      const { plane, clock, warned, sender, hearing } = senderOf();
      const named = `${String(status)}, the turn ${over ? "over" : "written"}`;

      hearing("turn-1", opening);
      await clock.advance(sessionLiveBounds.postGapMsMin);
      hearing("turn-1", [textDelta(0, "heard while the post flew")]);
      if (over) sender.ended("turn-1");
      await plane.answer(status);
      assert.equal(plane.posts.length, 1, named);

      hearing("turn-1", [textDelta(0, "unsent")]);
      sender.ended("turn-1");
      hearing("turn-2", [...opening, textDelta(0, "unsent too")]);
      await clock.advance(sessionLiveBounds.postRetryMs);
      sender.close();

      assert.equal(plane.posts.length, 1, named);
      assert.deepEqual(
        warned,
        ["the worker plane did not take 1 of 1 live posts\n"],
        named,
      );
    }
  }
});

test("a session that closes posts nothing more, and says nothing where every post was taken", async () => {
  const { plane, clock, sender, hearing, warned } = senderOf();

  hearing("turn-1", opening);
  await plane.answer();
  hearing("turn-1", [textDelta(0, "unsent")]);
  sender.close();
  await clock.advance(sessionLiveBounds.postGapMsMin);
  hearing("turn-1", [textDelta(0, "unheard")]);
  sender.ended("turn-1");

  assert.equal(plane.posts.length, 1);
  assert.deepEqual(warned, []);
});

/**
 * Nothing the sender is built on may raise into the session: each of these
 * failing closes the stream, and is said once when the session ends.
 */
test("a fault in what the sender is built on closes the stream and raises nothing", async () => {
  const raise = () => {
    throw new Error("a fault");
  };
  const faults = {
    "a scrub that raises": { scrub: raise, scrubHead: raise },
    "a pause that raises": { pause: raise },
    "a pause that rejects": {
      pause: () => Promise.reject(new Error("a fault")),
    },
    "a clock that raises": { now: raise },
  };
  for (const [named, fault] of Object.entries(faults)) {
    const { plane, sender, hearing, warned } = senderOf(fault);

    hearing("turn-1", [...opening, textDelta(0, "one")]);
    if (plane.flying() > 0) await plane.answer();
    hearing("turn-1", [textDelta(0, " two")]);
    sender.ended("turn-1");
    await settled();
    assert.equal(plane.flying(), 0, `${named} left the stream posting`);

    sender.close();
    assert.deepEqual(
      warned,
      ["the live stream stopped on its own fault\n"],
      named,
    );
  }
});

test("a request that raises where it is called, and a warning that cannot be written, raise nothing", async () => {
  const sender = sessionLiveSender(task, bearer, {
    request: () => {
      throw new Error("no transport");
    },
    now: () => 0,
    pause: () => new Promise(() => undefined),
    ...clear,
    warn: () => {
      throw new Error("no stream to warn on");
    },
  });

  for (const event of opening) sender.heard("turn-1", event);
  sender.ended("turn-1");
  await settled();
  sender.close();
});

/** One turn drawn from `random`: its messages, and each block's tool or the text it is written in. */
function drawnTurn(random, secrets) {
  return Array.from({ length: 1 + drawnBelow(random, 3) }, (_, message) => ({
    id: `message-${String(message + 1)}`,
    blocks: Array.from({ length: 1 + drawnBelow(random, 3) }, () => {
      if (drawnBelow(random, 4) === 0) return { tool: "Read" };
      const text = drawnText(random, secrets, 10);
      return { text, deltas: drawnCuts(random, text, 9) };
    }),
  }));
}

/** The stream events a drawn turn is written in. */
function turnEvents(messages) {
  return messages.flatMap(({ id, blocks }) => [
    messageStart(id),
    ...blocks.flatMap(({ tool, deltas }, index) => [
      tool === undefined
        ? textStart(index)
        : blockStart(index, { type: "tool_use", id: "call-1", name: tool }),
      ...(deltas ?? []).map((text) => textDelta(index, text)),
      blockStop(index),
    ]),
    messageStop,
  ]);
}

/**
 * A drawn turn heard by a sender whose plane takes, refuses and loses posts
 * at drawn moments, until the turn has ended and the plane holds all of it.
 * A lost post is one the plane may have taken without the sender hearing so,
 * which the reader is shown or not by another draw.
 */
async function streamedTurn(random, messages, held) {
  const bounds = {
    postGapMsMin: drawnBelow(random, 2) * sessionLiveBounds.postGapMsMin,
    postFailuresMax: Number.MAX_SAFE_INTEGER,
  };
  const { plane, clock, sender } = senderOf({ ...held, bounds });
  const reader = liveReader();
  const unheard = turnEvents(messages);
  let answered = 0;
  const answer = async (status) => {
    const lost = status instanceof Error;
    if (status === 204 || (lost && drawnBelow(random, 2) === 0))
      reader.posted(plane.posts[answered]);
    answered += 1;
    await plane.answer(status);
  };
  const lost = new Error("the answer was lost");
  while (unheard.length > 0) {
    const act = drawnBelow(random, 4);
    if (act < 2) sender.heard("turn-1", unheard.shift());
    else if (act === 2 && plane.flying() > 0)
      await answer([204, 204, 204, 503, lost][drawnBelow(random, 5)]);
    else await clock.advance(drawnBelow(random, 2 * bounds.postGapMsMin + 1));
  }
  sender.ended("turn-1");
  while (plane.flying() > 0 || clock.waiting().length > 0) {
    assert.ok(answered < postsMax, "the turn's posts never finished");
    if (plane.flying() > 0) await answer(204);
    else await clock.advance(sessionLiveBounds.postRetryMs);
  }
  return { posts: plane.posts, reader };
}

/**
 * The invariant the brief names, over drawn credentials, texts, cuts and
 * plane answers: every text sent of a block, taken or not, is the scrubbed
 * whole block's text at its offset, no reader is left gapped, and a plane
 * that ends up taking posts holds all of the last message before its end.
 */
test("everything sent of a block is how the scrubbed whole block begins, whatever comes next", async () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = seeded(seed);
    const secrets = drawnSecrets(random);
    const held = holding(...secrets);
    const messages = drawnTurn(random, secrets);
    const whole = new Map(
      messages.map(({ id, blocks }) => [
        id,
        blocks.map(({ text }) => held.scrub(text ?? "")),
      ]),
    );
    const named = `seed ${String(seed)}`;

    const { posts, reader } = await streamedTurn(random, messages, held);

    for (const { events } of posts)
      for (const { live, message, index, offset, text } of events)
        if (live === "Text")
          assert.equal(
            text,
            whole.get(message)[index].slice(offset, offset + text.length),
            `${named} sent what the store does not hold`,
          );
    assert.deepEqual(posts.at(-1).events.at(-1), end, named);
    assert.deepEqual(reader.held(), liveNothing, named);
    const last = reader.states.at(-2);
    assert.equal(last.message, messages.at(-1).id, named);
    assert.deepEqual(
      last.blocks.map((block) => block.text),
      whole.get(last.message),
      `${named} ended before the plane held the last message`,
    );
  }
});
