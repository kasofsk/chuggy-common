/**
 * The credentials a runner holds for each agent, and which one a workload
 * runs on: a set per agent, its OAuth credentials and its API keys each in an
 * order, and a policy choosing between the two.
 *
 * A RUNNER'S FILE NAMES A SET, OR ONE CREDENTIAL AS IT ALWAYS DID. A
 * `claudeCredential` of any kind and a `codexCredential` naming `authFile` are
 * each a set of one, named for their agent. Bedrock, Vertex and Foundry are no
 * type a policy chooses between: each stays a set of that one credential.
 *
 * A NAME IS NEVER A SECRET. It is what a run reports it ran on and what
 * `doctor` prints, so it is unique across the runner's agents and is letters,
 * digits, `-` and `_`.
 *
 * THE SELECTOR IS PURE OVER ITS STATE. `agentCredentialChosen` answers the
 * credential and the state after it from the state before; the runner holds
 * that state for the life of its process in `agentCredentialSelector`. Whether
 * a credential is available is a hook, always true where none is given.
 *
 * A WORKLOAD IS TOLD THE CREDENTIAL'S TYPE AND NAME, never its value: Claude's
 * kind in `claudeCredentialVariable`, Codex's type in
 * `codexCredentialVariable`, and the name in `agentCredentialNameVariable`.
 * A job on its runner's host could read every file of the set, so it is also
 * told where each is, in `agentCredentialsScrubbedVariable`, and scrubs what
 * they hold.
 */

import { z } from "zod";

import {
  claudeCredentialCarried,
  claudeCredentialFile,
  claudeCredentialNamed,
  claudeCredentialSchema,
  claudeCredentialSetting,
} from "./claudeCredential.mjs";
import { codexCredentialNamed, codexCredentialVariable } from "./codex.mjs";

/** The agents a runner holds credential sets for, by the name an `Agent:` capability gives each. */
export const agentCredentialAgents = /** @type {const} */ (["Claude", "Codex"]);

/** The types a policy chooses between. */
export const agentCredentialTypes = /** @type {const} */ (["OAuth", "ApiKey"]);

/** The types each policy takes, in the order it prefers them. */
export const agentCredentialPreferred = {
  PreferOAuth: ["OAuth", "ApiKey"],
  OAuthOnly: ["OAuth"],
  ApiKeyOnly: ["ApiKey"],
};

/** The most credentials of one type a set holds. */
export const agentCredentialsMax = 32;

/** What names the credential a workload runs on. */
export const agentCredentialNameVariable = "CHUG_WORKER_CREDENTIAL_NAME";

/** What names every file of the set a job on its runner's host could read, and its type. */
export const agentCredentialsScrubbedVariable =
  "CHUG_WORKER_CREDENTIALS_SCRUBBED";

/** The variables naming a workload's credential beside Claude's kind, which no agent inherits. */
export const agentCredentialVariables = [
  codexCredentialVariable,
  agentCredentialNameVariable,
  agentCredentialsScrubbedVariable,
];

/** The name a set of one a file names the old way is given, by its agent. */
const agentCredentialSingleNames = { Claude: "claude", Codex: "codex" };

const agentCredentialNamePattern = /^[A-Za-z0-9_-]{1,64}$/u;

const agentCredentialNameSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? "is required: the credential's name"
        : "is not a credential's name",
  })
  .regex(
    agentCredentialNamePattern,
    "is not a credential's name: at most 64 letters, digits, '-' and '_'",
  );

const agentCredentialPathSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined ? "is required: a file" : "is not a path",
  })
  .min(1, "is not a path");

/** One type's credentials, each naming its file under `fileKey`. */
function agentCredentialPoolSchema(fileKey) {
  return z.strictObject({
    order: z.enum(["InOrder", "RoundRobin"]),
    credentials: z
      .array(
        z.strictObject({
          name: agentCredentialNameSchema,
          [fileKey]: agentCredentialPathSchema,
        }),
      )
      .min(1, "names no credential")
      .max(agentCredentialsMax),
  });
}

/** A policy and the credentials of each type it names, refused where it allows none it names. */
function agentCredentialPolicySchema(oauthFileKey) {
  return z
    .strictObject({
      prefer: z.enum(Object.keys(agentCredentialPreferred)),
      oauth: agentCredentialPoolSchema(oauthFileKey).optional(),
      apiKey: agentCredentialPoolSchema("apiKeyFile").optional(),
    })
    .superRefine((policy, context) => {
      const allowed = agentCredentialPreferred[policy.prefer].filter(
        (type) => policy[agentCredentialPoolKeys[type]] !== undefined,
      );
      if (allowed.length === 0)
        context.addIssue({
          code: "custom",
          path: ["prefer"],
          message: `is ${policy.prefer}, and the set names no credential it allows`,
        });
    });
}

/** The key of a policy's credentials of each type. */
const agentCredentialPoolKeys = { OAuth: "oauth", ApiKey: "apiKey" };

/** The file key of each agent's OAuth credential. */
const agentCredentialOAuthFileKeys = { Claude: "tokenFile", Codex: "authFile" };

/** Claude's set: a policy over subscription tokens and API keys, or one credential of any kind. */
export const claudeCredentialSetSchema = z.union([
  claudeCredentialSchema,
  agentCredentialPolicySchema(agentCredentialOAuthFileKeys.Claude),
]);

/** Codex's set: a policy over `auth.json` files and API keys, or one `auth.json`. */
export const codexCredentialSetSchema = z.union([
  z.strictObject({ authFile: agentCredentialPathSchema }),
  agentCredentialPolicySchema(agentCredentialOAuthFileKeys.Codex),
]);

/** The key a runner's file names each agent's set under. */
export const agentCredentialSetKeys = {
  Claude: "claudeCredential",
  Codex: "codexCredential",
};

/**
 * @typedef {typeof agentCredentialAgents[number]} AgentCredentialAgent
 * @typedef {"OAuth" | "ApiKey" | "Bedrock" | "Vertex" | "Foundry"} AgentCredentialType
 * @typedef {z.infer<typeof claudeCredentialSetSchema>} ClaudeCredentialSetDocument
 * @typedef {z.infer<typeof codexCredentialSetSchema>} CodexCredentialSetDocument
 *
 * @typedef {object} AgentCredential one credential of a set
 * @property {AgentCredentialAgent} agent
 * @property {string} name
 * @property {AgentCredentialType} type
 * @property {string} file where its secret is
 * @property {import("./claudeCredential.mjs").ClaudeCredentialSetting} [setting] Claude's, which its workload is told
 *
 * @typedef {{order: "InOrder" | "RoundRobin", credentials: AgentCredential[]}} AgentCredentialPool
 * @typedef {{agent: AgentCredentialAgent, prefer: keyof typeof agentCredentialPreferred, pools: Partial<Record<"OAuth" | "ApiKey", AgentCredentialPool>>}} AgentCredentialPolicySet
 * @typedef {{agent: AgentCredentialAgent, fixed: AgentCredential}} AgentCredentialFixedSet
 * @typedef {AgentCredentialPolicySet | AgentCredentialFixedSet} AgentCredentialSet
 * @typedef {Partial<Record<AgentCredentialAgent, AgentCredentialSet>>} AgentCredentialSets
 * @typedef {Partial<Record<AgentCredentialAgent, Partial<Record<"OAuth" | "ApiKey", string>>>>} AgentCredentialState the name each type of each agent last chose
 */

/** A Claude credential of one kind as the credential of a set of one. */
function agentCredentialClaudeSingle(document) {
  const setting = claudeCredentialSetting(document);
  return {
    agent: "Claude",
    name: agentCredentialSingleNames.Claude,
    type:
      setting.kind === "Subscription"
        ? "OAuth"
        : /** @type {AgentCredentialType} */ (setting.kind),
    file: claudeCredentialFile(document),
    setting,
  };
}

/** A credential of a policy's pool, as its agent and type make it. */
function agentCredentialPooled(agent, type, entry) {
  const file =
    type === "OAuth"
      ? entry[agentCredentialOAuthFileKeys[agent]]
      : entry.apiKeyFile;
  return {
    agent,
    name: entry.name,
    type,
    file,
    ...(agent === "Claude"
      ? { setting: { kind: type === "OAuth" ? "Subscription" : "ApiKey" } }
      : {}),
  };
}

/**
 * One agent's set as its file names it, which its schema has read.
 *
 * @param {AgentCredentialAgent} agent
 * @param {ClaudeCredentialSetDocument | CodexCredentialSetDocument} document
 * @returns {AgentCredentialSet}
 */
export function agentCredentialSet(agent, document) {
  if (!("prefer" in document)) {
    if (agent === "Codex")
      return {
        agent,
        prefer: "OAuthOnly",
        pools: {
          OAuth: {
            order: "InOrder",
            credentials: [
              agentCredentialPooled(agent, "OAuth", {
                name: agentCredentialSingleNames.Codex,
                authFile: /** @type {{authFile: string}} */ (document).authFile,
              }),
            ],
          },
        },
      };
    const single = agentCredentialClaudeSingle(document);
    if (single.type !== "OAuth" && single.type !== "ApiKey")
      return { agent, fixed: single };
    return {
      agent,
      prefer: single.type === "OAuth" ? "OAuthOnly" : "ApiKeyOnly",
      pools: { [single.type]: { order: "InOrder", credentials: [single] } },
    };
  }
  /** @type {AgentCredentialPolicySet["pools"]} */
  const pools = {};
  for (const type of agentCredentialTypes) {
    const pool = document[agentCredentialPoolKeys[type]];
    if (pool !== undefined)
      pools[type] = {
        order: pool.order,
        credentials: pool.credentials.map((entry) =>
          agentCredentialPooled(agent, type, entry),
        ),
      };
  }
  return { agent, prefer: document.prefer, pools };
}

/**
 * Every credential of a set, OAuth first.
 *
 * @param {AgentCredentialSet} set
 * @returns {AgentCredential[]}
 */
export function agentCredentialSetCredentials(set) {
  if ("fixed" in set) return [set.fixed];
  return agentCredentialTypes.flatMap(
    (type) => set.pools[type]?.credentials ?? [],
  );
}

/**
 * The sets a runner's file names, by agent, under `agentCredentialSetKeys`,
 * each read by its schema already.
 *
 * @param {{claudeCredential?: ClaudeCredentialSetDocument, codexCredential?: CodexCredentialSetDocument}} documents
 * @returns {AgentCredentialSets}
 */
export function agentCredentialSets(documents) {
  /** @type {AgentCredentialSets} */
  const sets = {};
  for (const agent of agentCredentialAgents) {
    const document = documents[agentCredentialSetKeys[agent]];
    if (document !== undefined)
      sets[agent] = agentCredentialSet(agent, document);
  }
  return sets;
}

/**
 * Holds a runner's file to naming each credential once across its agents, a
 * refinement its own schema is given beside the sets' schemas.
 *
 * @param {{claudeCredential?: unknown, codexCredential?: unknown}} documents
 * @param {z.core.$RefinementCtx} context
 */
export function agentCredentialNamesRefined(documents, context) {
  const seen = new Set();
  for (const agent of agentCredentialAgents) {
    const key = agentCredentialSetKeys[agent];
    const read = (
      agent === "Claude" ? claudeCredentialSetSchema : codexCredentialSetSchema
    ).safeParse(documents[key]);
    if (!read.success) continue;
    for (const credential of agentCredentialSetCredentials(
      agentCredentialSet(agent, read.data),
    )) {
      if (seen.has(credential.name))
        context.addIssue({
          code: "custom",
          path: [key],
          message: `names the credential ${credential.name}, and another credential of this runner's has that name; name each once`,
        });
      seen.add(credential.name);
    }
  }
}

/** Both agents' sets as a runner's file names them, each name once across them. */
export const agentCredentialSetsSchema = z
  .object({
    claudeCredential: claudeCredentialSetSchema.optional(),
    codexCredential: codexCredentialSetSchema.optional(),
  })
  .superRefine(agentCredentialNamesRefined);

/**
 * The next of `pool` its order takes that `available` allows: the first, or
 * the first after `last` where it rotates.
 *
 * @param {AgentCredentialPool} pool
 * @param {string | undefined} last
 * @param {(credential: AgentCredential) => boolean} available
 */
function agentCredentialPoolChosen(pool, last, available) {
  const count = pool.credentials.length;
  const lastIndex = pool.credentials.findIndex(
    (credential) => credential.name === last,
  );
  const start = pool.order === "RoundRobin" ? lastIndex + 1 : 0;
  for (let step = 0; step < count; step += 1) {
    const credential = pool.credentials[(start + step) % count];
    if (available(credential)) return credential;
  }
  return undefined;
}

/**
 * The credential `agent`'s next workload runs on, and the state after it: the
 * type its policy prefers while one of that type is available, else the next
 * it allows, and within the type the one its order takes. Nothing where the
 * runner holds no set for `agent` or none it allows is available.
 *
 * @param {AgentCredentialSets} sets
 * @param {AgentCredentialState} state
 * @param {string} agent
 * @param {(credential: AgentCredential) => boolean} [available]
 * @returns {{credential: AgentCredential | undefined, state: AgentCredentialState}}
 */
export function agentCredentialChosen(
  sets,
  state,
  agent,
  available = () => true,
) {
  const set = Object.hasOwn(sets, agent) ? sets[agent] : undefined;
  if (set === undefined) return { credential: undefined, state };
  if ("fixed" in set)
    return { credential: available(set.fixed) ? set.fixed : undefined, state };
  for (const type of agentCredentialPreferred[set.prefer]) {
    const pool = set.pools[type];
    if (pool === undefined) continue;
    const credential = agentCredentialPoolChosen(
      pool,
      state[set.agent]?.[type],
      available,
    );
    if (credential === undefined) continue;
    if (credential.agent !== set.agent || credential.type !== type)
      throw new Error(
        `${set.agent}'s ${type} credentials hold ${credential.name}, which is not one`,
      );
    return {
      credential,
      state: {
        ...state,
        [set.agent]: { ...state[set.agent], [type]: credential.name },
      },
    };
  }
  return { credential: undefined, state };
}

/**
 * @typedef {object} AgentCredentialSelector
 * @property {readonly AgentCredentialAgent[]} agents the agents it holds a set for
 * @property {AgentCredentialSets} sets
 * @property {(agent: string) => AgentCredential | undefined} chosen the credential `agent`'s next workload runs on, as `agentCredentialChosen` answers it
 */

/**
 * The selector a runner holds over its sets for the life of its process.
 *
 * @param {AgentCredentialSets} sets
 * @param {(credential: AgentCredential) => boolean} [available]
 * @returns {AgentCredentialSelector}
 */
export function agentCredentialSelector(sets, available = () => true) {
  /** @type {AgentCredentialState} */
  let state = {};
  return {
    agents: agentCredentialAgents.filter((agent) => sets[agent] !== undefined),
    sets,
    chosen(agent) {
      const next = agentCredentialChosen(sets, state, agent, available);
      state = next.state;
      return next.credential;
    },
  };
}

/**
 * Each credential of the sets as `doctor` prints it: its name, agent, type
 * and file, never what the file holds.
 *
 * @param {AgentCredentialSets} sets
 * @returns {{name: string, agent: AgentCredentialAgent, type: AgentCredentialType, file: string}[]}
 */
export function agentCredentialsDescribed(sets) {
  return agentCredentialAgents.flatMap((agent) =>
    sets[agent] === undefined
      ? []
      : agentCredentialSetCredentials(sets[agent]).map(
          ({ name, type, file }) => ({ name, agent, type, file }),
        ),
  );
}

/**
 * The variables a workload is told the credential it runs on in: its type,
 * as its agent reads it, and its name.
 *
 * @param {AgentCredential} credential
 * @returns {Record<string, string>}
 */
export function agentCredentialCarried(credential) {
  if (!agentCredentialNamePattern.test(credential.name))
    throw new RangeError(`${credential.name} is not a credential's name`);
  return {
    ...(credential.agent === "Claude"
      ? claudeCredentialCarried(credential.setting)
      : {
          [codexCredentialVariable]: JSON.stringify({ kind: credential.type }),
        }),
    [agentCredentialNameVariable]: credential.name,
  };
}

/**
 * What a job on its runner's host is told of every credential of `sets`: each
 * file and the agent and type it is of.
 *
 * @param {AgentCredentialSets} sets
 * @returns {Record<string, string>}
 */
export function agentCredentialsScrubbedCarried(sets) {
  return {
    [agentCredentialsScrubbedVariable]: JSON.stringify(
      agentCredentialsDescribed(sets).map(({ agent, type, file }) => ({
        agent,
        type,
        file,
      })),
    ),
  };
}

const agentCredentialScrubbedSchema = z
  .array(
    z.strictObject({
      agent: z.enum(agentCredentialAgents),
      type: z.enum(["OAuth", "ApiKey", "Bedrock", "Vertex", "Foundry"]),
      file: z.string().startsWith("/"),
    }),
  )
  .max(
    agentCredentialAgents.length *
      agentCredentialTypes.length *
      agentCredentialsMax,
  );

/**
 * The files a workload's environment names in `agentCredentialsScrubbedVariable`,
 * none where it names none; a list this core cannot read is refused.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {{agent: AgentCredentialAgent, type: AgentCredentialType, file: string}[]}
 */
export function agentCredentialsScrubbedNamed(environment) {
  const carried = environment[agentCredentialsScrubbedVariable];
  if (carried === undefined) return [];
  let document;
  try {
    document = JSON.parse(carried);
  } catch {
    document = undefined;
  }
  const read = agentCredentialScrubbedSchema.safeParse(document);
  if (!read.success)
    throw new Error(
      `${agentCredentialsScrubbedVariable} names credentials this core cannot read`,
    );
  return read.data;
}

/**
 * The credential a run reports it ran on, as its environment names it: its
 * agent, its type and its name, never its value. Nothing where the workload is
 * told no name, as one a runner without sets starts is not.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} agent the run's
 * @returns {{agent: string, type: string, name: string} | undefined}
 */
export function agentCredentialReported(environment, agent) {
  const name = environment[agentCredentialNameVariable];
  if (name === undefined) return undefined;
  if (!agentCredentialNamePattern.test(name))
    throw new Error(
      `${agentCredentialNameVariable} names no credential this core can report`,
    );
  if (agent === "Codex")
    return { agent, type: codexCredentialNamed(environment), name };
  const kind = claudeCredentialNamed(environment)?.kind ?? "Subscription";
  return { agent, type: kind === "Subscription" ? "OAuth" : kind, name };
}
