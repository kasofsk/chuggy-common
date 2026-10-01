/**
 * The pool loop: each pass takes a token, reads what the backend holds, ends
 * the attempts of workloads that ended without reporting, polls the plane for
 * the room left, stops what it is told to and places what it is offered.
 * chuggy's `src/interpreter/workerPoolClient.ts` is the same loop in
 * TypeScript, and a change to one is a change to both.
 *
 * Nothing is held between passes. What is running is read from the backend,
 * so a restarted loop reconciles the work its predecessor placed, and a
 * settlement is never retried because the next poll's `held` renews the lease.
 * A denial ends the run; an outage backs off and comes back.
 */

/**
 * @typedef {import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment} WorkerPoolAssignment
 * @typedef {import("@chuggy/worker-contract/workerPool").AssignmentOutcome} AssignmentOutcome
 *
 * @typedef {{placed: "Placed"} | {placed: "Refused", evidence: string} | {placed: "Unavailable"}} WorkerPoolPlacement
 * @typedef {{stopped: "Stopped"} | {stopped: "Refused", evidence: string} | {stopped: "Unavailable", evidence: string}} WorkerPoolStopped
 *
 * @typedef {object} WorkerPoolEnded a workload that ended of itself, which its harness may never have reported
 * @property {Pick<WorkerPoolAssignment, "assignment" | "callbackUrl" | "bearer">} job
 * @property {string} why the backend's own words, never the workload's, which may carry a secret no scrub here holds
 *
 * @typedef {object} WorkerPoolBackend where the work runs, and the only record of what is running
 * @property {(assignment: WorkerPoolAssignment) => Promise<WorkerPoolPlacement>} place
 * @property {(assignment: string) => Promise<WorkerPoolStopped>} stop idempotent
 * @property {() => Promise<readonly string[]>} held
 * @property {() => Promise<readonly WorkerPoolEnded[]>} ended each one once, after `held` stopped naming it; never one this pool stopped
 *
 * @typedef {{polled: "Reconciled", assignments: readonly WorkerPoolAssignment[], stop: readonly string[]}
 *   | {polled: "Stale"} | {polled: "Denied", evidence: string} | {polled: "Unavailable", evidence: string}} WorkerPoolPolled
 * @typedef {"Settled" | "Lost" | "Stale" | "Denied" | "Unavailable"} WorkerPoolSettled
 *
 * @typedef {object} WorkerPoolPlane `Stale` is a token to replace; `Denied` a pool the plane will not serve
 * @property {(token: string, held: readonly string[], wanted: number) => Promise<WorkerPoolPolled>} poll
 * @property {(token: string, assignment: string, outcome: AssignmentOutcome) => Promise<WorkerPoolSettled>} settle
 *
 * @typedef {"Ended" | "Refused" | "Unavailable"} WorkerPoolJobEnded
 *
 * @typedef {object} WorkerPoolJobPlane `Refused` is an attempt no longer live, whose own report stands
 * @property {(ended: WorkerPoolEnded) => Promise<WorkerPoolJobEnded>} end
 *
 * @typedef {{acquired: "Token", token: string} | {acquired: "Denied", evidence: string}
 *   | {acquired: "Unavailable", evidence: string}} WorkerPoolTokenAcquired
 *
 * @typedef {object} WorkerPoolTokens holds the grant, so it is asked every pass
 * @property {() => Promise<WorkerPoolTokenAcquired>} acquire
 * @property {(token: string) => void} invalidate discards a token the plane rejected
 *
 * @typedef {object} WorkerPoolClientSettings
 * @property {number} concurrencyMax the assignments held at once, which each poll's `wanted` is measured from
 * @property {number} outageBackoffMs the wait after a pass that met an outage
 * @property {number} passesMax the passes one run makes
 *
 * @typedef {{passed: "Reconciled", placed: number, stopped: number, refused: number, ended: number}
 *   | {passed: "Denied", evidence: string} | {passed: "Unavailable", evidence: string}} WorkerPoolPass
 *
 * @typedef {object} WorkerPoolClient
 * @property {WorkerPoolTokens} tokens
 * @property {WorkerPoolPlane} plane
 * @property {WorkerPoolJobPlane} jobs
 * @property {WorkerPoolBackend} backend
 * @property {WorkerPoolClientSettings} settings
 */

/**
 * @param {WorkerPoolClientSettings} settings
 * @returns {WorkerPoolClientSettings}
 */
export function checkedWorkerPoolClientSettings(settings) {
  for (const [name, bound] of [
    ["concurrencyMax", settings.concurrencyMax],
    ["outageBackoffMs", settings.outageBackoffMs],
    ["passesMax", settings.passesMax],
  ])
    if (!Number.isSafeInteger(bound) || bound <= 0)
      throw new RangeError(
        `worker pool client ${name} must be a positive safe integer`,
      );
  return settings;
}

/** @param {WorkerPoolClient} client */
async function workerPoolClientToken(client) {
  const acquired = await client.tokens.acquire();
  if (acquired.acquired === "Denied")
    return { passed: "Denied", evidence: acquired.evidence };
  if (acquired.acquired === "Unavailable")
    return { passed: "Unavailable", evidence: acquired.evidence };
  return { token: acquired.token };
}

/**
 * Stops everything the plane flagged. An unreachable fabric ends the pass
 * before anything is placed; one that refused ends the run, because polling on
 * would renew the lease of work this pool cannot abandon.
 *
 * @param {WorkerPoolClient} client
 * @param {readonly string[]} stop
 */
async function workerPoolClientStopped(client, stop) {
  let stopped = 0;
  for (const assignment of stop) {
    const outcome = await client.backend.stop(assignment);
    if (outcome.stopped === "Refused")
      return { passed: "Denied", evidence: outcome.evidence };
    if (outcome.stopped === "Unavailable")
      return { passed: "Unavailable", evidence: outcome.evidence };
    stopped += 1;
  }
  return { stopped };
}

/**
 * Ends each attempt whose workload ended unreported, counting the ends the
 * plane took. One it did not take is left to its lease.
 *
 * @param {WorkerPoolClient} client
 */
async function workerPoolClientEnded(client) {
  let ended = 0;
  for (const workload of await client.backend.ended())
    if ((await client.jobs.end(workload)) === "Ended") ended += 1;
  return ended;
}

/**
 * @param {WorkerPoolPlacement} placement
 * @returns {AssignmentOutcome}
 */
function workerPoolClientOutcome(placement) {
  switch (placement.placed) {
    case "Placed":
      return { outcome: "Accepted" };
    case "Refused":
      return { outcome: "Refused", evidence: placement.evidence };
    case "Unavailable":
      return { outcome: "Unavailable" };
    default:
      throw new TypeError(
        `a backend answered ${String(placement.placed)}, which is no placement`,
      );
  }
}

/**
 * Places what there is room for and settles the rest as `Unavailable`: the
 * poll asked for no more than the room, so the rest is a plane that offered
 * past it. Room is what the backend held plus what this pass has placed.
 *
 * @param {WorkerPoolClient} client
 * @param {string} token
 * @param {readonly WorkerPoolAssignment[]} offered
 * @param {number} running
 */
async function workerPoolClientPlaced(client, token, offered, running) {
  const tally = { placed: 0, refused: 0 };
  for (const assignment of offered) {
    const placement =
      running + tally.placed < client.settings.concurrencyMax
        ? await client.backend.place(assignment)
        : { placed: "Unavailable" };
    const outcome = workerPoolClientOutcome(placement);
    if (placement.placed === "Placed") tally.placed += 1;
    if (placement.placed === "Refused") tally.refused += 1;
    const settled = await client.plane.settle(
      token,
      assignment.assignment,
      outcome,
    );
    if (settled === "Stale") client.tokens.invalidate(token);
  }
  return tally;
}

/**
 * One reconciliation pass. The room is asked before the stops are known, so a
 * stop this pass delivers frees room the next pass asks for. The ended are
 * ended before the poll, which may wait on the plane for work to offer.
 *
 * @param {WorkerPoolClient} client
 * @returns {Promise<WorkerPoolPass>}
 */
export async function workerPoolClientPass(client) {
  const minted = await workerPoolClientToken(client);
  if (!("token" in minted)) return minted;
  const held = await client.backend.held();
  const ended = await workerPoolClientEnded(client);
  const polled = await client.plane.poll(
    minted.token,
    held,
    Math.max(client.settings.concurrencyMax - held.length, 0),
  );
  if (polled.polled === "Stale") {
    client.tokens.invalidate(minted.token);
    return { passed: "Unavailable", evidence: "the pool token was rejected" };
  }
  if (polled.polled !== "Reconciled")
    return { passed: polled.polled, evidence: polled.evidence };
  const stopped = await workerPoolClientStopped(client, polled.stop);
  if ("passed" in stopped) return stopped;
  const tally = await workerPoolClientPlaced(
    client,
    minted.token,
    polled.assignments,
    held.length - stopped.stopped,
  );
  return {
    passed: "Reconciled",
    placed: tally.placed,
    stopped: stopped.stopped,
    refused: tally.refused,
    ended,
  };
}

/**
 * The whole loop, `passesMax` passes long so a run has an end, and ended early
 * by a denial because no later pass would be answered differently.
 *
 * @param {WorkerPoolClient} client
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<WorkerPoolPass>}
 */
export async function workerPoolClientRun(client, sleep) {
  checkedWorkerPoolClientSettings(client.settings);
  /** @type {WorkerPoolPass} */
  let last = {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 0,
  };
  for (let pass = 0; pass < client.settings.passesMax; pass += 1) {
    last = await workerPoolClientPass(client);
    if (last.passed === "Denied") return last;
    if (last.passed === "Unavailable")
      await sleep(client.settings.outageBackoffMs);
  }
  return last;
}
