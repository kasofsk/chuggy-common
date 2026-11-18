/**
 * A person's sign-in to one site, kept in the worker contract's shared sign-in
 * store (`@chuggy/worker-contract/signInStore`): the renewal token, the access
 * record binding the newest access token to it, the ended record saying when
 * and why the issuer ended the sign-in, and the pending record of a device
 * sign-in the person has yet to approve; and the store's lock every renewal
 * is made under. chuggy's setup program keeps the same sign-in there, as the
 * same client, so either signs the other in.
 *
 * THE RENEWAL TOKEN IS SPENT BY THE REQUEST THAT USES IT, and the issuer ends
 * the whole sign-in when shown a spent one. Every chat on the machine runs a
 * server of its own, and the setup program is a process of its own too, so a
 * renewal reads the token, spends it and writes its replacement inside one
 * hold of the lock, and no server keeps a renewal token in memory past that
 * hold.
 *
 * THE LOCK IS THE CONTRACT'S: a directory holding one entry whose name is what
 * the lock says, which changes hands only by renaming that entry from the word
 * it was judged by. Of the processes that judge the same lock nobody's, the
 * one whose rename finds that word takes it and every other finds it gone.
 * The holder is the store's one writer, so it removes what a write cut short
 * left before it reads.
 *
 * A token an earlier copy kept in a file of its own is moved into the store by
 * the first hold that finds it, kept only where the store holds none for the
 * site, and its file removed.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  signInStoreAccessDigest,
  signInStoreAccessName,
  signInStoreAccessRead,
  signInStoreAccessText,
  signInStoreDraftName,
  signInStoreDraftOf,
  signInStoreEndedName,
  signInStoreEndedRead,
  signInStoreEndedText,
  signInStoreFileName,
  signInStoreLockFree,
  signInStoreLockHolder,
  signInStoreLockName,
  signInStoreLockStale,
  signInStoreLockWord,
  signInStorePendingName,
  signInStorePendingRead,
  signInStorePendingText,
  signInStoreText,
  signInStoreTokenRead,
} from "@chuggy/worker-contract/signInStore";

import { fileLockHolderAlive } from "./fileLock.mjs";

/** How long a renewal waits for another process's hold to end before it gives up. */
export const localTokenStoreLockWaitMsMax = 20_000;

/** How long between two looks at a lock another process holds. */
export const localTokenStoreLockPollMs = 100;

const localTokenStoreFileMode = 0o600;
const localTokenStoreDirectoryMode = 0o700;

function localTokenStoreAbsent(failure) {
  return failure?.code === "ENOENT" || failure?.code === "ENOTDIR";
}

async function localTokenStoreText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if (localTokenStoreAbsent(failure)) return undefined;
    throw failure;
  }
}

/**
 * What the lock says: a holder's word, or nothing where it is free or not
 * there. With neither a word nor `free`, it says the first other name in it,
 * which is nobody's, so the next taker renames that.
 */
async function localTokenStoreLockSaid(lock) {
  let names;
  try {
    names = await readdir(lock);
  } catch (failure) {
    if (localTokenStoreAbsent(failure)) return undefined;
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

/** Makes the lock where there is none, already saying `word`; false where another process made it first. */
async function localTokenStoreLockMade(directory, lock, word, pid) {
  const draft = join(directory, signInStoreDraftName(signInStoreLockName, pid));
  await rm(draft, { recursive: true, force: true });
  await mkdir(draft, { mode: localTokenStoreDirectoryMode });
  try {
    await writeFile(join(draft, word), "", {
      flag: "wx",
      mode: localTokenStoreFileMode,
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

/** The lock's entry renamed from `from` to `next`, nothing being `free`; false where it no longer says `from`. */
async function localTokenStoreLockSwapped(directory, lock, from, next, pid) {
  try {
    await rename(
      join(lock, from ?? signInStoreLockFree),
      join(lock, next ?? signInStoreLockFree),
    );
    return true;
  } catch (failure) {
    if (!localTokenStoreAbsent(failure)) throw failure;
  }
  return (
    from === undefined &&
    next !== undefined &&
    localTokenStoreLockMade(directory, lock, next, pid)
  );
}

/** Removes every draft in the store, whichever process's: the lock's holder is its one writer. */
async function localTokenStoreSwept(directory) {
  for (const name of await readdir(directory))
    if (signInStoreDraftOf(name) !== undefined)
      await rm(join(directory, name), { force: true });
}

/** `text` written whole as `name` in the store: under the process's draft, renamed over it. */
async function localTokenStoreWritten(directory, name, text, pid) {
  const draft = join(directory, signInStoreDraftName(name, pid));
  await rm(draft, { force: true });
  await writeFile(draft, text, { flag: "wx", mode: localTokenStoreFileMode });
  await rename(draft, join(directory, name));
}

/** The digest an access record binds `renewal` by. */
function localTokenStoreDigest(renewal) {
  return createHash(signInStoreAccessDigest)
    .update(renewal, "utf8")
    .digest("hex");
}

/** The access, ended and pending records' methods of `localTokenStore`, each record written through `written`, beside the renewal file at `renewalPath`. */
function localTokenStoreRecords(directory, origin, renewalPath, written) {
  const accessPath = join(directory, signInStoreAccessName(origin));
  const endedPath = join(directory, signInStoreEndedName(origin));
  const pendingPath = join(directory, signInStorePendingName(origin));
  return {
    async accessRead(renewal) {
      const text = await localTokenStoreText(accessPath);
      return text === undefined
        ? undefined
        : signInStoreAccessRead(text, localTokenStoreDigest(renewal));
    },
    /** An access token the record cannot hold is not kept, and the record naming an older one is removed. */
    async accessWrite({ accessToken, expiresAtMs }, renewal) {
      let text;
      try {
        text = signInStoreAccessText({
          accessToken,
          expiresAtMs: Math.floor(expiresAtMs),
          renewalDigest: localTokenStoreDigest(renewal),
        });
      } catch {
        await rm(accessPath, { force: true });
        return;
      }
      await written(signInStoreAccessName(origin), text);
    },
    async accessClear() {
      await rm(accessPath, { force: true });
    },
    async endedRead() {
      const text = await localTokenStoreText(endedPath);
      return text === undefined ? undefined : signInStoreEndedRead(text);
    },
    endedWrite: (ended) =>
      written(signInStoreEndedName(origin), signInStoreEndedText(ended)),
    async endedClear() {
      await rm(endedPath, { force: true });
    },
    async pendingRead(nowMs) {
      const text = await localTokenStoreText(pendingPath);
      if (text === undefined) return undefined;
      const renewalHeld =
        (await localTokenStoreText(renewalPath)) !== undefined;
      return signInStorePendingRead(text, { renewalHeld, nowMs });
    },
    pendingWrite: (pending) =>
      written(signInStorePendingName(origin), signInStorePendingText(pending)),
    async pendingClear() {
      await rm(pendingPath, { force: true });
    },
  };
}

/**
 * The sign-in to `origin` in the store at `directory`. `read` answers the
 * renewal token or nothing, `write` replaces it, `clear` forgets it.
 * `accessRead` answers the access record's token and expiry where it names
 * the renewal token given, `accessWrite` binds one to a renewal token, and
 * `accessClear` forgets it; `endedRead`, `endedWrite` and `endedClear` do the
 * same for the ended record, and `pendingRead`, given the time, `pendingWrite`
 * and `pendingClear` for the pending record. `locked` runs one renewal under
 * the store's lock. `formerly` is the file an earlier copy kept the token in,
 * moved in by the first hold.
 *
 * @param {{directory: string, origin: string, formerly?: string}} place
 */
export function localTokenStore(
  { directory, origin, formerly },
  overrides = {},
) {
  const ports = {
    pid: process.pid,
    nowMs: Date.now,
    wait,
    holderAlive: fileLockHolderAlive,
    ...overrides,
  };
  const name = signInStoreFileName(origin);
  const path = join(directory, name);
  const lock = join(directory, signInStoreLockName);
  const written = (named, text) =>
    localTokenStoreWritten(directory, named, text, ports.pid);
  const store = {
    async read() {
      const text = await localTokenStoreText(path);
      return text === undefined ? undefined : signInStoreTokenRead(text);
    },
    write: (token) => written(name, signInStoreText(token)),
    async clear() {
      await rm(path, { force: true });
    },
    ...localTokenStoreRecords(directory, origin, path, written),
    async locked(renewal) {
      await mkdir(directory, {
        recursive: true,
        mode: localTokenStoreDirectoryMode,
      });
      const word = await localTokenStoreLockTaken(directory, lock, ports);
      try {
        await localTokenStoreSwept(directory);
        await localTokenStoreMoved(store, path, formerly);
        return await renewal();
      } finally {
        if ((await localTokenStoreLockSaid(lock)) === word)
          await localTokenStoreLockSwapped(
            directory,
            lock,
            word,
            undefined,
            ports.pid,
          );
      }
    },
  };
  return store;
}

/** The word this process took the lock under, waiting at most `localTokenStoreLockWaitMsMax` for another's hold. */
async function localTokenStoreLockTaken(directory, lock, ports) {
  const deadlineMs = ports.nowMs() + localTokenStoreLockWaitMsMax;
  for (;;) {
    const held = await localTokenStoreLockSaid(lock);
    const nowMs = ports.nowMs();
    const word = signInStoreLockWord(ports.pid, nowMs);
    if (
      (held === undefined ||
        signInStoreLockStale(held, nowMs, ports.holderAlive)) &&
      (await localTokenStoreLockSwapped(directory, lock, held, word, ports.pid))
    )
      return word;
    if (ports.nowMs() >= deadlineMs)
      throw new Error(
        `another program has held the sign-in lock at ${lock} for longer than a renewal waits`,
      );
    await ports.wait(localTokenStoreLockPollMs);
  }
}

/** The token at `formerly` moved into the store where it holds none, and `formerly` removed. */
async function localTokenStoreMoved(store, path, formerly) {
  if (formerly === undefined || formerly === path) return;
  const text = await localTokenStoreText(formerly);
  if (text === undefined) return;
  const token = signInStoreTokenRead(text.trim());
  if (token !== undefined && (await store.read()) === undefined)
    await store.write(token);
  await rm(formerly, { force: true });
}
