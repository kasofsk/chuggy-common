/**
 * The build's verdict on a session on its own prompt: that the installed
 * runtime, run under the options `sessionQueryOptions` gives it, reads its
 * checkout and nothing else, and loads nothing of the checkout's settings.
 *
 * IT DRIVES THE RUNTIME, NOT THE OPTIONS. Whether `"dontAsk"`, `tools` and an
 * empty `settingSources` confine the file tools is the runtime's behaviour, so
 * the runtime is run, against a Messages endpoint on 127.0.0.1 that
 * `ANTHROPIC_BASE_URL` names, which asks for each call below and keeps each
 * answer. A build with no network runs it as it is.
 *
 * WHAT IS REFUSED: a Read of a credential outside the checkout, of `../` out
 * of it, of a symlink in it pointing out, of `/proc/self/root/…` and of
 * `/proc/self/environ`; a Grep or Glob rooted at `/` finding the credential, and
 * a Grep of `/proc` finding the environment. WHAT RUNS: a Read inside the
 * checkout and a chuggy tool. The runtime is listed no built-in beyond the
 * ones the capabilities grant, and a hook in the checkout's
 * `.claude/settings.json` does not run, where it does for a session without
 * the fact. The lead is asked again resumed from its store, and once more in
 * an inquiry forked from it.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import { chuggyToolServerName } from "@chuggy/worker-contract/sessionTools";
import { workerWorkspaceVariable } from "@chuggy/worker-contract/workerEnvironment";

import { sessionQueryOptions, sessionSdk } from "./session.mjs";

/** How long one session is given to finish before the probe fails it. */
const confinementProbeSessionMsMax = 120_000;

/** What the probe's chuggy tool answers, which a session that ran it holds. */
const confinementProbeMcpAnswer = "the chuggy tool ran";

const sdk = await sessionSdk();
const root = await mkdtemp(join(tmpdir(), "chuggy-confinement-"));
try {
  const world = await confinementProbeWorld(root);
  const endpoint = await confinementProbeEndpoint();
  try {
    const store = confinementProbeStore();
    const lead = await confinementProbeSession(world, endpoint, store, {
      facts: { kind: "Lead", capabilities: ["RepositoryRead", "ProjectRead"] },
    });
    confinementProbeConfined(world, lead, "the lead");
    const resumed = await confinementProbeSession(world, endpoint, store, {
      facts: {
        kind: "Lead",
        capabilities: ["RepositoryRead", "ProjectRead"],
        agentReference: lead.session,
      },
    });
    confinementProbeConfined(world, resumed, "the resumed lead");
    if (resumed.session !== lead.session)
      throw new Error("the resumed lead did not resume its own session");
    const inquiry = await confinementProbeSession(world, endpoint, store, {
      facts: {
        kind: "Inquiry",
        capabilities: ["RepositoryRead", "ProjectRead"],
        forkFrom: lead.session,
      },
    });
    confinementProbeConfined(world, inquiry, "the inquiry");
    if (existsSync(world.hookMarker))
      throw new Error(
        "a hook in the checkout ran in a session on its own prompt",
      );
    await confinementProbeSession(world, endpoint, confinementProbeStore(), {
      facts: { kind: "Lead", capabilities: ["RepositoryRead", "ProjectRead"] },
      own: false,
    });
    if (!existsSync(world.hookMarker))
      throw new Error(
        "the checkout's hook did not run without the fact either, so its absence proves nothing",
      );
  } finally {
    endpoint.server.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(
  "a session on its own prompt reads its checkout and nothing else, resumed and forked, and runs none of its settings\n",
);

/** A workspace holding a checkout, a credential outside it, and a hook inside it. */
async function confinementProbeWorld(directory) {
  const workspace = join(directory, "workspace");
  const checkout = join(workspace, "repository");
  const mount = join(directory, "credentials");
  const credential = join(mount, `slot-${randomBytes(6).toString("hex")}`);
  const hookMarker = join(directory, "hook-ran");
  const world = {
    workspace,
    checkout,
    credential,
    hookMarker,
    secret: `chuggysecret${randomBytes(12).toString("hex")}`,
    inside: `chuggyinside${randomBytes(12).toString("hex")}`,
    environ: `chuggyenviron${randomBytes(12).toString("hex")}`,
  };
  await mkdir(join(checkout, ".claude"), { recursive: true });
  await mkdir(mount, { recursive: true });
  await writeFile(credential, `${world.secret}\n`);
  await writeFile(join(workspace, "beside.txt"), `${world.secret}\n`);
  await writeFile(join(checkout, "inside.txt"), `${world.inside}\n`);
  await symlink(credential, join(checkout, "pointing-out"));
  const hook = [
    { hooks: [{ type: "command", command: `touch ${hookMarker}` }] },
  ];
  await writeFile(
    join(checkout, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: hook,
        UserPromptSubmit: hook,
        PreToolUse: [{ matcher: "*", ...hook[0] }],
      },
    }),
  );
  return world;
}

/** The calls each confined session is asked to make, by the name its answer is kept under. */
function confinementProbeCalls(world, mcpTool) {
  return {
    credential: ["Read", { file_path: world.credential }],
    parent: ["Read", { file_path: join(world.checkout, "..", "beside.txt") }],
    symlink: ["Read", { file_path: join(world.checkout, "pointing-out") }],
    root: ["Read", { file_path: `/proc/self/root${world.credential}` }],
    environ: ["Read", { file_path: "/proc/self/environ" }],
    grepRoot: [
      "Grep",
      { pattern: "chuggysecret[0-9a-f]+", path: "/", output_mode: "content" },
    ],
    grepProc: [
      "Grep",
      {
        pattern: "chuggyenviron[0-9a-f]+",
        path: "/proc",
        output_mode: "content",
      },
    ],
    globRoot: ["Glob", { pattern: "**/slot-*", path: "/" }],
    inside: ["Read", { file_path: join(world.checkout, "inside.txt") }],
    mcp: [mcpTool, {}],
  };
}

/** What a confined session must have answered, or the probe fails naming who. */
function confinementProbeConfined(world, seen, who) {
  const leaked = [world.secret, world.environ, world.credential];
  for (const [name, answer] of Object.entries(seen.answers)) {
    if (name === "inside" || name === "mcp") continue;
    for (const value of leaked)
      if (answer.text.includes(value))
        throw new Error(`${who}'s ${name} call reached outside its checkout`);
  }
  for (const name of ["credential", "parent", "symlink", "root", "environ"])
    if (!seen.answers[name].error)
      throw new Error(`${who}'s ${name} read was not refused`);
  if (!seen.answers.inside.text.includes(world.inside))
    throw new Error(`${who} could not read inside its checkout`);
  if (!seen.answers.mcp.text.includes(confinementProbeMcpAnswer))
    throw new Error(`${who} could not run a chuggy tool`);
  const builtIns = seen.listed.filter((tool) => !tool.startsWith("mcp__"));
  const extra = builtIns.filter(
    (tool) => !["Read", "Grep", "Glob"].includes(tool),
  );
  if (extra.length > 0)
    throw new Error(
      `${who} was listed built-ins beyond its own: ${extra.join(", ")}`,
    );
}

/** A store holding what the runtime mirrors, keyed as `./sessionStore.mjs` keys it, without the project. */
function confinementProbeStore() {
  const held = new Map();
  const keyOf = (key) => `${key.sessionId}/${key.subpath ?? ""}`;
  return {
    async append(key, entries) {
      held.set(keyOf(key), [...(held.get(keyOf(key)) ?? []), ...entries]);
    },
    async load(key) {
      return held.get(keyOf(key)) ?? null;
    },
  };
}

/**
 * The options `sessionQueryOptions` gives the session, with a chuggy server
 * serving the first chuggy tool they allow, which the session is asked to run.
 */
function confinementProbeOptions(world, endpoint, store, facts, own) {
  const options = sessionQueryOptions(
    { bounds: { turnsMax: 20, budgetUsd: 1, loadTimeoutMs: 60_000 } },
    {
      ...facts,
      systemPrompt: "Answer the probe.",
      ...(own ? { systemPromptOwn: true } : {}),
    },
    store,
    {
      ...process.env,
      [workerWorkspaceVariable]: world.workspace,
      ANTHROPIC_BASE_URL: endpoint.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CHUGGY_CONFINEMENT_PROBE: world.environ,
    },
    { withheld: [], environment: { ANTHROPIC_API_KEY: "probe-key" } },
    { checkout: { directory: world.checkout }, servers: {} },
  );
  const mcpTool = options.allowedTools.find((tool) => tool.startsWith("mcp__"));
  if (mcpTool === undefined)
    throw new Error("the session's options allow no chuggy tool to run");
  options.mcpServers = {
    [chuggyToolServerName]: sdk.createSdkMcpServer({
      name: chuggyToolServerName,
      tools: [
        sdk.tool(mcpTool.split("__").at(-1), "probe", {}, async () => ({
          content: [{ type: "text", text: confinementProbeMcpAnswer }],
        })),
      ],
    }),
  };
  return { options, mcpTool };
}

/**
 * One session run to its first result under the pod's own options: confined
 * with the fact, as before without it. It answers the session's id, the
 * built-ins its init listed, and what each call it was asked to make answered.
 */
async function confinementProbeSession(
  world,
  endpoint,
  store,
  { facts, own = true },
) {
  const { options, mcpTool } = confinementProbeOptions(
    world,
    endpoint,
    store,
    facts,
    own,
  );
  endpoint.calls = confinementProbeCalls(world, mcpTool);
  endpoint.answers = {};
  const run = sdk.query({ prompt: "probe", options });
  const timer = setTimeout(() => {
    void run.interrupt();
  }, confinementProbeSessionMsMax);
  let session;
  let listed;
  let ended;
  try {
    for await (const message of run) {
      if (message.type === "system" && message.subtype === "init") {
        session = message.session_id;
        listed = message.tools;
      }
      if (message.type === "result") {
        ended = message;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    run.close();
  }
  if (ended?.subtype !== "success")
    throw new Error(
      `the probe's session ended ${ended?.subtype ?? "with no result"}`,
    );
  const missing = Object.keys(endpoint.calls).filter(
    (name) => !(name in endpoint.answers),
  );
  if (missing.length > 0)
    throw new Error(`the runtime never answered ${missing.join(", ")}`);
  return { session, listed, answers: endpoint.answers };
}

/**
 * The Messages endpoint the runtime is pointed at. A request offering the
 * session's tools is answered with every call at once, then, once their
 * results come back, with a text that ends the turn; anything else the
 * runtime asks for on its own is answered with a word.
 */
async function confinementProbeEndpoint() {
  const endpoint = { calls: {}, answers: {}, issued: new Map() };
  let next = 0;
  endpoint.server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (!request.url.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    if (request.url.startsWith("/v1/messages/count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const body = JSON.parse(text);
    const offered = (body.tools ?? []).map((tool) => tool.name);
    const replied = body.messages.findLastIndex(
      (message) => message.role === "assistant",
    );
    const results = body.messages
      .slice(replied + 1)
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((block) => block.type === "tool_result");
    for (const block of results) {
      const name = endpoint.issued.get(block.tool_use_id);
      if (name === undefined) continue;
      endpoint.answers[name] = {
        error: block.is_error === true,
        text: JSON.stringify(block.content ?? ""),
      };
    }
    const asking = offered.includes("Read") && results.length === 0;
    const content = asking
      ? Object.entries(endpoint.calls).map(([name, [tool, input]]) => {
          next += 1;
          const id = `toolu_probe${String(next)}`;
          endpoint.issued.set(id, name);
          return { type: "tool_use", id, name: tool, input };
        })
      : [{ type: "text", text: "done" }];
    confinementProbeStream(response, body.model, content, asking);
  });
  await new Promise((resolve) => {
    endpoint.server.listen(0, "127.0.0.1", resolve);
  });
  endpoint.url = `http://127.0.0.1:${String(endpoint.server.address().port)}`;
  return endpoint;
}

/** One assistant message written as the Messages API streams it. */
function confinementProbeStream(response, model, content, asking) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
  };
  const usage = { input_tokens: 1, output_tokens: 1 };
  send("message_start", {
    message: {
      id: `msg_probe${randomBytes(6).toString("hex")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", {
        index,
        content_block: { type: "text", text: "" },
      });
      send("content_block_delta", {
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      send("content_block_start", {
        index,
        content_block: { ...block, input: {} },
      });
      send("content_block_delta", {
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", {
    delta: {
      stop_reason: asking ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage,
  });
  send("message_stop", {});
  response.end();
}
