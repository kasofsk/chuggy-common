import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setImmediate, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";

import {
  signInStorePendingIntervalSecsMax,
  signInStorePendingRead,
  signInStorePendingText,
} from "@chuggy/worker-contract/signInStore";

import {
  LocalSignInNeeded,
  localSignIn,
  localSignInAnswerBytesMax,
  localSignInClientId,
  localSignInRefreshMarginMs,
  localSignInRefusedTokensMax,
  localSignInTokenPartCharsMin,
} from "./localSignIn.mjs";

const site = "https://chuggy.test";
const issuer = "https://auth.test";
const audience = "https://chuggy.test/api";

/** A store as `localTokenStore` keeps one, its pending record as the contract writes and reads it; `gate`, where set, is waited on before each hold runs. */
function storeOf(renewal) {
  const store = {
    renewal,
    access: undefined,
    ended: undefined,
    pending: undefined,
    locks: 0,
    gate: undefined,
  };
  return Object.assign(store, {
    read: async () => store.renewal,
    write: async (token) => {
      store.renewal = token;
    },
    clear: async () => {
      store.renewal = undefined;
    },
    accessRead: async (named) =>
      store.access !== undefined && store.access.renewal === named
        ? {
            accessToken: store.access.accessToken,
            expiresAtMs: store.access.expiresAtMs,
          }
        : undefined,
    accessWrite: async ({ accessToken, expiresAtMs }, named) => {
      store.access = { accessToken, expiresAtMs, renewal: named };
    },
    accessClear: async () => {
      store.access = undefined;
    },
    endedRead: async () => store.ended,
    endedWrite: async (ended) => {
      store.ended = ended;
    },
    endedClear: async () => {
      store.ended = undefined;
    },
    pendingRead: async (nowMs) =>
      store.pending === undefined
        ? undefined
        : signInStorePendingRead(store.pending, {
            renewalHeld: store.renewal !== undefined,
            nowMs,
          }),
    pendingWrite: async (pending) => {
      store.pending = signInStorePendingText(pending);
    },
    pendingClear: async () => {
      store.pending = undefined;
    },
    locked: async (renewalRun) => {
      store.locks += 1;
      await store.gate?.();
      return renewalRun();
    },
  });
}

/**
 * A site and issuer answering as the real ones do; `grant` answers each token
 * request, and `device`, where given, each device authorization, the issuer's
 * discovery naming its endpoint only then.
 */
function serversOf(grant, device = undefined) {
  const grants = [];
  const devices = [];
  const fetch = async (url, init) => {
    const asked = String(url);
    if (asked === `${site}/config.json`)
      return globalThis.Response.json({
        issuer,
        audience,
        clientId: "chuggy-ui",
      });
    if (asked === `${issuer}/.well-known/openid-configuration`)
      return globalThis.Response.json({
        issuer: `${issuer}/`,
        authorization_endpoint: `${issuer}/oauth2/auth`,
        token_endpoint: `${issuer}/oauth2/token`,
        ...(device === undefined
          ? {}
          : { device_authorization_endpoint: `${issuer}/oauth2/device/auth` }),
      });
    const answering = {
      [`${issuer}/oauth2/token`]: [grants, grant],
      [`${issuer}/oauth2/device/auth`]: [devices, device],
    }[asked];
    if (answering?.[1] !== undefined && init?.method === "POST") {
      const [asks, answer] = answering;
      const fields = Object.fromEntries(new URLSearchParams(init.body));
      asks.push(fields);
      const {
        status = 200,
        body,
        response,
      } = await answer(fields, asks.length);
      return response ?? globalThis.Response.json(body ?? {}, { status });
    }
    return new globalThis.Response("", { status: 404 });
  };
  return { fetch, grants, devices };
}

function issued(n, expiresInSecs = 3_600) {
  return {
    body: {
      access_token: `access-${String(n)}`,
      refresh_token: `renewal-${String(n)}`,
      expires_in: expiresInSecs,
    },
  };
}

async function signInNeeded(signIn) {
  try {
    await signIn.token();
  } catch (failure) {
    assert.ok(failure instanceof LocalSignInNeeded, String(failure));
    return failure;
  }
  assert.fail("a call with nothing to renew was not asked to sign in");
}

test("with nothing to renew, a call is answered with a sign-in page, and the page's answer signs in", async (t) => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const store = storeOf(undefined);
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());

  const needed = await signInNeeded(signIn);
  const authorize = new URL(needed.url);
  const query = authorize.searchParams;
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/oauth2/auth`);
  assert.equal(query.get("client_id"), localSignInClientId);
  assert.equal(query.get("audience"), audience);
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.equal(query.get("scope"), "openid offline_access");
  const redirect = new URL(query.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/callback");
  assert.equal((await signInNeeded(signIn)).url, needed.url);

  const stranger = await globalThis.fetch(`${redirect}?code=c&state=guessed`);
  assert.equal(stranger.status, 404);
  assert.equal(grants.length, 0);

  const answered = await globalThis.fetch(
    `${redirect}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /Signed in/);
  const [exchange] = grants;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.code, "the-code");
  assert.equal(exchange.redirect_uri, redirect.toString());
  assert.equal(exchange.client_id, localSignInClientId);
  assert.equal(
    createHash("sha256").update(exchange.code_verifier).digest("base64url"),
    query.get("code_challenge"),
  );
  assert.equal(store.renewal, "renewal-1");
  assert.equal(await signIn.token(), "access-1");
});

test("a declined sign-in is said on the page, which then closes, and the next call opens another", async (t) => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const needed = await signInNeeded(signIn);
  const query = new URL(needed.url).searchParams;
  const declined = await globalThis.fetch(
    `${query.get("redirect_uri")}?error=access_denied&state=${query.get("state")}`,
  );
  assert.equal(declined.status, 200);
  assert.match(await declined.text(), /declined/);
  assert.equal(grants.length, 0);
  await assert.rejects(globalThis.fetch(query.get("redirect_uri")));
  assert.notEqual((await signInNeeded(signIn)).url, needed.url);
});

test("a page whose browser left before its answer ends, and the next call opens another", async (t) => {
  let granting;
  const granted = new Promise((resolve) => {
    granting = resolve;
  });
  let release;
  const { fetch } = serversOf(() => {
    granting();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const needed = await signInNeeded(signIn);
  const query = new URL(needed.url).searchParams;
  const leaving = new globalThis.AbortController();
  const answering = globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
    { signal: leaving.signal },
  );
  await granted;
  leaving.abort();
  await assert.rejects(answering);
  await new Promise((resolve) => setTimeout(resolve, 100));
  release({ status: 400, body: { error: "invalid_grant" } });
  for (let looks = 0; looks < 100; looks += 1) {
    if ((await signInNeeded(signIn)).url !== needed.url) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the page stayed open after its browser left");
});

test("a code the issuer refuses is said on the page by what failed, and nothing is stored", async (t) => {
  const { fetch } = serversOf(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  const store = storeOf(undefined);
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());
  const query = new URL((await signInNeeded(signIn)).url).searchParams;
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 502);
  const page = await answered.text();
  assert.match(page, /refused the code/);
  assert.doesNotMatch(page, /the-code|invalid_grant/);
  assert.equal(store.renewal, undefined);
});

test("an authorization endpoint's own query is kept beside the sign-in's", async (t) => {
  const { fetch: served } = serversOf((_fields, n) => issued(n));
  const fetch = async (url, init) =>
    String(url) === `${issuer}/.well-known/openid-configuration`
      ? globalThis.Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/auth?tenant=one`,
          token_endpoint: `${issuer}/oauth2/token`,
        })
      : served(url, init);
  const signIn = localSignIn(site, storeOf(undefined), { fetch });
  t.after(() => signIn.close());
  const query = new URL((await signInNeeded(signIn)).url).searchParams;
  assert.equal(query.get("tenant"), "one");
  assert.equal(query.get("client_id"), localSignInClientId);
});

test("a held token is renewed ahead of its expiry, and the renewal replaces the stored one", async () => {
  let nowMs = 1_000_000;
  const { fetch, grants } = serversOf((_fields, n) => issued(n, 120));
  const store = storeOf("renewal-0");
  const signIn = localSignIn(site, store, { fetch, nowMs: () => nowMs });

  assert.equal(await signIn.token(), "access-1");
  assert.equal(await signIn.token(), "access-1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].refresh_token, "renewal-0");
  nowMs += 120_000 - localSignInRefreshMarginMs;
  assert.equal(await signIn.token(), "access-2");
  assert.equal(grants[1].refresh_token, "renewal-1");
  assert.equal(store.renewal, "renewal-2");
  assert.equal(store.locks, 2);
});

test("calls made together renew once", async () => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf("renewal-0"), { fetch });
  const tokens = await Promise.all([signIn.token(), signIn.token()]);
  assert.deepEqual(tokens, ["access-1", "access-1"]);
  assert.equal(grants.length, 1);
});

test("a token the API refused is dropped and the next call renews", async () => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const signIn = localSignIn(site, storeOf("renewal-0"), { fetch });
  const refused = await signIn.token();
  signIn.invalidate("some-other-token");
  assert.equal(await signIn.token(), refused);
  signIn.invalidate(refused);
  assert.equal(await signIn.token(), "access-2");
  assert.equal(grants.length, 2);
});

test("a renewal the issuer refuses is forgotten, and the call is asked to sign in", async (t) => {
  const { fetch } = serversOf(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  const store = storeOf("renewal-spent");
  const signIn = localSignIn(site, store, { fetch, log: () => {} });
  t.after(() => signIn.close());
  await signInNeeded(signIn);
  assert.equal(store.renewal, undefined);
});

test("an issuer that fails or limits renewals keeps the stored renewal and says so by status", async () => {
  for (const status of [503, 429, 403]) {
    const { fetch } = serversOf(() => ({ status }));
    const store = storeOf("renewal-0");
    const signIn = localSignIn(site, store, { fetch });
    await assert.rejects(
      signIn.token(),
      new RegExp(`answered ${String(status)} for a token`, "u"),
    );
    assert.equal(store.renewal, "renewal-0");
    assert.equal(store.ended, undefined);
  }
});

test("a renewal cut off by its bound or a network fault keeps the stored renewal and ends nothing", async () => {
  for (const fault of [
    new globalThis.DOMException("timed out", "TimeoutError"),
    new TypeError("fetch failed"),
  ]) {
    const { fetch } = serversOf(() => {
      throw fault;
    });
    const store = storeOf("renewal-0");
    const lines = [];
    const signIn = localSignIn(site, store, {
      fetch,
      log: (line) => lines.push(line),
    });
    await assert.rejects(signIn.token(), fault);
    assert.equal(store.renewal, "renewal-0");
    assert.equal(store.ended, undefined);
    assert.deepEqual(lines, []);
  }
});

const localSignInNeededText =
  /^not signed in to https:\/\/chuggy\.test: this call needs the person signed in, so give them this address, in full, in your next message, whatever else you are doing: https:\/\/auth\.test\/oauth2\/auth\?\S+ Call the tool again once they say they have signed in\. The page closes once it is answered or after a while unanswered, and a later call opens another\./u;

/** Hydra v26.2.0's answer to a renewal token used before, its hint folded into the description. */
const hydraReplayed = {
  status: 400,
  body: {
    error: "invalid_grant",
    error_description:
      "The provided authorization grant (e.g., authorization code, resource owner credentials) or refresh token is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client. The refresh token was already used.",
  },
};

const spentToken = `ory_rt_${"A".repeat(43)}.${"B".repeat(43)}`;

test("a refused renewal says when and why once on stderr, keeps that in place of both tokens, and every later call is told it", async (t) => {
  const nowMs = Date.UTC(2026, 10, 18, 9, 30);
  const at = new Date(nowMs).toISOString();
  const { fetch, grants } = serversOf(() => hydraReplayed);
  const store = storeOf(spentToken);
  store.access = {
    accessToken: "access-0",
    expiresAtMs: 0,
    renewal: spentToken,
  };
  const lines = [];
  const ports = { fetch, nowMs: () => nowMs, log: (line) => lines.push(line) };
  const signIn = localSignIn(site, store, ports);
  t.after(() => signIn.close());

  const why = `The issuer ended this sign-in at ${at} and said why: "invalid_grant: ${hydraReplayed.body.error_description}".`;
  const needed = await signInNeeded(signIn);
  assert.match(needed.message, localSignInNeededText);
  assert.ok(needed.message.endsWith(` ${why}`), needed.message);
  assert.deepEqual(lines, [
    `the issuer ended the sign-in to ${site} at ${at} and said why: "invalid_grant: ${hydraReplayed.body.error_description}"`,
  ]);
  assert.deepEqual(store.ended, {
    endedAtMs: nowMs,
    error: "invalid_grant",
    errorDescription: hydraReplayed.body.error_description,
  });
  assert.equal(store.renewal, undefined);
  assert.equal(store.access, undefined);

  const later = localSignIn(site, store, ports);
  t.after(() => later.close());
  const told = await signInNeeded(later);
  assert.match(told.message, localSignInNeededText);
  assert.ok(told.message.endsWith(` ${why}`), told.message);
  assert.equal(lines.length, 1);
  assert.equal(grants.length, 1);
  for (const said of [
    ...lines,
    JSON.stringify(store.ended),
    needed.message,
    told.message,
  ])
    assert.ok(!said.includes(spentToken.split(".")[1]), said);
});

test("a 400 or 401 with no body, a body that is not JSON, or one past the bound is a refusal with no reason", async (t) => {
  const answers = [
    new globalThis.Response(null, { status: 400 }),
    new globalThis.Response("<html>Bad Request</html>", { status: 401 }),
    globalThis.Response.json(
      { error: "x".repeat(localSignInAnswerBytesMax) },
      { status: 400 },
    ),
  ];
  for (const response of answers) {
    const { fetch } = serversOf(() => ({ response }));
    const store = storeOf("renewal-0");
    const lines = [];
    const signIn = localSignIn(site, store, {
      fetch,
      nowMs: () => 0,
      log: (line) => lines.push(line),
    });
    t.after(() => signIn.close());
    const needed = await signInNeeded(signIn);
    assert.ok(
      needed.message.endsWith(
        " The issuer ended this sign-in at 1970-01-01T00:00:00.000Z and gave no reason.",
      ),
      needed.message,
    );
    assert.deepEqual(store.ended, { endedAtMs: 0, error: "" });
    assert.equal(store.renewal, undefined);
    assert.equal(lines.length, 1);
  }
});

test("the issuer's words holding the token or a long part of it are dropped, and a short part is not", async (t) => {
  const long = "C".repeat(localSignInTokenPartCharsMin);
  const short = "spent";
  assert.ok(short.length < localSignInTokenPartCharsMin);
  const presented = `${long}.${short}`;
  const cases = [
    {
      refused: { error: `bad_${long}`, error_description: "no." },
      ended: { error: "", errorDescription: "no." },
    },
    {
      refused: {
        error: "invalid_grant",
        error_description: `token "${presented}" spent`,
      },
      ended: { error: "invalid_grant" },
    },
    {
      refused: { error: "invalid_grant", error_description: `has ${long}` },
      ended: { error: "invalid_grant" },
    },
    {
      refused: {
        error: "invalid_grant",
        error_description: "The token was spent.",
      },
      ended: {
        error: "invalid_grant",
        errorDescription: "The token was spent.",
      },
    },
  ];
  for (const { refused, ended } of cases) {
    const { fetch } = serversOf(() => ({ status: 400, body: refused }));
    const store = storeOf(presented);
    const lines = [];
    const signIn = localSignIn(site, store, {
      fetch,
      nowMs: () => 0,
      log: (line) => lines.push(line),
    });
    t.after(() => signIn.close());
    const needed = await signInNeeded(signIn);
    assert.deepEqual(store.ended, { endedAtMs: 0, ...ended });
    for (const said of [lines[0], needed.message])
      assert.ok(!said.includes(long), said);
  }
});

test("a renewal that finds a newer access token stored under the lock spends nothing", async () => {
  let nowMs = 1_000_000;
  const { fetch, grants } = serversOf((_fields, n) => issued(n, 120));
  const store = storeOf("renewal-0");
  const signIn = localSignIn(site, store, { fetch, nowMs: () => nowMs });
  assert.equal(await signIn.token(), "access-1");
  store.renewal = "renewal-other";
  store.access = {
    accessToken: "access-other",
    expiresAtMs: nowMs + 3_600_000,
    renewal: "renewal-other",
  };
  nowMs += 120_000 - localSignInRefreshMarginMs;
  assert.equal(await signIn.token(), "access-other");
  assert.equal(grants.length, 1);
});

test("a renewed token is answered once the store holds its renewal token and the access record naming it", async () => {
  const { fetch } = serversOf((_fields, n) => issued(n));
  const store = storeOf("renewal-0");
  store.ended = { endedAtMs: 0, error: "invalid_grant" };
  const signIn = localSignIn(site, store, { fetch, nowMs: () => 0 });
  assert.equal(await signIn.token(), "access-1");
  assert.equal(store.renewal, "renewal-1");
  assert.deepEqual(store.access, {
    accessToken: "access-1",
    expiresAtMs: 3_600_000,
    renewal: "renewal-1",
  });
  assert.equal(store.ended, undefined);
});

test("an access record naming another renewal token, or none, is not used", async () => {
  for (const named of ["renewal-other", undefined]) {
    const { fetch, grants } = serversOf((_fields, n) => issued(n));
    const store = storeOf("renewal-0");
    store.access = {
      accessToken: "access-stale",
      expiresAtMs: Date.now() + 3_600_000,
      renewal: named,
    };
    const signIn = localSignIn(site, store, { fetch });
    assert.equal(await signIn.token(), "access-1");
    assert.equal(grants.length, 1);
  }
});

test("a token the API refused is answered again neither from memory nor from the store, and the memory of refusals is bounded", async () => {
  const { fetch, grants } = serversOf((_fields, n) => issued(n));
  const store = storeOf("renewal-0");
  store.access = {
    accessToken: "access-stored",
    expiresAtMs: Date.now() + 3_600_000,
    renewal: "renewal-0",
  };
  const signIn = localSignIn(site, store, { fetch });
  assert.equal(await signIn.token(), "access-stored");
  assert.equal(grants.length, 0);
  signIn.invalidate("access-stored");
  assert.equal(await signIn.token(), "access-1");
  assert.equal(grants.length, 1);
  signIn.invalidate("access-1");
  assert.equal(await signIn.token(), "access-2");

  signIn.invalidate("access-2");
  for (let other = 0; other < localSignInRefusedTokensMax; other += 1)
    signIn.invalidate(`access-other-${String(other)}`);
  assert.equal(await signIn.token(), "access-2");
  assert.equal(grants.length, 2);
});

test("a sign-in through the page removes the ended record and stores the access record", async (t) => {
  const { fetch } = serversOf((_fields, n) => issued(n));
  const store = storeOf(undefined);
  store.ended = { endedAtMs: 0, error: "invalid_grant" };
  const signIn = localSignIn(site, store, { fetch, nowMs: () => 0 });
  t.after(() => signIn.close());
  const needed = await signInNeeded(signIn);
  assert.match(
    needed.message,
    / The issuer ended this sign-in at 1970-01-01T00:00:00\.000Z and said why: "invalid_grant"\.$/u,
  );
  const query = new URL(needed.url).searchParams;
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);
  assert.equal(store.ended, undefined);
  assert.equal(store.renewal, "renewal-1");
  assert.deepEqual(store.access, {
    accessToken: "access-1",
    expiresAtMs: 3_600_000,
    renewal: "renewal-1",
  });
});

test("closing waits for a renewal already sent to be kept, and starts none still waiting for the lock", async () => {
  let asked;
  const asking = new Promise((resolve) => {
    asked = resolve;
  });
  let answer;
  const { fetch } = serversOf(() => {
    asked();
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const store = storeOf("renewal-0");
  const sent = localSignIn(site, store, { fetch, nowMs: () => 0 });
  const token = sent.token();
  await asking;
  let closed = false;
  const closing = sent.close().then(() => {
    closed = true;
    return { renewal: store.renewal, access: store.access };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  answer(issued(1));
  assert.deepEqual(await closing, {
    renewal: "renewal-1",
    access: {
      accessToken: "access-1",
      expiresAtMs: 3_600_000,
      renewal: "renewal-1",
    },
  });
  assert.equal(await token, "access-1");

  const waiting = serversOf((_fields, n) => issued(n));
  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  let opened;
  store.gate = () => {
    entered();
    return new Promise((resolve) => {
      opened = resolve;
    });
  };
  store.access = undefined;
  const unsent = localSignIn(site, store, { fetch: waiting.fetch });
  const refused = unsent.token();
  await entering;
  await unsent.close();
  opened();
  await assert.rejects(refused, /ending, so it starts no renewal/);
  assert.equal(waiting.grants.length, 0);
  assert.equal(store.renewal, "renewal-1");
});

const deviceCode = `ory_dc_${"D".repeat(43)}.${"E".repeat(43)}`;

/** The issuer's answer to device authorization `n`, `changed` replacing its fields. */
function authorized(n, changed = {}) {
  return {
    body: {
      device_code: `${deviceCode}${String(n)}`,
      user_code: `USER-${String(n)}`,
      verification_uri: `${issuer}/device`,
      verification_uri_complete: `${issuer}/device?user_code=USER-${String(n)}`,
      expires_in: 600,
      interval: 5,
      ...changed,
    },
  };
}

const devicePending = { status: 400, body: { error: "authorization_pending" } };

/** A device sign-in's ports over `store` at a clock the test moves, every line said kept. */
function deviceOf(t, store, grant, device = (_fields, n) => authorized(n)) {
  const clock = { nowMs: 1_000_000 };
  const servers = serversOf(grant, device);
  const lines = [];
  const ports = {
    fetch: servers.fetch,
    nowMs: () => clock.nowMs,
    log: (line) => lines.push(line),
  };
  const opened = () => {
    const signIn = localSignIn(site, store, ports);
    t.after(() => signIn.close());
    return signIn;
  };
  return { ...servers, clock, lines, opened, signIn: opened() };
}

/** That nothing in `said` holds the device code or a long part of it. */
function deviceCodeUnsaid(...said) {
  for (const text of said)
    for (const part of [deviceCode, "D".repeat(43), "E".repeat(43)])
      assert.ok(!text.includes(part), text);
}

test("with nothing to renew, a call is answered with the page, the device link and its code, the authorization written before the answer", async (t) => {
  for (const complete of [true, false]) {
    const store = storeOf(undefined);
    const device = deviceOf(
      t,
      store,
      () => devicePending,
      (_fields, n) =>
        authorized(n, complete ? {} : { verification_uri_complete: undefined }),
    );
    const needed = await signInNeeded(device.signIn);
    const link = complete
      ? `${issuer}/device?user_code=USER-1`
      : `${issuer}/device`;
    assert.match(needed.message, localSignInNeededText);
    assert.ok(
      needed.message.endsWith(
        ` give them as well, in full, this link, which opens on any device, and its code, for them to sign in at whichever they can: ${link} with the code USER-1`,
      ),
      needed.message,
    );
    assert.equal(needed.deviceUrl, link);
    assert.equal(needed.userCode, "USER-1");
    assert.deepEqual(device.devices, [
      {
        client_id: localSignInClientId,
        scope: "openid offline_access",
        audience,
      },
    ]);
    assert.equal(device.grants.length, 0);
    const pending = await store.pendingRead(device.clock.nowMs);
    assert.equal(pending.deviceCode, `${deviceCode}1`);
    assert.equal(pending.expiresAtMs, device.clock.nowMs + 600_000);
    assert.equal(pending.intervalSecs, 5);
    deviceCodeUnsaid(needed.message, ...device.lines);
  }
});

test("calls inside the interval poll once between them, and slow_down widens the interval for every process after", async (t) => {
  const store = storeOf(undefined);
  const device = deviceOf(t, store, () => ({
    status: 400,
    body: { error: "slow_down" },
  }));
  const codes = [];
  const called = async (signIn = device.signIn) =>
    codes.push((await signInNeeded(signIn)).userCode);
  await called();
  await called();
  await called();
  assert.equal(device.devices.length, 1);
  assert.deepEqual(
    device.grants.map((fields) => fields.grant_type),
    ["urn:ietf:params:oauth:grant-type:device_code"],
  );
  assert.equal(device.grants[0].device_code, `${deviceCode}1`);
  assert.equal(device.grants[0].client_id, localSignInClientId);
  const slowed = await store.pendingRead(device.clock.nowMs);
  assert.equal(slowed.intervalSecs, 10);
  assert.equal(slowed.polledAtMs, device.clock.nowMs);

  device.clock.nowMs += 5_000;
  const next = device.opened();
  await called(next);
  assert.equal(device.grants.length, 1);
  device.clock.nowMs += 5_000;
  await called(next);
  assert.equal(device.grants.length, 2);
  assert.deepEqual(new Set(codes), new Set(["USER-1"]));
});

test("a slowed interval is kept within the contract's bound", async (t) => {
  const store = storeOf(undefined);
  const device = deviceOf(
    t,
    store,
    () => ({ status: 400, body: { error: "slow_down" } }),
    (_fields, n) =>
      authorized(n, { interval: signInStorePendingIntervalSecsMax }),
  );
  await signInNeeded(device.signIn);
  await signInNeeded(device.signIn);
  assert.equal(device.grants.length, 1);
  assert.equal(
    (await store.pendingRead(device.clock.nowMs)).intervalSecs,
    signInStorePendingIntervalSecsMax,
  );
});

test("a device approved with a renewal token is stored as a sign-in, with no pending or ended record, before the call is answered", async (t) => {
  const store = storeOf(undefined);
  store.ended = { endedAtMs: 0, error: "invalid_grant" };
  const device = deviceOf(t, store, (_fields, n) => issued(n));
  await signInNeeded(device.signIn);
  const answered = device.signIn.token().then((token) => ({
    token,
    renewal: store.renewal,
    access: store.access,
    pending: store.pending,
    ended: store.ended,
  }));
  assert.deepEqual(await answered, {
    token: "access-1",
    renewal: "renewal-1",
    access: {
      accessToken: "access-1",
      expiresAtMs: device.clock.nowMs + 3_600_000,
      renewal: "renewal-1",
    },
    pending: undefined,
    ended: undefined,
  });
});

test("a device approved with no renewal token serves this process alone: nothing is stored and the pending record is gone", async (t) => {
  const store = storeOf(undefined);
  const device = deviceOf(t, store, () => ({
    body: { access_token: "access-only", expires_in: 3_600 },
  }));
  await signInNeeded(device.signIn);
  assert.equal(await device.signIn.token(), "access-only");
  assert.equal(store.renewal, undefined);
  assert.equal(store.access, undefined);
  assert.equal(store.pending, undefined);
  assert.equal(await device.signIn.token(), "access-only");
  assert.equal(device.grants.length, 1);
});

test("a code the issuer answers expired_token or invalid_grant for, or one past its expiry, is replaced by a new one in the same call", async (t) => {
  for (const error of ["expired_token", "invalid_grant"]) {
    const store = storeOf(undefined);
    const device = deviceOf(t, store, () => ({ status: 400, body: { error } }));
    assert.equal((await signInNeeded(device.signIn)).userCode, "USER-1");
    assert.equal((await signInNeeded(device.signIn)).userCode, "USER-2");
    assert.equal(device.grants.length, 1, error);
    assert.equal(
      (await store.pendingRead(device.clock.nowMs)).deviceCode,
      `${deviceCode}2`,
    );
  }
  const store = storeOf(undefined);
  const device = deviceOf(t, store, () => devicePending);
  assert.equal((await signInNeeded(device.signIn)).userCode, "USER-1");
  device.clock.nowMs += 600_000;
  assert.equal((await signInNeeded(device.signIn)).userCode, "USER-2");
  assert.equal(device.grants.length, 0);
});

test("a poll answered with a 400 with no body or one that is not JSON, any other answer, or a fault keeps the record, its time recorded, and throws nothing", async (t) => {
  const answers = [
    () => ({ response: new globalThis.Response(null, { status: 400 }) }),
    () => ({
      response: new globalThis.Response("<html>Bad Request</html>", {
        status: 400,
      }),
    }),
    () => ({ status: 400, body: { error: "access_denied" } }),
    () => ({ status: 503 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ];
  for (const answer of answers) {
    const store = storeOf(undefined);
    const device = deviceOf(t, store, answer);
    await signInNeeded(device.signIn);
    device.clock.nowMs += 1;
    const needed = await signInNeeded(device.signIn);
    assert.equal(needed.userCode, "USER-1");
    assert.equal(device.grants.length, 1);
    assert.equal(device.devices.length, 1);
    const kept = await store.pendingRead(device.clock.nowMs);
    assert.equal(kept.deviceCode, `${deviceCode}1`);
    assert.equal(kept.polledAtMs, device.clock.nowMs);
    deviceCodeUnsaid(needed.message, ...device.lines);
  }
});

test("a refused device authorization, or none in the discovery, offers the page alone, writes nothing, and is not asked again", async (t) => {
  for (const status of [400, 401]) {
    const store = storeOf(undefined);
    const device = deviceOf(
      t,
      store,
      () => devicePending,
      () => ({
        status,
        body: { error: "invalid_grant" },
      }),
    );
    for (let call = 0; call < 2; call += 1) {
      const needed = await signInNeeded(device.signIn);
      assert.equal(needed.deviceUrl, undefined);
      assert.doesNotMatch(needed.message, /any device/u);
    }
    assert.equal(device.devices.length, 1);
    assert.equal(store.pending, undefined);
  }
  const { fetch, grants } = serversOf(() => devicePending);
  const store = storeOf(undefined);
  const signIn = localSignIn(site, store, { fetch });
  t.after(() => signIn.close());
  assert.equal((await signInNeeded(signIn)).deviceUrl, undefined);
  assert.equal(store.pending, undefined);
  assert.equal(grants.length, 0);
});

test("a device authorization cut off by a fault, or answered with anything but one, offers the page alone for that call and is asked again on the next", async (t) => {
  const faults = [
    () => {
      throw new TypeError("fetch failed");
    },
    () => ({ status: 503 }),
    () => authorized(1, { device_code: undefined }),
  ];
  for (const fault of faults) {
    const store = storeOf(undefined);
    let faulted = false;
    const device = deviceOf(
      t,
      store,
      () => devicePending,
      (fields, n) => {
        if (faulted) return authorized(n);
        faulted = true;
        return fault(fields, n);
      },
    );
    const first = await signInNeeded(device.signIn);
    assert.equal(first.deviceUrl, undefined);
    assert.equal(store.pending, undefined);
    assert.equal((await signInNeeded(device.signIn)).userCode, "USER-2");
    assert.equal(device.devices.length, 2);
  }
});

test("a sign-in through the page removes the pending record, and a hold that finds a renewal token stored uses it rather than polling", async (t) => {
  const paged = storeOf(undefined);
  const device = deviceOf(t, paged, (fields, n) =>
    fields.grant_type === "authorization_code" ? issued(n) : devicePending,
  );
  const query = new URL((await signInNeeded(device.signIn)).url).searchParams;
  assert.notEqual(paged.pending, undefined);
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);
  assert.equal(paged.pending, undefined);
  assert.equal(paged.renewal, "renewal-1");

  const renewed = storeOf(undefined);
  const elsewhere = deviceOf(t, renewed, (_fields, n) => issued(n));
  await signInNeeded(elsewhere.signIn);
  renewed.renewal = "renewal-0";
  assert.equal(await elsewhere.signIn.token(), "access-1");
  assert.deepEqual(
    elsewhere.grants.map((fields) => fields.grant_type),
    ["refresh_token"],
  );
});
