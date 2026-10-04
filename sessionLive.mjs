/**
 * What a thread's session reports of the message its model is writing: the
 * runtime's stream events folded into that message's blocks, and the posts
 * that carry them to the plane as the contract's live events.
 *
 * A post is computed from what the plane acknowledged rather than queued, so
 * one the plane did not take is sent again from there and a slow plane grows
 * nothing here. Text is sent only as far as `credentialScrubHead` has settled
 * it, because the store scrubs a block that is whole and this sends one in
 * pieces before it is.
 */

import {
  jsonTextBytes,
  sessionLiveBlockCharsMax,
  sessionLiveBlockKinds,
  sessionLiveEventSchema,
  sessionLiveEventsMax,
  sessionLiveTextBytesMax,
  sessionPlaneRoutes,
} from "@chuggy/worker-contract/sessionPlane";

import { sessionStopped } from "./sessionTransport.mjs";
import { rosterLabel } from "./wire.mjs";

const [textKind, thinkingKind, toolUseKind] = [
  "Text",
  "Thinking",
  "ToolUse",
].map((label) => rosterLabel(sessionLiveBlockKinds, label));

/** The kind a live event names each of the runtime's blocks as. A block of any other type is not reported. */
const liveBlockKinds = new Map([
  ["text", textKind],
  ["thinking", thinkingKind],
  ["redacted_thinking", thinkingKind],
  ["tool_use", toolUseKind],
  ["server_tool_use", toolUseKind],
  ["mcp_tool_use", toolUseKind],
]);

/**
 * The bounds a sender posts under, each a default its opener may replace: the
 * least time between the starts of two posts, how long one may take, how long
 * the next waits after one the plane could not take, and how many in a row it
 * may not take before the turn's stream stops.
 */
export const sessionLiveBounds = Object.freeze({
  postGapMsMin: 50,
  postDeadlineMs: 2_000,
  postRetryMs: 1_000,
  postFailuresMax: 5,
});

const acknowledgedStatus = 204;
const serverErrorStatusMin = 500;
const highSurrogateMin = 0xd800;
const highSurrogateMax = 0xdbff;
const jsonQuotesBytes = jsonTextBytes("");

/** Whether `event` is one the contract's route takes. */
function liveEventTaken(event) {
  return sessionLiveEventSchema.safeParse(event).success;
}

/** What is held of the turn being reported: the message its model is writing, and that message's blocks in the order they began. */
export function sessionLiveState(turn) {
  return {
    turn,
    message: undefined,
    blocks: new Map(),
    ended: false,
    finished: false,
  };
}

/**
 * More of a text block's text. Text that would pass what a live block holds
 * stops the block's stream instead: what is held is then no longer how the
 * block begins, so nothing more of it is sent.
 */
function liveHeardAppended(block, text) {
  if (block.raw.length + text.length > sessionLiveBlockCharsMax)
    block.stopped = true;
  else block.raw += text;
}

/**
 * A block that began, held where the contract takes the event that begins it:
 * of a type that is reported, under a message and a tool name the event can
 * carry, and at an index it can name, which is what bounds how many are held.
 * One that begins again replaces what was held at its index.
 */
function liveHeardBegun(state, event, scrub) {
  const { index, content_block: block } = event;
  state.blocks.delete(index);
  const kind = liveBlockKinds.get(block?.type);
  const named = kind === toolUseKind && typeof block.name === "string";
  const begun = {
    live: "Block",
    message: state.message,
    index,
    kind,
    ...(named ? { name: scrub(block.name) } : {}),
  };
  if (!liveEventTaken(begun)) return;
  const held = {
    begun,
    raw: "",
    whole: false,
    acknowledged: undefined,
    stopped: false,
  };
  state.blocks.set(index, held);
  if (kind === textKind && typeof block.text === "string")
    liveHeardAppended(held, block.text);
}

/** One delta of a block: more text where it is a text block's text, and nothing where it is anything else. */
function liveHeardWritten(block, delta) {
  if (block?.begun.kind !== textKind) return false;
  if (delta?.type !== "text_delta" || typeof delta.text !== "string")
    return false;
  liveHeardAppended(block, delta.text);
  return true;
}

/**
 * One stream event of `turn` folded into `state`, and whether it may have left
 * anything to post. A turn other than the one held replaces it, keeping
 * nothing of it, and a new message replaces the blocks of the last. `scrub` is
 * what the store passes every string through, which a message's identity and
 * a tool's name are.
 */
export function sessionLiveHeard(state, turn, event, scrub) {
  if (typeof turn !== "string") return false;
  if (state.turn !== turn) Object.assign(state, sessionLiveState(turn));
  if (state.ended) return false;
  switch (event?.type) {
    case "message_start": {
      const id = event.message?.id;
      state.message = typeof id === "string" ? scrub(id) : undefined;
      state.blocks = new Map();
      return false;
    }
    case "content_block_start":
      liveHeardBegun(state, event, scrub);
      return state.blocks.has(event.index);
    case "content_block_delta":
      return liveHeardWritten(state.blocks.get(event.index), event.delta);
    case "content_block_stop":
      if (!state.blocks.has(event.index)) return false;
      state.blocks.get(event.index).whole = true;
      return true;
    case "message_stop":
      for (const block of state.blocks.values()) block.whole = true;
      return true;
    default:
      return false;
  }
}

/** The result of `turn` was read: once what remains of it is posted, its end is. A turn that is not the one held has no end to post, as no turn has none. */
export function sessionLiveEnded(state, turn) {
  if (turn === undefined || state.turn !== turn || state.ended) return false;
  state.ended = true;
  return true;
}

/**
 * As much of a block's text as may be sent now: all of it scrubbed once the
 * block is whole, and until then the head no later text changes, ending on a
 * whole character.
 */
function livePostBlockDue(block, held) {
  if (block.whole) return held.scrub(block.raw);
  const settled = held.scrubHead(block.raw);
  const last = settled.charCodeAt(settled.length - 1);
  return last >= highSurrogateMin && last <= highSurrogateMax
    ? settled.slice(0, -1)
    : settled;
}

/** The longest head of `text`, in whole characters, that one event's text may weigh. */
function livePostEventText(text) {
  let bytes = jsonQuotesBytes;
  let chars = 0;
  for (const character of text) {
    bytes += jsonTextBytes(character) - jsonQuotesBytes;
    if (bytes > sessionLiveTextBytesMax) break;
    chars += character.length;
  }
  return text.slice(0, chars);
}

/**
 * One block's part of a post, as far as the post has room. A block the plane
 * has not been told of begins, as does one it holds text of that is no longer
 * the head of what may be sent. Text the contract refuses is not sent, nor is
 * any of the block after it.
 */
function livePostBlock(post, block, held) {
  if (block.stopped) return;
  const room = () => post.events.length < sessionLiveEventsMax;
  const due = livePostBlockDue(block, held);
  let sent = block.acknowledged;
  if (sent === undefined || !due.startsWith(sent)) {
    if (!room()) return;
    post.events.push(block.begun);
    sent = "";
  }
  const { message, index } = block.begun;
  while (sent.length < due.length && room()) {
    const text = livePostEventText(due.slice(sent.length));
    const written = { live: "Text", message, index, offset: sent.length, text };
    if (!liveEventTaken(written)) break;
    post.events.push(written);
    sent += text;
  }
  post.acknowledging.push([block, sent]);
}

/**
 * The next post of the turn held: the events that move the plane from what it
 * acknowledged to what may be sent now, block by block in the order they
 * began, and then the turn's end once it has ended. Each block fills the post
 * before the next adds to it, so a post with room for the end already carries
 * all that remained. Nothing where the plane holds it all.
 *
 * `held` is the session's `scrub` and `scrubHead`, asked as the post is built
 * rather than as the text arrived, so a credential learned in between is one
 * this post already leaves out.
 */
export function sessionLivePost(state, held) {
  if (state.finished) return undefined;
  const post = {
    turn: state.turn,
    events: [],
    acknowledging: [],
    ending: false,
  };
  for (const block of state.blocks.values()) livePostBlock(post, block, held);
  if (state.ended && post.events.length < sessionLiveEventsMax) {
    post.events.push({ live: "End" });
    post.ending = true;
  }
  return post.events.length === 0 ? undefined : post;
}

/**
 * What is held once the plane has taken `post`. A block that is no longer the
 * one held at its index is acknowledged to no effect, and the end of a turn
 * that is no longer the one held finishes nothing.
 */
export function sessionLiveAcknowledged(state, post) {
  for (const [block, text] of post.acknowledging) block.acknowledged = text;
  if (post.ending && state.turn === post.turn) state.finished = true;
}

/** What the plane made of one post, asked once and its body left unread. Every answer but the first is a post it did not take. */
async function liveSenderAnswer(sender, post) {
  try {
    const response = await sender.request(
      sender.task,
      sender.bearer,
      sessionPlaneRoutes.turnLive.path,
      {
        method: sessionPlaneRoutes.turnLive.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn: post.turn, events: post.events }),
      },
      { deadlineMs: sender.bounds.postDeadlineMs },
    );
    await response.body?.cancel();
    if (response.status === acknowledgedStatus) return "Acknowledged";
    if (sessionStopped(response)) return "Stopped";
    return response.status < serverErrorStatusMin ? "Refused" : "Unavailable";
  } catch {
    return "Unavailable";
  }
}

/**
 * What one post's answer leaves. A plane that stopped the session closes the
 * stream for it. One that refused the post, or has taken none for the bound,
 * finishes the stream of the turn the post was of, where that is still the
 * turn held. One that could not take it is asked again after the retry wait,
 * with whatever the acknowledged state then makes the next post.
 */
function liveSenderSettled(sender, post, answer) {
  if (answer === "Acknowledged") {
    sessionLiveAcknowledged(sender.state, post);
    sender.failures = 0;
    return;
  }
  sender.lost += 1;
  if (answer === "Stopped") {
    sender.open = false;
    return;
  }
  if (answer === "Unavailable") {
    sender.failures += 1;
    sender.notBefore = sender.now() + sender.bounds.postRetryMs;
  }
  if (sender.state.turn !== post.turn) return;
  if (answer === "Refused" || sender.failures >= sender.bounds.postFailuresMax)
    sender.state.finished = true;
}

/** `act`, where the sender is open. A fault of this module's own closes it instead of reaching the session. */
function liveSenderGuarded(sender, act) {
  if (!sender.open) return;
  try {
    act();
  } catch {
    sender.open = false;
    sender.faulted = true;
  }
}

/**
 * One step taken again once `waitMs` has passed, where no such wait is already
 * running. A pause that fails is a fault rather than a wait that ended, or
 * every step would begin the next at once.
 */
function liveSenderWake(sender, waitMs) {
  if (sender.waking) return;
  sender.waking = true;
  const woken = (act) => () => {
    sender.waking = false;
    liveSenderGuarded(sender, act);
  };
  sender.pause(waitMs).then(
    woken(() => liveSenderStep(sender)),
    woken(() => {
      throw new Error("the pause failed");
    }),
  );
}

/**
 * The next post sent, where the sender is open, there is one and none is in
 * flight, or the wait until one may be. Every post waits out the gap, an ended
 * turn's among them, so the gap and what a post holds bound what a plane is
 * sent in any stretch of time.
 */
function liveSenderStep(sender) {
  if (!sender.open || sender.flying) return;
  const waitMs = sender.notBefore - sender.now();
  if (waitMs > 0) {
    liveSenderWake(sender, waitMs);
    return;
  }
  const post = sessionLivePost(sender.state, sender.held);
  if (post === undefined) return;
  sender.flying = true;
  sender.asked += 1;
  sender.notBefore = sender.now() + sender.bounds.postGapMsMin;
  liveSenderAnswer(sender, post).then((answer) => {
    sender.flying = false;
    liveSenderGuarded(sender, () => {
      liveSenderSettled(sender, post, answer);
      liveSenderStep(sender);
    });
  });
}

/**
 * The sender a thread's session holds. `heard` and `ended` take what the
 * session read and return, and the posts go behind them, one in flight at a
 * time: no turn waits for one, and nothing here raises into its caller.
 * `close` ends it with the session, leaving a post in flight to its own
 * deadline and saying once what the plane did not take.
 */
export function sessionLiveSender(task, bearer, services) {
  const { request, now, pause, scrub, scrubHead, warn } = services;
  const sender = {
    task,
    bearer,
    request,
    now,
    pause,
    held: { scrub, scrubHead },
    bounds: { ...sessionLiveBounds, ...services.bounds },
    state: sessionLiveState(undefined),
    open: true,
    faulted: false,
    flying: false,
    waking: false,
    notBefore: 0,
    failures: 0,
    asked: 0,
    lost: 0,
  };
  return {
    heard(turn, event) {
      liveSenderGuarded(sender, () => {
        if (sessionLiveHeard(sender.state, turn, event, sender.held.scrub))
          liveSenderStep(sender);
      });
    },
    ended(turn) {
      liveSenderGuarded(sender, () => {
        if (sessionLiveEnded(sender.state, turn)) liveSenderStep(sender);
      });
    },
    close() {
      sender.open = false;
      try {
        if (sender.lost > 0)
          warn(
            `the worker plane did not take ${String(sender.lost)} of ${String(sender.asked)} live posts\n`,
          );
        if (sender.faulted) warn("the live stream stopped on its own fault\n");
      } catch {
        // A warning that cannot be written is not the session's failure.
      }
    },
  };
}
