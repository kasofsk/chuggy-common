import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  author,
  git,
  handedAsTheImage,
  headOf,
  inCheckout,
  recordingGit,
  remoteRefs,
} from "./checkout.fixture.mjs";
import { workerGitVariable } from "./checks.mjs";
import { forgeServed } from "./gitForge.fixture.mjs";
import { gitRemotePauseMs, gitRemoteTriesMax } from "./gitRemote.mjs";
import { workerCredentialEnvironment } from "./repository.mjs";
import {
  RunStepFailure,
  runCommitFailed,
  runPushFailed,
  runSetupFailed,
} from "./runEvidence.mjs";
import {
  checkpointAndPushSource,
  commitAndPushSource,
  resultDocument,
  sourceCheckpointDeleted,
  sourceCheckpointRestored,
  sourceCheckpointSeen,
  sourcePushPlacingVariables,
  sourceRestoredBriefed,
  sourceSecretReader,
  ticketBranch,
  ticketCheckpoint,
} from "./source.mjs";

/** Two secrets a pod holds, as its push is handed them. */
const held = [
  {
    kind: "the Claude Code credential",
    value: "sk-ant-oat01-0123456789abcdefghijklmnop",
  },
  {
    kind: "the git credential the plane minted",
    value: "ghs_0123456789abcdefghijklmnopqrstuvwxyz",
  },
];

/** The commit a stand-in git names, as git prints a commit's name. */
const stubbedCommit = "abc123".padEnd(40, "0");

/** The verb of one git call, past any `-c` entries before it. */
function gitVerb(args) {
  return args.find((arg, index) => arg !== "-c" && args[index - 1] !== "-c");
}

/**
 * A stand-in git that records each call in `calls` and answers it as
 * `answer` does where `answer` answers anything; otherwise `rev-parse` with a
 * workspace's object directory where it asks for one and `stubbedCommit`
 * where it does not, `init` as git itself does, since the push is made from
 * the repository it makes, and anything else with nothing.
 */
function stubbedGit(calls, answer = async () => undefined) {
  return async (executable, args, options) => {
    calls.push({ executable, args, options });
    const answered = await answer(args, options);
    if (answered !== undefined) return answered;
    if (gitVerb(args) === "init")
      return git(executable, args, {
        ...options,
        env: { PATH: process.env.PATH ?? "", ...options.env },
      });
    if (args.includes("--git-path")) return { stdout: ".git/objects\n" };
    return gitVerb(args) === "rev-parse"
      ? { stdout: `${stubbedCommit}\n` }
      : { stdout: "" };
  };
}

/**
 * Clears `process.env` of every variable git reads configuration entries
 * from until `t` ends, so a suite run as a job, whose worker hands it entries
 * of its own, reads and spawns git as a pod whose image names none.
 */
function withoutStandingGitEntries(t) {
  const standing = Object.entries(process.env).filter(([name]) =>
    workerGitVariable(name),
  );
  for (const [name] of standing) delete process.env[name];
  t.after(() => {
    Object.assign(process.env, Object.fromEntries(standing));
  });
}

/** The one call of `verb` among `calls`. */
function callOf(calls, verb) {
  const found = calls.filter(({ args }) => gitVerb(args) === verb);
  assert.equal(
    found.length,
    1,
    `git ${verb} ran ${String(found.length)} times`,
  );
  return found[0];
}

/** Whether `path` is `directory` or anywhere under it. */
function within(directory, path) {
  const way = relative(directory, path);
  return way === "" || (way !== ".." && !way.startsWith(`..${sep}`));
}

/** Whether anything is at `path`. */
async function present(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** One attempt published through `command`, a stand-in git, from `/workspace/repository`, holding no secret. */
function stubPublished(command, more = {}) {
  return commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: { GIT_ASKPASS: "askpass" },
    secrets: [],
    ...more,
  });
}

test("ticket branch is deterministic, bounded, and names the ticket", () => {
  assert.equal(
    ticketBranch({ ticket: 42, attempt: "attempt-identity" }),
    "refs/heads/chuggy/tickets/42/attempts/" +
      "9a33b56cbbac4db829e4917c5ac9369958062635f18534cfc26b48071229a39f",
  );
});

/** What the directory a push is made from holds as the push runs: the alternates of its repository, its hooks directory, its global configuration and its home. */
async function pushPlaceHolding({ cwd, env }) {
  return {
    alternates: await readFile(
      join(env.GIT_DIR, "objects", "info", "alternates"),
      "utf8",
    ),
    hooks: await readdir(join(cwd, "hooks")),
    global: await readFile(env.GIT_CONFIG_GLOBAL, "utf8"),
    home: await homeHolding(env.HOME),
  };
}

/** A home's entries, less a `.cache` holding Rosetta's translation cache alone: an x86-64 git run under Rosetta writes it there, and git reads no configuration from it. */
async function homeHolding(home) {
  const entries = await readdir(home);
  if (!entries.includes(".cache")) return entries;
  const cached = await readdir(join(home, ".cache"));
  return cached.length === 1 && cached[0] === "rosetta"
    ? entries.filter((entry) => entry !== ".cache")
    : entries;
}

/**
 * Catches a push made from the workspace, or from a repository of the core's
 * that holds a hook, borrows no objects or outlives the push; a push that
 * reads a configuration file it was not handed, a home that holds one, or any
 * helper; and a push
 * whose URL or refspec is anything but the attempt's.
 */
test("source publication commits all changes and pushes a new attempt ref from a repository of its own", async () => {
  const calls = [];
  let seen;
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) !== "push") return undefined;
    seen = await pushPlaceHolding(options);
    return { stdout: "" };
  });
  const source = await stubPublished(command, {
    task: {
      ticket: 7,
      attempt: "opaque",
      worker: { files: [{ path: ".claude/settings.json" }] },
    },
  });

  assert.deepEqual(source, {
    repository: "chuggy",
    ref: ticketBranch({ ticket: 7, attempt: "opaque" }),
    commit: stubbedCommit,
    base: "base123",
  });
  const push = calls.at(-1);
  const made = push.options.cwd;
  assert.ok(!within("/workspace/repository", made), made);
  assert.deepEqual(push.args, [
    "-c",
    `core.hooksPath=${join(made, "hooks")}`,
    "-c",
    "credential.helper=",
    "push",
    "http://git/rig.git",
    `${stubbedCommit}:${source.ref}`,
  ]);
  assert.deepEqual(push.options.env, {
    GIT_ASKPASS: "askpass",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(made, "configuration"),
    HOME: join(made, "home"),
    XDG_CONFIG_HOME: join(made, "home"),
    GIT_DIR: join(made, "repository"),
    GIT_DEFAULT_HASH: "sha1",
  });
  assert.deepEqual(callOf(calls, "init").args, [
    "init",
    "--quiet",
    "--bare",
    "--template=",
  ]);
  assert.deepEqual(seen, {
    alternates: "/workspace/repository/.git/objects\n",
    hooks: [],
    global: "",
    home: [],
  });
  assert.equal(await present(made), false, "the push's repository outlived it");
  assert.ok(calls.some(({ args }) => args[0] === "add" && args[1] === "--all"));
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === "reset" && args.at(-1) === ".claude/settings.json",
    ),
  );
  assert.ok(
    calls.some(
      ({ args }) => args[0] === "commit" && args.includes("--allow-empty"),
    ),
  );
});

/**
 * Catches a variable that places a repository reaching the push, which would
 * have it made from the repository the variable names rather than the core's.
 */
test("the push is handed no variable that places a repository, whatever the pod holds", async () => {
  const calls = [];
  const placing = Object.fromEntries(
    sourcePushPlacingVariables.map((name) => [name, `/pod/${name}`]),
  );

  await stubPublished(stubbedGit(calls), {
    environment: { ...placing, GIT_ASKPASS: "askpass" },
  });

  const push = callOf(calls, "push").options;
  for (const name of sourcePushPlacingVariables)
    assert.ok(
      !Object.values(push.env).includes(`/pod/${name}`),
      `${name} reached the push`,
    );
  assert.equal(push.env.GIT_DIR, join(push.cwd, "repository"));
});

/**
 * Catches a variable that places a repository left off the list the push is
 * cleared of, where the git this suite runs names it.
 */
test("the push is cleared of every variable git names local to a repository but the two carrying configuration entries", async () => {
  const { stdout } = await git("git", ["rev-parse", "--local-env-vars"]);
  const named = stdout.split("\n").filter((name) => name.length > 0);

  assert.deepEqual(
    named.filter((name) => !sourcePushPlacingVariables.includes(name)).sort(),
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"],
  );
});

test("a push that can take a fresh credential takes one once its repository is made, and uses it", async () => {
  const calls = [];
  let refreshes = 0;

  await stubPublished(stubbedGit(calls), {
    environment: {
      GIT_ASKPASS: "askpass",
      CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/earlier",
    },
    refresh: async () => {
      assert.equal(
        gitVerb(calls.at(-1).args),
        "init",
        "the credential is taken before everything the push needs but the push",
      );
      refreshes += 1;
      return {
        GIT_ASKPASS: "askpass",
        CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/later",
      };
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(gitVerb(calls.at(-1).args), "push");
  assert.equal(
    calls.at(-1).options.env.CHUG_WORKER_GIT_CREDENTIAL_FILE,
    "/tmp/later",
  );
});

/** The `[key, value]` entries `environment` hands git, in the order git reads them. */
function gitEntries(environment) {
  return Array.from(
    { length: Number(environment.GIT_CONFIG_COUNT ?? "0") },
    (_, index) => [
      environment[`GIT_CONFIG_KEY_${String(index)}`],
      environment[`GIT_CONFIG_VALUE_${String(index)}`],
    ],
  );
}

/**
 * Catches the push handed the attempt's reads, which it reaches no other
 * repository with, or the entries the image's environment names dropped from
 * it; and the commit's hooks handed anything less than the reads.
 */
test("the commit is handed the attempt's git, and the push only what the image's environment names", async (t) => {
  withoutStandingGitEntries(t);
  const calls = [];
  const reads = [
    ["credential.http://git.helper", ""],
    ["credential.http://git.helper", "cache --socket '/minted/reads.sock'"],
  ];
  const image = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "X-Image: kept",
  };

  await stubPublished(stubbedGit(calls), {
    environment: {},
    git: reads,
    refresh: async () => ({ GIT_ASKPASS: "askpass", ...image }),
  });

  assert.deepEqual(gitEntries(callOf(calls, "push").options.env), [
    ["http.extraHeader", "X-Image: kept"],
  ]);
  assert.deepEqual(gitEntries(callOf(calls, "commit").options.env), reads);
});

/** A git child that failed, writing `stderr`, as `execFile` rejects with it. */
function gitFailed(stderr) {
  return Object.assign(new Error(`Command failed: git\n${stderr}`), {
    code: 1,
    stderr,
  });
}

/**
 * One attempt published through a stand-in git whose pushes fail in turn as
 * `pushes` says and then succeed, and whose commit throws `commit` where it is
 * given: what the attempt declared or threw, how many times it pushed, how
 * many times it took a credential, each pause between pushes, each directory
 * a push was made from, the directory the repository it pushes from was made
 * in, and whether that directory is still there.
 */
async function pushedThrough(
  pushes,
  { commit, refresh = async () => ({ GIT_ASKPASS: "askpass" }) } = {},
) {
  let pushed = 0;
  let refreshes = 0;
  const pauses = [];
  const from = [];
  const calls = [];
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) === "commit" && commit !== undefined) throw commit;
    if (gitVerb(args) !== "push") return undefined;
    pushed += 1;
    from.push(options.cwd);
    if (pushes[pushed - 1] !== undefined) throw pushes[pushed - 1];
    return { stdout: "" };
  });
  const outcome = await stubPublished(command, {
    environment: {},
    refresh: () => {
      refreshes += 1;
      return refresh();
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  }).catch((failure) => failure);
  const made = calls.find(({ args }) => gitVerb(args) === "init")?.options.cwd;
  const left = made !== undefined && (await present(made));
  return { outcome, pushed, refreshes, pauses, from, made, left };
}

/** A server error a push is tried again after. */
const serverError = gitFailed(
  "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 502\n",
);

test("a push the forge failed with a server error is tried again under the one credential from the one repository, and lands", async () => {
  const { outcome, pushed, refreshes, pauses, from, made, left } =
    await pushedThrough([serverError]);

  assert.equal(outcome.commit, stubbedCommit);
  assert.equal(pushed, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
  assert.deepEqual(from, [made, made]);
  assert.equal(left, false, "the push's repository outlived it");
});

/** GitHub's answer to a credential minted moments before, as git reports it. */
const notFound = gitFailed(
  "remote: Repository not found.\nfatal: repository 'http://git/rig.git/' not found\n",
);

test("a push the forge answered not found is tried again under the one credential from the one repository, and lands", async () => {
  const { outcome, pushed, refreshes, pauses, from, made } =
    await pushedThrough([notFound]);

  assert.equal(outcome.commit, stubbedCommit);
  assert.equal(pushed, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(pauses, [gitRemotePauseMs]);
  assert.deepEqual(from, [made, made]);
});

test("a push the forge never finds the repository for fails the push step once every try is spent, led by git's own line", async () => {
  const { outcome, pushed, left } = await pushedThrough(
    Array.from({ length: gitRemoteTriesMax + 1 }, () => notFound),
  );

  assert.ok(outcome instanceof RunStepFailure);
  assert.equal(outcome.evidence, runPushFailed);
  assert.equal(
    outcome.message.split("\n")[0],
    "fatal: repository 'http://git/rig.git/' not found",
  );
  assert.equal(outcome.cause, notFound);
  assert.equal(pushed, gitRemoteTriesMax);
  assert.equal(left, false, "the push's repository outlived it");
});

test("a push failing every try fails the push step and leaves no repository of its own behind", async () => {
  const { outcome, pushed, made, left } = await pushedThrough(
    Array.from({ length: 8 }, () => serverError),
  );

  assert.equal(outcome.evidence, runPushFailed);
  assert.ok(pushed > 1);
  assert.notEqual(made, undefined);
  assert.equal(left, false, "the push's repository outlived it");
});

/**
 * Catches a directory made under a relative `TMPDIR` and named to git as it
 * was made: the push runs from inside it, so every path git is handed under it
 * would be read against itself.
 */
test("a push made under a relative temporary directory lands and leaves nothing behind", async () => {
  const room = await mkdtemp(join(tmpdir(), "chuggy-push-relative-"));
  const held = { cwd: process.cwd(), TMPDIR: process.env.TMPDIR };
  try {
    await mkdir(join(room, "temporary"));
    process.chdir(room);
    process.env.TMPDIR = "temporary";
    const calls = [];
    const outcome = await stubPublished(stubbedGit(calls)).catch(
      (failure) => failure,
    );

    assert.ok(!(outcome instanceof Error), String(outcome.message));
    const made = callOf(calls, "push").options.cwd;
    assert.ok(made.startsWith(join(room, "temporary", sep)), made);
    assert.deepEqual(await readdir(join(room, "temporary")), []);
  } finally {
    process.chdir(held.cwd);
    if (held.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = held.TMPDIR;
    await rm(room, { recursive: true, force: true });
  }
});

/**
 * Catches a removal whose failure is raised over how the push ended: a push
 * that landed would be reported failed.
 */
test("a push whose repository cannot be removed still reports that it landed", async () => {
  let locked;
  const calls = [];
  const command = stubbedGit(calls, async (args, options) => {
    if (gitVerb(args) !== "push") return undefined;
    locked = join(options.cwd, "locked");
    await mkdir(join(locked, "inside"), { recursive: true });
    await chmod(locked, 0o500);
    return { stdout: "" };
  });
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk));
  try {
    const outcome = await stubPublished(command).catch((failure) => failure);

    assert.ok(!(outcome instanceof Error), String(outcome.message));
    assert.equal(outcome.commit, stubbedCommit);
    assert.ok(
      written.some((line) =>
        line.startsWith(
          `the push's repository ${dirname(locked)} could not be removed: `,
        ),
      ),
      written.join(""),
    );
  } finally {
    process.stderr.write = write;
    await chmod(locked, 0o700);
    await rm(dirname(locked), { recursive: true, force: true });
  }
});

test("a push the forge refuses is tried once and fails the push step, led by why", async () => {
  for (const [stderr, why] of [
    [
      "remote: Permission to rig.git denied to bot.\nfatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403\n",
      "fatal: unable to access 'http://git/rig.git/': The requested URL returned error: 403",
    ],
    [
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.\n ! [remote rejected] abc123 -> chuggy (protected branch hook declined)\nerror: failed to push some refs to 'http://git/rig.git'\n",
      "remote: error: GH006: Protected branch update failed for refs/heads/chuggy.",
    ],
  ]) {
    const { outcome, pushed, left } = await pushedThrough([gitFailed(stderr)]);

    assert.ok(outcome instanceof RunStepFailure, why);
    assert.equal(outcome.evidence, runPushFailed, why);
    assert.equal(outcome.message.split("\n")[0], why);
    assert.ok(outcome.message.includes(stderr), why);
    assert.equal(pushed, 1, why);
    assert.equal(left, false, why);
  }
});

test("a push that cannot take its credential fails the push step, pushes nothing and leaves no repository of its own behind", async () => {
  const { outcome, pushed, made, left } = await pushedThrough([], {
    refresh: async () => {
      throw new Error("the worker plane answered 503 for a credential");
    },
  });

  assert.equal(outcome.evidence, runPushFailed);
  assert.equal(
    outcome.message,
    "the worker plane answered 503 for a credential",
  );
  assert.equal(pushed, 0);
  assert.notEqual(made, undefined);
  assert.equal(left, false, "the push's repository outlived it");
});

test("a commit its hook stops fails the commit step, takes no credential and makes no repository to push from", async () => {
  const { outcome, pushed, refreshes, made } = await pushedThrough([], {
    commit: gitFailed("pre-commit: secrets found\nerror: hook refused\n"),
  });

  assert.ok(outcome instanceof RunStepFailure);
  assert.equal(outcome.evidence, runCommitFailed);
  assert.equal(outcome.message.split("\n")[0], "error: hook refused");
  assert.equal(pushed, 0);
  assert.equal(refreshes, 0);
  assert.equal(made, undefined);
});

/**
 * One attempt published from a checkout by git itself, holding `held`: the
 * source it declared or the error it was refused with, and how many times its
 * push asked for a credential. `meanwhile` runs as the push asks, after the
 * check.
 */
async function publishedFrom(
  { remote, directory, base },
  meanwhile = async () => undefined,
  more = {},
) {
  const asked = { refreshes: 0 };
  const source = commitAndPushSource({
    task: { ticket: 9, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: remote,
    base,
    directory,
    command: git,
    environment: process.env,
    secrets: held,
    refresh: async () => {
      asked.refreshes += 1;
      await meanwhile();
      return process.env;
    },
    ...more,
  });
  return { asked, source: await source.catch((error) => error) };
}

/**
 * Catches a push repository made in an object format other than the
 * workspace's: it could borrow none of its objects, and the push would fail.
 */
test("a SHA-256 workspace pushes to a SHA-256 remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "chuggy-push-sha256-"));
  try {
    const remote = join(root, "remote.git");
    const directory = join(root, "checkout");
    await git("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      "--bare",
      remote,
    ]);
    await git("git", ["init", "--quiet", "--object-format=sha256", directory]);
    await writeFile(join(directory, "a"), "a\n");
    await git("git", ["add", "a"], { cwd: directory });
    await git("git", [...author, "commit", "--quiet", "-m", "base"], {
      cwd: directory,
    });
    const base = await headOf(directory);
    await git("git", ["push", "--quiet", remote, "HEAD:refs/heads/main"], {
      cwd: directory,
    });
    await writeFile(join(directory, "b"), "b\n");

    const { source } = await publishedFrom({ remote, directory, base });

    assert.ok(!(source instanceof Error), String(source.message));
    assert.equal(source.commit.length, 64);
    const { stdout } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(stdout.trim(), source.commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Driven against real repositories, because whether a commit exists when nothing
 * changed is git's answer and not the stub's. Catches a commit that stopped
 * being `--allow-empty`: the attempt would crash where it should have declared
 * the work its commands found nothing left to do.
 */
test("an attempt that changed nothing still declares a commit on its branch", async () => {
  await inCheckout(async ({ remote, directory, base }) => {
    const { source } = await publishedFrom({ remote, directory, base });

    const { stdout: changed } = await git(
      "git",
      ["diff", "--name-only", base, source.commit],
      { cwd: directory },
    );
    assert.equal(changed, "", "the attempt changed the tree it was given");
    assert.notEqual(source.commit, base);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/**
 * Catches a failed attempt's work lost with its container: what it changed,
 * committed or not, is pushed to the branch a pass would have used.
 */
test("an attempt that declares no empty commit pushes what it changed to its branch", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    const authored = await agentCommitted(directory, "change", "made\n");
    await writeFile(join(directory, "left"), "over\n");

    const { source } = await publishedFrom(checkout, undefined, {
      candidate: false,
    });

    assert.equal(source.ref, ticketBranch({ ticket: 9, attempt: "opaque" }));
    const { stdout: parent } = await git(
      "git",
      ["rev-parse", `${source.commit}^`],
      { cwd: directory },
    );
    assert.equal(parent.trim(), authored);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/**
 * Catches an empty commit pushed for an attempt that changed nothing but the
 * files provisioned for it, which keeps nothing, and a credential taken for it.
 */
test("an attempt that declares no empty commit and changed nothing pushes nothing", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote, base } = checkout;
    await writeFile(join(directory, "provisioned.json"), "{}\n");

    const { asked, source } = await publishedFrom(checkout, undefined, {
      task: {
        ticket: 9,
        attempt: "opaque",
        worker: { files: [{ path: "provisioned.json" }] },
      },
      candidate: false,
    });

    assert.equal(source, undefined);
    assert.equal(await headOf(directory), base);
    assert.equal(asked.refreshes, 0);
    assert.equal(await remoteRefs(remote), "");
  });
});

/**
 * Catches a worker commit made on top of an author's own when nothing is left
 * to commit: `HEAD`, the pushed ref and the attempt's commit would carry only
 * the worker's message, and not the author's why.
 */
test("an author's commit with nothing left over is the attempt's commit", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    const authored = await agentCommitted(directory, "change", "made\n");

    const { source } = await publishedFrom(checkout);

    assert.equal(source.commit, authored);
    assert.equal(await headOf(directory), authored);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), authored);
  });
});

/** Catches what an author left uncommitted on top of its own commit going unpushed. */
test("an author's commit with changes left over gets one commit on top holding them", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    const authored = await agentCommitted(directory, "change", "made\n");
    await writeFile(join(directory, "left"), "over\n");

    const { source } = await publishedFrom(checkout);

    const { stdout: parent } = await git(
      "git",
      ["rev-parse", `${source.commit}^`],
      { cwd: directory },
    );
    assert.equal(parent.trim(), authored);
    const { stdout: changed } = await git(
      "git",
      ["diff", "--name-only", authored, source.commit],
      { cwd: directory },
    );
    assert.equal(changed, "left\n");
  });
});

/**
 * Catches a check that refuses what it should pass: an attempt holding secrets
 * whose commits carry none pushes as it did before there was a check, and
 * takes its credential only once the check is done.
 */
test("an attempt whose commits carry no held secret pushes them", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(
      join(checkout.directory, "large.bin"),
      Buffer.concat([
        Buffer.alloc(1 << 20),
        Buffer.from(held[0].value.slice(1)),
      ]),
    );

    const { asked, source } = await publishedFrom(checkout);

    assert.equal(asked.refreshes, 1);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: checkout.remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/** Asserts `refused` is the check's refusal of `secret` in `commit`, and that nothing left the checkout. */
async function assertRefused(checkout, { refused, asked }, expected) {
  assert.ok(refused instanceof Error, "the attempt pushed a secret");
  assert.equal(refused.evidence, runCommitFailed);
  assert.equal(
    refused.message,
    `commit ${expected.commit} carries ${expected.secret.kind} in ${expected.place}, so the attempt pushes nothing`,
  );
  assert.ok(!refused.message.includes(expected.secret.value));
  assert.equal(
    asked.refreshes,
    0,
    "a credential was minted for a refused push",
  );
  assert.equal(await remoteRefs(checkout.remote), "");
}

/**
 * Catches a check that reads only the first secret, or only text: each held
 * secret is refused at the end of a binary file too large for one read.
 */
test("a file carrying any held secret is refused, and nothing is pushed", async () => {
  for (const secret of held)
    await inCheckout(async (checkout) => {
      await writeFile(
        join(checkout.directory, "large.bin"),
        Buffer.concat([Buffer.alloc(1 << 20), Buffer.from(secret.value)]),
      );

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        {
          secret,
          commit: await headOf(checkout.directory),
          place: "a file",
        },
      );
    });
});

/** A file the agent committed itself, and the commit it made. */
async function agentCommitted(directory, path, content) {
  await writeFile(join(directory, path), content);
  await git("git", ["add", path], { cwd: directory });
  await git("git", [...author, "commit", "-m", "the agent's"], {
    cwd: directory,
  });
  return headOf(directory);
}

/**
 * `checkout` with its base one commit past the one it was made with, which is
 * `below`, and a branch `target` at a commit made on `below` that the base
 * does not have, as a target that moved on would hold.
 */
async function rewritableCheckout(checkout) {
  const { directory } = checkout;
  const below = checkout.base;
  const base = await agentCommitted(directory, "base", "started\n");
  await git("git", ["checkout", "--quiet", "-b", "target", below], {
    cwd: directory,
  });
  await agentCommitted(directory, "target", "moved on\n");
  await git("git", ["checkout", "--quiet", "-"], { cwd: directory });
  return { ...checkout, base, below };
}

/** Asserts `refused` is a candidate refused for not descending from `base`, and that nothing left the checkout. */
async function assertRewrittenRefused(checkout, { refused, asked }) {
  assert.ok(refused instanceof Error, "a rewritten history was pushed");
  assert.equal(refused.evidence, runCommitFailed);
  assert.equal(
    refused.message,
    `commit ${await headOf(checkout.directory)} does not descend from ${checkout.base}, the commit this attempt started from, so the attempt pushes nothing. A rebase does this, and so does checking out a different commit. Add commits on top of ${checkout.base} instead, merging the target in rather than rebasing onto it.`,
  );
  assert.equal(
    asked.refreshes,
    0,
    "a credential was minted for a refused push",
  );
  assert.equal(await remoteRefs(checkout.remote), "");
}

/**
 * Catches a candidate pushed from an attempt that rebased its base onto a
 * newer target: it no longer descends from the base it is published with,
 * and no candidate can be built from it.
 */
test("a candidate rebased below its base is refused, and nothing is pushed", async () => {
  await inCheckout(async (made) => {
    const checkout = await rewritableCheckout(made);
    await agentCommitted(checkout.directory, "change", "made\n");
    await git(
      "git",
      [...author, "rebase", "--quiet", "--onto", "target", checkout.below],
      { cwd: checkout.directory },
    );

    const { asked, source } = await publishedFrom(checkout);

    await assertRewrittenRefused(checkout, { refused: source, asked });
  });
});

/** Catches a candidate pushed from an attempt that squashed its base into its own commit. */
test("a candidate squashed below its base is refused, and nothing is pushed", async () => {
  await inCheckout(async (made) => {
    const checkout = await rewritableCheckout(made);
    await agentCommitted(checkout.directory, "change", "made\n");
    await git("git", ["reset", "--soft", checkout.below], {
      cwd: checkout.directory,
    });
    await git("git", [...author, "commit", "--quiet", "-m", "squashed"], {
      cwd: checkout.directory,
    });

    const { asked, source } = await publishedFrom(checkout);

    await assertRewrittenRefused(checkout, { refused: source, asked });
  });
});

/**
 * Catches a check that refuses what it should pass: a newer target merged in
 * on top of the base, after a commit of the agent's own, keeps the base an
 * ancestor, and the candidate is pushed as it stands.
 */
test("a candidate that merged a newer target in on top of its base is pushed", async () => {
  await inCheckout(async (made) => {
    const checkout = await rewritableCheckout(made);
    await agentCommitted(checkout.directory, "change", "made\n");
    await git("git", [...author, "merge", "--quiet", "--no-edit", "target"], {
      cwd: checkout.directory,
    });
    const merged = await headOf(checkout.directory);

    const { source } = await publishedFrom(checkout);

    assert.ok(!(source instanceof Error), String(source.message));
    assert.equal(source.commit, merged);
    assert.equal(source.base, checkout.base);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: checkout.remote,
    });
    assert.equal(pushed.trim(), merged);
  });
});

/**
 * The check reads every commit the push adds, and names the first to carry
 * the secret. Catches a check of the attempt's final tree, which a secret the
 * agent committed and the attempt's own commit removed would pass, and one
 * naming the attempt's own commit for a secret the agent's put there.
 */
test("a secret is refused at the commit that first carries it, whether or not a later one removes it", async () => {
  for (const removed of [true, false])
    await inCheckout(async (checkout) => {
      const { directory } = checkout;
      const added = await agentCommitted(directory, "token", held[1].value);
      if (removed) await rm(join(directory, "token"));

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        { secret: held[1], commit: added, place: "a file" },
      );
      if (!removed) assert.equal(await headOf(directory), added);
    });
});

test("a secret in a commit's message is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    await git(
      "git",
      [...author, "commit", "--allow-empty", "-m", `saw ${held[0].value}`],
      { cwd: directory },
    );
    const carrying = await headOf(directory);

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: carrying,
        place: "its message",
      },
    );
  });
});

test("a secret in a file's name is refused", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(join(checkout.directory, held[0].value), "named\n");

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: await headOf(checkout.directory),
        place: "a path",
      },
    );
  });
});

/**
 * A push sends the objects a commit names, whatever a replacement ref stands
 * in for them. Catches a check that reads the replacement: an agent's
 * `git replace` would show it a clean file while the secret was pushed.
 */
test("a secret behind a replacement ref is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    const carrying = await agentCommitted(directory, "token", held[1].value);
    const { stdout: blob } = await git("git", ["rev-parse", "HEAD:token"], {
      cwd: directory,
    });
    await writeFile(join(directory, "clean"), "clean\n");
    const { stdout: clean } = await git("git", ["hash-object", "-w", "clean"], {
      cwd: directory,
    });
    await rm(join(directory, "clean"));
    await git("git", ["replace", blob.trim(), clean.trim()], {
      cwd: directory,
    });

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      { secret: held[1], commit: carrying, place: "a file" },
    );
  });
});

/**
 * What is pushed is the commit that was checked. Catches a push of `HEAD`,
 * which a process the agent left running could move between the check and the
 * push, onto a commit the check never read.
 */
test("a commit made after the check is never what is pushed", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;

    const { source } = await publishedFrom(checkout, async () => {
      await agentCommitted(directory, "late", held[0].value);
    });

    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
    assert.notEqual(source.commit, await headOf(directory));
  });
});

/**
 * A check git could not run found nothing, and is no reason to push. Catches
 * an exit status left unread: a base the checkout does not have lists no
 * object at all, which reads exactly like a clean push.
 */
test("a check git cannot run refuses the push", async () => {
  await inCheckout(async (checkout) => {
    const { asked, source: refused } = await publishedFrom({
      ...checkout,
      base: "f".repeat(40),
    });

    assert.ok(refused instanceof Error, "the attempt pushed unchecked");
    assert.match(
      refused.message,
      /^git rev-list exited 128 checking the push for secrets: /u,
    );
    assert.equal(asked.refreshes, 0);
    assert.equal(await remoteRefs(checkout.remote), "");
  });
});

/**
 * An image's git, and the hooks its project installed, may need a value
 * `check.sh` moved aside. Catches any git call of the publication's, or a
 * hook its commit runs, handed the core's own environment: without that
 * value, or with the task document, which carries the attempt's bearer; and
 * a push that runs the hook the workspace installed for it.
 */
test("each git a publication runs, and each hook its commit runs, is handed the image's environment and no task document, and its push runs none", async (t) => {
  await inCheckout(async ({ remote, directory, base }) => {
    const recording = await recordingGit(t);
    await git("git", ["config", "core.hooksPath", recording.hooks], {
      cwd: directory,
    });
    await writeFile(join(directory, "provisioned"), "set up\n");
    recording.start();

    await commitAndPushSource({
      task: {
        ticket: 9,
        attempt: "opaque",
        worker: { files: [{ path: "provisioned" }] },
      },
      repositoryId: "chuggy",
      repository: remote,
      base,
      directory,
      command: git,
      environment: workerCredentialEnvironment(
        join(remote, "unread"),
        "x",
        remote,
      ),
      secrets: held,
    });

    const records = await recording.records();
    for (const [label, ...handed] of records)
      assert.deepEqual(handed, handedAsTheImage, label);
    const labels = records.map(([label]) => label);
    for (const expected of [
      "git config",
      "git add",
      "git reset",
      "git commit",
      "pre-commit",
      "git rev-parse",
      "git rev-list",
      "git cat-file",
      "git init",
      "git push",
    ])
      assert.ok(labels.includes(expected), `${expected} was never recorded`);
    assert.ok(
      !labels.includes("pre-push"),
      "the push ran the workspace's hook",
    );
  });
});

/** Where a push runs, and what the repository it is made from holds as git reads it under the push's own environment. */
async function madeHolding(options) {
  const inMade = (args) =>
    git("git", args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", ...options.env },
    });
  const { stdout: configured } = await inMade(["config", "--list"]);
  return {
    where: options.cwd,
    refs: (await inMade(["for-each-ref"])).stdout,
    keys: configured
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(0, line.indexOf("="))),
    alternates: await readFile(
      join(options.env.GIT_DIR, "objects", "info", "alternates"),
      "utf8",
    ),
  };
}

/** How many objects a bare repository holds in packs. */
async function packedObjects(bare) {
  const { stdout } = await git("git", ["count-objects", "-v"], { cwd: bare });
  return Number(/^in-pack: (\d+)$/mu.exec(stdout)[1]);
}

/**
 * Driven by git itself, because what the remote is sent is git's answer to
 * what it advertises. Catches a push from a repository that copied a ref or
 * the workspace's configuration, one that cannot reach the attempt's commit,
 * one that sends the remote objects it already holds, and one under a
 * namespace the pod names, which would land its ref elsewhere.
 */
test("the push is made from a repository holding none of the workspace's refs or configuration, borrowing its objects, and sends only what the remote lacks", async (t) => {
  withoutStandingGitEntries(t);
  await inCheckout(async (checkout) => {
    const { remote, directory } = checkout;
    await git("git", ["push", "--quiet", remote, "HEAD:refs/heads/main"], {
      cwd: directory,
    });
    await git("git", ["config", "receive.unpackLimit", "1"], { cwd: remote });
    await git("git", ["config", "chuggy.workspace", "set"], { cwd: directory });
    await git("git", ["branch", "kept"], { cwd: directory });
    await writeFile(join(directory, "notes.md"), "what the attempt wrote\n");
    let seen;
    const command = async (executable, args, options) => {
      if (gitVerb(args) === "push") seen = await madeHolding(options);
      return git(executable, args, options);
    };

    const source = await commitAndPushSource({
      task: { ticket: 9, attempt: "opaque", worker: {} },
      repositoryId: "chuggy",
      repository: remote,
      base: checkout.base,
      directory,
      command,
      environment: { ...process.env, GIT_NAMESPACE: "elsewhere" },
      secrets: [],
    });

    assert.ok(!within(directory, seen.where), seen.where);
    assert.equal(seen.refs, "");
    assert.deepEqual(
      seen.keys.filter((key) => !key.startsWith("core.")),
      [],
      seen.keys.join(", "),
    );
    assert.equal(seen.alternates, `${join(directory, ".git", "objects")}\n`);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
    assert.equal(
      await packedObjects(remote),
      3,
      "the push sent more than the attempt's commit, its tree and its file",
    );
  });
});

/** The repository on the suite's forge an attempt pushes, and the password the forge accepts for it alone. */
const forgeRig = {
  name: "rig.git",
  password: "ghs_rigWrite0123456789abcdefghijklmn",
};

/**
 * Every way a configuration on this machine could turn the push, each a key
 * and a value reading the witnesses in `room`: a hook, a helper, a proxy, and
 * a rewrite of the URL it is told for its push alone or for every use.
 */
const configuredTurns = {
  hook: (room) => ["core.hooksPath", room.hooks],
  helper: (room) => [
    "credential.helper",
    `!f() { echo "$1" >> '${join(room.marks, "helper")}'; }; f`,
  ],
  proxy: (room) => ["http.proxy", room.proxy],
  pushInsteadOf: (room) => [
    `url.${room.elsewhere}/.pushInsteadOf`,
    `${room.origin}/`,
  ],
  insteadOf: (room) => [`url.${room.elsewhere}/.insteadOf`, `${room.origin}/`],
};

/** `entry` written to the configuration file at `file`. */
async function configuredFile(file, [key, value]) {
  await mkdir(dirname(file), { recursive: true });
  await git("git", ["config", "--file", file, key, value]);
}

/**
 * Each place an entry can be written for git to read it: each writes `entry`
 * there for `checkout`, its files under `room`, and answers what the push's
 * environment holds for git to find it.
 */
const configuredPlaces = {
  "the workspace's configuration": async (checkout, _room, [key, value]) => {
    await git("git", ["config", key, value], { cwd: checkout.directory });
    return {};
  },
  "the workspace's own hooks directory": async (checkout, room) => {
    await copyFile(
      join(room.hooks, "pre-push"),
      join(checkout.directory, ".git", "hooks", "pre-push"),
    );
    return {};
  },
  $HOME: async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "home", ".gitconfig"), entry);
    return { HOME: join(room.root, "home") };
  },
  $XDG_CONFIG_HOME: async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "xdg", "git", "config"), entry);
    return { XDG_CONFIG_HOME: join(room.root, "xdg") };
  },
  "the system's configuration": async (_checkout, room, entry) => {
    await configuredFile(join(room.root, "system"), entry);
    return { GIT_CONFIG_SYSTEM: join(room.root, "system") };
  },
  "the image's environment": async (_checkout, _room, [key, value]) => ({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: value,
  }),
};

/** A witness that records each connection made to it and ends it unanswered, as a proxy the push used would be reached. */
async function proxyWitness(t) {
  const reached = [];
  const server = createServer((socket) => {
    reached.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((listening) => {
    server.listen(0, "127.0.0.1", () => listening(undefined));
  });
  t.after(() => new Promise((closed) => server.close(() => closed(undefined))));
  return { url: `http://127.0.0.1:${String(server.address().port)}`, reached };
}

/**
 * The forge an attempt pushes, the proxy witness, the askpass as an image
 * installs it, and the credential file it reads, until `t` ends.
 */
async function forgeBench(t) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-push-turns-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forge = await forgeServed(t, [forgeRig.name]);
  forge.accept(forgeRig.name, forgeRig.password);
  const askpass = join(root, "git-askpass.sh");
  await copyFile(
    fileURLToPath(new URL("./git-askpass.sh", import.meta.url)),
    askpass,
  );
  await chmod(askpass, 0o555);
  const token = join(root, "token");
  await writeFile(token, `${forgeRig.password}\n`);
  return { root, forge, proxy: await proxyWitness(t), askpass, token };
}

/**
 * The room one push's witnesses are kept in: a hooks directory whose
 * pre-push marks that it ran, an empty directory of marks, and the repository
 * a rewritten URL would reach in place of the forge's.
 */
async function witnessRoom(bench) {
  const root = await mkdtemp(join(bench.root, "room-"));
  const room = {
    root,
    hooks: join(root, "hooks"),
    marks: join(root, "marks"),
    elsewhere: join(root, "elsewhere"),
    origin: bench.forge.origin,
    proxy: bench.proxy.url,
  };
  await mkdir(room.hooks);
  await mkdir(room.marks);
  const hook = join(room.hooks, "pre-push");
  await writeFile(
    hook,
    `#!/bin/sh\necho ran >> '${join(room.marks, "pre-push")}'\n`,
  );
  await chmod(hook, 0o755);
  await git("git", [
    "init",
    "--quiet",
    "--bare",
    join(room.elsewhere, forgeRig.name),
  ]);
  return room;
}

/**
 * Asserts one attempt published from `checkout` to the forge, its push handed
 * the askpass environment and `placed` beside it, reached the forge alone,
 * ran no hook, asked no helper and used no proxy.
 */
async function assertPushedUnturned(bench, room, { checkout, placed, label }) {
  const url = bench.forge.url(forgeRig.name);
  const source = await commitAndPushSource({
    task: { ticket: 9, attempt: label, worker: {} },
    repositoryId: "chuggy",
    repository: url,
    base: checkout.base,
    directory: checkout.directory,
    command: git,
    environment: {
      ...workerCredentialEnvironment(bench.token, "x-access-token", url),
      GIT_ASKPASS: bench.askpass,
      ...placed,
    },
    secrets: [],
    pause: async () => undefined,
  }).catch((failure) => failure);

  assert.ok(!(source instanceof Error), `${label}: ${String(source.message)}`);
  const { stdout } = await git("git", ["rev-parse", source.ref], {
    cwd: bench.forge.bare(forgeRig.name),
  });
  assert.equal(stdout.trim(), source.commit, label);
  assert.deepEqual(await readdir(room.marks), [], label);
  assert.deepEqual(bench.proxy.reached, [], label);
  assert.equal(
    await remoteRefs(join(room.elsewhere, forgeRig.name)),
    "",
    label,
  );
}

/**
 * Catches a push that reads any configuration but the core's own, in any of
 * the places git looks for one, or hands the image's entries the last word on
 * its hooks and helpers: each would run the hook, ask the helper, reach the
 * proxy or push where the rewrite says.
 */
for (const [turn, places] of [
  ["hook", Object.keys(configuredPlaces)],
  [
    "helper",
    Object.keys(configuredPlaces).filter((place) => !place.includes("hooks")),
  ],
  ...["proxy", "pushInsteadOf", "insteadOf"].map((named) => [
    named,
    Object.keys(configuredPlaces).filter(
      (place) => !place.includes("hooks") && !place.includes("image"),
    ),
  ]),
])
  test(`a push is turned by no ${turn} the workspace or this machine configures${places.some((place) => place.includes("image")) ? ", or the image's environment names" : ""}`, async (t) => {
    const bench = await forgeBench(t);
    for (const place of places)
      await inCheckout(async (checkout) => {
        const room = await witnessRoom(bench);
        const placed = await configuredPlaces[place](
          checkout,
          room,
          configuredTurns[turn](room),
        );

        await assertPushedUnturned(bench, room, {
          checkout,
          placed,
          label: `${turn} in ${place}`,
        });
      });
  });

/** `git cat-file --batch` output for blobs of these contents. */
function catFileOutput(...contents) {
  return Buffer.concat(
    contents.map((content, index) =>
      Buffer.from(
        `${String(index).repeat(40)} blob ${String(Buffer.byteLength(content))}\n${content}\n`,
      ),
    ),
  );
}

/** What a reader answers for `output` fed in chunks cut at `cuts`. */
function readInChunks(output, cuts) {
  const reader = sourceSecretReader(held);
  const bounds = [0, ...cuts, output.length];
  for (let index = 1; index < bounds.length; index += 1) {
    const found = reader.read(
      output.subarray(bounds[index - 1], bounds[index]),
    );
    if (found !== undefined) return found;
  }
  reader.end();
  return undefined;
}

/**
 * Chunks are where a pipe cuts them, never where an object does. Catches a
 * secret lost at a chunk boundary, and the opposite: two objects whose ends
 * meet to spell one.
 */
test("a secret is found across the chunks of one object and never across two objects", () => {
  const secret = held[0].value;
  const half = Math.floor(secret.length / 2);
  const whole = catFileOutput(`before ${secret} after`);
  const cut = whole.indexOf(secret) + half;
  for (const cuts of [[cut], [3, cut, cut + 1]])
    assert.equal(
      readInChunks(whole, cuts)?.kind,
      held[0].kind,
      `cut at ${cuts}`,
    );

  const apart = catFileOutput(secret.slice(0, half), secret.slice(half));
  for (let cut = 1; cut < apart.length; cut += 1)
    assert.equal(readInChunks(apart, [cut]), undefined, `cut at ${cut}`);
});

test("every worker report uses the schema that carries its summary", () => {
  assert.equal(
    resultDocument({ verdict: "Fail", report: "failed" }).version,
    3,
  );
  assert.equal(
    resultDocument({
      verdict: "Pass",
      report: "passed",
      source: { repository: "chuggy" },
    }).version,
    3,
  );
});

/** The attempt the checkpoint suites stand for. */
const checkpointTask = { ticket: 9, attempt: "opaque", worker: {} };

/** The branch every checkpoint of that task lands on. */
const checkpointRef = ticketCheckpoint(checkpointTask);

/** The run in `checkout` kept as its ticket's checkpoint, by git itself. */
function checkpointFrom({ remote, directory, base }, more = {}) {
  return checkpointAndPushSource({
    task: checkpointTask,
    repository: remote,
    base,
    directory,
    command: git,
    environment: process.env,
    secrets: held,
    ...more,
  });
}

/** What `args` ask of git, past the `-c` options leading them. */
function gitAsked(args) {
  return args.slice(
    args.findIndex((arg, at) => arg !== "-c" && args[at - 1] !== "-c"),
  );
}

/** What git prints for `args` in `directory`, without its last newline. */
async function gitSays(directory, ...args) {
  const { stdout } = await git("git", args, { cwd: directory });
  return stdout.trimEnd();
}

/**
 * What `directory`'s repository is at rest: `HEAD`, the state of its tree and
 * index, and who it says commits are by. A checkpoint is taken in the middle of
 * a run, so none of it may move.
 */
async function atRest(directory) {
  return {
    head: await headOf(directory),
    status: await gitSays(directory, "status", "--porcelain=v1"),
    index: await gitSays(directory, "ls-files", "--stage"),
    config: await gitSays(directory, "config", "--local", "--list"),
  };
}

/**
 * What a next attempt starts from: `remote` cloned as an attempt's workspace
 * is, so a checkpoint is a remote-tracking ref, at `base`. Its `base` is on the
 * remote, as a real target always is.
 */
async function nextClone({ remote, directory, base }, name = "next") {
  await git("git", ["push", remote, `${base}:refs/heads/main`], {
    cwd: directory,
  });
  const clone = join(dirname(directory), name);
  await git("git", ["clone", "--quiet", "--no-checkout", remote, clone]);
  await git("git", ["checkout", "--quiet", "--detach", base], { cwd: clone });
  return clone;
}

/** The checkpoint a next attempt finds in `clone` restored, by git itself. */
function restoredIn(clone, base, command = git) {
  return sourceCheckpointRestored({
    task: checkpointTask,
    base,
    directory: clone,
    command,
  });
}

/**
 * Catches a checkpoint that moves `HEAD`, the index or the repository's
 * configuration: a run resumed after a hold would find its history changed
 * under it, and its own next commit would carry the worker's name.
 */
test("a checkpoint keeps everything the tree holds and moves nothing", async () => {
  await inCheckout(async (checkout) => {
    const { remote, directory } = checkout;
    await writeFile(join(directory, "README.md"), "# half rewritten\n");
    await writeFile(join(directory, "staged"), "staged\n");
    await git("git", ["add", "staged"], { cwd: directory });
    await writeFile(join(directory, "untracked"), "untracked\n");
    const before = await atRest(directory);

    const kept = await checkpointFrom(checkout);

    assert.deepEqual(await atRest(directory), before);
    assert.equal(kept.ref, checkpointRef);
    assert.match(await remoteRefs(remote), new RegExp(`${kept.ref}$`, "mu"));
    assert.equal(await gitSays(remote, "rev-parse", kept.ref), kept.commit);
    assert.equal(
      await gitSays(remote, "rev-parse", `${kept.commit}^`),
      before.head,
    );
    assert.equal(
      await gitSays(remote, "show", `${kept.commit}:README.md`),
      "# half rewritten",
    );
    assert.equal(
      await gitSays(remote, "show", `${kept.commit}:staged`),
      "staged",
    );
    assert.equal(
      await gitSays(remote, "show", `${kept.commit}:untracked`),
      "untracked",
    );
    assert.equal(
      await gitSays(remote, "log", "-1", "--format=%an %ae", kept.commit),
      "Chuggy Worker worker@chuggy.invalid",
    );
  });
});

/**
 * Catches a name read from the process's environment, which git prefers to any
 * configuration: a host runner's shell can export one, and `git commit` exports
 * its own to a hook.
 */
test("a checkpoint carries the worker's name whatever the environment names", async (t) => {
  const given = process.env["GIT_AUTHOR_NAME"];
  process.env["GIT_AUTHOR_NAME"] = "Someone Else";
  t.after(() => {
    if (given === undefined) delete process.env["GIT_AUTHOR_NAME"];
    else process.env["GIT_AUTHOR_NAME"] = given;
  });
  await inCheckout(async (checkout) => {
    await writeFile(join(checkout.directory, "work.txt"), "work\n");

    const kept = await checkpointFrom(checkout);

    assert.equal(
      await gitSays(checkout.remote, "log", "-1", "--format=%an", kept.commit),
      "Chuggy Worker",
    );
  });
});

/**
 * The agent's own commits are on `HEAD`, and a pass whose commit landed there
 * and whose push failed leaves a tree with nothing else in it, so reading a
 * clean tree as nothing to keep would lose the whole of the work.
 */
test("a clean tree past its base is kept, since its commits are on no remote", async () => {
  await inCheckout(async (checkout) => {
    const { remote, directory } = checkout;
    const committed = await agentCommitted(directory, "work", "the work\n");

    const kept = await checkpointFrom(checkout);

    assert.equal(
      await gitSays(remote, "rev-parse", `${kept.commit}^`),
      committed,
    );
    assert.equal(
      await gitSays(remote, "show", `${kept.commit}:work`),
      "the work",
    );
  });
});

test("a tree and a head that are still the base's leave nothing to keep and push nothing", async () => {
  await inCheckout(async (checkout) => {
    assert.equal(await checkpointFrom(checkout), undefined);
    assert.equal(await remoteRefs(checkout.remote), "");
  });
});

test("a file only the attempt's block provisioned is nothing to keep", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, ".provisioned"), "from the block\n");
    const task = {
      ...checkpointTask,
      worker: {
        files: [{ path: ".provisioned", content: "from the block\n" }],
      },
    };

    assert.equal(await checkpointFrom(checkout, { task }), undefined);
    assert.equal(await remoteRefs(remote), "");
  });
});

test("a checkpoint leaves out what the attempt's block provisioned", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, ".provisioned"), "from the block\n");
    await writeFile(join(directory, "work"), "the work\n");
    const task = {
      ...checkpointTask,
      worker: {
        files: [{ path: ".provisioned", content: "from the block\n" }],
      },
    };

    const { commit } = await checkpointFrom(checkout, { task });

    assert.equal(
      await gitSays(remote, "ls-tree", "--name-only", commit),
      ["README.md", "work"].join("\n"),
    );
  });
});

/**
 * Starting from an empty index would drop a tracked file a project's
 * `.gitignore` also matches, which `git add --all` never adds back, and the
 * next attempt would read that as a deletion.
 */
test("a checkpoint keeps a tracked file the project also ignores", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, ".gitignore"), "ignored\n");
    await writeFile(join(directory, "ignored"), "tracked anyway\n");
    await git("git", ["add", "--force", ".gitignore", "ignored"], {
      cwd: directory,
    });

    const { commit } = await checkpointFrom(checkout);

    assert.equal(
      await gitSays(remote, "show", `${commit}:ignored`),
      "tracked anyway",
    );
  });
});

/** Half-done work is what a project's hooks refuse, and they must not decide whether it is kept. */
test("a checkpoint runs no hook of the project's", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    const hooks = join(dirname(directory), "hooks");
    await mkdir(hooks);
    for (const hook of [
      "pre-commit",
      "commit-msg",
      "post-commit",
      "pre-push",
    ]) {
      await writeFile(join(hooks, hook), "#!/bin/sh\nexit 1\n");
      await chmod(join(hooks, hook), 0o755);
    }
    await git("git", ["config", "core.hooksPath", hooks], { cwd: directory });
    await writeFile(join(directory, "work"), "the work\n");

    const kept = await checkpointFrom(checkout);

    assert.equal(await gitSays(remote, "rev-parse", kept.ref), kept.commit);
  });
});

test("a checkpoint made under a relative temporary directory is still made", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    const saved = process.env.TMPDIR;
    const cwd = process.cwd();
    process.chdir(dirname(directory));
    process.env.TMPDIR = ".";
    try {
      const kept = await checkpointFrom(checkout);
      assert.equal(await gitSays(remote, "rev-parse", kept.ref), kept.commit);
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

test("a checkpoint leaves nothing behind where it built its index", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    const temporary = join(dirname(directory), "temporary");
    await mkdir(temporary);
    await writeFile(join(directory, "work"), "the work\n");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      await checkpointFrom(checkout);
      assert.deepEqual(
        (await readdir(temporary)).filter((name) =>
          name.startsWith("chuggy-checkpoint-"),
        ),
        [],
      );
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

/** A checkpoint is pushed where any later reader of the forge can see it, so what a candidate may not carry it may not either. */
test("a checkpoint carrying a held secret is refused, naming the kind and never the value", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, "leaked"), `${held[0].value}\n`);

    await assert.rejects(checkpointFrom(checkout), (failure) => {
      assert.match(failure.message, /carries the Claude Code credential/u);
      assert.ok(!failure.message.includes(held[0].value));
      return true;
    });

    assert.equal(await remoteRefs(remote), "");
    assert.equal(
      await gitSays(directory, "for-each-ref", "refs/remotes/origin/chuggy"),
      "",
    );
  });
});

test("a secret in a commit under a clean tree is refused as well", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await agentCommitted(directory, "leaked", `${held[1].value}\n`);

    await assert.rejects(checkpointFrom(checkout), /carries /u);

    assert.equal(await remoteRefs(remote), "");
  });
});

/**
 * A second attempt that gave up on the first's history leaves a checkpoint that
 * does not descend from the last. Catches a push that is not forced, which
 * would lose the newer work to the older.
 */
test("a checkpoint replaces the last, whatever history it is on", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote, base } = checkout;
    await agentCommitted(directory, "first", "the first run's\n");
    await checkpointFrom(checkout);
    await git("git", ["reset", "--quiet", "--hard", base], { cwd: directory });
    await agentCommitted(directory, "second", "the second run's\n");

    const { commit } = await checkpointFrom(checkout);

    assert.equal(await gitSays(remote, "rev-parse", checkpointRef), commit);
  });
});

/**
 * Attempt two restores the checkpoint, rewrites the history below its base and
 * fails. Restore ignores what that leaves, and the push is forced, so pushing
 * it would lose the checkpoint attempt three could have started from.
 */
test("a checkpoint no attempt could start from does not replace one it could", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote, base } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    const kept = await checkpointFrom(checkout);
    await git("git", [...author, "commit", "--amend", "-m", "rewritten"], {
      cwd: directory,
    });

    await assert.rejects(
      checkpointFrom(checkout),
      new RegExp(`does not descend from ${base}`, "u"),
    );

    assert.equal(
      await gitSays(remote, "rev-parse", checkpointRef),
      kept.commit,
    );
  });
});

/** The checkpoint is taken during a hold, and the run may pass after it: the attempt's own push, not forced, must still land. */
test("a run that passes after a checkpoint pushes its candidate as it would have", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, "work"), "half\n");
    await checkpointFrom(checkout);
    await writeFile(join(directory, "work"), "done\n");

    const { source } = await publishedFrom(checkout);

    assert.equal(
      await gitSays(remote, "show", `${source.commit}:work`),
      "done",
    );
    assert.notEqual(
      await gitSays(remote, "rev-parse", checkpointRef),
      source.commit,
    );
  });
});

test("the checkpoint is one branch a ticket's attempts share, apart from each attempt's own", () => {
  assert.equal(
    ticketCheckpoint({ ticket: 9, attempt: "another" }),
    "refs/heads/chuggy/tickets/9/checkpoint",
  );
  assert.ok(!ticketBranch(checkpointTask).endsWith("/checkpoint"));
});

/**
 * Catches a restore that leaves the checkpoint's commit in history, which the
 * next candidate would carry, or the work staged, which the agent did not stage
 * and a `git commit` of its own would sweep up.
 */
test("a restored checkpoint is its parent's history with the rest unstaged in the tree", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    const committed = await agentCommitted(directory, "committed", "kept\n");
    await writeFile(join(directory, "README.md"), "# half rewritten\n");
    await writeFile(join(directory, "untracked"), "half\n");
    const kept = await checkpointFrom(checkout);
    const clone = await nextClone(checkout);

    assert.deepEqual(await restoredIn(clone, base), kept);

    assert.equal(await headOf(clone), committed);
    assert.equal(
      await readFile(join(clone, "README.md"), "utf8"),
      "# half rewritten\n",
    );
    assert.equal(await readFile(join(clone, "committed"), "utf8"), "kept\n");
    assert.equal(
      await gitSays(clone, "status", "--porcelain=v1"),
      " M README.md\n?? untracked",
    );
  });
});

test("a file the run deleted is deleted again", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await rm(join(directory, "README.md"));
    await writeFile(join(directory, "work"), "the work\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);

    await restoredIn(clone, base);

    assert.ok(!(await present(join(clone, "README.md"))));
  });
});

/** What a pass whose push failed leaves: nothing unstaged, everything in a commit the next attempt must start on. */
test("a checkpoint of a clean tree restores to its commits, with the work in the tree", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    const committed = await agentCommitted(directory, "work", "the work\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);

    await restoredIn(clone, base);

    assert.equal(await headOf(clone), committed);
    assert.equal(await readFile(join(clone, "work"), "utf8"), "the work\n");
    assert.equal(await gitSays(clone, "status", "--porcelain=v1"), "");
  });
});

test("a clone with no checkpoint is left as it was", async () => {
  await inCheckout(async (checkout) => {
    const { base } = checkout;
    const clone = await nextClone(checkout);

    assert.equal(await restoredIn(clone, base), undefined);

    assert.equal(await headOf(clone), base);
  });
});

/**
 * A rework runs on a result the old checkpoint never reached, so its parent
 * does not descend from the new base. Catches that old work being laid over
 * the base it was not made on.
 */
test("a checkpoint that does not descend from the base is ignored", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "stale"), "the old run's\n");
    await checkpointFrom(checkout);
    await git("git", ["checkout", "--quiet", "--detach", base], {
      cwd: directory,
    });
    const moved = await agentCommitted(directory, "newer", "the new base\n");
    const clone = await nextClone({ ...checkout, base: moved });

    assert.equal(await restoredIn(clone, moved), undefined);

    assert.equal(await headOf(clone), moved);
    assert.ok(!(await present(join(clone, "stale"))));
  });
});

/** Setup's edit to a tracked file was made on the base, and the checkpoint already holds what the run made of it. */
test("what the checkpoint holds outranks what setup left in the tree", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "README.md"), "# the run's\n");
    await writeFile(join(directory, "added"), "the run's\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    await writeFile(join(clone, "README.md"), "# setup's\n");
    await writeFile(join(clone, "added"), "setup's\n");

    await restoredIn(clone, base);

    assert.equal(
      await readFile(join(clone, "README.md"), "utf8"),
      "# the run's\n",
    );
    assert.equal(await readFile(join(clone, "added"), "utf8"), "the run's\n");
  });
});

/** `git` for the suites, raising `failure` for the one verb it fails. */
function gitFailingAt(verb, failure) {
  return async (program, args, options) => {
    if (gitAsked(args)[0] === verb) throw failure;
    return git(program, args, options);
  };
}

/** Catches a failed restore that leaves half of a checkpoint under an attempt told it starts from its base. */
test("a restore that fails partway raises with the workspace at its base", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "README.md"), "# half rewritten\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    const failure = new Error("reset failed");
    const failing = async (program, args, options) => {
      if (gitAsked(args).slice(0, 2).join(" ") === "reset --mixed")
        throw failure;
      return git(program, args, options);
    };

    await assert.rejects(restoredIn(clone, base, failing), failure);

    assert.equal(await headOf(clone), base);
    assert.equal(await gitSays(clone, "status", "--porcelain=v1"), "");
  });
});

/** `command`, with `read-tree` stopping as git does: what it wrote left behind, in no index. */
function stoppedPartway(clone, failure) {
  return async (program, args, options) => {
    if (gitAsked(args)[0] !== "read-tree") return git(program, args, options);
    await writeFile(join(clone, "written"), "half\n");
    await mkdir(join(clone, "made"));
    await writeFile(join(clone, "made", "written"), "half\n");
    await writeFile(join(clone, "README.md"), "# half\n");
    throw failure;
  };
}

/** Catches what a stopped `read-tree` wrote left in a tree the attempt is told is its base. */
test("a restore stopped partway removes what it wrote, which no index knows of", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    const failure = new Error("read-tree stopped");
    const before = await readFile(join(clone, "README.md"), "utf8");

    await assert.rejects(
      restoredIn(clone, base, stoppedPartway(clone, failure)),
      failure,
    );

    assert.equal(await headOf(clone), base);
    assert.equal(await gitSays(clone, "status", "--porcelain=v1"), "");
    assert.deepEqual((await readdir(clone)).sort(), [".git", "README.md"]);
    assert.equal(await readFile(join(clone, "README.md"), "utf8"), before);
  });
});

/** Setup's own files are excluded from the work, so putting the tree back must leave them too. */
test("a restore stopped partway leaves what setup excluded", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    await writeFile(join(clone, ".git", "info", "exclude"), "provisioned\n");
    await writeFile(join(clone, "provisioned"), "setup's\n");
    const failure = new Error("read-tree stopped");

    await assert.rejects(
      restoredIn(clone, base, stoppedPartway(clone, failure)),
      failure,
    );

    assert.equal(
      await readFile(join(clone, "provisioned"), "utf8"),
      "setup's\n",
    );
  });
});

/** Each way a workspace can fail to come back, none of which the attempt may run on. */
const putBackFailures = [
  [
    "its reset fails",
    async (args) => {
      if (gitAsked(args).slice(0, 2).join(" ") === "reset --hard")
        throw new Error("reset failed");
    },
  ],
  [
    "its clean fails",
    async (args) => {
      if (gitAsked(args)[0] === "clean") throw new Error("clean failed");
    },
  ],
  ["its clean does nothing", async (args) => gitAsked(args)[0] === "clean"],
];

/** Catches an attempt run on a tree nothing can vouch for, or a clean-up that exits clean and removed nothing. */
for (const [how, broken] of putBackFailures)
  test(`a restore whose clean-up cannot finish is the setup step's failure, where ${how}`, async () => {
    await inCheckout(async (checkout) => {
      const { directory, base } = checkout;
      await writeFile(join(directory, "work"), "the work\n");
      await checkpointFrom(checkout);
      const clone = await nextClone(checkout);
      const stopped = stoppedPartway(clone, new Error("read-tree stopped"));
      const command = async (program, args, options) =>
        (await broken(args)) === true
          ? { stdout: "", stderr: "" }
          : stopped(program, args, options);

      await assert.rejects(
        restoredIn(clone, base, command),
        (failure) =>
          failure instanceof RunStepFailure &&
          failure.evidence === runSetupFailed,
      );
    });
  });

/** Nothing about a failure to look can have changed the tree, so nothing is reset. */
test("a restore that fails before it writes leaves what setup left", async () => {
  await inCheckout(async (checkout) => {
    const { directory, base } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    await writeFile(join(clone, "README.md"), "# setup's\n");
    const failure = new Error("for-each-ref failed");

    await assert.rejects(
      restoredIn(clone, base, gitFailingAt("for-each-ref", failure)),
      failure,
    );

    assert.equal(
      await readFile(join(clone, "README.md"), "utf8"),
      "# setup's\n",
    );
  });
});

/** The checkpoint `directory`'s own clone can see, deleted from `remote`. */
function seenIn({ directory }, command = git) {
  return sourceCheckpointSeen({
    task: checkpointTask,
    directory,
    command,
  });
}

/** Catches a checkpoint this clone's own attempt left going unseen, so it is never deleted. */
test("a checkpoint is deleted from its remote by the clone that kept it", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote } = checkout;
    await writeFile(join(directory, "work"), "the work\n");
    const kept = await checkpointFrom(checkout);
    assert.match(await remoteRefs(remote), new RegExp(`${kept.ref}$`, "mu"));

    const checkpoint = await seenIn(checkout);
    assert.deepEqual(checkpoint, kept);
    await sourceCheckpointDeleted({
      checkpoint,
      repository: remote,
      directory,
      command: git,
      environment: { PATH: process.env.PATH ?? "" },
    });

    assert.doesNotMatch(await remoteRefs(remote), new RegExp(kept.ref, "u"));
  });
});

/** Catches a ticket with no checkpoint reaching a remote to say so. */
test("a clone that sees no checkpoint pushes nothing", async () => {
  await inCheckout(async (checkout) => {
    const verbs = [];
    const command = async (program, args, options) => {
      verbs.push(args[0]);
      return git(program, args, options);
    };

    assert.equal(await seenIn(checkout, command), undefined);

    assert.deepEqual(verbs, ["for-each-ref"]);
  });
});

/** Catches a secret check that runs on past the bound on what it is part of. */
test("a checkpoint's secret check stops with its signal", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    await writeFile(join(directory, "work"), "the work\n");

    await assert.rejects(
      checkpointFrom(checkout, {
        secrets: [{ kind: "the bearer", value: "unfound" }],
        signal: globalThis.AbortSignal.abort(),
      }),
      /git rev-list exited null/u,
    );
  });
});

/**
 * The last link of the whole: an attempt restored from a checkpoint and then
 * passing. Catches a candidate that does not descend from the base, one that
 * carries the checkpoint's own commit, and an agent's own commits lost.
 */
test("an attempt restored from a checkpoint pushes a candidate on its base with the work in it", async () => {
  await inCheckout(async (checkout) => {
    const { directory, remote, base } = checkout;
    const committed = await agentCommitted(directory, "committed", "kept\n");
    await writeFile(join(directory, "untracked"), "half\n");
    const kept = await checkpointFrom(checkout);
    const clone = await nextClone(checkout);
    await restoredIn(clone, base);

    const { source } = await publishedFrom({
      remote,
      directory: clone,
      base,
    });

    assert.equal(
      await gitSays(remote, "show", `${source.commit}:untracked`),
      "half",
    );
    const history = await gitSays(remote, "rev-list", source.commit);
    assert.ok(history.includes(committed));
    assert.ok(history.includes(base));
    assert.ok(!history.includes(kept.commit));
  });
});

test("a briefing is told what an earlier attempt left, and is as it was where nothing was restored", () => {
  const task = { briefing: { text: "the brief", purpose: "Work" } };

  assert.equal(sourceRestoredBriefed(task, undefined), task);
  const briefed = sourceRestoredBriefed(task, {
    ref: checkpointRef,
    commit: "abc",
  });
  assert.equal(briefed.briefing.purpose, "Work");
  assert.match(
    briefed.briefing.text,
    /^the brief\n\n## Unfinished work from an earlier attempt\n/u,
  );
  assert.match(briefed.briefing.text, /unstaged/u);
  assert.equal(task.briefing.text, "the brief");
});

/**
 * Hooks of the project's in the clone at `directory`, each refusing what it is
 * asked. Answers the file each one that runs is named in.
 */
async function hooksRefusing(directory) {
  const hooks = join(directory, ".git", "hooks");
  const ran = join(directory, ".git", "hooks-ran");
  await mkdir(hooks, { recursive: true });
  for (const hook of [
    "post-index-change",
    "reference-transaction",
    "monitor",
  ]) {
    await writeFile(
      join(hooks, hook),
      `#!/bin/sh\necho ${hook} >> '${ran}'\nexit 1\n`,
    );
    await chmod(join(hooks, hook), 0o755);
  }
  await git("git", ["config", "core.fsmonitor", join(hooks, "monitor")], {
    cwd: directory,
  });
  return ran;
}

/** A clone with the project's hooks in it, of `checkout` once a checkpoint holds `work`. */
async function hookedCloneOfCheckpoint(checkout) {
  await writeFile(join(checkout.directory, "work"), "the work\n");
  await checkpointFrom(checkout);
  const clone = await nextClone(checkout);
  return { clone, ran: await hooksRefusing(clone) };
}

/** Catches a hook reaching the git of a keep, where one that refuses loses the work. */
test("no hook of the project's runs for a checkpoint", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(join(checkout.directory, "work"), "the work\n");
    const ran = await hooksRefusing(checkout.directory);

    const kept = await checkpointFrom(checkout);

    assert.equal(kept.ref, checkpointRef);
    await assert.rejects(stat(ran), { code: "ENOENT" });
    assert.ok((await remoteRefs(checkout.remote)).includes(checkpointRef));
  });
});

/** Catches a hook reaching the git of a restore, where one that refuses loses the start. */
test("no hook of the project's runs for a restore", async () => {
  await inCheckout(async (checkout) => {
    const { clone, ran } = await hookedCloneOfCheckpoint(checkout);

    await restoredIn(clone, checkout.base);

    await assert.rejects(stat(ran), { code: "ENOENT" });
    assert.equal(await readFile(join(clone, "work"), "utf8"), "the work\n");
  });
});

/** Catches a hook refusing the reset that puts a stopped restore back, which is the attempt's failure. */
test("no hook of the project's runs putting a stopped restore back", async () => {
  await inCheckout(async (checkout) => {
    const { clone, ran } = await hookedCloneOfCheckpoint(checkout);
    const failure = new Error("read-tree stopped");

    await assert.rejects(
      restoredIn(clone, checkout.base, stoppedPartway(clone, failure)),
      failure,
    );

    await assert.rejects(stat(ran), { code: "ENOENT" });
    assert.equal(await headOf(clone), checkout.base);
  });
});
