/**
 * A pool runner composed beside its backend: the pool's token source and plane
 * client from its credentials, the job and session planes, and the loop. Each
 * runner brings its own backend, service manager and platform checks.
 *
 * THE RUN IS PASSES UNTIL A DENIAL rather than `workerPoolClientRun`'s count of
 * them, because the placements a run has in flight live in its memory. Each
 * outage is logged, since under a service manager an unlogged one is a pool
 * that silently stopped working. A pass that throws ends the run, and the
 * service manager's restart begins the next from what the backend lists.
 */

import { poolJobPlaneClient } from "./poolJobPlane.mjs";
import {
  checkedWorkerPoolClientSettings,
  workerPoolClientPass,
} from "./poolLoop.mjs";
import { poolPlaneClient } from "./poolPlane.mjs";
import { poolSessionPlaneClient } from "./poolSessionPlane.mjs";
import { poolClientTokens } from "./poolTokens.mjs";

/**
 * @typedef {import("./poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("./poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("./poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./poolLoop.mjs").WorkerPoolPass} WorkerPoolPass
 *
 * @typedef {object} PoolRunnerLimits
 * @property {number} concurrencyMax
 * @property {number} sessionsMax
 */

/** Chuggy's own pool client's bounds, which its issuer and plane are sized for. */
const tokenSettings = {
  requestTimeoutMs: 10_000,
  responseBytesMax: 64 * 1024,
  responseReadsMax: 64,
  refreshMarginMs: 60_000,
  mintCooldownMs: 1_000,
};
const planeSettings = { pollTimeoutMs: 120_000, settleTimeoutMs: 10_000 };
const jobPlaneSettings = { timeoutMs: 10_000 };
const sessionPlaneSettings = { timeoutMs: 10_000 };
const outageBackoffMs = 5_000;

/**
 * @param {PoolCredentials} credentials
 * @returns {WorkerPoolClient["tokens"]}
 */
export function poolRunnerTokens(credentials) {
  return poolClientTokens({
    tokenUrl: credentials.tokenUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    audience: [credentials.audience],
    scope: [],
    ...tokenSettings,
  });
}

/**
 * @param {PoolCredentials} credentials
 * @returns {WorkerPoolClient["plane"]}
 */
export function poolRunnerPlane(credentials) {
  return poolPlaneClient({ baseUrl: credentials.planeUrl, ...planeSettings });
}

/**
 * The client a run passes with, one pass at a time.
 *
 * @param {PoolCredentials} credentials
 * @param {WorkerPoolBackend} backend
 * @param {PoolRunnerLimits} limits
 * @param {{tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch}} [seams] the token source when not the pool file's, and the fetch a job's or a session's plane is reached by when not the global one
 * @returns {WorkerPoolClient}
 */
export function poolRunnerClient(credentials, backend, limits, seams = {}) {
  return {
    tokens: seams.tokens ?? poolRunnerTokens(credentials),
    plane: poolRunnerPlane(credentials),
    jobs: poolJobPlaneClient(jobPlaneSettings, seams.fetch),
    sessions: poolSessionPlaneClient(sessionPlaneSettings, seams.fetch),
    backend,
    settings: checkedWorkerPoolClientSettings({
      concurrencyMax: limits.concurrencyMax,
      sessionsMax: limits.sessionsMax,
      outageBackoffMs,
      passesMax: 1,
    }),
  };
}

/**
 * What a pass did, as a log line, naming the workloads it ended only where it
 * ended any.
 *
 * @param {{placed: number, stopped: number, refused: number, ended: number}} pass
 */
export function poolRunnerPassLine(pass) {
  const line = `placed ${String(pass.placed)}, stopped ${String(pass.stopped)}, refused ${String(pass.refused)}`;
  return pass.ended === 0 ? line : `${line}, ended ${String(pass.ended)}`;
}

/**
 * The pool loop until the plane denies the pool.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void}} seams
 * @returns {Promise<Extract<WorkerPoolPass, {passed: "Denied"}>>}
 */
export async function poolRunnerLoop(client, seams) {
  for (;;) {
    const pass = await workerPoolClientPass(client);
    if (pass.passed === "Denied") {
      seams.log(`the plane denied this pool: ${pass.evidence}`);
      return pass;
    }
    if (pass.passed === "Unavailable") {
      seams.log(`outage: ${pass.evidence}`);
      await seams.sleep(client.settings.outageBackoffMs);
    } else if (pass.placed + pass.stopped + pass.refused + pass.ended > 0)
      seams.log(poolRunnerPassLine(pass));
  }
}
