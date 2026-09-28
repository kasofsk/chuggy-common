import assert from "node:assert/strict";
import test from "node:test";

import { workerPoolClientPass, workerPoolClientRun } from "./poolLoop.mjs";

const settings = { concurrencyMax: 1, outageBackoffMs: 1, passesMax: 1 };

function assignment(named) {
  return {
    assignment: named,
    capabilities: [],
    cpuMillis: 500,
    memoryMib: 512,
    deadlineSecs: 60,
    callbackUrl: "https://plane.invalid/v1/ticket-execution",
    bearer: `bearer-${named}`,
  };
}

/** A backend holding nothing and placing everything, which every case narrows from. */
const idle = {
  place: async () => ({ placed: "Placed" }),
  stop: async () => ({ stopped: "Stopped" }),
  held: async () => [],
};

/** What a poll answers when it offers `assignments` and asks for `stop`. */
function reconciled(assignments = [], stop = []) {
  return { polled: "Reconciled", assignments, stop };
}

/** A plane with nothing to say, answered by the poll that says so. */
const quiet = {
  poll: async () => reconciled(),
  settle: async () => "Settled",
};

/** A plane offering `offered` on every poll and recording each outcome it is told. */
function offering(offered, settled = "Settled") {
  const posted = [];
  return {
    posted,
    plane: {
      poll: async () => reconciled(offered),
      settle: async (_token, _assignment, outcome) => {
        posted.push(outcome.outcome);
        return settled;
      },
    },
  };
}

function client(parts) {
  return {
    tokens: {
      acquire: async () =>
        parts.token ?? { acquired: "Token", token: "pool-token" },
      invalidate: () => undefined,
    },
    plane: quiet,
    backend: idle,
    settings,
    ...parts,
  };
}

/** A tokens port minting a fresh token per acquire and recording what it is told to discard. */
function counting() {
  const minted = [];
  const invalidated = [];
  return {
    minted,
    invalidated,
    tokens: {
      acquire: async () => {
        const token = `pool-token-${String(minted.length + 1)}`;
        minted.push(token);
        return { acquired: "Token", token };
      },
      invalidate: (token) => {
        invalidated.push(token);
      },
    },
  };
}

/** A backend placing everything, counting each placement. */
function placing(held = []) {
  const counted = { placed: 0 };
  return {
    counted,
    backend: {
      ...idle,
      held: async () => held,
      place: async () => {
        counted.placed += 1;
        return { placed: "Placed" };
      },
    },
  };
}

test("what the pool holds is read from the backend rather than remembered", async () => {
  const sent = [];
  const passed = await workerPoolClientPass(
    client({
      backend: { ...idle, held: async () => ["running-one"] },
      plane: {
        ...quiet,
        poll: async (_token, held) => {
          sent.push([...held]);
          return reconciled();
        },
      },
    }),
  );
  assert.deepEqual(sent, [["running-one"]]);
  assert.equal(passed.passed, "Reconciled");
});

test("a poll asks for the room left under the ceiling, and none at it", async () => {
  const asked = [];
  const plane = {
    ...quiet,
    poll: async (_token, _held, wanted) => {
      asked.push(wanted);
      return reconciled();
    },
  };
  for (const [concurrencyMax, held] of [
    [3, ["one"]],
    [3, ["one", "two", "three"]],
    [1, ["one", "two"]],
  ])
    await workerPoolClientPass(
      client({
        settings: { ...settings, concurrencyMax },
        backend: { ...idle, held: async () => held },
        plane,
      }),
    );
  assert.deepEqual(asked, [2, 0, 0]);
});

test("a pool at its own ceiling polls for none, and places nothing it is offered anyway", async () => {
  const asked = [];
  const placer = placing(["running-one"]);
  const offer = offering([assignment("offered")]);
  const passed = await workerPoolClientPass(
    client({
      backend: placer.backend,
      plane: {
        ...offer.plane,
        poll: async (token, held, wanted) => {
          asked.push(wanted);
          return offer.plane.poll(token, held, wanted);
        },
      },
    }),
  );
  assert.deepEqual(asked, [0]);
  assert.equal(placer.counted.placed, 0);
  assert.deepEqual(offer.posted, ["Unavailable"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
  });
});

test("a stopped assignment frees the room the same pass places into", async () => {
  const stopped = [];
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        held: async () => ["going"],
        stop: async (named) => {
          stopped.push(named);
          return { stopped: "Stopped" };
        },
      },
      plane: {
        ...quiet,
        poll: async () => reconciled([assignment("offered")], ["going"]),
      },
    }),
  );
  assert.deepEqual(stopped, ["going"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 1,
    stopped: 1,
    refused: 0,
  });
});

test("a fabric that could not take a stop places nothing further this pass", async () => {
  const placer = placing(["going"]);
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...placer.backend,
        stop: async () => ({
          stopped: "Unavailable",
          evidence: "the fabric could not be reached",
        }),
      },
      plane: {
        ...quiet,
        poll: async () => reconciled([assignment("offered")], ["going"]),
      },
    }),
  );
  assert.equal(placer.counted.placed, 0);
  assert.deepEqual(passed, {
    passed: "Unavailable",
    evidence: "the fabric could not be reached",
  });
});

test("a fabric that refused a stop ends the run rather than renewing that lease", async () => {
  let polled = 0;
  const passed = await workerPoolClientRun(
    client({
      settings: { ...settings, passesMax: 5 },
      backend: {
        ...idle,
        held: async () => ["going"],
        stop: async () => ({
          stopped: "Refused",
          evidence: "the fabric refused to stop this workload",
        }),
      },
      plane: {
        ...quiet,
        poll: async () => {
          polled += 1;
          return reconciled([], ["going"]);
        },
      },
    }),
    async () => undefined,
  );
  assert.equal(polled, 1);
  assert.deepEqual(passed, {
    passed: "Denied",
    evidence: "the fabric refused to stop this workload",
  });
});

test("a placement the plane never acknowledged is still placed", async () => {
  const placer = placing();
  const passed = await workerPoolClientPass(
    client({
      backend: placer.backend,
      plane: offering([assignment("offered")], "Unavailable").plane,
    }),
  );
  assert.equal(placer.counted.placed, 1);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 1,
    stopped: 0,
    refused: 0,
  });
});

test("a refused placement is reported as evidence rather than as unavailable", async () => {
  const offer = offering([assignment("offered")]);
  const passed = await workerPoolClientPass(
    client({
      backend: {
        ...idle,
        place: async () => ({
          placed: "Refused",
          evidence: "the cluster refused this workload",
        }),
      },
      plane: offer.plane,
    }),
  );
  assert.deepEqual(offer.posted, ["Refused"]);
  assert.deepEqual(passed, {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 1,
  });
});

test("a backend answering no placement the loop knows fails the pass before it settles", async () => {
  const offer = offering([assignment("offered")]);
  await assert.rejects(
    workerPoolClientPass(
      client({
        backend: { ...idle, place: async () => ({ placed: "Placd" }) },
        plane: offer.plane,
      }),
    ),
    /Placd, which is no placement/u,
  );
  assert.deepEqual(offer.posted, []);
});

test("a token is acquired every pass and nothing is discarded unasked", async () => {
  const source = counting();
  await workerPoolClientRun(
    client({ settings: { ...settings, passesMax: 3 }, tokens: source.tokens }),
    async () => undefined,
  );
  assert.equal(source.minted.length, 3);
  assert.deepEqual(source.invalidated, []);
});

test("a token the poll was refused with is invalidated, and the next pass acquires again", async () => {
  const source = counting();
  const polledWith = [];
  const running = client({
    tokens: source.tokens,
    plane: {
      ...quiet,
      poll: async (token) => {
        polledWith.push(token);
        return polledWith.length === 1 ? { polled: "Stale" } : reconciled();
      },
    },
  });
  const first = await workerPoolClientPass(running);
  assert.equal(first.passed, "Unavailable");
  assert.deepEqual(source.invalidated, ["pool-token-1"]);
  const second = await workerPoolClientPass(running);
  assert.equal(second.passed, "Reconciled");
  assert.deepEqual(polledWith, ["pool-token-1", "pool-token-2"]);
});

test("a token a settlement was refused with is invalidated, and the next pass acquires again", async () => {
  const source = counting();
  const polledWith = [];
  const running = client({
    tokens: source.tokens,
    plane: {
      poll: async (token) => {
        polledWith.push(token);
        return reconciled([assignment("offered")]);
      },
      settle: async () => "Stale",
    },
  });
  const passed = await workerPoolClientPass(running);
  assert.equal(passed.passed, "Reconciled");
  assert.deepEqual(source.invalidated, ["pool-token-1"]);
  await workerPoolClientPass(running);
  assert.deepEqual(polledWith, ["pool-token-1", "pool-token-2"]);
});

test("a pool the plane serves no registration for stops rather than retrying", async () => {
  let polled = 0;
  const passed = await workerPoolClientRun(
    client({
      settings: { ...settings, passesMax: 5 },
      plane: {
        ...quiet,
        poll: async () => {
          polled += 1;
          return {
            polled: "Denied",
            evidence: "the plane serves no such pool",
          };
        },
      },
    }),
    async () => undefined,
  );
  assert.equal(polled, 1);
  assert.equal(passed.passed, "Denied");
});

test("an issuer that refused the grant stops the run and one that faltered does not", async () => {
  const denied = await workerPoolClientRun(
    client({
      token: { acquired: "Denied", evidence: "the issuer refused this pool" },
    }),
    async () => undefined,
  );
  assert.equal(denied.passed, "Denied");
  const waited = [];
  const outage = await workerPoolClientRun(
    client({
      settings: { ...settings, outageBackoffMs: 7, passesMax: 2 },
      token: { acquired: "Unavailable", evidence: "the issuer is unreachable" },
    }),
    async (ms) => {
      waited.push(ms);
    },
  );
  assert.equal(outage.passed, "Unavailable");
  assert.deepEqual(waited, [7, 7]);
});

test("a run refuses a bound that is not a positive whole number", async () => {
  for (const name of ["concurrencyMax", "outageBackoffMs", "passesMax"])
    for (const refused of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      await assert.rejects(
        workerPoolClientRun(
          client({ settings: { ...settings, [name]: refused } }),
          async () => undefined,
        ),
        new RegExp(`${name} must be a positive safe integer`, "u"),
      );
});
