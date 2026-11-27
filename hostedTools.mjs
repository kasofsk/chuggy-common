/**
 * The `chuggy` tools served for one HTTP request, under the bearer that
 * request carried, bound to no workspace and no project. The host verified the
 * bearer and connects the transport; this module names `McpServer` and `z`
 * and imports neither, nor any HTTP server.
 *
 * THE ROSTER IS A PERSON'S OWN AGENT'S, `localToolCapabilities`, rebound.
 * Each tool that reaches a project takes `workspace` and `project` ahead of
 * its own arguments, and its call reaches that project's routes alone. A tool
 * a project-less session holds too (`MemberRead`) or that acts on its caller's
 * account (`AgentAccounts`) names no project, so it is served as it is.
 * `list_projects` is `chuggyInventoryTool`, which says what those two take.
 * `fetch_image` is withheld: it answers a file on this machine, which a
 * remote client cannot open.
 *
 * A CALL IS ITS OWN TURN, as it is over stdio, and a repeat is described as
 * `./localTools.mjs` describes it.
 *
 * A 401 ENDS THE CALL. The host refuses an expired bearer before any tool
 * runs, so the same bearer asked again gets the same answer.
 */

import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import {
  chuggyToolCapabilities,
  chuggyToolServerName,
} from "@chuggy/worker-contract/sessionTools";

import { chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggyInventoryTool,
  chuggyProjectTools,
  chuggySubmissionRepeatDescription,
  chuggyToolContext,
  chuggyToolPartition,
  chuggyToolHandler,
  chuggyToolInput,
  chuggyToolSignal,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import {
  localToolCapabilities,
  localToolRepeatDescription,
} from "./localTools.mjs";

/** What a call answers where the API refused the bearer it was made under. */
export const hostedToolSignInRefused = `chuggy refused this connection's sign-in, so nothing was done. Tell the person to reconnect chuggy in Claude, then call again.`;

/** The tools served here that reach no project, so take no `workspace` and `project`. */
const hostedToolsUnbound = new Set([
  ...chuggyToolCapabilities.MemberRead,
  ...chuggyToolCapabilities.AgentAccounts,
]);

/** The tools of the roster a remote client is not served. */
const hostedToolsWithheld = new Set(["fetch_image"]);

/** What the server tells an agent before it lists the tools. */
export function hostedToolInstructions() {
  return `This server is bound to no workspace and no project. Call list_projects first: each project it lists names its workspace as \`tenant\` and itself as \`project\`, and every tool that takes \`workspace\` and \`project\` must be passed both.
These tools are the only way to read or act on chuggy from here, and they act as the person who connected chuggy, in the projects list_projects answers. When a call answers that chuggy refused this connection's sign-in, pass that on to the person, in full, in your next message, whatever else you are doing. Nothing else stands in for what these tools answer, so do not work around a refused sign-in.
The chuggy docs are behind read_docs: call it with no page for the index first, then with a page the index lists.
To file a ticket, passing every call the \`workspace\` and \`project\` list_projects named:
1. read_abilities: who you act as, which a ticket's \`creator\` names, and what you may do.
2. list_repositories: a repository that is configured and \`fileable\`.
3. list_configurations: a revision whose \`repository\` is that repository, or, where its list_repositories row's \`configurationsHeld.result\` is Bootstrapped, the \`configurationsHeld.revision\` that row carries.
4. initialize_draft on that revision: the fence and the defaults.
5. create_draft: the minimum brief, and \`authoring\` from the defaults.
6. read_draft: the draft as filed.
7. release_draft.
8. read_operation: every command is submitted, and this is how its outcome is read.
Releasing starts nothing: once its dependencies are Done the ticket waits Pending until a person who may dispatch dispatches it: by dispatch_ticket on the word of the person you act for, or by another person who may dispatch.
To change a project's thread settings: read_docs the page "A project's thread settings", then read_lead_settings and update_lead_settings.
To merge a ticket's pull request: read_ticket_landings, ask the person whether they want chuggy to merge it, then merge_pull_request.`;
}

/** A request under the bearer, which never asks again and ends the call on a 401. */
export function hostedToolRequest(request = chuggyRequest) {
  return async (task, bearer, path, init = {}) => {
    const response = await request(task, bearer, path, {
      ...init,
      signal: chuggyToolSignal(),
    });
    if (response.status !== 401) return response;
    await response.body?.cancel?.();
    throw new Error(hostedToolSignInRefused);
  };
}

/**
 * The tools' context for one request: `site` is the origin the console is
 * served at, `api` the base URL its API is reached at, which may differ from
 * it, and `bearer` the person's own, which the host verified.
 */
export function hostedToolContext({
  site,
  api,
  version,
  bearer,
  request = chuggyRequest,
}) {
  const context = chuggyToolContext(
    { api: { url: new URL(api).origin } },
    bearer,
    { version, request: hostedToolRequest(request), turn: () => randomUUID() },
  );
  return { ...context, site: new URL(site).origin };
}

/** `definition` taking the project it reaches as its first two arguments, and reaching that project alone. */
function hostedToolBound(context, definition) {
  return {
    ...definition,
    shape: (z) => ({
      workspace: chuggyToolPartition(z).describe(
        "The workspace the project is in, as list_projects answers its `tenant`.",
      ),
      project: chuggyToolPartition(z).describe(
        "The project, as list_projects answers its `project`.",
      ),
      ...definition.shape(z),
    }),
    call: ({ workspace, project, ...args }) =>
      definition.call(
        { ...context, task: { ...context.task, tenant: workspace, project } },
        args,
      ),
  };
}

/** Every tool one request is served, each bound to `context`. */
export function hostedToolDefinitions(context) {
  const admitted = new Set(
    localToolCapabilities.flatMap((held) => sessionCapabilityTools[held]),
  );
  const served = chuggyProjectTools.filter(
    ({ name }) => admitted.has(name) && !hostedToolsWithheld.has(name),
  );
  return [chuggyInventoryTool, ...served].map((definition) =>
    definition === chuggyInventoryTool ||
    hostedToolsUnbound.has(definition.name)
      ? { ...definition, call: (args) => definition.call(context, args) }
      : hostedToolBound(context, definition),
  );
}

/** The server for one request, its instructions given, every tool registered and nothing connected. */
export function hostedToolServer(context, sdk) {
  const server = new sdk.McpServer(
    {
      name: chuggyToolServerName,
      version: context.version,
      websiteUrl: context.site,
    },
    { instructions: hostedToolInstructions() },
  );
  for (const definition of hostedToolDefinitions(context))
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
      chuggyToolHandler(definition, sdk.z),
    );
  return server;
}
