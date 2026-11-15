import assert from "node:assert/strict";
import test from "node:test";

import {
  targetMergeBriefed,
  targetMergeName,
  targetMergeResolveInstruction,
} from "./targetMerge.mjs";

/** Catches a resolution that renumbers the target's own migration, or leaves both sides on one number. */
test("the resolve instruction moves this change's own number on and leaves the target's as it is", () => {
  assert.ok(
    targetMergeResolveInstruction.includes(
      "Where both sides took the same next number or version, such as a migration's, move this change's own to the next free one and leave what the target holds exactly as it is.",
    ),
    targetMergeResolveInstruction,
  );
});

/** Catches `HEAD` named to the agent as a branch called HEAD. */
test("HEAD is named origin's default branch, and any other ref as itself", () => {
  assert.equal(targetMergeName("HEAD"), "origin's default branch");
  assert.equal(targetMergeName("refs/heads/main"), "refs/heads/main");
});

/** Catches a briefing section added where the start's merge has nothing to tell the agent. */
test("a start that merged cleanly, or merged nothing, adds nothing to the briefing", () => {
  const task = { briefing: { text: "brief" } };
  for (const started of [
    undefined,
    { named: "refs/heads/main", tip: "a", conflicted: [] },
    {
      named: "refs/heads/main",
      tip: "a",
      conflicted: [],
      change: { commit: "b", conflicted: [] },
    },
  ])
    assert.equal(targetMergeBriefed(task, started), task);
});
