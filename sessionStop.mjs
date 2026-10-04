/**
 * The stop a member puts on the turn a thread's session is answering: the
 * plane is asked whether the turn was stopped for as long as the turn runs,
 * and the runtime is interrupted once it says so.
 *
 * THE PLANE HOLDS THE QUESTION, so a stop is heard when the plane next looks
 * and not when this next asks. A question answered with nothing is asked again
 * no sooner than the mailbox's own pause after it began: a hold the plane
 * spent is followed at once, and a plane holding nothing is asked no more
 * often than an empty mailbox is.
 *
 * A STOP INTERRUPTS THE TURN IT NAMES AND NO OTHER. The session lets go of a
 * turn when it reads the turn's result, which abandons the question in
 * flight, and an answer read after that interrupts nothing: the turn after
 * cannot be the one interrupted.
 *
 * NOTHING HERE SETTLES THE TURN OR ENDS THE SESSION. An interrupted turn ends
 * with the runtime's own result and is settled as that result says, which the
 * plane takes and keeps nothing of; `stopped` is how the session knows the
 * result it read is such a turn's. A plane that could not be asked is asked
 * again, and one that answers anything else has decided, so this session asks
 * it nothing more.
 */

import { sessionPlaneRoutes } from "@chuggy/worker-contract/sessionPlane";

/** How long one question may go unanswered before it is asked again, a default the watch's opener may replace. */
export const sessionStopBounds = Object.freeze({ askDeadlineMs: 60_000 });

const stoppedStatus = 200;
const runningStatus = 204;
const serverErrorStatusMin = 500;

/**
 * What the plane made of one question about `held`: its turn was stopped, it
 * was not for as long as the plane held the question, the plane could not be
 * asked, or it answered anything else.
 */
async function stopAsked(watch, held) {
  try {
    const response = await watch.request(
      watch.task,
      watch.bearer,
      sessionPlaneRoutes.turnStopped.path,
      {
        method: sessionPlaneRoutes.turnStopped.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn: held.turn }),
      },
      { deadlineMs: watch.bounds.askDeadlineMs, signal: held.letGo.signal },
    );
    if (response.status === stoppedStatus)
      return (await response.json())?.turn === held.turn
        ? "Stopped"
        : "Refused";
    await response.body?.cancel();
    if (response.status === runningStatus) return "Running";
    return response.status < serverErrorStatusMin ? "Refused" : "Unavailable";
  } catch {
    return "Unavailable";
  }
}

/** The runtime interrupted for a turn its member stopped, and said so once. */
async function stopInterrupted(watch, held) {
  watch.stopped = held.turn;
  try {
    watch.warn(`turn ${held.turn} was stopped by its member\n`);
    await watch.interrupt();
  } catch (failure) {
    watch.warn(
      `the runtime could not be interrupted: ${failure instanceof Error ? failure.message : String(failure)}\n`,
    );
  }
}

/** The questions asked of one turn, until it is let go of, stopped, or the plane decides against the asking. */
async function stopWatched(watch, held) {
  while (watch.held === held && watch.asking) {
    const began = watch.now();
    const answer = await stopAsked(watch, held);
    if (watch.held !== held) return;
    if (answer === "Stopped") return stopInterrupted(watch, held);
    if (answer === "Refused") {
      watch.asking = false;
      return;
    }
    const rest = watch.task.bounds.mailboxPollMs - (watch.now() - began);
    if (rest > 0) await watch.pause(rest);
  }
}

/**
 * The watch a thread's session holds. `watching` takes the turn the session
 * has just claimed and `released` is told its result was read or its session
 * is over; neither waits for the plane, and nothing here raises into its
 * caller. `stopped` says whether the plane said `turn` was stopped while the
 * session held it. `interrupt` is the runtime's own.
 */
export function sessionStopWatch(task, bearer, services) {
  const { request, now, pause, interrupt, warn } = services;
  const watch = {
    task,
    bearer,
    request,
    now,
    pause,
    interrupt,
    warn,
    bounds: { ...sessionStopBounds, ...services.bounds },
    held: undefined,
    stopped: undefined,
    asking: true,
  };
  const released = () => {
    const held = watch.held;
    watch.held = undefined;
    held?.letGo.abort();
  };
  return {
    watching(turn) {
      released();
      if (!watch.asking) return;
      const held = { turn, letGo: new globalThis.AbortController() };
      watch.held = held;
      stopWatched(watch, held).catch(() => {
        watch.asking = false;
      });
    },
    released,
    stopped: (turn) => turn !== undefined && watch.stopped === turn,
  };
}
