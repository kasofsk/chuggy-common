/**
 * The predicate that decides whether a run or a turn was held, driven over each
 * value the SDK declares rather than over the two its callers happen to produce.
 *
 * THE MIDDLE VALUE IS WHY THIS SUITE EXISTS. `SDKRateLimitInfo.status` is a
 * three-valued closed set, and `allowed_warning` means the request was allowed
 * while the account nears a threshold. A predicate written as "not allowed"
 * reads that middle value as a refusal and prices an ordinary failure as free,
 * and a predicate written as "rejected" does not — so both members of the
 * vocabulary that are not a hold are asserted here, not just the one a caller
 * would naturally emit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  fiveHourResetsAtSecs,
  limitSnapshot,
  ordinarySnapshot,
  weeklyResetsAtSecs,
  windowlessSnapshot,
} from "./codexRollout.fixture.mjs";
import {
  observeCodexRollout,
  observeRateLimit,
  rateLimitSightings,
  rateLimited,
} from "./rateLimit.mjs";
import {
  limitFrames,
  limitRejected,
  limitResetsAtSecs,
} from "./rateLimit.fixture.mjs";

/** `SDKRateLimitInfo.status` as `sdk.d.ts` declares it, in its declared order. */
const declaredStatuses = ["allowed", "allowed_warning", "rejected"];

/** `SDKAssistantMessageError` as `sdk.d.ts` declares it. */
const declaredErrors = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
];

const rateLimitEvent = (status) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, rateLimitType: "five_hour", utilization: 1 },
});

/** The sightings a run that saw exactly these frames, in this order, ends with. */
function seenBy(...events) {
  return events.reduce(observeRateLimit, rateLimitSightings());
}

test("a run nothing was said about is not held", () => {
  assert.equal(rateLimited(rateLimitSightings()), false);
  assert.equal(rateLimited(undefined), false);
});

test("exactly one of the three declared statuses is a hold", () => {
  assert.deepEqual(
    declaredStatuses.map((status) =>
      rateLimited(seenBy(rateLimitEvent(status))),
    ),
    [false, false, true],
  );
});

test("exactly one of the declared assistant errors is a hold", () => {
  assert.deepEqual(
    declaredErrors.filter((error) =>
      rateLimited(seenBy({ type: "assistant", error })),
    ),
    ["rate_limit"],
  );
});

test("the latest status is the one that counts, in either direction", () => {
  assert.equal(
    rateLimited(seenBy(rateLimitEvent("rejected"), rateLimitEvent("allowed"))),
    false,
  );
  assert.equal(
    rateLimited(
      seenBy(rateLimitEvent("rejected"), rateLimitEvent("allowed_warning")),
    ),
    false,
  );
  assert.equal(
    rateLimited(seenBy(rateLimitEvent("allowed"), rateLimitEvent("rejected"))),
    true,
  );
});

test("a refusal the runtime named on its own frame outlives a later allowance", () => {
  assert.equal(
    rateLimited(
      seenBy(
        { type: "assistant", error: "rate_limit" },
        rateLimitEvent("allowed"),
      ),
    ),
    true,
  );
});

test("a frame that carries no status of its own leaves the last one standing", () => {
  for (const event of [
    { type: "rate_limit_event" },
    { type: "rate_limit_event", rate_limit_info: {} },
    { type: "rate_limit_event", rate_limit_info: { status: 7 } },
  ])
    assert.equal(rateLimited(seenBy(rateLimitEvent("rejected"), event)), true);
});

/**
 * `SDKAPIRetryMessage` is `{type:"system", subtype:"api_retry", error}`, the
 * same closed set on the same field name as the assistant frame's, saying the
 * request is being retried rather than refused. Only the type tells them apart.
 */
test("a retry the runtime recovered from carries the same error and is not a hold", () => {
  const retry = {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 1_000,
    error_status: 429,
    error: "rate_limit",
  };
  assert.equal(rateLimited(seenBy(retry)), false);
  for (const error of declaredErrors)
    assert.equal(rateLimited(seenBy({ ...retry, error })), false, error);
  assert.equal(
    rateLimited(seenBy(retry, { type: "assistant", error: "rate_limit" })),
    true,
    "a refusal after a recovered retry is still a hold",
  );
});

test("no other frame the runtime emits is read as a hold", () => {
  for (const event of [
    {
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "api_error",
    },
    {
      type: "result",
      subtype: "error_during_execution",
      stop_reason: "rate_limit",
    },
    { type: "result", subtype: "rate_limit" },
    { type: "assistant", message: { role: "assistant" }, error: undefined },
    { type: "system", subtype: "init" },
    { type: "user", message: { content: "rate_limit" } },
    undefined,
  ])
    assert.equal(
      rateLimited(seenBy(event)),
      false,
      JSON.stringify(event ?? null),
    );
});

/** A frame of `info` beside what the real rejected frame carried. */
function limitFrame(info) {
  return {
    ...limitRejected,
    rate_limit_info: { ...limitRejected.rate_limit_info, ...info },
  };
}

/** What folding `frames` leaves as the reset. */
function resetAfter(...frames) {
  return frames.reduce(observeRateLimit, rateLimitSightings()).reset;
}

test("a run the limit stopped says when its window reopens and which window it is", () => {
  assert.deepEqual(resetAfter(...limitFrames), {
    resetsAtSecs: limitResetsAtSecs,
    window: "five_hour",
  });
});

/**
 * Catches a reset read from a frame that refuses nothing: an `allowed_warning`
 * names a window nearing its limit, and a run held to that window's reset would
 * wait out a limit that never stopped it.
 */
test("a reset is read only from a rejected frame", () => {
  for (const status of declaredStatuses.filter((one) => one !== "rejected"))
    assert.equal(resetAfter(limitFrame({ status })), undefined, status);
});

test("a later status drops the reset, as it drops the refusal", () => {
  assert.equal(
    resetAfter(limitRejected, limitFrame({ status: "allowed" })),
    undefined,
  );
});

test("a later frame's reset replaces the one before it", () => {
  assert.equal(
    resetAfter(limitRejected, limitFrame({ resetsAt: limitResetsAtSecs + 60 }))
      .resetsAtSecs,
    limitResetsAtSecs + 60,
  );
});

test("a reset that names no instant is none", () => {
  for (const resetsAt of [
    undefined,
    null,
    "1793296800",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    8_640_000_000_001,
  ])
    assert.equal(
      resetAfter(limitFrame({ resetsAt })),
      undefined,
      String(resetsAt),
    );
});

test("a window that is not a name is none, and the reset still stands", () => {
  assert.deepEqual(resetAfter(limitFrame({ rateLimitType: 5 })), {
    resetsAtSecs: limitResetsAtSecs,
    window: undefined,
  });
});

/** The sightings `declared` alone folds to. */
function seenInRollout(declared) {
  return observeCodexRollout(rateLimitSightings(), {
    snapshot: undefined,
    errorInfo: undefined,
    ...declared,
  });
}

/** A window of `minutes` used to `percent`, reopening at `resetsAt`. */
function codexWindow(percent, minutes, resetsAt) {
  return {
    used_percent: percent,
    window_minutes: minutes,
    resets_at: resetsAt,
  };
}

/**
 * Catches an ordinary snapshot priced as a hold, which would leave the retry
 * budget unenforceable, and a limit missed where the refusal's headers carried
 * no window.
 */
test("a Codex rollout is a hold on a reached type, a used-up window or a usage limit's error", () => {
  const ordinary = seenInRollout({ snapshot: ordinarySnapshot });
  const almost = seenInRollout({
    snapshot: {
      ...ordinarySnapshot,
      primary: codexWindow(99.9, 300, fiveHourResetsAtSecs),
    },
  });
  const otherError = seenInRollout({ errorInfo: "context_window_exceeded" });
  assert.equal(rateLimited(ordinary), false);
  assert.equal(rateLimited(almost), false);
  assert.equal(rateLimited(otherError), false);
  assert.equal(ordinary.reset, undefined);

  for (const declared of [
    { snapshot: limitSnapshot },
    {
      snapshot: {
        ...ordinarySnapshot,
        rate_limit_reached_type: "rate_limit_reached",
      },
    },
    {
      snapshot: {
        ...ordinarySnapshot,
        secondary: codexWindow(100.4, 10_080, weeklyResetsAtSecs),
      },
    },
    { snapshot: windowlessSnapshot, errorInfo: "usage_limit_exceeded" },
    { errorInfo: "usage_limit_exceeded" },
  ])
    assert.equal(
      rateLimited(seenInRollout(declared)),
      true,
      JSON.stringify(declared),
    );
});

test("a Codex limit reopens at the latest reset a used-up window names, under that window's name", () => {
  const both = seenInRollout({ snapshot: limitSnapshot });
  const swapped = seenInRollout({
    snapshot: {
      ...limitSnapshot,
      primary: codexWindow(100, 10_080, weeklyResetsAtSecs),
      secondary: codexWindow(100, 300, fiveHourResetsAtSecs),
    },
  });
  const one = seenInRollout({
    snapshot: {
      ...limitSnapshot,
      secondary: codexWindow(40, 10_080, weeklyResetsAtSecs),
    },
  });
  const nullReset = seenInRollout({
    snapshot: {
      ...limitSnapshot,
      secondary: codexWindow(100, 10_080, null),
    },
  });
  for (const seen of [both, swapped])
    assert.deepEqual(seen.reset, {
      resetsAtSecs: weeklyResetsAtSecs,
      window: "seven_day",
    });
  for (const seen of [one, nullReset])
    assert.deepEqual(seen.reset, {
      resetsAtSecs: fiveHourResetsAtSecs,
      window: "five_hour",
    });
  assert.deepEqual(
    seenInRollout({
      snapshot: {
        ...limitSnapshot,
        secondary: codexWindow(0, 10_080, null),
        primary: codexWindow(100, 45, fiveHourResetsAtSecs),
      },
    }).reset,
    { resetsAtSecs: fiveHourResetsAtSecs, window: undefined },
  );
});

/** Catches a reset made up where nothing declared one, or one no date can name taken. */
test("a Codex limit with no used-up window naming a reset has no reset", () => {
  for (const snapshot of [
    windowlessSnapshot,
    {
      ...limitSnapshot,
      primary: codexWindow(100, 300, null),
      secondary: codexWindow(100, 10_080, null),
    },
    {
      ...limitSnapshot,
      primary: codexWindow(90, 300, fiveHourResetsAtSecs),
      secondary: codexWindow(100, 10_080, 9_000_000_000_000),
    },
    undefined,
  ]) {
    const seen = seenInRollout({ snapshot, errorInfo: "usage_limit_exceeded" });
    assert.equal(rateLimited(seen), true);
    assert.equal(seen.reset, undefined, JSON.stringify(snapshot));
  }
});
