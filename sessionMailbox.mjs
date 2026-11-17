/**
 * The session's mailbox: the long-poll claim against the worker plane, and the
 * async iterable of user messages it feeds one `query()`.
 *
 * ONE TURN IS IN FLIGHT AT A TIME, and the generator is what enforces it. After
 * yielding a turn it blocks until the pod says that turn settled, so the runtime
 * cannot be handed a second turn while the first is still being answered — and
 * so nothing belonging to a later turn can arrive while the pod is draining the
 * current one's messages.
 *
 * BOTH LOOPS ARE BOUNDED. One request is bounded by the plane's own long poll,
 * and the loop as a whole by the plane's `Stop` and, where the pod was launched
 * with one, its idle bound: a mailbox that stays empty that long ends the
 * iterable, the query ends with it, and the process exits for the scheduler's
 * idle reaper to collect.
 *
 * A CLAIM IS ANNOUNCED BEFORE THE TURN IS YIELDED, which is what lets the pod
 * set up anything a turn owns, such as the watch for its member's stop, before
 * the runtime reads it.
 *
 * THE IDLE WINDOW OPENS ON THE FIRST EMPTY POLL, NOT WHEN THE POD STARTED. A
 * cold session pages a resumed store and spawns a runtime before this loop is
 * asked for anything, and a startup slower than the bound would then end the
 * iterable on its first look at an empty mailbox. Idle is time the session spent
 * with nothing to do, so it is measured from the first moment it had nothing to
 * do, and a claim closes the window again. Nor is time idle while `busy` says
 * the session holds something that wakes it, a thread's job host
 * (`./jobHost.mjs`) among them: the window stays shut for as long as it does.
 *
 * A TURN NEVER RUNS ONE OF THE RUNTIME'S OWN COMMANDS. The runtime reads a
 * message that opens with a slash and a name as a command for itself rather
 * than as text for its model, and `/clear` starts a new conversation under a
 * new session id, which a session named by one reference written once can
 * never honour. Such a message is marked `client_composed`, the runtime's own
 * way of delivering one message as written, so the model reads it as the text
 * it is. That mark also skips the context the runtime attaches at a turn's
 * start, so it is set on nothing else: a first word holding a slash of its own
 * is a path, which the runtime reads as text already.
 */

import { setTimeout as wait } from "node:timers/promises";

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";

import { sessionRequest, sessionStopped } from "./sessionTransport.mjs";

const claimedStatus = 200;
const emptyStatus = 204;

/**
 * Whether the runtime may read `input` as one of its own commands: a slash,
 * then a first word with no slash in it.
 */
function sessionUserMessageReadsAsCommand(input) {
  const name = /^\s*\/(\S+)/u.exec(input)?.[1];
  return name !== undefined && !name.includes("/");
}

/** One claimed turn as the runtime's streaming input takes it. */
export function sessionUserMessage(input) {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: input },
    ...(sessionUserMessageReadsAsCommand(input)
      ? { client_composed: true }
      : {}),
  };
}

/** Whether a mailbox empty for `idleForMs` has outlasted its idle bound, which it has not where it has none. */
function sessionMailboxIdled(bounds, idleForMs) {
  return bounds.idleMs !== undefined && idleForMs >= bounds.idleMs;
}

/** One long poll of the mailbox: the turn it handed over, `Stop`, or nothing where it is empty. */
async function sessionMailboxClaim(task, bearer, request) {
  const response = await request(task, bearer, sessionPlaneRoutes.turn.path, {
    method: "GET",
  });
  if (sessionStopped(response) || response.status === emptyStatus)
    return sessionStopped(response) ? "Stop" : undefined;
  if (response.status !== claimedStatus)
    throw new Error(`the session mailbox answered ${String(response.status)}`);
  return response.json();
}

export function sessionMailbox(task, bearer, services = {}) {
  const {
    request = sessionRequest,
    wait: pause = wait,
    now = Date.now,
    claim: onClaim = () => undefined,
    settle: onSettle = () => undefined,
    busy = () => false,
  } = services;
  let held;
  let stopped = false;
  let release = () => undefined;
  let released = Promise.resolve();
  let idleSince;

  /** Blocks the generator until the turn settles. */
  function hold() {
    released = new Promise((resolve) => {
      release = resolve;
    });
  }

  return {
    claimed: () => held,

    /** What the pod calls once a turn is answered or failed, releasing the next. */
    settled() {
      held = undefined;
      onSettle();
      release();
    },

    /** What ends the iterable, and with it the query, without another claim. */
    stop() {
      stopped = true;
      release();
    },

    async *turns() {
      for (;;) {
        await released;
        if (stopped) return;
        const turn = await sessionMailboxClaim(task, bearer, request);
        if (turn === "Stop") return;
        if (turn === undefined) {
          idleSince = busy() ? undefined : (idleSince ?? now());
          if (
            idleSince !== undefined &&
            sessionMailboxIdled(task.bounds, now() - idleSince)
          )
            return;
          await pause(task.bounds.mailboxPollMs);
          continue;
        }
        held = turn;
        idleSince = undefined;
        onClaim(turn);
        hold();
        yield sessionUserMessage(turn.input);
      }
    },
  };
}
