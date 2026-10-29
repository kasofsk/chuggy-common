import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  runTranscriptPage,
  transcriptEntryPreviewCharsMax,
  transcriptEntryTypesOmitted,
  transcriptPageAnswer,
} from "./transcriptPage.mjs";

const bytesMax = 4_096;
const fits = (text) => Buffer.byteLength(text) <= bytesMax;

/** One page as the route answers it: entries of one store batch, and the next batch. */
function pageOf(entries, nextAfter) {
  return {
    stream: "s-1",
    entries,
    held: ["u-1", "u-2"],
    elided: 0,
    truncated: false,
    ...(nextAfter === undefined ? {} : { nextAfter }),
  };
}

function entryOf(index, bytes) {
  return {
    uuid: `u-${String(index)}`,
    type: "assistant",
    timestamp: "2026-09-04T12:00:00.000Z",
    message: { role: "assistant", content: "x".repeat(bytes) },
  };
}

/** The whole of one store batch, read the way a caller reads it: page after page. */
function walked(page, pagesMax = 64) {
  const read = [];
  const previews = [];
  let cursor = { after: 0, entry: 0 };
  for (let taken = 0; taken < pagesMax; taken += 1) {
    const text = transcriptPageAnswer(page, cursor, fits);
    assert.ok(fits(text), `page ${String(taken)} is over the bound`);
    const answer = JSON.parse(text);
    for (const entry of answer.entries)
      if (entry.preview === undefined) read.push(entry);
      else previews.push(entry);
    if (answer.next === undefined) return { read, previews, pages: taken + 1 };
    cursor = answer.next;
  }
  assert.fail("the walk did not terminate");
}

test("one batch larger than an answer is read whole, page by page, under the bound", () => {
  const entries = Array.from({ length: 89 }, (_, index) => entryOf(index, 700));

  const { read, pages } = walked(pageOf(entries));

  assert.ok(pages > 1, "a batch over the bound was answered in one page");
  assert.deepEqual(
    read.map(({ uuid }) => uuid),
    entries.map(({ uuid }) => uuid),
  );
});

test("a page that fits whole names no next and ends the walk", () => {
  const { read, pages } = walked(pageOf([entryOf(1, 8), entryOf(2, 8)]));

  assert.equal(pages, 1);
  assert.equal(read.length, 2);
});

test("the cursor moves to the route's next batch once a page is exhausted", () => {
  const answer = JSON.parse(
    transcriptPageAnswer(pageOf([entryOf(1, 8)], 12), { after: 4 }, fits),
  );

  assert.deepEqual(answer.next, { after: 12, entry: 0 });
});

test("an entry larger than any answer is given as a marked preview and the walk goes on", () => {
  const entries = [entryOf(1, 40), entryOf(2, bytesMax * 2), entryOf(3, 40)];

  const { read, previews, pages } = walked(pageOf(entries));

  assert.equal(pages, 3);
  assert.deepEqual(
    read.map(({ uuid }) => uuid),
    ["u-1", "u-3"],
  );
  assert.equal(previews.length, 1);
  assert.equal(previews[0].uuid, "u-2");
  assert.equal(previews[0].type, "assistant");
  assert.ok(previews[0].bytes > bytesMax);
  assert.ok(previews[0].preview.length <= transcriptEntryPreviewCharsMax);
  assert.ok(
    previews[0].preview.startsWith('{"uuid":"u-2"'),
    "the preview is not the head of the entry",
  );
});

test("a preview is cut to what the answer has room for rather than to its ceiling", () => {
  const page = pageOf([entryOf(1, bytesMax * 2)]);
  page.stream = "s".repeat(bytesMax - transcriptEntryPreviewCharsMax);

  const text = transcriptPageAnswer(page, { after: 0, entry: 0 }, fits);

  assert.ok(fits(text), "a preview at its ceiling went out over the bound");
  const [preview] = JSON.parse(text).entries;
  assert.ok(preview.preview.length > 0, "nothing of the entry was shown");
  assert.ok(
    preview.preview.length < transcriptEntryPreviewCharsMax,
    "the preview was not cut below its ceiling",
  );
});

test("the page's own facts are carried and its held set is narrowed to the entries given", () => {
  const page = pageOf([entryOf(1, 8), entryOf(2, 8)]);
  page.held = ["u-2", "u-9"];

  const answer = JSON.parse(
    transcriptPageAnswer(page, { after: 0, entry: 1 }, fits),
  );

  assert.equal(answer.stream, "s-1");
  assert.equal(answer.elided, 0);
  assert.equal(answer.truncated, false);
  assert.deepEqual(
    answer.entries.map(({ uuid }) => uuid),
    ["u-2"],
  );
  assert.deepEqual(
    answer.held,
    ["u-2"],
    "the held set names entries this answer did not give",
  );
});

/**
 * The window the two cursors open between them: an entry heavy enough that the
 * answer carrying it is over the bound once the wider cursor naming the next
 * batch is composed onto it, and light enough that the same entry with this
 * page's own cursor still fits. It is a function of the bound, of what
 * `entryOf` and `pageOf` weigh and of what the two cursors differ by, so it is
 * measured here rather than written down — a window written down drifts to
 * covering nothing when any of them changes.
 */
const windowNextAfter = 65_536;
const windowCursorBytes =
  Buffer.byteLength(JSON.stringify({ after: windowNextAfter, entry: 0 })) -
  Buffer.byteLength(JSON.stringify({ after: 0, entry: 1 }));
const windowAnswerBytes = (bytes) =>
  Buffer.byteLength(
    transcriptPageAnswer(
      pageOf([entryOf(1, bytes)], windowNextAfter),
      { after: 0, entry: 0 },
      () => true,
    ),
  );
const windowFixedBytes = windowAnswerBytes(0);

test("an entry that fits under this page's own cursor is given whole rather than previewed", () => {
  assert.equal(
    windowAnswerBytes(1) - windowFixedBytes,
    1,
    "an entry's bytes are not what the answer carrying it grows by",
  );
  assert.ok(windowCursorBytes > 0, "the two cursors weigh the same");

  for (
    let bytes = bytesMax - windowFixedBytes + 1;
    bytes <= bytesMax - windowFixedBytes + windowCursorBytes;
    bytes += 1
  ) {
    const page = pageOf([entryOf(1, bytes)], windowNextAfter);

    const text = transcriptPageAnswer(page, { after: 0, entry: 0 }, fits);

    assert.ok(
      fits(text),
      `an entry of ${String(bytes)} answered over the bound`,
    );
    const answer = JSON.parse(text);
    assert.deepEqual(
      answer.entries,
      [entryOf(1, bytes)],
      `an entry of ${String(bytes)} was not answered whole`,
    );
    assert.deepEqual(
      answer.next,
      { after: 0, entry: 1 },
      `an entry of ${String(bytes)} answered a cursor that does not move`,
    );

    const beyond = JSON.parse(transcriptPageAnswer(page, answer.next, fits));
    assert.deepEqual(beyond.entries, [], String(bytes));
    assert.deepEqual(beyond.next, { after: windowNextAfter, entry: 0 });
  }
});

test("a cursor past the page's entries answers none and does not name itself again", () => {
  const answer = JSON.parse(
    transcriptPageAnswer(pageOf([entryOf(1, 8)]), { after: 0, entry: 9 }, fits),
  );

  assert.deepEqual(answer.entries, []);
  assert.equal(answer.next, undefined);
});

/** One batch of a run's transcript as its route answers it, holding `content`. */
function runBatchOf(batch, content) {
  return {
    batch,
    recordedAt: "2026-10-22T12:00:00.000Z",
    bytes: Buffer.byteLength(content),
    read: "Content",
    content,
  };
}

test("a run page's lines are its entries in order, a line that is not JSON kept as its text, and a batch with nothing to read counted as elided", () => {
  const page = runTranscriptPage({
    batches: [
      runBatchOf(
        1,
        '{"type":"system","uuid":"r-1"}\n{"type":"assistant","uuid":"r-2"}\n',
      ),
      {
        batch: 2,
        recordedAt: "2026-10-22T12:00:01.000Z",
        bytes: 9,
        read: "Missing",
      },
      runBatchOf(3, "Claude Code exited 1\n"),
      {
        batch: 4,
        recordedAt: "2026-10-22T12:00:02.000Z",
        bytes: 9,
        read: "Corrupt",
      },
    ],
    observedAt: "2026-10-22T12:00:05.000Z",
    complete: true,
  });

  assert.deepEqual(page, {
    observedAt: "2026-10-22T12:00:05.000Z",
    complete: true,
    entries: [
      { type: "system", uuid: "r-1" },
      { type: "assistant", uuid: "r-2" },
      "Claude Code exited 1",
    ],
    elided: 2,
  });
});

test("a run page names the route's next batch, and a run still writing reads on after the page's last until a page finds nothing past it", () => {
  const batches = [runBatchOf(3, "{}\n"), runBatchOf(4, "{}\n")];

  assert.equal(
    runTranscriptPage({ batches, complete: true, nextAfter: 4 }).nextAfter,
    4,
  );
  assert.equal(
    runTranscriptPage({ batches, complete: true }).nextAfter,
    undefined,
  );
  assert.equal(runTranscriptPage({ batches, complete: false }).nextAfter, 4);
  assert.equal(
    runTranscriptPage({ batches: [], complete: false }).nextAfter,
    undefined,
  );

  const read = JSON.parse(
    transcriptPageAnswer(
      runTranscriptPage({ batches, complete: false }),
      { after: 2, entry: 0 },
      fits,
    ),
  );
  assert.equal(read.entries.length, 2);
  assert.deepEqual(read.next, { after: 4, entry: 0 });
  const caughtUp = JSON.parse(
    transcriptPageAnswer(
      runTranscriptPage({ batches: [], complete: false }),
      read.next,
      fits,
    ),
  );
  assert.deepEqual(caughtUp.entries, []);
  assert.equal(caughtUp.next, undefined);
});

/** A run's init event as the runtime writes it: what it says of the run, and the runtime's own lists beside it. */
const runInit = {
  type: "system",
  subtype: "init",
  uuid: "i-1",
  session_id: "s-1",
  cwd: "/work",
  model: "claude-opus-5-5",
  tools: ["Bash", "Edit", "Read"],
  mcp_servers: [{ name: "chuggy", status: "connected" }],
  slash_commands: Array.from(
    { length: 40 },
    (_, at) => `command-${String(at)}`,
  ),
  skills: Array.from({ length: 20 }, (_, at) => `skill-${String(at)}`),
  plugins: [{ name: "plugin", path: "/plugins/plugin" }],
  agents: ["general-purpose"],
  apiKeySource: "none",
  claude_code_version: "2.1.0",
  permissionMode: "bypassPermissions",
};

const runRateLimit = (uuid) => ({
  type: "rate_limit_event",
  uuid,
  rate_limit_info: { status: "allowed", resetsAt: 1_761_739_200 },
  session_id: "s-1",
});

const runThinking = (uuid, bytes) => ({
  type: "assistant",
  uuid,
  message: {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "x".repeat(bytes),
        signature: "E".repeat(600),
      },
      { type: "text", text: "editing" },
    ],
  },
});

/** A run's first batch: its init, thinking under signatures, and rate-limit events between them. */
const runEntries = [
  runInit,
  runRateLimit("l-1"),
  runThinking("t-1", 300),
  runRateLimit("l-2"),
  runThinking("t-2", 300),
  runRateLimit("l-3"),
  runThinking("t-3", 300),
];

test("a thinking block goes out without its signature and with the rest of its message", () => {
  const answer = JSON.parse(
    transcriptPageAnswer(
      pageOf(runEntries),
      { after: 0, entry: 0 },
      () => true,
    ),
  );

  const thought = answer.entries.find(({ uuid }) => uuid === "t-1");
  assert.deepEqual(thought.message.content, [
    { type: "thinking", thinking: "x".repeat(300) },
    { type: "text", text: "editing" },
  ]);
  assert.ok(
    !JSON.stringify(answer).includes('"signature"'),
    "a signature went out",
  );
});

test("the init entry goes out as its model, working directory and tools' names alone", () => {
  const answer = JSON.parse(
    transcriptPageAnswer(
      pageOf(runEntries),
      { after: 0, entry: 0 },
      () => true,
    ),
  );

  assert.deepEqual(answer.entries[0], {
    type: "system",
    subtype: "init",
    uuid: "i-1",
    cwd: "/work",
    model: "claude-opus-5-5",
    tools: ["Bash", "Edit", "Read"],
  });
});

test("a rate-limit event is left out and counted, and the cursor still counts the page as the route answered it", () => {
  assert.ok(transcriptEntryTypesOmitted.includes("rate_limit_event"));
  const whole = JSON.parse(
    transcriptPageAnswer(
      pageOf(runEntries),
      { after: 0, entry: 0 },
      () => true,
    ),
  );
  assert.deepEqual(
    whole.entries.map(({ uuid }) => uuid),
    ["i-1", "t-1", "t-2", "t-3"],
  );
  assert.deepEqual(whole.omitted, { rate_limit_event: 3 });

  const oneThought = Buffer.byteLength(
    JSON.stringify(pageOf([], undefined)) +
      JSON.stringify(runThinking("t-1", 300)),
  );
  const narrow = (text) => Buffer.byteLength(text) <= oneThought + 128;
  const read = [];
  let pages = 0;
  let cursor = { after: 0, entry: 0 };
  while (pages < runEntries.length) {
    pages += 1;
    const text = transcriptPageAnswer(pageOf(runEntries), cursor, narrow);
    assert.ok(narrow(text), `page ${String(pages)} is over the bound`);
    const answer = JSON.parse(text);
    const span = runEntries.slice(
      cursor.entry,
      answer.next?.entry ?? runEntries.length,
    );
    assert.deepEqual(
      answer.entries.map(({ uuid }) => uuid),
      span
        .filter(({ type }) => type !== "rate_limit_event")
        .map(({ uuid }) => uuid),
      `page ${String(pages)} did not answer the entries its cursors span`,
    );
    const left = span.length - answer.entries.length;
    assert.deepEqual(
      answer.omitted,
      left === 0 ? undefined : { rate_limit_event: left },
      `page ${String(pages)} did not count what it left out`,
    );
    read.push(...answer.entries.map(({ uuid }) => uuid));
    if (answer.next === undefined) break;
    cursor = answer.next;
  }

  assert.deepEqual(read, ["i-1", "t-1", "t-2", "t-3"]);
  assert.ok(pages > 1, "the page was not read across answers");
});

test("an entry after a left-out one that fits only without `omitted` beside it is answered whole by the next answer", () => {
  const edit = {
    type: "assistant",
    uuid: "e-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "e".repeat(400) }],
    },
  };
  const entries = [runRateLimit("l-1"), edit];
  const alone = Buffer.byteLength(
    transcriptPageAnswer(pageOf([edit]), { after: 0, entry: 0 }, () => true) +
      ',"next":{"after":0,"entry":2}',
  );
  const tight = (text) => Buffer.byteLength(text) <= alone;
  const answers = [];
  let cursor = { after: 0, entry: 0 };
  while (answers.length < entries.length) {
    const text = transcriptPageAnswer(pageOf(entries), cursor, tight);
    assert.ok(
      tight(text),
      `answer ${String(answers.length + 1)} is over the bound`,
    );
    const answer = JSON.parse(text);
    answers.push(answer);
    if (answer.next === undefined) break;
    cursor = answer.next;
  }

  assert.deepEqual(answers[0].entries, []);
  assert.deepEqual(answers[0].omitted, { rate_limit_event: 1 });
  assert.deepEqual(answers[0].next, { after: 0, entry: 1 });
  assert.deepEqual(answers.at(-1).entries, [edit]);
  assert.equal(answers.at(-1).next, undefined);
});
