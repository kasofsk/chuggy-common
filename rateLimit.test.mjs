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

import { workerRunUsageSchema } from "@chuggy/worker-contract/workerPlane";

import {
  creditsDepletedSnapshot,
  creditsDepletedTypes,
  fiveHourResetsAtSecs,
  limitReachedTypes,
  limitSnapshot,
  ordinarySnapshot,
  rolloutObservedAtSecs,
  rolloutTimestamp,
  weeklyResetsAtSecs,
  windowlessSnapshot,
} from "./codexRollout.fixture.mjs";
import {
  observeCodexReadings,
  observeCodexRollout,
  observeRateLimit,
  observeRateLimitReadings,
  rateLimitReadings,
  creditsExhausted,
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

/** Catches exhausted credits read from anything but the assistant frame's declared `billing_error`, or read as a hold. */
test("exactly one of the declared assistant errors is exhausted credits, and it is no hold", () => {
  assert.deepEqual(
    declaredErrors.filter((error) =>
      creditsExhausted(seenBy({ type: "assistant", error })),
    ),
    ["billing_error"],
  );
  assert.equal(
    rateLimited(seenBy({ type: "assistant", error: "billing_error" })),
    false,
  );
  assert.equal(
    creditsExhausted(
      seenBy({ type: "system", subtype: "api_retry", error: "billing_error" }),
    ),
    false,
  );
  assert.equal(
    creditsExhausted(
      seenBy({
        type: "assistant",
        message: { content: [{ type: "text", text: "billing_error" }] },
      }),
    ),
    false,
  );
  assert.equal(creditsExhausted(rateLimitSightings()), false);
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

/**
 * Catches a workspace's depleted credits read as a limit a reset reopens, a
 * limit's reached type read as depleted credits, or credits read from anything
 * but the reached type's exact declared value.
 */
test("a Codex rollout's credits are exhausted exactly where its last snapshot names a depleted reached type", () => {
  for (const reached of creditsDepletedTypes)
    for (const declared of [
      { snapshot: creditsDepletedSnapshot(reached) },
      {
        snapshot: creditsDepletedSnapshot(reached),
        errorInfo: "usage_limit_exceeded",
      },
      { snapshot: { ...limitSnapshot, rate_limit_reached_type: reached } },
    ])
      assert.equal(
        creditsExhausted(seenInRollout(declared)),
        true,
        JSON.stringify(declared),
      );

  for (const reached of [
    ...limitReachedTypes,
    "WORKSPACE_OWNER_CREDITS_DEPLETED",
    "credits_depleted",
  ]) {
    const seen = seenInRollout({
      snapshot: { ...limitSnapshot, rate_limit_reached_type: reached },
    });
    assert.equal(creditsExhausted(seen), false, reached);
    assert.equal(rateLimited(seen), true, reached);
    assert.deepEqual(seen.reset, {
      resetsAtSecs: weeklyResetsAtSecs,
      window: "seven_day",
    });
  }

  assert.equal(
    creditsExhausted(
      seenInRollout({
        snapshot: windowlessSnapshot,
        errorInfo: "usage_limit_exceeded",
      }),
    ),
    false,
  );
  assert.equal(
    creditsExhausted(seenInRollout({ errorInfo: "usage_limit_exceeded" })),
    false,
  );
  assert.deepEqual(seenInRollout({}), rateLimitSightings());
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

/** When the frames below were seen, a moment past a whole second, and that second. */
const seenAtMs = 1_793_250_000_750;
const seenAtSecs = 1_793_250_000;

/** The readings a run that saw these frames, each at `seenAtMs`, ends with, held to the contract. */
function readBy(...events) {
  const readings = events.reduce(
    (held, event) => observeRateLimitReadings(held, event, seenAtMs),
    rateLimitReadings(),
  );
  assert.ok(workerRunUsageSchema.safeParse(readings).success);
  return readings;
}

/** A rate-limit frame carrying `unifiedWindows`, and a status that refuses nothing. */
function windowsFrame(unifiedWindows) {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows },
  };
}

test("a rate-limit frame's windows are read, each dated when the frame was seen", () => {
  assert.deepEqual(readBy(limitRejected), {
    five_hour: {
      utilization: 1,
      resetsAt: limitResetsAtSecs,
      observedAt: seenAtSecs,
    },
    seven_day: {
      utilization: 0.5,
      resetsAt: 1_793_764_800,
      observedAt: seenAtSecs,
    },
  });
});

test("a frame naming one window reads that window alone", () => {
  assert.deepEqual(
    readBy(
      windowsFrame({ five_hour: { utilization: 0.24, resetsAt: 1793251800 } }),
    ),
    {
      five_hour: {
        utilization: 0.24,
        resetsAt: 1793251800,
        observedAt: seenAtSecs,
      },
    },
  );
});

/** Catches a malformed field failing the fold, or read as a window. */
test("windows that are not an object are none", () => {
  for (const unifiedWindows of [
    undefined,
    null,
    "five_hour",
    0.9,
    true,
    [{ utilization: 0.5, resetsAt: 1793251800 }],
  ])
    assert.deepEqual(
      readBy(windowsFrame(unifiedWindows)),
      {},
      String(unifiedWindows),
    );
  assert.deepEqual(readBy({ type: "rate_limit_event" }), {});
});

/** Catches a window the contract does not name sent, which it would refuse. */
test("a window that is neither of the two is passed over, and the others still read", () => {
  assert.deepEqual(
    readBy(
      windowsFrame({
        seven_day_opus: { utilization: 0.9, resetsAt: 1793800800 },
        overage: { utilization: 0.1, resetsAt: 1793800800 },
        seven_day: { utilization: 0.2, resetsAt: 1793800800 },
      }),
    ),
    {
      seven_day: {
        utilization: 0.2,
        resetsAt: 1793800800,
        observedAt: seenAtSecs,
      },
    },
  );
});

test("a reading's reset is floored to its second", () => {
  assert.equal(
    readBy(
      windowsFrame({ five_hour: { utilization: 0.3, resetsAt: 1793251800.9 } }),
    ).five_hour?.resetsAt,
    1793251800,
  );
});

/** Catches a reading the contract would refuse sent, losing the run's totals with it. */
test("a reading with any part the contract would refuse is passed over", () => {
  for (const reading of [
    { utilization: 0.3, resetsAt: 0.5 },
    { utilization: 0.3, resetsAt: 0 },
    { utilization: 0.3, resetsAt: -1793251800 },
    { utilization: 0.3, resetsAt: 8_640_000_000_001 },
    { utilization: 0.3, resetsAt: "1793251800" },
    { utilization: 0.3 },
    { utilization: -0.01, resetsAt: 1793251800 },
    { utilization: 100.5, resetsAt: 1793251800 },
    { utilization: "0.3", resetsAt: 1793251800 },
    { resetsAt: 1793251800 },
    null,
    "full",
  ])
    assert.deepEqual(
      readBy(windowsFrame({ five_hour: reading })),
      {},
      JSON.stringify(reading),
    );
});

test("a frame seen at no second the contract takes gives no reading", () => {
  assert.deepEqual(
    observeRateLimitReadings(rateLimitReadings(), limitRejected, 999),
    {},
  );
});

/** Catches the declared top-level `utilization` read, whose scale nothing establishes. */
test("a frame's own utilization is not a reading", () => {
  assert.deepEqual(
    readBy({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 80,
        resetsAt: 1793251800,
      },
    }),
    {},
  );
});

test("each window keeps the latest reading of it, and one the frame passed over keeps the last", () => {
  assert.deepEqual(
    readBy(
      limitRejected,
      windowsFrame({
        five_hour: { utilization: 0.1, resetsAt: 1793300000 },
        seven_day: { utilization: 0.6, resetsAt: -1 },
      }),
    ),
    {
      five_hour: {
        utilization: 0.1,
        resetsAt: 1793300000,
        observedAt: seenAtSecs,
      },
      seven_day: {
        utilization: 0.5,
        resetsAt: 1_793_764_800,
        observedAt: seenAtSecs,
      },
    },
  );
});

test("only a rate-limit frame carries readings", () => {
  assert.deepEqual(
    readBy({
      type: "assistant",
      rate_limit_info: limitRejected.rate_limit_info,
    }),
    {},
  );
});

/** Catches a refusal's sightings changed by the readings, or a reading made of a refusal. */
test("readings and sightings are folded apart", () => {
  const sightings = observeRateLimit(rateLimitSightings(), limitRejected);
  assert.deepEqual(Object.keys(sightings).sort(), [
    "creditsExhausted",
    "refused",
    "reset",
    "status",
  ]);
  assert.deepEqual(
    observeRateLimitReadings(
      rateLimitReadings(),
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1793251800 },
      },
      seenAtMs,
    ),
    {},
  );
});

/** The readings a Codex rollout's `snapshot`, its line dated `snapshotTimestamp`, gives, held to the contract. */
function codexReadBy(
  snapshot,
  dated = { snapshotTimestamp: rolloutTimestamp },
) {
  const readings = observeCodexReadings(rateLimitReadings(), {
    snapshot,
    ...dated,
    errorInfo: undefined,
  });
  assert.ok(workerRunUsageSchema.safeParse(readings).success);
  return readings;
}

test("a Codex snapshot's windows are read by their length, as fractions, dated by its line", () => {
  assert.deepEqual(codexReadBy(limitSnapshot), {
    five_hour: {
      utilization: 1,
      resetsAt: fiveHourResetsAtSecs,
      observedAt: rolloutObservedAtSecs,
    },
    seven_day: {
      utilization: 1,
      resetsAt: weeklyResetsAtSecs,
      observedAt: rolloutObservedAtSecs,
    },
  });
});

/** Catches a percentage sent as a fraction, which would pause the account for a whole window. */
test("a Codex window of another length is passed over, and a percent is read as its fraction", () => {
  assert.deepEqual(codexReadBy(ordinarySnapshot), {
    seven_day: {
      utilization: 0.125,
      resetsAt: 1_800_100_000,
      observedAt: rolloutObservedAtSecs,
    },
  });
  assert.deepEqual(
    codexReadBy({
      primary: { used_percent: 250, window_minutes: 300, resets_at: 1 },
    }).five_hour?.utilization,
    2.5,
  );
});

test("a Codex window naming no reset is passed over", () => {
  assert.deepEqual(
    codexReadBy({
      ...limitSnapshot,
      primary: { ...limitSnapshot.primary, resets_at: null },
    }),
    {
      seven_day: {
        utilization: 1,
        resetsAt: weeklyResetsAtSecs,
        observedAt: rolloutObservedAtSecs,
      },
    },
  );
  assert.deepEqual(codexReadBy(windowlessSnapshot), {});
  assert.deepEqual(codexReadBy(undefined), {});
});

test("where both Codex windows are one length, the one reopening later is read", () => {
  const earlier = {
    used_percent: 90,
    window_minutes: 300,
    resets_at: 1_793_600_000,
  };
  const later = {
    used_percent: 10,
    window_minutes: 300,
    resets_at: 1_793_610_000,
  };
  for (const [primary, secondary] of [
    [earlier, later],
    [later, earlier],
  ])
    assert.deepEqual(codexReadBy({ primary, secondary }), {
      five_hour: {
        utilization: 0.1,
        resetsAt: 1_793_610_000,
        observedAt: rolloutObservedAtSecs,
      },
    });
});

test("a Codex snapshot is dated by its line's timestamp floored to its second, or not read without one", () => {
  assert.equal(
    codexReadBy(limitSnapshot, {
      snapshotTimestamp: "2026-11-02T21:14:03.999Z",
    }).five_hour?.observedAt,
    rolloutObservedAtSecs,
  );
  for (const timestamp of [
    undefined,
    1_793_654_043,
    "2026-11-02 21:14:03",
    "2026-11-02T21:14:03.000+01:00",
    "1970-01-01T00:00:00.500Z",
  ])
    assert.deepEqual(
      codexReadBy(limitSnapshot, { snapshotTimestamp: timestamp }),
      {},
      String(timestamp),
    );
});

test("a Codex snapshot's used percent past what the contract takes is passed over", () => {
  assert.deepEqual(
    codexReadBy({
      primary: { used_percent: 10_001, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: -1, window_minutes: 10_080, resets_at: 1 },
    }),
    {},
  );
});
