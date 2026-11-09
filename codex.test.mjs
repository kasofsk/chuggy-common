import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";

import {
  workerChangeBaseVariable,
  workerImageVariable,
  workerShellEnvironment,
} from "./checks.mjs";
import {
  codexAgent,
  codexConfiguration,
  codexInvocation,
  codexResult,
  codexShellArguments,
  prepareCodexCredential,
  prepareCodexEnvironment,
  prepareCodexShell,
} from "./codex.mjs";
import { coreRuntime } from "./coreRuntime.mjs";

const task = {
  worker: {
    mode: {
      type: "SingleAgent",
      agent: "Codex",
      model: "gpt-5.3-codex",
      arguments: [],
    },
  },
  briefing: { text: "briefing" },
};

/** What a run's argv is composed with beside the task, its shell prepared with nothing. */
const run = { resultSchema: "/tmp/result.json", shellArguments: [] };

/**
 * Catches a run that leaves no rollout to read its limit from, and one that
 * lets a layer of Codex's configuration other than the user's turn Daybreak on.
 */
test("a Codex invocation is persisted, keeps Daybreak off and is constrained to the result schema", () => {
  assert.deepEqual(
    codexInvocation(task, { ...run, shellArguments: ["--config", "shell"] }),
    [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--model",
      "gpt-5.3-codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "--config",
      "daybreak=false",
      "--output-schema",
      "/tmp/result.json",
      "--config",
      "shell",
      "--",
      "briefing",
    ],
  );
});

/**
 * Catches the briefing taken as a value of the option before it, which an
 * option a worker configures, such as `--image`, takes every word after it
 * for, and which leaves a run with no prompt.
 */
test("a Codex briefing is the prompt whatever options precede it", () => {
  for (const configured of [[], ["--image", "screen.png"]]) {
    const argv = codexInvocation(
      {
        ...task,
        worker: { mode: { ...task.worker.mode, arguments: configured } },
      },
      run,
    );

    assert.deepEqual(argv.slice(-2), ["--", "briefing"]);
    assert.equal(argv.indexOf("--"), argv.length - 2);
  }
});

/** Catches a worker's `--` making the run's own `--` and briefing two prompts. */
test("ticket configuration cannot end a Codex run's options itself", () => {
  assert.throws(
    () =>
      codexInvocation(
        {
          ...task,
          worker: { mode: { ...task.worker.mode, arguments: ["--"] } },
        },
        run,
      ),
    /reserves Codex argument --$/u,
  );
});

test("Codex configuration records the runtime version and pinned model", async () => {
  const executed = [];
  assert.deepEqual(
    await codexConfiguration(task, { CODEX_HOME: "/tmp/codex" }, (...args) => {
      executed.push(args);
      return Promise.resolve({ stdout: "codex-cli 0.151.0\n" });
    }),
    {
      agent: "Codex",
      codexVersion: "codex-cli 0.151.0",
      model: "gpt-5.3-codex",
      userConfig: "Ignored",
      projectRules: "Ignored",
    },
  );
  assert.deepEqual(executed, [
    [
      coreRuntime.codex,
      ["--version"],
      { env: { CODEX_HOME: "/tmp/codex" }, maxBuffer: 4096 },
    ],
  ]);
});

test("attached values cannot evade reserved Codex short options", () => {
  for (const argument of [
    "-mother-model",
    '-cmodel="other"',
    "-pother-profile",
    "-sread-only",
    "-C/other/workspace",
  ])
    assert.throws(
      () =>
        codexInvocation(
          {
            ...task,
            worker: {
              mode: { ...task.worker.mode, arguments: [argument] },
            },
          },
          run,
        ),
      /reserves Codex argument/u,
    );
});

test("the final Codex agent message supplies the structured result", () => {
  const output = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ verdict: "Pass", summary: "done" }),
    },
  };
  assert.deepEqual(codexResult([output]), {
    output,
    result: { verdict: "Pass", summary: "done" },
  });
});

test("Codex must return a structured verdict", () => {
  assert.throws(
    () =>
      codexResult([
        {
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        },
      ]),
    /Codex returned no structured verdict/u,
  );
});

test("a summary the schema admits is taken though its code units exceed the bound", () => {
  const summary = "\u{1F600}".repeat(resultReportCharsMax);
  const output = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ verdict: "Pass", summary }),
    },
  };
  assert.equal(codexResult([output]).result.summary, summary);
});

test("ticket configuration cannot replace worker-owned Codex arguments", () => {
  assert.throws(
    () =>
      codexInvocation(
        {
          ...task,
          worker: {
            mode: {
              type: "SingleAgent",
              agent: "Codex",
              model: "gpt-5.3-codex",
              arguments: ["--output-schema=mine.json"],
            },
          },
        },
        run,
      ),
    /reserves Codex argument --output-schema=/u,
  );
});

/** Catches a configuration that puts back the flag that leaves no rollout to read a limit from. */
test("ticket configuration cannot make a Codex run ephemeral", () => {
  for (const argument of ["--ephemeral", "--ephemeral=true"])
    assert.throws(
      () =>
        codexInvocation(
          {
            ...task,
            worker: { mode: { ...task.worker.mode, arguments: [argument] } },
          },
          run,
        ),
      /reserves Codex argument --ephemeral/u,
    );
});

/**
 * Catches a thread lost, so the rollout cannot be found, and Codex's message
 * dropped from the text a person reads, which is the only place it says when
 * the limit resets.
 */
test("a Codex stream says its thread and the message its failed turn ended with", () => {
  const sentence =
    "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 1:26 AM.";
  const folded = [
    {
      type: "thread.started",
      thread_id: "019a4f4e-1c2b-7d3e-8f40-a1b2c3d4e5f6",
    },
    { type: "turn.started" },
    { type: "error", message: sentence },
    { type: "turn.failed", error: { message: sentence } },
  ].reduce(codexAgent.frame, undefined);

  assert.deepEqual(folded, {
    thread: "019a4f4e-1c2b-7d3e-8f40-a1b2c3d4e5f6",
    sentence,
  });
  assert.deepEqual(codexAgent.ended(undefined, folded), {
    sentence,
    session: undefined,
  });
  assert.deepEqual(codexAgent.ended(undefined, undefined), {
    sentence: undefined,
    session: undefined,
  });
});

test("ticket configuration cannot override the pinned Codex model through config", () => {
  assert.throws(
    () =>
      codexInvocation(
        {
          ...task,
          worker: {
            mode: {
              ...task.worker.mode,
              arguments: ['--config=model="other"'],
            },
          },
        },
        run,
      ),
    /reserves Codex argument --config=/u,
  );
});

test("Codex usage is translated into the run evidence vocabulary", () => {
  assert.deepEqual(
    codexAgent.observed({
      type: "turn.completed",
      usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1 },
    }),
    {
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        cache_read_input_tokens: 2,
      },
      num_turns: 1,
    },
  );
});

test("a mounted Codex OAuth document becomes a private writable CODEX_HOME", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "chuggy-codex-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, "home");
  const auth = JSON.stringify({
    tokens: {
      access_token: "access-token-long-enough",
      refresh_token: "refresh-token-long-enough",
    },
  });
  const prepared = await prepareCodexCredential(auth, {}, home);
  assert.deepEqual(prepared.environment, { CODEX_HOME: home });
  assert.deepEqual(prepared.secrets, [
    auth,
    "access-token-long-enough",
    "refresh-token-long-enough",
  ]);
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), `${auth}\n`);
});

/** Catches an API key's auth.json whose key alone a job could print unscrubbed. */
test("a Codex API key's auth.json scrubs the key itself", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "chuggy-codex-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const auth = JSON.stringify({
    OPENAI_API_KEY: "sk-api-key-long-enough",
    tokens: null,
  });

  const prepared = await prepareCodexCredential(auth, {}, join(parent, "home"));

  assert.deepEqual(prepared.secrets, [auth, "sk-api-key-long-enough"]);
});

/** Codex's environment as a run composes it: the inherited less what is withheld, then the credential's. */
function codexComposed(inherited, prepared) {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([name]) => !prepared.withheld.includes(name),
      ),
    ),
    ...prepared.environment,
  };
}

/** What a runner's environment may leave that Codex 0.165.0 reads a credential from ahead of `auth.json`. */
const codexStray = {
  OPENAI_API_KEY: "sk-stray-openai-api-key",
  CODEX_API_KEY: "sk-stray-codex-api-key",
  CODEX_ACCESS_TOKEN: "stray-codex-access-token",
};

/**
 * Catches a Codex API-key run handed its key anywhere but where `codex exec`
 * reads one, an `auth.json` written beside it, or a key the runner's
 * environment left outranking it.
 */
test("a Codex API-key run is handed its key in CODEX_API_KEY alone, with no auth.json", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "chuggy-codex-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, "home");
  const key = "sk-proj-the-runner-s-own-key-0123";
  const inherited = {
    ...codexStray,
    PATH: "/usr/bin",
    CHUG_WORKER_CODEX_CREDENTIAL: JSON.stringify({ kind: "ApiKey" }),
  };

  const prepared = await prepareCodexCredential(
    key,
    { environment: inherited },
    home,
  );
  const ran = codexComposed(inherited, prepared);

  assert.deepEqual(ran, {
    PATH: "/usr/bin",
    CODEX_HOME: home,
    CODEX_API_KEY: key,
  });
  assert.deepEqual(prepared.secrets, [key]);
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(
    prepareCodexCredential(
      `${key}\nsecond`,
      { environment: inherited },
      join(parent, "other"),
    ),
    /does not hold one key alone/u,
  );
});

/** Catches a key the runner's environment left outranking the ChatGPT login a Codex run was handed. */
test("a Codex OAuth run reads its auth.json alone whatever key it inherits", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "chuggy-codex-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const auth = JSON.stringify({
    tokens: { access_token: "access-0123456789" },
  });
  for (const [index, named] of [
    {},
    { CHUG_WORKER_CODEX_CREDENTIAL: JSON.stringify({ kind: "OAuth" }) },
  ].entries()) {
    const home = join(parent, String(index));
    const inherited = { ...codexStray, ...named };
    const prepared = await prepareCodexCredential(
      auth,
      { environment: inherited },
      home,
    );

    assert.deepEqual(codexComposed(inherited, prepared), { CODEX_HOME: home });
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), `${auth}\n`);
  }
  await assert.rejects(
    prepareCodexCredential(
      auth,
      { environment: { CHUG_WORKER_CODEX_CREDENTIAL: '{"kind":"Vertex"}' } },
      join(parent, "refused"),
    ),
    /names a Codex credential this core cannot read/u,
  );
});

/** Catches a Codex home outside HOME, the directory a job's check found writable. */
test("a Codex credential's home is under HOME where none is named", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chuggy-codex-default-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  const prepared = await prepareCodexCredential(JSON.stringify({ tokens: {} }));

  assert.equal(dirname(prepared.environment.CODEX_HOME), home);
  await readFile(join(prepared.environment.CODEX_HOME, "auth.json"), "utf8");
});

/**
 * What a Codex run's shell is handed for a pod whose image set three of the
 * variables `check.sh` moves aside, one plain, one empty, and one to every
 * character a TOML basic string must escape and some it need not, and that
 * hands git an entry of its own; and whose attempt knows the commit its change
 * started from and adds an entry to git's configuration.
 */
const handed = workerShellEnvironment(
  {
    PATH: "/usr/bin",
    [workerImageVariable("NODE_OPTIONS")]: "--max-old-space-size=4096",
    [workerImageVariable("NODE_PATH")]: "",
    [workerImageVariable("LD_LIBRARY_PATH")]:
      '/image/it\'s "lib"\\\n\t\u0001\u007f\u009f\u{1F600}end',
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "cat",
  },
  {
    changeBase: "a".repeat(40),
    git: [["credential.https://github.com.helper", "cache --socket '/m'"]],
  },
);

/**
 * The table a `shell_environment_policy.set` override sets, read back. Each
 * value is a TOML basic string holding only the escapes a JSON string means
 * the same by, so JSON reads it as TOML does; and what is read must be the
 * whole table, so nothing in it goes unread.
 */
function codexSetTable(argument) {
  const prefix = "shell_environment_policy.set={";
  assert.ok(argument.startsWith(prefix) && argument.endsWith("}"), argument);
  const body = argument.slice(prefix.length, -1);
  const entries = [
    ...body.matchAll(/([A-Z0-9_]+) = ("(?:[^"\\]|\\.)*")(?:, |$)/gu),
  ];
  assert.equal(entries.map(([entry]) => entry).join(""), body);
  return Object.fromEntries(
    entries.map(([, name, value]) => [name, JSON.parse(value)]),
  );
}

/**
 * Catches Codex's shell set a value other than the one a check stage's shells
 * are handed, or set it in a string TOML refuses for a raw control character;
 * and git's entries, whose keys Codex drops from what its shell inherits, set
 * short of the whole count.
 */
test("a Codex run's shell is set exactly what it is handed", () => {
  const [flag, argument, ...rest] = codexShellArguments(handed);

  assert.equal(flag, "--config");
  assert.deepEqual(rest, []);
  assert.doesNotMatch(argument, /\p{Cc}/u);
  assert.deepEqual(codexSetTable(argument), handed);
  assert.deepEqual(Object.keys(codexSetTable(argument)).sort(), [
    "CARGO_NET_GIT_FETCH_WITH_CLI",
    workerChangeBaseVariable,
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_VALUE_1",
    "LD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]);
});

/** Catches a Codex shell set a variable it was not handed. */
test("a Codex shell handed nothing is set nothing", () => {
  assert.deepEqual(codexShellArguments({}), [
    "--config",
    "shell_environment_policy.set={}",
  ]);
});

/** Catches a Codex run whose shell is prepared otherwise than by its arguments. */
test("a Codex run's shell is prepared by arguments alone", async () => {
  assert.deepEqual(await prepareCodexShell(handed), {
    environment: {},
    arguments: codexShellArguments(handed),
  });
  assert.equal(codexAgent.prepareShell, prepareCodexShell);
});

/** A CA bundle written under a directory of its own, removed when `t` ends. */
async function shippedBundle(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-codex-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, "ca-certificates.crt");
  await writeFile(bundle, "-----BEGIN CERTIFICATE-----\n");
  return bundle;
}

/** Catches Codex left without the runtime's bundle in an image that names none. */
test("a Codex run is given the bundle its runtime ships where its environment names none", async (t) => {
  const bundle = await shippedBundle(t);

  assert.deepEqual(
    await prepareCodexEnvironment({ PATH: "/usr/bin", HOME: "/home" }, bundle),
    { CODEX_CA_CERTIFICATE: bundle },
  );
});

/** Catches a bundle an image names for its own CA replaced by the runtime's. */
test("a Codex run keeps the bundle its environment names", async (t) => {
  const bundle = await shippedBundle(t);

  for (const name of ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "SSL_CERT_DIR"])
    assert.deepEqual(
      await prepareCodexEnvironment({ [name]: "/image/ca.pem" }, bundle),
      {},
      name,
    );
});

/** Catches Codex pointed at a bundle that is not there, which it refuses to start a client on. */
test("a Codex run is given no bundle where its runtime ships none", async (t) => {
  const bundle = await shippedBundle(t);

  assert.deepEqual(
    await prepareCodexEnvironment({}, join(dirname(bundle), "absent.crt")),
    {},
  );
});

/**
 * Catches a Codex run given a bundle other than the one in the tree its core
 * sits in: the module and the derivation it imports, copied into a tree as a
 * runtime holds them, beside that tree's bundle. The result reader it also
 * imports is stood in for, since it reaches packages the tree does not hold.
 */
test("a Codex run is given the bundle in its own core's tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-codex-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "lib", "chuggy");
  await mkdir(core, { recursive: true });
  await mkdir(join(root, "share"));
  for (const name of ["codex.mjs", "codexRollout.mjs", "coreRuntime.mjs"])
    await copyFile(
      fileURLToPath(new URL(name, import.meta.url)),
      join(core, name),
    );
  await writeFile(
    join(core, "result.mjs"),
    "export const agentResult = () => undefined;\n",
  );
  const bundle = join(root, "share", "ca-certificates.crt");
  await writeFile(bundle, "-----BEGIN CERTIFICATE-----\n");
  const copied = await import(pathToFileURL(join(core, "codex.mjs")).href);

  assert.deepEqual(await copied.codexAgent.prepareEnvironment({}), {
    CODEX_CA_CERTIFICATE: bundle,
  });
  assert.equal(codexAgent.prepareEnvironment, prepareCodexEnvironment);
});
