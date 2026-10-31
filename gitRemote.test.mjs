import assert from "node:assert/strict";
import test from "node:test";

import {
  gitFailureLine,
  gitRemotePauseMs,
  gitRemoteRetries,
  gitRemoteTried,
  gitRemoteTriesMax,
} from "./gitRemote.mjs";

const remote = "https://github.com/acme/widgets.git/";

/** A git child that failed, writing `stderr`, as `execFile` rejects with it. */
function gitFailed(stderr) {
  return Object.assign(new Error(`Command failed: git push\n${stderr}`), {
    code: 128,
    stderr,
  });
}

/** GitHub's own failure, as a push met it: its first line keeps the trailing spaces git prints. */
const commitRefsFailed = `remote: fatal error in commit_refs        
To https://github.com/eannagroup/argus.git
 ! [remote rejected] 8d84c8eb6de6098ddbe8b3e6bbb049f5a02e4ad1 -> chuggy/tickets/283/attempts/2c8dea2a7bd2021edf8f9da4d6d576dbc769593a2708612519e373060a9ac450 (failure)
error: failed to push some refs to 'https://github.com/eannagroup/argus.git'
`;

/** GitHub refusing an App a workflow file, as a push met it. */
const workflowRefused = ` ! [remote rejected] 8d84c8eb6de6098ddbe8b3e6bbb049f5a02e4ad1 -> chuggy/tickets/348/attempts/1 (refusing to allow a GitHub App to create or update workflow \`.github/workflows/ci.yml\` without \`workflows\` permission)
`;

/** What the workflow refusal's line says after GitHub's own words. */
const workflowNeeds =
  "In chuggy, the repository's Workflow files setting must be On, and the App must hold Workflows.";

/** What the remote answers when it refuses, each as git reports it. */
const refused = {
  "a denied credential": `remote: Permission to acme/widgets.git denied to bot.\nfatal: unable to access '${remote}': The requested URL returned error: 403\n`,
  "a denial git ends by hanging up": `error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\n`,
  "a missing repository git names by its status": `remote: Repository not found.\nfatal: unable to access '${remote}': The requested URL returned error: 404\n`,
  "a failed authentication": `fatal: Authentication failed for '${remote}'\n`,
  "a protected branch": `remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo ${remote}\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to '${remote}'\n`,
  "a rejected update": `To ${remote}\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '${remote}'\n`,
  "a declining hook": `remote: rejected by policy\nTo ${remote}\n ! [remote rejected] main -> main (pre-receive hook declined)\n`,
  "a rejection as a failure, with no word from GitHub of its own": `To ${remote}\n ! [remote rejected] main -> main (failure)\nerror: failed to push some refs to '${remote}'\n`,
  "GitHub's own failure alongside a protected branch": `${commitRefsFailed}remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)\n`,
  "a rejection as a failure, a hook quoting GitHub's words": `remote: lint: remote: fatal error in commit_refs\nTo ${remote}\n ! [remote rejected] main -> main (failure)\n`,
  "GitHub's own failure, the ref rejected for another reason": `remote: fatal error in commit_refs\nTo ${remote}\n ! [remote rejected] main -> main (pre-receive hook declined)\n`,
  "a workflow file refused to an App": workflowRefused,
  "a request too large, git ending it by hanging up": `error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\n`,
};

/** What git writes when its transport fails, each as git reports it. */
const transient = {
  "a server error": `fatal: unable to access '${remote}': The requested URL returned error: 502\n`,
  "a server error mid-push": `error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503\nfatal: the remote end hung up unexpectedly\n`,
  "a rate limit": `fatal: unable to access '${remote}': The requested URL returned error: 429\n`,
  "an unresolved host": `fatal: unable to access '${remote}': Could not resolve host: github.com\n`,
  "an unresolved host for a repository named for a refusal": `fatal: unable to access 'https://github.com/acme/declined-orders.git/': Could not resolve host: github.com\n`,
  "an unresolved host for a repository named for a certificate": `fatal: unable to access 'https://github.com/google/certificate-transparency-go.git/': Could not resolve host: github.com\n`,
  "a refused connection": `fatal: unable to access '${remote}': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server\n`,
  "a failed handshake": `fatal: unable to access '${remote}': gnutls_handshake() failed: The TLS connection was non-properly terminated.\n`,
  "a broken transfer": `error: RPC failed; curl 56 GnuTLS recv error (-9): Error decoding the received TLS packet.\nfatal: early EOF\n`,
  "a dropped sideband": `fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output\n`,
  "GitHub's own failure": commitRefsFailed,
};

/** What git writes when the remote found no repository, each as git reports it. */
const notFound = {
  "GitHub's answer": `remote: Repository not found.\nfatal: repository '${remote}' not found\n`,
  "a remote's answer with no words of its own": `fatal: repository '${remote}' not found\n`,
};

/** Failures nothing here names, each final. */
const unnamed = {
  "a pre-push hook": `lint failed: 3 problems\nerror: failed to push some refs to '${remote}'\n`,
  "a pre-push hook, for a repository named for GitHub's words": `lint failed: 3 problems\nerror: failed to push some refs to 'https://github.com/acme/remote: Repository not found.git/'\n`,
  "a pre-push hook, for a repository named for git's words": `lint failed: 3 problems\nerror: failed to push some refs to 'https://github.com/acme/fatal: repository 'widgets' not found/'\n`,
  "a pre-push hook quoting GitHub's words after its own": `lint: remote: Repository not found.\nerror: failed to push some refs to '${remote}'\n`,
  "a pre-push hook quoting GitHub's words before its own": `remote: Repository not found. says lint\nerror: failed to push some refs to '${remote}'\n`,
  "a pre-push hook quoting git's words after its own": `lint: fatal: repository 'widgets' not found\nerror: failed to push some refs to '${remote}'\n`,
  "a pre-push hook quoting git's words before its own": `fatal: repository 'widgets' not found, says lint\nerror: failed to push some refs to '${remote}'\n`,
  "GitHub's failure line alone": `remote: fatal error in commit_refs\nerror: failed to push some refs to '${remote}'\n`,
  "a ref named for GitHub's failure": `To ${remote}\n ! [remote rejected] main -> remote:fatal-error-in-commit_refs (failure)\n`,
  "a remote that hung up": `fatal: the remote end hung up unexpectedly\n`,
  "a certificate the image does not trust": `fatal: unable to access '${remote}': SSL certificate problem: unable to get local issuer certificate\n`,
  "a child with no standard error": undefined,
};

/** `reach` tried as a push is, answering each try's failure in turn, with every pause and every `again` recorded. */
async function triedThrough(failures) {
  const pauses = [];
  let tries = 0;
  let agains = 0;
  const outcome = await gitRemoteTried(
    async () => {
      tries += 1;
      const failure = failures[tries - 1];
      if (failure !== undefined) throw failure;
      return "reached";
    },
    {
      pause: async (ms) => {
        pauses.push(ms);
      },
      again: async () => {
        agains += 1;
      },
    },
  ).catch((failure) => ({ failure }));
  return { outcome, tries, pauses, agains };
}

test("a remote's refusal is tried once and thrown as it came", async () => {
  for (const [name, stderr] of Object.entries(refused)) {
    assert.equal(gitRemoteRetries(gitFailed(stderr)), false, name);
    const failure = gitFailed(stderr);
    const { outcome, tries, pauses } = await triedThrough([failure]);
    assert.deepEqual(outcome, { failure }, name);
    assert.equal(tries, 1, name);
    assert.deepEqual(pauses, [], name);
  }
});

test("a failure git does not name as its transport's is tried once", async () => {
  for (const [name, stderr] of Object.entries(unnamed)) {
    const failure =
      stderr === undefined ? new Error("spawn git ENOENT") : gitFailed(stderr);
    assert.equal(gitRemoteRetries(failure), false, name);
    const { tries } = await triedThrough([failure]);
    assert.equal(tries, 1, name);
  }
});

test("a transport failure is tried again once it pauses, and what clears it is the answer", async () => {
  for (const [name, stderr] of Object.entries(transient)) {
    assert.equal(gitRemoteRetries(gitFailed(stderr)), true, name);
    const { outcome, tries, pauses, agains } = await triedThrough([
      gitFailed(stderr),
    ]);
    assert.equal(outcome, "reached", name);
    assert.equal(tries, 2, name);
    assert.deepEqual(pauses, [gitRemotePauseMs], name);
    assert.equal(agains, 1, name);
  }
});

test("a remote that found no repository is tried again once it pauses, and what clears it is the answer", async () => {
  for (const [name, stderr] of Object.entries(notFound)) {
    assert.equal(gitRemoteRetries(gitFailed(stderr)), true, name);
    const { outcome, tries, pauses } = await triedThrough([gitFailed(stderr)]);
    assert.equal(outcome, "reached", name);
    assert.equal(tries, 2, name);
    assert.deepEqual(pauses, [gitRemotePauseMs], name);
  }
});

test("either line of GitHub's answer, on its own, is the remote finding no repository", () => {
  for (const line of notFound["GitHub's answer"].trim().split("\n"))
    assert.equal(gitRemoteRetries(gitFailed(`${line}\n`)), true, line);
});

test("a repository never found is tried to the bound and thrown as it came, named by git's own line", async () => {
  const failures = Array.from({ length: gitRemoteTriesMax + 1 }, () =>
    gitFailed(notFound["GitHub's answer"]),
  );
  const { outcome, tries } = await triedThrough(failures);

  assert.equal(outcome.failure, failures[gitRemoteTriesMax - 1]);
  assert.equal(tries, gitRemoteTriesMax);
  assert.equal(
    gitFailureLine(outcome.failure),
    `fatal: repository '${remote}' not found`,
  );
});

test("a transport failure that never clears is tried to the bound, each pause doubling", async () => {
  const failures = Array.from({ length: gitRemoteTriesMax + 1 }, () =>
    gitFailed(transient["a server error"]),
  );
  const { outcome, tries, pauses, agains } = await triedThrough(failures);

  assert.deepEqual(outcome, { failure: failures[gitRemoteTriesMax - 1] });
  assert.equal(tries, gitRemoteTriesMax);
  assert.deepEqual(
    pauses,
    Array.from(
      { length: gitRemoteTriesMax - 1 },
      (_, index) => gitRemotePauseMs * 2 ** index,
    ),
  );
  assert.equal(agains, gitRemoteTriesMax - 1);
});

test("a failure that turns from transport to refusal stops at the refusal", async () => {
  const refusal = gitFailed(refused["a denied credential"]);
  const { outcome, tries } = await triedThrough([
    gitFailed(transient["a server error"]),
    refusal,
  ]);

  assert.deepEqual(outcome, { failure: refusal });
  assert.equal(tries, 2);
});

test("the line a failure is named by is the one that decided it, and otherwise git's last", () => {
  assert.equal(
    gitFailureLine(gitFailed(refused["a protected branch"])),
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
  );
  assert.equal(
    gitFailureLine(gitFailed(refused["a denial git ends by hanging up"])),
    "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403",
  );
  assert.equal(
    gitFailureLine(
      gitFailed(refused["a request too large, git ending it by hanging up"]),
    ),
    "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413",
  );
  assert.equal(
    gitFailureLine(gitFailed(transient["a broken transfer"])),
    "error: RPC failed; curl 56 GnuTLS recv error (-9): Error decoding the received TLS packet.",
  );
  assert.equal(
    gitFailureLine(gitFailed(unnamed["a pre-push hook"])),
    `error: failed to push some refs to '${remote}'`,
  );
  assert.equal(
    gitFailureLine(gitFailed(commitRefsFailed)),
    "remote: fatal error in commit_refs",
  );
  assert.equal(
    gitFailureLine(
      gitFailed(refused["GitHub's own failure alongside a protected branch"]),
    ),
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
  );
  assert.equal(gitFailureLine(gitFailed("lint failed\n")), undefined);
  assert.equal(gitFailureLine(new Error("spawn git ENOENT")), undefined);
});

test("a workflow refusal is named by GitHub's line and then what it needs", () => {
  assert.equal(
    gitFailureLine(gitFailed(workflowRefused)),
    `${workflowRefused.trim()} ${workflowNeeds}`,
  );
});

test("a refusal only named for a workflow refusal is not told what one needs", () => {
  const named = "refusing-to-allow-a-GitHub-App-to-create-or-update-workflow";
  for (const stderr of [
    `To https://github.com/acme/${named}.git\n ! [remote rejected] main -> main (protected branch hook declined)\n`,
    `To ${remote}\n ! [remote rejected] main -> ${named} (pre-receive hook declined)\n`,
  ])
    assert.equal(
      gitFailureLine(gitFailed(stderr)).includes(workflowNeeds),
      false,
      stderr,
    );
});
