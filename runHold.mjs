/**
 * Whether a run the account's usage limit stopped waits the limit out and
 * carries on, and what one that does not says about it.
 *
 * A HOLD IS TAKEN ONLY ON WHAT WAS DECLARED. The window's reset is the frame's
 * and the session is the result's, each read from its field. Where either is
 * missing, or the agent cannot resume a conversation, the run ends as any
 * failed run does, and its text says why it was not held.
 *
 * A HOLD SPENDS THE RUN'S OWN TIME. The run is resumed a margin after the
 * reset, so a clock that disagrees does not resume it into the same refusal,
 * and is held only where that leaves it a reserve to finish in before its
 * deadline, counted from whichever is later, the reset or now. A launch that
 * names no deadline is never held, since nothing could say the wait fits.
 *
 * A WRITE CREDENTIAL LEFT ON DISK FORBIDS A HOLD. A hold's keep mints one, and
 * a resumed agent can read what that left. Where it could not be removed the
 * run ends.
 *
 * THE HOLDS OF ONE RUN ARE BOUNDED. A run refused again once resumed may hold
 * again, up to `runHoldsMax`.
 */

import { rateLimited } from "./rateLimit.mjs";

/** How long past a window's reset a held run is resumed. */
export const runHoldMarginMs = 60_000;

/** What a hold must leave the run before its deadline, once it is resumed. */
export const runHoldReserveMs = 1_800_000;

/** The most holds one run takes. */
export const runHoldsMax = 3;

/** The instant `epochMs` names, as an error text and a transcript line say it. */
export function runHoldInstant(epochMs) {
  return new Date(epochMs).toISOString();
}

/** The instant a run resumes at, where the frames said when the window reopens. */
function runHoldUntilMs(reset) {
  return reset.resetsAtSecs * 1_000 + runHoldMarginMs;
}

/** Why a limit that stopped a run is not waited out, or nothing where it is. */
function runHoldRefusal({
  resumable,
  reset,
  session,
  nowMs,
  deadlineMs,
  holds,
  credentialLeft,
}) {
  if (!resumable) return "this agent cannot resume a conversation";
  if (reset === undefined) return "the frames gave no reset time";
  if (typeof session !== "string" || session.length === 0)
    return "the result gave no session to resume";
  if (deadlineMs === undefined) return "this launch names no deadline";
  if (Math.max(nowMs, runHoldUntilMs(reset)) + runHoldReserveMs >= deadlineMs)
    return `the run's deadline at ${runHoldInstant(deadlineMs)} leaves no time to finish after the reset`;
  if (holds >= runHoldsMax)
    return `the run has already held ${String(holds)} times`;
  if (credentialLeft === true)
    return "the push's write credential could not be removed";
  return undefined;
}

/**
 * What a run that ended without a verdict does about the limit: nothing where
 * no limit stopped it, `{untilMs, window}` where it waits, and otherwise
 * `{refused, reset}`, why it does not and what the frames said.
 */
export function runHoldDecided({
  resumable,
  sightings,
  session,
  nowMs,
  deadlineMs,
  holds,
  credentialLeft,
}) {
  if (!rateLimited(sightings)) return undefined;
  const { reset } = sightings;
  const refused = runHoldRefusal({
    resumable,
    reset,
    session,
    nowMs,
    deadlineMs,
    holds,
    credentialLeft,
  });
  return refused === undefined
    ? { untilMs: runHoldUntilMs(reset), window: reset.window }
    : { refused, reset };
}

/**
 * The error text of a run that ended without a verdict: `stopped`, how its
 * process ended; `sentence`, what the runtime said of it, scrubbed; and for a
 * limit `decided` did not wait out, which window, when it reopens and why.
 */
export function runEndedText(stopped, sentence, decided) {
  const reset = decided?.reset;
  return [
    stopped,
    ...(typeof sentence === "string" && sentence.length > 0 ? [sentence] : []),
    ...(reset === undefined
      ? []
      : [
          `The ${reset.window ?? "account's"} limit resets at ${runHoldInstant(reset.resetsAtSecs * 1_000)}.`,
        ]),
    ...(decided === undefined
      ? []
      : [`The run was not held: ${decided.refused}.`]),
  ].join("\n");
}
