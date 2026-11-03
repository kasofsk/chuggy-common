/**
 * What a Codex run persisted of the limit that stopped it: the fields of its
 * rollout `rateLimit.mjs` reads, which `codex exec --json` drops from the
 * stream.
 *
 * THE FILE IS FOUND BY ITS THREAD ID, never by a date path built here. Codex
 * writes it as `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`
 * under its home, the folders and timestamp in its own process's local time,
 * and a reverted thread's name carries `_<rollout id>` after the thread id.
 * Only the run's own home is searched, a link below `sessions` is not
 * followed, and a compressed `.zst` is not read.
 *
 * THE READ IS BOUNDED. The directories walked, the file's tail read and each
 * line parsed have a limit, and a line past its limit is skipped before it is
 * parsed. What cannot be found or read is a warning and nothing declared,
 * never a failure.
 */

import { Buffer } from "node:buffer";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";

/** The directories under `sessions` a search walks. */
export const codexRolloutDirectoriesMax = 64;

/** The entries of one directory a search looks at. */
export const codexRolloutEntriesMax = 1_024;

/** The bytes at the end of a rollout read, where its last turn is. */
export const codexRolloutTailBytesMax = 4_194_304;

/** The longest line parsed; a snapshot or a turn's end is far shorter. */
export const codexRolloutLineBytesMax = 262_144;

const codexRolloutPrefix = "rollout-";
const codexRolloutSuffix = ".jsonl";
const codexRolloutTimestampChars = "YYYY-MM-DDThh-mm-ss-".length;
const codexRolloutFolderDepth = "YYYY/MM/DD".split("/").length;
const codexRolloutThreadPattern = /^[0-9A-Za-z-]{1,64}$/u;

/** Whether `name` is the plain rollout of `thread`, or of a thread reverted from it. */
function codexRolloutNamed(name, thread) {
  if (
    !name.startsWith(codexRolloutPrefix) ||
    !name.endsWith(codexRolloutSuffix)
  )
    return false;
  const ids = name
    .slice(codexRolloutPrefix.length, -codexRolloutSuffix.length)
    .slice(codexRolloutTimestampChars);
  return ids === thread || ids.startsWith(`${thread}_`);
}

/** The first entries of `directory`, up to a directory's bound. */
async function codexRolloutEntries(directory) {
  const entries = [];
  for await (const entry of await opendir(directory)) {
    entries.push(entry);
    if (entries.length >= codexRolloutEntriesMax) break;
  }
  return entries;
}

/** The latest-named rollout of `thread` in the date folders under `sessions`, or nothing. */
async function codexRolloutFound(sessions, thread) {
  let walked = 0;
  let level = [sessions];
  for (let depth = 0; depth < codexRolloutFolderDepth; depth += 1) {
    const next = [];
    for (const directory of level) {
      if (walked >= codexRolloutDirectoriesMax) break;
      walked += 1;
      for (const entry of await codexRolloutEntries(directory))
        if (entry.isDirectory()) next.push(join(directory, entry.name));
    }
    level = next;
  }
  const found = [];
  for (const directory of level.slice(0, codexRolloutDirectoriesMax))
    for (const entry of await codexRolloutEntries(directory))
      if (entry.isFile() && codexRolloutNamed(entry.name, thread))
        found.push(join(directory, entry.name));
  return found.sort().at(-1);
}

/** The last bytes of the file at `path`, and whether they begin mid-line. */
async function codexRolloutTail(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - codexRolloutTailBytesMax);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return { bytes: buffer.subarray(0, bytesRead), partial: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Each whole line of `bytes` no longer than a line's bound, as text. */
function codexRolloutLines({ bytes, partial }) {
  const lines = [];
  let from = 0;
  let first = true;
  while (from < bytes.length) {
    const newline = bytes.indexOf(0x0a, from);
    const to = newline === -1 ? bytes.length : newline;
    if (!(first && partial) && to - from <= codexRolloutLineBytesMax)
      lines.push(bytes.toString("utf8", from, to));
    first = false;
    from = to + 1;
  }
  return lines;
}

/** What a rollout that declared nothing declares. */
function codexRolloutNone() {
  return {
    snapshot: undefined,
    snapshotTimestamp: undefined,
    errorInfo: undefined,
  };
}

/**
 * What `lines` of a rollout declared: `snapshot`, the last `token_count`'s
 * `rate_limits` that carried one, `snapshotTimestamp`, that line's
 * `timestamp`, and `errorInfo`, the last `task_complete`'s
 * `error.codex_error_info`. A line that is not JSON, or is any other record, is
 * passed over.
 */
export function codexRolloutDeclared(lines) {
  const declared = codexRolloutNone();
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const { payload } = record;
    if (
      payload?.type === "token_count" &&
      typeof payload.rate_limits === "object" &&
      payload.rate_limits !== null
    ) {
      declared.snapshot = payload.rate_limits;
      declared.snapshotTimestamp = record.timestamp;
    }
    if (payload?.type === "task_complete")
      declared.errorInfo = payload.error?.codex_error_info;
  }
  return declared;
}

/**
 * What the rollout of `thread` under the Codex home `home` declared, read once
 * after its process has exited. Where there is none to read, `warn` is told why
 * and nothing is declared.
 */
export async function codexRolloutRead({ home, thread, warn }) {
  const none = codexRolloutNone();
  if (typeof home !== "string" || home.length === 0) {
    warn("Codex's rollout was not read: the run named no Codex home\n");
    return none;
  }
  if (typeof thread !== "string" || !codexRolloutThreadPattern.test(thread)) {
    warn("Codex's rollout was not read: the stream named no thread\n");
    return none;
  }
  try {
    const path = await codexRolloutFound(join(home, "sessions"), thread);
    if (path === undefined) {
      warn(`Codex's rollout of thread ${thread} was not found\n`);
      return none;
    }
    return codexRolloutDeclared(
      codexRolloutLines(await codexRolloutTail(path)),
    );
  } catch (failure) {
    if (failure?.code === "ENOENT") {
      warn(`Codex's rollout of thread ${thread} was not found\n`);
      return none;
    }
    warn(
      `Codex's rollout of thread ${thread} could not be read: ${failure instanceof Error ? failure.message : String(failure)}\n`,
    );
    return none;
  }
}
