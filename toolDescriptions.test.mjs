/**
 * Every chuggy tool as an MCP client lists it: a description that opens with
 * one short sentence, a description on every parameter and on every field of
 * one that is an object, and the annotations a directory requires of it. Both servers are listed through the MCP SDK's own
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
  chuggyToolsUnbuilt,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import {
  jobHost,
  jobHostToolNames,
  jobHostWakeRefusalsStanding,
} from "./jobHost.mjs";
import { hostedToolContext, hostedToolServer } from "./hostedTools.mjs";
import { localToolContext, localToolServer } from "./localTools.mjs";
import { sessionTicketWakesDefinitions } from "./sessionTicketWakes.mjs";

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
function podServer(request, held) {
  return chuggyToolServer(
    chuggyToolContext({ tenant: "t", project: "p" }, "bearer", {
      capabilities: Object.keys(sessionCapabilityTools),
      ...(request === undefined ? {} : { request }),
      ...(held === undefined ? {} : { own: held }),
    }),
    {
      z,
      tool: (name, description, inputSchema, handler, extras) => ({
        name,
        description,
        inputSchema,
        handler,
        annotations: extras?.annotations,
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

function hostedServer() {
  return hostedToolServer(
    hostedToolContext({
      site: "https://chuggy.example",
      api: "https://chuggy.example",
      version: "1",
      bearer: "bearer",
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

/** What a listed tool's annotations are found wanting in, nothing where it carries every one a directory requires. */
function toolAnnotationFaults({ name, annotations }) {
  const faults = [];
  if (typeof annotations?.title !== "string" || annotations.title === "")
    faults.push(`${name} has no title`);
  for (const hint of ["readOnlyHint", "openWorldHint"])
    if (typeof annotations?.[hint] !== "boolean")
      faults.push(`${name} has no ${hint}`);
  if (
    annotations?.readOnlyHint === false &&
    typeof annotations.destructiveHint !== "boolean"
  )
    faults.push(`${name} changes something and has no destructiveHint`);
  return faults;
}

/** The pod's server for a chat host's thread, which holds its own tools too: a job host's and `ticket_wakes`. */
function podServerJobs() {
  return podServer(undefined, [
    ...jobHost({
      directory: "/sessions/threads/thread",
      environment: {},
      wake: () => undefined,
      standing: async () => undefined,
      warn: () => undefined,
    }).definitions,
    ...sessionTicketWakesDefinitions({
      task: {},
      bearer: "bearer",
      request: async () => undefined,
    }),
  ]);
}

for (const [server, built, roster] of [
  [
    "the pod's server",
    podServer,
    allChuggyTools.filter((tool) => !chuggyToolsUnbuilt.includes(tool)),
  ],
  [
    "a chat host's thread's server",
    podServerJobs,
    [
      ...allChuggyTools.filter((tool) => !chuggyToolsUnbuilt.includes(tool)),
      ...Object.values(jobHostToolNames),
      "ticket_wakes",
    ],
  ],
  ["the local server", localServer, chuggyProjectTools.map(({ name }) => name)],
  [
    "the hosted server",
    hostedServer,
    [
      "list_projects",
      ...chuggyProjectTools
        .map(({ name }) => name)
        .filter((name) => name !== "fetch_image"),
    ],
  ],
])
  test(`${server} lists every tool opening with a short sentence, every parameter described and its annotations given`, async () => {
    const tools = await listed(built());

    assert.deepEqual(tools.map(({ name }) => name).sort(), [...roster].sort());
    assert.deepEqual(tools.flatMap(toolDescriptionFaults), []);
    assert.deepEqual(tools.flatMap(toolAnnotationFaults), []);
  });

test("the pod's server and the local server list each tool both serve with one set of annotations", async () => {
  const [pod, local] = await Promise.all([
    listed(podServer()),
    listed(localServer()),
  ]);

  for (const { name, annotations } of local)
    assert.deepEqual(
      pod.find((tool) => tool.name === name).annotations,
      annotations,
      name,
    );
});

test("the hosted server lists each tool it shares with the local server with the local server's annotations and title", async () => {
  const [local, hosted] = await Promise.all([
    listed(localServer()),
    listed(hostedServer()),
  ]);

  for (const { name, title, annotations } of hosted) {
    assert.equal(title, annotations.title, name);
    const served = local.find((tool) => tool.name === name);
    if (served !== undefined)
      assert.deepEqual(served.annotations, annotations, name);
  }
});

test("the local server lists each tool's title as its own as well as among its annotations", async () => {
  for (const { name, title, annotations } of await listed(localServer()))
    assert.equal(title, annotations.title, name);
});

test("only read_docs, which reads GitHub, and job_start, which runs any command, are open-world", async () => {
  const tools = await listed(podServerJobs());

  assert.deepEqual(
    tools
      .filter(({ annotations }) => annotations.openWorldHint)
      .map(({ name }) => name)
      .sort(),
    ["job_start", "read_docs"],
  );
});

test("a tool listed without a title or a hint a directory requires is found wanting", async () => {
  const server = new McpServer({ name: "wanting", version: "1" });
  server.registerTool("bare", { description: "Short." }, () => ({
    content: [],
  }));
  server.registerTool(
    "undestructive",
    {
      description: "Short.",
      annotations: {
        title: "Undestructive",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    () => ({ content: [] }),
  );
  server.registerTool(
    "read",
    {
      description: "Short.",
      annotations: { title: "Read", readOnlyHint: true, openWorldHint: false },
    },
    () => ({ content: [] }),
  );

  assert.deepEqual((await listed(server)).flatMap(toolAnnotationFaults), [
    "bare has no title",
    "bare has no readOnlyHint",
    "bare has no openWorldHint",
    "undestructive changes something and has no destructiveHint",
  ]);
});

test("a job host's list tools say what lastWake answers, and the tools that set a wake what wakesRefused does", async () => {
  const tools = await listed(podServerJobs());
  const said = (name) => tools.find((tool) => tool.name === name).description;
  const { jobList, watchList, wakeList, jobStart, watch, wakeAt } =
    jobHostToolNames;

  for (const name of [jobList, watchList, wakeList])
    for (const field of [
      "`lastWake`",
      "Delivered",
      "Refused",
      "`refusal`",
      "`status`",
      "PostsFailed",
      "QueueFull",
    ])
      assert.ok(said(name).includes(field), `${name} names ${field}`);
  assert.ok(said(wakeList).includes("that fired"));
  for (const name of [jobStart, watch, wakeAt]) {
    assert.ok(said(name).includes("`wakesRefused`"), name);
    for (const refusal of jobHostWakeRefusalsStanding)
      assert.ok(said(name).includes(refusal), `${name} names ${refusal}`);
  }
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
