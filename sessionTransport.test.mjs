import assert from "node:assert/strict";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import {
  workerContractHeader,
  workerContractRelease,
} from "@chuggy/worker-contract/workerContract";

import {
  sessionRequest,
  sessionRequestOnce,
  sessionStopped,
} from "./sessionTransport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };

function transportOf(answers) {
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    transport: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const answer = answers[Math.min(calls.length, answers.length) - 1];
        if (answer instanceof Error) throw answer;
        return {
          status: answer.status,
          headers: { get: (name) => answer.headers?.[name] },
        };
      },
      wait: async (milliseconds) => waits.push(milliseconds),
    },
  };
}

test("the bearer, the release and the plane's base url are what the request is made against", async () => {
  const { calls, transport } = transportOf([{ status: 204 }]);

  await sessionRequest(task, "chgs_secret", "/v1/session/turn", {}, transport);

  assert.equal(calls[0].url, "http://worker-plane.test:3001/v1/session/turn");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer chgs_secret",
    [workerContractHeader]: workerContractRelease,
  });
});

test("a decision is answered to the caller rather than asked again", async () => {
  for (const status of [200, 204, 400, 401, 409, 413]) {
    const { calls, transport } = transportOf([{ status }]);

    const response = await sessionRequest(
      task,
      "b",
      "/v1/session",
      {},
      transport,
    );

    assert.equal(response.status, status);
    assert.equal(calls.length, 1, `status ${String(status)} was retried`);
  }
});

test("a server error is retried, and the plane's own delay is what is waited", async () => {
  const { calls, waits, transport } = transportOf([
    { status: 503, headers: { "retry-after": "5" } },
    { status: 204 },
  ]);

  const response = await sessionRequest(
    task,
    "b",
    "/v1/session",
    {},
    transport,
  );

  assert.equal(response.status, 204);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [5_000]);
});

test("a delay the plane asks for is capped by this module's own bound", async () => {
  const { waits, transport } = transportOf([
    { status: 503, headers: { "retry-after": "86400" } },
    { status: 204 },
  ]);

  await sessionRequest(task, "b", "/v1/session", {}, transport);

  assert.ok(waits[0] <= 60_000, `waited ${String(waits[0])}`);
});

test("a transport that never answers exhausts a bound and raises its own refusal", async () => {
  const { calls, transport } = transportOf([new Error("connection refused")]);

  await assert.rejects(
    sessionRequest(task, "b", "/v1/session", {}, transport),
    /connection refused/u,
  );
  assert.equal(calls.length, 15);
});

test("stop is the status the plane fences with, and nothing else", () => {
  assert.ok(sessionStopped({ status: 401 }));
  assert.ok(sessionStopped({ status: 409 }));
  assert.ok(!sessionStopped({ status: 200 }));
  assert.ok(!sessionStopped({ status: 204 }));
  assert.ok(!sessionStopped({ status: 413 }));
});

const livePath = "/v1/session/turn/live";

test("a request asked once is asked once, whatever the plane answers, under the same headers", async () => {
  for (const status of [204, 400, 401, 409, 503]) {
    const { calls, waits, transport } = transportOf([{ status }]);

    const response = await sessionRequestOnce(
      task,
      "chgs_secret",
      livePath,
      { method: "POST", headers: { "content-type": "application/json" } },
      { ...transport, deadlineMs: 1_000 },
    );

    assert.equal(response.status, status);
    assert.equal(calls.length, 1, `status ${String(status)} was asked again`);
    assert.deepEqual(waits, [], `status ${String(status)} was waited on`);
    assert.equal(calls[0].url, `http://worker-plane.test:3001${livePath}`);
    assert.deepEqual(calls[0].init.headers, {
      "content-type": "application/json",
      authorization: "Bearer chgs_secret",
      [workerContractHeader]: workerContractRelease,
    });
  }
});

test("a request asked once raises the fetch that failed, and does not ask again", async () => {
  const { calls, waits, transport } = transportOf([new Error("unreachable")]);

  await assert.rejects(
    sessionRequestOnce(
      task,
      "b",
      livePath,
      {},
      { ...transport, deadlineMs: 1_000 },
    ),
    /unreachable/u,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("a request asked once is abandoned at its deadline", async () => {
  // The deadline's own timer does not hold the process open, and nothing else here would.
  const held = setTimeout(() => undefined, 60_000);
  const unanswered = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  try {
    await assert.rejects(
      sessionRequestOnce(
        task,
        "b",
        livePath,
        {},
        { fetch: unanswered, deadlineMs: 5 },
      ),
      { name: "TimeoutError" },
    );
  } finally {
    clearTimeout(held);
  }
});
