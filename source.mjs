import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resultManifestSchemaVersion } from "@chuggy/worker-contract/workerDocuments";

import {
  workerEnvironmentWithout,
  workerStageEnvironment,
  workerTemporaryFile,
} from "./checks.mjs";
import { gitFailureLine, gitRemoteTried } from "./gitRemote.mjs";
import {
  runCommitFailed,
  runPushFailed,
  runSetupFailed,
  runStep,
} from "./runEvidence.mjs";

/** Longer than any header `git cat-file --batch` writes: a name, a type and a size. */
const sourceObjectHeaderBytesMax = 256;

/** How much of a git child's standard error a failed secret check reports. */
const sourceCheckStderrCharsMax = 4_096;

/** Where in a commit each kind of object holds what it carries. */
const sourceObjectPlaces = new Map([
  ["commit", "its message"],
  ["tree", "a path"],
  ["blob", "a file"],
]);

/** What the directory a push is made from is named by, under the temporary directory. */
const sourcePushPrefix = "chuggy-push-";

/** What the directory a checkpoint's index is built in is named by, there too. */
const sourceCheckpointPrefix = "chuggy-checkpoint-";

/** Who the commits this core makes are by. */
const sourceAuthorName = "Chuggy Worker";
const sourceAuthorEmail = "worker@chuggy.invalid";

/** A checkpoint's name, in the variables git prefers to any configuration. */
const sourceCheckpointIdentity = {
  GIT_AUTHOR_NAME: sourceAuthorName,
  GIT_AUTHOR_EMAIL: sourceAuthorEmail,
  GIT_COMMITTER_NAME: sourceAuthorName,
  GIT_COMMITTER_EMAIL: sourceAuthorEmail,
};

/** The object format a commit's name is in, read from how long the name is. */
const sourceObjectFormats = new Map([
  [40, "sha1"],
  [64, "sha256"],
]);

/**
 * The variables that place a repository, which the push's environment is
 * cleared of so that the repository it uses is the one the core made: each
 * that git names local to a repository (`git rev-parse --local-env-vars`)
 * but the two carrying configuration entries, which git itself carries into
 * another repository it runs in; and the namespace refs are read under.
 */
export const sourcePushPlacingVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

export function ticketBranch(task) {
  const attempt = createHash("sha256").update(task.attempt).digest("hex");
  return `refs/heads/chuggy/tickets/${String(task.ticket)}/attempts/${attempt}`;
}

/** The branch a ticket's unfinished work is kept on, whichever attempt left it. */
export function ticketCheckpoint(task) {
  return `refs/heads/chuggy/tickets/${String(task.ticket)}/checkpoint`;
}

export function resultDocument(manifest) {
  return { version: resultManifestSchemaVersion, ...manifest };
}

/** One `git cat-file --batch` header, or a refusal where git could not read the object. */
function sourceObjectHeader(line) {
  const [name, type, size] = line.split(" ");
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(`git could not read ${name} to check the push for secrets`);
  return { name, type, remaining: bytes, tail: Buffer.alloc(0) };
}

/**
 * A reader over `git cat-file --batch` output, fed its chunks in order, that
 * answers the first held secret an object carries: its kind, the commit that
 * first reaches the object, and where in that commit it sits. Objects arrive
 * in commit order, each commit before the trees and blobs it is the first to
 * reference. Each chunk is searched with the tail of the object's previous
 * one, so a secret split between two chunks is still found.
 */
export function sourceSecretReader(secrets) {
  const needles = secrets.map(({ kind, value }) => {
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`${kind} is no value a push can be checked for`);
    return { kind, bytes: Buffer.from(value, "utf8") };
  });
  const tailBytes = Math.max(
    0,
    ...needles.map(({ bytes }) => bytes.length - 1),
  );
  let pending = Buffer.alloc(0);
  let object;
  let commit;
  return {
    read(chunk) {
      let rest = chunk;
      while (rest.length > 0) {
        if (object === undefined) {
          const end = rest.indexOf(0x0a);
          const header = Buffer.concat([
            pending,
            end === -1 ? rest : rest.subarray(0, end),
          ]);
          if (header.length > sourceObjectHeaderBytesMax)
            throw new Error("git cat-file wrote a header no object has");
          if (end === -1) {
            pending = header;
            return undefined;
          }
          pending = Buffer.alloc(0);
          rest = rest.subarray(end + 1);
          object = sourceObjectHeader(header.toString("latin1"));
          if (object.type === "commit") commit = object.name;
        } else if (object.remaining > 0) {
          const taken = rest.subarray(0, object.remaining);
          rest = rest.subarray(taken.length);
          object.remaining -= taken.length;
          const window = Buffer.concat([object.tail, taken]);
          const found = needles.find(({ bytes }) => window.includes(bytes));
          if (found !== undefined)
            return {
              kind: found.kind,
              commit,
              place: sourceObjectPlaces.get(object.type) ?? object.type,
            };
          object.tail = window.subarray(
            window.length - Math.min(tailBytes, window.length),
          );
        } else {
          if (rest[0] !== 0x0a)
            throw new Error("git cat-file wrote an object past its size");
          rest = rest.subarray(1);
          object = undefined;
        }
      }
      return undefined;
    },
    end() {
      if (object !== undefined || pending.length > 0)
        throw new Error("git cat-file stopped inside an object");
    },
  };
}

/** How one git child exited, with the head of what it wrote to standard error. */
function sourceGitExited(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text.slice(0, sourceCheckStderrCharsMax - stderr.length);
  });
  return new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ code: null, stderr: error.message }),
    );
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * The first held secret any object the push adds carries, or nothing: every
 * object reachable from `head` and not from `base`, which the remote already
 * has, read raw. So a commit's message, a tree's names and a file's bytes are
 * all searched, and a secret one commit adds and a later one removes is still
 * found. Replacement refs are ignored, as the push ignores them, so what is
 * read is what would be sent.
 */
async function sourceSecretCarried(directory, base, head, secrets, signal) {
  const git = (args, input) =>
    spawn("git", ["--no-replace-objects", ...args], {
      cwd: directory,
      env: workerStageEnvironment(process.env),
      stdio: [input, "pipe", "pipe"],
      signal,
    });
  const listing = git(
    [
      "rev-list",
      "--objects",
      "--no-object-names",
      "--in-commit-order",
      "--reverse",
      head,
      `^${base}`,
    ],
    "ignore",
  );
  const reading = git(["cat-file", "--batch", "--buffer"], "pipe");
  const exited = Promise.all([listing, reading].map(sourceGitExited));
  reading.stdin.on("error", () => undefined);
  listing.stdout.pipe(reading.stdin);
  const reader = sourceSecretReader(secrets);
  let found;
  let whole = false;
  try {
    for await (const chunk of reading.stdout) {
      found = reader.read(chunk);
      if (found !== undefined) break;
    }
    whole = found === undefined;
  } finally {
    if (!whole) for (const child of [listing, reading]) child.kill();
  }
  const [listed, read] = await exited;
  if (found !== undefined) return found;
  for (const [verb, exit] of [
    ["rev-list", listed],
    ["cat-file", read],
  ])
    if (exit.code !== 0)
      throw new Error(
        `git ${verb} exited ${String(exit.code)} checking the push for secrets: ${exit.stderr}`,
      );
  reader.end();
  return undefined;
}

/**
 * The branch one work attempt leaves behind: a passing attempt's candidate,
 * where `candidate`, or what a failing one changed, kept for whoever reads the
 * attempt. Nothing where it is not a candidate and the attempt changed nothing.
 *
 * A CANDIDATE DESCENDS FROM `base`. One whose history below `base` the attempt
 * rewrote, by a rebase, a squash or an amend, is refused before the remote is
 * reached, since no candidate can be built from it. A failing attempt's branch
 * is never read as a candidate, so what it keeps is kept whatever its history.
 *
 * NOTHING HELD IS PUSHED. `secrets` is every `{ kind, value }` the pod scrubs
 * from what it uploads, and a commit carrying one of them is refused before the
 * remote is reached, naming its kind and the commit and never its value. The
 * push names the commit that was checked rather than `HEAD`, so nothing
 * committed after the check is sent. The credential the push then takes is
 * minted after every commit it sends, so none can carry it and it is not
 * looked for.
 *
 * GIT IS THE IMAGE'S. Every call, and every hook a project's setup installed
 * that one of them runs, is handed what the image's own programs are; the
 * push is handed the credential's environment, which is that and its askpass.
 * The commit is handed `git`, the attempt's git configuration, as well, since
 * the hooks it runs are the project's.
 *
 * THE PUSH IS MADE FROM A REPOSITORY OF THE CORE'S OWN, so no git
 * configuration, hook or ref the attempt left in the workspace or its home
 * reaches it. That repository is made bare, from no template, under the temporary
 * directory, and removed however the push ends. It holds no ref and no
 * configuration but what making it writes, and borrows the workspace's
 * objects through `objects/info/alternates`: the commit, and each commit the
 * remote advertises that the workspace has, the base among them, which the
 * push then need not send. The push's environment is cleared of every
 * variable that places a repository, the system's configuration is off, the
 * global one is an empty file and its home an empty directory, so a git too
 * old to read that file's variable finds no global configuration either and
 * nothing reads the attempt's home; of what configures git only the entries
 * the image's environment names stand; and its command line, which outranks
 * those, names an empty hooks directory and no credential helper, so it runs
 * no hook and its credential is the askpass's alone, handed to no helper. It
 * needs none of `git`, since it reaches one URL.
 *
 * THE PUSH ASKS FOR ITS CREDENTIAL AGAIN. `refresh` is present where the plane
 * minted the one the clone used: that one is a read, a minted token expires,
 * an attempt may outlive one, and the push is the last thing it does — so the
 * credential is taken immediately before it rather than carried from the
 * clone. Where the launcher mounted the credential there is nothing to
 * refresh, and the clone's own environment is what the push is handed. The
 * push is tried again as `gitRemote.mjs` says, under that one credential and
 * from that one repository, with `pause` between tries.
 *
 * EACH HALF IS A STEP. A failure up to and including the secret check and,
 * for a candidate, the descent check fails the commit step, and one making the
 * repository the push is made from, taking the credential or pushing fails the
 * push step.
 */
export async function commitAndPushSource({
  task,
  repositoryId,
  repository,
  base,
  directory,
  command,
  environment,
  refresh,
  secrets,
  git = [],
  pause,
  candidate = true,
}) {
  if (!Array.isArray(secrets))
    throw new Error("a push is checked against the secrets the pod holds");
  const commit = await runStep(
    runCommitFailed,
    () =>
      sourceCommitted({
        task,
        base,
        directory,
        command,
        secrets,
        git,
        candidate,
      }),
    gitFailureLine,
  );
  if (commit === undefined) return undefined;
  const ref = ticketBranch(task);
  await runStep(
    runPushFailed,
    () =>
      sourcePushed({
        repository,
        refspec: `${commit}:${ref}`,
        commit,
        directory,
        command,
        environment,
        refresh,
        pause,
      }),
    gitFailureLine,
  );
  return { repository: repositoryId, ref, commit, base };
}

/**
 * The checkpoint of a run that left no result: everything its tree holds,
 * committed on top of `HEAD` and pushed to `ticketCheckpoint`, where it replaces
 * the last. `{ref, commit}`, or nothing where there is nothing to keep. A `HEAD`
 * past `base` is something to keep with a clean tree, as a pass whose push failed
 * leaves it: its work is in commits no remote holds.
 *
 * IT IS NOT THE ATTEMPT'S BRANCH. A checkpoint may be taken while the run goes
 * on, and that branch's push is not forced, so one there would refuse the pass
 * that follows it. Nothing reads this branch as a candidate; the next attempt
 * reads it as where to start (`sourceCheckpointRestored`).
 *
 * THE WORKSPACE IS LEFT AS IT WAS. The commit is built from a copy of the index
 * with plumbing alone, so `HEAD`, the index and the repository's configuration
 * do not move and a run resumed after it finds its tree and history as it left
 * them, and no hook of the project's can refuse half-done work. What is
 * provisioned is left out, and the push is checked and made as a candidate's
 * is, but for being forced (`commitAndPushSource`). One that does not descend
 * from `base` is refused like a candidate that does not: no attempt can start
 * from it, and being forced it would replace a checkpoint one can.
 *
 * THE CLONE SEES IT BEFORE IT IS PUSHED, as it sees one an earlier attempt left,
 * since a push cut off may still have landed (`sourceCheckpointDeleted`).
 *
 * `signal` stops the secret check; the rest stops as `command` does.
 */
export async function checkpointAndPushSource({
  task,
  repository,
  base,
  directory,
  command,
  environment,
  refresh,
  secrets,
  git = [],
  pause,
  signal,
}) {
  const commit = await sourceCheckpointCommitted({
    task,
    base,
    directory,
    command,
    secrets,
    git,
    signal,
  });
  if (commit === undefined) return undefined;
  const ref = ticketCheckpoint(task);
  await command("git", ["update-ref", sourceCheckpointSeenAt(ref), commit], {
    cwd: directory,
    env: workerStageEnvironment(process.env, { git }),
  });
  await sourcePushed({
    repository,
    refspec: `+${commit}:${ref}`,
    commit,
    directory,
    command,
    environment,
    refresh,
    pause,
  });
  return { ref, commit };
}

/**
 * The ticket's checkpoint deleted from the remote, once a candidate carries what
 * it held: a checkpoint left standing could be restored into a rework of that
 * candidate, handing it work a later attempt threw away. `{ref}`, or nothing
 * where the clone sees no checkpoint, which reaches no remote at all. Made from
 * a repository of its own, as every push is.
 */
export async function sourceCheckpointDeleted({
  task,
  repository,
  directory,
  command,
  environment,
  refresh,
  git = [],
}) {
  const ref = ticketCheckpoint(task);
  const seen = await sourceCheckpointSeen(ref, { directory, command, git });
  if (seen === undefined) return undefined;
  await sourcePushed({
    repository,
    refspec: `:${ref}`,
    commit: seen,
    directory,
    command,
    environment,
    refresh,
  });
  return { ref };
}

/** Where a clone holds the remote's `ref`. */
function sourceCheckpointSeenAt(ref) {
  return ref.replace("refs/heads/", "refs/remotes/origin/");
}

/** The commit the clone at `directory` holds for the remote's `ref`, or nothing. */
async function sourceCheckpointSeen(ref, { directory, command, git }) {
  const { stdout: listed } = await command(
    "git",
    ["for-each-ref", "--format=%(objectname)", sourceCheckpointSeenAt(ref)],
    { cwd: directory, env: workerStageEnvironment(process.env, { git }) },
  );
  const commit = listed.trim();
  return commit === "" ? undefined : commit;
}

/** What the tree holds beyond `HEAD`, committed from an index of its own and checked for what is held; nothing where the tree and `HEAD` are `base`'s. */
async function sourceCheckpointCommitted({
  task,
  base,
  directory,
  command,
  secrets,
  git,
  signal,
}) {
  const local = {
    cwd: directory,
    env: workerStageEnvironment(process.env, { git }),
  };
  const { stdout: index } = await command(
    "git",
    ["rev-parse", "--git-path", "index"],
    local,
  );
  const { stdout: head } = await command(
    "git",
    ["rev-parse", "HEAD", "HEAD^{tree}"],
    local,
  );
  const [parent, tree] = head.trim().split("\n");
  const made = resolve(
    await mkdtemp(workerTemporaryFile(sourceCheckpointPrefix)),
  );
  try {
    const kept = join(made, "index");
    await copyFile(resolve(directory, index.trim()), kept);
    const staged = await sourceStaged(task, command, {
      ...local,
      env: { ...local.env, GIT_INDEX_FILE: kept },
    });
    if (staged === tree && parent === base) return undefined;
    const { stdout: committed } = await command(
      "git",
      [
        "commit-tree",
        staged,
        "-p",
        parent,
        "-m",
        `ticket ${String(task.ticket)} attempt ${task.attempt} checkpoint`,
      ],
      { ...local, env: { ...local.env, ...sourceCheckpointIdentity } },
    );
    const commit = committed.trim();
    await sourceSecretRefused(directory, base, commit, secrets, signal);
    await sourceDescended(directory, base, commit, command);
    return commit;
  } finally {
    await rm(made, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The workspace put where an earlier attempt's checkpoint left it, with the
 * checkpoint's own commit undone: `HEAD` at its parent, so what was committed
 * reads as commits, and the rest in the tree and unstaged, as unfinished work.
 * `{ref, commit}`, or nothing where there is no such branch in the clone or its
 * parent does not descend from `base`, as an old checkpoint does not once a
 * rework runs on a result it never reached. What setup changed in the tree is
 * the checkpoint's to say, since the checkpoint carries it.
 *
 * A failure is raised with the workspace back at `base`, so the attempt can run
 * from there: `read-tree` can stop partway, having written files no index
 * knows of (`sourceBackAtBase`). A workspace that cannot be put back is raised
 * as the setup step's failure instead, since nothing can vouch for that tree.
 */
export async function sourceCheckpointRestored({
  task,
  base,
  directory,
  command,
  git = [],
}) {
  const local = {
    cwd: directory,
    env: workerStageEnvironment(process.env, { git }),
  };
  const ref = ticketCheckpoint(task);
  const commit = await sourceCheckpointSeen(ref, { directory, command, git });
  if (commit === undefined) return undefined;
  const { stdout: parent } = await command(
    "git",
    ["rev-parse", "--verify", `${commit}^`],
    local,
  );
  if (await sourceBaseMissing(directory, base, parent.trim(), command))
    return undefined;
  try {
    await command("git", ["read-tree", "--reset", "-u", commit], local);
    await command("git", ["reset", "--mixed", "--quiet", parent.trim()], local);
  } catch (failure) {
    await runStep(runSetupFailed, () => sourceBackAtBase(base, local, command));
    throw failure;
  }
  return { ref, commit };
}

/**
 * The workspace back at `base` after a restore that failed, whichever step it
 * failed at: tracked files reset, and what no index knows of removed, which is
 * only what the restore wrote because setup's own files are excluded. What
 * setup changed in a tracked file goes with it. `git status` then says it
 * worked, since a reset can warn of a file it could not remove and go on.
 */
async function sourceBackAtBase(base, local, command) {
  await command("git", ["reset", "--hard", "--quiet", base], local);
  await command("git", ["clean", "-d", "--force", "--quiet"], local);
  const { stdout: left } = await command(
    "git",
    ["status", "--porcelain=v1"],
    local,
  );
  if (left !== "")
    throw new Error(`the workspace could not be put back at ${base}: ${left}`);
}

/**
 * `task` as its agent is handed it after `sourceCheckpointRestored`: its
 * briefing ending in a section saying what is in the tree, or as it was where
 * nothing was restored.
 */
export function sourceRestoredBriefed(task, restored) {
  if (restored === undefined) return task;
  const section = [
    "## Unfinished work from an earlier attempt",
    "An earlier attempt at this ticket was stopped before it finished. Its commits are in this checkout's history, and what it had not committed is in the tree as unstaged changes. Check that work, then continue from it rather than starting over.",
  ].join("\n");
  return {
    ...task,
    briefing: {
      ...task.briefing,
      text: `${task.briefing.text}\n\n${section}`,
    },
  };
}

/** Where, in the directory a push is made from, its repository, its empty hooks directory, its empty global configuration and its empty home are. */
function sourcePushPlaces(made) {
  return {
    repository: join(made, "repository"),
    hooks: join(made, "hooks"),
    configuration: join(made, "configuration"),
    home: join(made, "home"),
  };
}

/**
 * What the push, and the making of the repository it is made from, are
 * handed: `environment` less every variable that places a repository, the
 * system's configuration off, the core's empty file as the global one and its
 * empty directory as the home, the core's repository named, and the object
 * format a repository is made in named as `commit` is.
 */
function sourcePushEnvironment(environment, places, commit) {
  const format = sourceObjectFormats.get(commit.length);
  if (format === undefined)
    throw new Error(`git named the commit ${commit} in no object format`);
  return {
    ...workerEnvironmentWithout(environment, sourcePushPlacingVariables),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: places.configuration,
    HOME: places.home,
    XDG_CONFIG_HOME: places.home,
    GIT_DIR: places.repository,
    GIT_DEFAULT_HASH: format,
  };
}

/**
 * `refspec` pushed to `repository` from a repository made for it in a
 * directory of its own, borrowing the objects of the workspace at `directory`,
 * with the credential taken once that repository is made.
 */
async function sourcePushed({
  repository,
  refspec,
  commit,
  directory,
  command,
  environment,
  refresh,
  pause,
}) {
  const { stdout: objects } = await command(
    "git",
    ["rev-parse", "--git-path", "objects"],
    { cwd: directory, env: workerStageEnvironment(process.env) },
  );
  const made = resolve(await mkdtemp(workerTemporaryFile(sourcePushPrefix)));
  try {
    const places = sourcePushPlaces(made);
    await mkdir(places.hooks);
    await mkdir(places.home);
    await writeFile(places.configuration, "");
    await command("git", ["init", "--quiet", "--bare", "--template="], {
      cwd: made,
      env: sourcePushEnvironment(environment, places, commit),
    });
    await writeFile(
      join(places.repository, "objects", "info", "alternates"),
      `${resolve(directory, objects.trim())}\n`,
    );
    const pushing = sourcePushEnvironment(
      refresh === undefined ? environment : await refresh(),
      places,
      commit,
    );
    await gitRemoteTried(
      () =>
        command(
          "git",
          [
            "-c",
            `core.hooksPath=${places.hooks}`,
            "-c",
            "credential.helper=",
            "push",
            repository,
            refspec,
          ],
          { cwd: made, env: pushing },
        ),
      { pause },
    );
  } finally {
    await sourcePushDiscarded(made);
  }
}

/**
 * The directory a push was made from, removed; one that cannot be is reported
 * on stderr rather than raised, so how the push ended is what it reports.
 */
async function sourcePushDiscarded(made) {
  try {
    await rm(made, { recursive: true, force: true });
  } catch (failure) {
    process.stderr.write(
      `the push's repository ${made} could not be removed: ${
        failure instanceof Error ? failure.message : String(failure)
      }\n`,
    );
  }
}

/**
 * The commit everything the attempt changed is in, refused where it carries a
 * held secret or, as a candidate, does not descend from `base`. What is left
 * staged is committed on top of `HEAD`; where nothing is, a `HEAD` past `base`
 * is that commit as it stands, and a `HEAD` still at `base` gets an empty one
 * where it is a candidate, declaring that the attempt found nothing left to
 * do, and is nothing where not.
 */
async function sourceCommitted({
  task,
  base,
  directory,
  command,
  secrets,
  git,
  candidate,
}) {
  const local = {
    cwd: directory,
    env: workerStageEnvironment(process.env, { git }),
  };
  await command("git", ["config", "user.name", sourceAuthorName], local);
  await command("git", ["config", "user.email", sourceAuthorEmail], local);
  const staged = await sourceStaged(task, command, local);
  const { stdout: head } = await command(
    "git",
    ["rev-parse", "HEAD", "HEAD^{tree}"],
    local,
  );
  const [authored, tree] = head.trim().split("\n");
  const unchanged = staged === tree;
  if (unchanged && authored === base && !candidate) return undefined;
  if (!unchanged || authored === base)
    await command(
      "git",
      [
        "commit",
        "--allow-empty",
        "-m",
        `ticket ${String(task.ticket)} attempt ${task.attempt}`,
      ],
      local,
    );
  const { stdout } = await command("git", ["rev-parse", "HEAD"], local);
  const commit = stdout.trim();
  await sourceSecretRefused(directory, base, commit, secrets);
  if (candidate) await sourceDescended(directory, base, commit, command);
  return commit;
}

/** Everything in the tree staged in the index `local` names, but what the attempt's block provisioned, and the tree that makes. */
async function sourceStaged(task, command, local) {
  await command("git", ["add", "--all"], local);
  const provisioned = (task.worker?.files ?? []).map((file) => file.path);
  if (provisioned.length > 0) {
    await command("git", ["reset", "--", ...provisioned], local);
  }
  const { stdout } = await command("git", ["write-tree"], local);
  return stdout.trim();
}

/** Refuses `commit` where it carries a held secret, naming the kind and the commit and never the value. */
async function sourceSecretRefused(directory, base, commit, secrets, signal) {
  const carried =
    secrets.length === 0
      ? undefined
      : await sourceSecretCarried(directory, base, commit, secrets, signal);
  if (carried !== undefined)
    throw new Error(
      `commit ${carried.commit} carries ${carried.kind} in ${carried.place}, so the attempt pushes nothing`,
    );
}

/** Whether `base` is not among `commit`'s ancestors. Replacement refs are ignored, as the push ignores them. */
async function sourceBaseMissing(directory, base, commit, command) {
  const { stdout: missing } = await command(
    "git",
    ["--no-replace-objects", "rev-list", "--max-count=1", base, `^${commit}`],
    { cwd: directory, env: workerStageEnvironment(process.env) },
  );
  return missing.trim() !== "";
}

/** Refuses `commit` where `base` is not among its ancestors, saying what the next attempt does instead. */
async function sourceDescended(directory, base, commit, command) {
  if (await sourceBaseMissing(directory, base, commit, command))
    throw new Error(
      `commit ${commit} does not descend from ${base}, the commit this attempt started from, so the attempt pushes nothing. A rebase does this, and so does checking out a different commit. Add commits on top of ${base} instead, merging the target in rather than rebasing onto it.`,
    );
}
