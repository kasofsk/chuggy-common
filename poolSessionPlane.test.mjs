import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionContainerEnds,
  sessionPlaneAnswers,
} from "@chuggy/worker-contract/sessionPlane";

import { planeFetch, planes } from "./plane.fixture.mjs";
import {
  checkedPoolSessionPlaneClientSettings,
  poolSessionPlaneClient,
} from "./poolSessionPlane.mjs";

const sessionBearer = "chgs_0123456789abcdef0123456789abcdef";

/** A session whose container ended as `phase`, as a backend names it. */
function sessionEnd(phase) {
  return {
    kind: "Session",
    session: {
      assignment: "session-assignment",
      callbackUrl: "https://worker-plane.invalid/v1/session-plane",
      bearer: sessionBearer,
    },
    phase,
  };
}

/** The client over a session plane answering every end with `status`, and what that plane was asked under which bearer. */
function endedOver(status) {
  const plane = planeFetch(planes.session, () => ({ status }));
  const bearers = [];
  const client = poolSessionPlaneClient({ timeoutMs: 1_000 }, (url, init) => {
    bearers.push(init.headers.authorization);
    return plane.fetch(url, init);
  });
  return { client, asked: plane.asked, bearers };
}

test("a session's container end is told to its own plane, as the phase alone, under the session's bearer", async () => {
  for (const phase of sessionContainerEnds) {
    const { client, asked, bearers } = endedOver(204);

    assert.equal(await client.end(sessionEnd(phase)), "Ended");
    assert.deepEqual(
      asked.map(({ route, path, body }) => ({ route, path, body })),
      [{ route: "ended", path: "/v1/session/ended", body: { phase } }],
    );
    assert.deepEqual(bearers, [`Bearer ${sessionBearer}`]);
  }
});

test("every status but the plane's taking is final, and a plane that could not be asked is an outage", async () => {
  const refusing = Object.keys(sessionPlaneAnswers.ended)
    .map(Number)
    .filter((status) => status !== 204);
  assert.ok(refusing.includes(401) && refusing.includes(409));
  for (const status of refusing)
    assert.equal(
      await endedOver(status).client.end(sessionEnd("Failed")),
      "Refused",
      String(status),
    );

  const failed = sessionEnd("Failed");
  assert.equal(
    await poolSessionPlaneClient(
      { timeoutMs: 1_000 },
      async () => new globalThis.Response(null, { status: 502 }),
    ).end(failed),
    "Unavailable",
  );
  assert.equal(
    await poolSessionPlaneClient({ timeoutMs: 1_000 }, async () => {
      throw new TypeError("fetch failed");
    }).end(failed),
    "Unavailable",
  );
});

test("an end the contract has no phase for fails before anything is sent", async () => {
  const { client, asked } = endedOver(204);

  await assert.rejects(client.end(sessionEnd("Exited")));
  assert.deepEqual(asked, []);
});

test("a session plane timeout that is not a positive whole number is refused", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
    assert.throws(
      () => checkedPoolSessionPlaneClientSettings({ timeoutMs }),
      /pool session plane timeout must be a positive integer/u,
    );
});
