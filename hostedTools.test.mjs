/**
 * The tools one hosted request is served, driven through the MCP SDK's own
 * client over its in-memory transport, as a remote client reaches them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chuggyToolCapabilities } from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import { chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggyProjectTools,
  chuggySubmissionRepeatDescription,
} from "./chuggyTools.mjs";
import {
  hostedToolContext,
  hostedToolServer,
  hostedToolSignInRefused,
} from "./hostedTools.mjs";
import { localToolRepeatDescription } from "./localTools.mjs";

const bearer = "person-bearer";

/** A hosted server whose requests reach `fetch` through the API client, and a client connected to it. */
async function hosted(fetch) {
  const server = hostedToolServer(
    hostedToolContext({
      site: "https://chuggy.example/console",
      api: "http://api.internal:8080",
      version: "7",
      bearer,
      request: (task, held, path, init) =>
        chuggyRequest(task, held, path, init, { fetch, wait: async () => {} }),
    }),
    { McpServer, z },
  );
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "hostedTools", version: "1" });
  await client.connect(clientSide);
  return client;
}

/** A fetch that records every request and answers each with `status` and `body`. */
function recorded(status = 200, body = "{}") {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url: new URL(url), init });
      return new globalThis.Response(body, { status });
    },
  };
}

/** The text a call answered. */
function said(answer) {
  return answer.content.map(({ text }) => text).join("");
}

test("a project tool reaches only the project its workspace and project name, under exactly the bearer given", async () => {
  const { requests, fetch } = recorded();
  const client = await hosted(fetch);

  const answer = await client.callTool({
    name: "list_tickets",
    arguments: { workspace: "w-1", project: "p-1", limit: 5 },
  });
  await client.close();

  assert.equal(answer.isError, undefined, said(answer));
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url.origin, "http://api.internal:8080");
  assert.equal(url.pathname, "/api/v1/tenants/w-1/projects/p-1");
  assert.equal(init.headers.authorization, `Bearer ${bearer}`);
});

test("a project tool called without its workspace or its project, or naming one a URL resolves away, is refused and sends nothing", async () => {
  const { requests, fetch } = recorded();
  const client = await hosted(fetch);

  for (const named of [
    { project: "p-1" },
    { workspace: "w-1" },
    { workspace: "..", project: "p-1" },
    { workspace: "w-1", project: "." },
  ]) {
    const answer = await client.callTool({
      name: "list_tickets",
      arguments: named,
    });
    assert.equal(answer.isError, true, JSON.stringify(named));
  }
  await client.close();

  assert.deepEqual(requests, []);
});

test("list_projects reads the project inventory, its cursor carried, and answers the route's body verbatim", async () => {
  const page = `{"projects":[{"tenant":"w-1","project":"p-1","name":"One"}],"nextCursor":"c-2"}`;
  const { requests, fetch } = recorded(200, page);
  const client = await hosted(fetch);

  const answer = await client.callTool({
    name: "list_projects",
    arguments: { cursor: "c-1", limit: 2 },
  });
  await client.close();

  assert.equal(said(answer), `HTTP 200\n${page}`);
  assert.equal(requests.length, 1);
  const [{ url }] = requests;
  assert.equal(url.pathname, "/api/v1/projects");
  assert.equal(url.searchParams.get("cursor"), "c-1");
  assert.equal(url.searchParams.get("limit"), "2");
});

test("a 401 ends the call, asked once, saying the person reconnects chuggy in Claude", async () => {
  const { requests, fetch } = recorded(401);
  const client = await hosted(fetch);

  const answer = await client.callTool({
    name: "list_tickets",
    arguments: { workspace: "w-1", project: "p-1" },
  });
  await client.close();

  assert.equal(answer.isError, true);
  assert.equal(said(answer), hostedToolSignInRefused);
  assert.equal(requests.length, 1);
});

test("the roster is the local one less fetch_image, list_projects the inventory's, and only the tools that reach a project take one", async () => {
  const client = await hosted(recorded().fetch);
  const { tools } = await client.listTools();
  await client.close();
  const unbound = new Set([
    "list_projects",
    ...chuggyToolCapabilities.MemberRead,
    ...chuggyToolCapabilities.AgentAccounts,
  ]);

  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "list_projects",
      ...chuggyProjectTools
        .map(({ name }) => name)
        .filter((name) => name !== "fetch_image"),
    ].sort(),
  );
  assert.ok(!tools.some(({ name }) => name === "navigate"));
  for (const { name, inputSchema } of tools) {
    const [first, second] = Object.keys(inputSchema.properties ?? {});
    const bound = !unbound.has(name);
    assert.equal(first === "workspace" && second === "project", bound, name);
    if (bound)
      assert.deepEqual(
        inputSchema.required?.slice(0, 2),
        ["workspace", "project"],
        name,
      );
  }
  assert.ok(
    !Object.hasOwn(
      tools.find(({ name }) => name === "list_projects").inputSchema.properties,
      "after",
    ),
    "list_projects is the member's, which pages by after",
  );
});

test("a repeated submission is described as a new operation, and the server names the site and no workspace", async () => {
  const client = await hosted(recorded().fetch);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  const server = client.getServerVersion();
  await client.close();
  const release = tools.find(({ name }) => name === "release_draft");

  assert.ok(release.description.includes(localToolRepeatDescription));
  assert.ok(!release.description.includes(chuggySubmissionRepeatDescription));
  assert.equal(server.websiteUrl, "https://chuggy.example");
  assert.equal(server.version, "7");
  assert.match(instructions, /bound to no workspace and no project/u);
  assert.match(instructions, /Call list_projects first/u);
  assert.match(instructions, /`workspace` and `project`/u);
  assert.doesNotMatch(instructions, /sign in|address|w-1/iu);
});
