/**
 * Every chuggy tool as an MCP client lists it: a description that opens with
 * one short sentence, and a description on every parameter and on every field
 * of one that is an object. Both servers are listed through the MCP SDK's own
 * client, so what is held is the JSON schema the SDK publishes and not the zod
 * shape it is converted from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  allChuggyTools,
  briefIntentCharsMax,
} from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import {
  chuggyProjectTools,
  chuggyToolContext,
  chuggyToolServer,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { localToolContext, localToolServer } from "./localTools.mjs";

/** The longest a description's opening sentence may be, which is what an agent reads a tool list by. */
const toolDescriptionOpeningCharsMax = 160;

/** A client connected to a server. */
async function connected(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "toolDescriptions", version: "1" });
  await client.connect(clientSide);
  return client;
}

/** The tools a connected server lists, as a client is answered them. */
async function listed(server) {
  const client = await connected(server);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** A request that records what it was asked and answers every one alike. */
function recorded() {
  const calls = [];
  return {
    calls,
    request: async (...asked) => {
      calls.push(asked);
      return { status: 201, text: async () => "{}" };
    },
  };
}

/**
 * The pod's server over every capability. The agent SDK's
 * `createSdkMcpServer` registers each of its `tool`s on an `McpServer`, and
 * this does the same, since the agent SDK is not this repository's to carry.
 */
function podServer(request) {
  return chuggyToolServer(
    chuggyToolContext({ tenant: "t", project: "p" }, "bearer", {
      capabilities: Object.keys(sessionCapabilityTools),
      staging: leadDecisionStaging(),
      ...(request === undefined ? {} : { request }),
    }),
    {
      z,
      tool: (name, description, inputSchema, handler) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
      createSdkMcpServer: ({ name, version, tools }) => {
        const server = new McpServer({ name, version });
        for (const { name: tool, handler, ...config } of tools)
          server.registerTool(tool, config, handler);
        return server;
      },
    },
  );
}

function localServer(request) {
  return localToolServer(
    localToolContext({
      site: "https://chuggy.example",
      tenant: "t",
      project: "p",
      version: "1",
      signIn: { token: async () => "token", invalidate() {} },
      ...(request === undefined ? {} : { request }),
    }),
    { McpServer, z },
  );
}

/** What a listed tool is found wanting in, nothing where it is in shape. */
function toolDescriptionFaults({ name, description, inputSchema }) {
  const faults = [];
  const [opening] = /^.*?\.(?=\s|$)/su.exec(description ?? "") ?? [];
  if (opening === undefined) faults.push(`${name} opens with no sentence`);
  else if (opening.length > toolDescriptionOpeningCharsMax)
    faults.push(
      `${name} opens with ${String(opening.length)} characters: ${opening}`,
    );
  for (const [parameter, schema] of Object.entries(
    inputSchema.properties ?? {},
  )) {
    if (typeof schema.description !== "string" || schema.description === "")
      faults.push(`${name}.${parameter} has no description`);
    for (const [field, held] of Object.entries(schema.properties ?? {}))
      if (typeof held.description !== "string" || held.description === "")
        faults.push(`${name}.${parameter}.${field} has no description`);
  }
  return faults;
}

for (const [server, built, roster] of [
  ["the pod's server", podServer, allChuggyTools],
  ["the local server", localServer, chuggyProjectTools.map(({ name }) => name)],
])
  test(`${server} lists every tool opening with a short sentence and every parameter described`, async () => {
    const tools = await listed(built());

    assert.deepEqual(tools.map(({ name }) => name).sort(), [...roster].sort());
    assert.deepEqual(tools.flatMap(toolDescriptionFaults), []);
  });

test("a tool listed with an undescribed parameter or a long opening is found wanting", async () => {
  const server = new McpServer({ name: "wanting", version: "1" });
  server.registerTool(
    "undescribed",
    { description: "Short.", inputSchema: { ticket: z.number() } },
    () => ({ content: [] }),
  );
  server.registerTool(
    "long",
    {
      description: `${"a".repeat(toolDescriptionOpeningCharsMax)}. Then more.`,
      inputSchema: { ticket: z.number().describe("A ticket.") },
    },
    () => ({ content: [] }),
  );
  server.registerTool("none", { description: "" }, () => ({ content: [] }));
  server.registerTool(
    "nested",
    {
      description: "Short.",
      inputSchema: {
        brief: z.object({ intent: z.string() }).describe("A brief."),
      },
    },
    () => ({ content: [] }),
  );

  const faults = (await listed(server)).flatMap(toolDescriptionFaults);

  assert.equal(faults.length, 4);
  assert.match(faults[0], /^undescribed\.ticket has no description$/u);
  assert.ok(
    faults[1].startsWith(
      `long opens with ${String(toolDescriptionOpeningCharsMax + 1)} characters`,
    ),
  );
  assert.match(faults[2], /^none opens with no sentence$/u);
  assert.match(faults[3], /^nested\.brief\.intent has no description$/u);
});

/** The draft writes whose `brief`, `authoring` and `selection` are the contract's shapes. */
const draftWrites = ["create_draft", "revise_draft"];

/** One listed tool's published input schema. */
function published(tools, name) {
  const tool = tools.find((held) => held.name === name);
  assert.ok(tool !== undefined, `${name} is not listed`);
  return tool.inputSchema;
}

test("create_draft publishes the contract's brief and authoring, each field described", async () => {
  const { brief, authoring } = published(
    await listed(podServer()),
    "create_draft",
  ).properties;

  assert.ok(brief.required.includes("intent"));
  for (const field of [
    "title",
    "links",
    "repository",
    "branch",
    "finalization",
  ])
    assert.notEqual(brief.properties[field]?.description ?? "", "", field);
  assert.equal(brief.properties.intent.maxLength, briefIntentCharsMax);
  assert.equal(brief.additionalProperties, false);
  for (const field of ["program", "dependencies"])
    assert.notEqual(authoring.properties[field]?.description ?? "", "", field);
});

/**
 * The pod's server and the local server each hand the tools their own `z`,
 * and a draft write's shapes are the contract's, so the two publish one schema
 * only where the instances are one.
 */
test("the pod's server and the local server publish one schema for each draft write", async () => {
  const [pod, local] = await Promise.all([
    listed(podServer()),
    listed(localServer()),
  ]);

  for (const name of draftWrites)
    assert.deepEqual(published(pod, name), published(local, name), name);
});

/** The server would refuse the same brief; the tool refuses it first, and asks nothing. */
for (const [server, built] of [
  ["the pod's server", podServer],
  ["the local server", localServer],
])
  test(`${server} refuses a create_draft whose intent is longer than the contract's bound before any request`, async () => {
    const { calls, request } = recorded();
    const client = await connected(built(request));
    const origination = {
      configurationRevision: "r1",
      configurationDigest: "d1",
      expectedProjectSequence: 1,
      authoring: { dependencies: [], program: [] },
    };

    const refused = await client.callTool({
      name: "create_draft",
      arguments: {
        ...origination,
        brief: { intent: "i".repeat(briefIntentCharsMax + 1), links: [] },
      },
    });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, 0);

    const asked = await client.callTool({
      name: "create_draft",
      arguments: {
        ...origination,
        brief: { intent: "i".repeat(briefIntentCharsMax), links: [] },
      },
    });
    await client.close();
    assert.equal(asked.isError, undefined);
    assert.equal(calls.length, 1);
  });
