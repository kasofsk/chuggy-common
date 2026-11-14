import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  workerContractCredentialBundles,
  workerContractHeader,
  workerContractRelease,
  workerContractRunCredentialAbsent,
} from "@chuggy/worker-contract/workerContract";
import {
  heldCredentialFilePlaceholder,
  workerHeldCredentialBundleSchema,
  workerPlaneAnswers,
} from "@chuggy/worker-contract/workerPlane";

import {
  heldCredentialFileWritten,
  heldCredentials,
  heldCredentialsUnmounted,
} from "./heldCredentials.mjs";
import { overPlane, planeFetch, planes } from "./plane.fixture.mjs";
import { RunStepFailure, runCredentialAbsent } from "./runEvidence.mjs";
import { WorkerPlaneRefusal, workerRequest } from "./transport.mjs";

const task = { workerPlane: { url: "http://worker-plane.test:3001" } };
const trackRecord = {
  credential: "track-record",
  variable: "TRACK_RECORD_TOKEN_FILE",
  secret: "track-record-0123456789abcdefghij",
};

/** The release just before the plane serves bundles, whose answers serve single secrets. */
const releaseBeforeBundles = `${String(workerContractCredentialBundles.major)}.${String(workerContractCredentialBundles.minor - 1)}.0`;

/** The release just before the plane takes a run ended for a credential not delivered. */
const releaseBeforeCredentialAbsent = `${String(workerContractRunCredentialAbsent.major)}.${String(workerContractRunCredentialAbsent.minor - 1)}.0`;

/** A plane answering the held credentials route `answer`, every ask of it recorded. */
function heldPlane(answer) {
  const plane = planeFetch(planes.job, () => answer);
  return {
    asked: plane.asked,
    request: overPlane(workerRequest, plane.fetch),
  };
}

/**
 * What one ask, given `listed` and the launcher's `credentialFiles`, kept and
 * wrote; through `write` where a case names it, which `written` then holds
 * nothing of.
 */
async function asked(
  plane,
  listed,
  credentialFiles = {},
  directory = "/m",
  write,
) {
  const kept = [];
  const written = [];
  const held = await heldCredentials({
    task,
    bearer: "capability",
    listed,
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
test("only the listed names the launcher did not mount are asked for", async () => {
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

/** Catches a pod every listed name was mounted for asking anyway. */
test("a pod mounted every listed name asks nothing", async () => {
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
    release: releaseBeforeBundles,
  });
  const order = [];
  await heldCredentials({
    task,
    bearer: "capability",
    listed: ["track-record"],
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
      heldCredentialFileWritten,
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
    assert.deepEqual(await readdir(directory), ["held-track-record"]);
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
 * its file's path or its filled value, or a file's writing name left behind.
 */
test("a bundle's files are written privately to its own directory, and its variables handed their paths and filled values", async () => {
  assert.ok(
    workerHeldCredentialBundleSchema.safeParse(forgeBundle).success,
    "the case serves a bundle the contract reads",
  );
  const plane = heldPlane({
    status: 200,
    body: { credentials: [forgeBundle] },
  });
  const directory = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const { held, kept } = await asked(
      plane,
      ["forge"],
      {},
      directory,
      heldCredentialFileWritten,
    );

    const bundleDirectory = join(directory, "held-forge");
    const token = join(bundleDirectory, "token");
    const config = join(bundleDirectory, "config");
    assert.deepEqual(kept, [forgeBundle.files[0].content.secret]);
    assert.deepEqual(held, [
      { credential: "forge", variable: "FORGE_TOKEN_FILE", value: token },
      {
        credential: "forge",
        variable: "FORGE_ARGUMENTS",
        value: `--config=${config}`,
      },
    ]);
    assert.equal(
      await readFile(token, "utf8"),
      forgeBundle.files[0].content.secret,
    );
    assert.equal(await readFile(config, "utf8"), `token-file = ${token}\n`);
    for (const file of [token, config])
      assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    assert.equal((await stat(bundleDirectory)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(bundleDirectory)).sort(), [
      "config",
      "token",
    ]);
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
    listed: ["forge"],
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

/**
 * Catches a placeholder filled with a path read as a replacement pattern, so
 * `$&` in it is not the path, or a path already filled in read again for a
 * placeholder its credential's name holds.
 */
test("a placeholder is filled with its file's path literally, whatever the credential's name holds", async () => {
  const token = heldCredentialFilePlaceholder("token");
  const config = heldCredentialFilePlaceholder("config");
  for (const credential of ["a$&b$'c$`d$$e", `c${token}`]) {
    const bundle = {
      ...forgeBundle,
      credential,
      files: [
        forgeBundle.files[0],
        {
          file: "config",
          content: { kind: "Text", text: `${config} ${token}\n` },
        },
      ],
      variables: [
        ...forgeBundle.variables,
        { kind: "Value", variable: "FORGE_BOTH", value: `${config} ${token}` },
      ],
    };
    assert.ok(
      workerHeldCredentialBundleSchema.safeParse(bundle).success,
      "the case serves a bundle the contract reads",
    );
    const plane = heldPlane({ status: 200, body: { credentials: [bundle] } });
    const written = [];
    const held = await heldCredentials({
      task,
      bearer: "capability",
      listed: [credential],
      credentialFiles: {},
      directory: "/m",
      keep: () => {},
      request: plane.request,
      makeDirectory: async () => {},
      write: async (file, content) => {
        written.push({ file, content });
      },
    });

    const bundleDirectory = `/m/held-${credential}`;
    const both = `${bundleDirectory}/config ${bundleDirectory}/token`;
    assert.equal(
      written.find(({ file }) => file === `${bundleDirectory}/config`).content,
      `${both}\n`,
    );
    assert.equal(
      held.find(({ variable }) => variable === "FORGE_ARGUMENTS").value,
      `--config=${bundleDirectory}/config`,
    );
    assert.equal(
      held.find(({ variable }) => variable === "FORGE_BOTH").value,
      both,
    );
  }
});

/** Catches a listed name that would write its secret outside the minted directory. */
test("an answer serving a name no file in the minted directory can be named by fails the ask, keeping and writing nothing", async () => {
  const credential = "a/../../x";
  const plane = heldPlane({
    status: 200,
    body: { credentials: [{ ...trackRecord, credential }] },
    release: releaseBeforeBundles,
  });
  const kept = [];
  const written = [];

  await assert.rejects(
    heldCredentials({
      task,
      bearer: "capability",
      listed: [credential],
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

/** One Secret file `file`, named by one Path variable. */
function oneFileBundle(file, variable = "FORGE_TOKEN_FILE") {
  return {
    credential: "forge",
    files: [{ file, content: { kind: "Secret", secret: "forge-secret-0123" } }],
    variables: [{ kind: "Path", variable, file }],
  };
}

/** What one ask of `plane` for `listed` kept, wrote, made and warned, or the error it failed with. */
async function seamed(plane, listed) {
  const seen = { kept: [], written: [], made: [], warned: [] };
  try {
    seen.held = await heldCredentials({
      task,
      bearer: "capability",
      listed,
      credentialFiles: {},
      directory: "/m",
      keep: (value) => seen.kept.push(value),
      request: plane.request,
      makeDirectory: async (made) => {
        seen.made.push(made);
      },
      write: async (file) => {
        seen.written.push(file);
      },
      warn: (text) => seen.warned.push(text),
    });
  } catch (error) {
    seen.error = error;
  }
  return seen;
}

/** Catches a shape read from a plane whose version does not serve it, which a bundle's or a secret's fields would be misread from. */
test("the plane's version chooses the shape read, and the other shape fails the ask, keeping and writing nothing", async () => {
  const bundle = oneFileBundle("token");
  for (const [body, release] of [
    [{ credentials: [bundle] }, releaseBeforeBundles],
    [{ credentials: [trackRecord] }, workerContractRelease],
  ]) {
    const seen = await seamed(heldPlane({ status: 200, body, release }), [
      "forge",
      "track-record",
    ]);
    assert.match(
      String(seen.error),
      /in a shape its version does not serve/u,
      release,
    );
    assert.deepEqual(
      [seen.kept, seen.written, seen.made],
      [[], [], []],
      release,
    );
  }

  const bundled = await seamed(
    heldPlane({ status: 200, body: { credentials: [bundle] } }),
    ["forge"],
  );
  assert.deepEqual(bundled.written, ["/m/held-forge/token"]);
  const single = await seamed(
    {
      request: async () => ({
        json: async () => ({ credentials: [trackRecord] }),
      }),
    },
    ["track-record"],
  );
  assert.deepEqual(single.written, ["/m/held-track-record"]);
});

/**
 * Catches a bundle written and handed on that sets a variable chuggy, its
 * agent runtime or git reads its own settings from, writes a file outside its
 * directory under the minted one, or serves a name not asked.
 */
test("a bundle naming a reserved variable, a file outside the minted directory, or a name not asked fails the ask, keeping and writing nothing", async () => {
  assert.ok(
    workerHeldCredentialBundleSchema.safeParse(oneFileBundle("token")).success,
    "the case refuses bundles one defect away from one the contract reads",
  );
  const refused = [
    oneFileBundle("token", "GIT_TOKEN_FILE"),
    oneFileBundle("token", "CHUG_TOKEN_FILE"),
    oneFileBundle("token", "CLAUDE_TOKEN_FILE"),
    {
      ...oneFileBundle("token"),
      variables: [
        ...oneFileBundle("token").variables,
        { kind: "Value", variable: "GIT_CONFIG_GLOBAL", value: "x" },
      ],
    },
    oneFileBundle("../token"),
    oneFileBundle("../../token"),
    oneFileBundle("a/token"),
    oneFileBundle("/token"),
    oneFileBundle(".."),
    { ...oneFileBundle("token"), credential: "a/../../x" },
    { ...oneFileBundle("token"), credential: "linear" },
  ];
  for (const bundle of refused) {
    const seen = await seamed(
      {
        request: async () => ({
          headers: new Map([[workerContractHeader, workerContractRelease]]),
          json: async () => ({ credentials: [bundle] }),
        }),
      },
      ["forge", "a/../../x"],
    );
    const named = JSON.stringify(bundle);
    assert.ok(seen.error instanceof Error, named);
    assert.deepEqual([seen.kept, seen.written, seen.made], [[], [], []], named);
  }
});

/** Catches an absence failing the ask to a plane that would refuse its label, logged without its credential or its reason, or logged as more or fewer lines than it names. */
test("to a plane before RunCredentialAbsent, each credential named absent is logged as one line with its reason, and fails nothing", async () => {
  const absent = [
    { credential: "track-record", reason: "NotHeld" },
    { credential: "linear", reason: "IssuerRefused" },
  ];
  const seen = await seamed(
    heldPlane({
      status: 200,
      body: { credentials: [oneFileBundle("token")], absent },
      release: releaseBeforeCredentialAbsent,
    }),
    ["forge", "track-record", "linear"],
  );

  assert.equal(seen.error, undefined);
  assert.deepEqual(seen.written, ["/m/held-forge/token"]);
  assert.equal(seen.warned.length, absent.length);
  for (const [at, { credential, reason }] of absent.entries()) {
    assert.ok(seen.warned[at].includes(credential), seen.warned[at]);
    assert.ok(seen.warned[at].includes(reason), seen.warned[at]);
    assert.ok(seen.warned[at].endsWith("\n"), seen.warned[at]);
    assert.equal(seen.warned[at].indexOf("\n"), seen.warned[at].length - 1);
  }
});

/**
 * Catches a listed credential not delivered letting the attempt run on, an
 * absence not logged before the ending, or the ending naming any but the first.
 */
test("to a plane taking RunCredentialAbsent, every absence is logged and the first ends the attempt under that label, keeping and writing nothing", async () => {
  const absent = [
    { credential: "track-record", reason: "NotGranted" },
    { credential: "linear", reason: "NotHeld" },
  ];
  const seen = await seamed(
    heldPlane({
      status: 200,
      body: { credentials: [oneFileBundle("token")], absent },
    }),
    ["forge", "track-record", "linear"],
  );

  assert.ok(seen.error instanceof RunStepFailure, String(seen.error));
  assert.equal(seen.error.evidence, runCredentialAbsent);
  assert.deepEqual(seen.error.absent, absent[0]);
  assert.ok(seen.error.message.includes("track-record"), seen.error.message);
  assert.ok(seen.error.message.includes("NotGranted"), seen.error.message);
  assert.equal(seen.warned.length, absent.length);
  for (const [at, { credential }] of absent.entries())
    assert.ok(seen.warned[at].includes(credential), seen.warned[at]);
  assert.deepEqual([seen.kept, seen.written, seen.made], [[], [], []]);

  const delivered = await seamed(
    heldPlane({
      status: 200,
      body: { credentials: [oneFileBundle("token")], absent: [] },
    }),
    ["forge"],
  );
  assert.equal(delivered.error, undefined);
  assert.deepEqual(delivered.written, ["/m/held-forge/token"]);
});

/** Catches a held file written in place, so a reader can see part of it, or written under a name beside it that is left behind. */
test("a held file is written under a name beside it and renamed onto it", async () => {
  const calls = [];
  await heldCredentialFileWritten(
    "/m/held-forge/token",
    "secret",
    { mode: 0o600 },
    {
      writeFile: async (file, content, options) => {
        calls.push(["write", file, content, options]);
      },
      rename: async (from, to) => {
        calls.push(["rename", from, to]);
      },
    },
  );
  const [[, writing], ...rest] = calls;
  assert.notEqual(writing, "/m/held-forge/token");
  assert.equal(join(writing, ".."), "/m/held-forge");
  assert.deepEqual(calls, [
    ["write", writing, "secret", { mode: 0o600 }],
    ...rest,
  ]);
  assert.deepEqual(rest, [["rename", writing, "/m/held-forge/token"]]);

  const directory = await mkdtemp(join(tmpdir(), "chuggy-held-"));
  try {
    const file = join(directory, "held-forge");
    await heldCredentialFileWritten(file, "first, and longer", { mode: 0o600 });
    await heldCredentialFileWritten(file, "second", { mode: 0o600 });
    assert.equal(await readFile(file, "utf8"), "second");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["held-forge"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
