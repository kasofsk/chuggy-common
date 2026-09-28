/**
 * The pool loop's token source: the OAuth2 client-credentials grant, held
 * until a refresh margin before its expiry and minted at most once per
 * cooldown. chuggy's `src/adapters/http/clientCredentials.ts` and
 * `src/adapters/http/poolTokens.ts` are the same source in TypeScript.
 *
 * The cooldown is measured from the start of the last attempt on a monotonic
 * clock, so neither a refusal that never stops nor an issuer that never
 * answers turns a loop of reads into a loop of grants; the expiry is the
 * issuer's statement about wall-clock time and is held against one. No
 * message here carries the secret or a token, though every grant carries both.
 */

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { URL, URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { boundedResponseBytes } from "./boundedResponse.mjs";

/**
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokens} WorkerPoolTokens
 * @typedef {import("./poolLoop.mjs").WorkerPoolTokenAcquired} WorkerPoolTokenAcquired
 *
 * @typedef {object} ClientCredentialsConfig
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {readonly string[]} audience
 * @property {readonly string[]} scope
 * @property {number} requestTimeoutMs
 * @property {number} responseBytesMax
 * @property {number} responseReadsMax
 * @property {number} refreshMarginMs how far ahead of expiry a held token stops being handed out
 * @property {number} mintCooldownMs the operator's bound on grant requests, shorter than the margin so a failed refresh is tried again before the token expires
 * @property {typeof fetch} [fetch]
 * @property {() => number} [currentTimeEpochMs]
 * @property {() => number} [monotonicMs]
 *
 * @typedef {object} AccessTokenSource
 * @property {(signal: AbortSignal) => Promise<string>} token
 * @property {(refused: string) => void} invalidate discards nothing once something else is held
 */

const millisecondsPerSecond = 1_000;
const clientCredentialsGrantType = "client_credentials";
const clientCredentialsTokenType = "bearer";

/** RFC 6749 lets an issuer answer more than these, and a client ignores the rest. */
const clientCredentialsGrantSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * @param {ClientCredentialsConfig} config
 * @returns {ClientCredentialsConfig}
 */
function clientCredentialsChecked(config) {
  const url = new URL(config.tokenUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new RangeError("client credentials token URL is not HTTP");
  if (url.username !== "" || url.password !== "")
    throw new RangeError("client credentials token URL carries credentials");
  if (config.clientId.length === 0 || config.clientSecret.length === 0)
    throw new RangeError("client credentials identity or secret is empty");
  for (const [bound, what] of [
    [config.requestTimeoutMs, "request timeout"],
    [config.responseBytesMax, "response byte bound"],
    [config.responseReadsMax, "response read bound"],
    [config.refreshMarginMs, "refresh margin"],
    [config.mintCooldownMs, "mint cooldown"],
  ])
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new RangeError(
        `client credentials ${what} must be a positive safe integer`,
      );
  if (config.mintCooldownMs >= config.refreshMarginMs)
    throw new RangeError(
      "client credentials mint cooldown must be shorter than its refresh margin",
    );
  return config;
}

/**
 * Basic authentication, each half percent-encoded so neither can contribute
 * the colon that joins them.
 *
 * @param {ClientCredentialsConfig} config
 */
function clientCredentialsAuthorization(config) {
  const encoded = [config.clientId, config.clientSecret]
    .map((part) => encodeURIComponent(part))
    .join(":");
  return `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
}

/**
 * How long a grant is handed out: its lifetime less the margin, or half of it
 * when the margin would leave none, since a hold of nothing is a mint per read.
 *
 * @param {number} lifetimeMs
 * @param {number} refreshMarginMs
 */
function clientCredentialsHoldMs(lifetimeMs, refreshMarginMs) {
  return lifetimeMs > refreshMarginMs
    ? lifetimeMs - refreshMarginMs
    : Math.floor(lifetimeMs / 2);
}

/**
 * The issuer refusing this client, which presenting the credential again will
 * not change; an issuer that could not be reached is an ordinary `Error`.
 */
export class ClientCredentialsRefused extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`client credentials grant returned ${String(status)}`);
    this.name = "ClientCredentialsRefused";
    this.status = status;
  }
}

/**
 * One grant. A grant that cannot outlive the cooldown is refused, because
 * holding it would let the issuer shorten the operator's bound, most of all
 * when the issuer is slowest to answer.
 *
 * @param {ClientCredentialsConfig} config
 * @param {typeof fetch} transport
 * @param {number} atEpochMs
 */
async function clientCredentialsMinted(config, transport, atEpochMs) {
  const form = new URLSearchParams({ grant_type: clientCredentialsGrantType });
  if (config.audience.length > 0)
    form.set("audience", config.audience.join(" "));
  if (config.scope.length > 0) form.set("scope", config.scope.join(" "));
  const response = await transport(new URL(config.tokenUrl), {
    method: "POST",
    headers: {
      authorization: clientCredentialsAuthorization(config),
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: globalThis.AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw response.status >= 400 && response.status < 500
      ? new ClientCredentialsRefused(response.status)
      : new Error(
          `client credentials grant returned ${String(response.status)}`,
        );
  }
  const bytes = await boundedResponseBytes(
    response,
    config.responseBytesMax,
    config.responseReadsMax,
  );
  const grant = clientCredentialsGrantSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (grant.token_type.toLowerCase() !== clientCredentialsTokenType)
    throw new Error("client credentials grant is not a bearer token");
  const lifetimeMs = grant.expires_in * millisecondsPerSecond;
  if (lifetimeMs <= config.mintCooldownMs)
    throw new RangeError(
      `client credentials grant lives ${String(lifetimeMs)}ms, which this client cannot operate on while keeping a ${String(config.mintCooldownMs)}ms cooldown between grants`,
    );
  if (/[\r\n]/u.test(grant.access_token))
    throw new RangeError(
      "client credentials grant is no bearer token a header can carry",
    );
  return {
    token: grant.access_token,
    replaceAtEpochMs:
      atEpochMs + clientCredentialsHoldMs(lifetimeMs, config.refreshMarginMs),
    expiresAtEpochMs: atEpochMs + lifetimeMs,
  };
}

/** The cooldown's clock when none is supplied: process-relative, so no wall-clock step can make elapsed time negative. */
export function clientCredentialsMonotonicMs() {
  return performance.now();
}

/**
 * Mints on demand and holds the grant until its margin. Callers arriving while
 * a mint is in flight join it, and one arriving inside the cooldown is handed
 * a token still short of its expiry. A failed mint is not held, so the next
 * caller past the cooldown mints again and carries the failure itself.
 *
 * @param {ClientCredentialsConfig} input
 * @returns {AccessTokenSource}
 */
export function clientCredentialsTokenSource(input) {
  const config = clientCredentialsChecked(input);
  const transport = config.fetch ?? globalThis.fetch;
  const currentTimeEpochMs = config.currentTimeEpochMs ?? Date.now;
  const monotonicMs = config.monotonicMs ?? clientCredentialsMonotonicMs;
  /** @type {{token: string, replaceAtEpochMs: number, expiresAtEpochMs: number} | undefined} */
  let held;
  /** @type {Promise<{token: string}> | undefined} */
  let minting;
  /** @type {number | undefined} */
  let attemptedAtMonotonicMs;
  const cooling = () =>
    attemptedAtMonotonicMs !== undefined &&
    monotonicMs() - attemptedAtMonotonicMs < config.mintCooldownMs;
  const mint = () => {
    const inFlight = minting;
    if (inFlight !== undefined) return inFlight;
    attemptedAtMonotonicMs = monotonicMs();
    return (minting = clientCredentialsMinted(
      config,
      transport,
      currentTimeEpochMs(),
    ).then(
      (granted) => {
        held = granted;
        minting = undefined;
        return granted;
      },
      (failure) => {
        minting = undefined;
        throw failure;
      },
    ));
  };
  return {
    token: async (signal) => {
      signal.throwIfAborted();
      const current = held;
      if (
        current !== undefined &&
        currentTimeEpochMs() < current.replaceAtEpochMs
      )
        return current.token;
      if (minting === undefined && cooling()) {
        if (
          current !== undefined &&
          currentTimeEpochMs() < current.expiresAtEpochMs
        )
          return current.token;
        throw new Error("client credentials grant is within its cooldown");
      }
      const granted = await mint();
      signal.throwIfAborted();
      return granted.token;
    },
    invalidate: (refused) => {
      if (held?.token === refused) held = undefined;
    },
  };
}

/**
 * The loop's tokens port over that source. A refusal and an outage stay apart:
 * merged, a pool with a mistyped secret would back off forever, or one behind
 * a restarting issuer would end.
 *
 * @param {ClientCredentialsConfig} config
 * @returns {WorkerPoolTokens}
 */
export function poolClientTokens(config) {
  const source = clientCredentialsTokenSource(config);
  return {
    acquire: async () => {
      try {
        return {
          acquired: "Token",
          token: await source.token(
            globalThis.AbortSignal.timeout(config.requestTimeoutMs),
          ),
        };
      } catch (failure) {
        if (failure instanceof ClientCredentialsRefused)
          return { acquired: "Denied", evidence: failure.message };
        return {
          acquired: "Unavailable",
          evidence:
            failure instanceof Error
              ? failure.message
              : "the issuer could not be reached",
        };
      }
    },
    invalidate: (token) => {
      source.invalidate(token);
    },
  };
}
