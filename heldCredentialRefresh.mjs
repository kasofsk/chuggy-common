/**
 * The held credentials an attempt was served with an expiry, asked of the
 * worker plane again ahead of it and rewritten in place while the attempt runs.
 *
 * THE PATHS AND VARIABLES NEVER CHANGE. A job's shells and agent keep the
 * environment they started with and re-read a file for its current value, so
 * a refresh rewrites the same files, each by a name beside it and a rename.
 * A refresh that would hand a variable another value than the first delivery
 * did is one no shell can take, and stops that credential's refreshing.
 *
 * NO REFRESH ENDS THE ATTEMPT. A job that no longer needs a credential is not
 * killed for it. A refresh the plane never answered is asked again here, on
 * this module's clock and not the transport's, with a growing pause until the
 * credential expires or the retries run out, and then logged once with the
 * last failure. One the plane refused or answered with an absence is its
 * answer, logged once and not asked again. Either way that credential is
 * refreshed no more.
 *
 * Each new secret is handed to `keep` before any file is written, as at the
 * first delivery.
 */

import { WorkerPlaneRefusal } from "./transport.mjs";
import {
  heldCredentialPlaced,
  heldCredentialPlacedWritten,
  heldCredentialsAsked,
} from "./heldCredentials.mjs";

/** How long before a credential's expiry it is first asked for again. */
export const heldCredentialRefreshLeadMs = 600_000;

/** The shortest time between two asks for one credential. */
export const heldCredentialRefreshIntervalMsMin = 15_000;

/** The longest pause before a failed refresh is asked again. */
export const heldCredentialRefreshBackoffMsMax = 120_000;

/** The most times one refresh that failed is asked again. */
export const heldCredentialRefreshRetriesMax = 6;

/**
 * How long from `nowMs` the first ask for a credential expiring at
 * `expiresAtMs` waits: until the lead before its expiry, and never less than
 * the shortest interval.
 */
export function heldCredentialRefreshDelayMs(expiresAtMs, nowMs) {
  return Math.max(
    expiresAtMs - heldCredentialRefreshLeadMs - nowMs,
    heldCredentialRefreshIntervalMsMin,
  );
}

/**
 * How long a refresh that has failed `failures` times waits before it is
 * asked again, or `undefined` where it is not: the retries are spent, or the
 * ask would fall at or after `expiresAtMs`.
 */
export function heldCredentialRefreshRetryDelayMs(
  failures,
  expiresAtMs,
  nowMs,
) {
  if (failures > heldCredentialRefreshRetriesMax) return undefined;
  const delayMs = Math.min(
    heldCredentialRefreshIntervalMsMin * 2 ** (failures - 1),
    heldCredentialRefreshBackoffMsMax,
  );
  return nowMs + delayMs < expiresAtMs ? delayMs : undefined;
}

/** Whether `placed` hands each variable the value `held` handed it, and no other. */
function heldCredentialRefreshSame(placed, held) {
  return (
    placed.length === held.length &&
    placed.every((each) =>
      held.some(
        (first) =>
          first.variable === each.variable && first.value === each.value,
      ),
    )
  );
}

/**
 * One ask for `credential`: where the plane serves it with the variables
 * `held` gives, `{placed, expiresAtMs}`, the expiry being `undefined` where it
 * serves none; otherwise `{stopped}`, the line saying why it is refreshed no
 * more. Anything the ask raised is raised.
 */
async function heldCredentialRefreshAsked(
  credential,
  held,
  attempt,
  { request, signal },
) {
  const answered = await heldCredentialsAsked({
    task: attempt.task,
    bearer: attempt.bearer,
    asked: [credential],
    signal,
    transport: { once: true },
    ...(request === undefined ? {} : { request }),
  });
  const served = answered.credentials.find(
    (each) => each.credential === credential,
  );
  if (served === undefined) {
    const absent = answered.absent.find(
      (each) => each.credential === credential,
    );
    return {
      stopped: `the worker plane served no held credential ${credential} on its refresh: ${absent?.reason ?? "it named no reason"}; it is refreshed no more\n`,
    };
  }
  const placed = heldCredentialPlaced(served, attempt.directory);
  if (!heldCredentialRefreshSame(placed.held, held))
    return {
      stopped: `the worker plane refreshed the held credential ${credential} with variables the job's shells were not started with; it is refreshed no more\n`,
    };
  return { placed, expiresAtMs: served.expiresAtMs };
}

/**
 * `heldCredentialRefreshAsked`'s answer, its files written through
 * `refreshing`'s seams unless its refreshing stopped while it was asked, and
 * the write held in `refreshing.writing` until it ends.
 */
async function heldCredentialRefreshWritten(
  credential,
  held,
  attempt,
  refreshing,
) {
  const { request, seams, aborting, writing } = refreshing;
  const answered = await heldCredentialRefreshAsked(credential, held, attempt, {
    request,
    signal: aborting.signal,
  });
  if (!refreshing.stopped && answered.placed !== undefined) {
    const written = heldCredentialPlacedWritten(answered.placed, seams);
    writing.add(written);
    try {
      await written;
    } finally {
      writing.delete(written);
    }
  }
  return answered;
}

/**
 * What follows a refresh of `credential` that has failed `failures` times,
 * the last with `failure`: `{delayMs}` until it is asked again, or `{line}`,
 * logged once, where it is not.
 */
function heldCredentialRefreshFailed(
  credential,
  failure,
  failures,
  expiresAtMs,
  nowMs,
) {
  const delayMs = heldCredentialRefreshRetryDelayMs(
    failures,
    expiresAtMs,
    nowMs,
  );
  if (delayMs !== undefined) return { delayMs };
  return {
    line: `the held credential ${credential} could not be refreshed: ${heldCredentialRefreshFailure(failure)}; it is refreshed no more\n`,
  };
}

/** What `failure` says. */
function heldCredentialRefreshFailure(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * One ask for `credential` set on `refreshing`'s timers `delayMs` from now,
 * its `failures` so far counted, and what follows it set in turn: another ask
 * ahead of the expiry it is served with, a retry, or a line logged.
 */
function heldCredentialRefreshScheduled(
  refreshing,
  { credential, held, expiresAtMs, failures },
  delayMs,
) {
  const { attempt, services, timers } = refreshing;
  const ask = async () => {
    let answered;
    try {
      answered = await heldCredentialRefreshWritten(
        credential,
        held,
        attempt,
        refreshing,
      );
    } catch (failure) {
      if (refreshing.stopped) return;
      if (failure instanceof WorkerPlaneRefusal) {
        services.warn(
          `the worker plane refused the held credential ${credential} its refresh: ${failure.message}; it is refreshed no more\n`,
        );
        return;
      }
      const failed = heldCredentialRefreshFailed(
        credential,
        failure,
        failures + 1,
        expiresAtMs,
        services.now(),
      );
      if (failed.line !== undefined) services.warn(failed.line);
      else
        heldCredentialRefreshScheduled(
          refreshing,
          { credential, held, expiresAtMs, failures: failures + 1 },
          failed.delayMs,
        );
      return;
    }
    if (refreshing.stopped) return;
    if (answered.stopped !== undefined) services.warn(answered.stopped);
    else if (answered.expiresAtMs !== undefined)
      heldCredentialRefreshScheduled(
        refreshing,
        { credential, held, expiresAtMs: answered.expiresAtMs, failures: 0 },
        heldCredentialRefreshDelayMs(answered.expiresAtMs, services.now()),
      );
  };
  timers.set(
    credential,
    services.setTimeout(() => {
      timers.delete(credential);
      return ask();
    }, delayMs),
  );
}

/**
 * Each of `expiring`, as `heldCredentials` hands it, refreshed ahead of its
 * expiry under `attempt`'s task and bearer into its `directory`, its secrets
 * handed to its `keep`. `services` are the plane's `request`, the file seams
 * `write` and `makeDirectory`, `warn`, and the clock: `now`, `setTimeout` and
 * `clearTimeout`, a timer's callback answering the ask it begins. What it
 * answers stops every timer, aborts any ask in flight and waits only for a
 * write already under way, and never raises; an answer arriving after it is
 * called writes nothing.
 */
export function keepHeldCredentialsFresh(expiring, attempt, services = {}) {
  const { request, write, makeDirectory } = services;
  const refreshing = {
    attempt,
    request,
    seams: {
      keep: attempt.keep,
      ...(write === undefined ? {} : { write }),
      ...(makeDirectory === undefined ? {} : { makeDirectory }),
    },
    services: {
      now: services.now ?? Date.now,
      setTimeout: services.setTimeout ?? globalThis.setTimeout,
      clearTimeout: services.clearTimeout ?? globalThis.clearTimeout,
      warn: services.warn ?? ((text) => process.stderr.write(text)),
    },
    timers: new Map(),
    aborting: new globalThis.AbortController(),
    writing: new Set(),
    stopped: false,
  };
  for (const { credential, held, expiresAtMs } of expiring)
    heldCredentialRefreshScheduled(
      refreshing,
      { credential, held, expiresAtMs, failures: 0 },
      heldCredentialRefreshDelayMs(expiresAtMs, refreshing.services.now()),
    );
  return async () => {
    refreshing.stopped = true;
    for (const timer of refreshing.timers.values())
      refreshing.services.clearTimeout(timer);
    refreshing.timers.clear();
    refreshing.aborting.abort();
    await Promise.allSettled([...refreshing.writing]);
  };
}
