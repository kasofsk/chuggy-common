/**
 * A Codex rollout's records, shaped as Codex's own tests persist them
 * (`codex-rs/rollout/src/tests.rs`, `codex-rs/codex-api/src/api_bridge_tests.rs`),
 * and the stream a run its weekly limit stopped wrote.
 */

/** The thread a run's stream named. */
export const rolloutThread = "019a4f4e-1c2b-7d3e-8f40-a1b2c3d4e5f6";

/** What the run's stream said as the limit stopped it. */
export const usageLimitSentence =
  "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 1:26 AM.";

/** When the weekly window reopens, in Unix seconds. */
export const weeklyResetsAtSecs = 1_793_841_960;

/** When the five-hour window reopens, before the weekly one. */
export const fiveHourResetsAtSecs = 1_793_671_200;

/** The name a rollout of `thread` is written under, in the folder `rolloutFolder` names. */
export function rolloutName(thread = rolloutThread) {
  return `rollout-2026-11-02T21-13-52-${thread}.jsonl`;
}

/** The date folders under a Codex home's `sessions` a rollout is written in. */
export const rolloutFolder = ["2026", "11", "02"];

/** When a line was persisted, as Codex writes it: UTC, to the millisecond. */
export const rolloutTimestamp = "2026-11-02T21:14:03.250Z";

/** The Unix second `rolloutTimestamp` falls in. */
export const rolloutObservedAtSecs = 1_793_654_043;

/** One persisted event's line, persisted at `timestamp`. */
export function rolloutLine(payload, timestamp = rolloutTimestamp) {
  return JSON.stringify({
    timestamp,
    ordinal: 7,
    type: "event_msg",
    payload,
  });
}

/** A snapshot of an account well inside its windows. */
export const ordinarySnapshot = {
  limit_id: null,
  limit_name: null,
  primary: { used_percent: 0.0, window_minutes: 60, resets_at: 1_800_000_000 },
  secondary: {
    used_percent: 12.5,
    window_minutes: 10_080,
    resets_at: 1_800_100_000,
  },
  credits: null,
  individual_limit: null,
  spend_control_reached: null,
  plan_type: null,
  rate_limit_reached_type: null,
};

/** The snapshot a refusal's headers made, with both windows used up. */
export const limitSnapshot = {
  limit_id: "codex",
  limit_name: null,
  primary: {
    used_percent: 100.0,
    window_minutes: 300,
    resets_at: fiveHourResetsAtSecs,
  },
  secondary: {
    used_percent: 100.0,
    window_minutes: 10_080,
    resets_at: weeklyResetsAtSecs,
  },
  credits: { has_credits: true, unlimited: false, balance: null },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: "pro",
  rate_limit_reached_type: "workspace_member_usage_limit_reached",
};

/** The snapshot a refusal whose headers carried no window or reached type made. */
export const windowlessSnapshot = {
  ...limitSnapshot,
  primary: null,
  secondary: null,
  rate_limit_reached_type: null,
};

/** A `token_count` carrying `snapshot`. */
export function tokenCount(snapshot) {
  return { type: "token_count", info: null, rate_limits: snapshot };
}

/** The turn the limit ended. */
export const usageLimitComplete = {
  type: "task_complete",
  turn_id: "turn-1",
  last_agent_message: null,
  error: {
    message: usageLimitSentence,
    codex_error_info: "usage_limit_exceeded",
  },
  started_at: 10,
  completed_at: 20,
  duration_ms: 10_000,
};

/** The stream of a run the limit stopped, as `codex exec --json` wrote it. */
export const usageLimitFrames = [
  { type: "thread.started", thread_id: rolloutThread },
  { type: "turn.started" },
  { type: "error", message: usageLimitSentence },
  { type: "turn.failed", error: { message: usageLimitSentence } },
];
