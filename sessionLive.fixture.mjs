/**
 * What the live suites hold a sender to: the runtime's stream events as a case
 * writes them, a plane whose answers a case chooses, a clock a case moves, and
 * the reader a plane's own fold makes of what was posted.
 *
 * THE READER IS WRITTEN HERE BECAUSE THE PACK DOES NOT CARRY IT. The worker
 * contract ships the live events and not `threadLiveHeard`, the fold the plane
 * reads them with, so `liveHeard` is that fold again: a sender is right when
 * this reader is never left with a block it missed text of. The fold takes a
 * post it has already heard as nothing new, because a post the sender gave up
 * on can still arrive after the one sent in its place.
 */

import { setImmediate } from "node:timers";

import { sessionTurnLiveSchema } from "@chuggy/worker-contract/sessionPlane";

/** One event of the runtime's stream, as `query()` yields it under `includePartialMessages`. */
export const streamed = (event, parent = null) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: parent,
  session_id: "runtime-1",
});

export const messageStart = (id) => ({
  type: "message_start",
  message: { id, type: "message", role: "assistant", content: [] },
});
export const blockStart = (index, block) => ({
  type: "content_block_start",
  index,
  content_block: block,
});
export const textStart = (index) =>
  blockStart(index, { type: "text", text: "" });
export const textDelta = (index, text) => ({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text },
});
export const blockStop = (index) => ({ type: "content_block_stop", index });
export const messageStop = { type: "message_stop" };

/** Every pending promise step run, which is every post a plane answered at once. */
export const settled = () => new Promise((resolve) => setImmediate(resolve));

export const liveNothing = { blocks: [] };

/**
 * A text block once more of its text is heard, gapped where the text does not
 * join what is held. Text the block already holds at its offset changes
 * nothing, which is a post heard again after a later one.
 */
function liveTextHeard(block, event) {
  if (block === undefined)
    return { index: event.index, kind: "Text", text: "", gapped: true };
  if (block.gapped || block.kind !== "Text" || event.offset > block.text.length)
    return { ...block, text: "", gapped: true };
  if (block.text.startsWith(event.text, event.offset)) return block;
  return { ...block, text: block.text.slice(0, event.offset) + event.text };
}

/** A block once it is said to begin: the one held where that is whole and the same block, and otherwise an empty one. */
function liveBlockHeard(block, event) {
  const same =
    block !== undefined &&
    !block.gapped &&
    block.kind === event.kind &&
    block.name === event.name;
  if (same) return block;
  return {
    index: event.index,
    kind: event.kind,
    ...(event.name === undefined ? {} : { name: event.name }),
    text: "",
    gapped: false,
  };
}

/** What a reader holds once `event` of `turn` is heard. */
export function liveHeard(held, turn, event) {
  if (event.live === "End") return held.turn === turn ? liveNothing : held;
  const blocks =
    held.turn === turn && held.message === event.message ? held.blocks : [];
  const block = blocks.find(({ index }) => index === event.index);
  const heard =
    event.live === "Block"
      ? liveBlockHeard(block, event)
      : liveTextHeard(block, event);
  return {
    turn,
    message: event.message,
    blocks: [
      ...blocks.filter((block) => block.index !== event.index),
      heard,
    ].sort((left, right) => left.index - right.index),
  };
}

/**
 * A reader of posts. `states` is what it held after each event, and a post
 * the contract's route would refuse, or an event that leaves a block gapped,
 * raises: neither is anything a sender may do.
 */
export function liveReader() {
  const states = [liveNothing];
  return {
    states,
    held: () => states.at(-1),
    posted(body) {
      const { turn, events } = sessionTurnLiveSchema.parse(body);
      for (const event of events) {
        const held = liveHeard(states.at(-1), turn, event);
        if (held.blocks.some((block) => block.gapped))
          throw new Error(
            `a reader was left gapped by ${JSON.stringify(event)}`,
          );
        states.push(held);
      }
    },
  };
}

/**
 * A plane that takes live posts and answers each when the case says. `posts`
 * is every body asked, `asked` what each was asked under, and `answer` settles
 * the oldest one in flight with a status and the body it carries, or with a
 * raise where it is given an error.
 */
export function livePlane() {
  const posts = [];
  const asked = [];
  const flying = [];
  return {
    posts,
    asked,
    flying: () => flying.length,
    request: (task, bearer, path, init, transport) =>
      new Promise((resolve, reject) => {
        asked.push({ task, bearer, path, method: init.method, transport });
        posts.push(JSON.parse(init.body));
        flying.push({ resolve, reject });
      }),
    async answer(status = 204, body = undefined) {
      const { resolve, reject } = flying.shift();
      if (status instanceof Error) reject(status);
      else resolve({ status, json: async () => body });
      await settled();
    },
  };
}

/** A clock that moves only when a case moves it, and the pauses that end as it passes them. */
export function liveClock() {
  let time = 0;
  let waits = [];
  return {
    now: () => time,
    waiting: () => waits.map(({ at }) => at - time),
    pause: (milliseconds) =>
      new Promise((resolve) => {
        waits.push({ at: time + milliseconds, resolve });
      }),
    async advance(milliseconds) {
      time += milliseconds;
      const due = waits.filter(({ at }) => at <= time);
      waits = waits.filter(({ at }) => at > time);
      for (const { resolve } of due) resolve();
      await settled();
    },
  };
}
