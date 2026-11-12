import assert from "node:assert/strict";
import test from "node:test";

import { workerRunnerCredentialsPerAgentMax } from "@chuggy/worker-contract/workerPool";

import {
  agentCredentialAssignmentsMax,
  agentCredentialCarried,
  agentCredentialChosen,
  agentCredentialReported,
  agentCredentialSelector,
  agentCredentialSets,
  agentCredentialSetsSchema,
  agentCredentialsDescribed,
  agentCredentialsScrubbedCarried,
  agentCredentialsScrubbedNamed,
  claudeCredentialSetSchema,
  codexCredentialSetSchema,
} from "./agentCredentialSet.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";

/** Claude's set of two subscription tokens and two API keys, under `prefer` and `order`. */
function claudeSet(prefer, order = "InOrder") {
  return {
    prefer,
    oauth: {
      order,
      credentials: [
        { name: "max-1", tokenFile: "/c/max-1" },
        { name: "max-2", tokenFile: "/c/max-2" },
      ],
    },
    apiKey: {
      order,
      credentials: [
        { name: "key-1", apiKeyFile: "/c/key-1" },
        { name: "key-2", apiKeyFile: "/c/key-2" },
      ],
    },
  };
}

/** Codex's set of two ChatGPT logins and an API key. */
const codexSet = {
  prefer: "PreferOAuth",
  oauth: {
    order: "RoundRobin",
    credentials: [
      { name: "chatgpt-1", authFile: "/x/auth-1.json" },
      { name: "chatgpt-2", authFile: "/x/auth-2.json" },
    ],
  },
  apiKey: {
    order: "InOrder",
    credentials: [{ name: "openai-1", apiKeyFile: "/x/openai-1" }],
  },
};

/** Every form a runner's file names Claude's credential in before sets. */
const claudeSingles = [
  { kind: "Subscription", tokenFile: "/c/token" },
  { kind: "ApiKey", apiKeyFile: "/c/key" },
  { kind: "Bedrock", region: "us-west-2", apiKeyFile: "/c/bedrock" },
  {
    kind: "Bedrock",
    region: "us-west-2",
    credentialsFile: "/c/aws",
    profile: "chuggy",
  },
  {
    kind: "Vertex",
    region: "us-east5",
    project: "example",
    credentialsFile: "/c/gcp.json",
  },
  { kind: "Foundry", resource: "example", apiKeyFile: "/c/foundry" },
];

/** The name each credential `selector` chooses for `agent`, `count` workloads in turn. */
function chosenNames(selector, agent, count) {
  return Array.from({ length: count }, () => selector.chosen(agent)?.name);
}

/** Catches a set form a runner's file may name refused, or one read as anything but itself. */
test("a set of each policy and order, and every form a runner's file named before sets, is read", () => {
  for (const prefer of ["PreferOAuth", "OAuthOnly", "ApiKeyOnly"])
    for (const order of ["InOrder", "RoundRobin"])
      assert.ok(
        claudeCredentialSetSchema.safeParse(claudeSet(prefer, order)).success,
      );
  assert.ok(
    claudeCredentialSetSchema.safeParse({
      prefer: "OAuthOnly",
      oauth: claudeSet("OAuthOnly").oauth,
    }).success,
  );
  assert.ok(
    claudeCredentialSetSchema.safeParse({
      prefer: "PreferOAuth",
      apiKey: claudeSet("ApiKeyOnly").apiKey,
    }).success,
  );
  for (const single of claudeSingles)
    assert.deepEqual(claudeCredentialSetSchema.parse(single), single);
  assert.ok(codexCredentialSetSchema.safeParse(codexSet).success);
  assert.deepEqual(codexCredentialSetSchema.parse({ authFile: "/x/auth" }), {
    authFile: "/x/auth",
  });
  assert.ok(
    agentCredentialSetsSchema.safeParse({
      claudeCredential: claudeSet("PreferOAuth"),
      codexCredential: codexSet,
    }).success,
  );
});

/**
 * Catches a credential a runner's file named before sets meaning anything but
 * what it meant: a subscription's token is an OAuth credential and an API key
 * an API key, each run as its kind, and Bedrock, Vertex and Foundry each stay
 * that one credential, outside any policy.
 */
test("each credential named before sets is a set of one that runs as it always did", () => {
  const types = ["OAuth", "ApiKey", "Bedrock", "Bedrock", "Vertex", "Foundry"];
  claudeSingles.forEach((single, index) => {
    const { Claude } = agentCredentialSets({ claudeCredential: single });
    const chosen = agentCredentialSelector({ Claude }).chosen("Claude");
    assert.equal(chosen?.name, "claude");
    assert.equal(chosen?.type, types[index]);
    assert.equal(
      chosen?.file,
      single.tokenFile ?? single.credentialsFile ?? single.apiKeyFile,
    );
    assert.equal(
      agentCredentialCarried(chosen)[claudeCredentialVariable],
      JSON.stringify(
        single.kind === "Bedrock"
          ? {
              kind: "Bedrock",
              region: "us-west-2",
              ...(single.profile === undefined ? {} : { profile: "chuggy" }),
            }
          : Object.fromEntries(
              Object.entries(single).filter(([key]) => !key.endsWith("File")),
            ),
      ),
    );
  });
  const codex = agentCredentialSelector(
    agentCredentialSets({ codexCredential: { authFile: "/x/auth" } }),
  ).chosen("Codex");
  assert.deepEqual(codex, {
    agent: "Codex",
    name: "codex",
    type: "OAuth",
    file: "/x/auth",
  });
});

/** Catches a set that names no credential its policy allows, or a credential without a name a run could report. */
test("a policy naming no credential it allows, and a credential with no name or one no report can carry, are refused", () => {
  const { oauth, apiKey } = claudeSet("PreferOAuth");
  for (const refused of [
    { prefer: "OAuthOnly", apiKey },
    { prefer: "ApiKeyOnly", oauth },
    { prefer: "PreferOAuth" },
    { prefer: "Sometimes", oauth },
    { prefer: "OAuthOnly", oauth: { order: "InOrder", credentials: [] } },
    {
      prefer: "OAuthOnly",
      oauth: { order: "InOrder", credentials: [{ tokenFile: "/c/t" }] },
    },
    {
      prefer: "OAuthOnly",
      oauth: {
        order: "InOrder",
        credentials: [{ name: "my key", tokenFile: "/c/t" }],
      },
    },
    {
      prefer: "OAuthOnly",
      oauth: {
        order: "Shuffled",
        credentials: [{ name: "max-1", tokenFile: "/c/t" }],
      },
    },
  ])
    assert.equal(
      claudeCredentialSetSchema.safeParse(refused).success,
      false,
      JSON.stringify(refused),
    );
  assert.equal(
    codexCredentialSetSchema.safeParse({
      prefer: "OAuthOnly",
      oauth: {
        order: "InOrder",
        credentials: [{ name: "chatgpt", tokenFile: "/x/auth" }],
      },
    }).success,
    false,
  );
});

/** Catches two credentials a run would report under one name, within one agent's set or across both. */
test("a name is refused where another credential of the runner's has it, whichever agent's", () => {
  const twice = claudeSet("PreferOAuth");
  twice.apiKey.credentials[1].name = "max-1";
  const shared = {
    ...codexSet,
    apiKey: {
      order: "InOrder",
      credentials: [{ name: "key-1", apiKeyFile: "/x/k" }],
    },
  };
  for (const documents of [
    { claudeCredential: twice },
    { claudeCredential: claudeSet("PreferOAuth"), codexCredential: shared },
    {
      claudeCredential: { kind: "ApiKey", apiKeyFile: "/c/k" },
      codexCredential: {
        prefer: "OAuthOnly",
        oauth: {
          order: "InOrder",
          credentials: [{ name: "claude", authFile: "/x/a" }],
        },
      },
    },
  ]) {
    const read = agentCredentialSetsSchema.safeParse(documents);
    assert.equal(read.success, false);
    assert.match(
      read.error?.issues[0]?.message ?? "",
      /another credential of this runner's has that name/u,
    );
  }
});

/**
 * Catches a policy taking a type it does not allow or not preferring the one
 * it prefers, and an order that does not take its credentials in turn: each
 * policy under each order, across workloads.
 */
test("each policy takes its type and each order its credential, across workloads", () => {
  const expected = {
    PreferOAuth: {
      InOrder: ["max-1", "max-1", "max-1"],
      RoundRobin: ["max-1", "max-2", "max-1"],
    },
    OAuthOnly: {
      InOrder: ["max-1", "max-1", "max-1"],
      RoundRobin: ["max-1", "max-2", "max-1"],
    },
    ApiKeyOnly: {
      InOrder: ["key-1", "key-1", "key-1"],
      RoundRobin: ["key-1", "key-2", "key-1"],
    },
  };
  for (const [prefer, orders] of Object.entries(expected))
    for (const [order, names] of Object.entries(orders)) {
      const selector = agentCredentialSelector(
        agentCredentialSets({ claudeCredential: claudeSet(prefer, order) }),
      );
      assert.deepEqual(
        chosenNames(selector, "Claude", 3),
        names,
        `${prefer} ${order}`,
      );
    }
});

/** The name each credential the pure choice takes for `agent`, `count` workloads in turn from no state, under `available`. */
function chosenPurely(sets, agent, count, available) {
  let state = {};
  return Array.from({ length: count }, () => {
    const next = agentCredentialChosen(sets, state, agent, available);
    state = next.state;
    return next.credential?.name;
  });
}

/**
 * Catches a policy that prefers OAuth taking an API key while an OAuth
 * credential is available, or none once none is, and an order that takes one
 * that is not available.
 */
test("a policy preferring OAuth takes an API key only while no OAuth credential is available, and each order skips what is not", () => {
  const sets = agentCredentialSets({
    claudeCredential: claudeSet("PreferOAuth", "RoundRobin"),
  });
  const without =
    (...away) =>
    (credential) =>
      !away.includes(credential.name);
  assert.deepEqual(chosenPurely(sets, "Claude", 2, without("max-1")), [
    "max-2",
    "max-2",
  ]);
  assert.deepEqual(chosenPurely(sets, "Claude", 3, without("max-1", "max-2")), [
    "key-1",
    "key-2",
    "key-1",
  ]);
  assert.deepEqual(
    chosenPurely(
      sets,
      "Claude",
      1,
      without("max-1", "max-2", "key-1", "key-2"),
    ),
    [undefined],
  );
  assert.deepEqual(
    chosenPurely(
      agentCredentialSets({ claudeCredential: claudeSet("OAuthOnly") }),
      "Claude",
      1,
      (credential) => credential.type !== "OAuth",
    ),
    [undefined],
  );
  assert.deepEqual(
    chosenPurely(
      agentCredentialSets({ claudeCredential: claudeSet("ApiKeyOnly") }),
      "Claude",
      2,
      without("key-1"),
    ),
    ["key-2", "key-2"],
  );
});

/** A selector over `document`'s Claude set on a clock the test moves. */
function benchedSelector(document) {
  const clock = { nowMs: 1_000_000 };
  const selector = agentCredentialSelector(
    agentCredentialSets({ claudeCredential: document }),
    () => clock.nowMs,
  );
  return { selector, clock };
}

/** The credential `selector` chooses for a Claude job as `assignment`, by name. */
function chosenAs(selector, assignment) {
  return selector.chosen("Claude", assignment)?.name;
}

/** A usage-limited outcome for `assignment`, reset at `resetsAtMs`. */
function usageLimited(assignment, resetsAtMs) {
  return {
    assignment,
    outcome: "UsageLimited",
    resetsAt: Math.floor(resetsAtMs / 1_000),
  };
}

/** A pause of Claude's credential `credential` until `untilMs`, as an answer names it in whole seconds. */
function paused(credential, untilMs) {
  return {
    agent: "Claude",
    credential,
    pausedUntil: Math.floor(untilMs / 1_000),
  };
}

/** Catches InOrder staying on a benched credential, or not coming back to it once its reset has passed. */
test("InOrder moves to the second credential once the first is benched, and back once its reset passes", () => {
  const { selector, clock } = benchedSelector(claudeSet("OAuthOnly"));
  assert.equal(chosenAs(selector, "job-1"), "max-1");
  const resetMs = clock.nowMs + 3_600_000;
  selector.outcomesTaken([usageLimited("job-1", resetMs)]);
  assert.deepEqual(selector.benchOf("max-1"), {
    state: "Benched",
    until: resetMs,
  });
  assert.equal(chosenAs(selector, "job-2"), "max-2");
  assert.equal(chosenAs(selector, "job-3"), "max-2");
  clock.nowMs = resetMs;
  assert.deepEqual(selector.benchOf("max-1"), { state: "Available" });
  assert.equal(chosenAs(selector, "job-4"), "max-1");
});

/** Catches RoundRobin taking a benched credential in its turn. */
test("RoundRobin skips a benched credential", () => {
  const { selector } = benchedSelector({
    prefer: "ApiKeyOnly",
    apiKey: {
      order: "RoundRobin",
      credentials: ["key-1", "key-2", "key-3"].map((name) => ({
        name,
        apiKeyFile: `/c/${name}`,
      })),
    },
  });
  assert.equal(chosenAs(selector, "job-1"), "key-1");
  selector.outcomesTaken([
    { assignment: "job-1", outcome: "CreditsExhausted" },
  ]);
  assert.deepEqual(
    ["job-2", "job-3", "job-4", "job-5"].map((job) => chosenAs(selector, job)),
    ["key-2", "key-3", "key-2", "key-3"],
  );
});

/**
 * Catches PreferOAuth not falling to API keys while every OAuth credential is
 * benched or paused, or not returning after a reset, and OAuthOnly falling to
 * one rather than running on the OAuth credential free soonest.
 */
test("PreferOAuth falls to API keys while every OAuth credential is benched or paused, and returns once a reset passes", () => {
  const { selector, clock } = benchedSelector(claudeSet("PreferOAuth"));
  assert.equal(chosenAs(selector, "job-1"), "max-1");
  selector.outcomesTaken([usageLimited("job-1", clock.nowMs + 60_000)]);
  assert.equal(chosenAs(selector, "job-2"), "max-2");
  selector.outcomesTaken([usageLimited("job-2", clock.nowMs + 120_000)]);
  assert.equal(chosenAs(selector, "job-3"), "key-1");
  clock.nowMs += 60_000;
  assert.equal(chosenAs(selector, "job-4"), "max-1");

  for (const [prefer, expected] of [
    ["PreferOAuth", "key-1"],
    ["OAuthOnly", "max-2"],
  ]) {
    const { selector: pausing, clock: pausingClock } = benchedSelector(
      claudeSet(prefer),
    );
    pausing.pausesTaken([
      paused("max-1", pausingClock.nowMs + 120_000),
      paused("max-2", pausingClock.nowMs + 60_000),
    ]);
    assert.equal(chosenAs(pausing, "job-1"), expected, prefer);
  }
});

/**
 * Catches a paused credential taken in its turn, a pause outliving the answer
 * after the one that named it, or one read as holding once its end has
 * passed.
 */
test("a paused credential is passed over under each order until an answer names it no longer or its end passes", () => {
  for (const [order, whilePaused, onceAnswered] of [
    ["InOrder", ["max-2", "max-2", "max-2"], ["max-1", "max-1"]],
    ["RoundRobin", ["max-2", "max-2", "max-2"], ["max-1", "max-2"]],
  ]) {
    const { selector, clock } = benchedSelector(claudeSet("OAuthOnly", order));
    const untilMs = clock.nowMs + 60_000;
    selector.pausesTaken([paused("max-1", untilMs)]);
    assert.deepEqual(chosenNames(selector, "Claude", 3), whilePaused, order);
    selector.pausesTaken([]);
    assert.deepEqual(chosenNames(selector, "Claude", 2), onceAnswered, order);
    selector.pausesTaken([paused("max-1", untilMs)]);
    assert.deepEqual(chosenNames(selector, "Claude", 2), ["max-2", "max-2"]);
    clock.nowMs = untilMs;
    assert.deepEqual(chosenNames(selector, "Claude", 2), onceAnswered, order);
  }
});

/** Catches a pause of a credential the selector holds under another agent, or none, taken as one of its own. */
test("a pause is taken only of a credential its agent's set holds", () => {
  const { selector, clock } = benchedSelector(claudeSet("OAuthOnly"));
  selector.pausesTaken([
    { ...paused("max-1", clock.nowMs + 60_000), agent: "Codex" },
    paused("someone-else", clock.nowMs + 60_000),
  ]);
  assert.equal(chosenAs(selector, "job-1"), "max-1");
});

/**
 * Catches a selector answering nothing, or a credential free later, while
 * every credential its policy allows is benched or paused: a job offered
 * before the runner's polls leave the agent out, or one the plane handed over,
 * is not dropped.
 */
test("with every credential benched or paused the selector answers the one free soonest, at the later of its bench's end and its pause's", () => {
  const { selector, clock } = benchedSelector(claudeSet("PreferOAuth"));
  const soonestMs = clock.nowMs + 60_000;
  const benched = [
    ["max-1", { assignment: "job-1", outcome: "CreditsExhausted" }],
    ["max-2", usageLimited("job-2", clock.nowMs + 600_000)],
    ["key-1", usageLimited("job-3", soonestMs)],
    ["key-2", usageLimited("job-4", clock.nowMs + 300_000)],
  ];
  for (const [name, outcome] of benched) {
    assert.equal(chosenAs(selector, outcome.assignment), name);
    selector.outcomesTaken([outcome]);
  }
  assert.equal(chosenAs(selector, "job-5"), "key-1");
  assert.equal(chosenAs(selector, "job-6"), "key-1");
  clock.nowMs = soonestMs;
  assert.equal(chosenAs(selector, "job-7"), "key-1");
  selector.pausesTaken([
    paused("key-1", soonestMs + 700_000),
    paused("key-2", soonestMs),
  ]);
  assert.equal(chosenAs(selector, "job-8"), "key-2");

  const { selector: restarted } = benchedSelector(claudeSet("OAuthOnly"));
  for (const assignment of ["job-1", "job-2"]) {
    chosenAs(restarted, assignment);
    restarted.outcomesTaken([{ assignment, outcome: "CreditsExhausted" }]);
  }
  assert.equal(chosenAs(restarted, "job-3"), "max-1");
});

/** A selector over Claude's set under OAuthOnly and one Codex API key, on a clock the test moves. */
function twoAgentSelector() {
  const clock = { nowMs: 1_000_000 };
  const selector = agentCredentialSelector(
    agentCredentialSets({
      claudeCredential: claudeSet("OAuthOnly"),
      codexCredential: {
        prefer: "ApiKeyOnly",
        apiKey: {
          order: "InOrder",
          credentials: [{ name: "openai-1", apiKeyFile: "/c/openai-1" }],
        },
      },
    }),
    () => clock.nowMs,
  );
  return { selector, clock };
}

/**
 * Catches an agent left out while a credential its policy allows is
 * available, counted available on a credential its policy does not allow,
 * kept out once its earliest bench has ended, or left out for a pause, which
 * the plane holds a claim back for.
 */
test("an agent is unavailable while every credential its policy allows is benched, and available once the earliest bench ends, however many are paused", () => {
  const { selector, clock } = twoAgentSelector();
  const earliestMs = clock.nowMs + 60_000;
  assert.equal(chosenAs(selector, "job-1"), "max-1");
  selector.outcomesTaken([usageLimited("job-1", clock.nowMs + 120_000)]);
  assert.deepEqual(selector.unavailable(), []);
  assert.equal(chosenAs(selector, "job-2"), "max-2");
  selector.outcomesTaken([usageLimited("job-2", earliestMs)]);
  assert.deepEqual(selector.unavailable(), ["Claude"]);
  assert.equal(selector.chosen("Codex", "job-3")?.name, "openai-1");
  clock.nowMs = earliestMs - 1;
  assert.deepEqual(selector.unavailable(), ["Claude"]);
  clock.nowMs = earliestMs;
  assert.deepEqual(selector.unavailable(), []);
  selector.pausesTaken(
    ["max-1", "max-2"].map((name) => paused(name, earliestMs + 600_000)),
  );
  assert.deepEqual(selector.unavailable(), []);
});

/** Catches an agent whose every credential's credits are exhausted counted available again before a restart. */
test("an agent whose every credential is benched until restart stays unavailable", () => {
  const { selector, clock } = twoAgentSelector();
  for (const assignment of ["job-1", "job-2"]) {
    chosenAs(selector, assignment);
    selector.outcomesTaken([{ assignment, outcome: "CreditsExhausted" }]);
  }
  clock.nowMs += 365 * 24 * 3_600_000;
  assert.deepEqual(selector.unavailable(), ["Claude"]);
  assert.deepEqual(twoAgentSelector().selector.unavailable(), []);
});

/** Catches exhausted credits benched for a time, or a later usage limit shortening that bench. */
test("a credits-exhausted outcome benches its credential until restart", () => {
  const { selector, clock } = benchedSelector(claudeSet("OAuthOnly"));
  chosenAs(selector, "job-1");
  selector.outcomesTaken([
    { assignment: "job-1", outcome: "CreditsExhausted" },
  ]);
  selector.outcomesTaken([usageLimited("job-1", clock.nowMs + 60_000)]);
  clock.nowMs += 365 * 24 * 3_600_000;
  assert.deepEqual(selector.benchOf("max-1"), {
    state: "BenchedUntilRestart",
  });
  assert.equal(chosenAs(selector, "job-2"), "max-2");
});

/** Catches a usage limit with no reset benching its credential for a figure made up here. */
test("a usage-limited outcome with no reset time benches nothing", () => {
  const { selector } = benchedSelector(claudeSet("OAuthOnly"));
  chosenAs(selector, "job-1");
  selector.outcomesTaken([{ assignment: "job-1", outcome: "UsageLimited" }]);
  assert.deepEqual(selector.benchOf("max-1"), { state: "Available" });
  assert.equal(chosenAs(selector, "job-2"), "max-1");
});

/** Catches an outcome for an assignment this selector chose nothing for benching a credential anyway. */
test("an outcome for a job the runner did not run is ignored", () => {
  const { selector } = benchedSelector(claudeSet("OAuthOnly"));
  chosenAs(selector, "job-1");
  selector.chosen("Claude");
  selector.outcomesTaken([
    { assignment: "someone-else", outcome: "CreditsExhausted" },
  ]);
  for (const { bench } of selector.described())
    assert.deepEqual(bench, { state: "Available" });
  assert.equal(chosenAs(selector, "job-2"), "max-1");
});

/** Claude's set of `count` API keys in order. */
function apiKeysSet(count) {
  return {
    prefer: "ApiKeyOnly",
    apiKey: {
      order: "InOrder",
      credentials: Array.from({ length: count }, (_, index) => ({
        name: `key-${String(index + 1)}`,
        apiKeyFile: `/c/key-${String(index + 1)}`,
      })),
    },
  };
}

/** The names of `apiKeysSet(count)`, from the `from`th. */
function apiKeyNames(count, from = 1) {
  return Array.from(
    { length: count - from + 1 },
    (_, index) => `key-${String(index + from)}`,
  );
}

const bound = workerRunnerCredentialsPerAgentMax;

/**
 * Catches a poll naming a credential no job would run on now, one its policy
 * does not allow, a name out of its set's order, or names for an agent past
 * the bound the plane reads, which would have the plane read none at all.
 */
test("a poll names each agent's credentials its policy allows that are not benched, in its set's order, and none of an agent past the bound", () => {
  for (const [why, documents, benched, named] of [
    [
      "one credential",
      { claudeCredential: { kind: "Subscription", tokenFile: "/c/token" } },
      [],
      { Claude: ["claude"] },
    ],
    [
      "several, of each agent",
      { claudeCredential: claudeSet("PreferOAuth"), codexCredential: codexSet },
      [],
      {
        Claude: ["max-1", "max-2", "key-1", "key-2"],
        Codex: ["chatgpt-1", "chatgpt-2", "openai-1"],
      },
    ],
    [
      "only what the policy allows",
      { claudeCredential: claudeSet("ApiKeyOnly") },
      [],
      { Claude: ["key-1", "key-2"] },
    ],
    [
      "one benched",
      { claudeCredential: claudeSet("OAuthOnly") },
      ["max-1"],
      { Claude: ["max-2"] },
    ],
    [
      "every one benched",
      { claudeCredential: claudeSet("OAuthOnly") },
      ["max-1", "max-2"],
      {},
    ],
    [
      "at the bound",
      { claudeCredential: apiKeysSet(bound) },
      [],
      { Claude: apiKeyNames(bound) },
    ],
    ["past the bound", { claudeCredential: apiKeysSet(bound + 1) }, [], {}],
    [
      "past the bound with one benched",
      { claudeCredential: apiKeysSet(bound + 1) },
      ["key-1"],
      { Claude: apiKeyNames(bound + 1, 2) },
    ],
  ]) {
    const selector = agentCredentialSelector(agentCredentialSets(documents));
    for (const [index, name] of benched.entries()) {
      const assignment = `job-${String(index)}`;
      assert.equal(selector.chosen("Claude", assignment)?.name, name, why);
      selector.outcomesTaken([{ assignment, outcome: "CreditsExhausted" }]);
    }
    assert.deepEqual(selector.named(), named, why);
  }
});

/** Catches reading what a poll names taking a RoundRobin turn, or leaving out a credential that is paused but not benched. */
test("what a poll names takes no turn, and names a paused credential", () => {
  const { selector, clock } = benchedSelector(
    claudeSet("OAuthOnly", "RoundRobin"),
  );
  for (let index = 0; index < 3; index += 1) selector.named();
  assert.equal(chosenAs(selector, "job-1"), "max-1");
  selector.named();
  assert.equal(chosenAs(selector, "job-2"), "max-2");
  selector.pausesTaken([paused("max-1", clock.nowMs + 60_000)]);
  assert.deepEqual(selector.named(), { Claude: ["max-1", "max-2"] });
});

/** Catches the record of what each assignment ran on growing past its bound, or forgetting the newest first. */
test("a selector remembers the credential of its latest assignments, up to its bound", () => {
  const { selector } = benchedSelector(claudeSet("OAuthOnly"));
  for (let index = 0; index <= agentCredentialAssignmentsMax; index += 1)
    chosenAs(selector, `job-${String(index)}`);
  selector.outcomesTaken([
    { assignment: "job-0", outcome: "CreditsExhausted" },
  ]);
  assert.deepEqual(selector.benchOf("max-1"), { state: "Available" });
  selector.outcomesTaken([
    {
      assignment: `job-${String(agentCredentialAssignmentsMax)}`,
      outcome: "CreditsExhausted",
    },
  ]);
  assert.deepEqual(selector.benchOf("max-1"), {
    state: "BenchedUntilRestart",
  });
});

/** Catches `doctor` told anything but where each credential's bench stands now. */
test("each credential is described with its bench: available, benched until a time, or until restart", () => {
  const { selector, clock } = benchedSelector(claudeSet("PreferOAuth"));
  const resetMs = clock.nowMs + 60_000;
  chosenAs(selector, "job-1");
  selector.outcomesTaken([usageLimited("job-1", resetMs)]);
  chosenAs(selector, "job-2");
  selector.outcomesTaken([
    { assignment: "job-2", outcome: "CreditsExhausted" },
  ]);
  const benches = () =>
    selector.described().map(({ name, bench }) => [name, bench]);
  assert.deepEqual(benches(), [
    ["max-1", { state: "Benched", until: resetMs }],
    ["max-2", { state: "BenchedUntilRestart" }],
    ["key-1", { state: "Available" }],
    ["key-2", { state: "Available" }],
  ]);
  clock.nowMs = resetMs;
  assert.deepEqual(benches()[0], ["max-1", { state: "Available" }]);
});

/** Catches one agent's or one type's turn moving another's, and a choice that reads anything but the state it is given. */
test("a turn is each agent's and each type's own, and a choice is the state's alone", () => {
  const sets = agentCredentialSets({
    claudeCredential: claudeSet("PreferOAuth", "RoundRobin"),
    codexCredential: codexSet,
  });
  const selector = agentCredentialSelector(sets);
  assert.deepEqual(chosenNames(selector, "Claude", 1), ["max-1"]);
  assert.deepEqual(chosenNames(selector, "Codex", 3), [
    "chatgpt-1",
    "chatgpt-2",
    "chatgpt-1",
  ]);
  assert.deepEqual(chosenNames(selector, "Claude", 1), ["max-2"]);
  assert.equal(selector.chosen("Gemini"), undefined);
  assert.deepEqual(selector.agents, ["Claude", "Codex"]);

  const state = { Claude: { OAuth: "max-1", ApiKey: "key-1" } };
  const first = agentCredentialChosen(sets, state, "Claude");
  assert.deepEqual(agentCredentialChosen(sets, state, "Claude"), first);
  assert.equal(first.credential?.name, "max-2");
  assert.deepEqual(first.state, {
    Claude: { OAuth: "max-2", ApiKey: "key-1" },
  });
  assert.deepEqual(state, { Claude: { OAuth: "max-1", ApiKey: "key-1" } });
  assert.deepEqual(agentCredentialChosen({}, state, "Claude"), {
    credential: undefined,
    state,
  });
});

/** Catches what `doctor` prints, or a workload is told, carrying more of a credential than its name, agent, type and file. */
test("a credential is described and carried by its name, agent, type and file, and nothing else", () => {
  const sets = agentCredentialSets({
    claudeCredential: { kind: "Vertex", ...claudeSingles[4] },
    codexCredential: codexSet,
  });
  const available = { state: "Available" };
  assert.deepEqual(agentCredentialsDescribed(sets), [
    {
      name: "claude",
      agent: "Claude",
      type: "Vertex",
      file: "/c/gcp.json",
      bench: available,
    },
    {
      name: "chatgpt-1",
      agent: "Codex",
      type: "OAuth",
      file: "/x/auth-1.json",
      bench: available,
    },
    {
      name: "chatgpt-2",
      agent: "Codex",
      type: "OAuth",
      file: "/x/auth-2.json",
      bench: available,
    },
    {
      name: "openai-1",
      agent: "Codex",
      type: "ApiKey",
      file: "/x/openai-1",
      bench: available,
    },
  ]);
  const key = agentCredentialSelector(
    agentCredentialSets({ claudeCredential: claudeSet("ApiKeyOnly") }),
  ).chosen("Claude");
  assert.deepEqual(agentCredentialCarried(/** @type {any} */ (key)), {
    [claudeCredentialVariable]: JSON.stringify({ kind: "ApiKey" }),
    CHUG_WORKER_CREDENTIAL_NAME: "key-1",
  });
  const codexKey = agentCredentialSelector(
    agentCredentialSets({
      codexCredential: { ...codexSet, prefer: "ApiKeyOnly" },
    }),
  ).chosen("Codex");
  const carried = agentCredentialCarried(/** @type {any} */ (codexKey));
  assert.deepEqual(carried, {
    CHUG_WORKER_CODEX_CREDENTIAL: JSON.stringify({ kind: "ApiKey" }),
    CHUG_WORKER_CREDENTIAL_NAME: "openai-1",
  });
  const scrubbed = agentCredentialsScrubbedCarried(sets);
  assert.deepEqual(
    agentCredentialsScrubbedNamed(scrubbed),
    agentCredentialsDescribed(sets).map(({ agent, type, file }) => ({
      agent,
      type,
      file,
    })),
  );
});

/** Catches a run reporting its credential under another type than the one it ran on, or a name no runner gave. */
test("a run reports its credential's agent, type and name as its workload was told them", () => {
  assert.deepEqual(
    agentCredentialReported(
      {
        [claudeCredentialVariable]: JSON.stringify({ kind: "ApiKey" }),
        CHUG_WORKER_CREDENTIAL_NAME: "key-1",
      },
      "Claude",
    ),
    { agent: "Claude", type: "ApiKey", name: "key-1" },
  );
  assert.deepEqual(
    agentCredentialReported({ CHUG_WORKER_CREDENTIAL_NAME: "max-1" }, "Claude"),
    { agent: "Claude", type: "OAuth", name: "max-1" },
  );
  assert.deepEqual(
    agentCredentialReported(
      {
        CHUG_WORKER_CODEX_CREDENTIAL: JSON.stringify({ kind: "ApiKey" }),
        CHUG_WORKER_CREDENTIAL_NAME: "openai-1",
      },
      "Codex",
    ),
    { agent: "Codex", type: "ApiKey", name: "openai-1" },
  );
  assert.equal(agentCredentialReported({}, "Claude"), undefined);
  assert.throws(
    () =>
      agentCredentialReported(
        { CHUG_WORKER_CREDENTIAL_NAME: "sk-ant secret" },
        "Claude",
      ),
    /names no credential this core can report/u,
  );
  assert.throws(
    () =>
      agentCredentialReported(
        {
          CHUG_WORKER_CODEX_CREDENTIAL: '{"kind":"Bedrock"}',
          CHUG_WORKER_CREDENTIAL_NAME: "x",
        },
        "Codex",
      ),
    /names a Codex credential this core cannot read/u,
  );
});
