import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  author,
  git,
  headOf,
  inCheckout,
  remoteRefs,
} from "./checkout.fixture.mjs";
import {
  commitAndPushSource,
  resultDocument,
  sourceSecretReader,
  ticketBranch,
} from "./source.mjs";

/** Two secrets a pod holds, as its push is handed them. */
const held = [
  {
    kind: "the Claude Code credential",
    value: "sk-ant-oat01-0123456789abcdefghijklmnop",
  },
  {
    kind: "the git credential the plane minted",
    value: "ghs_0123456789abcdefghijklmnopqrstuvwxyz",
  },
];

test("ticket branch is deterministic, bounded, and names the ticket", () => {
  assert.equal(
    ticketBranch({ ticket: 42, attempt: "attempt-identity" }),
    "refs/heads/chuggy/tickets/42/attempts/" +
      "9a33b56cbbac4db829e4917c5ac9369958062635f18534cfc26b48071229a39f",
  );
});

test("source publication commits all changes and pushes a new attempt ref", async () => {
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const environment = { GIT_ASKPASS: "askpass" };
  const source = await commitAndPushSource({
    task: {
      ticket: 7,
      attempt: "opaque",
      worker: { files: [{ path: ".claude/settings.json" }] },
    },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment,
    secrets: [],
  });

  assert.deepEqual(source, {
    repository: "chuggy",
    ref: ticketBranch({ ticket: 7, attempt: "opaque" }),
    commit: "abc123",
    base: "base123",
  });
  assert.deepEqual(calls.at(-1), {
    executable: "git",
    args: ["push", "http://git/rig.git", `HEAD:${source.ref}`],
    options: { cwd: "/workspace/repository", env: environment },
  });
  assert.ok(calls.some(({ args }) => args[0] === "add" && args[1] === "--all"));
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === "reset" && args.at(-1) === ".claude/settings.json",
    ),
  );
  assert.ok(
    calls.some(
      ({ args }) => args[0] === "commit" && args.includes("--allow-empty"),
    ),
  );
});

test("a push that can take a fresh credential takes one, and uses it", async () => {
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return args[0] === "rev-parse" ? { stdout: "abc123\n" } : { stdout: "" };
  };
  const refreshed = {
    GIT_ASKPASS: "askpass",
    CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/later",
  };
  let refreshes = 0;

  await commitAndPushSource({
    task: { ticket: 7, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: "http://git/rig.git",
    base: "base123",
    directory: "/workspace/repository",
    command,
    environment: {
      GIT_ASKPASS: "askpass",
      CHUG_WORKER_GIT_CREDENTIAL_FILE: "/tmp/earlier",
    },
    secrets: [],
    refresh: async () => {
      assert.equal(
        calls.at(-1).args[0],
        "rev-parse",
        "the credential is taken after everything the commit needed, not before",
      );
      refreshes += 1;
      return refreshed;
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(calls.at(-1).args[0], "push");
  assert.deepEqual(calls.at(-1).options.env, refreshed);
});

/**
 * One attempt published from a checkout by git itself, holding `held`: the
 * source it declared or the error it was refused with, and how many times its
 * push asked for a credential.
 */
async function publishedFrom({ remote, directory, base }) {
  const asked = { refreshes: 0 };
  const source = commitAndPushSource({
    task: { ticket: 9, attempt: "opaque", worker: {} },
    repositoryId: "chuggy",
    repository: remote,
    base,
    directory,
    command: git,
    environment: process.env,
    secrets: held,
    refresh: async () => {
      asked.refreshes += 1;
      return process.env;
    },
  });
  return { asked, source: await source.catch((error) => error) };
}

/**
 * Driven against real repositories, because whether a commit exists when nothing
 * changed is git's answer and not the stub's. Catches a commit that stopped
 * being `--allow-empty`: the attempt would crash where it should have declared
 * the work its commands found nothing left to do.
 */
test("an attempt that changed nothing still declares a commit on its branch", async () => {
  await inCheckout(async ({ remote, directory, base }) => {
    const { source } = await publishedFrom({ remote, directory, base });

    const { stdout: changed } = await git(
      "git",
      ["diff", "--name-only", base, source.commit],
      { cwd: directory },
    );
    assert.equal(changed, "", "the attempt changed the tree it was given");
    assert.notEqual(source.commit, base);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/**
 * Catches a check that refuses what it should pass: an attempt holding secrets
 * whose commits carry none pushes as it did before there was a check, and
 * takes its credential only once the check is done.
 */
test("an attempt whose commits carry no held secret pushes them", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(
      join(checkout.directory, "large.bin"),
      Buffer.concat([
        Buffer.alloc(1 << 20),
        Buffer.from(held[0].value.slice(1)),
      ]),
    );

    const { asked, source } = await publishedFrom(checkout);

    assert.equal(asked.refreshes, 1);
    const { stdout: pushed } = await git("git", ["rev-parse", source.ref], {
      cwd: checkout.remote,
    });
    assert.equal(pushed.trim(), source.commit);
  });
});

/** Asserts `refused` is the check's refusal of `secret` in `commit`, and that nothing left the checkout. */
async function assertRefused(checkout, { refused, asked }, expected) {
  assert.ok(refused instanceof Error, "the attempt pushed a secret");
  assert.equal(
    refused.message,
    `commit ${expected.commit} carries ${expected.secret.kind} in ${expected.place}, so the attempt pushes nothing`,
  );
  assert.ok(!refused.message.includes(expected.secret.value));
  assert.equal(
    asked.refreshes,
    0,
    "a credential was minted for a refused push",
  );
  assert.equal(await remoteRefs(checkout.remote), "");
}

/**
 * Catches a check that reads only the first secret, or only text: each held
 * secret is refused at the end of a binary file too large for one read.
 */
test("a file carrying any held secret is refused, and nothing is pushed", async () => {
  for (const secret of held)
    await inCheckout(async (checkout) => {
      await writeFile(
        join(checkout.directory, "large.bin"),
        Buffer.concat([Buffer.alloc(1 << 20), Buffer.from(secret.value)]),
      );

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        {
          secret,
          commit: await headOf(checkout.directory),
          place: "a file",
        },
      );
    });
});

/** A file the agent committed itself, and the commit it made. */
async function agentCommitted(directory, path, content) {
  await writeFile(join(directory, path), content);
  await git("git", ["add", path], { cwd: directory });
  await git("git", [...author, "commit", "-m", "the agent's"], {
    cwd: directory,
  });
  return headOf(directory);
}

/**
 * The check reads every commit the push adds, and names the first to carry
 * the secret. Catches a check of the attempt's final tree, which a secret the
 * agent committed and the attempt's own commit removed would pass, and one
 * naming the attempt's own commit for a secret the agent's put there.
 */
test("a secret is refused at the commit that first carries it, whether or not a later one removes it", async () => {
  for (const removed of [true, false])
    await inCheckout(async (checkout) => {
      const { directory } = checkout;
      const added = await agentCommitted(directory, "token", held[1].value);
      if (removed) await rm(join(directory, "token"));

      const { asked, source: refused } = await publishedFrom(checkout);

      await assertRefused(
        checkout,
        { refused, asked },
        { secret: held[1], commit: added, place: "a file" },
      );
    });
});

test("a secret in a commit's message is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    await git(
      "git",
      [...author, "commit", "--allow-empty", "-m", `saw ${held[0].value}`],
      { cwd: directory },
    );
    const carrying = await headOf(directory);

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: carrying,
        place: "its message",
      },
    );
  });
});

test("a secret in a file's name is refused", async () => {
  await inCheckout(async (checkout) => {
    await writeFile(join(checkout.directory, held[0].value), "named\n");

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      {
        secret: held[0],
        commit: await headOf(checkout.directory),
        place: "a path",
      },
    );
  });
});

/**
 * A push sends the objects a commit names, whatever a replacement ref stands
 * in for them. Catches a check that reads the replacement: an agent's
 * `git replace` would show it a clean file while the secret was pushed.
 */
test("a secret behind a replacement ref is refused", async () => {
  await inCheckout(async (checkout) => {
    const { directory } = checkout;
    const carrying = await agentCommitted(directory, "token", held[1].value);
    const { stdout: blob } = await git("git", ["rev-parse", "HEAD:token"], {
      cwd: directory,
    });
    await writeFile(join(directory, "clean"), "clean\n");
    const { stdout: clean } = await git("git", ["hash-object", "-w", "clean"], {
      cwd: directory,
    });
    await rm(join(directory, "clean"));
    await git("git", ["replace", blob.trim(), clean.trim()], {
      cwd: directory,
    });

    const { asked, source: refused } = await publishedFrom(checkout);

    await assertRefused(
      checkout,
      { refused, asked },
      { secret: held[1], commit: carrying, place: "a file" },
    );
  });
});

/** `git cat-file --batch` output for blobs of these contents. */
function catFileOutput(...contents) {
  return Buffer.concat(
    contents.map((content, index) =>
      Buffer.from(
        `${String(index).repeat(40)} blob ${String(Buffer.byteLength(content))}\n${content}\n`,
      ),
    ),
  );
}

/** What a reader answers for `output` fed in chunks cut at `cuts`. */
function readInChunks(output, cuts) {
  const reader = sourceSecretReader(held);
  const bounds = [0, ...cuts, output.length];
  for (let index = 1; index < bounds.length; index += 1) {
    const found = reader.read(
      output.subarray(bounds[index - 1], bounds[index]),
    );
    if (found !== undefined) return found;
  }
  reader.end();
  return undefined;
}

/**
 * Chunks are where a pipe cuts them, never where an object does. Catches a
 * secret lost at a chunk boundary, and the opposite: two objects whose ends
 * meet to spell one.
 */
test("a secret is found across the chunks of one object and never across two objects", () => {
  const secret = held[0].value;
  const half = Math.floor(secret.length / 2);
  const whole = catFileOutput(`before ${secret} after`);
  const cut = whole.indexOf(secret) + half;
  for (const cuts of [[cut], [3, cut, cut + 1]])
    assert.equal(
      readInChunks(whole, cuts)?.kind,
      held[0].kind,
      `cut at ${cuts}`,
    );

  const apart = catFileOutput(secret.slice(0, half), secret.slice(half));
  for (let cut = 1; cut < apart.length; cut += 1)
    assert.equal(readInChunks(apart, [cut]), undefined, `cut at ${cut}`);
});

test("every worker report uses the schema that carries its summary", () => {
  assert.equal(
    resultDocument({ verdict: "Fail", report: "failed" }).version,
    3,
  );
  assert.equal(
    resultDocument({
      verdict: "Pass",
      report: "passed",
      source: { repository: "chuggy" },
    }).version,
    3,
  );
});
