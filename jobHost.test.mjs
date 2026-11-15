import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { allThreadJobWakeReasons } from "@chuggy/worker-contract/sessionPlane";

import {
  chuggyToolAnswerBytes,
  chuggyToolAnswerBytesMax,
} from "./chuggyTools.mjs";
import {
  jobHost,
  jobHostCommandCharsMax,
  jobHostJobsMax,
  jobHostNameCharsMax,
  jobHostPlaces,
  jobHostTimerSecsMax,
  jobHostTimersMax,
  jobHostToolNames,
  jobHostWakeSender,
  jobHostWakeTriesMax,
  jobHostWatchBatchLinesMax,
  jobHostWatchesMax,
} from "./jobHost.mjs";

/** How often a case looks again for what it waits on, and the most it waits. */
const untilPollMs = 10;
const untilWaitMs = 10_000;

/** `holds()` once it holds, polled every `untilPollMs`, refused past `untilWaitMs`. */
async function until(holds, what) {
  const began = Date.now();
  for (;;) {
    const held = await holds();
    if (held) return held;
    if (Date.now() - began > untilWaitMs) throw new Error(`never: ${what}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, untilPollMs));
  }
}

/** A clock a case moves by hand, and the timers it fires as it moves. */
function handClock(start = 1_700_000_000_000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    schedule: (act, ms) => {
      const timer = { act, at: now + ms, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
    advance: (ms) => {
      now += ms;
      for (const timer of timers.filter(({ done, at }) => !done && at <= now)) {
        timer.done = true;
        timer.act();
      }
    },
    armed: () => timers.filter(({ done }) => !done).length,
  };
}

/** A thread's directory of its own, and a host over it whose wakes, standings and lines are kept. */
async function hostOf(t, seams = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-job-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = handClock();
  const wakes = [];
  const standings = [];
  const warned = [];
  const open = () =>
    jobHost({
      directory,
      environment: { PATH: process.env.PATH, JOB_HOST_CASE: "case" },
      wake: (offer) => wakes.push(offer),
      standing: async (standing) => {
        standings.push(standing);
      },
      warn: (text) => warned.push(text),
      now: clock.now,
      schedule: clock.schedule,
      ...seams,
    });
  const host = open();
  t.after(() => host.close());
  const tool = (opened, name) =>
    opened.definitions.find((definition) => definition.name === name);
  const call = async (name, args = {}, opened = host) =>
    tool(opened, name).call(undefined, args);
  return { directory, clock, wakes, standings, warned, host, open, call, tool };
}

/** The state the host last wrote. */
async function stateOf(directory) {
  return JSON.parse(await readFile(jobHostPlaces(directory).state, "utf8"));
}

test("every wake the host offers is one the contract's job wake roster carries", () => {
  for (const reason of [
    "JobExited",
    "WatchMatched",
    "TimerDue",
    "AttemptEnded",
  ])
    assert.ok(allThreadJobWakeReasons.includes(reason), reason);
});

test("a job runs its command in the thread's directory on the runtime's environment, logs both its outputs, and wakes the thread naming it alone when it exits on its own", async (t) => {
  const { directory, wakes, host, call } = await hostOf(t);

  const started = JSON.parse(
    await call(jobHostToolNames.jobStart, {
      name: "poll",
      command: 'pwd; echo "$JOB_HOST_CASE"; echo oops >&2; exit 3',
    }),
  );

  assert.equal(started.status, "Running");
  assert.equal(started.log, jobHostPlaces(directory).log("poll"));
  await until(() => wakes.length > 0, "the job's wake");
  await host.settled();
  assert.equal(wakes.length, 1);
  assert.deepEqual(Object.keys(wakes[0]).sort(), ["event", "resource", "wake"]);
  assert.equal(wakes[0].wake, "JobExited");
  assert.equal(wakes[0].resource, "poll");
  assert.deepEqual((await readFile(started.log, "utf8")).split("\n"), [
    directory,
    "case",
    "oops",
    "",
  ]);
  const [listed] = JSON.parse(await call(jobHostToolNames.jobList));
  assert.equal(listed.status, "Exited");
  assert.equal(listed.code, 3);
  assert.equal(listed.pid, undefined);
  assert.equal((await stateOf(directory)).jobs[0].status, "Exited");
});

test("a job that exits while its log is still being closed is heard: it ends Exited and wakes the thread", async (t) => {
  const { EventEmitter } = await import("node:events");
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      unref: () => undefined,
    });
    process.nextTick(() => {
      child.emit("spawn");
      child.emit("exit", 0, null);
    });
    return child;
  };
  const { directory, wakes, host, call } = await hostOf(t, { spawn });

  await call(jobHostToolNames.jobStart, { name: "quick", command: "exit 0" });

  await until(() => wakes.length > 0, "the job's wake");
  await host.settled();
  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["JobExited", "quick"]],
  );
  assert.equal((await stateOf(directory)).jobs[0].status, "Exited");
  assert.equal(host.busy(), false);
});

test("every job whose command exits at once ends Exited and wakes the thread", async (t) => {
  const { wakes, host, call } = await hostOf(t);

  for (let index = 0; index < jobHostJobsMax; index += 1)
    await call(jobHostToolNames.jobStart, {
      name: `quick-${String(index)}`,
      command: "exit 0",
    });

  await until(() => wakes.length === jobHostJobsMax, "every job's wake");
  await host.settled();
  assert.ok(wakes.every(({ wake }) => wake === "JobExited"));
  assert.ok(
    JSON.parse(await call(jobHostToolNames.jobList)).every(
      ({ status }) => status === "Exited",
    ),
  );
  assert.equal(host.busy(), false);
});

test("a job runs in a process group of its own", async (t) => {
  const { wakes, call } = await hostOf(t);

  const { pid, log } = JSON.parse(
    await call(jobHostToolNames.jobStart, {
      name: "group",
      command: "ps -o pgid= -p $$",
    }),
  );

  await until(() => wakes.length > 0, "the job's wake");
  assert.equal(Number((await readFile(log, "utf8")).trim()), pid);
});

test("a job's directory is the thread's or one inside it, and no other", async (t) => {
  const { directory, call } = await hostOf(t);

  await assert.rejects(
    call(jobHostToolNames.jobStart, {
      name: "out",
      command: "true",
      cwd: "..",
    }),
    /outside the thread's directory/u,
  );
  await assert.rejects(
    call(jobHostToolNames.jobStart, { name: "out", command: "true", cwd: "/" }),
    /outside the thread's directory/u,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("a job job_stop ends is Stopped and wakes nobody, and one that is not running is forgotten", async (t) => {
  const { directory, wakes, host, call } = await hostOf(t);
  await call(jobHostToolNames.jobStart, { name: "long", command: "sleep 600" });

  const stopped = JSON.parse(
    await call(jobHostToolNames.jobStop, { name: "long" }),
  );

  assert.equal(stopped.status, "Stopped");
  assert.equal(stopped.signal, "SIGTERM");
  await host.settled();
  assert.deepEqual(wakes, []);
  assert.match(
    await call(jobHostToolNames.jobStop, { name: "long" }),
    /is forgotten/u,
  );
  assert.deepEqual(JSON.parse(await call(jobHostToolNames.jobList)), []);
  assert.deepEqual((await stateOf(directory)).jobs, []);
});

test("a job that outlives TERM by the grace is killed", async (t) => {
  const { clock, call } = await hostOf(t, { stopGraceMs: 1_000 });
  const { log } = JSON.parse(
    await call(jobHostToolNames.jobStart, {
      name: "stubborn",
      command: "trap 'echo termed' TERM; echo ready; while :; do sleep 1; done",
    }),
  );
  await until(
    async () => (await readFile(log, "utf8")).includes("ready"),
    "the job's start",
  );

  const stopping = call(jobHostToolNames.jobStop, { name: "stubborn" });
  await until(
    async () => (await readFile(log, "utf8")).includes("termed"),
    "the job's TERM",
  );
  clock.advance(1_000);

  assert.equal(JSON.parse(await stopping).signal, "SIGKILL");
});

test("a job of a name that is running, or past the most jobs the host holds, is refused", async (t) => {
  const { call } = await hostOf(t);
  await call(jobHostToolNames.jobStart, {
    name: "job-0",
    command: "sleep 600",
  });

  await assert.rejects(
    call(jobHostToolNames.jobStart, { name: "job-0", command: "true" }),
    /is running/u,
  );
  for (let index = 1; index < jobHostJobsMax; index += 1)
    await call(jobHostToolNames.jobStart, {
      name: `job-${String(index)}`,
      command: "sleep 600",
    });
  await assert.rejects(
    call(jobHostToolNames.jobStart, { name: "one-more", command: "true" }),
    new RegExp(`its ${String(jobHostJobsMax)} jobs`, "u"),
  );
});

test("the thread is standing while the host holds a running job started with restart, and reports each change once", async (t) => {
  const { host, standings, call } = await hostOf(t);
  await host.restore();
  await call(jobHostToolNames.jobStart, {
    name: "plain",
    command: "sleep 600",
  });
  await call(jobHostToolNames.jobStart, {
    name: "kept",
    command: "sleep 600",
    restart: true,
  });
  await call(jobHostToolNames.jobStart, {
    name: "kept-too",
    command: "sleep 600",
    restart: true,
  });

  await call(jobHostToolNames.jobStop, { name: "kept" });
  await host.settled();
  assert.deepEqual(standings, [false, true]);
  await call(jobHostToolNames.jobStop, { name: "kept-too" });
  await host.settled();

  assert.deepEqual(standings, [false, true, false]);
});

test("a watch wakes the thread once for each read that matched new lines, keeping them where it says", async (t) => {
  const { directory, clock, wakes, call } = await hostOf(t);
  const file = join(directory, "out.log");
  await writeFile(file, "ALERT before the watch\n");

  const { matched } = JSON.parse(
    await call(jobHostToolNames.watch, {
      name: "alerts",
      path: "out.log",
      pattern: "^ALERT",
    }),
  );
  await appendFile(file, "quiet\nALERT one\nALERT two\nALERT part");
  clock.advance(1_000);

  await until(() => wakes.length > 0, "the watch's wake");
  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["WatchMatched", "alerts"]],
  );
  assert.equal(await readFile(matched, "utf8"), "ALERT one\nALERT two\n");
  await appendFile(file, "ial\n");
  clock.advance(1_000);
  await until(() => wakes.length > 1, "the second read's wake");
  assert.equal(
    await readFile(matched, "utf8"),
    "ALERT one\nALERT two\nALERT partial\n",
  );
});

test("a watch's one wake keeps at most a batch of the lines it matched, and says how many it did not", async (t) => {
  const { directory, clock, wakes, call } = await hostOf(t);
  const file = join(directory, "out.log");
  await writeFile(file, "");
  const { matched } = JSON.parse(
    await call(jobHostToolNames.watch, {
      name: "many",
      path: file,
      pattern: "x",
    }),
  );

  await appendFile(
    file,
    Array.from({ length: jobHostWatchBatchLinesMax + 3 }, () => "x\n").join(""),
  );
  clock.advance(1_000);

  await until(() => wakes.length > 0, "the watch's wake");
  const lines = (await readFile(matched, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, jobHostWatchBatchLinesMax + 1);
  assert.equal(lines.at(-1), "(3 more matched lines were not kept)");
});

test("an unwatched file wakes nobody, and a pattern that is not a regular expression is refused", async (t) => {
  const { directory, clock, wakes, host, call } = await hostOf(t);
  const file = join(directory, "out.log");
  await writeFile(file, "");
  await call(jobHostToolNames.watch, {
    name: "gone",
    path: file,
    pattern: "x",
  });
  await call(jobHostToolNames.unwatch, { name: "gone" });

  await appendFile(file, "x\n");
  clock.advance(1_000);

  await host.settled();
  assert.deepEqual(wakes, []);
  assert.equal(host.busy(), false);
  await assert.rejects(
    call(jobHostToolNames.watch, { name: "bad", path: file, pattern: "(" }),
    /not a regular expression/u,
  );
});

test("a timer wakes the thread with its reason once it falls due, and a cancelled one never does", async (t) => {
  const { directory, clock, wakes, host, call } = await hostOf(t);

  const set = JSON.parse(
    await call(jobHostToolNames.wakeAt, {
      seconds: 60,
      reason: "check the deploy",
    }),
  );
  await call(jobHostToolNames.wakeAt, { seconds: 30, reason: "never" });
  await call(jobHostToolNames.wakeCancel, { reason: "never" });

  assert.equal(set.dueAt, new Date(clock.now() + 60_000).toISOString());
  assert.equal(host.busy(), true);
  assert.deepEqual((await stateOf(directory)).timers, [
    { reason: "check the deploy", dueAtMs: clock.now() + 60_000 },
  ]);
  clock.advance(59_999);
  assert.deepEqual(wakes, []);
  clock.advance(1);
  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["TimerDue", "check the deploy"]],
  );
  await host.settled();
  assert.deepEqual((await stateOf(directory)).timers, []);
  assert.equal(host.busy(), false);
});

test("a timer past the longest, or past the most the host holds, is refused", async (t) => {
  const { call } = await hostOf(t);

  await assert.rejects(
    call(jobHostToolNames.wakeAt, {
      seconds: jobHostTimerSecsMax + 1,
      reason: "late",
    }),
    /a timer is 1 to/u,
  );
  for (let index = 0; index < jobHostTimersMax; index += 1)
    await call(jobHostToolNames.wakeAt, {
      seconds: 1,
      reason: `r${String(index)}`,
    });
  await assert.rejects(
    call(jobHostToolNames.wakeAt, { seconds: 1, reason: "one more" }),
    new RegExp(`its ${String(jobHostTimersMax)} timers`, "u"),
  );
});

/** The attempt a restore case restores: a job of each kind, one that ended, a watch of `file` and two timers, then its end. */
async function restoredAttempt({ wakes, open, call }, file) {
  const before = open();
  const started = (args) => call(jobHostToolNames.jobStart, args, before);
  await started({ name: "kept", command: "sleep 600", restart: true });
  await started({ name: "plain", command: "sleep 600" });
  await started({ name: "done", command: "true" });
  await until(() => wakes.length > 0, "the job that ends at once");
  await call(
    jobHostToolNames.watch,
    { name: "w", path: file, pattern: "x" },
    before,
  );
  await call(jobHostToolNames.wakeAt, { seconds: 10, reason: "due" }, before);
  await call(
    jobHostToolNames.wakeAt,
    { seconds: 600, reason: "later" },
    before,
  );
  await before.close();
  return JSON.parse(await call(jobHostToolNames.jobList, {}, before));
}

test("an attempt's restore starts a restart job again, ends any other that was running, fires a timer that fell due, and wakes for each but the job started again", async (t) => {
  const hosted = await hostOf(t);
  const { directory, clock, wakes, standings, open, call } = hosted;
  const file = join(directory, "out.log");
  await writeFile(file, "");
  const ended = await restoredAttempt(hosted, file);
  wakes.length = 0;
  standings.length = 0;
  clock.advance(10_000);

  const after = open();
  t.after(() => after.close());
  await after.restore();
  await after.settled();

  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [
      ["AttemptEnded", "plain"],
      ["TimerDue", "due"],
    ],
  );
  const jobs = Object.fromEntries(
    JSON.parse(await call(jobHostToolNames.jobList, {}, after)).map((job) => [
      job.name,
      job,
    ]),
  );
  assert.equal(jobs.kept.status, "Running");
  assert.notEqual(jobs.kept.pid, ended.find(({ name }) => name === "kept").pid);
  assert.equal(jobs.plain.status, "AttemptEnded");
  assert.equal(jobs.done.status, "Exited");
  assert.deepEqual(standings, [true]);
  assert.deepEqual(
    JSON.parse(await call(jobHostToolNames.wakeList, {}, after)).map(
      ({ reason }) => reason,
    ),
    ["later"],
  );
});

/** A thread whose attempt left `jobs` running, each `{ name, restart }`, restored by an attempt of its own: the wakes it offered, the standings it reported and the state it wrote. */
async function restoredJobs(t, jobs) {
  const hosted = await hostOf(t);
  const { directory, wakes, standings, host, open, call } = hosted;
  for (const { name, restart } of jobs)
    await call(jobHostToolNames.jobStart, {
      name,
      command: "sleep 600",
      restart,
    });
  await host.settled();
  const left = await stateOf(directory);
  await host.close();
  wakes.length = 0;
  standings.length = 0;
  const after = open();
  t.after(() => after.close());
  await after.restore();
  await after.settled();
  return { wakes, standings, left, written: await stateOf(directory) };
}

test("a restore that only starts restart jobs again wakes nobody, and still writes their new pids and reports the thread standing", async (t) => {
  const { wakes, standings, left, written } = await restoredJobs(t, [
    { name: "one", restart: true },
    { name: "two", restart: true },
  ]);
  assert.deepEqual(wakes, []);
  assert.deepEqual(standings, [true]);
  for (const job of written.jobs) {
    assert.equal(job.status, "Running");
    assert.notEqual(
      job.pid,
      left.jobs.find(({ name }) => name === job.name).pid,
    );
  }
});

test("a restore that found a job running not started with restart offers exactly one AttemptEnded wake, naming it", async (t) => {
  const { wakes, standings } = await restoredJobs(t, [
    { name: "plain", restart: false },
  ]);
  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["AttemptEnded", "plain"]],
  );
  assert.deepEqual(standings, [false]);
});

test("a restore of restart jobs and one that is not names only the one that is not", async (t) => {
  const { wakes } = await restoredJobs(t, [
    { name: "kept", restart: true },
    { name: "plain", restart: false },
    { name: "also", restart: true },
  ]);
  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["AttemptEnded", "plain"]],
  );
});

test("a restart job that exits while the restore's standing report is outstanding leaves the plane last told the thread is not standing", async (t) => {
  const heard = [];
  let holding;
  const hosted = await hostOf(t, {
    standing: async (standing) => {
      const held = holding;
      holding = undefined;
      await held;
      heard.push(standing);
    },
  });
  const { host, open, call } = hosted;
  await call(jobHostToolNames.jobStart, {
    name: "kept",
    command: "sleep 600",
    restart: true,
  });
  await host.settled();
  await host.close();
  heard.length = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  holding = held;

  const after = open();
  t.after(() => after.close());
  const restoring = after.restore();
  await until(() => holding === undefined, "the restore's report is asked");
  const [job] = JSON.parse(await call(jobHostToolNames.jobList, {}, after));
  process.kill(-job.pid, "SIGKILL");
  await until(
    async () =>
      JSON.parse(await call(jobHostToolNames.jobList, {}, after))[0].status ===
      "Exited",
    "the restarted job's exit",
  );
  release();
  await restoring;
  await after.settled();

  assert.deepEqual(heard, [true, false]);
});

test("an attempt's restore resumes each watch at its file's end", async (t) => {
  const hosted = await hostOf(t);
  const { directory, clock, wakes, open, call } = hosted;
  const file = join(directory, "out.log");
  await writeFile(file, "");
  await restoredAttempt(hosted, file);
  await appendFile(file, "x written between attempts\n");
  wakes.length = 0;

  const after = open();
  t.after(() => after.close());
  await after.restore();
  await appendFile(file, "x written after\n");
  clock.advance(1_000);

  await until(
    () => wakes.some(({ wake }) => wake === "WatchMatched"),
    "the watch's wake",
  );
  const [{ matched }] = JSON.parse(
    await call(jobHostToolNames.watchList, {}, after),
  );
  assert.equal(await readFile(matched, "utf8"), "x written after\n");
});

test("a host closing with its attempt leaves its running jobs recorded running and wakes nobody for their end", async (t) => {
  const { directory, wakes, host, call } = await hostOf(t);
  const { pid } = JSON.parse(
    await call(jobHostToolNames.jobStart, {
      name: "long",
      command: "sleep 600",
    }),
  );

  await host.close();

  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the job's end");
  assert.deepEqual(wakes, []);
  assert.equal((await stateOf(directory)).jobs[0].status, "Running");
});

test("state that cannot be read is restored as empty, which is said", async (t) => {
  const { directory, wakes, warned, standings, host } = await hostOf(t);
  const { state, root } = jobHostPlaces(directory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  await writeFile(state, "{not json");

  await host.restore();

  assert.deepEqual(wakes, []);
  assert.deepEqual(standings, [false]);
  assert.ok(
    warned.some(
      (line) => line.includes(state) && line.includes("starts empty"),
    ),
    warned.join(""),
  );
});

test("the state is written whole and renamed into place, leaving nothing beside it", async (t) => {
  const { directory, call } = await hostOf(t);

  await call(jobHostToolNames.wakeAt, { seconds: 5, reason: "a" });
  await call(jobHostToolNames.wakeAt, { seconds: 5, reason: "b" });

  assert.deepEqual(await readdir(jobHostPlaces(directory).root), [
    "state.json",
  ]);
  assert.equal((await stateOf(directory)).timers.length, 2);
});

test("each tool's description states the bounds it is held to from the host's constants", async (t) => {
  const { tool, host } = await hostOf(t);
  const said = (name) => tool(host, name).description;

  assert.ok(
    said(jobHostToolNames.jobStart).includes(
      `at most ${String(jobHostJobsMax)} jobs`,
    ),
  );
  assert.ok(
    said(jobHostToolNames.watch).includes(
      `at most ${String(jobHostWatchBatchLinesMax)} of its lines`,
    ),
  );
  assert.ok(
    said(jobHostToolNames.watch).includes(
      `at most ${String(jobHostWatchesMax)} watches`,
    ),
  );
  assert.ok(
    said(jobHostToolNames.wakeAt).includes(
      `at most ${String(jobHostTimersMax)} timers`,
    ),
  );
  assert.deepEqual(
    host.definitions.map(({ name }) => name),
    Object.values(jobHostToolNames),
  );
});

test("job_list of the most jobs the host holds, each at its longest, fits one tool answer", async (t) => {
  const { call } = await hostOf(t);
  const command = `sleep 600 #${'"'.repeat(jobHostCommandCharsMax - 11)}`;
  for (let index = 0; index < jobHostJobsMax; index += 1)
    await call(jobHostToolNames.jobStart, {
      name: `${String(index)}`.padEnd(jobHostNameCharsMax, "n"),
      command,
      restart: true,
    });

  const listed = await call(jobHostToolNames.jobList);

  assert.ok(
    chuggyToolAnswerBytes(listed) <= chuggyToolAnswerBytesMax,
    `${String(chuggyToolAnswerBytes(listed))} bytes`,
  );
});

/** A plane's wake route answering each post as `answers` says, in turn, a raise where it says so. */
function wakeRoute(answers) {
  const posted = [];
  return {
    posted,
    request: async (_task, _bearer, path, init) => {
      posted.push({ path, body: JSON.parse(init.body) });
      const answer = answers[posted.length - 1] ?? answers.at(-1);
      if (answer instanceof Error) throw answer;
      return { status: answer.status, json: async () => answer.body };
    },
  };
}

test("a wake the plane answers with no turn is dropped and said, and one it woke is not", async () => {
  for (const woken of [
    "Backlogged",
    "Closed",
    "NoThread",
    "Woken",
    "AlreadyWoken",
  ]) {
    const warned = [];
    const route = wakeRoute([
      {
        status: 200,
        body: woken.endsWith("Woken") ? { woken, ordinal: 2 } : { woken },
      },
    ]);
    const sender = jobHostWakeSender({}, "bearer", {
      request: route.request,
      pause: async () => undefined,
      warn: (text) => warned.push(text),
    });

    sender.offer({ wake: "TimerDue", resource: "r", event: "e-1" });
    await sender.settled();

    assert.equal(route.posted.length, 1, woken);
    assert.equal(route.posted[0].path, "/v1/session/wake");
    assert.equal(
      warned.some(
        (line) =>
          line.includes(`answered ${woken}`) && line.includes("dropped"),
      ),
      !woken.endsWith("Woken"),
      woken,
    );
  }
});

test("a wake whose post failed is posted again under the same event, and dropped and said past its tries", async () => {
  const warned = [];
  const route = wakeRoute([
    new Error("down"),
    { status: 200, body: { woken: "Woken", ordinal: 1 } },
  ]);
  const sender = jobHostWakeSender({}, "bearer", {
    request: route.request,
    pause: async () => undefined,
    warn: (text) => warned.push(text),
  });
  sender.offer({ wake: "JobExited", resource: "j", event: "e-1" });
  await sender.settled();

  assert.deepEqual(
    route.posted.map(({ body }) => body),
    [
      { wake: "JobExited", resource: "j", event: "e-1" },
      { wake: "JobExited", resource: "j", event: "e-1" },
    ],
  );

  const failing = wakeRoute([new Error("down")]);
  const given = jobHostWakeSender({}, "bearer", {
    request: failing.request,
    pause: async () => undefined,
    warn: (text) => warned.push(text),
  });
  given.offer({ wake: "JobExited", resource: "j", event: "e-2" });
  await given.settled();

  assert.equal(failing.posted.length, jobHostWakeTriesMax);
  assert.ok(warned.at(-1).includes("dropped"), warned.at(-1));
});

test("a command holding a control character but a tab or a line's end is refused", async (t) => {
  const { call } = await hostOf(t);

  await assert.rejects(
    call(jobHostToolNames.jobStart, { name: "c", command: "echo \u0007" }),
    /no control character/u,
  );
  assert.equal(
    JSON.parse(
      await call(jobHostToolNames.jobStart, {
        name: "c",
        command: "echo a\n\techo b",
      }),
    ).status,
    "Running",
  );
});

test("a restored timer due further off than the longest a timer is set for fires when it is due, and not before", async (t) => {
  const { directory, clock, wakes, host } = await hostOf(t);
  const { root, state } = jobHostPlaces(directory);
  const dueAtMs = clock.now() + jobHostTimerSecsMax * 1_000 * 2;
  await mkdir(root);
  await writeFile(
    state,
    JSON.stringify({
      jobs: [],
      watches: [],
      timers: [{ reason: "far", dueAtMs }],
    }),
  );
  await host.restore();

  clock.advance(jobHostTimerSecsMax * 1_000);
  assert.deepEqual(wakes, []);
  clock.advance(jobHostTimerSecsMax * 1_000);

  assert.deepEqual(
    wakes.map(({ wake, resource }) => [wake, resource]),
    [["TimerDue", "far"]],
  );
});
