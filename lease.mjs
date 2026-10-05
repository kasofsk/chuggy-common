import { workerPlaneRoutes } from "@chuggy/worker-contract/workerPlane";

import { WorkerPlaneRefusal, workerRequest } from "./transport.mjs";

export const heartbeatIntervalMilliseconds = 60_000;

/**
 * The lease a pod keeps while it holds an attempt. The path is a parameter
 * because a work attempt and a session attempt are leased on different routes
 * and by nothing else different.
 *
 * ONLY A BEAT THE PLANE REFUSED ENDS THE ATTEMPT. `request` raises a
 * `WorkerPlaneRefusal` for one, which is remembered and raised when the lease
 * is stopped. A beat that was never answered says nothing of the lease, so it
 * is forgotten and the next one asks again.
 */
export function keepWorkerLease(task, bearer, services = {}) {
  const {
    request = workerRequest,
    setInterval: schedule = globalThis.setInterval,
    clearInterval: unschedule = globalThis.clearInterval,
    path = workerPlaneRoutes.heartbeat.path,
  } = services;
  let pending;
  let refusal;
  const heartbeat = () => {
    if (pending !== undefined) return;
    pending = request(task, bearer, path, { method: "POST" })
      .catch((failure) => {
        if (failure instanceof WorkerPlaneRefusal) refusal ??= failure;
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = schedule(heartbeat, heartbeatIntervalMilliseconds);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    unschedule(timer);
    await pending;
    if (refusal !== undefined) throw refusal;
  };
}
