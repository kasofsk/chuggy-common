import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  fileLocked,
  fileLockHolderAlive,
  fileRenamedOver,
} from "./fileLock.mjs";

const bounds = {
  waitMsMax: 20_000,
  heldMsMax: 300_000,
  pollMs: 100,
  busy: "the lock is held past the wait",
};

async function lockPathOf(t) {
  const directory = await mkdtemp(join(tmpdir(), "file-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "held.lock");
}

function portsOf(overrides) {
  return {
    pid: process.pid,
    nowMs: Date.now,
    wait: async () => {},
    holderAlive: fileLockHolderAlive,
    ...overrides,
  };
}

test("a holder is alive while its process runs", () => {
  assert.equal(fileLockHolderAlive(process.pid), true);
  assert.equal(fileLockHolderAlive(Number.NaN), false);
  assert.equal(fileLockHolderAlive(0), false);
});

/**
 * A rename failing with each code in `codes` in turn and then renaming,
 * recording each try and each wait.
 *
 * @param {readonly string[]} codes
 */
function renameFailing(codes) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    ports: {
      rename: async (/** @type {string} */ from, /** @type {string} */ to) => {
        calls.push(`rename ${from} ${to}`);
        const code =
          codes[calls.filter((c) => c.startsWith("rename")).length - 1];
        if (code !== undefined) throw Object.assign(new Error(code), { code });
      },
      wait: async (/** @type {number} */ ms) => {
        calls.push(`wait ${String(ms)}`);
      },
    },
  };
}

test("a rename Windows refuses for another process's brief hold is tried again, and any other failure is not", async () => {
  const held = renameFailing(["EPERM", "EBUSY", "EACCES"]);
  await fileRenamedOver("a", "b", held.ports);
  assert.deepEqual(held.calls.filter((c) => c.startsWith("rename")).length, 4);
  assert.ok(held.calls.includes("wait 100"));
  const missing = renameFailing(["ENOENT"]);
  await assert.rejects(fileRenamedOver("a", "b", missing.ports), {
    code: "ENOENT",
  });
  assert.deepEqual(missing.calls, ["rename a b"]);
  const stuck = renameFailing(Array(10).fill("EPERM"));
  await assert.rejects(fileRenamedOver("a", "b", stuck.ports), {
    code: "EPERM",
  });
  assert.equal(stuck.calls.filter((c) => c.startsWith("rename")).length, 5);
});

test("a lock whose holder is gone is taken, and one still held past the wait raises", async (t) => {
  const lock = await lockPathOf(t);
  await writeFile(lock, "4242\n");
  const abandoned = portsOf({ holderAlive: () => false });
  assert.equal(
    await fileLocked(lock, bounds, abandoned, async () => "held"),
    "held",
  );
  await assert.rejects(readFile(lock), { code: "ENOENT" });

  await writeFile(lock, "4242\n");
  let nowMs = Date.now();
  const startedMs = nowMs;
  const held = portsOf({
    holderAlive: () => true,
    nowMs: () => nowMs,
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  let ran = false;
  await assert.rejects(
    fileLocked(lock, bounds, held, async () => {
      ran = true;
    }),
    /held past the wait/,
  );
  assert.equal(ran, false);
  assert.ok(nowMs - startedMs >= bounds.waitMsMax);
  await readFile(lock);
});

test("a lock older than any hold is taken whoever it names, and a younger one is waited on", async (t) => {
  const lock = await lockPathOf(t);
  await writeFile(lock, `${String(process.pid)}\n`);
  const startedMs = Date.now();
  let nowMs = startedMs;
  const ports = portsOf({
    nowMs: () => nowMs,
    wait: async (ms) => {
      nowMs += ms;
    },
  });
  await assert.rejects(
    fileLocked(lock, bounds, ports, async () => "taken"),
    /held past the wait/,
  );
  nowMs = startedMs + bounds.heldMsMax + 1_000;
  assert.equal(
    await fileLocked(lock, bounds, ports, async () => "taken"),
    "taken",
  );
});

test("a held lock names its holder whole", async (t) => {
  const lock = await lockPathOf(t);
  const seen = await fileLocked(lock, bounds, portsOf({}), async () =>
    readFile(lock, "utf8"),
  );
  assert.equal(seen, `${String(process.pid)}\n`);
});
