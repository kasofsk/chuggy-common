/**
 * The `chuggy` tools served to a coding agent on a person's own machine, over
 * stdio, under that person's own sign-in (`./localSignIn.mjs`) rather than a
 * session bearer.
 *
 * THE TOOLS ARE THE POD'S, unchanged: `chuggyProjectTools`, their handler and
 * their bounds, for one site's one project. What differs is only what
 * `chuggyToolContext` is handed. The roster is every project tool and no
 * decision tool, since there is no lead here to decide for, and the API is the
 * control: it authorizes the person's token through their membership as it
 * does the console's.
 *
 * A CALL IS ITS OWN TURN. Nothing over stdio says which turn of a chat a call
 * belongs to, so each submitted command mints its operation from a turn of its
 * own. A command repeated is a second operation, and the API's fences on what
 * the command names are what refuse it, so the pod's description of a repeat
 * is replaced with that.
 *
 * A 401 IS ASKED ONCE MORE. It says the token was what was wrong, and nothing
 * it answered was applied, so the held token is dropped and the call is made
 * again under a renewed one; a second 401 is relayed.
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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { URL } from "node:url";

import {
  chuggyToolServerName,
  nativeHttpMediaType,
} from "@chuggy/worker-contract/sessionTools";
import {
  workerRunnerReleasesPinnedRoute,
  workerRunnerReleasesPinnedSchema,
} from "@chuggy/worker-contract/workerPool";

import { chuggyBoundedBody, chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggySubmissionRepeatDescription,
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
];

/** What a submitted command made again answers here, where every call is a turn of its own. */
export const localToolRepeatDescription = `The same call again is a new operation, submitted again: where the first already landed, the API refuses the second for what it names, so read_operation the first's id to learn what it did before calling again.`;

/** What the server tells an agent before it lists the tools, `task` naming the workspace and project it is bound to. */
export function localToolInstructions(task) {
  return `This server is bound to the workspace ${task.tenant} and its project ${task.project}.
These tools are the only way to read or act on chuggy from here, and every one but read_docs needs the person signed in. When a call answers that they are not, give them the address it names, in full, in your next message, whatever else you are doing, and call again once they say they have signed in. Nothing else stands in for what these tools answer, so do not work around a sign-in.
The chuggy docs are behind read_docs: call it with no page for the index first, then with a page the index lists.
To file a ticket:
1. read_abilities: who you act as, which a ticket's \`creator\` names, and what you may do.
2. list_repositories: a repository that is configured and \`fileable\`.
3. list_configurations: a revision whose \`repository\` is that repository, or, where its list_repositories row's \`configurationsHeld.result\` is Bootstrapped, the \`configurationsHeld.revision\` that row carries.
4. initialize_draft on that revision: the fence and the defaults.
5. create_draft: the minimum brief, and \`authoring\` from the defaults.
6. read_draft: the draft as filed.
7. release_draft.
8. read_operation: every command is submitted, and this is how its outcome is read.
Releasing starts nothing: once its dependencies are Done the ticket waits Pending until it is dispatched, by the project's lead unless read_lead answers a lead standing \`paused\` or no lead for a reason other than \`NotNeeded\` or \`AwaitingSelector\`, and there by dispatch_ticket on the word of the person you act for, or by another person who may dispatch.
To change the lead's prompt: read_docs the page "Writing a project's lead prompt", then read_lead_settings and update_lead_settings.
To move the lead onto the subsidized lead: read_docs the page "The subsidized lead", then update_placement.`;
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
  request = chuggyRequest,
}) {
  return chuggyToolContext(
    { tenant, project, api: { url: new URL(site).origin } },
    undefined,
    {
      capabilities: localToolCapabilities,
      version,
      request: localToolRequest(signIn, request),
      turn: () => randomUUID(),
    },
  );
}

/** The server, its instructions given, every tool registered and nothing connected. */
export function localToolServer(context, sdk) {
  const server = new sdk.McpServer(
    { name: chuggyToolServerName, version: context.version },
    { instructions: localToolInstructions(context.task) },
  );
  for (const definition of chuggyToolDefinitions(context))
    server.registerTool(
      definition.name,
      {
        description: definition.description.replace(
          chuggySubmissionRepeatDescription,
          localToolRepeatDescription,
        ),
        inputSchema: chuggyToolInput(definition, sdk.z),
      },
      chuggyToolHandler(definition, sdk.z),
    );
  return server;
}

/**
 * Serves the tools on stdio until the transport closes, which the SDK's own
 * does on a read that fails and not on the end of its input, so the end of
 * `stdin` closes it too. `serving` starts once the server is connected, and
 * the serve ends once both have.
 *
 * @param {() => Promise<void>} [serving]
 */
export async function localToolServe(
  context,
  sdk,
  stdin = process.stdin,
  serving = async () => {},
) {
  const server = localToolServer(context, sdk);
  const closed = new Promise((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new sdk.StdioServerTransport());
  const ended = () => void server.close();
  stdin.once("end", ended);
  stdin.once("close", ended);
  const [, served] = await Promise.allSettled([closed, serving()]);
  if (served.status === "rejected") throw served.reason;
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

/** The file in `directory` one site's renewal token is kept in. */
export function localToolSignInFile(directory, site) {
  return join(directory, encodeURIComponent(new URL(site).origin));
}

/**
 * One project's tools served on stdio under the sign-in kept in `signIns`,
 * until the agent closes stdio and any update it started has ended. The ask is
 * `localToolAskRefusal`'s to check first; a `fetch` not given is the global
 * one, and `updates` not given installs nothing.
 *
 * @param {{site: string, workspace: string, project: string, version: string, signIns: string, fetch?: typeof globalThis.fetch, updates?: LocalToolUpdates}} asked
 */
export async function localToolServed(asked, sdk, stdin = process.stdin) {
  const { site, workspace, project, version, signIns, fetch, updates } = asked;
  const signIn = localSignIn(
    site,
    localTokenStore(localToolSignInFile(signIns, site)),
    { fetch },
  );
  try {
    await localToolServe(
      localToolContext({ site, tenant: workspace, project, version, signIn }),
      sdk,
      stdin,
      () =>
        localToolUpdated(site, updates, {
          fetch: fetch ?? globalThis.fetch,
          log: (line) => void process.stderr.write(`${line}\n`),
        }),
    );
  } finally {
    signIn.close();
  }
}
