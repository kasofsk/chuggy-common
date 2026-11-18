/**
 * A person's own sign-in to one chuggy site, for the local tool server: the
 * access token every tool call presents, renewed ahead of its expiry, and the
 * sign-in page that starts one when there is none.
 *
 * IT SIGNS IN AS THE SETUP PROGRAM'S CLIENT, the one chuggy's
 * `ui/chuggy-ui/app/core/setupProgram.ts` names: public, returning to a
 * loopback address on any port, under the scopes named here, as the issuer
 * registers it. The authorization code
 * flow with PKCE is the console's, and the site's own `/config.json` names
 * the issuer and the audience, so a site that moves its issuer moves this too.
 *
 * NO SIGN-IN IS STARTED BY A PAGE OPENING ITSELF. A call made with no renewal
 * token, or with one the issuer refused, is answered with the issuer's sign-in
 * address, for the agent to hand the person; the sign-in returns to a page
 * this process holds on `127.0.0.1`, so it is opened on this machine. The
 * page stays answerable until it is answered or its bound passes; a call made
 * meanwhile is answered with the same address. An answer the page reads
 * is one carrying the state this sign-in sent, checked before anything else
 * is read, so nothing else that reaches the port can end it.
 *
 * BESIDE THE PAGE, A SIGN-IN FROM ANY DEVICE (RFC 8628), where the issuer's
 * discovery names a device authorization endpoint: the answer carries its
 * link and user code too, so a person with no browser on this machine approves
 * elsewhere. The site has one authorization, in the store's pending record,
 * which every process shows and polls; it is requested, and polled once its
 * interval has passed, in the hold a renewal is made in, and a call waits on
 * no timer for it. Whichever of the page and the device is approved first
 * signs the machine in. The device code is a sign-in for whoever holds it, so
 * it is kept as a renewal token is. A refusal of the device authorization,
 * or no endpoint, leaves the page alone for the process's life; a fault
 * leaves it alone for that call.
 *
 * A TOKEN IS NEVER IN AN ANSWER. Not in an error, not in a page, not in a
 * line written anywhere. A refusal from the issuer is said by the `error` and
 * `error_description` it answered, as the contract's ended record fits them,
 * and either is dropped where it holds the token presented or a long part of
 * it.
 *
 * Renewals run under the store's lock, which every process on the machine
 * that renews the same sign-in takes, chuggy's setup program too. In that hold
 * a process first takes the access token the store keeps for the renewal
 * token it holds, while that is fresh and the API has not refused it, so a
 * machine renews once per access token's life. A renewal the issuer refused,
 * as the console reads a refusal, ends the sign-in: the process says when and
 * why on stderr, and the store keeps that in place of both tokens until a
 * sign-in. Any other failure keeps the store for the next call. A renewal
 * whose answer is lost after the issuer replaced the token still leaves a
 * spent one stored, and the next renewal ends the sign-in. Hydra deletes a
 * device code on its approval, so a lost answer to a poll costs a second
 * approval. So a renewal or a poll sent before the server is told to end
 * finishes before it ends, and one not yet sent is not started
 * (https://www.ory.com/docs/hydra/debug, "Refresh Token flow fails").
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";

import {
  signInStoreEndedRead,
  signInStoreEndedText,
  signInStorePendingIntervalSecsMax,
} from "@chuggy/worker-contract/signInStore";

import { chuggyBoundedBody } from "./chuggyApi.mjs";

export const localSignInClientId = "chuggy-setup";
export const localSignInCallbackPath = "/callback";
export const localSignInScopes = ["openid", "offline_access"];
export const localSignInLoopbackHost = "127.0.0.1";

/** How long a sign-in page waits for the person before it closes. */
export const localSignInListenMsMax = 600_000;

/** The bound every request to the site's configuration and to the issuer is sent under. */
export const localSignInFetchTimeoutMs = 15_000;

/** How far ahead of its expiry a held access token is replaced. */
export const localSignInRefreshMarginMs = 60_000;

/** The most one answer from the site's configuration or the issuer is read to. */
export const localSignInAnswerBytesMax = 65_536;

/** How long a server told to end waits for the renewal it sent: the request is cut off at `localSignInFetchTimeoutMs`, and its writes have as long again. */
export const localSignInEndingMsMax = 2 * localSignInFetchTimeoutMs;

/** The most tokens the API refused a process remembers, the oldest forgotten first: each is one a call was answered with and then refused. */
export const localSignInRefusedTokensMax = 32;

/**
 * The shortest `.`-separated part of a presented token whose presence in the
 * issuer's words drops them. A part this long is random text no issuer words
 * by chance; a shorter one can be an ordinary word, which would drop a reason
 * holding no token.
 */
export const localSignInTokenPartCharsMin = 16;

const localSignInConfigurationPath = "/config.json";
const localSignInDiscoveryPath = "/.well-known/openid-configuration";
const localSignInVerifierBytes = 32;
const localSignInStateBytes = 16;
/** The statuses a token request or a device authorization is refused with, as the console's session holder reads them. */
const localSignInRefusalStatuses = new Set([400, 401]);
const localSignInDeviceGrantType =
  "urn:ietf:params:oauth:grant-type:device_code";
/** The polling interval a device authorization naming none is given (RFC 8628 §3.2). */
const localSignInDeviceIntervalSecs = 5;
/** What each `slow_down` adds to a device authorization's polling interval (RFC 8628 §3.5). */
const localSignInSlowDownSecs = 5;

/** When the issuer ended a sign-in, and why where it said. */
function localSignInEndedSaid(ended) {
  const at = new Date(ended.endedAtMs).toISOString();
  const words = [ended.error, ended.errorDescription]
    .filter((word) => word !== undefined && word !== "")
    .join(": ");
  return words === ""
    ? `at ${at} and gave no reason`
    : `at ${at} and said why: "${words}"`;
}

/** The link a device sign-in is approved at: the complete verification URI where the issuer gave one. */
function localSignInDeviceUrl(pending) {
  return pending.verificationUriComplete ?? pending.verificationUri;
}

/**
 * What a call is answered with where the person must sign in first, when and
 * why the issuer ended the sign-in where `ended` says, and the link and user
 * code of the device sign-in `pending`, where there is one.
 */
export class LocalSignInNeeded extends Error {
  constructor(site, url, ended = undefined, pending = undefined) {
    super(
      `not signed in to ${site}: this call needs the person signed in, so give them this address, in full, in your next message, whatever else you are doing: ${url} Call the tool again once they say they have signed in. The page closes once it is answered or after a while unanswered, and a later call opens another.${ended === undefined ? "" : ` The issuer ended this sign-in ${localSignInEndedSaid(ended)}.`}${pending === undefined ? "" : ` The address opens only on this machine, so give them as well, in full, this link, which opens on any device, and its code, for them to sign in at whichever they can: ${localSignInDeviceUrl(pending)} with the code ${pending.userCode}`}`,
    );
    this.name = "LocalSignInNeeded";
    this.url = url;
    this.deviceUrl =
      pending === undefined ? undefined : localSignInDeviceUrl(pending);
    this.userCode = pending?.userCode;
  }
}

function localSignInBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function localSignInAsked(ports, url, init = {}) {
  return ports.fetch(url, {
    ...init,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(localSignInFetchTimeoutMs),
    headers: { accept: "application/json", ...init.headers },
  });
}

async function localSignInFetch(ports, url, init = {}) {
  return localSignInRead(url, await localSignInAsked(ports, url, init));
}

/** The status `url` answered, and its body where that is a 200. */
async function localSignInRead(url, response) {
  const { text, cut } = await chuggyBoundedBody(
    response,
    localSignInAnswerBytesMax,
  );
  if (cut) throw new Error(`${url} answered more than one answer is read to`);
  let body;
  try {
    body = response.status === 200 ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${url} answered a body that is not JSON`);
  }
  return { status: response.status, body };
}

function localSignInText(value, what) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${what} is missing`);
  return value;
}

/** The issuer the site names, its endpoints, and the audience its API takes. */
async function localSignInIssuer(ports, site) {
  const configuration = await localSignInFetch(
    ports,
    `${site}${localSignInConfigurationPath}`,
  );
  if (configuration.status !== 200)
    throw new Error(
      `${site} answered ${String(configuration.status)} for its configuration`,
    );
  const issuer = localSignInText(
    configuration.body?.issuer,
    "the site's issuer",
  ).replace(/\/+$/u, "");
  const audience = localSignInText(
    configuration.body?.audience,
    "the site's audience",
  );
  const discovery = await localSignInFetch(
    ports,
    `${issuer}${localSignInDiscoveryPath}`,
  );
  if (discovery.status !== 200)
    throw new Error(
      `the sign-in server answered ${String(discovery.status)} for its discovery document`,
    );
  if (
    localSignInText(discovery.body?.issuer, "the issuer's name").replace(
      /\/+$/u,
      "",
    ) !== issuer
  )
    throw new Error(
      "the sign-in server's discovery document names another issuer",
    );
  return {
    audience,
    authorize: localSignInText(
      discovery.body?.authorization_endpoint,
      "the issuer's authorization endpoint",
    ),
    token: localSignInText(
      discovery.body?.token_endpoint,
      "the issuer's token endpoint",
    ),
    device: localSignInOptional(discovery.body?.device_authorization_endpoint),
  };
}

function localSignInOptional(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The `error` and `error_description` of a refusal's body, each where it is a
 * string. Nothing here throws: a body that is missing, cut short, past
 * `localSignInAnswerBytesMax` or not JSON gives no reason.
 */
async function localSignInRefusalRead(response) {
  try {
    const { text, cut } = await chuggyBoundedBody(
      response,
      localSignInAnswerBytesMax,
    );
    const body = cut ? undefined : JSON.parse(text);
    const word = (value) => (typeof value === "string" ? value : undefined);
    return {
      error: word(body?.error),
      errorDescription: word(body?.error_description),
    };
  } catch {
    return {};
  }
}

/** One token request: `issued`, the tokens issued, or `refused`, what the issuer said refusing the grant. */
async function localSignInGrant(ports, issuer, fields) {
  const response = await localSignInAsked(ports, issuer.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...fields,
      client_id: localSignInClientId,
    }).toString(),
  });
  if (localSignInRefusalStatuses.has(response.status))
    return { refused: await localSignInRefusalRead(response) };
  const answer = await localSignInRead(issuer.token, response);
  if (answer.status !== 200)
    throw new Error(
      `the sign-in server answered ${String(answer.status)} for a token`,
    );
  const expiresInSecs = answer.body?.expires_in;
  return {
    issued: {
      access: localSignInText(answer.body?.access_token, "the access token"),
      renewal: localSignInOptional(answer.body?.refresh_token),
      expiresAtMs:
        ports.nowMs() +
        (Number.isInteger(expiresInSecs) && expiresInSecs > 0
          ? expiresInSecs * 1_000
          : 0),
    },
  };
}

/** Whether `text` holds `token`, or one of its `.`-separated parts of at least `localSignInTokenPartCharsMin`. */
function localSignInHoldsToken(text, token) {
  return (
    text.includes(token) ||
    token
      .split(".")
      .some(
        (part) =>
          part.length >= localSignInTokenPartCharsMin && text.includes(part),
      )
  );
}

/**
 * The ended record of a refusal of `presented` at `endedAtMs`, its words
 * fitted as the contract's record keeps them, and each dropped where it held
 * the token before or after fitting.
 */
function localSignInEndedFitted(endedAtMs, refused, presented) {
  const fitted = signInStoreEndedRead(
    signInStoreEndedText({
      endedAtMs,
      error: refused.error ?? "",
      errorDescription: refused.errorDescription,
    }),
  );
  const kept = (raw, word) =>
    word === undefined ||
    localSignInHoldsToken(raw ?? "", presented) ||
    localSignInHoldsToken(word, presented)
      ? undefined
      : word;
  const errorDescription = kept(
    refused.errorDescription,
    fitted.errorDescription,
  );
  return {
    endedAtMs,
    error: kept(refused.error, fitted.error) ?? "",
    ...(errorDescription === undefined ? {} : { errorDescription }),
  };
}

/** The sign-in ended where the issuer refused `presented`: said on stderr, then kept in the store in place of both tokens. */
async function localSignInEnded(signIn, store, presented, refused) {
  const ended = localSignInEndedFitted(
    signIn.ports.nowMs(),
    refused,
    presented,
  );
  signIn.ports.log(
    `the issuer ended the sign-in to ${signIn.site} ${localSignInEndedSaid(ended)}`,
  );
  await store.endedWrite(ended);
  await store.clear();
  await store.accessClear();
  return ended;
}

/** What the issuer issued kept in the store: the renewal token, then the access token bound to it, then no pending or ended record. */
async function localSignInKept(store, issued, presented) {
  const renewal = issued.renewal ?? presented;
  if (issued.renewal !== undefined) await store.write(issued.renewal);
  if (renewal !== undefined)
    await store.accessWrite(
      { accessToken: issued.access, expiresAtMs: issued.expiresAtMs },
      renewal,
    );
  await store.pendingClear();
  await store.endedClear();
  return { access: issued.access, expiresAtMs: issued.expiresAtMs };
}

function localSignInPage(response, status, text) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${text}\n`);
}

/**
 * The page a sign-in returns to. It answers the one request carrying its state
 * on its own path, and tells everything else there is nothing here. The page
 * ends once that answer is sent or its browser has gone, and not before,
 * since ending it closes every connection it holds.
 */
function localSignInCallback(signIn, page, request, response) {
  const asked = new URL(request.url ?? "/", page.origin);
  if (
    request.method !== "GET" ||
    asked.pathname !== localSignInCallbackPath ||
    asked.searchParams.get("state") !== page.state
  ) {
    localSignInPage(response, 404, "There is nothing here.");
    return;
  }
  if (page.answering) {
    localSignInPage(response, 409, "This sign-in is already being answered.");
    return;
  }
  page.answering = true;
  response.once("close", () => signIn.pageEnded(page));
  const code = asked.searchParams.get("code");
  if (code === null) {
    localSignInPage(
      response,
      200,
      "The sign-in was declined. Ask your agent to try again.",
    );
    return;
  }
  void signIn.pageAnswered(page, code).then(
    () =>
      localSignInPage(
        response,
        200,
        "Signed in. You can close this page and go back to your chat.",
      ),
    (failure) =>
      localSignInPage(
        response,
        502,
        `The sign-in did not complete: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
  );
}

async function localSignInPageOpened(signIn, issuer) {
  const verifier = localSignInBase64url(
    signIn.ports.randomBytes(localSignInVerifierBytes),
  );
  const page = {
    verifier,
    state: localSignInBase64url(
      signIn.ports.randomBytes(localSignInStateBytes),
    ),
    issuer,
  };
  const server = createServer((request, response) =>
    localSignInCallback(signIn, page, request, response),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, localSignInLoopbackHost, resolve);
  });
  page.server = server;
  page.origin = `http://${localSignInLoopbackHost}:${String(server.address().port)}`;
  page.redirect = `${page.origin}${localSignInCallbackPath}`;
  const authorize = new URL(issuer.authorize);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: localSignInClientId,
    redirect_uri: page.redirect,
    scope: localSignInScopes.join(" "),
    audience: issuer.audience,
    state: page.state,
    code_challenge: localSignInBase64url(
      createHash("sha256").update(verifier).digest(),
    ),
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(name, value);
  page.url = authorize.toString();
  page.timer = setTimeout(() => signIn.pageEnded(page), localSignInListenMsMax);
  page.timer.unref?.();
  return page;
}

/**
 * The sign-in to `site`, kept in `store` (`./localTokenStore.mjs`). `token`
 * answers an access token or raises `LocalSignInNeeded`; `invalidate` refuses
 * one the API refused, for good; `close` ends a page still open, starts no
 * renewal after, and resolves once one already sent has finished, or
 * `localSignInEndingMsMax` has passed. `log` says a line on stderr.
 */
export function localSignIn(site, store, overrides = {}) {
  const ports = {
    fetch: globalThis.fetch,
    nowMs: Date.now,
    randomBytes,
    log: (line) => void process.stderr.write(`${line}\n`),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, port]) => port !== undefined),
    ),
  };
  const origin = new URL(site).origin;
  return localSignInHolder(origin, store, ports);
}

/** One renewal under the store's lock, or the sign-in page where there is nothing to renew. */
async function localSignInRenewed(signIn, store) {
  const issuer = await signIn.issuer();
  const held = await store.locked(() => localSignInHeld(signIn, store, issuer));
  if (held.issued !== undefined) return held.issued;
  signIn.page ??= await localSignInPageOpened(signIn, issuer);
  throw new LocalSignInNeeded(
    signIn.site,
    signIn.page.url,
    held.ended,
    held.pending,
  );
}

/**
 * In the store's one hold: the access token it keeps for its renewal token
 * where that is usable, else a renewal, else, where there is nothing to
 * renew, the device sign-in's outcome and the ended record. A server told to
 * end sends no renewal.
 */
async function localSignInHeld(signIn, store, issuer) {
  const renewal = await store.read();
  if (renewal === undefined) {
    const device = await localSignInDeviceHeld(signIn, store, issuer);
    return device.issued !== undefined
      ? device
      : { ...device, ended: await store.endedRead() };
  }
  const kept = await store.accessRead(renewal);
  if (kept !== undefined && signIn.usable(kept.accessToken, kept.expiresAtMs))
    return {
      issued: { access: kept.accessToken, expiresAtMs: kept.expiresAtMs },
    };
  if (signIn.ending)
    throw new Error(
      `this server is ending, so it starts no renewal of the sign-in to ${signIn.site}`,
    );
  return localSignInSending(signIn, () =>
    localSignInSent(signIn, store, issuer, renewal),
  );
}

/** What `send` answers, held as the request `close` waits for until it has. */
async function localSignInSending(signIn, send) {
  signIn.sending = send();
  try {
    return await signIn.sending;
  } finally {
    signIn.sending = undefined;
  }
}

/**
 * In the store's hold, with no renewal token stored: the site's device
 * sign-in, polled once where its interval has passed, else a new one where
 * there is none; `issued` where a poll found it approved, and nothing where
 * the page alone is to be offered. A server told to end sends nothing.
 */
async function localSignInDeviceHeld(signIn, store, issuer) {
  if (issuer.device === undefined || signIn.deviceRefused) return {};
  const nowMs = signIn.ports.nowMs();
  let pending = await store.pendingRead(nowMs);
  if (
    pending !== undefined &&
    !signIn.ending &&
    (pending.polledAtMs ?? -Infinity) + pending.intervalSecs * 1_000 <= nowMs
  ) {
    const polled = await localSignInSending(signIn, () =>
      localSignInPolled(signIn, store, issuer, pending),
    );
    if (polled.issued !== undefined) return polled;
    pending = polled.pending;
  }
  if (pending !== undefined || signIn.ending) return { pending };
  try {
    const authorized = await localSignInSending(signIn, () =>
      localSignInDeviceAuthorized(signIn, store, issuer),
    );
    if (authorized.refused) signIn.deviceRefused = true;
    return { pending: authorized.pending };
  } catch {
    return {};
  }
}

/**
 * One poll of `pending`, its outcome written before it is answered: `issued`
 * kept as a sign-in is, nothing where the code is spent or expired, else
 * `pending` as it is kept, its poll's time and any slowing recorded.
 */
async function localSignInPolled(signIn, store, issuer, pending) {
  const polledAtMs = signIn.ports.nowMs();
  let granted;
  try {
    granted = await localSignInGrant(signIn.ports, issuer, {
      grant_type: localSignInDeviceGrantType,
      device_code: pending.deviceCode,
    });
  } catch {
    granted = { refused: {} };
  }
  if (granted.issued !== undefined)
    return { issued: await localSignInKept(store, granted.issued, undefined) };
  const { error } = granted.refused;
  if (error === "expired_token" || error === "invalid_grant") {
    await store.pendingClear();
    return {};
  }
  const kept = {
    ...pending,
    polledAtMs,
    intervalSecs:
      error === "slow_down"
        ? Math.min(
            pending.intervalSecs + localSignInSlowDownSecs,
            signInStorePendingIntervalSecsMax,
          )
        : pending.intervalSecs,
  };
  await store.pendingWrite(kept);
  return { pending: kept };
}

/**
 * A new device authorization, its pending record written before it is
 * answered, or `refused` where the issuer refused the client the grant. An
 * answer that is not one throws, and nothing is written.
 */
async function localSignInDeviceAuthorized(signIn, store, issuer) {
  const nowMs = signIn.ports.nowMs();
  const response = await localSignInAsked(signIn.ports, issuer.device, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: localSignInClientId,
      scope: localSignInScopes.join(" "),
      audience: issuer.audience,
    }).toString(),
  });
  if (localSignInRefusalStatuses.has(response.status)) {
    await response.body?.cancel();
    return { refused: true };
  }
  const { status, body } = await localSignInRead(issuer.device, response);
  if (status !== 200)
    throw new Error(
      `the sign-in server answered ${String(status)} for a device authorization`,
    );
  const expiresInSecs = body?.expires_in;
  if (!Number.isInteger(expiresInSecs) || expiresInSecs <= 0)
    throw new Error("the device authorization's expiry is missing");
  const verificationUriComplete = localSignInOptional(
    body?.verification_uri_complete,
  );
  const pending = {
    deviceCode: localSignInText(body?.device_code, "the device code"),
    userCode: localSignInText(body?.user_code, "the user code"),
    verificationUri: localSignInText(
      body?.verification_uri,
      "the verification URI",
    ),
    ...(verificationUriComplete === undefined
      ? {}
      : { verificationUriComplete }),
    expiresAtMs: nowMs + expiresInSecs * 1_000,
    intervalSecs:
      Number.isInteger(body?.interval) && body.interval > 0
        ? body.interval
        : localSignInDeviceIntervalSecs,
  };
  await store.pendingWrite(pending);
  return { pending };
}

/** One renewal of `renewal`, sent and its outcome kept. */
async function localSignInSent(signIn, store, issuer, renewal) {
  const granted = await localSignInGrant(signIn.ports, issuer, {
    grant_type: "refresh_token",
    refresh_token: renewal,
  });
  if (granted.refused !== undefined)
    return {
      ended: await localSignInEnded(signIn, store, renewal, granted.refused),
    };
  return { issued: await localSignInKept(store, granted.issued, renewal) };
}

/** Waits for `sending` to settle, at most `localSignInEndingMsMax`. */
async function localSignInSettled(sending) {
  let timer;
  await Promise.race([
    sending.then(
      () => undefined,
      () => undefined,
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, localSignInEndingMsMax);
    }),
  ]);
  clearTimeout(timer);
}

function localSignInHolder(site, store, ports) {
  const signIn = {
    site,
    ports,
    known: undefined,
    held: undefined,
    renewing: undefined,
    sending: undefined,
    ending: false,
    deviceRefused: false,
    refused: new Set(),
    page: undefined,
    usable(access, expiresAtMs) {
      return (
        expiresAtMs - localSignInRefreshMarginMs > ports.nowMs() &&
        !signIn.refused.has(access)
      );
    },
    async issuer() {
      signIn.known ??= await localSignInIssuer(ports, site);
      return signIn.known;
    },
    pageEnded(ended) {
      if (ended.ended) return;
      ended.ended = true;
      clearTimeout(ended.timer);
      ended.server.close();
      ended.server.closeAllConnections?.();
      if (signIn.page === ended) signIn.page = undefined;
    },
    async pageAnswered(answered, code) {
      const granted = await localSignInGrant(ports, answered.issuer, {
        grant_type: "authorization_code",
        code,
        redirect_uri: answered.redirect,
        code_verifier: answered.verifier,
      });
      if (granted.refused !== undefined)
        throw new Error("the sign-in server refused the code");
      signIn.held = await store.locked(() =>
        localSignInKept(store, granted.issued, undefined),
      );
    },
  };
  return localSignInAnswering(signIn, store);
}

/** What `localSignIn` answers for `signIn`. */
function localSignInAnswering(signIn, store) {
  return {
    async token() {
      const held = signIn.held;
      if (held !== undefined && signIn.usable(held.access, held.expiresAtMs))
        return held.access;
      signIn.renewing ??= localSignInRenewed(signIn, store).finally(() => {
        signIn.renewing = undefined;
      });
      signIn.held = await signIn.renewing;
      return signIn.held.access;
    },
    invalidate(refused) {
      signIn.refused.delete(refused);
      signIn.refused.add(refused);
      if (signIn.refused.size > localSignInRefusedTokensMax)
        signIn.refused.delete(signIn.refused.values().next().value);
      if (signIn.held?.access === refused) signIn.held = undefined;
    },
    async close() {
      signIn.ending = true;
      if (signIn.page !== undefined) signIn.pageEnded(signIn.page);
      if (signIn.sending !== undefined)
        await localSignInSettled(signIn.sending);
    },
  };
}
