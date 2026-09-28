/**
 * A real checkout and the bare remote its attempt pushes to, for the suites
 * whose question is git's answer rather than a stub's.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const git = promisify(execFile);
export const author = [
  "-c",
  "user.email=suite@chuggy.invalid",
  "-c",
  "user.name=s",
];

/** A checkout with a commit already in it, and the bare remote its attempt pushes to. */
async function checkoutWithRemote(root) {
  const remote = join(root, "remote.git");
  const directory = join(root, "checkout");
  await git("git", ["init", "--bare", remote]);
  await git("git", ["init", directory]);
  await writeFile(join(directory, "README.md"), "# what the ticket found\n");
  await git("git", ["add", "README.md"], { cwd: directory });
  await git("git", [...author, "commit", "-m", "before"], { cwd: directory });
  return { remote, directory, base: await headOf(directory) };
}

/** `body` run against a fresh checkout and its remote, both removed after. */
export async function inCheckout(body) {
  const root = await mkdtemp(join(tmpdir(), "chuggy-source-"));
  try {
    await body(await checkoutWithRemote(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every ref a remote holds, which is none where nothing reached it. */
export async function remoteRefs(remote) {
  const { stdout } = await git("git", ["for-each-ref"], { cwd: remote });
  return stdout;
}

export async function headOf(directory) {
  const { stdout } = await git("git", ["rev-parse", "HEAD"], {
    cwd: directory,
  });
  return stdout.trim();
}
