import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

import {
  signInStoreDraftName,
  signInStoreFileName,
  signInStoreLockFree,
  signInStoreLockName,
  signInStoreLockSecsMax,
  signInStoreLockWord,
  signInStoreText,
} from "@chuggy/worker-contract/signInStore";

import {
  localTokenStore,
  localTokenStoreLockWaitMsMax,
} from "./localTokenStore.mjs";

const origin = "https://chuggy.test";

async function directoryOf(t) {
  const directory = await mkdtemp(join(tmpdir(), "local-token-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "sign-ins");
}

async function lockSays(directory, word) {
  await mkdir(join(directory, signInStoreLockName), { recursive: true });
  await writeFile(join(directory, signInStoreLockName, word), "");
}

function clockOf(startedMs = Date.now()) {
  const clock = { nowMs: startedMs };
  return Object.assign(clock, {
    ports: {
      nowMs: () => clock.nowMs,
      wait: async (ms) => {
        clock.nowMs += ms;
      },
    },
  });
}

test("a token is kept in the shared store's file for its site, as the setup program writes and reads it, and is the person's alone", async (t) => {
  const directory = await directoryOf(t);
  const file = join(directory, signInStoreFileName(origin));
  const store = localTokenStore(directory, origin);
  assert.equal(await store.read(), undefined);
  await store.locked(() => store.write("renewal-one"));
  assert.equal(await readFile(file, "utf8"), signInStoreText("renewal-one"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  await writeFile(file, signInStoreText("from-setup"));
  assert.equal(await store.read(), "from-setup");
  await writeFile(file, "not one token\n");
  assert.equal(await store.read(), undefined);
  await store.clear();
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await assert.rejects(store.write("not one token"), /cannot hold/);
});

test("a hold says its holder's word in the lock, and leaves it free", async (t) => {
  const directory = await directoryOf(t);
  const clock = clockOf();
  const store = localTokenStore(directory, origin, clock.ports);
  const lock = join(directory, signInStoreLockName);
  assert.deepEqual(await store.locked(() => readdir(lock)), [
    signInStoreLockWord(process.pid, clock.nowMs),
  ]);
  assert.deepEqual(await readdir(lock), [signInStoreLockFree]);
  assert.deepEqual(await store.locked(() => readdir(lock)), [
    signInStoreLockWord(process.pid, clock.nowMs),
  ]);
});

test("the holder removes what a write cut short left, and nothing else", async (t) => {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  const draft = signInStoreDraftName(signInStoreFileName(origin), 4242);
  await writeFile(join(directory, draft), "half");
  await writeFile(join(directory, "kept"), "");
  await localTokenStore(directory, origin).locked(async () => {});
  assert.deepEqual((await readdir(directory)).sort(), [
    "kept",
    signInStoreLockName,
  ]);
});

test("a second hold waits for the first to end", async (t) => {
  const directory = await directoryOf(t);
  const order = [];
  let release;
  let held;
  const holding = new Promise((resolve) => {
    held = resolve;
  });
  let waited;
  const waiting = new Promise((resolve) => {
    waited = resolve;
  });
  const first = localTokenStore(directory, origin).locked(
    () =>
      new Promise((resolve) => {
        order.push("first held");
        release = resolve;
        held();
      }),
  );
  await holding;
  const second = localTokenStore(directory, origin, {
    wait: async () => {
      waited();
      await new Promise((resolve) => setImmediate(resolve));
    },
  }).locked(async () => {
    order.push("second held");
  });
  await waiting;
  assert.deepEqual(order, ["first held"]);
  release();
  await first;
  await second;
  assert.deepEqual(order, ["first held", "second held"]);
});

test("a lock a live holder holds is waited on and raises past the wait, its word left as it was", async (t) => {
  const directory = await directoryOf(t);
  const clock = clockOf();
  const word = signInStoreLockWord(4242, clock.nowMs);
  await lockSays(directory, word);
  const startedMs = clock.nowMs;
  let ran = false;
  await assert.rejects(
    localTokenStore(directory, origin, {
      ...clock.ports,
      holderAlive: () => true,
    }).locked(async () => {
      ran = true;
    }),
    /held the sign-in lock/,
  );
  assert.equal(ran, false);
  assert.ok(clock.nowMs - startedMs >= localTokenStoreLockWaitMsMax);
  assert.deepEqual(await readdir(join(directory, signInStoreLockName)), [word]);
});

test("a lock is nobody's where its holder is gone, it is older than any hold, or it says no word, and then it is taken", async (t) => {
  const startedMs = Date.now();
  const cases = [
    [signInStoreLockWord(4242, startedMs), () => false],
    [
      signInStoreLockWord(
        process.pid,
        startedMs - signInStoreLockSecsMax * 1_000 - 1,
      ),
      () => true,
    ],
    ["left-by-a-file-manager", () => true],
  ];
  for (const [word, holderAlive] of cases) {
    const directory = await directoryOf(t);
    await lockSays(directory, word);
    const clock = clockOf(startedMs);
    assert.equal(
      await localTokenStore(directory, origin, {
        ...clock.ports,
        holderAlive,
      }).locked(async () => "taken"),
      "taken",
      word,
    );
  }
});

test("holders contending for a lock its holder left never both hold it", async (t) => {
  const directory = await directoryOf(t);
  await lockSays(directory, signInStoreLockWord(4242, Date.now()));
  let contended;
  const contending = new Promise((resolve) => {
    contended = resolve;
  });
  let holding = 0;
  let overlapped = false;
  let holds = 0;
  await Promise.all(
    [1, 2].map((n) =>
      localTokenStore(directory, origin, {
        pid: process.pid + n,
        holderAlive: (pid) => pid !== 4242,
        wait: async () => {
          contended();
          await new Promise((resolve) => setImmediate(resolve));
        },
      }).locked(async () => {
        holding += 1;
        holds += 1;
        overlapped ||= holding > 1;
        if (holds === 1) await contending;
        holding -= 1;
      }),
    ),
  );
  assert.equal(holds, 2);
  assert.equal(overlapped, false);
});

test("a token an older copy kept is moved into the store by the first hold, once, and the older file removed", async (t) => {
  const directory = await directoryOf(t);
  const formerDirectory = await directoryOf(t);
  await mkdir(formerDirectory, { recursive: true });
  const former = join(formerDirectory, signInStoreFileName(origin));
  await writeFile(former, "renewal-kept\n");
  const store = localTokenStore(directory, origin, { former });
  assert.equal(await store.locked(() => store.read()), "renewal-kept");
  await assert.rejects(readFile(former), { code: "ENOENT" });
  await store.locked(() => store.write("renewal-next"));
  assert.equal(await store.locked(() => store.read()), "renewal-next");
});

test("where the store already holds a sign-in, an older copy's token is removed and the store's kept", async (t) => {
  const directory = await directoryOf(t);
  const formerDirectory = await directoryOf(t);
  await mkdir(formerDirectory, { recursive: true });
  const former = join(formerDirectory, signInStoreFileName(origin));
  await localTokenStore(directory, origin).locked(async () => {});
  await writeFile(
    join(directory, signInStoreFileName(origin)),
    signInStoreText("renewal-from-setup"),
  );
  await writeFile(former, "renewal-older\n");
  const store = localTokenStore(directory, origin, { former });
  assert.equal(await store.locked(() => store.read()), "renewal-from-setup");
  await assert.rejects(readFile(former), { code: "ENOENT" });
});

test("where an older copy kept its token at the store's own file, it is read where it is", async (t) => {
  const directory = await directoryOf(t);
  await mkdir(directory, { recursive: true });
  const file = join(directory, signInStoreFileName(origin));
  await writeFile(file, "renewal-kept\n");
  const store = localTokenStore(directory, origin, {
    former: join(directory, ".", signInStoreFileName(origin)),
  });
  assert.equal(await store.locked(() => store.read()), "renewal-kept");
  assert.equal(await readFile(file, "utf8"), "renewal-kept\n");
});

/** A site and issuer that end the sign-in when a renewal token is spent twice, holding the first grant until `held` resolves. */
async function issuerOf(t, held) {
  const spent = new Set();
  const replayed = [];
  let issued = 0;
  const server = createServer((request, response) => {
    const base = `http://127.0.0.1:${String(server.address().port)}`;
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/config.json")
      return json(200, { issuer: base, audience: `${base}/api` });
    if (request.url === "/.well-known/openid-configuration")
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
      });
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const token = new URLSearchParams(body).get("refresh_token");
      if (spent.has(token)) {
        replayed.push(token);
        return json(400, { error: "invalid_grant" });
      }
      spent.add(token);
      if (issued === 0) await held;
      issued += 1;
      json(200, {
        access_token: `access-${String(issued)}`,
        refresh_token: `renewal-${String(issued)}`,
        expires_in: 3_600,
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    site: `http://127.0.0.1:${String(server.address().port)}`,
    spent,
    replayed,
  };
}

function renewalOf(directory, site, ready) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./localTokenStore.fixture.mjs", import.meta.url)),
      directory,
      site,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.startsWith("ready\n")) ready();
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(out.split("\n")[1])
        : reject(new Error(`a renewal exited ${String(code)}: ${out}`)),
    );
  });
}

test("processes renewing one sign-in at once spend each renewal token once", async (t) => {
  const directory = await directoryOf(t);
  const processes = 4;
  let readyCount = 0;
  let allReady;
  const held = new Promise((resolve) => {
    allReady = resolve;
  });
  const { site, spent, replayed } = await issuerOf(t, held);
  await localTokenStore(directory, new URL(site).origin).locked(async () => {});
  await writeFile(
    join(directory, signInStoreFileName(new URL(site).origin)),
    signInStoreText("renewal-0"),
  );
  const tokens = await Promise.all(
    Array.from({ length: processes }, () =>
      renewalOf(directory, site, () => {
        readyCount += 1;
        if (readyCount === processes) allReady();
      }),
    ),
  );
  assert.deepEqual(replayed, []);
  assert.equal(spent.size, processes);
  assert.equal(new Set(tokens).size, processes);
  assert.equal(
    await readFile(
      join(directory, signInStoreFileName(new URL(site).origin)),
      "utf8",
    ),
    signInStoreText(`renewal-${String(processes)}`),
  );
});
