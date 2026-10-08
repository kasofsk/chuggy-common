import assert from "node:assert/strict";
import test from "node:test";

import { runtimeScratch } from "./runtimeScratch.mjs";

test("a runtime directory entry names what it is for and the process that made it", () => {
  assert.equal(runtimeScratch("pull", 4242), "pull-4242-");
  assert.equal(runtimeScratch("job"), `job-${String(process.pid)}-`);
});
