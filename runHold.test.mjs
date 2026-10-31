import assert from "node:assert/strict";
import test from "node:test";

import { observeRateLimit, rateLimitSightings } from "./rateLimit.mjs";
import {
  limitFrames,
  limitRejected,
  limitRefused,
  limitResetsAtSecs,
  limitSentence,
  limitSession,
} from "./rateLimit.fixture.mjs";
import {
  runEndedText,
  runHoldDecided,
  runHoldInstant,
  runHoldMarginMs,
  runHoldReserveMs,
  runHoldsMax,
} from "./runHold.mjs";

/** The sightings a run that streamed `frames` ended with. */
function seenBy(frames) {
  return frames.reduce(observeRateLimit, rateLimitSightings());
}

const resumesAtMs = limitResetsAtSecs * 1_000 + runHoldMarginMs;

/** A run the limit stopped, with every condition of a hold met. */
const stopped = {
  resumable: true,
  sightings: seenBy(limitFrames),
  session: limitSession,
  deadlineMs: resumesAtMs + runHoldReserveMs + 1,
  holds: 0,
};

test("a run the limit stopped is held until a margin past the reset of the window it names", () => {
  assert.deepEqual(runHoldDecided(stopped), {
    untilMs: resumesAtMs,
    window: "five_hour",
  });
});

test("a run no limit stopped is nothing to this decision, whatever else it lacks", () => {
  assert.equal(
    runHoldDecided({
      ...stopped,
      sightings: rateLimitSightings(),
      session: undefined,
    }),
    undefined,
  );
});

/**
 * Each condition taken away alone, so a guard that stopped being read would
 * leave its case held. Catches a hold on a run that could not resume, one with
 * no time to finish in, and one past the bound.
 */
test("a limit is not waited out where any condition of a hold fails, and it says which", () => {
  const cases = [
    [{ resumable: false }, /cannot resume/u],
    [{ session: undefined }, /no session/u],
    [{ session: "" }, /no session/u],
    [{ deadlineMs: undefined }, /no deadline/u],
    [{ deadlineMs: resumesAtMs + runHoldReserveMs }, /no time to finish/u],
    [{ holds: runHoldsMax }, /already held/u],
    [{ sightings: seenBy([limitRefused]) }, /no reset time/u],
  ];
  for (const [changed, reason] of cases) {
    const decided = runHoldDecided({ ...stopped, ...changed });
    assert.equal(decided.untilMs, undefined);
    assert.match(decided.refused, reason);
  }
});

test("a run one hold short of the bound is still held", () => {
  assert.equal(
    runHoldDecided({ ...stopped, holds: runHoldsMax - 1 }).untilMs,
    resumesAtMs,
  );
});

test("a refused frame without the assistant's says the same limit", () => {
  assert.equal(
    runHoldDecided({ ...stopped, sightings: seenBy([limitRejected]) }).untilMs,
    resumesAtMs,
  );
});

test("the text of a run no limit stopped is how it stopped and what the runtime said", () => {
  assert.equal(
    runEndedText("Claude Code exited 1", limitSentence, undefined),
    `Claude Code exited 1\n${limitSentence}`,
  );
  assert.equal(
    runEndedText("Claude Code exited 1", undefined, undefined),
    "Claude Code exited 1",
  );
  assert.equal(
    runEndedText("Claude Code exited 1", "", undefined),
    "Claude Code exited 1",
  );
});

test("the text of a limit not waited out names its window, its reset and why", () => {
  const decided = runHoldDecided({ ...stopped, session: undefined });

  assert.equal(
    runEndedText("Claude Code exited 1", limitSentence, decided),
    [
      "Claude Code exited 1",
      limitSentence,
      `The five_hour limit resets at ${runHoldInstant(limitResetsAtSecs * 1_000)}.`,
      "The run was not held: the result gave no session to resume.",
    ].join("\n"),
  );
});

test("the text of a limit whose frames named no window still names its reset", () => {
  const info = { ...limitRejected.rate_limit_info, rateLimitType: undefined };
  const decided = runHoldDecided({
    ...stopped,
    sightings: seenBy([{ ...limitRejected, rate_limit_info: info }]),
    session: undefined,
  });

  assert.match(
    runEndedText("Claude Code exited 1", undefined, decided),
    /^The account's limit resets at /mu,
  );
});

test("the text of a limit the frames gave no reset for does not make one up", () => {
  const decided = runHoldDecided({
    ...stopped,
    sightings: seenBy([limitRefused]),
  });

  assert.equal(
    runEndedText("Claude Code exited 1", undefined, decided),
    "Claude Code exited 1\nThe run was not held: the frames gave no reset time.",
  );
});
