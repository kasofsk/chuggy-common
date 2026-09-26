/**
 * The shipped set, `package.json`'s `files`, against the modules a pod runs.
 * An image copies that set and nothing else, so a module the entry reaches
 * and the set omits is a pod that fails at its first import.
 *
 * THE GRAPH IS READ OFF THE TEXT. The suites run where the image's own Node
 * runs them, which carries no parser but the runtime's, and a module is
 * reached here by a literal specifier or not at all: `session.mjs` names the
 * agent runtime and `zod` through variables, and neither is shipped.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const root = new URL("./", import.meta.url);
const entry = "entrypoint.mjs";

/** A static import or re-export, a bare import, or an `import()` of a literal. */
const specifierPattern =
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)|\b(?:from|import)\s*["']([^"']+)["']/gu;

async function shippedFiles() {
  const manifest = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );
  return manifest.files;
}

function relativeSpecifiers(source) {
  return [...source.matchAll(specifierPattern)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => /^\.\.?\//u.test(specifier));
}

/** Every module reachable from `start` by relative imports, named from the root. */
async function reachedFrom(start) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const name = pending.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const module = new URL(name, root);
    for (const specifier of relativeSpecifiers(await readFile(module, "utf8")))
      pending.push(new URL(specifier, module).href.slice(root.href.length));
  }
  return [...reached].sort();
}

test("every module the entry reaches is shipped", async () => {
  const files = await shippedFiles();
  const reached = await reachedFrom(entry);

  assert.ok(reached.includes("checks.mjs"), reached.join(" "));
  assert.ok(reached.includes("session.mjs"), "the dynamic import is followed");
  for (const name of reached)
    assert.ok(files.includes(name), `${entry} reaches ${name}, never shipped`);
});

/** The probes are the build's own entries, so a module the entry never reaches is still shipped. */
test("the shipped set is every module and script here but the suites and fixtures", async () => {
  const harness = (await readdir(root)).filter(
    (name) =>
      /\.(mjs|sh)$/u.test(name) &&
      !name.endsWith(".test.mjs") &&
      !name.includes(".fixture."),
  );

  assert.ok(harness.includes("git-askpass.sh"), harness.join(" "));
  assert.deepEqual([...(await shippedFiles())].sort(), harness.sort());
});
