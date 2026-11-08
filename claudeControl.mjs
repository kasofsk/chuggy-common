/**
 * A Claude run's control channel: the process's stdin, which carries the brief
 * as the run's first user message and the core's control requests, and the
 * control messages its stream carries back.
 *
 * THE WINDOW IS READ AT EACH PROCESS'S START, AFTER EACH COMPACTION AND AT ITS
 * END, one request at a time in the order they were asked for, each with
 * `detail: 'summary'`. A compaction's reading carries its facts whatever the
 * answer; any other reading is the answer, and there is none without one.
 *
 * NOTHING ON IT HOLDS THE RUN. A request not answered within
 * `claudeControlWaitMs`, answered with an error, or still out when the stream
 * ends is left out. A request the runtime sends the core is answered with an
 * error, since a headless run has no one to ask. Stdin is closed once the
 * process's result has arrived and its end reading has settled, which is what
 * ends the process.
 */

import { setTimeout as wait } from "node:timers/promises";

import { runContextReadingsMax } from "@chuggy/worker-contract/workerPlane";

import {
  contextCompacted,
  contextCompaction,
  contextWindow,
} from "./contextReading.mjs";

/** How long the runtime is given to answer one control request. */
export const claudeControlWaitMs = 5_000;

/** What a request the runtime sends the core is answered with. */
export const claudeControlRefusal = "a chuggy run answers no control request";

const claudeContextAsked = { subtype: "get_context_usage", detail: "summary" };

/** `text` as the user message Claude Code's `stream-json` input takes. */
function claudeUserLine(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

/** A wait that keeps nothing alive. */
function claudeControlPause(milliseconds) {
  return wait(milliseconds, undefined, { ref: false });
}

/**
 * The channel on `input`, a process's stdin, its readings handed to
 * `evidence` with each text passed through `scrub`. `pause` is how a request's
 * bound is waited out.
 */
export function claudeControlChannel(
  input,
  { evidence, scrub, pause = claudeControlPause },
) {
  const state = {
    open: true,
    asked: 0,
    queued: 0,
    pending: undefined,
    ended: false,
    reading: Promise.resolve(),
  };
  // A process that has exited breaks the pipe; what would have been written
  // is then left unsaid, as a closed channel's is.
  input.on("error", () => {
    state.open = false;
  });
  const write = (message) => {
    if (state.open) input.write(`${JSON.stringify(message)}\n`);
  };
  const close = () => {
    state.pending?.resolve(undefined);
    if (!state.open) return;
    state.open = false;
    input.end();
  };
  const ask = () => claudeControlAsked(state, write, pause);
  const read = (cause, facts) =>
    claudeControlRead(state, { evidence, scrub, ask }, cause, facts);
  return {
    /** The run's brief, or what a resumed one is told, as its first message. */
    brief(text) {
      if (state.open) input.write(`${claudeUserLine(text)}\n`);
    },
    /** Whether `event` is the channel's own traffic, which is answered here and is no part of the run's stream. */
    control(event) {
      return claudeControlAnswered(state, write, event);
    },
    /** `event` of the run's stream, read for what it asks of the window. */
    observed(event) {
      if (event?.type === "system" && event.subtype === "init")
        read("Start", {});
      else if (contextCompacted(event)) {
        const compaction = contextCompaction(event);
        read("Compaction", compaction === undefined ? {} : { compaction });
      } else if (event?.type === "result" && !state.ended) {
        state.ended = true;
        read("End", {});
        state.reading = state.reading.then(() => close());
      }
    },
    /** The stream is over, so nothing still out will be answered. */
    ended: close,
    /** Every reading asked for, taken or left out. */
    settled: () => state.reading,
  };
}

/** The window as the runtime answers for it, or nothing where it does not answer within its bound. */
async function claudeControlAsked(state, write, pause) {
  if (!state.open) return undefined;
  state.asked += 1;
  const id = `chuggy-context-${String(state.asked)}`;
  const answered = new Promise((resolve) => {
    state.pending = { id, resolve };
  });
  write({
    type: "control_request",
    request_id: id,
    request: claudeContextAsked,
  });
  const usage = await Promise.race([
    answered,
    pause(claudeControlWaitMs).then(() => undefined),
  ]);
  state.pending = undefined;
  return usage;
}

/**
 * A reading of the window queued behind every one asked for before it, after
 * the turns folded as it is asked for, while the run's readings are still
 * taken. Nothing it meets is raised, since evidence never fails a run.
 */
function claudeControlRead(state, { evidence, scrub, ask }, cause, facts) {
  if (state.queued >= runContextReadingsMax) return;
  state.queued += 1;
  const afterTurn = evidence.turnsFolded();
  state.reading = state.reading.then(async () => {
    try {
      const usage = await ask();
      const window =
        usage === undefined ? undefined : contextWindow(usage, scrub);
      if (window === undefined && cause !== "Compaction") return;
      evidence.context({
        cause,
        afterTurn,
        ...facts,
        ...(window === undefined ? {} : { window }),
      });
    } catch {
      // The reading is left out.
    }
  });
}

/** Whether `event` was control traffic, answering the runtime's own requests with an error. */
function claudeControlAnswered(state, write, event) {
  switch (event?.type) {
    case "control_response": {
      const { response } = event;
      if (
        state.pending !== undefined &&
        response?.request_id === state.pending.id
      )
        state.pending.resolve(
          response.subtype === "success" ? response.response : undefined,
        );
      return true;
    }
    case "control_request":
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: event.request_id,
          error: claudeControlRefusal,
        },
      });
      return true;
    case "control_cancel_request":
      return true;
    default:
      return false;
  }
}
