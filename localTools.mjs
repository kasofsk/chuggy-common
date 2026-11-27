/**
 * The `chuggy` tools served to a coding agent on a person's own machine, over
 * stdio, under that person's own sign-in (`./localSignIn.mjs`), or an access
 * token they made, rather than a session bearer.
 *
 * THE TOOLS ARE THE POD'S, unchanged: `chuggyProjectTools`, their handler and
 * their bounds, for one site's one project. What differs is only what
 * `chuggyToolContext` is handed, and under an access token the notes an answer
 * ends with. The roster is every project tool, and the API
 * is the control: it authorizes the person's token through their membership as it
 * does the console's.
 *
 * A CALL IS ITS OWN TURN. Nothing over stdio says which turn of a chat a call
 * belongs to, so each submitted command mints its operation from a turn of its
 * own. A command repeated is a second operation, and the API's fences on what
 * the command names are what refuse it, so the pod's description of a repeat
 * is replaced with that.
 *
 * UNDER A SIGN-IN, A 401 IS ASKED ONCE MORE. It says the token was what was
 * wrong, and nothing it answered was applied, so the token is refused for good
 * and the call is made again under another, which may be one another process
 * renewed; a second 401 is relayed.
 *
 * AN ACCESS TOKEN IN `CHUGGY_TOKEN` TAKES THE SIGN-IN'S PLACE, for a script
 * no person attends: no sign-in is built and its store is never reached. A
 * value that is not a token is never sent, and every call says so. Under a
 * token a 401 ends the call, since the same token gets the same answer, and
 * an answer ends with a note where it met a 404 or the token nears its expiry,
 * since what such a script logs is what the agent says.
 *
 * THE INSTALL IS KEPT ON THE SITE'S PIN, once per start: once serving, the
 * server reads the release its site pins for its own package, with no
 * sign-in, and where it is above this copy and the host's updates are on,
 * installs it through `runnerUpdater`, as the host's runner services do. It
 * never exits or restarts for it: the session serves the copy it started with
 * and the agent's next one starts the new copy, so nothing this module
 * reaches imports a module lazily, and its suite holds that. A failure is said
 * on stderr, since stdout is the protocol's, and changes nothing.
 *
 * The SDK is the caller's, as the pod's own is: this module names
 * `McpServer`, `StdioServerTransport` and `z` and imports none of them.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import {
  accessTokenExpiresHeader,
  accessTokenPattern,
  accessTokenWarningDays,
} from "@chuggy/worker-contract/accessToken";
import {
  chuggyToolServerName,
  nativeHttpMediaType,
} from "@chuggy/worker-contract/sessionTools";
import { signInStoreDirectory } from "@chuggy/worker-contract/signInStore";
import {
  workerRunnerReleasesPinnedRoute,
  workerRunnerReleasesPinnedSchema,
} from "@chuggy/worker-contract/workerPool";

import { chuggyBoundedBody, chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggySubmissionRepeatDescription,
  chuggyToolAnswerBytes,
  chuggyToolAnswerBytesMax,
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
  chuggyToolInput,
  chuggyToolSignal,
} from "./chuggyTools.mjs";
import { localSignIn } from "./localSignIn.mjs";
import { localTokenStore } from "./localTokenStore.mjs";
import { registerEndpointRefusal } from "./register.mjs";
import { runnerUpdater, runnerVersionAbove } from "./runnerUpdate.mjs";

/**
 * @typedef {import("./runnerUpdate.mjs").RunnerUpdateSettings} RunnerUpdateSettings
 * @typedef {import("./runnerUpdate.mjs").RunnerUpdater} RunnerUpdater
 * @typedef {{on: boolean, settings: RunnerUpdateSettings}} LocalToolUpdates what the host passes `runnerUpdater` for its services, and whether its updates are on
 */

/** Every capability whose tools a person's own agent is given. */
export const localToolCapabilities = [
  "ProjectRead",
  "DraftAuthor",
  "DraftOriginate",
  "TicketDispatch",
  "ProjectSettings",
  "AgentAccounts",
  "ProposalMerge",
];

/** What a submitted command made again answers here, where every call is a turn of its own. */
export const localToolRepeatDescription = `The same call again is a new operation, submitted again: where the first already landed, the API refuses the second for what it names, so read_operation the first's id to learn what it did before calling again.`;

/** How an agent files a ticket once it knows the project, the steps every serving of these tools gives. */
export const localToolFilingSteps = `1. read_abilities: who you act as, which a ticket's \`creator\` names, and what you may do.
2. list_repositories: a repository that is configured and \`fileable\`.
3. list_configurations: a revision whose \`repository\` is that repository, or, where its list_repositories row's \`configurationsHeld.result\` is Bootstrapped, the \`configurationsHeld.revision\` that row carries.
4. initialize_draft on that revision: the fence and the defaults.
5. create_draft: the minimum brief, and \`authoring\` from the defaults.
6. read_draft: the draft as filed.
7. release_draft.
8. read_operation: every command is submitted, and this is how its outcome is read.
Releasing starts nothing: once its dependencies are Done the ticket waits Pending until a person who may dispatch dispatches it: by dispatch_ticket on the word of the person you act for, or by another person who may dispatch.`;

/** How an agent steers `article` project's thread settings and merges a ticket's pull request, where it may. */
export function localToolSteeringSteps(article) {
  return `To change ${article} project's thread settings: read_docs the page "A project's thread settings", then read_lead_settings and update_lead_settings.
To merge a ticket's pull request: read_ticket_landings, ask the person whether they want chuggy to merge it, then merge_pull_request.`;
}

/**
 * What the server tells an agent before it lists the tools, `task` naming the
 * workspace and project it is bound to, and `access` the token it acts under
 * where it acts under one.
 */
export function localToolInstructions(task, access) {
  const token = access !== undefined;
  const acting = token
    ? `they act as the person who made the access token they are given, in this project only. When a call answers that the token was refused, pass that on to the person, in full, in your next message, whatever else you are doing. Nothing else stands in for what these tools answer, so do not work around a refused token.`
    : `every one but read_docs needs the person signed in. When a call answers that they are not, give them the address it names, in full, in your next message, whatever else you are doing, and call again once they say they have signed in. Nothing else stands in for what these tools answer, so do not work around a sign-in.`;
  const steering = token
    ? `Changing the project's thread settings or its placement, and merging a ticket's pull request, are, like approvals, the person's to do in the console.`
    : localToolSteeringSteps("the");
  return `This server is bound to the workspace ${task.tenant} and its project ${task.project}.
These tools are the only way to read or act on chuggy from here, and ${acting}
The chuggy docs are behind read_docs: call it with no page for the index first, then with a page the index lists.
To file a ticket:
${localToolFilingSteps}
${steering}`;
}

const localToolUnauthorizedStatus = 401;
const localToolAttemptsMax = 2;

/** A request under the person's current token, made again once on a 401. */
export function localToolRequest(signIn, request = chuggyRequest) {
  return async (task, _bearer, path, init = {}) => {
    const signal = chuggyToolSignal();
    for (let attempt = 1; ; attempt += 1) {
      const token = await signIn.token();
      const response = await request(task, token, path, { ...init, signal });
      if (
        response.status !== localToolUnauthorizedStatus ||
        attempt === localToolAttemptsMax
      )
        return response;
      signIn.invalidate(token);
      await response.body?.cancel?.();
    }
  };
}

/** The variable a script hands this server an access token in, as `gh` takes `GH_TOKEN`. */
export const localToolTokenVariable = "CHUGGY_TOKEN";

const localToolTokenRemedy = `make a new one in the project's Settings → Access tokens and set ${localToolTokenVariable} to it`;

/** What every call answers where `CHUGGY_TOKEN` holds something other than an access token, which is never sent. */
export const localToolTokenNotHeld = `${localToolTokenVariable} does not hold a chuggy access token, so nothing was sent: ${localToolTokenRemedy}.`;

/** What a call answers where the API refused the access token. */
export const localToolTokenRefused = `chuggy refused the access token in ${localToolTokenVariable}: it was deleted, it expired, or it belongs to another site. Tell the person to ${localToolTokenRemedy}.`;

/** What an answer under a token ends with where the call met a 404. */
export const localToolTokenNotFoundNote = `Under an access token a 404 may mean the token was made for another project, since it works only in its own; otherwise what was asked for is absent.`;

/** The most one note an answer under a token ends with may weigh. */
export const localToolTokenNoteBytesMax = 512;

const localToolTokenWarningMs = accessTokenWarningDays * 24 * 60 * 60 * 1_000;

/** What says the access token expires at `expiresAtMs`. */
export function localToolTokenExpiringNote(expiresAtMs) {
  return `The access token in ${localToolTokenVariable} expires at ${new Date(expiresAtMs).toISOString()}: before then, ${localToolTokenRemedy}.`;
}

/**
 * The access a set `value` of `CHUGGY_TOKEN` gives, or nothing where it is
 * unset or empty, which leaves the sign-in. `token` is absent where the value
 * is not an access token; `log` takes the one expiry line this process writes.
 *
 * @param {string | undefined} value
 * @param {{log: (line: string) => void, now?: () => number}} ports
 */
export function localToolTokenAccess(value, { log, now = Date.now }) {
  if (value === undefined || value === "") return undefined;
  return {
    token: accessTokenPattern.test(value) ? value : undefined,
    expiresAtMs: undefined,
    warned: false,
    calls: new AsyncLocalStorage(),
    log,
    now,
  };
}

/** A request under the access token, which never asks again and ends the call on a 401. */
export function localToolTokenRequest(access, request = chuggyRequest) {
  return async (task, _bearer, path, init = {}) => {
    if (access.token === undefined) throw new Error(localToolTokenNotHeld);
    const response = await request(task, access.token, path, {
      ...init,
      signal: chuggyToolSignal(),
    });
    const expiresAtMs = Date.parse(
      response.headers?.get(accessTokenExpiresHeader) ?? "",
    );
    if (Number.isFinite(expiresAtMs) && !(access.expiresAtMs >= expiresAtMs))
      access.expiresAtMs = expiresAtMs;
    const call = access.calls.getStore();
    if (response.status === 404 && call !== undefined) call.notFound = true;
    if (response.status !== localToolUnauthorizedStatus) return response;
    await response.body?.cancel?.();
    throw new Error(localToolTokenRefused);
  };
}

/**
 * `handler` under the access token: every call refused where there is no
 * token, and otherwise its answer ending with the notes it earned, each only
 * where the whole answer stays within `chuggyToolAnswerBytesMax`.
 */
export function localToolTokenHandler(access, handler) {
  if (access.token === undefined)
    return async () => ({
      content: [{ type: "text", text: localToolTokenNotHeld }],
      isError: true,
    });
  return async (args) => {
    const call = { notFound: false };
    const answer = await access.calls.run(call, () => handler(args));
    const notes = [];
    if (call.notFound) notes.push(localToolTokenNotFoundNote);
    const { expiresAtMs } = access;
    if (
      expiresAtMs !== undefined &&
      expiresAtMs - access.now() <= localToolTokenWarningMs
    ) {
      const expiring = localToolTokenExpiringNote(expiresAtMs);
      notes.push(expiring);
      if (!access.warned) access.log(expiring);
      access.warned = true;
    }
    return notes.reduce(localToolTokenNoted, answer);
  };
}

/** `answer` ending with `note`, where the note is within its bound and the whole within what one answer may weigh. */
function localToolTokenNoted(answer, note) {
  const content = answer.content ?? [];
  const text = [...content, { text: note }]
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
  return chuggyToolAnswerBytes(note) <= localToolTokenNoteBytesMax &&
    chuggyToolAnswerBytes(text) <= chuggyToolAnswerBytesMax
    ? { ...answer, content: [...content, { type: "text", text: note }] }
    : answer;
}

/**
 * The tools' context for one project: `site` is the origin the console and
 * its API are served at, and `tenant` and `project` are as its routes name
 * them.
 */
export function localToolContext({
  site,
  tenant,
  project,
  version,
  signIn,
  access,
  request = chuggyRequest,
}) {
  const context = chuggyToolContext(
    { tenant, project, api: { url: new URL(site).origin } },
    undefined,
    {
      capabilities: localToolCapabilities,
      version,
      request:
        access === undefined
          ? localToolRequest(signIn, request)
          : localToolTokenRequest(access, request),
      turn: () => randomUUID(),
    },
  );
  return { ...context, access };
}

/** The server, its instructions given, every tool registered and nothing connected. */
export function localToolServer(context, sdk) {
  const server = new sdk.McpServer(
    { name: chuggyToolServerName, version: context.version },
    { instructions: localToolInstructions(context.task, context.access) },
  );
  for (const definition of chuggyToolDefinitions(context)) {
    const handler = chuggyToolHandler(definition, sdk.z);
    server.registerTool(
      definition.name,
      {
        title: definition.annotations.title,
        description: definition.description.replace(
          chuggySubmissionRepeatDescription,
          localToolRepeatDescription,
        ),
        inputSchema: chuggyToolInput(definition, sdk.z),
        annotations: definition.annotations,
      },
      context.access === undefined
        ? handler
        : localToolTokenHandler(context.access, handler),
    );
  }
  return server;
}

/** The signals an MCP client ends a server with, each ending the serve as the end of its input does. */
export const localToolEndSignals = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Serves the tools on stdio until the transport closes, which the SDK's own
 * does on a read that fails and not on the end of its input, so the end of
 * `stdin`, or `ending` aborting, closes it too, and `told` is called the
 * first time either does. `serving` starts once the server is connected, and
 * the serve ends once both have.
 *
 * @param {() => Promise<void>} [serving]
 * @param {{ending?: AbortSignal, told?: () => void}} [end]
 */
export async function localToolServe(
  context,
  sdk,
  stdin = process.stdin,
  serving = async () => {},
  { ending, told = () => {} } = {},
) {
  const server = localToolServer(context, sdk);
  const closed = new Promise((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new sdk.StdioServerTransport());
  let telling = told;
  const ended = () => {
    telling();
    telling = () => {};
    void server.close();
  };
  stdin.once("end", ended);
  stdin.once("close", ended);
  ending?.addEventListener("abort", ended, { once: true });
  try {
    const [, served] = await Promise.allSettled([closed, serving()]);
    if (served.status === "rejected") throw served.reason;
  } finally {
    ending?.removeEventListener("abort", ended);
  }
}

/** The bound the read of a site's pins is sent under. */
export const localToolReleasesFetchMsMax = 15_000;

/** The most the answer of a site's pins is read to. */
export const localToolReleasesBytesMax = 65_536;

/**
 * The releases `site` pins, read with no credential.
 *
 * @param {string} site
 * @param {typeof globalThis.fetch} fetch
 */
async function localToolReleasesPinned(site, fetch) {
  const response = await fetch(
    new URL(workerRunnerReleasesPinnedRoute, new URL(site).origin),
    {
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(localToolReleasesFetchMsMax),
      headers: { accept: nativeHttpMediaType },
    },
  );
  const { text, cut } = await chuggyBoundedBody(
    response,
    localToolReleasesBytesMax,
  );
  if (response.status !== 200)
    throw new Error(`it answered ${String(response.status)}`);
  if (cut) throw new Error("it answered more than its answer is read to");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("it answered a body that is not JSON");
  }
  const parsed = workerRunnerReleasesPinnedSchema.safeParse(body);
  if (!parsed.success)
    throw new Error("it answered a body that is not the contract's");
  return parsed.data.releases;
}

/**
 * This copy's package updated to the release `site` pins for it, where the
 * pin is above this copy and `updates` is given and on. What happened is said
 * through `log`, and nothing is thrown.
 *
 * @param {string} site
 * @param {LocalToolUpdates | undefined} updates
 * @param {{fetch: typeof globalThis.fetch, log: (line: string) => void, updater?: RunnerUpdater}} ports `updater` where a suite stands in for the one `updates.settings` makes
 */
export async function localToolUpdated(site, updates, ports) {
  if (updates?.on !== true) return;
  let updater;
  try {
    updater =
      ports.updater ?? runnerUpdater(updates.settings, { fetch: ports.fetch });
  } catch (failure) {
    ports.log(`cannot update this copy: ${localToolFailure(failure)}`);
    return;
  }
  let releases;
  try {
    releases = await localToolReleasesPinned(site, ports.fetch);
  } catch (failure) {
    ports.log(
      `could not read the runner releases ${site} pins: ${localToolFailure(failure)}`,
    );
    return;
  }
  const { runner } = updater;
  const release = releases.find((pinned) => pinned.package === runner.package);
  if (
    release === undefined ||
    !runnerVersionAbove(release.version, runner.version)
  )
    return;
  const named = `${release.package} ${release.version}`;
  const updated = await updater.update(release);
  ports.log(
    updated.updated === "Failed"
      ? `did not update to ${named}: ${updated.reason}`
      : `${runner.package} ${updated.version} is installed, and this session serves ${runner.version} until the agent starts its next`,
  );
}

/** @param {unknown} failure */
function localToolFailure(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Why an ask for one project's tools cannot be served, or nothing: the site is
 * one this machine sends a credential to, and the workspace and project are
 * each named.
 */
export function localToolAskRefusal({ site, workspace, project }) {
  if (site === undefined || workspace === undefined || project === undefined)
    return "the tools need a site, a workspace and a project";
  let url;
  try {
    url = new URL(site);
  } catch {
    return `the site ${site} is not a URL`;
  }
  const refused = registerEndpointRefusal(url);
  if (refused !== undefined) return `the site ${refused}`;
  if (url.username !== "" || url.password !== "")
    return "the site must carry no credentials";
  if (workspace === "" || project === "")
    return "the workspace and the project must each be named";
  return undefined;
}

/** The file in `directory` an earlier copy kept one site's renewal token in. */
export function localToolSignInFile(directory, site) {
  return join(directory, encodeURIComponent(new URL(site).origin));
}

/**
 * One project's tools served on stdio under the access token `CHUGGY_TOKEN`
 * holds in `environment`, or else in this process's, or where it is unset or
 * empty under the person's sign-in in the contract's shared store, placed by
 * `surroundings` or else by this process's home and `XDG_CONFIG_HOME`, until
 * the agent closes stdio or `signals` gets one of `localToolEndSignals`, and
 * any update it started and any renewal it sent have ended. A sign-in an
 * earlier copy kept in `signIns` is moved into the store. The ask is `localToolAskRefusal`'s to check first; a `fetch` not
 * given is the global one, and `updates` not given installs nothing.
 *
 * @param {{site: string, workspace: string, project: string, version: string, signIns: string, environment?: Record<string, string | undefined>, surroundings?: import("@chuggy/worker-contract/signInStore").SignInStoreSurroundings, fetch?: typeof globalThis.fetch, updates?: LocalToolUpdates}} asked
 */
export async function localToolServed(
  asked,
  sdk,
  stdin = process.stdin,
  signals = process,
) {
  const { site, workspace, project, version, signIns, fetch, updates } = asked;
  const log = (line) => void process.stderr.write(`${line}\n`);
  const environment = asked.environment ?? process.env;
  const access = localToolTokenAccess(environment[localToolTokenVariable], {
    log,
  });
  const surroundings = asked.surroundings ?? {
    home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME,
  };
  const signIn =
    access === undefined
      ? localSignIn(
          site,
          localTokenStore({
            directory: signInStoreDirectory(surroundings),
            origin: new URL(site).origin,
            formerly: localToolSignInFile(signIns, site),
          }),
          { fetch },
        )
      : undefined;
  // Held until the close settles: with no listener, a signal's default
  // handling would end the process while a sent renewal is still unanswered.
  const ending = new globalThis.AbortController();
  const end = () => ending.abort();
  for (const signal of localToolEndSignals) signals.on(signal, end);
  try {
    await localToolServe(
      localToolContext({
        site,
        tenant: workspace,
        project,
        version,
        signIn,
        access,
      }),
      sdk,
      stdin,
      () =>
        localToolUpdated(site, updates, {
          fetch: fetch ?? globalThis.fetch,
          log,
        }),
      { ending: ending.signal, told: () => void signIn?.close() },
    );
  } finally {
    try {
      await signIn?.close();
    } finally {
      for (const signal of localToolEndSignals) signals.off(signal, end);
    }
  }
}
