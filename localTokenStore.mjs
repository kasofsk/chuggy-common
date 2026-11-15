/**
 * A person's renewal token for one site, kept in the worker contract's shared
 * sign-in store (`@chuggy/worker-contract/signInStore`), which chuggy's setup
 * program reads and renews as the same sign-in.
 *
 * THE RENEWAL TOKEN IS SPENT BY THE REQUEST THAT USES IT, and the issuer ends
 * the whole sign-in when shown a spent one. So a renewal reads the token,
 * spends it and writes its replacement inside one hold of the store's lock,
 * which every program on the machine that uses the store takes, and no server
 * keeps a renewal token in memory past that hold.
 *
 * THE LOCK IS THE CONTRACT'S: a directory holding one entry whose name is what
 * the lock says, changing hands only by renaming that entry from the word it
 * was judged by, and made whole under a draft's name where there is none. The
 * holder is the store's one writer, so it removes what a write cut short left.
 *
 * A TOKEN AN OLDER COPY KEPT is moved into the store by the first hold that
 * finds it, under that copy's own lock, and is kept only where the store holds
 * none for the site.
 */

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  signInStoreDraftName,
  signInStoreDraftOf,
  signInStoreFileName,
  signInStoreLockFree,
  signInStoreLockHolder,
  signInStoreLockName,
  signInStoreLockStale,
  signInStoreLockWord,
  signInStoreText,
  signInStoreTokenRead,
} from "@chuggy/worker-contract/signInStore";

import { fileLocked, fileLockHolderAlive } from "./fileLock.mjs";

/** How long a renewal waits for another program's hold to end before it gives up. */
export const localTokenStoreLockWaitMsMax = 20_000;

/** How long between two looks at a lock another program holds. */
export const localTokenStoreLockPollMs = 100;

/** How old an older copy's lock may be before it is abandoned whoever it names. */
export const localTokenStoreFormerLockHeldMsMax = 300_000;

const localTokenStoreFileMode = 0o600;
const localTokenStoreDirectoryMode = 0o700;

async function localTokenStoreText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if (failure?.code === "ENOENT") return undefined;
    throw failure;
  }
}

/** What the lock says: a holder's word, or another name it holds to be taken from, or nothing where it is free or absent. */
async function localTokenStoreLockSaid(lock) {
  let names;
  try {
    names = await readdir(lock);
  } catch (failure) {
    if (failure?.code === "ENOENT") return undefined;
    throw failure;
  }
  const words = names.filter(
    (name) =>
      name === signInStoreLockFree || signInStoreLockHolder(name) !== undefined,
  );
  if (words.length > 1)
    throw new Error(`the sign-in lock at ${lock} says more than one word`);
  const [word] = words;
  if (word === undefined) return names.toSorted()[0];
  return word === signInStoreLockFree ? undefined : word;
}

async function localTokenStoreRenamed(from, to) {
  try {
    await rename(from, to);
    return true;
  } catch (failure) {
    if (failure?.code === "ENOENT") return false;
    throw failure;
  }
}

/** Makes the lock where there is none, already saying `word`; answers no where another program made it first. */
async function localTokenStoreLockMade(directory, lock, word, pid) {
  const draft = join(directory, signInStoreDraftName(signInStoreLockName, pid));
  await rm(draft, { recursive: true, force: true });
  await mkdir(draft, { mode: localTokenStoreDirectoryMode });
  try {
    await writeFile(join(draft, word), "", {
      mode: localTokenStoreFileMode,
      flag: "wx",
    });
    await rename(draft, lock);
    return true;
  } catch (failure) {
    if (failure?.code === "ENOTEMPTY" || failure?.code === "EEXIST")
      return false;
    throw failure;
  } finally {
    await rm(draft, { recursive: true, force: true });
  }
}

/** The lock moved from what it said, `from`, to `word`; answers no where it no longer says `from`. */
async function localTokenStoreLockSwapped(directory, lock, from, word, pid) {
  if (
    await localTokenStoreRenamed(
      join(lock, from ?? signInStoreLockFree),
      join(lock, word),
    )
  )
    return true;
  return (
    from === undefined && localTokenStoreLockMade(directory, lock, word, pid)
  );
}

/** Takes the lock, waiting at most `localTokenStoreLockWaitMsMax` for a holder, and answers the word it was taken under. */
async function localTokenStoreLockTaken(directory, lock, ports) {
  const turns =
    Math.ceil(localTokenStoreLockWaitMsMax / localTokenStoreLockPollMs) + 1;
  for (let turn = 0; turn < turns; turn += 1) {
    const held = await localTokenStoreLockSaid(lock);
    const nowMs = ports.nowMs();
    const nobodys =
      held === undefined ||
      signInStoreLockStale(held, nowMs, ports.holderAlive);
    const mine = signInStoreLockWord(ports.pid, nowMs);
    if (
      nobodys &&
      (await localTokenStoreLockSwapped(directory, lock, held, mine, ports.pid))
    )
      return mine;
    if (turn + 1 < turns) await ports.wait(localTokenStoreLockPollMs);
  }
  throw new Error(
    `another program has held the sign-in lock at ${lock} for longer than a renewal waits`,
  );
}

/** Removes every draft a write cut short left in the store; the caller holds the lock. */
async function localTokenStoreSwept(directory) {
  for (const name of await readdir(directory))
    if (signInStoreDraftOf(name) !== undefined)
      await rm(join(directory, name), { recursive: true, force: true });
}

/**
 * The renewal token for `origin` in the shared store at `directory`. `read`
 * answers it or nothing, `write` replaces it, `clear` forgets it, and `locked`
 * runs one renewal under the store's lock. `former`, where given, is the file
 * an older copy kept the token in.
 */
export function localTokenStore(directory, origin, overrides = {}) {
  const { former, ...rest } = overrides;
  const ports = {
    pid: process.pid,
    nowMs: Date.now,
    wait,
    holderAlive: fileLockHolderAlive,
    ...rest,
  };
  const name = signInStoreFileName(origin);
  const path = join(directory, name);
  const lock = join(directory, signInStoreLockName);
  const store = {
    async read() {
      const text = await localTokenStoreText(path);
      return text === undefined ? undefined : signInStoreTokenRead(text);
    },
    async write(token) {
      if (signInStoreTokenRead(signInStoreText(token)) !== token)
        throw new Error(
          "the sign-in server issued a token the store cannot hold",
        );
      const draft = join(directory, signInStoreDraftName(name, ports.pid));
      await writeFile(draft, signInStoreText(token), {
        mode: localTokenStoreFileMode,
      });
      await rename(draft, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
    async locked(renewal) {
      await mkdir(directory, {
        recursive: true,
        mode: localTokenStoreDirectoryMode,
      });
      const mine = await localTokenStoreLockTaken(directory, lock, ports);
      try {
        await localTokenStoreSwept(directory);
        await localTokenStoreMoved(store, path, former, ports);
        return await renewal();
      } finally {
        await localTokenStoreRenamed(
          join(lock, mine),
          join(lock, signInStoreLockFree),
        );
      }
    },
  };
  return store;
}

/** Moves the token an older copy kept at `former` into the store, under that copy's lock; the caller holds the store's. */
async function localTokenStoreMoved(store, path, former, ports) {
  if (former === undefined || resolve(former) === resolve(path)) return;
  if ((await localTokenStoreText(former)) === undefined) return;
  const formerLock = `${former}.lock`;
  const bounds = {
    waitMsMax: localTokenStoreLockWaitMsMax,
    heldMsMax: localTokenStoreFormerLockHeldMsMax,
    pollMs: localTokenStoreLockPollMs,
    busy: `an older chuggy tool server has held the sign-in lock at ${formerLock} for longer than a renewal waits`,
  };
  await fileLocked(formerLock, bounds, ports, async () => {
    const token = (await localTokenStoreText(former))?.trim();
    if (
      token !== undefined &&
      signInStoreTokenRead(token) === token &&
      (await store.read()) === undefined
    )
      await store.write(token);
    await rm(former, { force: true });
  });
}
