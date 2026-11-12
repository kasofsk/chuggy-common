import assert from "node:assert/strict";
import test from "node:test";

import {
  runContextItemsMax,
  workerRunContextSchema,
} from "@chuggy/worker-contract/workerPlane";

import {
  contextCompacted,
  contextCompaction,
  contextWindow,
} from "./contextReading.mjs";
import { contextUsage } from "./contextUsage.fixture.mjs";

/** Whether the contract takes `window` as a reading's. */
function taken(window) {
  return workerRunContextSchema.safeParse({
    readings: [{ ordinal: 1, afterTurn: 0, cause: "End", window }],
  }).success;
}

const unchanged = (text) => text;

test("the runtime's breakdown is the contract's window, without its grid, its colours or its API usage", () => {
  const window = contextWindow(contextUsage, unchanged);

  assert.ok(taken(window));
  assert.equal(window.model, contextUsage.model);
  assert.equal(window.totalTokens, contextUsage.totalTokens);
  assert.equal(window.maxTokens, contextUsage.maxTokens);
  assert.equal(window.autoCompactThreshold, contextUsage.autoCompactThreshold);
  assert.deepEqual(window.categories.slice(0, 3), [
    { name: "System prompt", tokens: 141, kind: "Used" },
    { name: "System tools", tokens: 9943, kind: "Used" },
    { name: "System tools (deferred)", tokens: 19723, kind: "Deferred" },
  ]);
  assert.deepEqual(window.skills, {
    total: contextUsage.skills.totalSkills,
    included: contextUsage.skills.includedSkills,
    tokens: contextUsage.skills.tokens,
    items: contextUsage.skills.skillFrontmatter.map(({ name, tokens }) => ({
      name,
      tokens,
    })),
  });
  assert.equal(
    window.messages.attachments,
    contextUsage.messageBreakdown.attachmentTokens,
  );
  for (const left of ["gridRows", "apiUsage", "slashCommands", "percentage"])
    assert.equal(Object.hasOwn(window, left), false, left);
});

test("each list the runtime names is the contract's, entry for entry", () => {
  const window = contextWindow(
    {
      ...contextUsage,
      memoryFiles: [
        { path: "/workspace/CLAUDE.md", type: "Project", tokens: 9 },
      ],
      mcpTools: [{ name: "read_ticket", serverName: "chuggy", tokens: 7 }],
      systemTools: [{ name: "Bash", tokens: 5 }],
      systemPromptSections: [{ name: "Tone", tokens: 3 }],
      agents: [{ agentType: "Explore", source: "built-in", tokens: 2 }],
    },
    unchanged,
  );

  assert.ok(taken(window));
  assert.deepEqual(window.memoryFiles, [
    { path: "/workspace/CLAUDE.md", tokens: 9 },
  ]);
  assert.deepEqual(window.mcpTools, [
    { server: "chuggy", name: "read_ticket", tokens: 7 },
  ]);
  assert.deepEqual(window.systemTools, [{ name: "Bash", tokens: 5 }]);
  assert.deepEqual(window.systemPromptSections, [{ name: "Tone", tokens: 3 }]);
  assert.deepEqual(window.agents, [{ type: "Explore", tokens: 2 }]);
});

test("a list longer than the contract holds is cut to its bound, and the window is still taken", () => {
  const tools = Array.from({ length: runContextItemsMax + 1 }, (_, index) => ({
    name: `tool_${String(index)}`,
    serverName: "chuggy",
    tokens: index,
  }));

  const window = contextWindow({ ...contextUsage, mcpTools: tools }, unchanged);

  assert.equal(window.mcpTools.length, runContextItemsMax);
  assert.ok(taken(window));
});

test("a category of a kind the contract does not name is dropped, and the rest are kept", () => {
  const window = contextWindow(
    {
      ...contextUsage,
      categories: [
        { name: "Messages", tokens: 4, kind: "used" },
        { name: "Elsewhere", tokens: 1, kind: "elsewhere" },
      ],
    },
    unchanged,
  );

  assert.deepEqual(window.categories, [
    { name: "Messages", tokens: 4, kind: "Used" },
  ]);
  assert.ok(taken(window));
});

test("every text a window carries has passed the scrub", () => {
  const window = contextWindow(
    {
      ...contextUsage,
      memoryFiles: [{ path: "/home/secret/CLAUDE.md", tokens: 1 }],
    },
    (text) => text.replaceAll("secret", "[redacted]"),
  );

  assert.equal(window.memoryFiles[0].path, "/home/[redacted]/CLAUDE.md");
});

test("a compaction is its boundary's trigger and the tokens either side of it", () => {
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "auto",
      pre_tokens: 167_000,
      post_tokens: 12_000,
      duration_ms: 30_000,
    },
  };

  assert.ok(contextCompacted(boundary));
  assert.deepEqual(contextCompaction(boundary), {
    trigger: "Auto",
    tokensBefore: 167_000,
    tokensAfter: 12_000,
  });
  assert.deepEqual(
    contextCompaction({
      ...boundary,
      compact_metadata: { trigger: "manual", pre_tokens: 9 },
    }),
    { trigger: "Manual", tokensBefore: 9 },
  );
});

test("a boundary naming no trigger or no count before it has no facts the contract takes", () => {
  const boundary = (compact_metadata) => ({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata,
  });

  assert.equal(
    contextCompaction(boundary({ trigger: "sometimes", pre_tokens: 1 })),
    undefined,
  );
  assert.equal(
    contextCompaction(boundary({ trigger: "auto", pre_tokens: -1 })),
    undefined,
  );
  assert.equal(contextCompaction(boundary(undefined)), undefined);
  assert.equal(contextCompacted({ type: "system", subtype: "init" }), false);
});
