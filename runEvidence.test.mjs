import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  creditsDepletedSnapshot,
  creditsDepletedTypes,
  fiveHourResetsAtSecs,
  limitReachedTypes,
  limitSnapshot,
  rolloutObservedAtSecs,
  rolloutTimestamp,
  weeklyResetsAtSecs,
} from "./codexRollout.fixture.mjs";
import {
  runEndedEvidences,
  runModelCharsMax,
  runTranscriptBatchBytesMax,
  runTranscriptBatchesMax,
  runTurnSeriesMax,
  workerRunContextSchema,
  workerRunEndedSchema,
  workerRunLimitSchema,
  workerRunTotalsSchema,
  workerRunTurnsSchema,
  workerRunUsageSchema,
} from "@chuggy/worker-contract/workerPlane";

import {
  workerContractCredentialOutcome,
  workerContractHeader,
  workerContractRelease,
  workerContractRunCredential,
} from "@chuggy/worker-contract/workerContract";

import { drawnSecrets, drawnText, seeded } from "./credentialText.fixture.mjs";
import {
  credentialScrub,
  credentialScrubbing,
  credentialScrubCharsMin,
  credentialScrubHead,
  endedEvidence,
  RunStepFailure,
  runCloneFailed,
  runCommitFailed,
  runCredentialAbsent,
  runEvidenceRecorder,
  runLimit,
  runPushFailed,
  runSetupFailed,
  runStep,
  runTimedOut,
  runTotals,
  runTranscriptEventBytesMax,
  runTurn,
  runUsage,
  truncatedEvent,
} from "./runEvidence.mjs";
import {
  observeCodexRollout,
  observeRateLimit,
  rateLimitReadings,
  rateLimitSightings,
  rateLimited,
} from "./rateLimit.mjs";
import { contextWindow } from "./contextReading.mjs";
import { contextUsage } from "./contextUsage.fixture.mjs";
import {
  creditsRefused,
  creditsResult,
  limitRejected,
  limitResetsAtSecs,
} from "./rateLimit.fixture.mjs";

/** The sightings a run that saw exactly these frames, in this order, ends with. */
function seenBy(...events) {
  return events.reduce(observeRateLimit, rateLimitSightings());
}

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const secret = "sk-ant-oat01-0123456789abcdefghijklmnopqrstuvwxyz";

/** When the harness's clock says a frame was seen, a moment past a whole second. */
const observedAtMs = 1_793_250_000_750;

function harness(options = {}) {
  const calls = [];
  let ticked;
  const recorder = runEvidenceRecorder(
    task,
    "bearer",
    options.scrub ?? ((text) => text),
    {
      request: async (_task, _bearer, path, init) => {
        calls.push({ path, init });
        await options.behaviour?.(path);
        const headers = new globalThis.Headers(
          options.release === undefined
            ? {}
            : { [workerContractHeader]: options.release },
        );
        if (path !== "/v1/run/turns") return { ok: true, status: 204, headers };
        return {
          ok: true,
          status: 200,
          headers,
          json: async () => ({ turnsRecorded: options.turnsRecorded ?? 0 }),
        };
      },
      setInterval: (callback) => {
        ticked = callback;
        return { unref: () => undefined };
      },
      clearInterval: () => undefined,
      warn: () => undefined,
      now: options.now ?? (() => observedAtMs),
      credential: options.credential,
    },
  );
  return { recorder, calls, tick: () => ticked() };
}

function assistantEvent(model, usage) {
  return { type: "assistant", message: { model, usage } };
}

/** A plane that answers nothing until `back()`, as one that is away and then returns does. */
function awayPlane() {
  let back;
  const away = new Promise((returned) => {
    back = returned;
  });
  return { behaviour: () => away, back };
}

/** The transcript batches a plane was sent, in the order it was sent them. */
function transcriptBatches(calls) {
  return calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
}

test("a credential the worker was handed is redacted wherever it appears", () => {
  const scrub = credentialScrub([secret]);
  assert.equal(
    scrub(`before ${secret} between ${secret} after`),
    "before [redacted credential] between [redacted credential] after",
  );
});

test("a value one character short of a credential is left alone", () => {
  const scrub = credentialScrub([secret]);
  const nearMiss = secret.slice(0, -1);
  assert.equal(scrub(`before ${nearMiss} after`), `before ${nearMiss} after`);
});

test("a credential too short to be distinctive is not scrubbed", () => {
  const short = "a".repeat(credentialScrubCharsMin - 1);
  assert.equal(credentialScrub([short])(`x ${short} y`), `x ${short} y`);
});

test("a credential minted after the scrub was handed out is scrubbed by it", () => {
  const { scrub, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
  ]);
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

  assert.equal(scrub(`saw ${minted}`), `saw ${minted}`);
  keepSecret({ kind: "minted", value: minted });

  assert.equal(scrub(`saw ${minted}`), "saw [redacted credential]");
  assert.equal(scrub(`saw ${secret}`), "saw [redacted credential]");
});

test("a text still being written is scrubbed only as far as no later text can change it", () => {
  const head = credentialScrubHead([secret]);
  const begun = secret.slice(0, 20);

  assert.equal(head(`the token is ${begun}`), "the token is ");
  assert.equal(
    head(`the token is ${begun} and more`),
    `the token is ${begun} and more`,
    "a beginning that turned out not to be the credential stayed held back",
  );
  assert.equal(
    head(`the token is ${secret} and more`),
    "the token is [redacted credential] and more",
  );
  assert.equal(
    head(`one ${secret} two ${secret.slice(0, 1)}`),
    "one [redacted credential] two ",
    "the credential's first character was sent before what follows it was known",
  );
});

/**
 * Where one credential holds another, the store replaces the longer whole and
 * the shorter wherever it stands alone, and a text in pieces sends neither:
 * the shorter is held back while it may still be the longer's middle.
 */
test("a credential inside another is never sent, whichever of them the text turns out to hold", () => {
  const inner = "inner-0123456789abcdef";
  const outer = `outer-${inner}-tail-0123`;
  const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
    make([inner, outer]),
  );

  assert.equal(scrub(`a ${outer} b`), "a [redacted credential] b");
  assert.equal(scrub(`a ${inner} b`), "a [redacted credential] b");
  for (const whole of [
    `a ${outer} b`,
    `a outer-${inner}-other b`,
    `a ${inner}`,
  ])
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const sent = head(whole.slice(0, cut));
      assert.ok(
        scrub(whole).startsWith(sent),
        `${whole} cut at ${String(cut)}`,
      );
      assert.ok(
        !sent.includes(inner.slice(0, 8)),
        `${sent} holds a credential`,
      );
    }
});

/**
 * Where two credentials overlap in a text, the store replaces the one the
 * scrub reaches first, the longer, and leaves what remains of the other. A
 * text in pieces sends that remainder too and nothing else: never more than
 * the store holds.
 */
test("credentials that overlap are sent as the store holds them, the longer replaced and the rest left", () => {
  const first = "0123456789abcdefXYZ";
  const second = "abcdefXYZ0123456789-q";
  const overlapped = `${first}${second.slice("abcdefXYZ".length)}`;
  const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
    make([first, second]),
  );

  assert.equal(
    scrub(`a ${overlapped} b`),
    "a 0123456789[redacted credential] b",
  );
  for (let cut = 0; cut <= overlapped.length + 4; cut += 1)
    assert.ok(
      scrub(`a ${overlapped} b`).startsWith(
        head(`a ${overlapped} b`.slice(0, cut)),
      ),
      `cut at ${String(cut)}`,
    );
});

/**
 * The property the live stream rests on, over drawn credentials and texts:
 * whatever was scrubbed of a text's beginning is how the scrub of the whole
 * text begins, it only grows as the text does, and nothing is held back once
 * the text's last character is one no credential holds.
 */
test("whatever a text's beginning is scrubbed to is how the whole text's scrub begins", () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = seeded(seed);
    const secrets = drawnSecrets(random);
    const text = drawnText(random, secrets, 12);
    const [scrub, head] = [credentialScrub, credentialScrubHead].map((make) =>
      make(secrets),
    );
    const whole = scrub(text);
    let before = "";
    for (let cut = 0; cut <= text.length; cut += 1) {
      const begun = text.slice(0, cut);
      const sent = head(begun);
      const named = `seed ${String(seed)} cut at ${String(cut)}`;
      assert.ok(whole.startsWith(sent), `${named} sent what the store redacts`);
      assert.ok(sent.startsWith(before), `${named} took back what was sent`);
      if (!secrets.some((value) => value.includes(begun.slice(-1))))
        assert.equal(sent, scrub(begun), `${named} held back settled text`);
      before = sent;
    }
    assert.equal(scrub(text).startsWith(head(text)), true);
  }
});

test("a credential minted after the head scrub was handed out is held back by it", () => {
  const { scrubHead, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
  ]);
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

  assert.equal(
    scrubHead(`saw ${minted.slice(0, 20)}`),
    `saw ${minted.slice(0, 20)}`,
  );
  keepSecret({ kind: "minted", value: minted });

  assert.equal(scrubHead(`saw ${minted.slice(0, 20)}`), "saw ");
  assert.equal(
    scrubHead(`saw ${minted} then`),
    "saw [redacted credential] then",
  );
});

/**
 * What a push is checked for is what the scrub replaces. Catches a held set
 * that drifted from it: a short value kept, which no scrub replaces, a
 * repeated one named twice, or a later kind renaming one held first.
 */
test("the held secrets are the scrub's, each once under the kind it was first held as", () => {
  const minted = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
  const { held, keepSecret } = credentialScrubbing([
    { kind: "agent", value: secret },
    { kind: "bearer", value: "a".repeat(credentialScrubCharsMin - 1) },
    { kind: "mounted", value: secret },
  ]);
  keepSecret({ kind: "minted", value: minted });

  assert.deepEqual(held(), [
    { kind: "agent", value: secret },
    { kind: "minted", value: minted },
  ]);
});

test("an oversized event keeps its type and position and loses its payload", () => {
  const payload = "p".repeat(runTranscriptEventBytesMax * 2);
  const line = JSON.stringify({
    type: "user",
    ordinal: 7,
    message: { content: [{ type: "tool_result", content: payload }] },
  });
  const kept = JSON.parse(truncatedEvent(line));

  assert.ok(
    Buffer.byteLength(truncatedEvent(line)) <= runTranscriptEventBytesMax,
  );
  assert.equal(kept.type, "user");
  assert.equal(kept.ordinal, 7);
  assert.equal(kept.message.content[0].type, "tool_result");
  assert.equal(
    kept.message.content[0].content.chuggy_truncated.bytes,
    payload.length,
  );
  assert.match(
    kept.message.content[0].content.chuggy_truncated.digest,
    /^[0-9a-f]{64}$/u,
  );
});

test("an event within the bound is kept byte for byte", () => {
  const line = JSON.stringify({ type: "system", subtype: "init" });
  assert.equal(truncatedEvent(line), line);
});

test("the run's totals are the runtime's own figures", () => {
  const totals = runTotals(
    {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      num_turns: 4,
      duration_ms: 252_000,
      duration_api_ms: 190_000,
      total_cost_usd: 0.4237185,
      permission_denials: [{ tool_name: "Bash" }],
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 33,
        cache_read_input_tokens: 44,
      },
      modelUsage: {
        "claude-opus-4": {
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationInputTokens: 33,
          cacheReadInputTokens: 44,
          costUSD: 0.4237185,
        },
      },
    },
    [],
  );

  assert.deepEqual(totals, {
    tokensInput: 11,
    tokensOutput: 22,
    tokensCacheCreation: 33,
    tokensCacheRead: 44,
    turns: 4,
    durationMs: 252_000,
    durationApiMs: 190_000,
    costUsdMicros: 423_719,
    costBasis: "List",
    models: [
      {
        model: "claude-opus-4",
        tokensInput: 11,
        tokensOutput: 22,
        tokensCacheCreation: 33,
        tokensCacheRead: 44,
        costUsdMicros: 423_719,
      },
    ],
    permissionDenials: 1,
    resultSubtype: "success",
    stopReason: "end_turn",
  });
});

test("a run that emitted no result event still states its totals", () => {
  const turns = [
    runTurn(
      assistantEvent("claude-opus-4", {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
      }),
      1,
    ),
    runTurn(
      assistantEvent("claude-opus-4", {
        input_tokens: 16,
        output_tokens: 32,
        cache_creation_input_tokens: 64,
        cache_read_input_tokens: 128,
      }),
      2,
    ),
    runTurn(
      assistantEvent("claude-haiku-4", {
        input_tokens: 256,
        output_tokens: 512,
        cache_creation_input_tokens: 1_024,
        cache_read_input_tokens: 2_048,
      }),
      3,
    ),
  ];
  const totals = runTotals(undefined, turns);

  assert.equal(totals.turns, 3);
  assert.equal(totals.costUsdMicros, 0);
  assert.equal(totals.costBasis, "List");
  assert.equal(totals.tokensInput, 273);
  assert.equal(totals.tokensOutput, 546);
  assert.equal(totals.tokensCacheCreation, 1_092);
  assert.equal(totals.tokensCacheRead, 2_184);
  assert.deepEqual(totals.models, [
    {
      model: "claude-opus-4",
      tokensInput: 17,
      tokensOutput: 34,
      tokensCacheCreation: 68,
      tokensCacheRead: 136,
      costUsdMicros: 0,
    },
    {
      model: "claude-haiku-4",
      tokensInput: 256,
      tokensOutput: 512,
      tokensCacheCreation: 1_024,
      tokensCacheRead: 2_048,
      costUsdMicros: 0,
    },
  ]);
});

test("a turn the runtime left unnamed still names a model the plane takes", () => {
  const turn = runTurn(assistantEvent("", { input_tokens: 3 }), 1);

  assert.ok(turn.model.length >= 1);
  assert.ok(turn.model.length <= runModelCharsMax);
  assert.equal(turn.model, "unknown");
  assert.equal(turn.tokensInput, 3);
});

test("a model identity longer than the plane stores is cut to it", () => {
  const turn = runTurn(assistantEvent("m".repeat(500), {}), 1);

  assert.equal(turn.model.length, runModelCharsMax);
});

test("an unnamed model in the runtime's own breakdown is named too", () => {
  const totals = runTotals(
    { type: "result", modelUsage: { "": { inputTokens: 4, costUSD: 0.5 } } },
    [],
  );

  assert.equal(totals.models[0].model, "unknown");
  assert.equal(totals.models[0].tokensInput, 4);
});

test("an event that is not a charged turn folds to nothing", () => {
  assert.equal(runTurn({ type: "system" }, 1), undefined);
  assert.equal(runTurn({ type: "assistant", message: {} }, 1), undefined);
});

test("an interval that produced no bytes ships nothing", async () => {
  const { calls, tick } = harness();
  await tick();
  await tick();
  assert.deepEqual(calls, []);
});

test("turns are posted before the batch that covers them", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", {
    input_tokens: 1,
    output_tokens: 2,
  });
  await recorder.record(JSON.stringify(event), event);
  await tick();

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/turns", "/v1/run/transcript/1"],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body).turns, [
    {
      ordinal: 1,
      model: "claude-opus-4",
      tokensInput: 1,
      tokensOutput: 2,
      tokensCacheCreation: 0,
      tokensCacheRead: 0,
    },
  ]);
});

test("a turn row carries what the plane takes and nothing besides", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  await recorder.record(JSON.stringify(event), event);
  await tick();

  const [row] = JSON.parse(
    calls.find(({ path }) => path === "/v1/run/turns").init.body,
  ).turns;
  assert.deepEqual(Object.keys(row).sort(), [
    "model",
    "ordinal",
    "tokensCacheCreation",
    "tokensCacheRead",
    "tokensInput",
    "tokensOutput",
  ]);
});

/** The release of a plane from before turns named their subagent and runs took readings. */
const releaseBeforeContext = "1.43.0";

/** One API call's events as Claude Code streams them: one per content block, each repeating the call's id and usage. */
function callEvents(id, blocks, extra = {}) {
  return blocks.map((block) => ({
    type: "assistant",
    message: {
      id,
      model: "claude-opus-4",
      content: [{ type: block }],
      usage: { input_tokens: 10, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    ...extra,
  }));
}

async function recordAll(recorder, events) {
  for (const event of events)
    await recorder.record(JSON.stringify(event), event);
}

/** Every turn row a plane was posted, in the order it was posted them. */
function postedTurns(calls) {
  return calls
    .filter(({ path }) => path === "/v1/run/turns")
    .flatMap(({ init }) => JSON.parse(init.body).turns);
}

test("one API call is one turn row, whatever blocks it streamed as, and ordinals stay contiguous", async () => {
  const { recorder, calls, tick } = harness();
  await recordAll(recorder, [
    ...callEvents("msg_1", ["thinking", "text", "tool_use"]),
    ...callEvents("msg_2", ["text"]),
  ]);
  await tick();

  assert.deepEqual(
    postedTurns(calls).map(({ ordinal }) => ordinal),
    [1, 2],
  );
});

test("a run with no result folds its totals from one row per API call", async () => {
  const { recorder, calls } = harness();
  await recordAll(
    recorder,
    callEvents("msg_1", ["thinking", "text", "tool_use"]),
  );
  await recorder.finish();

  const totals = JSON.parse(
    calls.find(({ path }) => path === "/v1/run/totals").init.body,
  );
  assert.equal(totals.turns, 1);
  assert.equal(totals.tokensInput, 10);
});

test("a subagent's call names the call it was made under, to a plane that takes the field", async () => {
  const { recorder, calls, tick } = harness({ release: workerContractRelease });
  await recorder.configuration(Buffer.from("{}"));
  await recordAll(recorder, [
    ...callEvents("msg_1", ["tool_use"]),
    ...callEvents("msg_2", ["text"], { parent_tool_use_id: "toolu_01" }),
  ]);
  await tick();

  const turns = postedTurns(calls);
  assert.equal(Object.hasOwn(turns[0], "parentToolUseId"), false);
  assert.equal(turns[1].parentToolUseId, "toolu_01");
  assert.ok(workerRunTurnsSchema.safeParse({ turns }).success);
});

test("a plane from before the field is offered no subagent", async () => {
  const { recorder, calls, tick } = harness({ release: releaseBeforeContext });
  await recorder.configuration(Buffer.from("{}"));
  await recordAll(
    recorder,
    callEvents("msg_1", ["text"], { parent_tool_use_id: "toolu_01" }),
  );
  await tick();

  assert.equal(Object.hasOwn(postedTurns(calls)[0], "parentToolUseId"), false);
});

const compaction = {
  trigger: "Auto",
  tokensBefore: 167_000,
  tokensAfter: 9_000,
};

/** Every reading a plane was posted, in the order it was posted them. */
function postedReadings(calls) {
  return calls
    .filter(({ path }) => path === "/v1/run/context")
    .flatMap(({ init }) => JSON.parse(init.body).readings);
}

/** A reading of `cause` offered after the turns `recorder` has folded. */
function offerReading(recorder, cause, fields = {}) {
  recorder.context({ cause, afterTurn: recorder.turnsFolded(), ...fields });
}

test("a compaction posts one reading, after the turn it follows", async () => {
  const { recorder, calls, tick } = harness({ release: workerContractRelease });
  await recordAll(recorder, callEvents("msg_1", ["thinking", "text"]));
  offerReading(recorder, "Compaction", { compaction });
  await tick();

  const readings = postedReadings(calls);
  assert.deepEqual(readings, [
    { ordinal: 1, afterTurn: 1, cause: "Compaction", compaction },
  ]);
  assert.ok(workerRunContextSchema.safeParse({ readings }).success);
});

test("readings at start, at a compaction and at end are numbered in the order offered, each with its window", async () => {
  const { recorder, calls, tick } = harness({ release: workerContractRelease });
  const window = contextWindow(contextUsage, (text) => text);
  offerReading(recorder, "Start", { window });
  await recordAll(recorder, callEvents("msg_1", ["text"]));
  offerReading(recorder, "Compaction", { compaction, window });
  await recordAll(recorder, callEvents("msg_2", ["text"]));
  offerReading(recorder, "End", { window });
  await tick();

  const readings = postedReadings(calls);
  assert.deepEqual(
    readings.map(({ ordinal, afterTurn, cause }) => [
      ordinal,
      afterTurn,
      cause,
    ]),
    [
      [1, 0, "Start"],
      [2, 1, "Compaction"],
      [3, 2, "End"],
    ],
  );
  assert.ok(readings.every((reading) => reading.window !== undefined));
  assert.ok(workerRunContextSchema.safeParse({ readings }).success);
});

/** Catches a window the contract refuses costing the compaction it rides on, or posting a reading that is nothing but its cause. */
test("a refused window costs a compaction only its window, and any other reading itself", async () => {
  const { recorder, calls, tick } = harness({ release: workerContractRelease });
  const refused = { ...contextWindow(contextUsage, (text) => text), model: "" };
  await recordAll(recorder, callEvents("msg_1", ["text"]));
  offerReading(recorder, "Start", { window: refused });
  offerReading(recorder, "Compaction", { compaction, window: refused });
  offerReading(recorder, "End", { window: refused });
  await tick();

  assert.deepEqual(postedReadings(calls), [
    { ordinal: 1, afterTurn: 1, cause: "Compaction", compaction },
  ]);
});

test("a plane from before readings is offered none", async () => {
  const { recorder, calls } = harness({ release: releaseBeforeContext });
  await recordAll(recorder, callEvents("msg_1", ["text"]));
  offerReading(recorder, "Compaction", { compaction });
  await recorder.finish();

  assert.deepEqual(postedReadings(calls), []);
});

test("a refused reading stops the readings and nothing else of the run's evidence", async () => {
  const { recorder, calls, tick } = harness({
    release: workerContractRelease,
    behaviour: async (path) => {
      if (path === "/v1/run/context") throw new Error("refused");
    },
  });
  await recordAll(recorder, callEvents("msg_1", ["text"]));
  offerReading(recorder, "Compaction", { compaction });
  await tick();
  await recordAll(recorder, callEvents("msg_2", ["text"]));
  offerReading(recorder, "Compaction", { compaction });
  await tick();

  assert.equal(
    calls.filter(({ path }) => path === "/v1/run/context").length,
    1,
  );
  assert.equal(transcriptBatches(calls).length, 2);
  assert.equal(postedTurns(calls).length, 2);
});

test("a buffer that would exceed one body's worth is shipped first", async () => {
  const { recorder, calls, tick } = harness();
  const line = JSON.stringify({ type: "system", text: "x".repeat(1_000) });
  for (let written = 0; written < 200; written += 1)
    await recorder.record(line, { type: "system" });
  await tick();

  const batches = calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
  assert.deepEqual(
    batches.map(({ path }) => path),
    [
      "/v1/run/transcript/1",
      "/v1/run/transcript/2",
      "/v1/run/transcript/3",
      "/v1/run/transcript/4",
    ],
  );
  for (const batch of batches)
    assert.ok(batch.init.body.byteLength <= runTranscriptBatchBytesMax);
});

test("the transcript stops at its run cap with a line saying so", async () => {
  const { recorder, calls, tick } = harness();
  const line = JSON.stringify({ type: "system" });
  for (let batch = 0; batch < runTranscriptBatchesMax + 2; batch += 1) {
    await recorder.record(line, { type: "system" });
    await tick();
  }

  const batches = calls.filter(({ path }) => path.startsWith("/v1/run/tran"));
  assert.equal(batches.length, runTranscriptBatchesMax);
  assert.equal(
    batches.at(-1).path,
    `/v1/run/transcript/${String(runTranscriptBatchesMax)}`,
  );
  assert.deepEqual(JSON.parse(batches.at(-1).init.body.toString("utf8")), {
    type: "chuggy_transcript_truncated",
    batches: runTranscriptBatchesMax,
  });
});

test("the turn series stops at its bound and the transcript says so", async () => {
  const { recorder, calls, tick } = harness();
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  for (let turn = 0; turn < runTurnSeriesMax + 5; turn += 1)
    await recorder.record(line, event);
  await tick();

  const posted = calls
    .filter(({ path }) => path === "/v1/run/turns")
    .flatMap(({ init }) => JSON.parse(init.body).turns);
  assert.equal(posted.length, runTurnSeriesMax);
  assert.equal(posted.at(-1).ordinal, runTurnSeriesMax);
  const shipped = calls
    .filter(({ path }) => path.startsWith("/v1/run/tran"))
    .map(({ init }) => init.body.toString("utf8"))
    .join("");
  assert.ok(
    shipped.includes(
      JSON.stringify({
        type: "chuggy_turns_truncated",
        turns: runTurnSeriesMax,
      }),
    ),
  );
});

test("a refused evidence call stops the transcript and never fails the run", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  await recorder.record(line, event);
  await tick();
  const refusedAt = calls.length;
  await recorder.record(line, event);
  await tick();

  assert.deepEqual(
    calls.slice(0, refusedAt).map(({ path }) => path),
    ["/v1/run/turns", "/v1/run/transcript/1"],
  );
  assert.equal(calls.length, refusedAt);
});

/** Catches a refusal that leaves the batches queued behind it to be offered again. */
test("a refusal stops the batches waiting behind the one refused", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  const line = JSON.stringify({ type: "system", text: "x".repeat(1_000) });
  for (let written = 0; written < 200; written += 1)
    recorder.record(line, { type: "system" });
  await tick();
  await tick();
  await recorder.finish();

  assert.deepEqual(
    transcriptBatches(calls).map(({ path }) => path),
    ["/v1/run/transcript/1"],
  );
});

/** Catches a flush queued behind another on every interval a slow plane outlasts. */
test("a tick that finds a flush in flight starts no other", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  recorder.record(JSON.stringify({ type: "system" }), { type: "system" });
  const inFlight = tick();

  assert.equal(tick(), inFlight);
  assert.equal(tick(), inFlight);
  plane.back();
  await inFlight;

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/transcript/1"],
  );
});

/** Catches a run whose end took the flush in flight for the last one, and posted its totals over a line still buffered. */
test("a run that ends with a flush in flight ships what that flush left behind", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  const lines = ["first", "second"].map((text) =>
    JSON.stringify({ type: "system", text }),
  );
  recorder.record(lines[0], { type: "system" });
  tick();
  await new Promise((turned) => setImmediate(turned));
  recorder.record(lines[1], { type: "system" });
  const finished = recorder.finish();
  plane.back();
  await finished;

  assert.deepEqual(
    calls.map(({ path, init }) => [path, init.body.toString("utf8")]),
    [
      ["/v1/run/transcript/1", `${lines[0]}\n`],
      ["/v1/run/transcript/2", `${lines[1]}\n`],
      ["/v1/run/totals", calls.at(-1).init.body],
    ],
  );
});

/**
 * An agent writing more than a batch while the plane is away. Catches a writer
 * held until the plane answers, a line dropped or reordered while it waited,
 * and a batch closed over the size one body carries.
 */
test("a line written while the plane is away waits for nothing, and none is lost", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness(plane);
  const lines = Array.from({ length: 200 }, (_, written) =>
    JSON.stringify({ type: "system", text: String(written).padEnd(1_000) }),
  );
  recorder.record(lines[0], { type: "system" });
  const inFlight = tick();
  const written = (async () => {
    for (const line of lines.slice(1))
      await recorder.record(line, { type: "system" });
  })();

  const waited = await Promise.race([
    written.then(() => false),
    new Promise((turned) => setImmediate(() => turned(true))),
  ]);
  assert.equal(waited, false, "the writer waited on a plane that was away");
  plane.back();
  await inFlight;
  await recorder.finish();

  const batches = transcriptBatches(calls);
  assert.ok(batches.length > 2, String(batches.length));
  assert.deepEqual(
    batches.map(({ path }) => path),
    batches.map((_, sent) => `/v1/run/transcript/${String(sent + 1)}`),
  );
  for (const batch of batches)
    assert.ok(batch.init.body.byteLength <= runTranscriptBatchBytesMax);
  assert.equal(
    batches.map(({ init }) => init.body.toString("utf8")).join(""),
    lines.map((line) => `${line}\n`).join(""),
  );
});

/**
 * An agent taking turns while a batch waits on the plane, enough of them to
 * close another. Catches that batch sent ahead of the turns it covers, which
 * were folded after the flush sent its own.
 */
test("a batch closed while another waited is sent after the turns it covers", async () => {
  const plane = awayPlane();
  const { recorder, calls, tick } = harness({
    behaviour: (path) =>
      path === "/v1/run/transcript/1" ? plane.behaviour() : undefined,
  });
  const turn = (ordinal) => {
    const event = {
      ...assistantEvent("claude-test", { input_tokens: ordinal }),
      padding: "x".repeat(runTranscriptEventBytesMax / 2),
    };
    recorder.record(JSON.stringify(event), event);
  };
  turn(1);
  const inFlight = tick();
  await new Promise((turned) => setImmediate(turned));
  const turns = (4 * runTranscriptBatchBytesMax) / runTranscriptEventBytesMax;
  for (let ordinal = 2; ordinal <= turns; ordinal += 1) turn(ordinal);
  plane.back();
  await inFlight;
  await recorder.finish();

  let posted = 0;
  let covered = 0;
  for (const { path, init } of calls) {
    if (path === "/v1/run/turns")
      posted = JSON.parse(init.body).turns.at(-1).ordinal;
    if (!path.startsWith("/v1/run/tran")) continue;
    covered += init.body.toString("utf8").split("\n").length - 1;
    assert.ok(covered <= posted, `${path} went before turn ${covered}`);
  }
  assert.equal(covered, turns);
  assert.ok(transcriptBatches(calls).length > 2);
});

/**
 * What waits on a plane that is away is counted against the run's cap with
 * what was sent, so the queue ends where the transcript does. Catches a cap
 * read off the batches sent alone, which a plane that is away never moves.
 */
test("the batches waiting on a plane that is away stop at the run cap", async () => {
  let away;
  let back;
  const { recorder, calls, tick } = harness({ behaviour: () => away });
  const line = JSON.stringify({ type: "system" });
  const waiting = 3;
  for (let batch = 0; batch < runTranscriptBatchesMax - waiting; batch += 1) {
    recorder.record(line, { type: "system" });
    await tick();
  }
  away = new Promise((returned) => {
    back = returned;
  });
  recorder.record(line, { type: "system" });
  const inFlight = tick();
  const full = JSON.stringify({
    type: "system",
    text: "x".repeat(runTranscriptEventBytesMax / 2),
  });
  const fullBatches = 2 * waiting;
  for (
    let bytes = 0;
    bytes < fullBatches * runTranscriptBatchBytesMax;
    bytes += Buffer.byteLength(full)
  )
    recorder.record(full, { type: "system" });
  back();
  await inFlight;
  await recorder.finish();

  const batches = transcriptBatches(calls);
  assert.equal(batches.length, runTranscriptBatchesMax);
  assert.deepEqual(JSON.parse(batches.at(-1).init.body.toString("utf8")), {
    type: "chuggy_transcript_truncated",
    batches: runTranscriptBatchesMax,
  });
});

test("a run that outlived its evidence still names the plane as the reason", () => {
  assert.equal(
    endedEvidence({ subtype: "error_max_turns" }, false, undefined),
    "RunTurnsExhausted",
  );
  assert.equal(endedEvidence(undefined, true, undefined), "RunUploadRefused");
  assert.equal(endedEvidence(undefined, false, undefined), "RunFailed");
  assert.equal(
    endedEvidence({ subtype: "error_during_execution" }, false, undefined),
    "RunFailed",
  );
});

test("a run stopped at a step is that step's, whatever else it saw", () => {
  const steps = [
    runCloneFailed,
    runSetupFailed,
    runCommitFailed,
    runPushFailed,
    runTimedOut,
  ];
  assert.equal(new Set(steps).size, steps.length);
  for (const step of steps) {
    assert.ok(runEndedEvidences.includes(step), step);
    assert.equal(
      endedEvidence(
        { subtype: "error_max_turns" },
        true,
        seenBy(rejection),
        step,
      ),
      step,
    );
  }
});

test("a step's failure carries its label, led by what the step says of it", async () => {
  const failure = Object.assign(new Error("Command failed: git push"), {
    stderr: "fatal: denied",
  });
  const failed = await runStep(
    runPushFailed,
    () => Promise.reject(failure),
    ({ stderr }) => stderr,
  ).catch((thrown) => thrown);

  assert.ok(failed instanceof RunStepFailure);
  assert.equal(failed.evidence, runPushFailed);
  assert.equal(failed.message, "fatal: denied\n\nCommand failed: git push");
  assert.equal(failed.cause, failure);
  assert.equal(await runStep(runPushFailed, async () => "pushed"), "pushed");
});

test("a step's failure inside another step keeps its own label and text", async () => {
  const inner = new RunStepFailure(runCommitFailed, "the commit failed");
  const failed = await runStep(
    runPushFailed,
    () => Promise.reject(inner),
    () => "a lead",
  ).catch((thrown) => thrown);

  assert.equal(failed, inner);
});

test("a step's failure says nothing more where nothing leads it", async () => {
  const failed = await runStep(runCloneFailed, () => {
    throw new Error("no repository configuration for repository-1");
  }).catch((thrown) => thrown);

  assert.equal(failed.evidence, runCloneFailed);
  assert.equal(failed.message, "no repository configuration for repository-1");
});

/**
 * The frames kasofsk/chuggy#386 reports, as the runtime declares them: the
 * status is on `rate_limit_info`, and the result the issue quotes says only
 * `api_error`. Nothing in either carries the text the label used to look for.
 */
const rejection = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    rateLimitType: "five_hour",
    utilization: 1,
    resetsAt: 1787823600,
  },
};
const apiErrorResult = {
  type: "result",
  subtype: "error_during_execution",
  terminal_reason: "api_error",
};

test("the run the issue reports is a hold, and the same run without the rejection is not", () => {
  const seen = seenBy(rejection);
  assert.equal(endedEvidence(apiErrorResult, false, seen), "RunRateLimited");
  assert.equal(
    endedEvidence(apiErrorResult, false, rateLimitSightings()),
    "RunFailed",
  );
});

test("an assistant frame naming the rate-limited error kind is a hold", () => {
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy({ type: "assistant", error: "rate_limit" }),
    ),
    "RunRateLimited",
  );
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy({ type: "assistant", error: "server_error" }),
    ),
    "RunFailed",
  );
});

test("a rejection the provider then lifted is not a hold when the run ends", () => {
  assert.equal(
    endedEvidence(
      apiErrorResult,
      false,
      seenBy(rejection, {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
    ),
    "RunFailed",
  );
});

test("a hold outranks the turn count, because a held run had no turns to spend", () => {
  assert.equal(
    endedEvidence({ subtype: "error_max_turns" }, false, seenBy(rejection)),
    "RunRateLimited",
  );
});

/**
 * Catches exhausted credits labelled for a plane whose release does not take
 * the label, which would refuse the run's end, or labelled a hold, or outranking
 * a step of the harness's own.
 */
test("exhausted credits end a run RunCreditsExhausted only to a plane whose release takes it, outranking a hold", () => {
  const seen = seenBy(rejection, creditsRefused, creditsResult);
  const takes = workerContractCredentialOutcome;
  const before = { ...takes, minor: takes.minor - 1 };
  assert.ok(runEndedEvidences.includes("RunCreditsExhausted"));
  assert.equal(
    endedEvidence(creditsResult, false, seen, undefined, takes),
    "RunCreditsExhausted",
  );
  assert.equal(
    endedEvidence(creditsResult, false, seen, undefined, before),
    "RunRateLimited",
  );
  assert.equal(
    endedEvidence(
      creditsResult,
      false,
      seenBy(creditsRefused, creditsResult),
      undefined,
      before,
    ),
    "RunFailed",
  );
  assert.equal(
    endedEvidence(creditsResult, false, seen, undefined, undefined),
    "RunRateLimited",
  );
  assert.equal(
    endedEvidence(creditsResult, false, seen, runTimedOut, takes),
    runTimedOut,
  );
});

/** Catches a workspace whose Codex credits are depleted labelled a limit, or a Codex limit labelled exhausted credits. */
test("a Codex rollout naming depleted credits ends RunCreditsExhausted, and one naming a limit RunRateLimited", () => {
  const takes = workerContractCredentialOutcome;
  const ended = (snapshot) =>
    endedEvidence(
      undefined,
      false,
      observeCodexRollout(rateLimitSightings(), {
        snapshot,
        errorInfo: "usage_limit_exceeded",
      }),
      undefined,
      takes,
    );
  for (const reached of creditsDepletedTypes) {
    assert.equal(
      ended(creditsDepletedSnapshot(reached)),
      "RunCreditsExhausted",
    );
    assert.equal(
      ended({ ...limitSnapshot, rate_limit_reached_type: reached }),
      "RunCreditsExhausted",
    );
  }
  for (const reached of limitReachedTypes)
    assert.equal(
      ended({ ...limitSnapshot, rate_limit_reached_type: reached }),
      "RunRateLimited",
    );
  assert.equal(ended(undefined), "RunRateLimited");
});

test("the recorder folds the frames it ships, so the ending reads the whole run", async () => {
  const { recorder, calls } = harness();
  const line = JSON.stringify(rejection);
  await recorder.record(line, rejection);
  recorder.observed(apiErrorResult);
  await recorder.ended();

  const ended = calls.find(({ path }) => path === "/v1/run/ended");
  assert.deepEqual(JSON.parse(ended.init.body), {
    evidence: "RunRateLimited",
    limit: { window: "five_hour", resetsAt: 1787823600 },
  });
});

/** Catches a Codex limit read from its rollout but not priced as a hold, or written into the transcript as if the run had streamed it. */
test("what a Codex rollout declared ends the run held and adds nothing to its transcript", async () => {
  const { recorder, calls, tick } = harness();
  recorder.rolloutObserved({
    snapshot: limitSnapshot,
    errorInfo: "usage_limit_exceeded",
  });
  await tick();
  await recorder.ended();

  assert.equal(recorder.sightings().reset.window, "seven_day");
  assert.deepEqual(
    calls.filter(({ path }) => path.startsWith("/v1/run/tran")),
    [],
  );
  const ended = calls.find(({ path }) => path === "/v1/run/ended");
  assert.deepEqual(JSON.parse(ended.init.body), {
    evidence: "RunRateLimited",
    limit: { window: "seven_day", resetsAt: weeklyResetsAtSecs },
  });
});

test("every transcript byte the worker ships has passed the scrub", async () => {
  const { recorder, calls, tick } = harness({
    scrub: credentialScrub([secret]),
  });
  const event = { type: "user", message: { content: `env printed ${secret}` } };
  await recorder.record(JSON.stringify(event), event);
  await tick();

  const shipped = calls
    .filter(({ path }) => path.startsWith("/v1/run/tran"))
    .map(({ init }) => init.body.toString("utf8"))
    .join("");
  assert.ok(!shipped.includes(secret));
  assert.ok(shipped.includes("[redacted credential]"));
});

test("a refused configuration does not stop the transcript it precedes", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path === "/v1/run/configuration") throw new Error("plane refused");
    },
  });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  await recorder.configuration(Buffer.from("{}"));
  await recorder.record(JSON.stringify(event), event);
  await tick();

  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/v1/run/configuration", "/v1/run/turns", "/v1/run/transcript/1"],
  );
});

test("a lost acknowledgement is resynced from the plane's own high-water", async () => {
  const { recorder, calls, tick } = harness({ turnsRecorded: 3 });
  const event = assistantEvent("claude-opus-4", { input_tokens: 1 });
  const line = JSON.stringify(event);
  await recorder.record(line, event);
  await tick();
  await recorder.record(line, event);
  await recorder.record(line, event);
  await tick();
  await recorder.record(line, event);
  await tick();

  const posted = calls.filter(({ path }) => path === "/v1/run/turns");
  assert.equal(posted.length, 2);
  assert.deepEqual(
    JSON.parse(posted[0].init.body).turns.map(({ ordinal }) => ordinal),
    [1],
  );
  assert.deepEqual(
    JSON.parse(posted[1].init.body).turns.map(({ ordinal }) => ordinal),
    [4],
  );
});

test("a run the runtime accounted for is not labelled by an earlier refusal", async () => {
  const refuseTranscript = {
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  };
  const first = harness(refuseTranscript);
  await first.recorder.record(JSON.stringify({ type: "system" }), {
    type: "system",
  });
  await first.tick();
  first.recorder.observed({
    type: "result",
    subtype: "error_during_execution",
  });
  await first.recorder.ended();

  const second = harness(refuseTranscript);
  second.recorder.observed({
    type: "result",
    subtype: "error_during_execution",
  });
  await second.recorder.record(JSON.stringify({ type: "system" }), {
    type: "system",
  });
  await second.tick();
  await second.recorder.ended();

  for (const { calls } of [first, second])
    assert.equal(
      JSON.parse(calls.at(-1).init.body).evidence,
      "RunFailed",
      "the runtime's own account of the run outranks a refused upload",
    );
});

test("a run nothing else accounts for is labelled by the refusal", async () => {
  const { recorder, calls, tick } = harness({
    behaviour: (path) => {
      if (path.startsWith("/v1/run/tran")) throw new Error("plane refused");
    },
  });
  await recorder.record(JSON.stringify({ type: "system" }), { type: "system" });
  await tick();
  await recorder.ended();

  assert.equal(JSON.parse(calls.at(-1).init.body).evidence, "RunUploadRefused");
});

test("the totals a run ends with are posted once", async () => {
  const { recorder, calls } = harness();
  const event = { type: "result", num_turns: 2, total_cost_usd: 0.5 };
  recorder.observed(event);
  await recorder.finish();
  await recorder.finish();

  const totals = calls.filter(({ path }) => path === "/v1/run/totals");
  assert.equal(totals.length, 1);
  assert.equal(JSON.parse(totals[0].init.body).costUsdMicros, 500_000);
});

/** `event` as the stream carried it. */
function framed(recorder, event) {
  recorder.record(JSON.stringify(event), event);
}

/** The totals a recorder posted when it finished. */
async function postedTotals(recorder, calls) {
  await recorder.finish();
  const posted = calls.find(({ path }) => path === "/v1/run/totals");
  return JSON.parse(posted.init.body);
}

/** A process's result as the runtime wrote it: `figures` over nothing spent. */
function processResult(figures) {
  return { type: "result", subtype: "success", ...figures };
}

/** What the plane holds of one model's use in a process's `modelUsage`. */
function modelUse(inputTokens, costUSD) {
  return { "claude-opus-5-5": { inputTokens, outputTokens: 1, costUSD } };
}

/**
 * The figures of two processes of one conversation, as a real resumed run wrote
 * them: its usage, turns and wall time counted from the process's start, and
 * its cost, API time and model rows carried on from the session's. Catches a
 * run charged only its last process, which is what `observed` overwriting the
 * first would do, and a run charged its first process's cost twice.
 */
test("a resumed run's totals are the sum of what each process counted alone, and the last of what the session carried", async () => {
  const { recorder, calls } = harness();
  recorder.observed(
    processResult({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      num_turns: 28,
      duration_ms: 1_000,
      duration_api_ms: 1_734,
      total_cost_usd: 1.2,
      modelUsage: modelUse(10, 1.2),
      permission_denials: [{}],
      stop_reason: "stop_sequence",
    }),
  );

  recorder.resumed();
  recorder.observed(
    processResult({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
      num_turns: 2,
      duration_ms: 500,
      duration_api_ms: 3_188,
      total_cost_usd: 2.5,
      modelUsage: modelUse(20, 2.5),
      permission_denials: [{}, {}],
      stop_reason: "end_turn",
    }),
  );

  const totals = await postedTotals(recorder, calls);
  assert.equal(totals.tokensInput, 11);
  assert.equal(totals.tokensOutput, 22);
  assert.equal(totals.tokensCacheCreation, 33);
  assert.equal(totals.tokensCacheRead, 44);
  assert.equal(totals.turns, 30);
  assert.equal(totals.durationMs, 1_500);
  assert.equal(totals.permissionDenials, 3);
  assert.equal(totals.durationApiMs, 3_188);
  assert.equal(totals.costUsdMicros, 2_500_000);
  assert.deepEqual(
    totals.models.map(({ tokensInput }) => tokensInput),
    [20],
  );
  assert.equal(totals.stopReason, "end_turn");
});

/**
 * A process that died unaccounted leaves only the turns it streamed. Catches
 * the first process's turns counted again in what the second folds to, and the
 * cost and model rows the first was charged being lost to a total of nothing.
 */
test("a resumed process that ended unaccounted adds its turns to what was already accounted for", async () => {
  const { recorder, calls } = harness();
  framed(recorder, assistantEvent("claude-opus-5-5", { input_tokens: 7 }));
  recorder.observed(
    processResult({
      usage: { input_tokens: 7, output_tokens: 1 },
      num_turns: 1,
      duration_ms: 100,
      duration_api_ms: 90,
      total_cost_usd: 1,
      modelUsage: modelUse(7, 1),
    }),
  );

  recorder.resumed();
  framed(recorder, assistantEvent("claude-opus-5-5", { input_tokens: 5 }));

  const totals = await postedTotals(recorder, calls);
  assert.equal(totals.tokensInput, 12);
  assert.equal(totals.turns, 2);
  assert.equal(totals.costUsdMicros, 1_000_000);
  assert.equal(totals.durationApiMs, 90);
  assert.deepEqual(
    totals.models.map(({ tokensInput, costUsdMicros }) => [
      tokensInput,
      costUsdMicros,
    ]),
    [[12, 1_000_000]],
  );
});

test("a run that was never resumed posts the totals it always did", async () => {
  const { recorder, calls } = harness();
  const result = processResult({
    usage: { input_tokens: 3, output_tokens: 4 },
    num_turns: 2,
    total_cost_usd: 0.5,
  });
  recorder.observed(result);

  assert.deepEqual(
    await postedTotals(recorder, calls),
    JSON.parse(JSON.stringify(runTotals(result, []))),
  );
});

/**
 * Catches a process charged a limit the one before it saw. A rejection is
 * sticky within a process, so without this a run that came back from its hold
 * and then failed for its own reasons would be held again, and end labelled as
 * though the provider had refused it.
 */
test("a resumed process starts with nothing seen of the limit", () => {
  const { recorder } = harness();
  framed(recorder, { type: "assistant", error: "rate_limit", message: {} });
  assert.ok(rateLimited(recorder.sightings()));

  recorder.resumed();

  assert.ok(!rateLimited(recorder.sightings()));
});

/** Catches a turn series whose ordinals start over, which the plane would read as the first process's turns sent again. */
test("a resumed process's turns go on from the last ordinal", async () => {
  const { recorder, calls } = harness();
  framed(recorder, assistantEvent("claude-opus-5-5", { input_tokens: 1 }));

  recorder.resumed();
  framed(recorder, assistantEvent("claude-opus-5-5", { input_tokens: 1 }));
  await recorder.finish();

  const sent = calls
    .filter(({ path }) => path === "/v1/run/turns")
    .flatMap(({ init }) => JSON.parse(init.body).turns);
  assert.deepEqual(
    sent.map(({ ordinal }) => ordinal),
    [1, 2],
  );
});

test("a hold is a line of the transcript, saying until when and which window", async () => {
  const { recorder, calls } = harness();

  const line = recorder.held({
    until: "2026-10-30T18:01:00.000Z",
    window: "five_hour",
  });
  await recorder.finish();

  assert.deepEqual(JSON.parse(line), {
    type: "chuggy_run_held",
    until: "2026-10-30T18:01:00.000Z",
    window: "five_hour",
  });
  assert.ok(
    transcriptBatches(calls).some(({ init }) =>
      Buffer.from(init.body).toString("utf8").includes(line),
    ),
  );
});

/** Catches a resume the limit stopped at once emptying the rows of what the run spent. */
test("a resumed process whose result names no model leaves the rows before it", async () => {
  const { recorder, calls } = harness();
  recorder.observed(
    processResult({ total_cost_usd: 1.2, modelUsage: modelUse(10, 1.2) }),
  );
  recorder.resumed();
  recorder.observed(processResult({ num_turns: 1, total_cost_usd: 1.2 }));

  const totals = await postedTotals(recorder, calls);
  assert.equal(totals.costUsdMicros, 1_200_000);
  assert.deepEqual(
    totals.models.map(({ tokensInput, costUsdMicros }) => ({
      tokensInput,
      costUsdMicros,
    })),
    [{ tokensInput: 10, costUsdMicros: 1_200_000 }],
  );
});

/** The second the harness's clock says each frame was seen in. */
const observedAtSecs = Math.floor(observedAtMs / 1_000);

/** What `limitRejected`'s windows read as, seen on the harness's clock. */
const limitReadings = {
  five_hour: {
    utilization: 1,
    resetsAt: limitResetsAtSecs,
    observedAt: observedAtSecs,
  },
  seven_day: {
    utilization: 0.5,
    resetsAt: 1_793_764_800,
    observedAt: observedAtSecs,
  },
};

/** The end a recorder posted, held to the contract. */
async function postedEnded(recorder, calls, step) {
  await recorder.ended(step);
  const posted = calls.find(({ path }) => path === "/v1/run/ended");
  const body = JSON.parse(posted.init.body);
  assert.ok(workerRunEndedSchema.safeParse(body).success, posted.init.body);
  return body;
}

/** Catches a run ended for a credential not delivered posting without the credential and why, or outside the contract. */
test("a run ended RunCredentialAbsent carries the credential and why, inside the contract", async () => {
  const { recorder, calls } = harness();
  const absent = { credential: "track-record", reason: "NotGranted" };
  await recorder.ended(runCredentialAbsent, absent);
  const posted = calls.find(({ path }) => path === "/v1/run/ended");
  const body = JSON.parse(posted.init.body);

  assert.ok(workerRunEndedSchema.safeParse(body).success, posted.init.body);
  assert.deepEqual(body, { evidence: "RunCredentialAbsent", absent });
});

test("a run's totals carry the latest reading of each window it saw, inside the contract", async () => {
  const { recorder, calls } = harness();
  framed(recorder, limitRejected);
  recorder.observed(processResult({ num_turns: 1 }));

  const totals = await postedTotals(recorder, calls);
  assert.ok(workerRunTotalsSchema.safeParse(totals).success);
  assert.deepEqual(totals.usage, limitReadings);
});

/** Catches an empty `usage` sent, and a run's totals changed by readings it never saw. */
test("a run that saw no reading posts no usage", async () => {
  const { recorder, calls } = harness();
  const result = processResult({ num_turns: 1 });
  recorder.observed(result);
  framed(recorder, {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", utilization: 50 },
  });

  assert.deepEqual(
    await postedTotals(recorder, calls),
    JSON.parse(JSON.stringify(runTotals(result, []))),
  );
});

/**
 * Catches readings dropped with the sightings when a hold ends, which would
 * leave the plane no reading of the window the run was held at.
 */
test("a run's readings survive its hold, and a later reading of a window replaces the earlier", async () => {
  const { recorder, calls } = harness();
  framed(recorder, limitRejected);
  recorder.resumed();
  assert.ok(!rateLimited(recorder.sightings()));
  framed(recorder, {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.01, resetsAt: 1_793_314_800 },
      },
    },
  });
  recorder.observed(processResult({ num_turns: 1 }));

  assert.deepEqual((await postedTotals(recorder, calls)).usage, {
    five_hour: {
      utilization: 0.01,
      resetsAt: 1_793_314_800,
      observedAt: observedAtSecs,
    },
    seven_day: limitReadings.seven_day,
  });
});

/** Catches a Codex rollout's usage made into a refusal, which would end a run with a verdict rate-limited. */
test("a Codex rollout's usage is read without being seen as a limit", async () => {
  const { recorder, calls } = harness();
  recorder.rolloutUsageObserved({
    snapshot: limitSnapshot,
    snapshotTimestamp: rolloutTimestamp,
    errorInfo: "usage_limit_exceeded",
  });

  assert.ok(!rateLimited(recorder.sightings()));
  assert.deepEqual((await postedTotals(recorder, calls)).usage, {
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

test("usage is each window read, and nothing where none was", () => {
  assert.equal(runUsage(rateLimitReadings()), undefined);
  assert.equal(runUsage(undefined), undefined);
  for (const readings of [
    limitReadings,
    { seven_day: limitReadings.seven_day },
  ]) {
    const usage = runUsage(readings);
    assert.deepEqual(usage, readings);
    assert.ok(workerRunUsageSchema.safeParse(usage).success);
  }
});

/** Catches a field the contract would refuse sent, which would leave the attempt to the lease sweep. */
test("a limit carries each field of its reset the contract takes, floored, and is nothing where it takes neither", () => {
  for (const [reset, limit] of [
    [
      { resetsAtSecs: 1_793_296_800, window: "five_hour" },
      { window: "five_hour", resetsAt: 1_793_296_800 },
    ],
    [
      { resetsAtSecs: 1_793_296_800.75, window: "seven_day" },
      { window: "seven_day", resetsAt: 1_793_296_800 },
    ],
    [
      { resetsAtSecs: 1_793_296_800, window: "seven_day_opus" },
      { resetsAt: 1_793_296_800 },
    ],
    [
      { resetsAtSecs: 1_793_296_800, window: undefined },
      { resetsAt: 1_793_296_800 },
    ],
    [{ resetsAtSecs: 0.5, window: "five_hour" }, { window: "five_hour" }],
    [{ resetsAtSecs: 0.5, window: "overage" }, undefined],
    [undefined, undefined],
  ]) {
    assert.deepEqual(runLimit(reset), limit, JSON.stringify(reset));
    if (limit !== undefined)
      assert.ok(workerRunLimitSchema.safeParse(limit).success);
  }
});

test("a run ended rate-limited carries the limit that stopped it", async () => {
  const { recorder, calls } = harness();
  framed(recorder, limitRejected);

  assert.deepEqual(await postedEnded(recorder, calls), {
    evidence: "RunRateLimited",
    limit: { window: "five_hour", resetsAt: limitResetsAtSecs },
  });
});

/** A limit whose reset names neither a window nor a time the contract takes. */
const limitRejectedBare = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: 0.5,
    rateLimitType: "seven_day_opus",
  },
};

test("a limit whose reset the contract takes no field of is left out of the end", async () => {
  const { recorder, calls } = harness();
  framed(recorder, limitRejectedBare);

  assert.deepEqual(await postedEnded(recorder, calls), {
    evidence: "RunRateLimited",
  });
});

/** Catches a limit sent beside a label it is not kept beside. */
test("a run ended any other way carries no limit, whatever it saw", async () => {
  const { recorder, calls } = harness();
  framed(recorder, limitRejected);

  assert.deepEqual(await postedEnded(recorder, calls, runPushFailed), {
    evidence: "RunPushFailed",
  });
});

/** The name a run is told its credential has, as a runner with credential sets tells it. */
const runCredentialName = "work-2";

/** Releases of a plane against the one that takes a run's credential: the first, a later, an earlier, and none named. */
const runCredentialReleases = {
  at: `${workerContractRunCredential.major}.${workerContractRunCredential.minor}.0`,
  later: `${workerContractRunCredential.major}.${workerContractRunCredential.minor + 1}.0`,
  earlier: `${workerContractRunCredential.major}.${workerContractRunCredential.minor - 1}.0`,
  none: undefined,
};

/**
 * What a recorder told `credential`, answered at `release`, posts once the
 * plane has answered it: `post` reads the body from the recorder and its calls.
 */
async function runCredentialPosted(release, credential, events, post) {
  const { recorder, calls } = harness({ release, credential });
  await recorder.configuration(Buffer.from("{}"));
  for (const event of events) framed(recorder, event);
  recorder.observed(processResult({ num_turns: 1 }));
  return post(recorder, calls);
}

/**
 * Catches a credential named to a plane whose strict schema refuses it, which
 * loses a run's totals, and a credential not named where it is taken, which
 * keeps one credential's usage under another's name.
 */
test("a run's totals name its credential beside its usage, only to a plane that takes it", async () => {
  for (const [release, credential, events, named] of [
    ["at", runCredentialName, [limitRejected], true],
    ["later", runCredentialName, [limitRejected], true],
    ["earlier", runCredentialName, [limitRejected], false],
    ["none", runCredentialName, [limitRejected], false],
    ["at", runCredentialName, [], false],
    ["at", undefined, [limitRejected], false],
    ["later", undefined, [limitRejected], false],
    ["earlier", undefined, [limitRejected], false],
  ]) {
    const case_ = JSON.stringify({ release, credential, events, named });
    const answered = runCredentialReleases[release];
    const posted = await runCredentialPosted(
      answered,
      credential,
      events,
      postedTotals,
    );
    const today = await runCredentialPosted(
      answered,
      undefined,
      events,
      postedTotals,
    );
    assert.ok(workerRunTotalsSchema.safeParse(posted).success, case_);
    assert.deepEqual(
      posted,
      named ? { ...today, credential: runCredentialName } : today,
      case_,
    );
    assert.equal(Object.hasOwn(posted, "credential"), named, case_);
  }
});

/**
 * Catches a limit naming its credential to a plane that refuses it, which
 * leaves the run's end unreported, and a limit sent beside another label.
 */
test("a rate-limited end names its credential inside its limit, only to a plane that takes it", async () => {
  const resetsAt = limitResetsAtSecs;
  for (const [release, credential, event, step, limit] of [
    [
      "at",
      runCredentialName,
      limitRejected,
      undefined,
      { window: "five_hour", resetsAt, credential: runCredentialName },
    ],
    [
      "later",
      runCredentialName,
      limitRejected,
      undefined,
      { window: "five_hour", resetsAt, credential: runCredentialName },
    ],
    [
      "at",
      runCredentialName,
      limitRejectedBare,
      undefined,
      { credential: runCredentialName },
    ],
    [
      "earlier",
      runCredentialName,
      limitRejected,
      undefined,
      { window: "five_hour", resetsAt },
    ],
    [
      "none",
      runCredentialName,
      limitRejected,
      undefined,
      { window: "five_hour", resetsAt },
    ],
    ["earlier", runCredentialName, limitRejectedBare, undefined, undefined],
    ["none", runCredentialName, limitRejectedBare, undefined, undefined],
    ["at", runCredentialName, limitRejected, runPushFailed, undefined],
    ["at", undefined, limitRejectedBare, undefined, undefined],
    [
      "later",
      undefined,
      limitRejected,
      undefined,
      { window: "five_hour", resetsAt },
    ],
  ]) {
    const case_ = JSON.stringify({ release, credential, event, step });
    const posted = await runCredentialPosted(
      runCredentialReleases[release],
      credential,
      [event],
      (recorder, calls) => postedEnded(recorder, calls, step),
    );
    const evidence = step ?? "RunRateLimited";
    assert.deepEqual(
      posted,
      limit === undefined ? { evidence } : { evidence, limit },
      case_,
    );
  }
});

/** Catches a resumed run that loses the name its readings were read of. */
test("a resumed run goes on naming the credential it was told", async () => {
  const { recorder, calls } = harness({
    release: runCredentialReleases.at,
    credential: runCredentialName,
  });
  await recorder.configuration(Buffer.from("{}"));
  framed(recorder, limitRejected);
  recorder.resumed();
  framed(recorder, limitRejected);
  recorder.observed(processResult({ num_turns: 1 }));

  const totals = await postedTotals(recorder, calls);
  assert.deepEqual(totals.usage, limitReadings);
  assert.equal(totals.credential, runCredentialName);
  assert.equal(
    (await postedEnded(recorder, calls)).limit.credential,
    runCredentialName,
  );
});
