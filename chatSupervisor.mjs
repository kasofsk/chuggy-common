/**
 * The supervisor in a member's chat container: it reads the member's chat
 * host's frames on its standard input, runs each session the host starts as a
 * user of its own (`./chatSession.mjs`), and writes its own frames on its
 * standard output, as `@chuggy/worker-contract/chatHost` states them. It is
 * started as root, under an init that forwards its signals, and its own
 * process id is nothing it relies on.
 *
 * EVERY `Start` IS ANSWERED ONCE. A preparation or a running session is an
 * entry under its assignment from the `Start` that made it to the frame that
 * ends it — `Refused` for a preparation, `Ended` for a session — so a later
 * `Start` for it is a `Duplicate` before anything else is asked, and the
 * entries are what `sessionsMax` counts. A preparation a `Stop` reaches is
 * cancelled and refused `Stopped` once what it made is gone; one that had
 * already started its process stops it first, and is still refused, since the
 * host was told of no session to end.
 *
 * A THREAD'S SESSIONS RUN ONE AT A TIME, in the workspace kept for it
 * (`./chatSession.mjs`). A `Start` naming a thread an entry already names is
 * prepared once every such entry has ended, and its entry counts meanwhile.
 * A `Forget` is held until no entry names its thread, a `Start` naming it is
 * refused `Unprepared` while it is held, and then the thread's workspace is
 * removed and each `Forget` held for it is answered `Forgotten`.
 *
 * `Drain` ENDS WHAT HOLDS NO CLAIMED TURN. Every later `Start` is refused
 * `Draining`, unless it is a `Duplicate`; each preparation is cancelled, and
 * each session is stopped once it says it holds no claimed turn. Once no
 * entry is left and every `Forget` is answered, `Drained` is written and the
 * supervisor exits. To a host of a protocol before
 * `chatSupervisorThreadProtocol`, `Drain` only waits, as it did then.
 *
 * A SESSION RUNS ON THE CREDENTIAL ITS `Start` NAMES, the file the host
 * handed for that name in `CHUG_CHAT_CREDENTIALS`, and a `Start` naming one
 * it was handed no file for is refused `Unprepared`, never run on another. A
 * host that hands one file in `CHUG_CHAT_CREDENTIAL` instead names none, and
 * every session runs on that file, as each did under protocol 1, whose
 * `Start` names none.
 *
 * THE END OF ITS INPUT ENDS EVERYTHING. Every preparation is cancelled and
 * refused `Stopped`, every session is stopped and its `Ended` written, every
 * `Forget` held is answered once its thread's sessions have ended, and the
 * supervisor exits. A line longer than a frame, or one that is not a
 * frame, is a host this supervisor cannot follow, which it trusts no less
 * for it: it says so on its log, without the line, reads nothing more, and
 * ends as it would at the end of its input, exiting non-zero. A signal to end
 * is taken as the end of its input.
 *
 * THE PROTOCOL IS MORE THAN THE FRAMES. A host and a supervisor are built from
 * cores released apart, and `chatProtocolVersion` names everything one hands
 * the other: the frames, and the environment, mounts and tmpfs a host runs
 * this supervisor with. The host names the protocol it speaks in
 * `CHUG_CHAT_PROTOCOL`, which the supervisor reads before anything else, and
 * exits refusing a host that names none or one not in
 * `chatSupervisorProtocols`, saying which side to update. A supervisor's
 * `Ready` names the same protocols, and a host ends one that lacks its own.
 * So a change to any of that bumps the version, and the supervisor speaks the
 * old ones beside it, reading each shape, until its window ends: a host and a
 * supervisor a release apart then agree, and any further apart each refuses
 * the other before a session is claimed. `chatProtocol.test.mjs`
 * holds that shape against the version; it sees names and mounts, so a
 * value's form or meaning changing under a name it already holds — the JSON
 * in `CHUG_WORKER_CLAUDE_CREDENTIAL`, what `CHUG_CHAT_CREDENTIAL_UID` is the
 * uid of — bumps the version by hand. The version is chuggy's, in
 * `@chuggy/worker-contract`, so a bump is a contract release and then this
 * core's lock moved to it.
 *
 * THE WINDOW ENDS AT THE PLANE'S FLOOR. A version leaves
 * `chatSupervisorProtocols` only once the plane admits no host that speaks
 * only it: once chuggy's `workerContractChatHost.min`, the contract release
 * below which a chat host is refused every pool plane route, is at or past
 * the release that brought the version after it, which
 * `chatSupervisorProtocolOldest` is moved past then. The release a poll names
 * (`./runnerUpdate.mjs`) moves a host forward and refuses none, so it ends no
 * window.
 */

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chatHostCredentialSchema,
  chatProtocolFrameBytesMax,
  chatProtocolLine,
  chatProtocolVersion,
  parseChatHostFrame,
} from "@chuggy/worker-contract/chatHost";
import { workerContractRelease } from "@chuggy/worker-contract/workerContract";
import { workerRepositoriesVariable } from "@chuggy/worker-contract/workerEnvironment";
import { z } from "zod";

import {
  agentCredentialTypes,
  agentCredentialsMax,
} from "./agentCredentialSet.mjs";
import { chatLineReader, chatLineText } from "./chatChannel.mjs";
import {
  chatAbortable,
  chatCheckout,
  chatMirrorGroupCount,
  chatMirrorGroupFirst,
  chatMirrorsDirectory,
  chatMirrorsOpened,
} from "./chatCheckout.mjs";
import {
  chatSessionClearWaitMs,
  chatSessionEntrypoint,
  chatSessionFreeBytesMin,
  chatSessionGit,
  chatSessionStopGraceMs,
  chatSessionUidCount,
  chatSessionUidFirst,
  chatSessionsDirectory,
  chatSessionsMintedDirectory,
  chatSessionsOpened,
  chatSupervisorMintedDirectory,
  chatSystem,
} from "./chatSession.mjs";
import { claudeCredentialSettingSchema } from "./claudeCredential.mjs";
import { envelopeTask } from "./entrypoint.mjs";
import { planeCredential, sessionCredentialPath } from "./planeCredential.mjs";
import { workerRepositories } from "./repository.mjs";
import { sessionRequest } from "./sessionTransport.mjs";

/** The oldest protocol a host the plane admits may speak alone, as the module says. */
const chatSupervisorProtocolOldest = 1;

/**
 * The protocols this supervisor speaks, newest last: the version, and every
 * one before it back to `chatSupervisorProtocolOldest`, as the module says.
 */
export const chatSupervisorProtocols = Object.freeze(
  Array.from(
    { length: chatProtocolVersion - chatSupervisorProtocolOldest + 1 },
    (_, offset) => chatSupervisorProtocolOldest + offset,
  ),
);

/** The first protocol whose `Start` may name the credential its session runs on. */
const chatSupervisorCredentialProtocol = 2;

/** The first protocol whose `Start` may name a thread, which has `Forget`, and whose `Drain` ends what holds no claimed turn. */
const chatSupervisorThreadProtocol = 3;

/** Where the host names the protocol it speaks, which it sets beside every other variable. */
export const chatSupervisorProtocolVariable = "CHUG_CHAT_PROTOCOL";

/**
 * Why this supervisor cannot follow the host whose environment is
 * `environment`, naming the side to update, or nothing where it speaks the
 * host's protocol.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 */
export function chatSupervisorProtocolRefusal(environment) {
  const named = environment[chatSupervisorProtocolVariable];
  const spoken = /^[1-9]\d*$/u.test(named ?? "") ? Number(named) : undefined;
  if (spoken !== undefined && chatSupervisorProtocols.includes(spoken))
    return undefined;
  const newest = chatSupervisorProtocols.at(-1) ?? chatProtocolVersion;
  const side =
    spoken !== undefined && spoken > newest
      ? "update this image to one whose supervisor speaks it"
      : "update the host's runner to one that speaks one of these";
  return `this image's supervisor speaks protocol(s) [${chatSupervisorProtocols.join(", ")}]; the host speaks ${named === undefined || named.length === 0 ? "none" : named}: run matching versions; ${side}`;
}

/**
 * The variables a supervisor's places and bounds are read from, each its
 * constant where it is unset, and the provider credential's file and the
 * owner it is read as, which have none.
 */
export const chatSupervisorVariables = {
  uidFirst: "CHUG_CHAT_UID_FIRST",
  uidCount: "CHUG_CHAT_UID_COUNT",
  sessionsMax: "CHUG_CHAT_SESSIONS_MAX",
  sessionsRoot: "CHUG_CHAT_SESSIONS",
  mintedRoot: "CHUG_CHAT_MINTED",
  supervisorMinted: "CHUG_CHAT_SUPERVISOR_MINTED",
  mirrorsRoot: "CHUG_CHAT_MIRRORS",
  groupFirst: "CHUG_CHAT_MIRROR_GROUP_FIRST",
  groupCount: "CHUG_CHAT_MIRROR_GROUP_COUNT",
  credential: "CHUG_CHAT_CREDENTIAL",
  credentials: "CHUG_CHAT_CREDENTIALS",
  credentialUid: "CHUG_CHAT_CREDENTIAL_UID",
  credentialGid: "CHUG_CHAT_CREDENTIAL_GID",
};

/** A whole number `environment` names under `name`, `fallback` where it names none. */
function chatSupervisorCount(environment, name, fallback, least) {
  const value = environment[name];
  if (value === undefined || value.length === 0) return fallback;
  const count = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(count) || count < least)
    throw new RangeError(
      `${name} must be a whole number of at least ${String(least)}`,
    );
  return count;
}

/**
 * The Claude credentials a host hands in `chatSupervisorVariables.credentials`,
 * each named as a `Start` names it, with its file in this container and its
 * setting, which is of its type, and each name once.
 */
const chatSupervisorCredentialsSchema = z
  .array(
    z.strictObject({
      ...chatHostCredentialSchema.shape,
      agent: z.literal("Claude"),
      file: z.string().startsWith("/"),
      setting: claudeCredentialSettingSchema,
    }),
  )
  .min(1)
  .max(agentCredentialTypes.length * agentCredentialsMax)
  .superRefine((credentials, context) => {
    const names = new Set(credentials.map(({ name }) => name));
    if (names.size !== credentials.length)
      context.addIssue({ code: "custom", message: "names a credential twice" });
    for (const { type, setting } of credentials)
      if (setting.kind !== (type === "OAuth" ? "Subscription" : type))
        context.addIssue({
          code: "custom",
          message: `names a ${type} credential of the kind ${setting.kind}`,
        });
  });

/** The credentials `carried` names, refused where it is no list `chatSupervisorCredentialsSchema` reads. */
function chatSupervisorCredentialsNamed(carried) {
  let document;
  try {
    document = JSON.parse(carried);
  } catch {
    document = undefined;
  }
  const read = chatSupervisorCredentialsSchema.safeParse(document);
  if (!read.success)
    throw new RangeError(
      `${chatSupervisorVariables.credentials} names credentials this supervisor cannot read`,
    );
  return read.data;
}

/**
 * The provider credential's file, or the set of them, and the owner each is
 * read as, as `environment` names them, refused where it names both a file
 * and a set or neither, or an owner a session is run as, who could then read
 * them.
 */
function chatSupervisorCredential(environment, uidFirst, uidCount) {
  const names = chatSupervisorVariables;
  const credentialFile = environment[names.credential] ?? "";
  const carried = environment[names.credentials] ?? "";
  if (credentialFile.length > 0 && carried.length > 0)
    throw new RangeError(
      `${names.credential} and ${names.credentials} each name the provider credential; name one`,
    );
  const credentials =
    carried.length > 0 ? chatSupervisorCredentialsNamed(carried) : undefined;
  if (credentials === undefined && !credentialFile.startsWith("/"))
    throw new RangeError(
      `${names.credential} must name the provider credential's file by its absolute path`,
    );
  const uid = chatSupervisorCount(environment, names.credentialUid, -1, 0);
  const gid = chatSupervisorCount(environment, names.credentialGid, -1, 0);
  if (uid < 0 || gid < 0)
    throw new RangeError(
      `${names.credentialUid} and ${names.credentialGid} must name the owner the provider credential is read as`,
    );
  if (uid >= uidFirst && uid < uidFirst + uidCount)
    throw new RangeError(
      `the credential's owner ${String(uid)} is among the users a session is run as`,
    );
  return {
    ...(credentials === undefined ? { credentialFile } : { credentials }),
    credentialOwner: { uid, gid },
  };
}

/**
 * Where a supervisor makes what it makes, how many sessions it runs, and the
 * credential it hands them, read from `environment`, refused where a
 * session's user could be root, could share a number with a mirror's group,
 * which its own group would then be, or could own the credential.
 */
export function chatSupervisorSettings(environment) {
  const names = chatSupervisorVariables;
  const count = (name, fallback, least = 1) =>
    chatSupervisorCount(environment, name, fallback, least);
  const uidCount = count(names.uidCount, chatSessionUidCount);
  const uidFirst = count(names.uidFirst, chatSessionUidFirst);
  const settings = {
    uidFirst,
    uidCount,
    sessionsMax: Math.min(uidCount, count(names.sessionsMax, uidCount)),
    sessionsRoot: environment[names.sessionsRoot] || chatSessionsDirectory,
    mintedRoot: environment[names.mintedRoot] || chatSessionsMintedDirectory,
    supervisorMinted:
      environment[names.supervisorMinted] || chatSupervisorMintedDirectory,
    mirrorsRoot: environment[names.mirrorsRoot] || chatMirrorsDirectory,
    groupFirst: count(names.groupFirst, chatMirrorGroupFirst),
    groupCount: count(names.groupCount, chatMirrorGroupCount),
    freeBytesMin: chatSessionFreeBytesMin,
    stopGraceMs: chatSessionStopGraceMs,
    clearWaitMs: chatSessionClearWaitMs,
    node: process.execPath,
    entrypoint: chatSessionEntrypoint,
    ...chatSupervisorCredential(environment, uidFirst, uidCount),
    environment,
  };
  const uidLast = settings.uidFirst + settings.uidCount - 1;
  const groupLast = settings.groupFirst + settings.groupCount - 1;
  if (settings.uidFirst <= groupLast && settings.groupFirst <= uidLast)
    throw new RangeError(
      "the users a session may be run as overlap the groups a mirror may have",
    );
  return settings;
}

/** One frame on the supervisor's output. */
function chatSupervisorWritten(state, frame) {
  state.output.write(chatProtocolLine(frame));
}

/** The answer to `assignment`'s `Start` that it did not become a session, its entry gone. */
function chatSupervisorRefused(state, assignment, reason) {
  chatSupervisorWritten(state, { frame: "Refused", assignment, reason });
}

/** The supervisor's end, once no entry is left and no `Forget` is held after a `Drain` or the end of its input. */
function chatSupervisorSettled(state) {
  if (state.finished || state.entries.size > 0 || state.forgetting.size > 0)
    return;
  if (!state.draining && !state.closing) return;
  state.finished = true;
  if (state.draining) chatSupervisorWritten(state, { frame: "Drained" });
  state.finish(state.code);
}

/** The key a thread is held under, which no two threads share. */
function chatSupervisorThreadKey(thread) {
  return JSON.stringify([thread.project, thread.session]);
}

/** Whether an entry names the thread `key` is. */
function chatSupervisorThreadBusy(state, key) {
  for (const entry of state.entries.values())
    if (entry.thread === key) return true;
  return false;
}

/** An entry's preparation, then its session, answered and ended as its frames say. */
async function chatSupervisorPrepared(state, start, entry) {
  const { assignment, envelope, credential, thread } = start;
  const { signal } = entry.cancel;
  let running;
  try {
    await chatAbortable(signal, entry.after);
    signal.throwIfAborted();
    running = await state.sessions.prepared(
      assignment,
      envelope,
      signal,
      credential,
      thread,
    );
  } catch {
    running = undefined;
  }
  if (running === undefined || signal.aborted) {
    if (running !== undefined) {
      running.stop();
      await running.ended;
    }
    chatSupervisorRefused(
      state,
      assignment,
      signal.aborted ? "Stopped" : "Unprepared",
    );
  } else {
    entry.running = running;
    chatSupervisorWritten(state, { frame: "Started", assignment });
    const phase = await running.ended;
    chatSupervisorWritten(state, { frame: "Ended", assignment, phase });
  }
  state.entries.delete(assignment);
  entry.finish();
  if (entry.thread !== undefined) chatSupervisorForgetting(state, entry.thread);
  chatSupervisorSettled(state);
}

/**
 * A `Start`, answered at once where it is refused, and prepared where it is
 * not, once every entry naming its thread before it has ended.
 */
function chatSupervisorStart(state, start) {
  const { assignment } = start;
  const thread =
    start.thread === undefined
      ? undefined
      : chatSupervisorThreadKey(start.thread);
  if (state.entries.has(assignment))
    return chatSupervisorRefused(state, assignment, "Duplicate");
  if (state.draining)
    return chatSupervisorRefused(state, assignment, "Draining");
  if (state.entries.size >= state.sessionsMax)
    return chatSupervisorRefused(state, assignment, "Full");
  if (thread !== undefined && state.forgetting.has(thread))
    return chatSupervisorRefused(state, assignment, "Unprepared");
  const entry = {
    cancel: new globalThis.AbortController(),
    running: undefined,
    thread,
    after: Promise.resolve(),
    done: Promise.resolve(),
    finish: () => undefined,
  };
  entry.done = new Promise((resolve) => {
    entry.finish = resolve;
  });
  if (thread !== undefined) {
    entry.after = state.threadLast.get(thread) ?? Promise.resolve();
    // A cancelled entry finishes before the one it queued behind has ended.
    const ended = Promise.all([entry.after, entry.done]);
    state.threadLast.set(thread, ended);
    void ended.then(() => {
      if (state.threadLast.get(thread) === ended)
        state.threadLast.delete(thread);
    });
  }
  state.entries.set(assignment, entry);
  void chatSupervisorPrepared(state, start, entry);
  return undefined;
}

/** An entry asked to end: its preparation cancelled, or its session stopped. */
function chatSupervisorStopped(entry) {
  if (entry.running === undefined) entry.cancel.abort();
  else entry.running.stop();
}

/** An entry drained: its preparation cancelled, or its session ended once it holds no claimed turn. */
function chatSupervisorEntryDrained(entry) {
  if (entry.running === undefined) entry.cancel.abort();
  else entry.running.drain();
}

/**
 * The thread `key` is forgotten where a `Forget` is held for it and no entry
 * names it: its workspace removed, and each `Forget` held for it answered.
 */
function chatSupervisorForgetting(state, key) {
  const held = state.forgetting.get(key);
  if (held === undefined || held.removing) return;
  if (chatSupervisorThreadBusy(state, key)) return;
  held.removing = true;
  void (async () => {
    try {
      await state.sessions.forgotten(held.thread);
    } catch (failure) {
      state.log(
        `the workspace of a closed thread could not be removed, and is still kept: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
    }
    state.forgetting.delete(key);
    for (let answer = 0; answer < held.count; answer += 1)
      chatSupervisorWritten(state, { frame: "Forgotten", thread: held.thread });
    chatSupervisorSettled(state);
  })();
}

/** A `Forget`, held until no entry names its thread. */
function chatSupervisorForget(state, thread) {
  const key = chatSupervisorThreadKey(thread);
  const held = state.forgetting.get(key);
  if (held !== undefined) held.count += 1;
  else state.forgetting.set(key, { thread, count: 1, removing: false });
  chatSupervisorForgetting(state, key);
}

/** The end of the host's frames, whether its stream ended or could not be followed. */
function chatSupervisorClosed(state) {
  if (state.closing) return;
  state.closing = true;
  for (const entry of state.entries.values()) chatSupervisorStopped(entry);
  chatSupervisorSettled(state);
}

/** A host this supervisor cannot follow: said on its log, and its frames ended. */
function chatSupervisorUnfollowed(state, why) {
  if (state.closing) return;
  state.log(`${why}; reading nothing more from it\n`);
  state.code = 1;
  chatSupervisorClosed(state);
}

/** One line of the host's, acted on as the frame it is. */
function chatSupervisorHeard(state, bytes) {
  if (state.closing || state.finished) return undefined;
  let frame;
  try {
    frame = parseChatHostFrame(chatLineText(bytes));
  } catch {
    return chatSupervisorUnfollowed(
      state,
      "the host wrote a line that is not a frame",
    );
  }
  const unspoken = chatSupervisorUnspoken(state.protocol, frame);
  if (unspoken !== undefined)
    return chatSupervisorUnfollowed(
      state,
      `the host speaks protocol ${String(state.protocol)} and wrote ${unspoken}, which that protocol's does not`,
    );
  if (frame.frame === "Start") return chatSupervisorStart(state, frame);
  if (frame.frame === "Forget")
    return chatSupervisorForget(state, frame.thread);
  if (frame.frame === "Stop") {
    const entry = state.entries.get(frame.assignment);
    if (entry !== undefined) chatSupervisorStopped(entry);
    return undefined;
  }
  state.draining = true;
  if (state.protocol >= chatSupervisorThreadProtocol)
    for (const entry of state.entries.values())
      chatSupervisorEntryDrained(entry);
  return chatSupervisorSettled(state);
}

/** What of `frame` a host speaking `protocol` cannot have written, or nothing. */
function chatSupervisorUnspoken(protocol, frame) {
  if (frame.frame === "Forget" && protocol < chatSupervisorThreadProtocol)
    return "a Forget";
  if (frame.frame !== "Start") return undefined;
  if (
    frame.credential !== undefined &&
    protocol < chatSupervisorCredentialProtocol
  )
    return "a Start naming a credential";
  if (frame.thread !== undefined && protocol < chatSupervisorThreadProtocol)
    return "a Start naming a thread";
  return undefined;
}

/**
 * A supervisor speaking the protocol on `input` and `output` over `sessions`,
 * which prepares and runs one (`./chatSession.mjs`'s `prepared`) and removes
 * a thread's workspace (its `forgotten`), at most
 * `sessionsMax` at once, to a host speaking `protocol`, the newest it speaks
 * where none is given: `Ready` first, then each frame the host's call for.
 * It settles with the code the supervisor exits with, once it has nothing
 * left to answer; `closed` is a signal taken as the end of `input`.
 */
export function chatSupervised({
  input,
  output,
  log,
  sessions,
  sessionsMax,
  closed,
  protocol = chatProtocolVersion,
}) {
  const state = {
    protocol,
    output,
    log,
    sessions,
    sessionsMax,
    entries: new Map(),
    threadLast: new Map(),
    forgetting: new Map(),
    draining: false,
    closing: false,
    finished: false,
    code: 0,
    finish: () => undefined,
  };
  const settled = new Promise((resolved) => {
    state.finish = resolved;
  });
  chatSupervisorWritten(state, {
    frame: "Ready",
    protocols: [...chatSupervisorProtocols],
    sessionsMax,
    contractRelease: workerContractRelease,
  });
  const lines = chatLineReader(chatProtocolFrameBytesMax, {
    line: (bytes) => chatSupervisorHeard(state, bytes),
    overlong: () =>
      chatSupervisorUnfollowed(
        state,
        "the host wrote a line longer than a frame",
      ),
  });
  input.on("data", (chunk) => {
    if (!state.closing) lines.push(chunk);
  });
  input.once("end", () => {
    if (!state.closing) lines.end();
    chatSupervisorClosed(state);
  });
  input.once("error", () => chatSupervisorClosed(state));
  closed?.addEventListener("abort", () => chatSupervisorClosed(state), {
    once: true,
  });
  return settled;
}

/**
 * The tree a session reads, checked out by the supervisor as root under a
 * credential the plane mints for the session's own attempt, and one its
 * thread's workspace keeps fetched into as the session's user; it is handed
 * no repository's credential file of its own.
 */
export function chatSupervisorCheckout(environment, mirrors) {
  const named = environment[workerRepositoriesVariable];
  const repositories =
    named === undefined || named.length === 0 ? {} : workerRepositories(named);
  return (task, bearer, workspace, { signal, uid, kept, minted, log }) =>
    chatCheckout(task, bearer, workspace, {
      mint: (repository) =>
        planeCredential({
          task,
          bearer,
          path: sessionCredentialPath,
          repository,
          request: sessionRequest,
          directory: minted,
        }),
      mirrors,
      repositories,
      credentialFiles: {},
      environment,
      user: { uid, gid: uid },
      kept,
      userRun: (args, { group, ...options }) =>
        chatSessionGit({ uid, gid: uid }, [group], args, {
          ...options,
          path: environment["PATH"] ?? "/usr/bin:/bin",
        }),
      signal,
      log,
    });
}

/** The supervisor as its image starts it, on its own standard streams. */
export async function chatSupervisorMain(environment = process.env) {
  const log = (text) => process.stderr.write(text);
  const refused = chatSupervisorProtocolRefusal(environment);
  if (refused !== undefined) {
    log(`${refused}\n`);
    return 1;
  }
  const settings = chatSupervisorSettings(environment);
  const mirrors = await chatMirrorsOpened({
    root: settings.mirrorsRoot,
    groupFirst: settings.groupFirst,
    groupCount: settings.groupCount,
  });
  const sessions = await chatSessionsOpened(settings, {
    system: chatSystem(),
    log,
    task: (envelope) => envelopeTask(envelope),
    checkout: chatSupervisorCheckout(environment, mirrors),
  });
  if (!(await sessions.holding())) await mirrors.pruned(log);
  const closed = new globalThis.AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.once(signal, () => closed.abort());
  const code = await chatSupervised({
    input: process.stdin,
    output: process.stdout,
    log,
    sessions,
    sessionsMax: settings.sessionsMax,
    closed: closed.signal,
    protocol: Number(environment[chatSupervisorProtocolVariable]),
  });
  await new Promise((written) =>
    process.stdout.write("", () => written(undefined)),
  );
  return code;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  chatSupervisorMain().then(
    (code) => process.exit(code),
    (failure) => {
      process.stderr.write(
        `${failure instanceof Error ? failure.message : String(failure)}\n`,
      );
      process.exit(1);
    },
  );
