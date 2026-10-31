/**
 * What one work attempt is given, what runs it, and what it leaves behind.
 *
 * THE CARRIER IS THE MODE AND THE CANDIDATE IS THE TASK KIND. Whether an agent
 * or a list of commands runs the attempt is the worker mode the task carries;
 * whether what ran leaves a candidate behind is the task's kind and its
 * verdict. Neither is read from the other, so a Work task carrying commands
 * runs them with no agent and still pushes the candidate a passing run leaves.
 *
 * A FAILED WORK ATTEMPT KEEPS WHAT IT CHANGED on the branch a pass would have
 * pushed, named in the run's log and its report and never as its source, so
 * nothing reads it as a candidate. Keeping it is never the attempt's failure:
 * a commit or push that fails, or a commit carrying a held secret, is logged
 * and the attempt still reports the Fail it ran to.
 *
 * A WORK RUN THAT LEAVES NO RESULT LEAVES A CHECKPOINT, whether it ended without
 * a verdict or passed and could not commit or push, and the ticket's next Work
 * attempt starts from what it left. Such a run is a lost attempt and never a
 * failed task, so what it did is not a kept branch for a reader but where the
 * work goes on from (`source.mjs`). Keeping it is never the run's failure:
 * where it cannot be kept the error text says so, and the run ends under the
 * label it had, however long the remote takes (`workAside`). Where it cannot be
 * restored the attempt runs from its base, and fails where the workspace cannot
 * be put back there. It is restored once the setup has run, so half-done work
 * cannot fail a setup that passes without it, and nothing it left untracked is
 * taken for what setup left. A pass deletes it once its report has landed, since
 * until then the run can still be lost and the next attempt go on from it.
 *
 * A RUN THE ACCOUNT'S LIMIT STOPPED WAITS IT OUT WHERE IT CAN, in the slot it
 * holds, and carries on in the same conversation (`runHold.mjs`). Its work is
 * checkpointed first, since the runner may be restarted or the deadline may
 * land during the wait. Its lease is kept by its own timer throughout.
 *
 * THE COMMANDS' EXIT STATUS IS THE WORK'S SUCCESS. Where an agent ran the
 * attempt there is an account of the run to take a verdict from; where commands
 * ran it there is nothing but what they exited with, and nothing else is asked
 * for.
 *
 * AN EMPTY DIFF IS STILL A CANDIDATE IN THIS WORKER'S WORK MODE, because the
 * commit it makes is `--allow-empty`: an attempt whose commands changed nothing
 * declares the commit anyway. That is this worker's rule and not a property of
 * the platform, so a configuration read across to another runner cannot assume
 * it; a repository that wants an empty attempt to fail says so in a command.
 *
 * A POOL HANDS ITS POD AN ENVELOPE, AND THE TASK IS FETCHED. Where a launcher
 * writes the task document itself, a pool writes only the plane to fetch it
 * from, the bearer to fetch it under, and what the pool itself mounted. What
 * the plane answers is the document less that plane, so the plane is joined
 * back on and the attempt runs from admission onwards exactly as a pushed one.
 * A session's task, which a pool holds only with the site's API, bounds and
 * model on it, runs as a session pod's own launch does (`./session.mjs`).
 * A job its runner started on its host mints credentials into that job's own
 * directory rather than a mount's, and a session never runs there.
 *
 * WHAT PREPARING THE WORKSPACE LEAVES IS NOT THE WORK. Each file a block
 * provisions, and whatever its setup lines leave untracked, such as a lockfile
 * a repository does not keep or a directory it does not have, is excluded in
 * the clone before anything runs. Neither the attempt's commit nor what the
 * agent sees as its changes carries them, and a file the agent adds under such
 * a directory goes with it. A tracked file setup changes is still the work's,
 * as is a name with a line break, which no pattern holds, and a path the
 * repository's own `.gitignore` takes back with `!`, which outranks this.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  access,
  appendFile,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { Socket } from "node:net";

import {
  mintedCredentialDirectory,
  sessionTaskVariable,
  workerCredentialFilesVariable,
  workerRepositoriesVariable,
  workerTaskVariable,
  workerWorkspaceVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import {
  contractVersionRefusalSchema,
  contractVersionRefusalStatus,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";
import {
  workerPlaneAnswers,
  workerPlaneBytesMediaType,
  workerPlaneRoutes,
  workerPlaneUploadBytesMax,
} from "@chuggy/worker-contract/workerPlane";
import {
  filesystemAccesses,
  poolEnvelopeSchema,
  workTaskAnswerSchema,
  workTaskDocumentSchema,
  workerTaskAnswerSchema,
} from "@chuggy/worker-contract/workerTask";

import { workerAgent } from "./agent.mjs";
import {
  chatChannelOpened,
  chatChannelVariable,
  chatCheckoutRead,
  chatCheckoutVariable,
  chatMintedVariable,
} from "./chatChannel.mjs";
import {
  runChecks,
  workerAgentEnvironment,
  workerCheckCommands,
  workerEnvironmentWithout,
  workerJobEnvironment,
  workerReportText,
  workerSetupEnvironmentVariable,
  workerShellEnvironment,
  workerStageEnvironment,
  workerSummaryText,
  workerTemporaryFile,
} from "./checks.mjs";
import { hostJobVariable } from "./coreRuntime.mjs";
import { chatAbortable } from "./chatCheckout.mjs";
import { gitFailureLine, gitRemoteTried } from "./gitRemote.mjs";
import { heldCredentials } from "./heldCredentials.mjs";
import { jobHostPlaces, jobRepositoryDirectory } from "./job.mjs";
import { keepWorkerLease } from "./lease.mjs";
import {
  planeCredential,
  planeCredentialAnswered,
  planeCredentialUnreachedText,
  workerCredentialPath,
} from "./planeCredential.mjs";
import { projectReadsServed } from "./projectReads.mjs";
import {
  workerCredentialEnvironment,
  workerRepositories,
  workerRepository,
  workerRepositoryUrl,
} from "./repository.mjs";
import {
  RunStepFailure,
  credentialScrub,
  credentialScrubbing,
  runCloneFailed,
  runEvidenceRecorder,
  runSetupFailed,
  runStep,
  workerErrorPath,
} from "./runEvidence.mjs";
import { runEndedText, runHoldDecided, runHoldInstant } from "./runHold.mjs";
import {
  setupEnvironmentDirectory,
  setupEnvironmentFile,
  setupEnvironmentMerged,
  setupEnvironmentWritten,
} from "./setupEnvironment.mjs";
import { runConfigurationSnapshot } from "./snapshot.mjs";
import {
  checkpointAndPushSource,
  sourceCheckpointDeleted,
  sourceCheckpointSeen,
  commitAndPushSource,
  resultDocument,
  sourceCheckpointRestored,
  sourceRestoredBriefed,
} from "./source.mjs";
import {
  readTicketImages,
  ticketImageReferences,
  ticketImagesBriefed,
} from "./ticketImages.mjs";
import { workerPlaneAwayMillisecondsMax, workerRequest } from "./transport.mjs";
import { agentResultSchema } from "./result.mjs";
import { answeredWith, rosterLabel, routePath } from "./wire.mjs";

const executeFile = promisify(execFile);
const agentResultSchemaName = "chuggy-agent-result-schema.json";
const agentDiagnosticPath = ".chuggy/agent-result.json";
/** Where an agent's summary is kept as it was written: the path chuggy reads its `work-summary` output from. */
const agentSummaryPath = ".chuggy/outputs/summary.md";
const checkDiagnosticPath = ".chuggy/check-output.json";
const workerCredentialFilesMax = 64;
const workspaceWrite = rosterLabel(filesystemAccesses, "WriteWorkspace");

/** What a held run tells the time by and waits on, where a suite names no other. */
const workerClock = {
  now: Date.now,
  wait,
  uptimeSecs: () => process.uptime(),
};

/** What each secret this pod holds is, which a refused push names in place of its value. */
const workerSecretKinds = {
  bearer: "the attempt's bearer",
  mounted: "a credential the launcher mounted",
  minted: "the git credential the plane minted",
  read: "a read the plane minted for a repository",
  held: "a credential the plane holds",
};

let activeTask;
let activeBearer;
let activeScrub;
let activeEvidence;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

/**
 * A site map this pod may run without. A minted credential reaches a repository
 * at its own identity, so a deployment that mints names nothing here; a
 * deployment that mounts still does, and the mounted arm refuses a repository
 * the map leaves out exactly as before.
 */
function optionalRepositories(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0
    ? {}
    : workerRepositories(value);
}

function parsed(name) {
  return JSON.parse(required(name));
}

function oneReference(input, kind) {
  const references = input.references.filter(
    (reference) => reference.kind === kind,
  );
  if (references.length !== 1)
    throw new Error(`input bundle must carry one ${kind}`);
  return references[0].reference;
}

/** The input reference naming the commit the change an attempt carries started from. */
const changeBaseKind = "ChangeBase";

/** A full commit hash, in either of the object formats git names a commit in. */
const changeBaseCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The commit the change started from, as the input bundle pinned it, or
 * nothing: where the bundle names none, as a plane that predates the reference
 * does, where it is not a full hash, and where the clone at `directory` holds
 * no such commit. The clone is of every branch, so a base the remote still
 * reaches is in it; one no branch reaches is left unknown rather than fetched
 * by its hash, which a forge need not serve.
 */
async function workerChangeBase(input, directory) {
  const named = input.references.filter(
    (reference) => reference.kind === changeBaseKind,
  );
  if (named.length > 1)
    throw new Error(`input bundle must carry at most one ${changeBaseKind}`);
  const base = named[0]?.reference;
  if (base === undefined || !changeBaseCommit.test(base)) return undefined;
  return command("git", ["cat-file", "-e", `${base}^{commit}`], {
    cwd: directory,
  }).then(
    () => base,
    () => undefined,
  );
}

/**
 * One of the image's programs run to its end, git or a setup line: handed what
 * the image's own programs are where `options` names no environment of its own.
 */
const commandBufferMax = 16 * 1024 * 1024;

async function command(executable, args, options = {}) {
  return executeFile(executable, args, {
    maxBuffer: commandBufferMax,
    env: workerStageEnvironment(process.env),
    ...options,
  });
}

/**
 * The repository cloned into `workspace` and checked out at `commit`. The
 * clone is tried again as `gitRemote.mjs` says, from an empty directory each
 * time; the checkout reaches no remote and is run once. `seams` names the
 * programs run and the pause between tries.
 */
export async function cloneRepository(
  repository,
  commit,
  workspace,
  environment,
  seams = {},
) {
  const { run = command, pause } = seams;
  const directory = jobRepositoryDirectory(workspace);
  await gitRemoteTried(
    () =>
      run("git", ["clone", "--no-checkout", repository, directory], {
        env: environment,
      }),
    {
      again: () => rm(directory, { recursive: true, force: true }),
      pause,
    },
  );
  await run("git", ["checkout", "--detach", commit], {
    cwd: directory,
    env: environment,
  });
  return directory;
}

function workspaceFile(directory, path) {
  const target = resolve(directory, path);
  const within = relative(directory, target);
  if (within.length === 0 || within.startsWith("..") || within.startsWith("/"))
    throw new Error(`worker setup path escapes the repository: ${path}`);
  return target;
}

/** `path` as a gitignore pattern naming it alone, from the repository's root;
 * none for a name with a line break, where git ends every pattern. A carriage
 * return is bracketed, because git drops one that ends a line. */
function excludedPattern(path) {
  if (path.includes("\n")) return undefined;
  return `/${path
    .replace(/[\\*?[]/gu, "\\$&")
    .replace(/\r/gu, "[\r]")
    .replace(/ $/u, "\\ ")}`;
}

/** `paths` excluded in the clone at `directory`, each by a pattern naming it alone. */
async function excludedFromWork(directory, paths) {
  const patterns = paths.flatMap((path) => excludedPattern(path) ?? []);
  if (patterns.length === 0) return;
  const { stdout: exclude } = await command(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: directory },
  );
  const excludeFile = resolve(directory, exclude.trim());
  await mkdir(dirname(excludeFile), { recursive: true });
  await appendFile(excludeFile, `${patterns.join("\n")}\n`);
}

/** How a setup line's shell ended, naming the line. */
function setupFailureLine(setup, failure) {
  if (typeof failure?.code === "number")
    return `${setup} exited ${String(failure.code)}`;
  if (typeof failure?.signal === "string")
    return `${setup} was killed by ${failure.signal}`;
  return `${setup} failed`;
}

/**
 * Each of `lines` run in order in `directory`, handed what the attempt hands
 * the stage's commands, what the lines before it passed on, and a file of its
 * own to pass variables on in; what they all passed on, once the last has run.
 * A line that fails, or passes on what setup may not, fails the setup step.
 */
async function prepareWorkerSetup(lines, directory, handed) {
  if (lines.length === 0) return {};
  const files = await setupEnvironmentDirectory();
  try {
    let passed = {};
    for (const [index, setup] of lines.entries()) {
      const file = await runStep(runSetupFailed, () =>
        setupEnvironmentFile(files, index),
      );
      await runStep(
        runSetupFailed,
        () =>
          command("/bin/sh", ["-eu", "-c", setup], {
            cwd: directory,
            env: {
              ...workerStageEnvironment(process.env, {
                ...handed,
                setupEnvironment: passed,
              }),
              [workerSetupEnvironmentVariable]: file,
            },
          }),
        (failure) => setupFailureLine(setup, failure),
      );
      passed = await runStep(
        runSetupFailed,
        async () =>
          setupEnvironmentMerged(passed, await setupEnvironmentWritten(file)),
        () => `${setup} passed on what setup may not`,
      );
    }
    return passed;
  } finally {
    await rm(files, { recursive: true, force: true });
  }
}

/**
 * The files and the setup lines a worker block asks for, in the workspace it
 * runs in, its lines handed what the attempt hands the stage's commands; what
 * those lines passed on. A file that cannot be written, or a line that fails
 * or passes on what setup may not, fails the setup step.
 */
export async function prepareWorker(task, directory, handed = {}) {
  const provisioned = [];
  for (const file of task.worker?.files ?? []) {
    const target = await runStep(runSetupFailed, async () => {
      const written = workspaceFile(directory, file.path);
      await mkdir(dirname(written), { recursive: true });
      await writeFile(written, file.content, { flag: "wx" });
      return written;
    });
    provisioned.push(relative(directory, target));
  }
  await excludedFromWork(directory, provisioned);
  const setupEnvironment = await prepareWorkerSetup(
    task.worker?.setup ?? [],
    directory,
    handed,
  );
  const { stdout: status } = await command(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    { cwd: directory },
  );
  await excludedFromWork(
    directory,
    status
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3)),
  );
  return setupEnvironment;
}

async function captureConfiguration(context, argv, init) {
  const snapshot = await runConfigurationSnapshot({
    argv,
    init,
    task: context.task,
    cwd: context.directory,
    home: process.env.HOME,
    scrub: context.scrub,
  });
  await context.evidence.configuration(snapshot);
}

async function readAgentStream(context, child, argv, stream) {
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    process.stdout.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(
        `${context.agent.runtime} emitted invalid streaming JSON`,
      );
    }
    if (!stream.captured && context.agent.configurationEvent(event)) {
      stream.captured = true;
      await captureConfiguration(context, argv, event);
    }
    if (context.agent.resultEvent(event)) stream.result = event;
    const observed = context.agent.observed(event);
    if (observed !== undefined) context.evidence.observed(observed);
    context.evidence.record(line, event);
  }
}

/**
 * Each image the attempt's bundle pins, read with its bearer into a directory
 * of this run's own under the temporary directory, or none.
 */
async function agentImages(context) {
  const references = context.images ?? [];
  if (references.length === 0) return [];
  return readTicketImages({
    task: context.task,
    bearer: context.bearer,
    references,
    directory: await mkdtemp(workerTemporaryFile("chuggy-ticket-images-")),
    ...(context.request === undefined ? {} : { request: context.request }),
  });
}

/**
 * What an agent's own process is started with: the pod's inherited
 * environment less what the agent's credential withholds, the credential's
 * environment and its shell's, and what the agent adds to them once it has
 * seen the whole of it.
 */
async function runAgentEnvironment(context, shell) {
  const environment = {
    ...workerEnvironmentWithout(
      workerAgentEnvironment(process.env),
      context.agentWithheld ?? [],
    ),
    ...context.agentEnvironment,
    ...shell.environment,
  };
  return context.agent.prepareEnvironment === undefined
    ? environment
    : {
        ...environment,
        ...(await context.agent.prepareEnvironment(environment)),
      };
}

/**
 * One process of the agent, run to its end: its stream's last result and how it
 * exited. One whose stream cannot be read is killed before the failure is raised.
 * That is the process alone: anything it started can still be writing to the tree.
 */
async function runAgentProcess(context, argv, environment, stream) {
  const child = spawn(context.agent.executable, argv, {
    cwd: context.directory,
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) =>
      resolve([exitCode, exitSignal]),
    );
  });
  stream.result = undefined;
  try {
    await readAgentStream(context, child, argv, stream);
    const [code, signal] = await exited;
    return { resultEvent: stream.result, code, signal };
  } catch (failure) {
    child.kill("SIGKILL");
    child.stdout.destroy();
    await exited.catch(() => undefined);
    const { sentence } = context.agent.ended?.(stream.result) ?? {};
    failure.message = runEndedText(
      failure.message,
      runAgentSentence(context, sentence),
    );
    throw failure;
  }
}

/** What a runtime said of how it ended, scrubbed, where it said anything. */
function runAgentSentence(context, sentence) {
  return typeof sentence === "string" ? context.scrub(sentence) : undefined;
}

/**
 * What one process of the agent came to: `finished`, the run's account, where
 * it exited clean with a verdict; `held`, the limit to wait out and the session
 * to resume, where it reached none and may; and otherwise its failure, raised
 * saying what the runtime said and why a limit was not waited out. A verdict
 * wins, so a process that gave one is never held, whatever its frames said. Read
 * a second time once its work is kept, since that can spend the time a hold
 * rests on or leave a write credential that forbids one (`credentialLeft`).
 */
function runAgentEnded(
  context,
  { resultEvent, code, signal },
  { holds, credentialLeft = false },
) {
  const { agent } = context;
  let read;
  let missing;
  try {
    read = agent.result([resultEvent]);
  } catch (failure) {
    missing = failure;
  }
  if (code === 0 && missing === undefined)
    return {
      finished: {
        ...read,
        diagnosticPath: agentDiagnosticPath,
        summaryPath: agentSummaryPath,
      },
    };
  const { sentence, session } = agent.ended?.(resultEvent) ?? {};
  const decided =
    missing === undefined
      ? undefined
      : runHoldDecided({
          resumable: agent.resumeInvocation !== undefined,
          sightings: context.evidence.sightings(),
          session,
          nowMs: (context.clock ?? workerClock).now(),
          deadlineMs: context.runDeadlineMs,
          holds,
          credentialLeft,
        });
  if (decided?.untilMs !== undefined) return { held: decided, session };
  throw new Error(
    runEndedText(
      code === 0
        ? missing.message
        : `${agent.runtime} exited ${code ?? `after signal ${signal ?? "unknown"}`}`,
      runAgentSentence(context, sentence),
      decided,
    ),
  );
}

/**
 * The limit waited out: the wait written to the transcript and the log, and the
 * run's evidence told a new process follows, which may change the tree.
 */
async function runAgentHeld(context, { untilMs, window }, clock) {
  const line = context.evidence.held({
    until: runHoldInstant(untilMs),
    window,
  });
  process.stderr.write(`${line}\n`);
  await clock.wait(Math.max(0, untilMs - clock.now()));
  context.evidence.resumed();
  context.keepAgain();
}

/**
 * The agent started on the task from what a check stage's shells inherit, its
 * shell prepared to hand the project's commands the rest of what those shells
 * are handed, and its briefing told where each image its brief carries was
 * read to and what an earlier attempt left in the tree. A run held at a limit
 * is the same process started again, on the same shell and environment, in the
 * conversation it left, and everything it streams is the one run's.
 */
async function runAgent(context) {
  const task = ticketImagesBriefed(
    sourceRestoredBriefed(context.task, context.restored),
    await agentImages(context),
  );
  const shell = await context.agent.prepareShell(
    workerShellEnvironment(process.env, {
      setupEnvironment: context.setupEnvironment,
      heldCredentials: context.heldCredentials,
      changeBase: context.changeBase,
      job: context.job,
      git: context.git,
    }),
  );
  const argv = context.agent.invocation(task, {
    resultSchema: workerTemporaryFile(agentResultSchemaName),
    shellArguments: shell.arguments,
  });
  const environment = await runAgentEnvironment(context, shell);
  if (context.agent.configuration !== undefined)
    await captureConfiguration(
      context,
      argv,
      await context.agent.configuration(task, environment),
    );
  const stream = { captured: false };
  for (let holds = 0, next = argv; ; holds += 1) {
    const exited = await runAgentProcess(context, next, environment, stream);
    const ended = runAgentEnded(context, exited, { holds });
    if (ended.finished !== undefined) return ended.finished;
    const { credentialLeft } = await context.keep();
    const { held, session } = runAgentEnded(context, exited, {
      holds,
      credentialLeft,
    });
    await runAgentHeld(context, held, context.clock ?? workerClock);
    next = context.agent.resumeInvocation(task, session);
  }
}

function artifact(path, content) {
  return {
    path,
    digest: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

async function upload(task, bearer, path, content, request = workerRequest) {
  await request(task, bearer, routePath(workerPlaneRoutes.artifact, path), {
    method: "PUT",
    headers: { "content-type": workerPlaneBytesMediaType },
    body: content,
  });
  return artifact(path, content);
}

/**
 * What a work attempt leaves on its branch: a passing one's `source`, and what
 * a failing one changed as `kept`, where it changed anything and keeping it
 * did not fail.
 */
async function workSource(context, workspace, verdict) {
  if (context.task.taskKind !== "Work") return {};
  const pushed = () =>
    commitAndPushSource({
      task: context.task,
      ...workspace,
      command: context.command ?? command,
      secrets: context.held(),
      git: context.git,
      candidate: verdict === "Pass",
    });
  if (verdict === "Pass") {
    let source;
    try {
      source = await pushed();
    } catch (failure) {
      throw await workFailureKept(failure, () =>
        workCheckpointed(context, workspace),
      );
    }
    return { source };
  }
  try {
    const kept = await pushed();
    process.stderr.write(
      kept === undefined
        ? "the failed attempt changed nothing, so nothing is kept\n"
        : `${workSourceKept(kept)}\n`,
    );
    return { kept };
  } catch (failure) {
    process.stderr.write(
      `the failed attempt's changes could not be kept: ${context.scrub(
        failure instanceof Error ? failure.message : String(failure),
      )}\n`,
    );
    return {};
  }
}

/** Where a failed attempt's changes are kept, as its log and its report say it. */
function workSourceKept({ ref, commit }) {
  return `The failed attempt's changes are kept on ${ref} at ${commit}.`;
}

/** How long a push aside may take: a bound on a hang, with room for a large repository's push. */
const workAsideCapMs = 1_200_000;

/** What a push aside leaves before the run's deadline, for a report the plane is slow to take. */
const workAsideReportMs = workerPlaneAwayMillisecondsMax;

/** How much of what a step aside failed with is carried beside the run's own failure. */
export const workFailureSaidCharsMax = 4_096;

/** What the directory a push aside's credential is written in is named by, in the minted directory. */
const workAsidePrefix = "chuggy-aside-";

/**
 * How long a push aside may take from `nowMs`, which at the run's end may be
 * none: in whole milliseconds, the only kind a timer takes, while a deadline
 * counted from a process's uptime is a fraction.
 */
function workAsideBoundMs(capMs, nowMs, deadlineMs) {
  return deadlineMs === undefined
    ? capMs
    : Math.floor(
        Math.max(0, Math.min(capMs, deadlineMs - nowMs - workAsideReportMs)),
      );
}

/**
 * `command` for what `signal` stops: nothing begins once it has gone, and each
 * child is in a process group of its own, which is killed whole, because a
 * killed `git push` leaves its transport running, and with it, over a local
 * path, a remote's hook. It is spawned here because `execFile` makes no group.
 * Windows has no groups, so there the child alone is killed. What it says is
 * bounded as `command` bounds it: past that it is stopped and fails as `command`
 * does, and whatever a writer outside its group goes on saying is dropped.
 */
export function commandStopped(signal) {
  const alone = process.platform === "win32";
  return (executable, args, options = {}) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(executable, args, {
        env: workerStageEnvironment(process.env),
        ...options,
        detached: !alone,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stopped = () => {
        try {
          process.kill(alone ? child.pid : -child.pid, "SIGKILL");
        } catch {
          // Nothing of it is left, or it never began.
        }
      };
      const said = { stdout: "", stderr: "" };
      for (const stream of ["stdout", "stderr"])
        child[stream].setEncoding("utf8").on("data", (text) => {
          if (said[stream].length > commandBufferMax) return;
          said[stream] += text;
          if (said[stream].length <= commandBufferMax) return;
          stopped();
          reject(
            Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          );
        });
      signal.addEventListener("abort", stopped, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        signal.removeEventListener("abort", stopped);
        if (code === 0) resolve(said);
        else
          reject(
            Object.assign(
              new Error(
                `Command failed: ${[executable, ...args].join(" ")}\n${said.stderr}`,
              ),
              said,
              { code },
            ),
          );
      });
    });
}

/** What `failure` said, scrubbed. */
function workFailureSaid(context, failure) {
  return context.scrub(
    failure instanceof Error ? failure.message : String(failure),
  );
}

/**
 * `said`, already scrubbed, cut short enough to stand beside the run's own
 * failure, since a remote can say anything and an upload past its size keeps only
 * its end. What is left starts with git's line saying why, which a flood buries.
 */
function workFailureCut(said) {
  if (said.length <= workFailureSaidCharsMax) return said;
  const line = gitFailureLine({ stderr: said });
  const led = line === undefined ? said : `${line}\n${said}`;
  return `${led.slice(0, workFailureSaidCharsMax)}\n(the rest of what it said is cut)`;
}

/**
 * `work`, handed the `command` and `signal` that stop it, as something aside from
 * the run's result. It answers `{done}` or `{failure}`, scrubbed and cut, and
 * raises nothing, so whatever goes wrong never reaches how the run ended.
 *
 * ONE BOUND HOLDS ALL OF IT. Retries are inside it, its git children are stopped
 * when it lands, and a mint the plane has not answered is simply left, so no
 * remote can delay the run's end past it or end the run as timed out in its
 * place. Where the run's deadline is known it lands early enough to report.
 */
async function workWithinBound(context, work) {
  let boundMs;
  let signal;
  try {
    boundMs = workAsideBoundMs(
      context.asideCapMs ?? workAsideCapMs,
      (context.clock ?? workerClock).now(),
      context.runDeadlineMs,
    );
    signal = globalThis.AbortSignal.timeout(boundMs);
    return {
      done: await chatAbortable(
        signal,
        work({ command: context.command ?? commandStopped(signal), signal }),
      ),
    };
  } catch (failure) {
    return {
      failure: signal?.aborted
        ? `it was stopped after ${String(boundMs)} ms`
        : workFailureCut(workFailureSaid(context, failure)),
    };
  }
}

/** Whether `apart`'s write credential stayed behind, which is logged. It raises nothing. */
async function workApartLeft(context, apart) {
  try {
    await apart?.discard();
    return false;
  } catch (failure) {
    process.stderr.write(
      `a push's write credential could not be removed: ${workFailureSaid(context, failure)}\n`,
    );
    return true;
  }
}

/**
 * A push that is not the run's result, within its bound: `push` handed the
 * `command`, `signal` and `refresh` to make it with. It answers as
 * `workWithinBound` does, with `credentialLeft` from `workApartLeft`.
 *
 * ITS WRITE CREDENTIAL IS ITS OWN. A hold pushes while the attempt's agent has
 * yet to be resumed, so what it mints is written apart from the attempt's read
 * and removed with its directory however the push ended. A mint answered after
 * that finds no directory to write in, which is why it is a directory.
 */
async function workAside(context, workspace, push) {
  const taken = {};
  const ended = await workWithinBound(context, async (pushing) => {
    taken.apart = await workspace.refreshApart?.();
    pushing.signal.throwIfAborted();
    return push({
      ...pushing,
      ...(taken.apart === undefined ? {} : { refresh: taken.apart.refresh }),
    });
  });
  return {
    ...ended,
    credentialLeft: await workApartLeft(context, taken.apart),
  };
}

/**
 * What a work run did kept as its ticket's checkpoint: `line`, saying what became
 * of it, which is logged, and `credentialLeft` as `workAside` answers it. Nothing
 * where the run is not work. Whatever goes wrong here is that line, and never
 * reaches the run's own end.
 */
async function workCheckpointed(context, workspace) {
  if (context.task.taskKind !== "Work") return {};
  const { done, failure, credentialLeft } = await workAside(
    context,
    workspace,
    (pushing) =>
      checkpointAndPushSource({
        task: context.task,
        ...workspace,
        ...pushing,
        secrets: context.held(),
        git: context.git,
      }),
  );
  let line;
  if (failure !== undefined)
    line = `The run's work could not be kept: ${failure}`;
  else if (done === undefined)
    line = "The run changed nothing, so nothing is kept.";
  else line = `The run's work is kept on ${done.ref} at ${done.commit}.`;
  process.stderr.write(`${line}\n`);
  return { line, credentialLeft };
}

/**
 * The ticket's checkpoint readied to go once a pass is reported: `clear` deletes
 * it, and `discard` removes what deleting it took. Until the report has landed
 * the run can still be lost, and the next attempt goes on from the checkpoint, so
 * only the credential is taken before it, since the bearer may be dead after it.
 * That comes before the lease stops, so a mint that stalls cannot cost a pass its
 * lease. A clone that sees none readies nothing. What becomes of the delete is
 * logged and nothing else: neither raises, and it touches neither the pass nor
 * its report, since a checkpoint left standing only risks being restored.
 */
async function workCheckpointClearing(context, workspace) {
  if (context.task.taskKind !== "Work") return undefined;
  const logged = (failure) =>
    process.stderr.write(
      `The ticket's checkpoint could not be deleted: ${failure}\n`,
    );
  const taken = {};
  const { done: ready, failure: unready } = await workWithinBound(
    context,
    async ({ command: stopping, signal }) => {
      const checkpoint = await sourceCheckpointSeen({
        task: context.task,
        directory: workspace.directory,
        command: stopping,
        git: context.git,
      });
      if (checkpoint === undefined) return undefined;
      taken.apart = await workspace.refreshApart?.();
      signal.throwIfAborted();
      const environment = await taken.apart?.refresh();
      return { checkpoint, environment: environment ?? workspace.environment };
    },
  );
  if (unready !== undefined) logged(unready);
  return {
    clear: async () => {
      if (ready === undefined) return;
      const { failure } = await workWithinBound(
        context,
        ({ command: stopping }) =>
          sourceCheckpointDeleted({
            ...workspace,
            ...ready,
            command: stopping,
          }),
      );
      if (failure !== undefined) logged(failure);
      else
        process.stderr.write(
          `The ticket's checkpoint ${ready.checkpoint.ref} is deleted.\n`,
        );
    },
    discard: () => workApartLeft(context, taken.apart),
  };
}

/**
 * What an earlier attempt of a work task left, restored into the workspace:
 * `{ref, commit}`, or nothing where it left nothing to start from. One that
 * cannot be restored is logged, and the attempt runs from its base, unless the
 * workspace could not be put back there, which is the attempt's failure.
 */
async function workCheckpointRestored(context, workspace) {
  if (context.task.taskKind !== "Work") return undefined;
  try {
    const restored = await sourceCheckpointRestored({
      task: context.task,
      base: workspace.base,
      directory: workspace.directory,
      command,
      git: context.git,
    });
    if (restored !== undefined)
      process.stderr.write(
        `this attempt starts from the checkpoint ${restored.commit} on ${restored.ref}\n`,
      );
    return restored;
  } catch (failure) {
    if (failure instanceof RunStepFailure) throw failure;
    process.stderr.write(
      `the checkpoint could not be restored, so this attempt starts from its base: ${workFailureSaid(context, failure)}\n`,
    );
    return undefined;
  }
}

/**
 * `keep` taken once for each state of the tree, so a run a hold's own keep ends
 * pushes nothing twice; `keepAgain` says an agent is about to change the tree.
 */
function workKeptOnce(keep) {
  let kept;
  return {
    keep: async () => {
      kept ??= keep();
      return kept;
    },
    keepAgain: () => {
      kept = undefined;
    },
  };
}

/** `failure`, the run's own, told what became of its unfinished work. */
async function workFailureKept(failure, keep) {
  const { line } = await keep();
  if (line !== undefined && failure instanceof Error)
    failure.message = `${failure.message}\n${line}`;
  return failure;
}

/**
 * One mint from the plane, its password kept out of everything this pod writes
 * before anything reaches a remote with it: a read of `repository` where it is
 * named, and what the attempt's task kind needs of its own where nothing is.
 * Nothing where this deployment mints no credential for the attempt's
 * repository, and the attempt's failure where the plane says which way its app
 * does not reach it, before anything falls back to the mount.
 */
async function workerMinted({
  task,
  bearer,
  keepSecret,
  request,
  write,
  directory,
  repository,
}) {
  const minted = await planeCredential({
    task,
    bearer,
    path: workerCredentialPath,
    ...(repository === undefined ? {} : { repository }),
    ...(request === undefined ? {} : { request }),
    ...(write === undefined ? {} : { write }),
    ...(directory === undefined ? {} : { directory }),
  });
  if (minted?.unreached !== undefined)
    throw new Error(planeCredentialUnreachedText(minted.unreached));
  if (minted !== undefined)
    keepSecret({ kind: workerSecretKinds.minted, value: minted.password });
  return minted;
}

/**
 * A fresh mint immediately before the push, naming no repository, so the plane
 * mints what the task kind needs: the clone's credential is a read, and a
 * minted token expires while an attempt may outlive one. The plane refusing
 * here is this attempt's failure: a clone that minted and a push that cannot
 * is a deployment mid-change or an installation that grants only a read, and
 * reaching the remote with something else is exactly what a minted credential
 * is for. It is presented for `remote`, the URL the push reaches.
 */
async function workerRefreshed(asked, remote) {
  const minted = await workerMinted(asked);
  if (minted === undefined)
    throw new Error("the worker plane mints no credential to push with");
  return workerCredentialEnvironment(minted.file, minted.username, remote);
}

/**
 * A push's credential kept apart from the attempt's own, which an agent reads:
 * `refresh`, minting as the push's does into a directory made for it, and
 * `discard`, removing that.
 */
async function workerRefreshApart(asked, remote) {
  const directory = await mkdtemp(
    join(asked.directory ?? mintedCredentialDirectory, workAsidePrefix),
  );
  return {
    refresh: () => workerRefreshed({ ...asked, directory }, remote),
    discard: () => rm(directory, { recursive: true, force: true }),
  };
}

/** The credential this attempt's launcher mounted, and the authority that must name it. */
function workerMounted(task, repositories, credentialFiles, repositoryId) {
  const mounted = workerRepository(repositories, credentialFiles, repositoryId);
  if (!task.authority.credentials.includes(mounted.credential))
    throw new Error(`worker authority does not grant ${mounted.credential}`);
  return { repository: mounted.repository, environment: mounted.environment };
}

/**
 * The remote one attempt reaches and the askpass environment it reaches it
 * with. The plane's mint answers where there is one, a read of the attempt's
 * own repository asked for by name, and the launcher's mount where there is
 * not — which is what answered before this plane minted anything, the
 * attempt's own credential roster included. `refresh` and `refreshApart` come
 * back only from the minted arm, there being nothing to take again in the other.
 */
export async function workerCredential(asked) {
  const { task, repositories, credentialFiles, repositoryId } = asked;
  const minted = await workerMinted({ ...asked, repository: repositoryId });
  if (minted === undefined)
    return workerMounted(task, repositories, credentialFiles, repositoryId);
  const repository = workerRepositoryUrl(repositories, repositoryId);
  return {
    repository,
    environment: workerCredentialEnvironment(
      minted.file,
      minted.username,
      repository,
    ),
    refresh: () => workerRefreshed(asked, repository),
    refreshApart: () => workerRefreshApart(asked, repository),
  };
}

/**
 * What one attempt works in: the repository its own bundle pinned, cloned with
 * the credential this pod resolved, that credential's `refresh` where the
 * plane minted it, and the commit the change started from where the bundle
 * names one the clone holds. `seams` names the plane, the clone, the file the
 * password is written to, the directory it is written in and the directory
 * cloned into, this module's own, the contract's and the image's
 * `CHUG_WORKER_WORKSPACE` where it names none. `images` are the
 * brief's images the bundle pins, where it pins any. A credential refused or a
 * clone failed fails the clone step.
 */
export async function workerWorkspace(
  task,
  repositories,
  credentialFiles,
  bearer,
  keepSecret,
  seams = {},
) {
  const {
    request = workerRequest,
    clone = cloneRepository,
    write,
    minted,
    workspace,
  } = seams;
  const input = await (
    await request(task, bearer, workerPlaneRoutes.input.path)
  ).json();
  const repositoryId = oneReference(input, "Repository");
  const base = oneReference(input, "TargetCommit");
  const { repository, environment, refresh, refreshApart, directory } =
    await runStep(
      runCloneFailed,
      async () => {
        const credential = await workerCredential({
          task,
          bearer,
          repositories,
          credentialFiles,
          repositoryId,
          keepSecret,
          request,
          ...(write === undefined ? {} : { write }),
          ...(minted === undefined ? {} : { directory: minted }),
        });
        const cloned = await clone(
          credential.repository,
          base,
          workspace ?? required(workerWorkspaceVariable),
          credential.environment,
        );
        return { ...credential, directory: cloned };
      },
      gitFailureLine,
    );
  const changeBase = await workerChangeBase(input, directory);
  const images = ticketImageReferences(input);
  return {
    repositoryId,
    repository,
    base,
    directory,
    environment,
    ...(refresh === undefined ? {} : { refresh, refreshApart }),
    ...(changeBase === undefined ? {} : { changeBase }),
    ...(images.length === 0 ? {} : { images }),
  };
}

async function diagnostic(context, path, result) {
  const content = Buffer.from(
    context.scrub(`${JSON.stringify(result, null, 2)}\n`),
  );
  return upload(context.task, context.bearer, path, content, context.request);
}

/**
 * The summary of a run that names where it is kept, uploaded as
 * `workerSummaryText` leaves it. No artifact where the run names nowhere, or
 * where that text is empty.
 */
async function summaryDiagnostics(context, path, summary) {
  if (path === undefined) return [];
  const content = Buffer.from(workerSummaryText(summary, context.scrub));
  if (content.byteLength === 0) return [];
  return [
    await upload(context.task, context.bearer, path, content, context.request),
  ];
}

async function report(context, manifest) {
  await context.request(
    context.task,
    context.bearer,
    workerPlaneRoutes.report.path,
    {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: JSON.stringify(resultDocument(manifest)),
    },
  );
}

/** What a report says of an agent whose summary left nothing printable. */
const reportSummaryBlank = "the agent's summary held no printable text";

/**
 * A run's summary as the report row accepts it, or a note that an agent's
 * summary had nothing printable, led by where a failed attempt's changes are
 * kept so that no length of summary cuts it.
 */
function reportSummary(summary, scrub, kept) {
  const text = workerReportText(summary, scrub) || reportSummaryBlank;
  return kept === undefined
    ? text
    : workerReportText(`${workSourceKept(kept)} ${text}`, scrub);
}

async function credentialValues(mounted) {
  const values = [];
  for (const path of mounted.slice(0, workerCredentialFilesMax)) {
    if (typeof path !== "string" || !path.startsWith("/")) continue;
    try {
      values.push((await readFile(path, "utf8")).trim());
    } catch {
      process.stderr.write(`worker credential ${path} could not be read\n`);
    }
  }
  return values;
}

/** The agent's credential as its file and the pod's environment prepare it. */
async function agentCredential(credentialFiles, agent) {
  const credentialFile = credentialFiles[agent.credential];
  if (typeof credentialFile !== "string")
    throw new Error(`worker credential ${agent.credential} is not mounted`);
  const token = (await readFile(credentialFile, "utf8")).trim();
  return agent.prepareCredential(token, {
    path: credentialFile,
    environment: process.env,
  });
}

/**
 * What a run is set up with: the agent's environment, the evidence recorder,
 * and the scrub over every secret this pod holds — the agent's own, the bearer,
 * and each file in `mounted`, which is every credential this pod's launcher
 * mounted whether or not the map names it. `held` answers those secrets with
 * their kinds, for the push to be checked against.
 */
export async function workerRun({
  task,
  bearer,
  credentialFiles,
  mounted,
  agent,
}) {
  const prepared =
    agent === undefined
      ? { environment: {}, secrets: [] }
      : await agentCredential(credentialFiles, agent);
  const agentKind = `the ${agent?.runtime ?? "agent"} credential`;
  const { scrub, keepSecret, held } = credentialScrubbing([
    ...prepared.secrets.map((value) => ({ kind: agentKind, value })),
    { kind: workerSecretKinds.bearer, value: bearer },
    ...(await credentialValues(mounted)).map((value) => ({
      kind: workerSecretKinds.mounted,
      value,
    })),
  ]);
  activeScrub = scrub;
  const evidence = runEvidenceRecorder(task, bearer, scrub);
  activeEvidence = evidence;
  return {
    agentEnvironment: prepared.environment,
    agentWithheld: prepared.withheld ?? [],
    scrub,
    keepSecret,
    held,
    evidence,
  };
}

function scrubbed(text) {
  return activeScrub === undefined ? text : activeScrub(text);
}

/** What the task must grant before it runs, and what an agent-run task needs on disk. */
async function admitWorkerTask(task, agent) {
  if (agent !== undefined) {
    if (!task.authority.credentials.includes(agent.credential))
      throw new Error(`worker authority does not grant ${agent.credential}`);
    await writeFile(
      workerTemporaryFile(agentResultSchemaName),
      JSON.stringify(agentResultSchema),
      { flag: "wx" },
    );
  }
  if (!task.authority.network || task.authority.filesystem !== workspaceWrite)
    throw new Error(
      "development worker requires network and workspace write authority",
    );
}

/** What ran and what it found: one agent's result, or one check stage's. */
export async function runWorkerTask(context, commands) {
  if (commands === undefined) return runAgent(context);
  const run = await runChecks(
    {
      directory: context.directory,
      setupEnvironment: context.setupEnvironment,
      heldCredentials: context.heldCredentials,
      changeBase: context.changeBase,
      job: context.job,
      git: context.git,
    },
    commands,
    { scrub: context.scrub },
  );
  return { ...run, diagnosticPath: checkDiagnosticPath };
}

/** The status the task route answers a task with, and the kind a work task is told from a session's by. */
const [taskAnswered] = answeredWith(
  workerPlaneAnswers.task,
  workerTaskAnswerSchema,
);
const workKind = workTaskAnswerSchema.shape.kind.value;

/** A reason there is no task to run, and whether the plane can still take this attempt's end. */
function envelopeTaskRefused(refused, settles) {
  return { refused, settles };
}

/**
 * The work task the task route answered, less its kind, or the session's
 * answer whole, or why there is none to run. The plane cannot take the end
 * where it refuses this pod's release, since it then refuses every route
 * alike, nor where the bearer is a session's, which the job plane never takes;
 * the task route's own stop shares the status the release refusal comes on.
 */
async function envelopeTaskRead(response) {
  const body = await response.json().catch(() => undefined);
  if (response.status === contractVersionRefusalStatus) {
    const version = contractVersionRefusalSchema.safeParse(body);
    if (version.success)
      return envelopeTaskRefused(
        `the worker plane serves contract ${version.data.accepted.min} to ${version.data.accepted.max}, and this pod speaks ${workerContractRelease}`,
        false,
      );
    const stopped =
      workerPlaneAnswers.task[contractVersionRefusalStatus].safeParse(body);
    return envelopeTaskRefused(
      `the worker plane holds no task for this attempt${stopped.success ? `: ${stopped.data.reason}` : ""}`,
      true,
    );
  }
  const answer = workerTaskAnswerSchema.safeParse(body);
  if (response.status !== taskAnswered || !answer.success)
    return envelopeTaskRefused(
      "the worker plane answered a task this pod cannot read",
      true,
    );
  const { kind, ...task } = answer.data;
  if (kind === workKind) return { task };
  return answer.data.model === undefined
    ? envelopeTaskRefused(
        `the worker plane answered a ${kind} session's task without the API, bounds and model a pool-held session is answered with`,
        false,
      )
    : { session: answer.data };
}

/** One refused attempt ended as a crashed run's is, with the refusal as its error text. */
async function envelopeTaskSettled(plane, bearer, request, message) {
  try {
    await reportWorkerFailureBeforeRun(plane, bearer, request, message);
  } catch {
    process.stderr.write("the refused attempt could not be ended\n");
  }
}

/**
 * The task a pool's envelope stands for, and which mode runs it: fetched from
 * the plane it names under the bearer it carries. A work task has that plane
 * joined back on as the one field a pushed document carries and the answer
 * does not; a session's answer is the session's launch to assemble.
 *
 * A REFUSAL ENDS THE ATTEMPT NOW RATHER THAN AT ITS LEASE. A pod that only
 * exited would leave the attempt running until its lease lapsed and the reaper
 * lost it; so where the plane can still take the end, it is settled here.
 */
export async function envelopeTask(envelope, request = workerRequest) {
  const plane = { workerPlane: { url: envelope.callbackUrl } };
  const read = await envelopeTaskRead(
    await request(
      plane,
      envelope.bearer,
      workerPlaneRoutes.task.path,
      {},
      { settled: [contractVersionRefusalStatus] },
    ),
  );
  if (read.task !== undefined)
    return { mode: "Work", task: { ...read.task, ...plane } };
  if (read.session !== undefined)
    return { mode: "Session", answer: read.session };
  if (read.settles)
    await envelopeTaskSettled(plane, envelope.bearer, request, read.refused);
  throw new Error(read.refused);
}

/**
 * The credential map an envelope stands for: the provider credential the pool
 * mounted, in the slot the task's agent reads it from. With no file, or no
 * agent, it is empty, and an agent then finds its credential unmounted exactly
 * as a pushed pod's does.
 */
export function envelopeCredentialFiles(envelope, agent) {
  return envelope.providerCredentialFile === undefined || agent === undefined
    ? {}
    : { [agent.credential]: envelope.providerCredentialFile };
}

/**
 * What the push path's launcher hands a pod beside its task document: the
 * credential map in its own variable and the bearer in the file the document
 * names, each read only once the attempt has been admitted.
 */
function documentLaunch(document) {
  return {
    task: async () => document,
    given: async () => {
      const credentialFiles = workerRepositories(
        required(workerCredentialFilesVariable),
      );
      return {
        credentialFiles,
        mounted: Object.values(credentialFiles),
        bearer: (
          await readFile(document.workerPlane.capabilityFile, "utf8")
        ).trim(),
      };
    },
  };
}

/**
 * What a pool's envelope stands for in their place, given the work task it was
 * answered. Its `timeoutSecsMax` is the pool's to enforce, as a Kubernetes
 * pool does at its pod's deadline, and is read only to tell whether a hold fits
 * before it. Its `outputBytesMax` names no channel, every one this pod writes to
 * the plane being bounded by the contract already, so it is not read here. Its
 * `bearer` is held from the start, so a task refused at admission still ends
 * its attempt.
 */
export function envelopeLaunch(envelope, task) {
  return {
    bearer: envelope.bearer,
    task: async () => task,
    given: async (agent) => ({
      credentialFiles: envelopeCredentialFiles(envelope, agent),
      mounted:
        envelope.providerCredentialFile === undefined
          ? []
          : [envelope.providerCredentialFile],
      bearer: envelope.bearer,
      workspace: envelope.workspace,
      timeoutSecsMax: envelope.timeoutSecsMax,
    }),
  };
}

/**
 * The directory a minted credential is written to, checked before an attempt
 * starts its work: a launcher that forgot to mount it would otherwise fail the
 * attempt only at the plane's first mint.
 */
export async function workerMintedWritable(directory) {
  const found = await stat(directory).catch(() => undefined);
  if (found === undefined)
    throw new Error(
      `the minted credential directory ${directory} does not exist; a pod is launched with it mounted writable`,
    );
  const writable =
    found.isDirectory() &&
    (await access(directory, constants.W_OK | constants.X_OK).then(
      () => true,
      () => false,
    ));
  if (!writable)
    throw new Error(
      `the minted credential directory ${directory} is not writable; a pod is launched with it mounted writable`,
    );
}

/**
 * The reads every git this attempt runs makes of the repositories its project
 * binds, its own among them, served under `minted` and asked of the plane
 * under the attempt's bearer, each password held among the attempt's secrets;
 * the image's git, run as its programs are, is asked its version.
 */
function workerProjectReads({
  task,
  bearer,
  repositoryId,
  minted,
  keepSecret,
  request = workerRequest,
}) {
  return projectReadsServed({
    repositoryId,
    directory: minted,
    mint: (repository) =>
      planeCredentialAnswered({
        task,
        bearer,
        path: workerCredentialPath,
        repository,
        request,
      }),
    keep: (value) => keepSecret({ kind: workerSecretKinds.read, value }),
    gitVersion: async () => (await command("git", ["--version"])).stdout,
  });
}

/**
 * The credentials the plane holds of those `task` grants and
 * `credentialFiles` does not hold, each kept among the attempt's secrets and
 * written under `minted`: the variables naming their files, as a job's shells
 * are handed them. One the pod already holds is overridden, which is logged by
 * its name alone.
 */
export async function workerHeldCredentials({
  task,
  bearer,
  credentialFiles,
  minted,
  keepSecret,
  request,
  environment = process.env,
  warn = (text) => process.stderr.write(text),
}) {
  const held = await heldCredentials({
    task,
    bearer,
    granted: task.authority.credentials,
    credentialFiles,
    directory: minted,
    keep: (value) => keepSecret({ kind: workerSecretKinds.held, value }),
    ...(request === undefined ? {} : { request }),
  });
  for (const { credential, variable } of held)
    if (Object.hasOwn(environment, variable))
      warn(
        `the held credential ${credential} is handed as ${variable}, over the value the job's environment set\n`,
      );
  return Object.fromEntries(held.map(({ variable, file }) => [variable, file]));
}

/**
 * What one attempt does in the workspace it cloned, every git it runs handed
 * `git` and every shell told which job it is in and handed its held
 * credentials' files: its setup, what an earlier attempt left put back on top
 * of it, its run, handed what that setup passed on, and what that run leaves
 * behind, a run that failed leaving its unfinished work.
 */
async function workerAttemptWorked(attempt, workspace, git) {
  const { task, bearer, evidence, scrub } = attempt;
  const handed = {
    heldCredentials: attempt.heldCredentials,
    changeBase: workspace.changeBase,
    job: workerJobEnvironment(task, workspace.repositoryId),
    git,
  };
  const setupEnvironment = await prepareWorker(
    task,
    workspace.directory,
    handed,
  );
  const aside = {
    clock: attempt.clock,
    runDeadlineMs: attempt.runDeadlineMs,
    asideCapMs: attempt.asideCapMs,
  };
  const working = { task, held: attempt.held, scrub, git, ...aside };
  const restored = await workCheckpointRestored(working, workspace);
  const { keep, keepAgain } = workKeptOnce(() =>
    workCheckpointed(working, workspace),
  );
  const run = await runWorkerTask(
    {
      task,
      bearer,
      directory: workspace.directory,
      ...handed,
      setupEnvironment,
      images: workspace.images,
      agentEnvironment: attempt.agentEnvironment,
      agentWithheld: attempt.agentWithheld,
      scrub,
      evidence,
      agent: attempt.agent,
      restored,
      keep,
      keepAgain,
      clock: attempt.clock,
      runDeadlineMs: attempt.runDeadlineMs,
    },
    attempt.commands,
  ).catch(async (failure) => {
    throw await workFailureKept(failure, keep);
  });
  await publishWorkerResult(
    {
      task,
      bearer,
      evidence,
      scrub,
      held: attempt.held,
      git,
      stopLease: attempt.stopLease,
      request: workerRequest,
      ...aside,
    },
    workspace,
    run,
  );
}

/**
 * When the pool stops this run: `timeoutSecsMax` seconds from this process's
 * start, which is as near as the pod can tell to when it was placed. Nothing
 * where the launch names no such bound.
 */
function workerRunDeadlineMs(timeoutSecsMax, clock) {
  if (timeoutSecsMax === undefined) return undefined;
  return clock.now() + (timeoutSecsMax - clock.uptimeSecs()) * 1_000;
}

/**
 * What an attempt holding its lease does: its credentials, its workspace and its
 * project reads taken, and the work done in them. Its evidence stops and its
 * reads close however that ends.
 */
async function workerAttemptLeased(
  attempt,
  { credentialFiles, repositories, minted, into, workspaceSeams },
) {
  const { task, bearer, keepSecret, evidence } = attempt;
  let reads;
  try {
    const heldCredentials = await workerHeldCredentials({
      task,
      bearer,
      credentialFiles,
      minted,
      keepSecret,
      request: workspaceSeams.request,
    });
    const workspace = await workerWorkspace(
      task,
      repositories,
      credentialFiles,
      bearer,
      keepSecret,
      { ...workspaceSeams, minted, workspace: into },
    );
    reads = await workerProjectReads({
      task,
      bearer,
      repositoryId: workspace.repositoryId,
      minted,
      keepSecret,
      request: workspaceSeams.request,
    });
    await workerAttemptWorked(
      { ...attempt, heldCredentials },
      workspace,
      reads.git,
    );
  } finally {
    evidence.stop();
    await reads?.close();
  }
}

/**
 * One attempt, run from its task onwards the same whichever carrier brought it.
 * `seams` are `workerWorkspace`'s, less the directory, which is the launch's;
 * `minted`, the directory checked, the git credential and the held credentials
 * written to and the reads served under in place of the contract's; `agent`,
 * run in place of the one the task names; and `clock`, what a held run tells
 * the time by, how long this process has run by, and waits on.
 */
export async function workerAttempt(launch, seams = {}) {
  const {
    minted = mintedCredentialDirectory,
    agent: standIn,
    clock = workerClock,
    asideCapMs,
    ...workspaceSeams
  } = seams;
  const task = await launch.task();
  activeTask = task;
  activeBearer = launch.bearer;
  const commands = workerCheckCommands(task);
  const agent =
    commands === undefined ? (standIn ?? workerAgent(task)) : undefined;
  await admitWorkerTask(task, agent);
  const repositories = optionalRepositories(workerRepositoriesVariable);
  const {
    credentialFiles,
    mounted,
    bearer,
    workspace: into,
    timeoutSecsMax,
  } = await launch.given(agent);
  activeBearer = bearer;
  const ran = await workerRun({
    task,
    bearer,
    credentialFiles,
    mounted,
    agent,
  });
  await workerMintedWritable(minted);
  const stopLease = keepWorkerLease(task, bearer);
  try {
    await workerAttemptLeased(
      {
        ...ran,
        task,
        bearer,
        agent,
        commands,
        stopLease,
        clock,
        runDeadlineMs: workerRunDeadlineMs(timeoutSecsMax, clock),
        asideCapMs,
      },
      { credentialFiles, repositories, minted, into, workspaceSeams },
    );
  } finally {
    await stopLease();
  }
}

/**
 * What a finished run leaves behind, in the order it has to leave it: the run's
 * totals reach the plane before the report that terminalizes the execution, so
 * a settled task never carries figures nothing wrote. `context.command` is the
 * seam a work attempt's push runs through, this module's own where it
 * is absent; `context.held` answers the secrets that push is checked for; and
 * `context.git` is the attempt's git configuration, which its commit is handed
 * with the hooks it runs.
 */
export async function publishWorkerResult(
  context,
  workspace,
  { output, result, diagnosticPath, summaryPath },
) {
  await context.evidence.finish();
  const { source, kept } = await workSource(context, workspace, result.verdict);
  const diagnostics = [
    await diagnostic(context, diagnosticPath, output),
    ...(await summaryDiagnostics(context, summaryPath, result.summary)),
  ];
  const clearing =
    result.verdict === "Pass"
      ? await workCheckpointClearing(context, workspace)
      : undefined;
  try {
    await context.stopLease();
    await report(context, {
      verdict: result.verdict,
      report: reportSummary(result.summary, context.scrub, kept),
      handoffs: [],
      ...(source === undefined ? {} : { source }),
      diagnostics,
    });
    await clearing?.clear();
  } finally {
    await clearing?.discard();
  }
}

/** The first line of an error text cut to fit the upload, saying how much of it was dropped before the end that follows. */
function reportWorkerFailureTextDropped(bytes) {
  return `The first ${String(bytes)} bytes of this error text were dropped; what follows is its end.\n`;
}

/**
 * An error text as it is uploaded: whole where the plane takes it, and
 * otherwise its end, after a first line saying how many bytes before it were
 * dropped. The end is what says why a run stopped. The cut is made where a
 * character starts, because a text that is not UTF-8 is one its read refuses
 * as corrupt.
 */
function reportWorkerFailureText(content) {
  if (content.byteLength <= workerPlaneUploadBytesMax) return content;
  let start =
    content.byteLength -
    (workerPlaneUploadBytesMax -
      Buffer.byteLength(reportWorkerFailureTextDropped(content.byteLength)));
  while ((content[start] & 0xc0) === 0x80) start += 1;
  return Buffer.concat([
    Buffer.from(reportWorkerFailureTextDropped(start)),
    content.subarray(start),
  ]);
}

/**
 * What a crashed run leaves behind: its figures, its error text, and the label
 * that ends the attempt, which is `step`'s where the run stopped at one. It
 * reports no verdict, because a run that died is a lost attempt and never a
 * failed task. The text is scrubbed whole before it is cut, so a secret the cut
 * would split is still matched.
 */
export async function reportWorkerFailure(
  { task, bearer, evidence, request = workerRequest, scrub = scrubbed, step },
  message,
) {
  await evidence?.finish();
  try {
    await upload(
      task,
      bearer,
      workerErrorPath,
      reportWorkerFailureText(Buffer.from(scrub(`${message}\n`))),
      request,
    );
  } catch {
    process.stderr.write("worker failure text could not be uploaded\n");
  }
  await evidence?.ended(step);
}

/**
 * A failure ended as a crashed run's is, where the run never began: its figures
 * are empty, and the bearer is the one secret it holds to scrub.
 */
async function reportWorkerFailureBeforeRun(
  task,
  bearer,
  request,
  message,
  step,
) {
  const scrub = credentialScrub([bearer]);
  await reportWorkerFailure(
    {
      task,
      bearer,
      evidence: runEvidenceRecorder(task, bearer, scrub, { request }),
      request,
      scrub,
      step,
    },
    message,
  );
}

/**
 * Which mode the pod was launched in. Exactly one task document must be set:
 * neither leaves the pod with nothing to do, and both would let a launcher's
 * environment decide which of two authorities the pod acts under. A chat
 * supervisor's session names its channel in place of either, and never beside
 * one.
 */
export function workerMode(environment) {
  const named = (name) => {
    const value = environment[name];
    return typeof value === "string" && value.length > 0;
  };
  const work = named(workerTaskVariable);
  const session = named(sessionTaskVariable);
  if (named(chatChannelVariable)) {
    if (work || session)
      throw new Error(
        `a chat supervisor's session is launched with ${chatChannelVariable} alone, never beside ${workerTaskVariable} or ${sessionTaskVariable}`,
      );
    return "Chat";
  }
  if (work && session)
    throw new Error(
      `a pod is launched with ${workerTaskVariable} or ${sessionTaskVariable}, never both`,
    );
  if (work) return "Work";
  if (session) return "Session";
  throw new Error(
    `a pod needs one of ${workerTaskVariable} and ${sessionTaskVariable}`,
  );
}

/**
 * What `CHUG_WORKER_TASK` carries: a task document, which is what the push
 * path's launcher writes, or a pool's envelope naming where to fetch one. It is
 * told by the fields each schema names, so a value naming fields of both, or of
 * neither, is refused rather than read as whichever it resembles more.
 */
export function workerTaskCarrier(value) {
  const names = (schema) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(schema.shape).some((field) => Object.hasOwn(value, field));
  const document = names(workTaskDocumentSchema);
  const envelope = names(poolEnvelopeSchema);
  if (document && envelope)
    throw new Error(
      `${workerTaskVariable} carries a task document and a pool envelope at once`,
    );
  if (document) return "Document";
  if (envelope) return "Envelope";
  throw new Error(
    `${workerTaskVariable} carries neither a task document nor a pool envelope`,
  );
}

/** The envelope a pool launched this pod with, refused naming the fields this pod cannot read. */
function envelopeRead(value) {
  const envelope = poolEnvelopeSchema.safeParse(value);
  if (!envelope.success)
    throw new Error(
      `${workerTaskVariable} carries a pool envelope this pod cannot read: ${envelope.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return envelope.data;
}

async function main() {
  const carried = parsed(workerTaskVariable);
  if (workerTaskCarrier(carried) === "Document")
    return workerAttempt(documentLaunch(carried));
  const envelope = envelopeRead(carried);
  const fetched = await envelopeTask(envelope);
  const host = process.env[hostJobVariable];
  if (fetched.mode === "Work")
    return workerAttempt(
      envelopeLaunch(envelope, fetched.task),
      host === undefined ? {} : { minted: jobHostPlaces(host).minted },
    );
  if (host !== undefined)
    throw new Error(
      "a session runs in a container, never on its runner's host",
    );
  const { sessionEnvelopeServices, sessionMain } =
    await import("./session.mjs");
  process.exitCode = await sessionMain(
    sessionEnvelopeServices(envelope, fetched.answer),
  );
}

/**
 * A session a chat supervisor runs as a user of its own: its envelope read
 * off the channel the supervisor names, its task fetched as a pool's session
 * fetches one, and the session run as a pool's runs, in the workspace, the
 * minted directory and the checkout the supervisor made for it. The channel's
 * end stops it.
 */
async function chatSessionMain(environment = process.env) {
  const channel = chatChannelOpened(
    new Socket({
      fd: Number(environment[chatChannelVariable]),
      readable: true,
      writable: false,
    }),
  );
  try {
    const envelope = {
      ...(await channel.envelope),
      workspace: required(workerWorkspaceVariable),
    };
    const checkout = chatCheckoutRead(required(chatCheckoutVariable));
    const fetched = await envelopeTask(envelope);
    if (fetched.mode !== "Session")
      throw new Error(
        "the worker plane answered a chat session's bearer with a work task",
      );
    const { sessionEnvelopeServices, sessionMain } =
      await import("./session.mjs");
    process.exitCode = await sessionMain({
      ...sessionEnvelopeServices(envelope, fetched.answer, environment),
      minted: required(chatMintedVariable),
      checkout: async () => checkout,
      stopped: channel.stopped,
    });
  } finally {
    channel.close();
  }
}

async function run() {
  const mode = workerMode(process.env);
  if (mode === "Work") return main();
  if (mode === "Chat") return chatSessionMain();
  const { sessionMain } = await import("./session.mjs");
  process.exitCode = await sessionMain();
}

async function reportActiveFailure(failure) {
  const message = scrubbed(
    failure instanceof Error ? failure.message : "worker failed",
  );
  const step = failure instanceof RunStepFailure ? failure.evidence : undefined;
  process.stderr.write(`${message}\n`);
  if (activeTask !== undefined && activeBearer !== undefined) {
    try {
      await (activeEvidence === undefined
        ? reportWorkerFailureBeforeRun(
            activeTask,
            activeBearer,
            workerRequest,
            message,
            step,
          )
        : reportWorkerFailure(
            {
              task: activeTask,
              bearer: activeBearer,
              evidence: activeEvidence,
              scrub: scrubbed,
              step,
            },
            message,
          ));
    } catch {
      process.stderr.write("worker failure could not be reported\n");
    }
  }
  process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  run().catch(reportActiveFailure);
