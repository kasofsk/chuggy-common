import assert from "node:assert/strict";
import test from "node:test";

import { workerRunContextSchema } from "@chuggy/worker-contract/workerPlane";

import {
  claudeControlChannel,
  claudeControlRefusal,
  claudeControlWaitMs,
} from "./claudeControl.mjs";
import { contextWindow } from "./contextReading.mjs";
import { contextUsage } from "./contextUsage.fixture.mjs";

/** A process's stdin as the channel writes it: each line kept, and each write a signal. */
function standInInput() {
  const lines = [];
  const waiting = [];
  const handlers = {};
  return {
    lines,
    ended: false,
    on(event, handler) {
      handlers[event] = handler;
    },
    write(text) {
      lines.push(JSON.parse(text));
      waiting.shift()?.(lines.at(-1));
    },
    end() {
      this.ended = true;
    },
    /** The next line written. */
    next: () => new Promise((resolve) => waiting.push(resolve)),
    broken: () => handlers.error?.(new Error("EPIPE")),
  };
}

/** A pause that ends when the suite says, each one asked for kept. */
function signalledPause() {
  const asked = [];
  const ends = [];
  return {
    asked,
    pause: (milliseconds) => {
      asked.push(milliseconds);
      return new Promise((resolve) => ends.push(resolve));
    },
    end: () => ends.shift()?.(),
  };
}

/** A channel on a stand-in stdin, its readings kept and its turns as the suite sets them. */
function channelled() {
  const input = standInInput();
  const readings = [];
  const evidence = { turns: 0 };
  const paused = signalledPause();
  const channel = claudeControlChannel(input, {
    evidence: {
      turnsFolded: () => evidence.turns,
      context: (reading) => readings.push(reading),
    },
    scrub: (text) => text,
    pause: paused.pause,
  });
  return { input, readings, evidence, paused, channel };
}

const init = { type: "system", subtype: "init" };
const result = { type: "result", subtype: "success" };
const boundary = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: {
    trigger: "auto",
    pre_tokens: 167_000,
    post_tokens: 9_000,
  },
};

function answered(request, response) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.request_id,
      response,
    },
  };
}

function refused(request) {
  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: request.request_id,
      error: "no",
    },
  };
}

test("the brief is the run's first message, as a user message", () => {
  const { input, channel } = channelled();

  channel.brief("the briefing");

  assert.deepEqual(input.lines, [
    {
      type: "user",
      message: { role: "user", content: "the briefing" },
    },
  ]);
});

test("a run's window is read at its start, after a compaction and at its end, each as a summary", async () => {
  const { input, readings, evidence, channel } = channelled();
  const window = contextWindow(contextUsage, (text) => text);

  let asked = input.next();
  channel.observed(init);
  const start = await asked;
  assert.equal(start.type, "control_request");
  assert.deepEqual(start.request, {
    subtype: "get_context_usage",
    detail: "summary",
  });
  assert.equal(channel.control(answered(start, contextUsage)), true);

  evidence.turns = 3;
  asked = input.next();
  channel.observed(boundary);
  const compacted = await asked;
  channel.control(answered(compacted, contextUsage));

  evidence.turns = 5;
  asked = input.next();
  channel.observed(result);
  const end = await asked;
  assert.equal(input.ended, false);
  channel.control(answered(end, contextUsage));
  await channel.settled();

  assert.deepEqual(readings, [
    { cause: "Start", afterTurn: 0, window },
    {
      cause: "Compaction",
      afterTurn: 3,
      compaction: {
        trigger: "Auto",
        tokensBefore: 167_000,
        tokensAfter: 9_000,
      },
      window,
    },
    { cause: "End", afterTurn: 5, window },
  ]);
  assert.ok(
    workerRunContextSchema.safeParse({
      readings: readings.map((reading, at) => ({
        ...reading,
        ordinal: at + 1,
      })),
    }).success,
  );
  assert.equal(input.ended, true);
});

test("an answer that errors leaves a start or end reading out, and a compaction's reading keeps its facts", async () => {
  const { input, readings, channel } = channelled();

  let asked = input.next();
  channel.observed(init);
  channel.control(refused(await asked));
  asked = input.next();
  channel.observed(boundary);
  channel.control(refused(await asked));
  asked = input.next();
  channel.observed(result);
  channel.control(refused(await asked));
  await channel.settled();

  assert.deepEqual(readings, [
    {
      cause: "Compaction",
      afterTurn: 0,
      compaction: {
        trigger: "Auto",
        tokensBefore: 167_000,
        tokensAfter: 9_000,
      },
    },
  ]);
  assert.equal(input.ended, true);
});

/** Catches a request the runtime never answers keeping stdin open, which would keep the run from ending. */
test("a request never answered is left out once its bound is waited out, and stdin still closes", async () => {
  const { input, readings, paused, channel } = channelled();

  const asked = input.next();
  channel.observed(result);
  await asked;
  assert.equal(input.ended, false);
  paused.end();
  await channel.settled();

  assert.deepEqual(paused.asked, [claudeControlWaitMs]);
  assert.deepEqual(readings, []);
  assert.equal(input.ended, true);
});

test("a stream that ends with a request out settles it unanswered, without waiting out its bound", async () => {
  const { input, readings, channel } = channelled();

  const asked = input.next();
  channel.observed(init);
  await asked;
  channel.ended();
  await channel.settled();

  assert.deepEqual(readings, []);
  assert.equal(input.ended, true);
});

/** Catches a permission prompt or hook callback left unanswered, which a run would wait on forever. */
test("a request the runtime sends the core is answered with an error, and is no part of the run's stream", async () => {
  const { input, channel } = channelled();

  const asked = input.next();
  const handled = channel.control({
    type: "control_request",
    request_id: "cli-1",
    request: { subtype: "can_use_tool", tool_name: "Bash" },
  });

  assert.equal(handled, true);
  assert.deepEqual(await asked, {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "cli-1",
      error: claudeControlRefusal,
    },
  });
  assert.equal(channel.control(init), false);
  assert.equal(channel.control(result), false);
});

test("an answer to no request out is the channel's and changes nothing", () => {
  const { readings, channel } = channelled();

  assert.equal(
    channel.control(answered({ request_id: "stale" }, contextUsage)),
    true,
  );
  assert.deepEqual(readings, []);
});

test("a broken stdin is written to no further, and asks nothing", async () => {
  const { input, readings, channel } = channelled();

  input.broken();
  channel.observed(init);
  channel.observed(result);
  await channel.settled();

  assert.deepEqual(input.lines, []);
  assert.deepEqual(readings, []);
});

test("only the first result ends the process's readings", async () => {
  const { input, channel } = channelled();

  const asked = input.next();
  channel.observed(result);
  channel.control(refused(await asked));
  await channel.settled();
  channel.observed(result);
  await channel.settled();

  assert.equal(
    input.lines.filter(({ type }) => type === "control_request").length,
    1,
  );
});
