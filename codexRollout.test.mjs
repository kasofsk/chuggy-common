import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexRolloutDeclared,
  codexRolloutLineBytesMax,
  codexRolloutRead,
  codexRolloutTailBytesMax,
} from "./codexRollout.mjs";
import {
  limitSnapshot,
  ordinarySnapshot,
  rolloutFolder,
  rolloutLine,
  rolloutName,
  rolloutThread,
  tokenCount,
  usageLimitComplete,
  windowlessSnapshot,
} from "./codexRollout.fixture.mjs";

/** A Codex home of its own holding `lines` as the rollout `name`, and the warnings a read of it gave. */
async function rolloutHome(t, lines, name = rolloutName()) {
  const home = await mkdtemp(join(tmpdir(), "chuggy-codex-rollout-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, "sessions", ...rolloutFolder);
  await mkdir(folder, { recursive: true });
  if (lines !== undefined)
    await writeFile(join(folder, name), `${lines.join("\n")}\n`);
  const warned = [];
  return {
    home,
    folder,
    warned,
    read: (...thread) =>
      codexRolloutRead({
        home,
        thread: thread.length === 0 ? rolloutThread : thread[0],
        warn: (text) => warned.push(text),
      }),
  };
}

/** A line past the bound on one, which would have said the account was fine. */
function oversizedLine() {
  return rolloutLine({
    ...tokenCount(ordinarySnapshot),
    info: { padding: "x".repeat(codexRolloutLineBytesMax) },
  });
}

/**
 * Catches a limit missed for a line before it that is not JSON or is another
 * record, an oversized line parsed, and an earlier snapshot read in place of
 * the last.
 */
test("a rollout declares its last snapshot and its turn's error, past what it cannot read", async (t) => {
  const { read, warned } = await rolloutHome(t, [
    rolloutLine(tokenCount(ordinarySnapshot)),
    "not a record",
    JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    rolloutLine({ type: "warning", message: "hello" }),
    rolloutLine(tokenCount(limitSnapshot)),
    oversizedLine(),
    rolloutLine(usageLimitComplete),
  ]);

  assert.deepEqual(await read(), {
    snapshot: limitSnapshot,
    errorInfo: "usage_limit_exceeded",
  });
  assert.deepEqual(warned, []);
});

test("a rollout's limit with no windows is still its turn's error", async (t) => {
  const { read } = await rolloutHome(t, [
    rolloutLine(tokenCount(windowlessSnapshot)),
    rolloutLine(usageLimitComplete),
  ]);

  assert.deepEqual(await read(), {
    snapshot: windowlessSnapshot,
    errorInfo: "usage_limit_exceeded",
  });
});

test("an ordinary rollout declares an ordinary snapshot and no error", () => {
  assert.deepEqual(
    codexRolloutDeclared([
      rolloutLine(tokenCount(limitSnapshot)),
      rolloutLine(tokenCount(ordinarySnapshot)),
      rolloutLine(tokenCount(null)),
      rolloutLine({ ...usageLimitComplete, error: undefined }),
    ]),
    { snapshot: ordinarySnapshot, errorInfo: undefined },
  );
});

/** Catches a reverted thread's rollout missed, which a built name would. */
test("a reverted thread's rollout is found by its thread", async (t) => {
  const { read } = await rolloutHome(
    t,
    [rolloutLine(usageLimitComplete)],
    rolloutName(`${rolloutThread}_019a4f4e-0000-7000-8000-000000000001`),
  );

  assert.equal((await read()).errorInfo, "usage_limit_exceeded");
});

/** Catches a run failed, or a read beyond the run's own thread, where there is nothing to read. */
test("a rollout that is not there is a warning and nothing declared", async (t) => {
  const none = { snapshot: undefined, errorInfo: undefined };
  const { read, warned } = await rolloutHome(t, [
    rolloutLine(usageLimitComplete),
  ]);

  assert.deepEqual(await read("019a4f4e-ffff-7fff-8fff-ffffffffffff"), none);
  assert.deepEqual(await read(undefined), none);
  assert.deepEqual(await read("../escape"), none);
  assert.deepEqual(
    await codexRolloutRead({
      home: undefined,
      thread: rolloutThread,
      warn: (text) => warned.push(text),
    }),
    none,
  );
  assert.equal(warned.length, 4);
  assert.match(warned[0], /was not found/u);
  assert.match(warned[1], /named no thread/u);
  assert.match(warned[2], /named no thread/u);
  assert.match(warned[3], /named no Codex home/u);
});

test("a compressed rollout is not read", async (t) => {
  const { read, warned } = await rolloutHome(
    t,
    [rolloutLine(usageLimitComplete)],
    `${rolloutName()}.zst`,
  );

  assert.equal((await read()).errorInfo, undefined);
  assert.match(warned[0], /was not found/u);
});

test("a rollout behind a link is not read", async (t) => {
  const elsewhere = await rolloutHome(t, [rolloutLine(usageLimitComplete)]);
  const { read, folder, warned } = await rolloutHome(t, undefined);
  await symlink(
    join(elsewhere.folder, rolloutName()),
    join(folder, rolloutName()),
  );

  assert.equal((await read()).errorInfo, undefined);
  assert.match(warned[0], /was not found/u);
});

/** Catches a whole rollout read, and a line cut by the tail's start parsed. */
test("only a rollout's tail is read, from its first whole line", async (t) => {
  const filler = rolloutLine({ type: "warning", message: "y".repeat(1_000) });
  const fillers = Array.from(
    { length: Math.ceil(codexRolloutTailBytesMax / filler.length) + 1 },
    () => filler,
  );
  const early = await rolloutHome(t, [
    rolloutLine(usageLimitComplete),
    ...fillers,
  ]);
  const late = await rolloutHome(t, [
    ...fillers,
    rolloutLine(tokenCount(limitSnapshot)),
  ]);

  assert.equal((await early.read()).errorInfo, undefined);
  assert.deepEqual(early.warned, []);
  assert.deepEqual((await late.read()).snapshot, limitSnapshot);
});

test("an unreadable rollout is a warning and nothing declared", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "chuggy-codex-rollout-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "sessions"), "");
  const warned = [];

  assert.deepEqual(
    await codexRolloutRead({
      home,
      thread: rolloutThread,
      warn: (text) => warned.push(text),
    }),
    { snapshot: undefined, errorInfo: undefined },
  );
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not be read/u);
});
