import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { promisify } from "node:util";

import {
  signInStoreAccessName,
  signInStoreDirectory,
  signInStoreDraftName,
  signInStoreEndedName,
  signInStoreFileName,
  signInStoreLockFree,
  signInStoreLockName,
  signInStoreLockSecsMax,
  signInStoreLockWord,
  signInStorePendingName,
  signInStoreText,
} from "@chuggy/worker-contract/signInStore";

import {
  localTokenStore,
  localTokenStoreLockWaitMsMax,
} from "./localTokenStore.mjs";

const origin = "https://chuggy.test";
const deadPid = 999_999_999;

async function directoryOf(t) {
  const home = await mkdtemp(join(tmpdir(), "local-token-store-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return signInStoreDirectory({ home, configHome: undefined });
}

/** A lock as the contract lays it out, saying `word`. */
async function lockSaying(directory, word) {
  await mkdir(join(directory, signInStoreLockName), { recursive: true });
  await writeFile(join(directory, signInStoreLockName, word), "");
}

function lockRead(directory) {
  return readdir(join(directory, signInStoreLockName));
}

/** Ports whose clock moves only by the waits a hold makes. */
function pacedPorts(holderAlive) {
  const clock = { nowMs: Date.now() };
  return {
    clock,
    ports: {
      holderAlive,
      nowMs: () => clock.nowMs,
      wait: async (ms) => {
        clock.nowMs += ms;
      },
    },
  };
}

test("a token is kept in the site's file in the contract's store, as the contract writes it, the person's alone", async (t) => {
  const directory = await directoryOf(t);
  const store = localTokenStore({ directory, origin });
  assert.equal(await store.read(), undefined);
  await store.locked(() => store.write("renewal-one"));
  await store.locked(() => store.write("renewal-two"));
  const file = join(directory, signInStoreFileName(origin));
  assert.equal(await readFile(file, "utf8"), signInStoreText("renewal-two"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await store.clear();
  assert.equal(await store.read(), undefined);
});

test("a token another program wrote in the store is read, and one it did not write as the contract does is none", async (t) => {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  const file = join(directory, signInStoreFileName(origin));
  await writeFile(file, signInStoreText("renewal-setup"));
  const store = localTokenStore({ directory, origin });
  assert.equal(await store.read(), "renewal-setup");
  await writeFile(file, "two words\n");
  assert.equal(await store.read(), undefined);
});

test("a hold leaves the lock free as the contract says it, and names its holder while held", async (t) => {
  const directory = await directoryOf(t);
  const store = localTokenStore({ directory, origin });
  const held = await store.locked(() => lockRead(directory));
  assert.equal(held.length, 1);
  assert.match(held[0], new RegExp(`^${String(process.pid)}\\.\\d+$`, "u"));
  assert.deepEqual(await lockRead(directory), [signInStoreLockFree]);
  await store.locked(async () => {});
  assert.deepEqual(await lockRead(directory), [signInStoreLockFree]);
});

test("a lock another program holds is waited on, and given up on past the wait without running the renewal", async (t) => {
  const directory = await directoryOf(t);
  const word = signInStoreLockWord(process.pid, Date.now());
  await lockSaying(directory, word);
  const { clock, ports } = pacedPorts(() => true);
  const startedMs = clock.nowMs;
  let ran = false;
  await assert.rejects(
    localTokenStore({ directory, origin }, ports).locked(async () => {
      ran = true;
    }),
    /held the sign-in lock/,
  );
  assert.equal(ran, false);
  assert.ok(clock.nowMs - startedMs >= localTokenStoreLockWaitMsMax);
  assert.deepEqual(await lockRead(directory), [word]);
});

test("a lock whose holder is gone, or older than any hold lasts, is taken from its word", async (t) => {
  const directory = await directoryOf(t);
  await lockSaying(directory, signInStoreLockWord(deadPid, Date.now()));
  const gone = localTokenStore(
    { directory, origin },
    pacedPorts(() => false).ports,
  );
  assert.equal(await gone.locked(async () => "renewed"), "renewed");
  assert.deepEqual(await lockRead(directory), [signInStoreLockFree]);

  await rm(join(directory, signInStoreLockName), { recursive: true });
  const takenAtMs = Date.now();
  await lockSaying(directory, signInStoreLockWord(process.pid, takenAtMs));
  const { clock, ports } = pacedPorts(() => true);
  clock.nowMs = takenAtMs + signInStoreLockSecsMax * 1_000 + 1;
  const old = localTokenStore({ directory, origin }, ports);
  assert.equal(await old.locked(async () => "renewed"), "renewed");
});

test("a hold removes what a write cut short left in the store, whichever program's", async (t) => {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  const draft = signInStoreDraftName(signInStoreFileName(origin), deadPid);
  await writeFile(join(directory, draft), "renewal-half");
  const store = localTokenStore({ directory, origin });
  await store.locked(async () => {});
  assert.deepEqual((await readdir(directory)).toSorted(), [
    signInStoreLockName,
  ]);
});

test("a sign-in an earlier copy kept is moved into the store once, and kept only where the store holds none", async (t) => {
  const directory = await directoryOf(t);
  const formerly = join(
    directory,
    "..",
    "earlier",
    "https%3A%2F%2Fchuggy.test",
  );
  await mkdir(join(formerly, ".."), { recursive: true });
  await writeFile(formerly, "renewal-earlier\n");
  const store = localTokenStore({ directory, origin, formerly });
  assert.equal(await store.locked(() => store.read()), "renewal-earlier");
  await assert.rejects(readFile(formerly), { code: "ENOENT" });
  await store.locked(() => store.write("renewal-next"));
  assert.equal(await store.locked(() => store.read()), "renewal-next");

  await writeFile(formerly, "renewal-stale\n");
  assert.equal(await store.locked(() => store.read()), "renewal-next");
  await assert.rejects(readFile(formerly), { code: "ENOENT" });
});

test("an earlier copy's file that is the store's own file is left where it is", async (t) => {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  const formerly = join(directory, signInStoreFileName(origin));
  await writeFile(formerly, "renewal-earlier\n");
  const store = localTokenStore({ directory, origin, formerly });
  assert.equal(await store.locked(() => store.read()), "renewal-earlier");
  assert.equal(await readFile(formerly, "utf8"), "renewal-earlier\n");
});

test("an access record is kept beside the renewal token, the person's alone, and read only for the renewal token it was written with", async (t) => {
  const directory = await directoryOf(t);
  const store = localTokenStore({ directory, origin });
  assert.equal(await store.accessRead("renewal-one"), undefined);
  const access = { accessToken: "access-one", expiresAtMs: 1_234 };
  await store.locked(() => store.accessWrite(access, "renewal-one"));
  assert.deepEqual(await store.accessRead("renewal-one"), access);
  assert.equal(await store.accessRead("renewal-two"), undefined);
  const file = join(directory, signInStoreAccessName(origin));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, "utf8")).includes("renewal-one"));
  await store.locked(() =>
    store.accessWrite(
      { accessToken: "two words", expiresAtMs: 1 },
      "renewal-one",
    ),
  );
  assert.equal(await store.accessRead("renewal-one"), undefined);
  await store.locked(() => store.accessWrite(access, "renewal-one"));
  await store.accessClear();
  assert.equal(await store.accessRead("renewal-one"), undefined);
});

test("an ended record is kept beside the renewal token, the person's alone, and one not written as the contract does is none", async (t) => {
  const directory = await directoryOf(t);
  const store = localTokenStore({ directory, origin });
  assert.equal(await store.endedRead(), undefined);
  const ended = {
    endedAtMs: 1_234,
    error: "invalid_grant",
    errorDescription: "The refresh token was already used.",
  };
  await store.locked(() => store.endedWrite(ended));
  assert.deepEqual(await store.endedRead(), ended);
  const file = join(directory, signInStoreEndedName(origin));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, "{}\n");
  assert.equal(await store.endedRead(), undefined);
  await store.endedClear();
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("a pending record is kept beside the renewal token, the person's alone, and reads as absent past its expiry or beside a renewal file", async (t) => {
  const directory = await directoryOf(t);
  const store = localTokenStore({ directory, origin });
  assert.equal(await store.pendingRead(0), undefined);
  const pending = {
    deviceCode: "device-one",
    userCode: "USER-1",
    verificationUri: "https://auth.test/device",
    expiresAtMs: 1_000,
    intervalSecs: 5,
  };
  await store.locked(() => store.pendingWrite(pending));
  assert.deepEqual(await store.pendingRead(999), pending);
  assert.equal(await store.pendingRead(1_000), undefined);
  const file = join(directory, signInStorePendingName(origin));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.locked(() => store.write("renewal-one"));
  assert.equal(await store.pendingRead(0), undefined);
  await store.clear();
  assert.deepEqual(await store.pendingRead(0), pending);
  await store.pendingClear();
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

/**
 * A site and issuer over HTTP whose token endpoint refuses a renewal token
 * spent before, issues access tokens lasting `expiresInSecs`, and answers
 * every device code polled `authorization_pending`.
 */
async function issuerOf(t, expiresInSecs) {
  const spent = new Set();
  const outcome = {
    current: "renewal-0",
    granted: 0,
    replayed: [],
    authorized: 0,
    polled: [],
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const base = `http://127.0.0.1:${String(server.address().port)}`;
      const answer = (status, json) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      if (request.url === "/config.json")
        return answer(200, { issuer: base, audience: `${base}/api` });
      if (request.url === "/.well-known/openid-configuration")
        return answer(200, {
          issuer: base,
          authorization_endpoint: `${base}/auth`,
          token_endpoint: `${base}/token`,
          device_authorization_endpoint: `${base}/device`,
        });
      const fields = new URLSearchParams(body);
      if (request.url === "/device") {
        outcome.authorized += 1;
        return answer(200, {
          device_code: `device-${String(outcome.authorized)}`,
          user_code: `USER-${String(outcome.authorized)}`,
          verification_uri: `${base}/verify`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (fields.has("device_code")) {
        outcome.polled.push(fields.get("device_code"));
        return answer(400, { error: "authorization_pending" });
      }
      const token = fields.get("refresh_token");
      if (spent.has(token) || token !== outcome.current) {
        outcome.replayed.push(token);
        return answer(400, { error: "invalid_grant" });
      }
      spent.add(token);
      outcome.granted += 1;
      outcome.current = `renewal-${String(outcome.granted)}`;
      return answer(200, {
        access_token: `access-${String(outcome.granted)}`,
        refresh_token: outcome.current,
        expires_in: expiresInSecs,
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { site: `http://127.0.0.1:${String(server.address().port)}`, outcome };
}

const fixture = fileURLToPath(
  new URL("./localTokenStore.fixture.mjs", import.meta.url),
);

/** One fixture process asking `site` for a token `count` times, its clock at `nowMs` where given. */
function fixtureRun(site, directory, count, nowMs = undefined) {
  return promisify(execFile)(process.execPath, [
    fixture,
    site,
    directory,
    String(count),
    ...(nowMs === undefined ? [] : [String(nowMs)]),
  ]);
}

async function storedOf(t, site) {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, signInStoreFileName(site)),
    signInStoreText("renewal-0"),
  );
  return directory;
}

test("processes renewing one sign-in at once never spend the same token twice", async (t) => {
  const { site, outcome } = await issuerOf(t, 0);
  const directory = await storedOf(t, site);
  const processes = 4;
  const renewals = 5;
  await Promise.all(
    Array.from({ length: processes }, () =>
      fixtureRun(site, directory, renewals),
    ),
  );
  assert.deepEqual(outcome.replayed, []);
  assert.equal(outcome.granted, processes * renewals);
  assert.equal(
    await readFile(join(directory, signInStoreFileName(site)), "utf8"),
    signInStoreText(outcome.current),
  );
});

test("fresh processes one after another, or started together, spend one renewal in all while its access token lasts", async (t) => {
  for (const together of [false, true]) {
    const { site, outcome } = await issuerOf(t, 3_600);
    const directory = await storedOf(t, site);
    const processes = 4;
    if (together)
      await Promise.all(
        Array.from({ length: processes }, () => fixtureRun(site, directory, 1)),
      );
    else
      for (let started = 0; started < processes; started += 1)
        await fixtureRun(site, directory, 1);
    assert.deepEqual(outcome.replayed, []);
    assert.equal(outcome.granted, 1);
    assert.equal(
      await localTokenStore({ directory, origin: site }).read(),
      outcome.current,
    );
  }
});

test("processes not signed in make one device authorization between them and show its code, and one started after they exited polls it", async (t) => {
  const { site, outcome } = await issuerOf(t, 3_600);
  const directory = await directoryOf(t);
  const startedMs = 1_000_000;
  const processes = 4;
  const shown = await Promise.all(
    Array.from({ length: processes }, () =>
      fixtureRun(site, directory, 1, startedMs),
    ),
  );
  assert.equal(outcome.authorized, 1);
  assert.deepEqual(
    new Set(shown.map(({ stdout }) => JSON.parse(stdout).userCode)),
    new Set(["USER-1"]),
  );
  assert.deepEqual(outcome.polled, ["device-1"]);

  const { stdout } = await fixtureRun(site, directory, 1, startedMs + 5_000);
  assert.equal(JSON.parse(stdout).userCode, "USER-1");
  assert.equal(JSON.parse(stdout).deviceUrl, `${site}/verify`);
  assert.deepEqual(outcome.polled, ["device-1", "device-1"]);
  assert.equal(outcome.authorized, 1);
});
