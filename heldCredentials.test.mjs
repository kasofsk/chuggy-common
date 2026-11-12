import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  heldCredentialFilePlaceholder,
  workerHeldCredentialBundleSchema,
  workerPlaneAnswers,
} from "@chuggy/worker-contract/workerPlane";

import {
  heldCredentials,
  heldCredentialsUnmounted,
} from "./heldCredentials.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { WorkerPlaneRefusal, workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const trackRecord = {
  credential: "track-record",
  variable: "TRACK_RECORD_TOKEN_FILE",
  secret: "track-record-0123456789abcdefghij",
};

/** A plane answering the held credentials route `answer`, every ask of it recorded. */
function heldPlane(answer) {
  const plane = planeFetch(planes.job, () => answer);
  return {
    asked: plane.asked,
    request: overPlane(workerRequest, plane.fetch),
  };
}

/**
 * What one ask, given `granted` and the launcher's `credentialFiles`, kept and
 * wrote; through `write` where a case names it, which `written` then holds
 * nothing of.
 */
async function asked(
  plane,
  granted,
  credentialFiles = {},
  directory = "/m",
  write,
) {
  const kept = [];
  const written = [];
  const held = await heldCredentials({
    task,
    bearer: "capability",
    granted,
    credentialFiles,
    directory,
    keep: (value) => kept.push(value),
    request: plane.request,
    write:
      write ??
      (async (file, content, options) => {
        written.push({ file, content, options });
      }),
  });
  return { held, kept, written };
}

/** Catches a name the launcher mounted asked of the plane, and a name asked twice. */
test("only the granted names the launcher did not mount are asked for", async () => {
  assert.deepEqual(
    heldCredentialsUnmounted(
      ["forge", "claude-code", "track-record", "forge"],
      { "claude-code": "/c" },
    ),
    ["forge", "track-record"],
  );

  const plane = heldPlane({ status: 200, body: { credentials: [] } });
  await asked(plane, ["claude-code", "track-record"], { "claude-code": "/c" });

  assert.deepEqual(
    plane.asked.map(({ route, body }) => ({ route, body })),
    [{ route: "heldCredentials", body: { credentials: ["track-record"] } }],
  );
});

/** Catches a pod every granted name was mounted for asking anyway, as a pod launched with a credential map would. */
test("a pod mounted every granted name asks nothing", async () => {
  const plane = heldPlane({ status: 200, body: { credentials: [] } });

  const { held } = await asked(plane, ["forge"], { forge: "/f" });

  assert.deepEqual(held, []);
  assert.deepEqual(plane.asked, []);
});

/** Catches an empty answer read as a failure. */
test("a plane holding none of those asked is nothing to do", async () => {
  const plane = heldPlane({ status: 200, body: { credentials: [] } });

  assert.deepEqual(await asked(plane, ["track-record"]), {
    held: [],
    kept: [],
    written: [],
  });
});

/**
 * Catches a secret written before it is kept among the attempt's secrets, a
 * file anywhere but the minted directory, or one a user but the pod's reads.
 */
test("a held credential is kept, then written privately under the minted directory", async () => {
  const plane = heldPlane({
    status: 200,
    body: { credentials: [{ ...trackRecord, expiresAtMs: 1 }] },
  });
  const order = [];
  await heldCredentials({
    task,
    bearer: "capability",
    granted: ["track-record"],
    credentialFiles: {},
    directory: "/m",
    keep: () => order.push("kept"),
    request: plane.request,
    write: async () => {
      order.push("written");
    },
  });
  assert.deepEqual(order, ["kept", "written"]);

  const directory = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const { held, kept } = await asked(
      plane,
      ["track-record"],
      {},
      directory,
      writeFile,
    );

    const file = join(directory, "held-track-record");
    assert.deepEqual(held, [
      {
        credential: trackRecord.credential,
        variable: trackRecord.variable,
        value: file,
      },
    ]);
    assert.deepEqual(kept, [trackRecord.secret]);
    assert.equal(await readFile(file, "utf8"), trackRecord.secret);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Catches a refusal read as the plane holding nothing, which runs the job's shells without the credential. */
test("a refusal of the held credentials route fails the ask", async () => {
  for (const status of [400, 401, 409]) {
    const plane = heldPlane({ status });

    await assert.rejects(
      asked(plane, ["track-record"]),
      WorkerPlaneRefusal,
      String(status),
    );
    assert.equal(plane.asked.length, 1, String(status));
  }
});

/** Catches an outage given up on and read as the plane holding nothing. */
test("an outage of the held credentials route is asked again, and one past the retries fails the ask", async () => {
  assert.ok(Object.hasOwn(workerPlaneAnswers.heldCredentials, 503));
  const plane = heldPlane({ status: 503 });

  await assert.rejects(asked(plane, ["track-record"]), /answered 503/u);
  assert.ok(plane.asked.length > 1, String(plane.asked.length));
});

/** Catches an answer the schema refuses, or one serving a name not asked, which would be written and handed on. */
test("an answer this pod cannot read, or one serving a name not asked, fails the ask", async () => {
  const unread = async (credentials) => {
    const plane = { request: async () => ({ json: async () => credentials }) };
    await assert.rejects(asked(plane, ["track-record"]));
  };
  await unread({
    credentials: [{ ...trackRecord, variable: "GIT_TOKEN_FILE" }],
  });
  await unread({ credentials: [{ ...trackRecord, secret: "" }] });
  await unread({ credentials: [{ ...trackRecord, credential: "forge" }] });
  await unread("not an answer");
});

/**
 * A bundle serving a Secret file, a Text file naming it by placeholder, and a
 * Path and a Value variable, each naming a file.
 */
const forgeBundle = {
  credential: "forge",
  files: [
    { file: "token", content: { kind: "Secret", secret: "forge-secret-0123" } },
    {
      file: "config",
      content: {
        kind: "Text",
        text: `token-file = ${heldCredentialFilePlaceholder("token")}\n`,
      },
    },
  ],
  variables: [
    { kind: "Path", variable: "FORGE_TOKEN_FILE", file: "token" },
    {
      kind: "Value",
      variable: "FORGE_ARGUMENTS",
      value: `--config=${heldCredentialFilePlaceholder("config")}`,
    },
  ],
};

/**
 * Catches a bundle's secret left out of what is kept, a file written anywhere
 * but its credential's directory under the minted directory or readable past
 * the pod's user, a placeholder left unfilled, a variable handed anything but
 * its file's path or its filled value, or the legacy shape beside it changed.
 */
test("a bundle's files are written privately to its own directory, and its variables handed their paths and filled values", async () => {
  assert.ok(
    workerHeldCredentialBundleSchema.safeParse(forgeBundle).success,
    "the case serves a bundle the contract reads",
  );
  const plane = heldPlane({
    status: 200,
    body: { credentials: [forgeBundle, trackRecord] },
  });
  const directory = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const { held, kept } = await asked(
      plane,
      ["forge", "track-record"],
      {},
      directory,
      writeFile,
    );

    const bundleDirectory = join(directory, "held-forge");
    const token = join(bundleDirectory, "token");
    const config = join(bundleDirectory, "config");
    const legacy = join(directory, "held-track-record");
    assert.deepEqual(kept, [
      forgeBundle.files[0].content.secret,
      trackRecord.secret,
    ]);
    assert.deepEqual(held, [
      { credential: "forge", variable: "FORGE_TOKEN_FILE", value: token },
      {
        credential: "forge",
        variable: "FORGE_ARGUMENTS",
        value: `--config=${config}`,
      },
      {
        credential: trackRecord.credential,
        variable: trackRecord.variable,
        value: legacy,
      },
    ]);
    assert.equal(
      await readFile(token, "utf8"),
      forgeBundle.files[0].content.secret,
    );
    assert.equal(await readFile(config, "utf8"), `token-file = ${token}\n`);
    assert.equal(await readFile(legacy, "utf8"), trackRecord.secret);
    for (const file of [token, config, legacy])
      assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    assert.equal((await stat(bundleDirectory)).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Catches a bundle's file written while a secret of it is not yet among the attempt's secrets. */
test("every Secret content of a bundle is kept before any of its files is written", async () => {
  const bundle = {
    ...forgeBundle,
    files: [
      ...forgeBundle.files,
      { file: "key", content: { kind: "Secret", secret: "forge-key-0123" } },
    ],
  };
  const plane = heldPlane({ status: 200, body: { credentials: [bundle] } });
  const order = [];
  await heldCredentials({
    task,
    bearer: "capability",
    granted: ["forge"],
    credentialFiles: {},
    directory: "/m",
    keep: (value) => order.push(`kept ${value}`),
    request: plane.request,
    makeDirectory: async (made) => {
      order.push(`made ${made}`);
    },
    write: async (file) => {
      order.push(`written ${file}`);
    },
  });

  assert.deepEqual(order, [
    "kept forge-secret-0123",
    "kept forge-key-0123",
    "made /m/held-forge",
    "written /m/held-forge/token",
    "written /m/held-forge/config",
    "written /m/held-forge/key",
  ]);
});

/** Catches a granted name that would write its secret outside the minted directory. */
test("an answer serving a name no file in the minted directory can be named by fails the ask, keeping and writing nothing", async () => {
  const credential = "a/../../x";
  const plane = heldPlane({
    status: 200,
    body: { credentials: [{ ...trackRecord, credential }] },
  });
  const kept = [];
  const written = [];

  await assert.rejects(
    heldCredentials({
      task,
      bearer: "capability",
      granted: [credential],
      credentialFiles: {},
      directory: "/m",
      keep: (value) => kept.push(value),
      request: plane.request,
      write: async (file) => {
        written.push(file);
      },
    }),
    /no file in the minted directory can be named by/u,
  );
  assert.deepEqual(
    plane.asked.map(({ body }) => body),
    [{ credentials: [credential] }],
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(written, []);
});
