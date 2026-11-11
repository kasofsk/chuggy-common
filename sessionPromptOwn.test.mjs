import assert from "node:assert/strict";
import test from "node:test";

import { chuggyToolPrefix } from "@chuggy/worker-contract/sessionTools";

import { sessionBuiltInTools } from "./chuggyTools.mjs";
import {
  facts,
  leadRoster,
  planeOf,
  queryOf,
  result,
  run,
  turnOne,
} from "./sessionHarness.fixture.mjs";

const objectives = "# What this project wants\n\nShip the lead.";
const checkout = { directory: "/workspace/repository", commit: "a".repeat(40) };
const leadOwn = {
  ...facts,
  capabilities: [...leadRoster],
  systemPrompt: objectives,
  systemPromptOwn: true,
};

async function optionsOf(sessionFacts, services = {}) {
  const plane = planeOf([], sessionFacts);
  const { seen, query } = queryOf(() => []);
  await run({ request: plane.request, query, ...services });
  return seen.options;
}

test("a lead on its own prompt runs on its environment lines and objectives, confined to its checkout", async () => {
  const options = await optionsOf(leadOwn, { checkout: async () => checkout });

  assert.deepEqual(options.systemPrompt, {
    type: "custom",
    prompt: [
      "Each turn's user message is the selector's observation document (JSON). A read-only checkout of the project's repository is at /workspace/repository; Glob, Grep, and Read read it. End the turn by calling the decision tools; your final text is not read by anyone.",
      objectives,
    ].join("\n\n"),
    snapshot: false,
  });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.cwd, checkout.directory);
  assert.deepEqual(options.tools, ["Glob", "Grep", "Read"]);
  assert.ok(options.allowedTools.length > 0);
  for (const tool of options.allowedTools)
    assert.ok(
      tool.startsWith(chuggyToolPrefix),
      `${tool} is allowed on every path`,
    );
  for (const tool of sessionBuiltInTools.filter(
    (one) => !options.tools.includes(one),
  ))
    assert.ok(options.disallowedTools.includes(tool), tool);
});

test("a session on its own prompt with no checkout runs in an empty directory of its own, never the workspace", async () => {
  const ensured = [];
  const options = await optionsOf(leadOwn, {
    ensureDirectory: async (path) => {
      ensured.push(path);
    },
  });

  assert.equal(options.cwd, "/workspace/empty");
  assert.ok(ensured.includes("/workspace/empty"), "the directory was not made");
  assert.match(
    options.systemPrompt.prompt,
    /This session holds no checkout of the project's repository\./u,
  );
});

test("a session without the fact runs on the preset with the project's settings, as before", async () => {
  const options = await optionsOf(
    { ...facts, capabilities: [...leadRoster], systemPrompt: objectives },
    { checkout: async () => checkout },
  );

  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    snapshot: false,
    append: objectives,
  });
  assert.deepEqual(options.settingSources, ["project"]);
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.cwd, checkout.directory);
  assert.ok(!("tools" in options), "a session without the fact lost tools");
  assert.ok(options.allowedTools.includes("Read"));
  assert.equal(
    (await optionsOf({ ...facts, systemPrompt: objectives })).cwd,
    "/workspace",
  );
});

test("an inquiry on its own prompt is told its reader and no decision tools, and answers as before", async () => {
  const inquiryTurn = { ...turnOne, inputKind: "Inquiry", input: "why?" };
  const plane = planeOf([inquiryTurn], {
    ...facts,
    kind: "Inquiry",
    capabilities: ["RepositoryRead", "ProjectRead"],
    forkFrom: "lead-1",
    systemPrompt: objectives,
    systemPromptOwn: true,
  });
  const { seen, query } = queryOf(() => [
    { type: "system", subtype: "init", session_id: "fork-1" },
    result("success", { result: "because." }),
  ]);

  const code = await run({
    request: plane.request,
    query,
    checkout: async () => checkout,
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.options.systemPrompt, {
    type: "custom",
    prompt: [
      "A read-only checkout of the project's repository is at /workspace/repository; Glob, Grep, and Read read it. Your final text is your answer, and the member who asked reads it.",
      objectives,
    ].join("\n\n"),
    snapshot: false,
  });
  assert.equal(seen.options.permissionMode, "dontAsk");
  assert.deepEqual(seen.options.settingSources, []);
  assert.deepEqual(
    plane.calls.find(({ path }) => path === "/v1/session/turn/answer").body,
    { turn: "turn-1", result: "because." },
  );
});
