/**
 * What a real run streamed as its account's usage limit stopped it, field for
 * field, and the sentence a real run ended with for another reason.
 */

/** When the limit that stopped it reopens, in Unix seconds. */
export const limitResetsAtSecs = 1_793_296_800;

/** The conversation it was in. */
export const limitSession = "16d74a73-110f-435f-910e-1c02f765eb2d";

/** What the runtime said of it. */
export const limitSentence = "You've hit your session limit · resets 6pm (UTC)";

/** What a run whose credential was revoked ended with. */
export const revokedSentence =
  "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

/** The frame saying the window is refusing the account. */
export const limitRejected = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: limitResetsAtSecs,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 1, resetsAt: limitResetsAtSecs },
      seven_day: { utilization: 0.5, resetsAt: 1_793_764_800 },
    },
  },
  uuid: "f4510ec5",
  session_id: limitSession,
};

/** The turn the runtime wrote in the model's place. */
export const limitRefused = {
  type: "assistant",
  message: {
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    content: [{ type: "text", text: limitSentence }],
  },
  parent_tool_use_id: null,
  session_id: limitSession,
  error: "rate_limit",
  is_api_error_message: true,
};

/** How the run ended: `success`, with no verdict in it, and the process exits 1. */
export const limitResult = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 429,
  stop_reason: "stop_sequence",
  result: limitSentence,
  num_turns: 28,
  session_id: limitSession,
  total_cost_usd: 1.2024888,
};

/** Every frame of it, in order. */
export const limitFrames = [limitRejected, limitRefused, limitResult];
