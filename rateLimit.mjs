/**
 * Whether the runtime's own frames said the account was held rather than that
 * the work failed. A work attempt's run evidence and a session pod's turn both
 * read it, so a rate limit is one fact with one reading.
 *
 * IT READS DECLARED FIELDS, NEVER TEXT. `@anthropic-ai/claude-agent-sdk`'s
 * `sdk.d.ts` declares two frames that name a hold, each with a closed set of
 * values:
 *
 *   `SDKRateLimitEvent` — `{type:"rate_limit_event", rate_limit_info:{status}}`,
 *     the status being `allowed`, `allowed_warning` or `rejected`.
 *   `SDKAssistantMessage` — `{type:"assistant", error}`, the error being one of
 *     a closed set that includes `rate_limit`, which is what the runtime sets
 *     when the provider refused the request.
 *
 * A SUBSTRING MATCH READ NEITHER, which is why kasofsk/chuggy#386 was filed. The
 * label this replaces looked for `rate_limit` inside the result's `subtype` and
 * `stop_reason`; neither field's declared values contain it, and the run the
 * issue reports carried `terminal_reason: "api_error"` with the rejection on a
 * frame nothing looked at. A run the provider refused was charged a retry the
 * work never spent.
 *
 * `terminal_reason: "api_error"` IS NOT READ, though the issue quotes it. It is
 * the generic arm: the runtime dispatches it on an error kind, and the
 * rate-limited kind is the `error` field above, so `api_error` adds no case the
 * assistant frame does not already carry. Reading it alone — or beside a
 * rate-limit frame of any status, since one is emitted whenever the information
 * changes — would price every API error as a hold and leave the retry budget
 * unenforceable.
 *
 * EXHAUSTED CREDITS ARE THE SAME FRAME'S `billing_error`, which the same
 * closed set declares and the runtime sets where the account has no credit
 * left. It is no hold: no window reopens. Codex declares exhausted credits
 * only for a ChatGPT workspace, as a snapshot's `rate_limit_reached_type`
 * of `workspace_owner_credits_depleted` or `workspace_member_credits_depleted`.
 * An API key's exhausted balance is `usage_limit_exceeded`, as is a used-up
 * quota, so it is never read as exhausted credits.
 *
 * THE LATEST STATUS IS THE ONE THAT COUNTS, for that same reason: a run rejected
 * at one point and allowed again later was not being held when it ended.
 *
 * THE FRAME'S TYPE IS HALF OF WHAT `error` MEANS. `SDKAPIRetryMessage` —
 * `{type:"system", subtype:"api_retry", error}` — carries the same closed set on
 * the same field name and says the opposite thing: the request is being retried,
 * not refused. So the assistant arm is guarded on `type`, and a rate-limited
 * retry the runtime recovered from is not a hold.
 *
 * A REJECTED FRAME SAYS WHEN THE WINDOW REOPENS, as `resetsAt`, in Unix seconds,
 * and which window as `rateLimitType`. Only a rejected frame's are read, since
 * an allowed frame names a window that is refusing nothing, and a later status
 * drops them. The sentence the runtime writes for a person is never parsed.
 *
 * CODEX'S ROLLOUT IS A SECOND SOURCE OF DECLARED FIELDS, read from the file its
 * run persisted rather than from the stream, whose `--json` output carries an
 * error's message alone. Codex's `protocol.rs` declares both:
 *
 *   `RateLimitSnapshot` — a `token_count`'s `rate_limits`, with windows
 *     `primary` and `secondary`, each `{used_percent, window_minutes,
 *     resets_at}`, and `rate_limit_reached_type`. The last snapshot counts: a
 *     limit names a reached type or a window used up.
 *   `CodexErrorInfo` — a `task_complete`'s `error.codex_error_info`, which is
 *     `usage_limit_exceeded` for every refusal that means the account cannot
 *     run now, whatever the snapshot carried. It names no reset.
 *
 * The reset is the latest a full window names. The sentence Codex writes is
 * never parsed: its time is in its own process's zone and names none.
 *
 * READINGS ARE KEPT APART FROM REFUSALS. How much of each window the account
 * has used is the plane's to act on before a refusal, so it is folded on its
 * own: a hold does not clear it and a session does not carry it. Each window
 * keeps the latest reading seen, and a reading the contract would refuse is
 * dropped rather than sent. Claude's come from a rate-limit frame's
 * `rate_limit_info.unifiedWindows`, which `sdk.d.ts` does not declare: it is
 * read as a field, shape-checked, as fractions where one is the whole window.
 * The declared top-level `utilization` is not read, since nothing establishes
 * its scale. Codex's come from the last snapshot, each window named by its
 * length, its `used_percent` scaled to a fraction and dated by its line's
 * `timestamp`.
 */

import {
  runUsageInstantSecsMax,
  runUsageUtilizationMax,
  runUsageWindows,
} from "@chuggy/worker-contract/workerPlane";

const rateLimitEventType = "rate_limit_event";
const rateLimitRejectedStatus = "rejected";
const assistantMessageType = "assistant";
const rateLimitErrorKind = "rate_limit";
const creditsExhaustedErrorKind = "billing_error";

const codexUsageLimitErrorInfo = "usage_limit_exceeded";
const codexCreditsDepletedTypes = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
]);
const codexUsedPercentFull = 100;
const codexTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** Codex's windows by their length in minutes, under the names Claude's frames give them. */
const codexWindowNames = new Map([
  [300, "five_hour"],
  [10_080, "seven_day"],
]);

/** What has been seen so far, which until a frame says otherwise is nothing. */
export function rateLimitSightings() {
  return {
    status: undefined,
    refused: false,
    reset: undefined,
    creditsExhausted: false,
  };
}

/** When the window a frame's `info` refuses reopens and which it is, or nothing where it refuses none or does not say. */
function rateLimitResetOf(info) {
  const { status, resetsAt, rateLimitType } = info;
  if (status !== rateLimitRejectedStatus || !rateLimitResetsAtBounded(resetsAt))
    return undefined;
  return {
    resetsAtSecs: resetsAt,
    window: typeof rateLimitType === "string" ? rateLimitType : undefined,
  };
}

/** Whether a Unix second is one a reset can be. */
function rateLimitResetsAtBounded(resetsAtSecs) {
  return (
    Number.isFinite(resetsAtSecs) &&
    resetsAtSecs > 0 &&
    resetsAtSecs <= runUsageInstantSecsMax
  );
}

/** Folds one runtime frame into the sightings it may carry. */
export function observeRateLimit(sightings, event) {
  if (event?.type === rateLimitEventType) {
    const info = event.rate_limit_info;
    if (typeof info?.status === "string") {
      sightings.status = info.status;
      sightings.reset = rateLimitResetOf(info);
    }
    return sightings;
  }
  if (event?.type !== assistantMessageType) return sightings;
  if (event.error === rateLimitErrorKind) sightings.refused = true;
  if (event.error === creditsExhaustedErrorKind)
    sightings.creditsExhausted = true;
  return sightings;
}

/** The windows of a Codex snapshot that are used up. */
function codexWindowsFull(snapshot) {
  return [snapshot?.primary, snapshot?.secondary].filter(
    (window) => window?.used_percent >= codexUsedPercentFull,
  );
}

/** When the latest full window of a Codex snapshot that names a reset reopens, and which it is. */
function codexResetOf(snapshot) {
  const latest = codexWindowsFull(snapshot)
    .filter((window) => rateLimitResetsAtBounded(window.resets_at))
    .reduce(
      (held, window) =>
        held === undefined || window.resets_at > held.resets_at ? window : held,
      undefined,
    );
  if (latest === undefined) return undefined;
  return {
    resetsAtSecs: latest.resets_at,
    window: codexWindowNames.get(latest.window_minutes),
  };
}

/**
 * Folds what a Codex rollout declared — `snapshot`, its last `token_count`'s
 * `rate_limits`, and `errorInfo`, its `task_complete`'s `codex_error_info` —
 * into the sightings, where it says the account was refused, and whether a
 * workspace's credits were depleted.
 */
export function observeCodexRollout(sightings, { snapshot, errorInfo }) {
  const reached =
    typeof snapshot?.rate_limit_reached_type === "string" ||
    codexWindowsFull(snapshot).length > 0;
  if (!reached && errorInfo !== codexUsageLimitErrorInfo) return sightings;
  sightings.refused = true;
  if (codexCreditsDepletedTypes.has(snapshot?.rate_limit_reached_type))
    sightings.creditsExhausted = true;
  sightings.reset = codexResetOf(snapshot);
  return sightings;
}

/** Whether what was seen says the provider was refusing the account. */
export function rateLimited(sightings) {
  return (
    sightings?.refused === true || sightings?.status === rateLimitRejectedStatus
  );
}

/** Whether what was seen says the account's credits are exhausted. */
export function creditsExhausted(sightings) {
  return sightings?.creditsExhausted === true;
}

/** The latest reading of each window, which until a frame gives one is none. */
export function rateLimitReadings() {
  return {};
}

/** A Unix second floored to a whole one the contract takes, or nothing where it is none. */
export function rateLimitInstantSecs(secs) {
  const whole = Number.isFinite(secs) ? Math.floor(secs) : 0;
  return whole >= 1 && whole <= runUsageInstantSecsMax ? whole : undefined;
}

/** One window's reading, or nothing where any of it is outside what the contract takes. */
function rateLimitReading(utilization, resetsAtSecs, observedAtSecs) {
  const resetsAt = rateLimitInstantSecs(resetsAtSecs);
  const observedAt = rateLimitInstantSecs(observedAtSecs);
  if (
    !Number.isFinite(utilization) ||
    utilization < 0 ||
    utilization > runUsageUtilizationMax ||
    resetsAt === undefined ||
    observedAt === undefined
  )
    return undefined;
  return { utilization, resetsAt, observedAt };
}

/** `readings` with each window of `windows` that is a reading put in its place. */
function rateLimitReadingsKept(readings, windows) {
  for (const window of runUsageWindows) {
    const reading = windows.get(window);
    if (reading !== undefined) readings[window] = reading;
  }
  return readings;
}

/**
 * Folds the readings a runtime frame carries in `unifiedWindows`, each seen at
 * `observedAtMs`, into `readings`.
 */
export function observeRateLimitReadings(readings, event, observedAtMs) {
  const windows = event?.rate_limit_info?.unifiedWindows;
  if (
    event?.type !== rateLimitEventType ||
    windows === null ||
    typeof windows !== "object"
  )
    return readings;
  const read = new Map();
  for (const window of runUsageWindows) {
    const { utilization, resetsAt } = windows[window] ?? {};
    if (typeof utilization !== "number" || typeof resetsAt !== "number")
      continue;
    const reading = rateLimitReading(
      utilization,
      resetsAt,
      observedAtMs / 1_000,
    );
    if (reading !== undefined) read.set(window, reading);
  }
  return rateLimitReadingsKept(readings, read);
}

/** The Unix seconds a rollout line's UTC `timestamp` names, or nothing where it is no such instant. */
function codexObservedAtSecs(timestamp) {
  if (typeof timestamp !== "string" || !codexTimestampPattern.test(timestamp))
    return undefined;
  return Date.parse(timestamp) / 1_000;
}

/**
 * Folds the readings of a Codex rollout's `snapshot`, its line dated
 * `snapshotTimestamp`, into `readings`. Where both of its windows are one
 * length, the one reopening later is kept.
 */
export function observeCodexReadings(
  readings,
  { snapshot, snapshotTimestamp },
) {
  const observedAtSecs = codexObservedAtSecs(snapshotTimestamp);
  const read = new Map();
  for (const window of [snapshot?.primary, snapshot?.secondary]) {
    const name = codexWindowNames.get(window?.window_minutes);
    const { used_percent: usedPercent, resets_at: resetsAt } = window ?? {};
    if (
      name === undefined ||
      typeof usedPercent !== "number" ||
      typeof resetsAt !== "number"
    )
      continue;
    const reading = rateLimitReading(
      usedPercent / codexUsedPercentFull,
      resetsAt,
      observedAtSecs,
    );
    const held = read.get(name);
    if (
      reading !== undefined &&
      (held === undefined || reading.resetsAt > held.resetsAt)
    )
      read.set(name, reading);
  }
  return rateLimitReadingsKept(readings, read);
}
