import assert from "node:assert/strict";
import test from "node:test";

import {
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

/**
 * Catches a policy that prefers OAuth taking an API key while an OAuth
 * credential is available, or none once none is, and an order that takes one
 * that is not available; "available" is the hook a runner fills.
 */
test("a policy preferring OAuth takes an API key only while no OAuth credential is available, and each order skips what is not", () => {
  const sets = agentCredentialSets({
    claudeCredential: claudeSet("PreferOAuth", "RoundRobin"),
  });
  const away = new Set(["max-1"]);
  const selector = agentCredentialSelector(
    sets,
    (credential) => !away.has(credential.name),
  );
  assert.deepEqual(chosenNames(selector, "Claude", 2), ["max-2", "max-2"]);
  away.add("max-2");
  assert.deepEqual(chosenNames(selector, "Claude", 3), [
    "key-1",
    "key-2",
    "key-1",
  ]);
  away.delete("max-1");
  assert.deepEqual(chosenNames(selector, "Claude", 1), ["max-1"]);
  away.add("max-1").add("key-1").add("key-2");
  assert.equal(selector.chosen("Claude"), undefined);

  const onlyOAuth = agentCredentialSelector(
    agentCredentialSets({ claudeCredential: claudeSet("OAuthOnly") }),
    (credential) => credential.type !== "OAuth",
  );
  assert.equal(onlyOAuth.chosen("Claude"), undefined);
  const inOrder = agentCredentialSelector(
    agentCredentialSets({ claudeCredential: claudeSet("ApiKeyOnly") }),
    (credential) => credential.name !== "key-1",
  );
  assert.deepEqual(chosenNames(inOrder, "Claude", 2), ["key-2", "key-2"]);
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
  assert.deepEqual(agentCredentialsDescribed(sets), [
    { name: "claude", agent: "Claude", type: "Vertex", file: "/c/gcp.json" },
    {
      name: "chatgpt-1",
      agent: "Codex",
      type: "OAuth",
      file: "/x/auth-1.json",
    },
    {
      name: "chatgpt-2",
      agent: "Codex",
      type: "OAuth",
      file: "/x/auth-2.json",
    },
    { name: "openai-1", agent: "Codex", type: "ApiKey", file: "/x/openai-1" },
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
