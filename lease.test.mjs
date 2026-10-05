import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import { pausedClock } from "./clock.fixture.mjs";
import { heartbeatIntervalMilliseconds, keepWorkerLease } from "./lease.mjs";
import { WorkerPlaneRefusal, workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };

/**
 * A lease over the transport a job pod is given, on a plane answering every
 * ask of the nth beat with the nth of `statuses`. `beat()` is the interval's
 * tick, which must begin a beat, awaited until the lease has read its end.
 */
function leaseOver(statuses) {
  let tick;
  const beats = [];
  const stop = keepWorkerLease(task, "bearer", {
    request: (...args) => {
      const status = statuses[beats.length];
      const beat = workerRequest(...args, {
        fetch: async () => ({ ok: status === 204, status }),
        ...pausedClock(),
      });
      beats.push(beat.catch(() => undefined));
      return beat;
    },
    setInterval: (callback) => {
      tick = callback;
      return "timer";
    },
    clearInterval: () => undefined,
  });
  return {
    stop,
    beat: async () => {
      const begun = beats.length;
      tick();
      assert.equal(beats.length, begun + 1, "the beat before is in flight");
      await beats.at(-1);
      await new Promise((turned) => setImmediate(turned));
    },
  };
}

test("a running worker renews its attempt lease without overlapping heartbeats", async () => {
  const calls = [];
  let tick;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const stop = keepWorkerLease(
    { workerPlane: { url: "http://worker-plane" } },
    "bearer",
    {
      request: async (...args) => {
        calls.push(args);
        await pending;
      },
      setInterval: (callback, milliseconds) => {
        assert.equal(milliseconds, heartbeatIntervalMilliseconds);
        tick = callback;
        return "timer";
      },
      clearInterval: (timer) => assert.equal(timer, "timer"),
    },
  );

  tick();
  tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), [
    "bearer",
    "/v1/heartbeat",
    { method: "POST" },
  ]);
  release();
  await stop();
});

test("a heartbeat the plane refused fails the worker when its work finishes", async () => {
  let tick;
  const stop = keepWorkerLease({}, "bearer", {
    request: async () => {
      throw new WorkerPlaneRefusal("fenced");
    },
    setInterval: (callback) => {
      tick = callback;
      return "timer";
    },
    clearInterval: () => undefined,
  });
  tick();
  await assert.rejects(stop(), /fenced/);
});

/**
 * A plane away for a whole beat's patience and back for the next. Catches a
 * lease that remembers the beat nothing answered, and so ends an attempt the
 * plane went on to renew.
 */
test("a heartbeat the plane never answered is forgotten, and the next asks again", async () => {
  const { stop, beat } = leaseOver([503, 204]);

  await beat();
  await beat();

  await stop();
});

/** The same lease, refused by the plane once it is back: the beat before it being forgotten forgets nothing after. */
test("a heartbeat refused after one that was never answered still fails the worker", async () => {
  const { stop, beat } = leaseOver([503, 409]);

  await beat();
  await beat();

  await assert.rejects(stop(), /answered 409/u);
});
