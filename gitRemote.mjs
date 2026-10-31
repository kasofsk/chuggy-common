/**
 * Git's reach of a remote, tried again where git says its transport failed,
 * GitHub failed on its own side or the remote found no repository, and never
 * where the remote refused.
 *
 * A REFUSAL IS FINAL. A remote that denied the credential, refused the
 * request or the ref, or declined the push answers the same on every try, so a
 * failure naming one is not tried again, whatever else it names. A failure naming git's own
 * transport is tried again; anything else, a hook's included, is final.
 *
 * BUT GITHUB'S OWN FAILURE IS NOT A REFUSAL. A ref GitHub rejects as a
 * `(failure)` where it says `commit_refs` failed is tried again, like a
 * transport failure.
 *
 * BUT NOT FINDING THE REPOSITORY IS NOT FINAL. GitHub answers a credential
 * minted moments before as if no such repository existed, so a remote's saying
 * it found none is tried again where nothing names a refusal, and a repository
 * truly missing fails only once the tries are spent.
 *
 * WHAT IS READ IS GIT'S STANDARD ERROR. A failure carrying none, a child that
 * could not start among them, is final.
 */

import { setTimeout as delay } from "node:timers/promises";

/** How many times one reach of a remote is tried, the first included. */
export const gitRemoteTriesMax = 4;

/** The pause before the second try, doubled before each try after it. */
export const gitRemotePauseMs = 2_000;

/**
 * Lines naming a remote's refusal: of the credential, of the repository, of
 * the request, or of the ref. What the remote itself says is read only off
 * the lines it wrote, so a repository named for a refusal is not one.
 */
const gitRefusals = [
  /returned error: 40[134]\b/u,
  /\bHTTP 4(?!29)\d\d\b/u,
  /Authentication failed/u,
  /could not read (?:Username|Password)/u,
  /\[remote rejected\]/u,
  /! \[rejected\]/u,
  /^remote:.*(?:protected branch|declined)/iu,
];

/**
 * GitHub failing on its own side: the line saying so, and a ref rejected for
 * that alone. Each is the whole line, so a ref named for either is not one.
 */
const gitRemoteFailureLine = /^remote: fatal error in commit_refs$/u;
const gitRemoteFailureRejected =
  /^! \[remote rejected\] \S+ -> \S+ \(failure\)$/u;

/**
 * GitHub refusing a workflow file to an App, read off the remote's rejection
 * of a ref, so a repository or branch named for it is not one.
 */
const gitWorkflowRefused =
  /^! \[remote rejected\] \S+ -> \S+ \(refusing to allow a GitHub App to create or update workflow /u;

/** What a workflow refusal needs, since GitHub names only the App's half. */
const gitWorkflowRefusedNeeds =
  "In chuggy, the repository's Workflow files setting must be On, and the App must hold Workflows.";

/** Lines naming git's transport failing: the connection, its TLS short of a certificate, or a server error. */
const gitTransportFailures = [
  /returned error: (?:5\d\d|429)\b/u,
  /\bHTTP (?:5\d\d|429)\b/u,
  /RPC failed; curl \d+/u,
  /unable to access '[^']*': (?!.*certificate).*(?:Could not resolve|Failed to connect|timed out|Connection reset|Recv failure|Send failure|Empty reply|SSL|TLS|gnutls)/u,
  /unexpected disconnect/u,
  /early EOF/u,
];

/**
 * Lines saying the remote found no repository: the remote's own words, as
 * GitHub writes them, and git's. Each is the whole line, so a repository named
 * for either is not one.
 */
const gitRepositoryNotFound = [
  /^remote: Repository not found\.$/u,
  /^fatal: repository '[^']+' not found$/u,
];

/** What git wrote to standard error, line by line. */
function gitErrorLines(failure) {
  const stderr = failure?.stderr;
  if (typeof stderr !== "string") return [];
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The first of `lines` any of `patterns` matches. */
function lineMatching(lines, patterns) {
  return lines.find((line) => patterns.some((pattern) => pattern.test(line)));
}

/** GitHub's line saying it failed, where it also rejected a ref for that alone. */
function gitRemoteFailure(lines) {
  return lines.some((line) => gitRemoteFailureRejected.test(line))
    ? lines.find((line) => gitRemoteFailureLine.test(line))
    : undefined;
}

/** The first line naming a refusal, a rejection GitHub's own failure explains not among them. */
function gitRefusal(lines) {
  const remoteFailed = gitRemoteFailure(lines) !== undefined;
  return lineMatching(
    lines.filter(
      (line) => !(remoteFailed && gitRemoteFailureRejected.test(line)),
    ),
    gitRefusals,
  );
}

/**
 * The line that says why git failed: the refusal, GitHub's own failure or the
 * transport failure it names, and otherwise its last `fatal:` or `error:`
 * line. Nothing where it wrote none of them. A workflow refusal is followed by
 * what it needs.
 */
export function gitFailureLine(failure) {
  const lines = gitErrorLines(failure);
  const refusal = gitRefusal(lines);
  if (refusal !== undefined && gitWorkflowRefused.test(refusal))
    return `${refusal} ${gitWorkflowRefusedNeeds}`;
  return (
    refusal ??
    gitRemoteFailure(lines) ??
    lineMatching(lines, gitTransportFailures) ??
    lines.findLast((line) => /^(?:fatal|error):/u.test(line))
  );
}

/** Whether a try that failed so may succeed again. */
export function gitRemoteRetries(failure) {
  const lines = gitErrorLines(failure);
  return (
    gitRefusal(lines) === undefined &&
    (gitRemoteFailure(lines) !== undefined ||
      lineMatching(lines, [
        ...gitTransportFailures,
        ...gitRepositoryNotFound,
      ]) !== undefined)
  );
}

/**
 * What `reach` resolves to, tried until it does, until it fails in a way
 * another try cannot fix, or until it has been tried `gitRemoteTriesMax`
 * times; its last failure is thrown. `again` runs before every try after the
 * first, and `pause` is the wait before it.
 */
export async function gitRemoteTried(reach, seams = {}) {
  const { again = async () => undefined, pause = delay } = seams;
  for (let tried = 1; ; tried += 1) {
    try {
      return await reach();
    } catch (failure) {
      if (tried >= gitRemoteTriesMax || !gitRemoteRetries(failure))
        throw failure;
    }
    await pause(gitRemotePauseMs * 2 ** (tried - 1));
    await again();
  }
}
