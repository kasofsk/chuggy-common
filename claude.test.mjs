import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { workerTaskVariable } from "@chuggy/worker-contract/workerEnvironment";
import { workTaskAnswerSchema } from "@chuggy/worker-contract/workerTask";

import {
  workerAgentEnvironment,
  workerChangeBaseVariable,
  workerImageVariable,
  workerShellEnvironment,
  workerStageEnvironment,
} from "./checks.mjs";
import {
  claudeAgent,
  claudeBrief,
  claudeCredentialPrepared,
  claudeInvocation,
  claudeResult,
  claudeResumeInvocation,
  claudeShellScript,
  prepareClaudeShell,
} from "./claude.mjs";
import { claudeCredentialVariable } from "./claudeCredential.mjs";
import {
  decidingVariables,
  strayEnvironment,
  strayLeftFor,
} from "./claudeCredential.fixture.mjs";
import { codexAgent } from "./codex.mjs";
import {
  limitResult,
  limitSentence,
  limitSession,
} from "./rateLimit.fixture.mjs";
import { agentShells, posixShells } from "./shells.fixture.mjs";

/** Catches a job's agent moving a long command to the background, where the headless run kills it unseen. */
test("a Claude job never moves a command to the background", () => {
  assert.equal(
    claudeAgent.prepareCredential("token").environment
      .CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    "1",
  );
});

/** Catches a job's agent killed at Claude Code's own Bash timeout before a repository's checks end. */
test("a Claude job waits on a command past Claude Code's own Bash timeout", () => {
  const { environment } = claudeAgent.prepareCredential("token");
  assert.equal(environment.BASH_DEFAULT_TIMEOUT_MS, "1800000");
  assert.equal(environment.BASH_MAX_TIMEOUT_MS, "3000000");
});

/** Catches a run's Claude Code replacing itself, which an image's environment no longer prevents. */
test("a Claude run never updates its Claude Code", () => {
  assert.equal(
    claudeAgent.prepareCredential("token").environment.DISABLE_AUTOUPDATER,
    "1",
  );
});

/** The worker is parsed by the contract first, so the fixture is one a plane could serve. */
test("a configured Claude worker composes a valid default Claude invocation", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("./configuration.fixture.json", import.meta.url),
      "utf8",
    ),
  );
  const task = {
    worker: workTaskAnswerSchema.shape.worker.parse(configuration.worker),
    briefing: { text: "briefing" },
  };

  assert.deepEqual(claudeInvocation(task).slice(-2), [
    '--mcp-config={"mcpServers":{}}',
    "--allowedTools=Bash,Edit,Read,Write,Glob,Grep",
  ]);
  assert.deepEqual(claudeInvocation(task).slice(0, 7), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
  ]);
  assert.equal(claudeBrief(task), "briefing");
});

/**
 * Catches a resumed run that drops an option of the run it continues, is told
 * its briefing again, or a session that lands where an option taking every
 * word after it would swallow it.
 */
test("a resumed run is the same run in the conversation it left, told the limit reset", () => {
  const task = {
    worker: { mode: { arguments: ["--allowedTools", "Bash"] } },
    briefing: { text: "briefing" },
  };
  const first = claudeInvocation(task);

  const resumed = claudeResumeInvocation(task, "the-session");

  assert.deepEqual(resumed, [...first, "--resume", "the-session"]);
  assert.match(claudeBrief(task, "the-session"), /limit .*has reset/u);
  assert.ok(!claudeBrief(task, "the-session").includes("briefing"));
  assert.equal(claudeAgent.resumeInvocation, claudeResumeInvocation);
  assert.equal(claudeAgent.brief, claudeBrief);
});

/** Catches a resumed run told the limit's prompt in place of the one it was given, or a first run told a prompt in place of its briefing. */
test("a resumed run given a prompt is told that prompt alone, as its first message", () => {
  const task = { briefing: { text: "briefing" } };

  assert.equal(claudeBrief(task, "the-session", "-resolve it"), "-resolve it");
  assert.equal(claudeBrief(task, undefined, "-resolve it"), "briefing");
});

/** Which runtime may resume is what decides whether a limit can be waited out. */
test("a Codex run has no conversation to resume, so no limit of its is waited out", () => {
  assert.equal(codexAgent.resumeInvocation, undefined);
});

test("a result frame says what the runtime said and which conversation it ended", () => {
  assert.deepEqual(claudeAgent.ended(limitResult), {
    sentence: limitSentence,
    session: limitSession,
  });
  assert.deepEqual(claudeAgent.ended(undefined), {
    sentence: undefined,
    session: undefined,
  });
});

test("the final structured event is retained after streamed progress", () => {
  const final = {
    type: "result",
    structured_output: { verdict: "Pass", summary: "done" },
  };
  assert.deepEqual(
    claudeResult([{ type: "assistant", message: "working" }, final]),
    { output: final, result: final.structured_output },
  );
});

/**
 * Catches the briefing back on the command line, where no message after it
 * could be sent, or the MCP configuration given as a word `--mcp-config` would
 * take the next option's words with.
 */
test("a Claude run reads its briefing from stdin, whatever options precede it", () => {
  for (const configured of [[], ["--allowedTools", "Bash", "Read"]]) {
    const argv = claudeInvocation({
      worker: {
        mode: { type: "SingleAgent", agent: "Claude", arguments: configured },
      },
      briefing: { text: "briefing" },
    });

    assert.ok(!argv.includes("briefing"));
    assert.ok(!argv.includes("--"));
    assert.equal(argv[argv.indexOf("--input-format") + 1], "stream-json");
    assert.deepEqual(argv.slice(argv.length - configured.length), configured);
    assert.ok(argv.includes('--mcp-config={"mcpServers":{}}'));
    assert.ok(!argv.includes("--mcp-config"));
  }
});

/** Catches a worker's `--` making the words after it a prompt beside the briefing stdin carries. */
test("ticket configuration cannot end the run's options itself", () => {
  assert.throws(
    () =>
      claudeInvocation({
        worker: {
          mode: { type: "SingleAgent", agent: "Claude", arguments: ["--"] },
        },
        briefing: { text: "briefing" },
      }),
    /reserves Claude argument --$/u,
  );
});

test("ticket configuration cannot replace worker-owned Claude arguments", () => {
  assert.throws(
    () =>
      claudeInvocation({
        worker: {
          mode: {
            type: "SingleAgent",
            agent: "Claude",
            arguments: ["--mcp-config={}"],
          },
        },
        briefing: { text: "briefing" },
      }),
    /reserves Claude argument --mcp-config=/,
  );
});

/**
 * A pod's environment as a job's `check.sh` leaves it, for an image that set
 * three of the variables it moves aside: one to what this suite's node runs
 * under, one empty, and one to a value no shell word survives unquoted. The
 * pod holds its task document and a change base it inherited, neither of
 * which a stage's shells are handed.
 */
const checkedPod = {
  PATH: process.env.PATH ?? "",
  CHUG_SUITE_POD_VARIABLE: "the pod's own",
  [workerTaskVariable]: '{"the task":"document"}',
  [workerChangeBaseVariable]: "e".repeat(40),
  [workerImageVariable("NODE_OPTIONS")]: "--max-old-space-size=4096",
  [workerImageVariable("NODE_PATH")]: "",
  [workerImageVariable("LD_LIBRARY_PATH")]:
    '/image/it\'s "lib":$HOME/`id`\\\n\tend',
};

/** The variables a shell adds of its own to what it execs. */
const shellOwnVariables = ["PWD", "SHLVL", "OLDPWD", "_"];

/**
 * What a command of Claude Code's Bash tool is started with, the script run
 * as Claude Code runs it: its text, then the command, in one shell started
 * with the agent's own environment. The command is this suite's node, which
 * reports the environment it was handed. Its stdin is closed, since bash
 * takes the socket node would hand it for a remote shell's and reads this
 * machine's bashrc.
 */
function claudeCommandEnvironment(shell, script, environment) {
  const report = "process.stdout.write(JSON.stringify(process.env))";
  const ran = spawnSync(
    shell.argv[0],
    [
      ...shell.argv.slice(1),
      "-c",
      `${script.trim()}\n: && exec "$0" -e '${report}'`,
      process.execPath,
    ],
    { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(ran.status, 0, ran.stderr);
  const seen = JSON.parse(ran.stdout);
  for (const name of shellOwnVariables) delete seen[name];
  return seen;
}

/** The commit an attempt's change started from, where it knows one. */
const attemptBase = "a".repeat(40);

/** An entry an attempt's git configuration adds, its value one a shell must quote. */
const attemptGit = [
  ["credential.https://github.com.helper", "cache --socket '/minted/it''s'"],
];

/**
 * Catches an agent's shell running a project's commands in an environment a
 * check stage's shells are not handed: a value lost, mangled by its quoting,
 * left under the name `check.sh` kept it under, the task document, a change
 * base other than the attempt's own, or git's configuration other than the
 * attempt's.
 */
for (const shell of [...agentShells, ...posixShells])
  test(
    `a Claude command under ${shell.name} is handed what a check stage's shells are`,
    {
      skip: shell.absent,
    },
    () => {
      for (const handed of [
        { changeBase: attemptBase },
        {},
        { changeBase: attemptBase, git: attemptGit },
      ])
        assert.deepEqual(
          claudeCommandEnvironment(
            shell,
            claudeShellScript(workerShellEnvironment(checkedPod, handed)),
            workerAgentEnvironment(checkedPod),
          ),
          workerStageEnvironment(checkedPod, handed),
        );
    },
  );

/** Catches a script that leaves a variable set where it was handed none. */
test("a Claude shell handed nothing is given nothing to run", () => {
  assert.equal(claudeShellScript({}), "");
});

/**
 * Catches the script where Claude Code is not told of it, readable by another
 * user, or written over one something else left, which this run would then
 * take for its own.
 */
test("a Claude run's shell script is written once, privately, where CLAUDE_ENV_FILE names it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-claude-shell-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "shell.sh");

  const handed = workerShellEnvironment(checkedPod, {
    changeBase: attemptBase,
  });

  assert.deepEqual(await prepareClaudeShell(handed, file), {
    environment: { CLAUDE_ENV_FILE: file },
    arguments: [],
  });
  assert.equal(await readFile(file, "utf8"), claudeShellScript(handed));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(prepareClaudeShell(handed, file), /EEXIST/u);
  assert.equal(claudeAgent.prepareShell, prepareClaudeShell);
});

/** Catches the script written outside HOME, the directory a job's check found writable. */
test("a Claude run's shell script is under HOME where none is named", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chuggy-claude-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  const prepared = await prepareClaudeShell({});

  assert.equal(dirname(prepared.environment.CLAUDE_ENV_FILE), home);
});

const token = "sk-ant-oat01-exampleexampleexample";
const key = "sk-ant-api03-exampleexampleexample";

/** Claude Code's environment as a run composes it: the inherited less what is withheld, then the credential's. */
function composed(inherited, prepared) {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([name]) => !prepared.withheld.includes(name),
      ),
    ),
    ...prepared.environment,
  };
}

/**
 * Catches an inherited API key outranking the token a run was handed: a site
 * pool's runner names no kind, and a runner's selector names a subscription's,
 * and either way the token is the only credential Claude Code finds.
 */
test("a Claude OAuth run, named or not, runs on its token alone whatever key it inherits", () => {
  const inherited = { ...strayEnvironment, ANTHROPIC_API_KEY: key };
  for (const environment of [
    inherited,
    { ...inherited, [claudeCredentialVariable]: '{"kind":"Subscription"}' },
  ]) {
    const prepared = claudeCredentialPrepared(token, {
      path: "/var/run/chuggy/credentials/claude-code",
      environment,
    });
    const ran = composed(inherited, prepared);

    assert.deepEqual(
      decidingVariables.filter((name) => Object.hasOwn(ran, name)),
      ["CLAUDE_CODE_OAUTH_TOKEN"],
    );
    assert.equal(ran.CLAUDE_CODE_OAUTH_TOKEN, token);
    assert.deepEqual(prepared.secrets, [token]);
  }
  assert.deepEqual(
    claudeAgent.prepareCredential(token).withheld,
    claudeCredentialPrepared(token, {
      environment: { [claudeCredentialVariable]: '{"kind":"Subscription"}' },
    }).withheld,
  );
});

/** Catches an inherited token outranked by, or outranking, the API key a run was handed. */
test("a Claude API-key run runs on its key alone whatever token it inherits", () => {
  const inherited = { ...strayEnvironment, CLAUDE_CODE_OAUTH_TOKEN: token };
  const ran = composed(
    inherited,
    claudeCredentialPrepared(key, {
      environment: { [claudeCredentialVariable]: '{"kind":"ApiKey"}' },
    }),
  );

  assert.deepEqual(
    decidingVariables.filter((name) => Object.hasOwn(ran, name)),
    ["ANTHROPIC_API_KEY"],
  );
  assert.equal(ran.ANTHROPIC_API_KEY, key);
});

/** Each kind as its setting, its file, and what it sets that decides the credential Claude Code runs on. */
const namedKinds = [
  [{ kind: "Subscription" }, token, { CLAUDE_CODE_OAUTH_TOKEN: token }],
  [{ kind: "ApiKey" }, key, { ANTHROPIC_API_KEY: key }],
  [
    { kind: "Foundry", resource: "example" },
    key,
    {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "example",
      ANTHROPIC_FOUNDRY_API_KEY: key,
    },
  ],
  [
    { kind: "Bedrock", region: "us-west-2" },
    key,
    {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: key,
    },
  ],
  [
    { kind: "Bedrock", region: "us-west-2", profile: "chuggy" },
    `[chuggy]\naws_access_key_id = ${key}\naws_secret_access_key = ${token}`,
    {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_SHARED_CREDENTIALS_FILE: "/mounted",
      AWS_PROFILE: "chuggy",
    },
  ],
  [
    { kind: "Vertex", region: "us-east5", project: "example" },
    JSON.stringify({ type: "service_account", private_key: key }),
    {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_VERTEX_PROJECT_ID: "example",
      GOOGLE_APPLICATION_CREDENTIALS: "/mounted",
    },
  ],
];

/**
 * Catches a variable a runner's environment left in deciding which credential
 * Claude Code runs on or where it sends it: a token beside a key, which the
 * key would outrank, a key beside a token, which would outrank it, a
 * provider's selector beside either, and a base URL, a header or a socket
 * that would send the kind's credential elsewhere. The names are the
 * fixture's, written out apart from the module's.
 */
test("a kind named is the only credential in force, at its provider's own endpoint, whatever the runner's environment left", () => {
  for (const [setting, text, set] of namedKinds) {
    const environment = composed(
      { ...strayEnvironment, PATH: "/usr/bin" },
      claudeCredentialPrepared(text, {
        path: "/mounted",
        environment: {
          ...strayEnvironment,
          [claudeCredentialVariable]: JSON.stringify(setting),
        },
      }),
    );
    assert.deepEqual(strayLeftFor(setting.kind, environment), [], setting.kind);
    for (const [name, value] of Object.entries(set))
      assert.equal(environment[name], value, `${setting.kind} ${name}`);
    for (const name of decidingVariables)
      if (!Object.hasOwn(set, name))
        assert.ok(!(name in environment), `${setting.kind} kept ${name}`);
    assert.equal(environment.PATH, "/usr/bin");
  }
});

/**
 * Catches a named kind run without Claude Code's routing held by its host,
 * under which a checkout's settings could send the credential elsewhere, or a
 * cloud provider's telemetry left on by it.
 */
test("a named kind is run as a host's, with a cloud provider's telemetry left off", () => {
  for (const [setting, text, telemetry] of [
    [{ kind: "Subscription" }, token, undefined],
    [{ kind: "ApiKey" }, key, undefined],
    [{ kind: "Bedrock", region: "us-west-2" }, key, "1"],
    [{ kind: "Foundry", resource: "example" }, key, "1"],
  ]) {
    const { environment } = claudeCredentialPrepared(text, {
      path: "/mounted",
      environment: { [claudeCredentialVariable]: JSON.stringify(setting) },
    });
    assert.equal(environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
    assert.equal(environment.DISABLE_TELEMETRY, telemetry, setting.kind);
    assert.equal(environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(environment.BASH_DEFAULT_TIMEOUT_MS, "1800000");
    assert.equal(environment.BASH_MAX_TIMEOUT_MS, "3000000");
    assert.equal(environment.DISABLE_AUTOUPDATER, "1");
  }
});

/** Catches a file of the wrong shape handed to Claude Code rather than refused before it runs. */
test("a named kind's file of the wrong shape is refused before Claude Code is started on it", () => {
  assert.throws(
    () =>
      claudeCredentialPrepared(`${key}\n${key}`, {
        path: "/mounted",
        environment: {
          [claudeCredentialVariable]: JSON.stringify({ kind: "ApiKey" }),
        },
      }),
    {
      message:
        "the Anthropic API key file /mounted holds more than one line; save a key from the Claude Console there, alone",
    },
  );
});
