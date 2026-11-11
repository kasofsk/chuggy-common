/**
 * A job's workspace that its runner keeps, and what says whose work it holds.
 *
 * THE CORE WRITES WHOSE WORK A WORKSPACE HOLDS in `keptWorkspaceRecordName`
 * at the workspace's root, beside the checkout and outside it, so no commit
 * or push carries it: the ticket, attempt and stage, the repository once the
 * input names it, and `safe`, set only once what the run did is somewhere
 * other than the workspace, or the run changed nothing.
 *
 * A RUNNER REMOVES A JOB'S WORKSPACE ONLY WHERE THE JOB ENDED CLEAN: it ended
 * of itself with status 0, and its record says its work is safe. Every other
 * workspace is kept, and a record of it written in `keptWorkspaceDirectory` of
 * the runner's log directory. Nothing removes a kept workspace or its record
 * but the runner's operator.
 */

import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

/** The workspace's record, at the root of the workspace it describes. */
export const keptWorkspaceRecordName = "chuggy-workspace.json";

/** Far above any record the core writes, which bounds what a runner reads of one. */
export const keptWorkspaceRecordBytesMax = 4096;

/** Where a runner's records of the workspaces it kept are, in its log directory. */
export const keptWorkspaceDirectory = "kept-workspaces";

/** A name a record carries, which a log line can hold as it is. */
const keptWorkspaceIdentifier = z.string().regex(/^[\x21-\x7e]{1,200}$/u);

export const keptWorkspaceRecordSchema = z
  .object({
    ticket: z.number().int().nonnegative(),
    attempt: keptWorkspaceIdentifier,
    stage: z.number().int().nonnegative().optional(),
    repository: keptWorkspaceIdentifier.optional(),
    safe: z.boolean(),
  })
  .strict();

const keptWorkspaceKeptSchema = z
  .object({
    workspace: z.string().min(1),
    reason: z.string().min(1),
    keptAt: z.string().min(1),
    ticket: z.number().int().nonnegative().optional(),
    attempt: keptWorkspaceIdentifier.optional(),
    stage: z.number().int().nonnegative().optional(),
    repository: keptWorkspaceIdentifier.optional(),
  })
  .strict();

/**
 * @typedef {z.infer<typeof keptWorkspaceRecordSchema>} KeptWorkspaceRecord
 * @typedef {{record: KeptWorkspaceRecord} | {unread: string}} KeptWorkspaceRead
 * @typedef {z.infer<typeof keptWorkspaceKeptSchema>} KeptWorkspaceKept
 */

/**
 * Writes a workspace's record, scrubbed.
 *
 * @param {string} workspace
 * @param {KeptWorkspaceRecord} record
 * @param {(text: string) => string} scrub
 */
export async function keptWorkspaceRecordWritten(workspace, record, scrub) {
  await writeFile(
    join(workspace, keptWorkspaceRecordName),
    scrub(`${JSON.stringify(keptWorkspaceRecordSchema.parse(record))}\n`),
  );
}

/**
 * A workspace's record read from `file`, or why it could not be: only a
 * regular file is read, never through a link, and never past
 * `keptWorkspaceRecordBytesMax`, so what a job left there cannot make the
 * read wait or reach anything else.
 *
 * @param {string} file
 * @returns {Promise<KeptWorkspaceRead>}
 */
export async function keptWorkspaceRecordRead(file) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const found = await handle.stat();
    if (!found.isFile()) return { unread: "it is not a file" };
    if (found.size > keptWorkspaceRecordBytesMax)
      return {
        unread: `it is over ${String(keptWorkspaceRecordBytesMax)} bytes`,
      };
    const parsed = keptWorkspaceRecordSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    return parsed.success
      ? { record: parsed.data }
      : { unread: "it is not a record this runner reads" };
  } catch (failure) {
    return {
      unread:
        failure instanceof SyntaxError
          ? "it is not a record this runner reads"
          : /** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT"
            ? "there is none"
            : failure instanceof Error
              ? failure.message
              : String(failure),
    };
  } finally {
    await handle?.close();
  }
}

/**
 * Why a job's workspace is kept, or nothing where its job ended clean.
 *
 * @param {string | undefined} unclean why the job did not end of itself with status 0, which keeps its workspace whatever its record says
 * @param {KeptWorkspaceRead} read
 */
export function keptWorkspaceWhy(unclean, read) {
  if (unclean !== undefined) return unclean;
  if ("unread" in read)
    return `its workspace record could not be read: ${read.unread}`;
  if (!read.record.safe)
    return "its workspace record does not say its work is safe";
  return undefined;
}

/**
 * What a kept workspace holds, as a log line and the operator's listing say it.
 *
 * @param {Pick<KeptWorkspaceKept, "ticket" | "attempt" | "stage" | "repository">} kept
 */
function keptWorkspaceHolds({ ticket, attempt, stage, repository }) {
  if (ticket === undefined) return "its workspace record could not be read";
  return [
    `ticket ${String(ticket)}`,
    `attempt ${String(attempt)}`,
    ...(stage === undefined ? [] : [`stage ${String(stage)}`]),
    ...(repository === undefined ? [] : [`repository ${repository}`]),
  ].join(", ");
}

/**
 * Records a kept workspace beside the runner's saved logs, answering the line
 * its log says it with: the workspace, why it is kept, and the ticket, attempt
 * and stage its record names, or that its record could not be read.
 *
 * @param {string} logDir
 * @param {string} workspace the volume's name or the directory's path
 * @param {string} reason
 * @param {KeptWorkspaceRead} read
 * @param {number} nowMs
 */
export async function keptWorkspaceKept(
  logDir,
  workspace,
  reason,
  read,
  nowMs,
) {
  const record = "record" in read ? read.record : undefined;
  /** @type {KeptWorkspaceKept} */
  const kept = {
    workspace,
    reason,
    keptAt: new Date(nowMs).toISOString(),
    ...(record === undefined
      ? {}
      : {
          ticket: record.ticket,
          attempt: record.attempt,
          ...(record.stage === undefined ? {} : { stage: record.stage }),
          ...(record.repository === undefined
            ? {}
            : { repository: record.repository }),
        }),
  };
  const line = `${workspace} is kept, since ${reason}: ${keptWorkspaceHolds(kept)}`;
  try {
    const directory = join(logDir, keptWorkspaceDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, `${basename(workspace)}.json`),
      `${JSON.stringify(kept)}\n`,
      { mode: 0o600 },
    );
    return line;
  } catch (failure) {
    return `${line}; it could not be recorded: ${failure instanceof Error ? failure.message : String(failure)}`;
  }
}

/**
 * Whether a record of a kept workspace names `workspace`, read from the one
 * file `keptWorkspaceKept` writes for it. A record there that cannot be read
 * is taken to name it, so nothing removes a workspace whose record is damaged.
 *
 * @param {string} logDir
 * @param {string} workspace
 */
export async function keptWorkspaceRecorded(logDir, workspace) {
  let text;
  try {
    text = await readFile(
      join(logDir, keptWorkspaceDirectory, `${basename(workspace)}.json`),
      "utf8",
    );
  } catch (failure) {
    return /** @type {NodeJS.ErrnoException} */ (failure).code !== "ENOENT";
  }
  try {
    const parsed = keptWorkspaceKeptSchema.safeParse(JSON.parse(text));
    return !parsed.success || parsed.data.workspace === workspace;
  } catch {
    return true;
  }
}

/**
 * The records of every workspace a runner kept, by the file each is in; one
 * that cannot be read is left out.
 *
 * @param {string} logDir
 * @returns {Promise<KeptWorkspaceKept[]>}
 */
export async function keptWorkspacesRecorded(logDir) {
  const directory = join(logDir, keptWorkspaceDirectory);
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  /** @type {KeptWorkspaceKept[]} */
  const kept = [];
  for (const name of names.toSorted()) {
    try {
      const parsed = keptWorkspaceKeptSchema.safeParse(
        JSON.parse(await readFile(join(directory, name), "utf8")),
      );
      if (parsed.success) kept.push(parsed.data);
    } catch {
      // A record removed or half written since the listing.
    }
  }
  return kept;
}

/**
 * The operator's listing of kept workspaces, a line each: the workspace, its
 * size where `sizes` knows it, what its record names, when it was kept and
 * why. A workspace `unrecorded` names that no record names is listed as one.
 *
 * @param {readonly KeptWorkspaceKept[]} kept
 * @param {ReadonlyMap<string, number>} sizes bytes, by workspace
 * @param {readonly string[]} [unrecorded]
 */
export function keptWorkspacesListed(kept, sizes, unrecorded = []) {
  /** @param {string} workspace */
  const size = (workspace) => {
    const bytes = sizes.get(workspace);
    return bytes === undefined
      ? "size unknown"
      : `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  };
  const recorded = new Set(kept.map(({ workspace }) => workspace));
  return [
    ...kept.map(
      (each) =>
        `${each.workspace}  ${size(each.workspace)}  ${keptWorkspaceHolds(each)}; kept ${each.keptAt}, since ${each.reason}`,
    ),
    ...unrecorded
      .filter((workspace) => !recorded.has(workspace))
      .map(
        (workspace) =>
          `${workspace}  ${size(workspace)}  no record of why it is kept`,
      ),
  ];
}
