/**
 * The job host a chat host's thread attempt holds outside its model's own
 * tool calls: the jobs, watches and timers the thread sets through tools of
 * its session's chuggy server. The model runs only when woken and never
 * polls in a turn; what polls is a job, at no token cost.
 *
 * A WAKE IS THE PLANE'S THREAD WAKE AND NOTHING ELSE. A job exiting on its
 * own, a watch matching and a timer falling due are each offered through
 * `jobHostWakeSender`, naming the reason and the job, watch or timer's name
 * under an event identity of its own, and carrying no log text: the thread
 * reads a job's log, or the lines a watch matched, with its own tools, at the
 * paths the tools answer. A job `job_stop` ended wakes nobody.
 *
 * WHAT IT HOLDS OUTLIVES THE ATTEMPT AS A FILE, NOT AS A PROCESS. The thread's
 * user's processes end with its attempt (`./chatSession.mjs`), so every change
 * is written to `jobHostStateName` in the thread's directory, written whole
 * and renamed into place, and `restore` reads it back before the attempt's
 * first turn. A job that was running is started again where it was started
 * with `restart`, and recorded `AttemptEnded` otherwise; each one not started
 * again is offered as an `AttemptEnded` wake naming it, so a restore that only
 * starts jobs again wakes nobody, and the thread reads their new pids and logs
 * from `job_list` when next woken. A watch resumes at its file's end, and a
 * timer that fell due meanwhile fires at once. State that cannot be read is
 * taken to be empty, which is said.
 *
 * IT IS STANDING WHILE IT HOLDS A RUNNING JOB STARTED WITH `restart`, which is
 * reported to the plane once on restore and again whenever it changes, each
 * report after the one before it, and
 * it is busy while it holds a running job, a watch or a timer, which keeps
 * the mailbox's idle bound from ending the attempt under them.
 *
 * Every bound is one of the constants below, and each tool's description
 * states the ones it is held to from them.
 */

import { Buffer } from "node:buffer";
import { spawn as spawnDefault } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  allThreadJobWakeReasons,
  sessionIdentityCharsMax,
  sessionPlaneRoutes,
  sessionWokenAnswerSchema,
} from "@chuggy/worker-contract/sessionPlane";

import { rosterLabel } from "./wire.mjs";

/** The directory, in the thread's, the job host keeps its state, logs and matched lines in. */
export const jobHostDirectoryName = ".chuggy-job-host";

/** The file, in that directory, its state is written to. */
export const jobHostStateName = "state.json";

/** The tools the job host serves on the session's chuggy server. */
export const jobHostToolNames = {
  jobStart: "job_start",
  jobStop: "job_stop",
  jobList: "job_list",
  watch: "watch",
  unwatch: "unwatch",
  watchList: "watch_list",
  wakeAt: "wake_at",
  wakeCancel: "wake_cancel",
  wakeList: "wake_list",
};

/** The longest name a job or a watch is given, which its files are named by. */
export const jobHostNameCharsMax = 64;

/** What a job's or a watch's name is made of, so that it is a file's name and nothing else. */
const jobHostNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** The most jobs, watches and timers the host holds of each. */
export const jobHostJobsMax = 8;
export const jobHostWatchesMax = 8;
export const jobHostTimersMax = 8;

/** The longest command a job runs, path it is run in or is watched, pattern a watch matches and reason a timer is set for. */
export const jobHostCommandCharsMax = 512;
export const jobHostPathCharsMax = 1_024;
export const jobHostPatternCharsMax = 512;
export const jobHostReasonCharsMax = Math.min(256, sessionIdentityCharsMax);

/** The most matched lines one watch wake keeps, and how often a watch reads its file. */
export const jobHostWatchBatchLinesMax = 64;
export const jobHostWatchPollMs = 1_000;

/** The most of a watched file one read takes, and the most its matched lines are kept to before they are moved aside. */
export const jobHostWatchReadBytesMax = 1024 * 1024;
export const jobHostMatchedBytesMax = 1024 * 1024;

/** The longest a timer is set for. */
export const jobHostTimerSecsMax = 7 * 24 * 60 * 60;

/** How long `job_stop` waits on a job it ended before killing what is left of it. */
export const jobHostStopGraceMs = 10_000;

/** How often one wake is posted before it is dropped, the pause between, and the most waiting to be posted. */
export const jobHostWakeTriesMax = 5;
export const jobHostWakePauseMs = 5_000;
export const jobHostWakesQueuedMax = 64;

/** The largest state file read back. */
const jobHostStateBytesMax = 1024 * 1024;

const [jobExited, watchMatched, timerDue, attemptEnded] = [
  "JobExited",
  "WatchMatched",
  "TimerDue",
  "AttemptEnded",
].map((label) => rosterLabel(allThreadJobWakeReasons, label));

/** What `job_list` says of a job: running, exited on its own, ended by `job_stop`, or ended with an attempt. */
const jobRunning = "Running";
const jobExitedOwn = "Exited";
const jobStopped = "Stopped";
const jobAttemptEnded = "AttemptEnded";

/** What answers the plane's wake route, as `jobHostWakeSender` reads it. */
const wokenStatus = 200;
const deliveredWokens = new Set(["Woken", "AlreadyWoken"]);

/** `ms` later, `act` run, unless the returned function is called first. */
function jobHostSchedule(act, ms) {
  const timer = globalThis.setTimeout(act, ms);
  timer.unref?.();
  return () => globalThis.clearTimeout(timer);
}

/** Refused unless `name` is one a job's or a watch's file may be named by. */
function jobHostName(name) {
  if (
    typeof name !== "string" ||
    name.length > jobHostNameCharsMax ||
    !jobHostNamePattern.test(name)
  )
    throw new Error(
      `a name is 1 to ${String(jobHostNameCharsMax)} letters, digits, dots, underscores and hyphens, opening with a letter or digit`,
    );
  return name;
}

/** Refused unless `command` is one a job runs: well formed, and holding no control character but a tab or a line's end. */
function jobHostCommand(command) {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > jobHostCommandCharsMax ||
    !command.isWellFormed() ||
    /[^\P{Cc}\t\n]/u.test(command)
  )
    throw new Error(
      `a command is 1 to ${String(jobHostCommandCharsMax)} characters with no control character but a tab or a line's end`,
    );
  return command;
}

/** Refused unless `reason` is a timer's name a wake can carry. */
function jobHostReason(reason) {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > jobHostReasonCharsMax ||
    !reason.isWellFormed() ||
    /\p{Cc}/u.test(reason)
  )
    throw new Error(
      `a reason is 1 to ${String(jobHostReasonCharsMax)} characters with no control character`,
    );
  return reason;
}

/** Every place the host keeps its files in, under the thread's `directory`. */
export function jobHostPlaces(directory) {
  const root = join(directory, jobHostDirectoryName);
  return {
    root,
    state: join(root, jobHostStateName),
    logs: join(root, "logs"),
    matched: join(root, "matched"),
    log: (name) => join(root, "logs", `${name}.log`),
    matches: (name) => join(root, "matched", `${name}.log`),
  };
}

/** `path` resolved against the thread's `directory`, refused where it leaves it. */
function jobHostInside(directory, path) {
  const resolved = resolve(directory, path ?? ".");
  const within = relative(directory, resolved);
  if (within === ".." || within.startsWith(`..${sep}`) || within === resolved)
    throw new Error(`${path} is outside the thread's directory ${directory}`);
  return resolved;
}

/** Whether `value` is a record of the shape `fields` names, each field's type. */
function jobHostRecord(value, fields) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(fields).every(([field, type]) =>
      type.endsWith("?")
        ? value[field] === undefined ||
          typeof value[field] === type.slice(0, -1)
        : typeof value[field] === type,
    )
  );
}

/** The state `text` holds, or `undefined` where it is not one the host wrote. */
export function jobHostStateParsed(text) {
  let read;
  try {
    read = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { jobs, watches, timers } = read ?? {};
  if (![jobs, watches, timers].every(Array.isArray)) return undefined;
  const fine =
    jobs.every((job) =>
      jobHostRecord(job, {
        name: "string",
        command: "string",
        cwd: "string",
        restart: "boolean",
        status: "string",
      }),
    ) &&
    watches.every((watch) =>
      jobHostRecord(watch, {
        name: "string",
        path: "string",
        pattern: "string",
      }),
    ) &&
    timers.every((timer) =>
      jobHostRecord(timer, { reason: "string", dueAtMs: "number" }),
    );
  if (!fine) return undefined;
  try {
    for (const { name } of [...jobs, ...watches]) jobHostName(name);
    for (const { command } of jobs) jobHostCommand(command);
    for (const { reason } of timers) jobHostReason(reason);
    for (const { pattern } of watches) new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
  return {
    jobs: jobs.slice(0, jobHostJobsMax),
    watches: watches.slice(0, jobHostWatchesMax),
    timers: timers.slice(0, jobHostTimersMax),
  };
}

/** The state at `path`, empty where there is none, and empty where it cannot be read, which `warn` says. */
async function jobHostStateRead(path, warn) {
  const empty = { jobs: [], watches: [], timers: [] };
  let text;
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size > jobHostStateBytesMax)
        throw new Error(
          `it is larger than ${String(jobHostStateBytesMax)} bytes`,
        );
      text = await readFile(handle, "utf8");
    } finally {
      await handle.close();
    }
  } catch (failure) {
    if (failure?.code === "ENOENT") return empty;
    warn(
      `the job host's state at ${path} could not be read, and it starts empty: ${failure instanceof Error ? failure.message : String(failure)}\n`,
    );
    return empty;
  }
  const parsed = jobHostStateParsed(text);
  if (parsed === undefined)
    warn(
      `the job host's state at ${path} is not one it wrote, and it starts empty\n`,
    );
  return parsed ?? empty;
}

/** What one job is written as, and answered as by `job_list`. */
function jobHostJobWritten(job) {
  return {
    name: job.name,
    command: job.command,
    cwd: job.cwd,
    restart: job.restart,
    status: job.status,
    ...(job.pid === undefined ? {} : { pid: job.pid }),
    ...(job.code === undefined ? {} : { code: job.code }),
    ...(job.signal === undefined ? {} : { signal: job.signal }),
  };
}

/** What the host's state is written as. */
function jobHostStateWritten(host) {
  return {
    jobs: [...host.jobs.values()].map(jobHostJobWritten),
    watches: [...host.watches.values()].map(({ name, path, pattern }) => ({
      name,
      path,
      pattern,
    })),
    timers: [...host.timers.values()].map(({ reason, dueAtMs }) => ({
      reason,
      dueAtMs,
    })),
  };
}

/** The host's state written whole beside its file and renamed over it, after every write asked before it. */
function jobHostPersist(host) {
  const text = `${JSON.stringify(jobHostStateWritten(host))}\n`;
  const { state, root } = host.places;
  host.writing = host.writing.then(async () => {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const written = `${state}.${randomUUID()}`;
      await writeFile(written, text, { mode: 0o600 });
      await rename(written, state);
    } catch (failure) {
      host.warn(
        `the job host's state could not be written to ${state}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
  });
  return host.writing;
}

/** Whether the host holds a running job started with `restart`. */
function jobHostStanding(host) {
  return [...host.jobs.values()].some(
    (job) => job.status === jobRunning && job.restart,
  );
}

/** The host's standing told the plane where it is not what was last told, after every report asked before it. */
function jobHostStandingChanged(host) {
  const standing = jobHostStanding(host);
  if (host.closing || standing === host.told) return;
  host.told = standing;
  host.reporting = host.reporting.then(() =>
    host.standing(standing).catch((failure) => {
      host.warn(
        `the thread's standing could not be reported: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }),
  );
}

/** One wake offered for `resource`, under an event identity of its own. */
function jobHostWake(host, wake, resource) {
  if (host.closing) return;
  host.wake({ wake, resource, event: randomUUID() });
}

/** A previous log of `path` moved aside, so a job's start keeps the run before it and no other. */
async function jobHostLogTurned(path) {
  try {
    await rename(path, `${path}.1`);
  } catch (failure) {
    if (failure?.code !== "ENOENT") throw failure;
  }
}

/**
 * `job` started: `/bin/sh -c` its command in a process group of its own, as
 * the attempt's user, in its directory, its output and error both its log.
 */
async function jobHostSpawned(host, job) {
  const log = host.places.log(job.name);
  await mkdir(host.places.logs, { recursive: true, mode: 0o700 });
  await jobHostLogTurned(log);
  const handle = await open(log, "w", 0o600);
  let child;
  let exited;
  try {
    child = host.spawn("/bin/sh", ["-c", job.command], {
      cwd: job.cwd,
      env: host.environment,
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
    });
    // Heard before any await, so an exit that comes while the log closes is kept.
    exited = new Promise((heard) => {
      child.once("exit", (code, signal) => heard({ code, signal }));
    });
    await new Promise((resolved, refused) => {
      child.once("error", refused);
      child.once("spawn", () => {
        child.off("error", refused);
        resolved();
      });
    });
  } finally {
    await handle.close();
  }
  child.on("error", () => undefined);
  child.unref();
  const running = { ...job, status: jobRunning, pid: child.pid, child };
  host.jobs.set(job.name, running);
  running.ended = exited.then(({ code, signal }) => {
    jobHostExited(host, running, code, signal);
  });
  return running;
}

/** What a job's own exit makes of it: `Exited`, waking the thread, or `Stopped` where `job_stop` ended it. */
function jobHostExited(host, job, code, signal) {
  if (host.closing || host.jobs.get(job.name) !== job) return;
  host.jobs.set(job.name, {
    ...jobHostJobWritten(job),
    status: job.stopping ? jobStopped : jobExitedOwn,
    pid: undefined,
    ...(code === null ? {} : { code }),
    ...(signal === null ? {} : { signal }),
  });
  void jobHostPersist(host);
  jobHostStandingChanged(host);
  if (!job.stopping) jobHostWake(host, jobExited, job.name);
}

/** A signal sent to `job`'s process group, which may have gone already. */
function jobHostSignalled(host, job, signal) {
  try {
    host.kill(-job.pid, signal);
  } catch (failure) {
    if (failure?.code !== "ESRCH") throw failure;
  }
}

/** Whether `promise` settles within `ms`. */
function jobHostWithin(host, promise, ms) {
  return new Promise((settled) => {
    const cancel = host.schedule(() => settled(false), ms);
    void promise.then(() => {
      cancel();
      settled(true);
    });
  });
}

/** `job_start`: a job named `name` started, or refused where one of that name runs or the host holds its most. */
async function jobHostStart(host, { name, command, cwd, restart = false }) {
  jobHostName(name);
  jobHostCommand(command);
  const held = host.jobs.get(name);
  if (held?.status === jobRunning)
    throw new Error(
      `a job named ${name} is running; ${jobHostToolNames.jobStop} it first`,
    );
  if (held === undefined && host.jobs.size >= jobHostJobsMax)
    throw new Error(
      `the host holds its ${String(jobHostJobsMax)} jobs; ${jobHostToolNames.jobStop} one that is not running to forget it`,
    );
  const job = await jobHostSpawned(host, {
    name,
    command,
    cwd: jobHostInside(host.directory, cwd),
    restart,
  });
  await jobHostPersist(host);
  jobHostStandingChanged(host);
  return jobHostAnswer(host, job);
}

/** `job_stop`: a running job ended, TERM then KILL past the grace, or one that is not running forgotten. */
async function jobHostStop(host, { name }) {
  const job = host.jobs.get(jobHostName(name));
  if (job === undefined) throw new Error(`no job is named ${name}`);
  if (job.status !== jobRunning) {
    host.jobs.delete(name);
    await jobHostPersist(host);
    return `the job ${name}, which was not running, is forgotten`;
  }
  job.stopping = true;
  jobHostSignalled(host, job, "SIGTERM");
  if (!(await jobHostWithin(host, job.ended, host.stopGraceMs))) {
    jobHostSignalled(host, job, "SIGKILL");
    await job.ended;
  }
  await host.writing;
  return jobHostAnswer(host, host.jobs.get(name));
}

/** What a tool answers of one job. */
function jobHostAnswer(host, job) {
  return JSON.stringify({
    ...jobHostJobWritten(job),
    log: host.places.log(job.name),
  });
}

/** `job_list`: every job the host holds, each without the directory it runs in, which keeps the list inside one answer. */
function jobHostList(host) {
  return JSON.stringify(
    [...host.jobs.values()].map((job) => {
      const listed = jobHostJobWritten(job);
      delete listed.cwd;
      return { ...listed, log: host.places.log(job.name) };
    }),
  );
}

/** What a watched file holds past `offset`, as whole lines, and where the next read starts. */
async function jobHostWatchRead(path, offset) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (failure) {
    if (failure?.code === "ENOENT") return { lines: [], offset };
    throw failure;
  }
  try {
    const { size } = await handle.stat();
    const from = size < offset ? 0 : offset;
    const length = Math.min(size - from, jobHostWatchReadBytesMax);
    if (length <= 0) return { lines: [], offset: from };
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, from);
    const read = bytes.subarray(0, bytesRead);
    const end = read.lastIndexOf(0x0a);
    const whole =
      end >= 0
        ? read.subarray(0, end + 1)
        : length === jobHostWatchReadBytesMax
          ? read
          : undefined;
    if (whole === undefined) return { lines: [], offset: from };
    const lines = whole.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { lines, offset: from + whole.length };
  } finally {
    await handle.close();
  }
}

/** Matched lines added to a watch's file, which is moved aside past its bound. */
async function jobHostMatchesKept(host, name, lines, unkept) {
  const path = host.places.matches(name);
  await mkdir(host.places.matched, { recursive: true, mode: 0o700 });
  const size = await stat(path).then(
    ({ size: held }) => held,
    () => 0,
  );
  if (size > jobHostMatchedBytesMax) await rename(path, `${path}.1`);
  const more =
    unkept === 0
      ? []
      : [`(${String(unkept)} more matched lines were not kept)`];
  await appendFile(path, `${[...lines, ...more].join("\n")}\n`, {
    mode: 0o600,
  });
}

/** One read of one watch's file, waking the thread once for whatever of it matched. */
async function jobHostWatchPolled(host, watch) {
  const { lines, offset } = await jobHostWatchRead(watch.path, watch.offset);
  if (host.watches.get(watch.name) !== watch) return;
  watch.offset = offset;
  const matched = lines.filter((line) => watch.regex.test(line));
  if (matched.length === 0) return;
  const kept = matched.slice(0, jobHostWatchBatchLinesMax);
  await jobHostMatchesKept(
    host,
    watch.name,
    kept,
    matched.length - kept.length,
  );
  jobHostWake(host, watchMatched, watch.name);
}

/** Every watch read once, and the next reads scheduled while any is held. */
async function jobHostWatchesPolled(host) {
  host.polling = undefined;
  for (const watch of [...host.watches.values()]) {
    if (host.closing) return;
    try {
      await jobHostWatchPolled(host, watch);
    } catch (failure) {
      host.warn(
        `the watch ${watch.name} could not read ${watch.path}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
  }
  jobHostWatchesScheduled(host);
}

/** The next read of every watch, where one is held and none is scheduled. */
function jobHostWatchesScheduled(host) {
  if (host.closing || host.polling !== undefined || host.watches.size === 0)
    return;
  host.polling = host.schedule(() => {
    void jobHostWatchesPolled(host);
  }, host.watchPollMs);
}

/** A watch of `path` from its end as it is now. */
async function jobHostWatchOpened(host, { name, path, pattern }) {
  const regex = new RegExp(pattern, "u");
  const offset = await stat(path).then(
    ({ size }) => size,
    () => 0,
  );
  const watch = { name, path, pattern, regex, offset };
  host.watches.set(name, watch);
  jobHostWatchesScheduled(host);
  return watch;
}

/** `watch`: a watch named `name` of `path`'s new lines matching `pattern`, replacing one of that name. */
async function jobHostWatchAdd(host, { name, path, pattern }) {
  jobHostName(name);
  if (!host.watches.has(name) && host.watches.size >= jobHostWatchesMax)
    throw new Error(
      `the host holds its ${String(jobHostWatchesMax)} watches; ${jobHostToolNames.unwatch} one first`,
    );
  try {
    new RegExp(pattern, "u");
  } catch (failure) {
    throw new Error(
      `the pattern is not a regular expression: ${failure.message}`,
      { cause: failure },
    );
  }
  const watch = await jobHostWatchOpened(host, {
    name,
    path: resolve(host.directory, path),
    pattern,
  });
  await jobHostPersist(host);
  return JSON.stringify(jobHostWatchAnswer(host, watch));
}

/** What a tool answers of one watch. */
function jobHostWatchAnswer(host, { name, path, pattern }) {
  return { name, path, pattern, matched: host.places.matches(name) };
}

/** `unwatch`: the watch named `name` ended. */
async function jobHostUnwatch(host, { name }) {
  if (!host.watches.delete(jobHostName(name)))
    throw new Error(`no watch is named ${name}`);
  await jobHostPersist(host);
  return `the watch ${name} is ended; what it matched stays at ${host.places.matches(name)}`;
}

/** A timer armed for when it falls due, at once where it has, and no further off than the longest a timer is set for. */
function jobHostTimerArmed(host, timer) {
  timer.cancel = host.schedule(
    () => jobHostTimerFired(host, timer),
    Math.min(
      Math.max(0, timer.dueAtMs - host.now()),
      jobHostTimerSecsMax * 1_000,
    ),
  );
  host.timers.set(timer.reason, timer);
}

/** A timer that fell due, forgotten, and its thread woken; one that has not yet is armed again. */
function jobHostTimerFired(host, timer) {
  if (host.closing || host.timers.get(timer.reason) !== timer) return;
  if (host.now() < timer.dueAtMs) return jobHostTimerArmed(host, timer);
  host.timers.delete(timer.reason);
  void jobHostPersist(host);
  jobHostWake(host, timerDue, timer.reason);
}

/** `wake_at`: a timer `seconds` from now for `reason`, replacing one for the same reason. */
async function jobHostWakeAt(host, { seconds, reason }) {
  jobHostReason(reason);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > jobHostTimerSecsMax
  )
    throw new Error(`a timer is 1 to ${String(jobHostTimerSecsMax)} seconds`);
  const held = host.timers.get(reason);
  if (held === undefined && host.timers.size >= jobHostTimersMax)
    throw new Error(
      `the host holds its ${String(jobHostTimersMax)} timers; ${jobHostToolNames.wakeCancel} one first`,
    );
  held?.cancel();
  const timer = { reason, dueAtMs: host.now() + seconds * 1_000 };
  jobHostTimerArmed(host, timer);
  await jobHostPersist(host);
  return JSON.stringify(jobHostTimerAnswer(timer));
}

/** What a tool answers of one timer. */
function jobHostTimerAnswer({ reason, dueAtMs }) {
  return { reason, dueAt: new Date(dueAtMs).toISOString() };
}

/** `wake_cancel`: the timer for `reason` cancelled. */
async function jobHostWakeCancel(host, { reason }) {
  const timer = host.timers.get(jobHostReason(reason));
  if (timer === undefined) throw new Error(`no timer is set for ${reason}`);
  timer.cancel();
  host.timers.delete(reason);
  await jobHostPersist(host);
  return `the timer for ${reason} is cancelled`;
}

/** One job the restore found running: started again where it was started with `restart`, `AttemptEnded` otherwise, and whether it was started again. */
async function jobHostJobRestored(host, job) {
  if (job.restart)
    try {
      await jobHostSpawned(host, {
        name: job.name,
        command: job.command,
        cwd: jobHostInside(host.directory, job.cwd),
        restart: true,
      });
      return true;
    } catch (failure) {
      host.warn(
        `the job ${job.name} could not be started again: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
  host.jobs.set(job.name, {
    ...job,
    status: jobAttemptEnded,
    pid: undefined,
    code: undefined,
    signal: undefined,
  });
  return false;
}

/**
 * What the thread's directory holds of the host, restored before the
 * attempt's first turn, its changes written back and its wakes offered, and
 * its standing reported, whose refusal raises.
 */
async function jobHostRestore(host) {
  const read = await jobHostStateRead(host.places.state, host.warn);
  let changed = false;
  const ended = [];
  for (const job of read.jobs)
    if (job.status === jobRunning) {
      changed = true;
      if (!(await jobHostJobRestored(host, job))) ended.push(job.name);
    } else host.jobs.set(job.name, job);
  for (const watch of read.watches) await jobHostWatchOpened(host, watch);
  const due = read.timers.filter(({ dueAtMs }) => dueAtMs <= host.now());
  for (const timer of read.timers)
    if (!due.includes(timer)) jobHostTimerArmed(host, { ...timer });
  if (changed || due.length > 0) await jobHostPersist(host);
  for (const name of ended) jobHostWake(host, attemptEnded, name);
  for (const { reason } of due) jobHostWake(host, timerDue, reason);
  const standing = jobHostStanding(host);
  host.told = standing;
  const reported = host.reporting.then(() => host.standing(standing));
  host.reporting = reported.catch(() => {});
  await reported;
}

/**
 * The host's end with its attempt's: nothing more is written, woken or
 * reported, and every running job's group is asked to end, its state left
 * running for the next attempt's restore.
 */
async function jobHostClose(host) {
  host.closing = true;
  host.polling?.();
  for (const timer of host.timers.values()) timer.cancel?.();
  await host.writing;
  for (const job of host.jobs.values())
    if (job.status === jobRunning)
      try {
        jobHostSignalled(host, job, "SIGTERM");
      } catch (failure) {
        host.warn(
          `the job ${job.name} could not be ended: ${String(failure)}\n`,
        );
      }
}

/**
 * The job host of a thread whose directory is `directory`, its jobs run on
 * `environment`. `wake` offers one wake, `standing` reports the thread's
 * standing, and `warn` writes on the attempt's output; `now`, `schedule`,
 * `spawn` and `kill` are seams a suite stands in for.
 */
export function jobHost(services) {
  const host = {
    directory: services.directory,
    environment: services.environment,
    places: jobHostPlaces(services.directory),
    wake: services.wake,
    standing: services.standing,
    warn: services.warn,
    now: services.now ?? Date.now,
    schedule: services.schedule ?? jobHostSchedule,
    spawn: services.spawn ?? spawnDefault,
    kill: services.kill ?? ((pid, signal) => process.kill(pid, signal)),
    stopGraceMs: services.stopGraceMs ?? jobHostStopGraceMs,
    watchPollMs: services.watchPollMs ?? jobHostWatchPollMs,
    jobs: new Map(),
    watches: new Map(),
    timers: new Map(),
    writing: Promise.resolve(),
    reporting: Promise.resolve(),
    told: undefined,
    polling: undefined,
    closing: false,
  };
  return {
    restore: () => jobHostRestore(host),
    close: () => jobHostClose(host),
    busy: () =>
      host.watches.size > 0 ||
      host.timers.size > 0 ||
      [...host.jobs.values()].some((job) => job.status === jobRunning),
    settled: async () => {
      await host.writing;
      await host.reporting;
    },
    definitions: jobHostDefinitions(host),
  };
}

/** A job's or a watch's name, as its tools take it. */
const jobHostNameShape = (z) =>
  z
    .string()
    .min(1)
    .max(jobHostNameCharsMax)
    .regex(jobHostNamePattern)
    .describe(
      `1 to ${String(jobHostNameCharsMax)} letters, digits, dots, underscores and hyphens, opening with a letter or digit; it names the files the host keeps for it.`,
    );

/** A timer's reason, as its tools take it. */
const jobHostReasonShape = (z) =>
  z
    .string()
    .min(1)
    .max(jobHostReasonCharsMax)
    .describe(
      `Why the thread is to be woken, 1 to ${String(jobHostReasonCharsMax)} characters; it names the timer, and the wake carries it.`,
    );

/** What every wake the host offers is, which each tool that sets one says. */
const jobHostWakeSays = `A wake is a turn of this thread naming why and the name, and carrying no text of what happened.`;

/** The job tools. */
function jobHostJobDefinitions(host) {
  const { jobStart, jobStop, jobList } = jobHostToolNames;
  return [
    {
      name: jobStart,
      description: `Starts a command as a job that runs on outside your turns, as /bin/sh -c in a process group of its own, its output and error written to its log. It wakes this thread when it exits on its own, and never when ${jobStop} ends it. ${jobHostWakeSays} With \`restart\`, a job running when this attempt ends is started again by the thread's next attempt, which keeps an attempt running for the thread while it runs; without it, the next attempt only says it ended. The host holds at most ${String(jobHostJobsMax)} jobs. Answers its pid and its log's path, which you read with your own tools.`,
      shape: (z) => ({
        name: jobHostNameShape(z),
        command: z
          .string()
          .min(1)
          .max(jobHostCommandCharsMax)
          .describe(
            `The command, 1 to ${String(jobHostCommandCharsMax)} characters with no control character but a tab or a line's end, run by /bin/sh -c.`,
          ),
        cwd: z
          .string()
          .min(1)
          .max(jobHostPathCharsMax)
          .describe(
            `The directory it runs in, inside the thread's directory ${host.directory}, which it is where left out.`,
          )
          .optional(),
        restart: z
          .boolean()
          .describe(
            "Whether the thread's next attempt starts it again where it was running as this one ended.",
          )
          .optional(),
      }),
      call: (_context, args) => jobHostStart(host, args),
    },
    {
      name: jobStop,
      description: `Ends a running job: TERM to its process group, then KILL past ${String(jobHostStopGraceMs / 1_000)} seconds. It forgets a job that is not running.`,
      shape: (z) => ({ name: jobHostNameShape(z) }),
      call: (_context, args) => jobHostStop(host, args),
    },
    {
      name: jobList,
      description: `Lists every job the host holds, with its command, its pid while it runs, its status and its log's path. A status is Running, Exited with its code or signal, Stopped by ${jobStop}, or AttemptEnded where an attempt ended under it.`,
      shape: () => ({}),
      call: () => jobHostList(host),
    },
  ];
}

/** The watch tools. */
function jobHostWatchDefinitions(host) {
  const { watch, unwatch, watchList } = jobHostToolNames;
  return [
    {
      name: watch,
      description: `Wakes this thread on new lines of a file that match a regular expression, read every ${String(jobHostWatchPollMs / 1_000)} seconds from the file's end as it is now. ${jobHostWakeSays} Each read that matched wakes it once, keeping at most ${String(jobHostWatchBatchLinesMax)} of its lines in the matched file it answers, which you read with your own tools. The host holds at most ${String(jobHostWatchesMax)} watches, and one of the same name is replaced.`,
      shape: (z) => ({
        name: jobHostNameShape(z),
        path: z
          .string()
          .min(1)
          .max(jobHostPathCharsMax)
          .describe(
            `The file, relative to the thread's directory ${host.directory} or absolute.`,
          ),
        pattern: z
          .string()
          .min(1)
          .max(jobHostPatternCharsMax)
          .describe(
            `A JavaScript regular expression, 1 to ${String(jobHostPatternCharsMax)} characters, which a line matches anywhere in it.`,
          ),
      }),
      call: (_context, args) => jobHostWatchAdd(host, args),
    },
    {
      name: unwatch,
      description: "Ends a watch; what it matched stays in its matched file.",
      shape: (z) => ({ name: jobHostNameShape(z) }),
      call: (_context, args) => jobHostUnwatch(host, args),
    },
    {
      name: watchList,
      description:
        "Lists every watch the host holds: its file, its pattern and its matched file's path.",
      shape: () => ({}),
      call: () =>
        JSON.stringify(
          [...host.watches.values()].map((held) =>
            jobHostWatchAnswer(host, held),
          ),
        ),
    },
  ];
}

/** The timer tools. */
function jobHostTimerDefinitions(host) {
  const { wakeAt, wakeCancel, wakeList } = jobHostToolNames;
  return [
    {
      name: wakeAt,
      description: `Wakes this thread once, a number of seconds from now, for a reason. ${jobHostWakeSays} A timer that falls due while no attempt runs fires as the next one starts. The host holds at most ${String(jobHostTimersMax)} timers, and one for the same reason is replaced.`,
      shape: (z) => ({
        seconds: z
          .number()
          .int()
          .min(1)
          .max(jobHostTimerSecsMax)
          .describe(
            `How long from now, 1 to ${String(jobHostTimerSecsMax)} seconds.`,
          ),
        reason: jobHostReasonShape(z),
      }),
      call: (_context, args) => jobHostWakeAt(host, args),
    },
    {
      name: wakeCancel,
      description: `Cancels the timer ${wakeAt} set for a reason.`,
      shape: (z) => ({ reason: jobHostReasonShape(z) }),
      call: (_context, args) => jobHostWakeCancel(host, args),
    },
    {
      name: wakeList,
      description:
        "Lists every timer the host holds: its reason and when it falls due.",
      shape: () => ({}),
      call: () =>
        JSON.stringify([...host.timers.values()].map(jobHostTimerAnswer)),
    },
  ];
}

/** Every tool the host serves, as `./chuggyTools.mjs` defines a tool. */
function jobHostDefinitions(host) {
  return [
    ...jobHostJobDefinitions(host),
    ...jobHostWatchDefinitions(host),
    ...jobHostTimerDefinitions(host),
  ];
}

/** What the plane's wake route answered one offer with, in words, or nothing where it woke the thread. */
async function jobHostWakeAnswer(response) {
  const body = await response.json().catch(() => undefined);
  if (response.status === wokenStatus) {
    const woken = sessionWokenAnswerSchema.safeParse(body);
    if (!woken.success) return `an answer it could not read`;
    return deliveredWokens.has(woken.data.woken) ? undefined : woken.data.woken;
  }
  return `${String(response.status)}${typeof body?.reason === "string" ? ` ${body.reason}` : ""}`;
}

/**
 * The wakes a host offers, posted to the plane's wake route one at a time in
 * the order offered. An offer the plane answered with anything but a wake,
 * `Backlogged`, `Closed` and `NoThread` among them, is dropped and said on
 * `warn`; a post that failed is posted again under the same event identity,
 * at most `jobHostWakeTriesMax` times, and then dropped and said. At most
 * `jobHostWakesQueuedMax` wait, and one past that is dropped and said.
 */
export function jobHostWakeSender(task, bearer, services) {
  const { request, pause, warn } = services;
  const queued = [];
  let posting = Promise.resolve();
  let closed = false;
  const said = (offer, what) =>
    warn(
      `the ${offer.wake} wake for ${offer.resource} ${what}, and is dropped\n`,
    );
  const post = async (offer) => {
    for (let tries = 1; tries <= jobHostWakeTriesMax && !closed; tries += 1) {
      try {
        const response = await request(
          task,
          bearer,
          sessionPlaneRoutes.wake.path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(offer),
          },
        );
        const refused = await jobHostWakeAnswer(response);
        if (refused !== undefined) said(offer, `was answered ${refused}`);
        return;
      } catch (failure) {
        warn(
          `the ${offer.wake} wake for ${offer.resource} could not be posted: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        );
        if (tries < jobHostWakeTriesMax) await pause(jobHostWakePauseMs);
      }
    }
    said(
      offer,
      closed
        ? "was not posted before the attempt ended"
        : `failed ${String(jobHostWakeTriesMax)} posts`,
    );
  };
  return {
    offer: (offer) => {
      if (closed) return;
      if (queued.length >= jobHostWakesQueuedMax)
        return said(
          offer,
          `found ${String(jobHostWakesQueuedMax)} wakes waiting`,
        );
      queued.push(offer);
      posting = posting.then(() => post(queued.shift()));
    },
    settled: () => posting,
    close: () => {
      closed = true;
    },
  };
}
