/**
 * The credentials an attempt's grant names and its launcher did not mount,
 * asked of the worker plane, which serves those its deployment holds as files.
 *
 * ONLY WHAT NO LAUNCHER MOUNTED IS ASKED FOR. A pod launched with a credential
 * map is mounted every name its grant gives, so it never asks; one launched by
 * envelope, any pool's, is mounted only its agent's credential, and asks once
 * for the rest. The plane answers each name asked that the attempt's recorded
 * grant names and its deployment holds for the project, and none other.
 *
 * A REFUSAL OR AN OUTAGE IS THE ATTEMPT'S FAILURE. A job's shells run on
 * without a credential its grant names only where the plane holds none, which
 * is an empty answer; a plane that could not say is no reason to run them
 * without it.
 *
 * THE SECRET IS WRITTEN AND NEVER PASSED. Each is written to a file of its own
 * in the minted directory, which only this pod's user reads, and a job's
 * shells are told the file under the variable the plane names for it. A
 * bundle's files are written to a directory of its own there, and its
 * variables handed each its file's path or its value, either with the paths
 * its placeholders name filled in. Each file is written under a name of its
 * own beside it and then renamed, so no reader sees part of one.
 *
 * THE PLANE'S VERSION CHOOSES THE SHAPE. A plane whose answer names
 * `workerContractCredentialBundles` or later serves bundles and names those it
 * does not serve, each logged; any other serves single secrets and names none.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { workerContractCredentialBundles } from "@chuggy/worker-contract/workerContract";

import {
  heldCredentialFilePlaceholder,
  heldCredentialFilesPlaced,
  workerHeldCredentialsAnswerSchema,
  workerHeldCredentialsSchema,
  workerPlaneRoutes,
} from "@chuggy/worker-contract/workerPlane";

import { workerRequest } from "./transport.mjs";
import { answeredVersion, versionReaches } from "./wire.mjs";

/** The route an attempt asks for its held credentials through. */
export const workerHeldCredentialsPath = workerPlaneRoutes.heldCredentials.path;

/** The file one held credential is written to, or the directory one served as a bundle is, in the minted directory. */
function heldCredentialFile(directory, credential) {
  return join(directory, `held-${credential}`);
}

/** What each file is created with, so nothing outside this pod's user reads it. */
const heldCredentialFileMode = 0o600;

/** What a bundle's directory is created with, so nothing outside this pod's user lists it. */
const heldCredentialDirectoryMode = 0o700;

/** The names `granted` gives that `credentialFiles`, the launcher's, does not hold. */
export function heldCredentialsUnmounted(granted, credentialFiles) {
  return [...new Set(granted)].filter(
    (credential) => !Object.hasOwn(credentialFiles, credential),
  );
}

/**
 * `content` written to `file` with `options`, first under a name beside it that
 * no credential's file or directory takes, then renamed onto it. `seams` are
 * the filesystem's `writeFile` and `rename`.
 */
export async function heldCredentialFileWritten(
  file,
  content,
  options,
  seams = { writeFile, rename },
) {
  const writing = join(dirname(file), `.${basename(file)}.writing`);
  await seams.writeFile(writing, content, options);
  await seams.rename(writing, file);
}

/**
 * The plane's answer, refused where it serves a shape the version `version`
 * does not, a name not asked, or one no file can be named by.
 */
function heldCredentialsRead(body, asked, version) {
  const answer = workerHeldCredentialsAnswerSchema.safeParse(body);
  if (!answer.success)
    throw new Error(
      "the worker plane answered held credentials this pod cannot read",
    );
  const bundles = versionReaches(version, workerContractCredentialBundles);
  for (const served of answer.data.credentials) {
    const { credential } = served;
    if (Object.hasOwn(served, "files") !== bundles)
      throw new Error(
        `the worker plane answered a held credential in a shape its version does not serve: ${credential}`,
      );
    if (!asked.includes(credential))
      throw new Error(
        `the worker plane answered a held credential this attempt did not ask for: ${credential}`,
      );
    if (credential.includes("/"))
      throw new Error(
        `the worker plane answered a held credential no file in the minted directory can be named by: ${credential}`,
      );
  }
  return {
    credentials: answer.data.credentials,
    absent: bundles ? (answer.data.absent ?? []) : [],
  };
}

/**
 * `text` with each placeholder it holds filled with the path `paths` gives its
 * file, in one pass, so no path filled in is read again for a placeholder.
 */
function heldCredentialsBundleFilled(text, paths) {
  let filled = "";
  let rest = 0;
  for (const file of heldCredentialFilesPlaced(text)) {
    const placeholder = heldCredentialFilePlaceholder(file);
    const at = text.indexOf(placeholder, rest);
    filled += text.slice(rest, at) + paths.get(file);
    rest = at + placeholder.length;
  }
  return filled + text.slice(rest);
}

/**
 * One bundle's files written to a directory of its own under `directory`,
 * every Secret content handed to `keep` before any is written, and the
 * variables it sets as `{credential, variable, value}`.
 */
async function heldCredentialsBundleWritten(
  { credential, files, variables },
  { directory, keep, write, makeDirectory },
) {
  const bundleDirectory = heldCredentialFile(directory, credential);
  const paths = new Map(
    files.map(({ file }) => [file, join(bundleDirectory, file)]),
  );
  for (const { content } of files)
    if (content.kind === "Secret") keep(content.secret);
  await makeDirectory(bundleDirectory, {
    recursive: true,
    mode: heldCredentialDirectoryMode,
  });
  for (const { file, content } of files)
    await write(
      paths.get(file),
      content.kind === "Secret"
        ? content.secret
        : heldCredentialsBundleFilled(content.text, paths),
      { mode: heldCredentialFileMode },
    );
  return variables.map((each) => ({
    credential,
    variable: each.variable,
    value:
      each.kind === "Path"
        ? paths.get(each.file)
        : heldCredentialsBundleFilled(each.value, paths),
  }));
}

/**
 * Each credential the plane holds of the names `granted` gives that
 * `credentialFiles` does not, its secrets handed to `keep` and then written
 * under `directory`, and each it names absent handed to `warn` as one line:
 * `{credential, variable, value}` for each variable a job's shells are handed,
 * none where nothing is unmounted, which asks nothing. `request`, `write` and
 * `makeDirectory` are the seams the plane, a file and a bundle's directory are
 * reached through.
 */
export async function heldCredentials({
  task,
  bearer,
  granted,
  credentialFiles,
  directory,
  keep,
  request = workerRequest,
  write = heldCredentialFileWritten,
  makeDirectory = mkdir,
  warn = (text) => process.stderr.write(text),
}) {
  const asked = heldCredentialsUnmounted(granted, credentialFiles);
  if (asked.length === 0) return [];
  const response = await request(task, bearer, workerHeldCredentialsPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      workerHeldCredentialsSchema.parse({ credentials: asked }),
    ),
  });
  const answered = heldCredentialsRead(
    await response.json().catch(() => undefined),
    asked,
    answeredVersion(response),
  );
  for (const { credential, reason } of answered.absent)
    warn(
      `the worker plane served no held credential ${credential}: ${reason}\n`,
    );
  const held = [];
  for (const served of answered.credentials) {
    if (Object.hasOwn(served, "files")) {
      held.push(
        ...(await heldCredentialsBundleWritten(served, {
          directory,
          keep,
          write,
          makeDirectory,
        })),
      );
      continue;
    }
    const { credential, variable, secret } = served;
    keep(secret);
    const file = heldCredentialFile(directory, credential);
    await write(file, secret, { mode: heldCredentialFileMode });
    held.push({ credential, variable, value: file });
  }
  return held;
}
