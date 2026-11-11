import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  chuggyToolServerName,
  chuggyToolTimeoutMs,
} from "@chuggy/worker-contract/sessionTools";
import { z } from "zod";

import {
  chuggyProjectTools,
  chuggySubmissionRepeatDescription,
} from "./chuggyTools.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  localToolAskRefusal,
  localToolContext,
  localToolInstructions,
  localToolRepeatDescription,
  localToolRequest,
  localToolServe,
  localToolServed,
  localToolServer,
  localToolReleasesBytesMax,
  localToolSignInFile,
  localToolUpdated,
} from "./localTools.mjs";

function signInOf(tokens) {
  const invalidated = [];
  let given = 0;
  return {
    invalidated,
    token: async () => tokens[Math.min(given++, tokens.length - 1)],
    invalidate: (token) => invalidated.push(token),
  };
}

function apiOf(statuses) {
  const calls = [];
  return {
    calls,
    request: async (task, bearer, path, init) => {
      calls.push({ task, bearer, path, init });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return new globalThis.Response(`{"status":${String(status)}}`, {
        status,
      });
    },
  };
}

test("a call goes under the person's token, and a 401 is asked once more under a renewed one", async () => {
  const signIn = signInOf(["first", "second", "third"]);
  const api = apiOf([401, 200]);
  const request = localToolRequest(signIn, api.request);
  const response = await request({}, undefined, "/api/v1/x", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    api.calls.map(({ bearer }) => bearer),
    ["first", "second"],
  );
  assert.deepEqual(signIn.invalidated, ["first"]);
  assert.equal(api.calls[1].init.method, "POST");
  assert.ok(api.calls[1].init.signal instanceof globalThis.AbortSignal);
});

test("a second 401 is relayed rather than asked a third time", async () => {
  const signIn = signInOf(["first", "second", "third"]);
  const api = apiOf([401]);
  const response = await localToolRequest(signIn, api.request)(
    {},
    undefined,
    "/api/v1/x",
  );
  assert.equal(response.status, 401);
  assert.equal(api.calls.length, 2);
});

function sdkOf() {
  const registered = [];
  class McpServer {
    constructor(info, options) {
      this.info = info;
      this.options = options;
      this.server = {};
    }
    registerTool(name, config, handler) {
      registered.push({ name, config, handler });
    }
  }
  return { registered, sdk: { McpServer, z } };
}

test("a person's agent is given every project tool and no decision tool, under one project's routes", async () => {
  const signIn = signInOf(["token"]);
  const context = localToolContext({
    site: "https://chuggy.test/console",
    tenant: "vteng",
    project: "chuggy",
    version: "9.9.9",
    signIn,
  });
  const { registered, sdk } = sdkOf();
  const server = localToolServer(context, sdk);
  assert.deepEqual(server.info, {
    name: chuggyToolServerName,
    version: "9.9.9",
  });
  assert.deepEqual(
    registered.map(({ name }) => name),
    chuggyProjectTools.map(({ name }) => name),
  );
  assert.equal(context.task.api.url, "https://chuggy.test");
  assert.equal(context.bearer, undefined);
  const first = context.turn();
  assert.ok(first.length > 0);
  assert.notEqual(context.turn(), first);
});

test("the server tells the agent the docs are behind read_docs, index first", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { registered, sdk } = sdkOf();
  const server = localToolServer(context, sdk);
  assert.deepEqual(server.options, {
    instructions: localToolInstructions(context.task),
  });
  assert.match(server.options.instructions, /read_docs/u);
  assert.match(server.options.instructions, /index first/u);
  assert.ok(registered.some(({ name }) => name === "read_docs"));
});

test("the server's instructions open with the workspace and project it is bound to", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { sdk } = sdkOf();
  const { instructions } = localToolServer(context, sdk).options;
  assert.match(
    instructions,
    /^This server is bound to the workspace vteng and its project chuggy\b/u,
  );
});

test("the server's instructions say every tool needs the person signed in, and that a sign-in is relayed, not worked around", () => {
  const instructions = localToolInstructions({
    tenant: "vteng",
    project: "chuggy",
  });
  assert.match(
    instructions,
    /^These tools are the only way to read or act on chuggy from here, and every one but read_docs needs the person signed in\./mu,
  );
  assert.match(
    instructions,
    /give them the address it names, in full, in your next message/u,
  );
  assert.match(instructions, /call again once they say they have signed in\./u);
  assert.match(instructions, /do not work around a sign-in\.$/mu);
});

test("the server's instructions name the filing recipe's tools in order, then who starts the work", () => {
  const instructions = localToolInstructions({
    tenant: "vteng",
    project: "chuggy",
  });
  const recipe = [
    "read_abilities",
    "list_repositories",
    "list_configurations",
    "initialize_draft",
    "create_draft",
    "read_draft",
    "release_draft",
    "read_operation",
  ];
  const steps = [...instructions.matchAll(/^(\d+)\. (\w+)/gmu)];
  assert.deepEqual(
    steps.map(([, number, tool]) => [Number(number), tool]),
    recipe.map((tool, index) => [index + 1, tool]),
  );
  const tools = new Set(chuggyProjectTools.map(({ name }) => name));
  for (const tool of recipe) assert.ok(tools.has(tool), tool);
  assert.match(
    instructions,
    /^1\. read_abilities: who you act as, which a ticket's `creator` names, and what you may do\.$/mu,
  );
  assert.match(instructions, /^2\. list_repositories: [^\n]*`fileable`/mu);
  assert.match(
    instructions,
    /Releasing starts nothing: [^.]*lead dispatches it[^.]*, or a person who may dispatch does\.$/u,
  );
  assert.match(
    instructions,
    /^3\. list_configurations: a revision whose `repository` is that repository, or, where its list_repositories row's `configurationsHeld\.result` is Bootstrapped, the `configurationsHeld\.revision` that row carries\.$/mu,
  );
});

test("a registered tool reaches its project's route under the person's token", async () => {
  const api = apiOf([200]);
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
    request: api.request,
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const readTicket = registered.find(({ name }) => name === "read_ticket");
  const answer = await readTicket.handler({ ticket: 7 });
  assert.equal(answer.isError, undefined);
  assert.equal(api.calls[0].bearer, "token");
  assert.equal(api.calls[0].task.tenant, "vteng");
  assert.match(
    api.calls[0].path,
    /\/tenants\/vteng\/projects\/chuggy\/tickets\/7$/,
  );
});

/** `release_draft` as a person's agent is given it, under `signIn` and `request`. */
function releaseDraftOf(signIn, request) {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn,
    request,
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const { handler } = registered.find(({ name }) => name === "release_draft");
  return () =>
    handler({ ticket: 4, authoringVersion: 2, configurationRevision: "r1" });
}

test("a call cut off at the tool timeout answers the retry sentence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const release = releaseDraftOf(
    signInOf(["token"]),
    async (_task, _bearer, _path, init) => {
      await new Promise((resolve) => {
        init.signal.addEventListener("abort", resolve, { once: true });
      });
      throw init.signal.reason;
    },
  );

  const answered = release();
  await new Promise(setImmediate);
  t.mock.timers.tick(chuggyToolTimeoutMs);
  const answer = await answered;

  assert.equal(answer.isError, true);
  assert.match(
    answer.content[0].text,
    /^release_draft ended at its \d+-second timeout: /u,
  );
});

test("a sign-in that times out is answered as itself, not as the tool timeout", async () => {
  const api = apiOf([200]);
  const release = releaseDraftOf(
    {
      token: async () => {
        throw new globalThis.DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      },
      invalidate: () => undefined,
    },
    api.request,
  );

  const answer = await release();

  assert.equal(answer.isError, true);
  assert.equal(
    answer.content[0].text,
    "The operation was aborted due to timeout",
  );
  assert.equal(api.calls.length, 0);
});

test("a submitted command is described as a new operation each call, and every other description is the pod's", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const submissions = [];
  for (const { name, config } of registered) {
    const pod = chuggyProjectTools.find((tool) => tool.name === name);
    assert.ok(!config.description.includes(chuggySubmissionRepeatDescription));
    if (pod.description.includes(chuggySubmissionRepeatDescription)) {
      submissions.push(name);
      assert.ok(config.description.includes(localToolRepeatDescription));
    } else assert.equal(config.description, pod.description);
  }
  assert.deepEqual(submissions.sort(), [
    "dispatch_ticket",
    "release_draft",
    "revoke_ticket",
    "update_ticket",
  ]);
});

test("the end of the agent's input closes the server", async () => {
  const stdin = new EventEmitter();
  const closed = [];
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool() {}
    async connect(transport) {
      this.transport = transport;
    }
    async close() {
      closed.push(this.transport);
      this.server.onclose?.();
    }
  }
  class StdioServerTransport {}
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const served = localToolServe(
    context,
    { McpServer, StdioServerTransport, z },
    stdin,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed.length, 0);
  stdin.emit("end");
  await served;
  assert.ok(closed[0] instanceof StdioServerTransport);
});

test("served with the global fetch, a call with no sign-in is answered with a page, and the end of input ends it", async (t) => {
  const signIns = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(signIns, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const asked = String(url);
    if (asked === "https://chuggy.test/config.json")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        audience: "https://chuggy.test/api",
      });
    if (asked === "https://auth.test/.well-known/openid-configuration")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/oauth2/auth",
        token_endpoint: "https://auth.test/oauth2/token",
      });
    return new globalThis.Response("", { status: 404 });
  });
  const stdin = new EventEmitter();
  const handlers = new Map();
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool(name, _config, handler) {
      handlers.set(name, handler);
    }
    async connect() {}
    async close() {
      this.server.onclose?.();
    }
  }
  const served = localToolServed(
    {
      site: "https://chuggy.test",
      workspace: "vteng",
      project: "chuggy",
      version: "1",
      signIns,
    },
    { McpServer, StdioServerTransport: class {}, z },
    stdin,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const answer = await handlers.get("read_ticket")({ ticket: 7 });
  assert.equal(answer.isError, true);
  const text = answer.content.map(({ text }) => text).join("");
  assert.match(
    text,
    /not signed in to https:\/\/chuggy\.test: this call needs the person signed in, so give them this address, in full, in your next message, whatever else you are doing: https:\/\/auth\.test\/oauth2\/auth\?\S+ Call the tool again once they say they have signed in\./,
  );
  stdin.emit("end");
  await served;
});

test("an ask names a site a credential may be sent to, and a workspace and project", () => {
  const named = { workspace: "vteng", project: "chuggy" };
  assert.match(localToolAskRefusal(named), /need a site/);
  assert.match(
    localToolAskRefusal({ ...named, site: "http://chuggy.test" }),
    /https/,
  );
  assert.match(
    localToolAskRefusal({ ...named, site: "https://me:pw@chuggy.test" }),
    /no credentials/,
  );
  assert.match(
    localToolAskRefusal({ ...named, site: "https://chuggy.test", project: "" }),
    /each be named/,
  );
  assert.equal(
    localToolAskRefusal({ ...named, site: "http://127.0.0.1:8080" }),
    undefined,
  );
});

test("each site's sign-in is a file of its own, named by its origin", () => {
  assert.equal(
    localToolSignInFile("/home/me/sign-ins", "https://chuggy.test/console"),
    "/home/me/sign-ins/https%3A%2F%2Fchuggy.test",
  );
});

const pinnedPackage = "chuggy-test";
const pinnedPrefix =
  "https://github.com/kasofsk/chuggy-test/releases/download/";

function pinOf(version, packageName = pinnedPackage) {
  return {
    package: packageName,
    version,
    url: `${pinnedPrefix}v${version}/${packageName}-${version}.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  };
}

function pinsAnswered(releases) {
  const asked = [];
  return {
    asked,
    fetch: async (url, init) => {
      asked.push({ url: String(url), init });
      return globalThis.Response.json({ releases });
    },
  };
}

function updaterOf(
  version,
  answer = (release) => ({
    updated: "Installed",
    version: release.version,
  }),
) {
  const updates = [];
  return {
    updates,
    updater: {
      runner: { package: pinnedPackage, version },
      refusal: async () => undefined,
      prove: async () => ({ proved: "Proved" }),
      update: async (release) => {
        updates.push(release);
        return answer(release);
      },
    },
  };
}

const updatesOn = {
  on: true,
  settings: {
    runner: { package: pinnedPackage, version: "0.4.0" },
    releasePrefix: pinnedPrefix,
    installed: "/opt/chuggy-test",
    lockPath: "/run/chuggy-test/update.lock",
  },
};

test("the site's pin for this copy's package, read with no credential, is installed through its updater where it is above this copy", async () => {
  const site = pinsAnswered([pinOf("9.9.9", "chuggy-other"), pinOf("0.5.0")]);
  const { updater, updates } = updaterOf("0.4.0");
  const lines = [];
  await localToolUpdated("https://chuggy.test/console", updatesOn, {
    fetch: site.fetch,
    log: (line) => lines.push(line),
    updater,
  });
  assert.deepEqual(
    site.asked.map(({ url }) => url),
    ["https://chuggy.test/api/v1/runner-releases"],
  );
  const { init } = site.asked[0];
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal instanceof globalThis.AbortSignal);
  assert.deepEqual(Object.keys(init.headers), ["accept"]);
  assert.deepEqual(updates, [pinOf("0.5.0")]);
  assert.deepEqual(lines, [
    "chuggy-test 0.5.0 is installed, and this session serves 0.4.0 until the agent starts its next",
  ]);
});

test("a pin at or below this copy, or none for its package, installs nothing and says nothing", async () => {
  for (const releases of [
    [pinOf("0.4.0")],
    [pinOf("0.3.9")],
    [pinOf("0.5.0", "chuggy-other")],
    [],
  ]) {
    const { updater, updates } = updaterOf("0.4.0");
    const lines = [];
    await localToolUpdated("https://chuggy.test", updatesOn, {
      fetch: pinsAnswered(releases).fetch,
      log: (line) => lines.push(line),
      updater,
    });
    assert.deepEqual(updates, [], JSON.stringify(releases));
    assert.deepEqual(lines, [], JSON.stringify(releases));
  }
});

test("updates not given, or given off, read nothing and install nothing", async () => {
  for (const updates of [undefined, { ...updatesOn, on: false }]) {
    const site = pinsAnswered([pinOf("0.5.0")]);
    const { updater, updates: installed } = updaterOf("0.4.0");
    const lines = [];
    await localToolUpdated("https://chuggy.test", updates, {
      fetch: site.fetch,
      log: (line) => lines.push(line),
      updater,
    });
    assert.deepEqual(site.asked, []);
    assert.deepEqual(installed, []);
    assert.deepEqual(lines, []);
  }
});

test("a read that fails, or answers anything but the contract's pins, is said and installs nothing", async () => {
  const answers = [
    [() => Promise.reject(new Error("offline")), /: offline$/],
    [() => new globalThis.Response("", { status: 404 }), /: it answered 404$/],
    [
      () =>
        new globalThis.Response("", {
          status: 302,
          headers: { location: "https://elsewhere.test/" },
        }),
      /: it answered 302$/,
    ],
    [
      () => new globalThis.Response(" ".repeat(localToolReleasesBytesMax + 1)),
      /more than its answer is read to$/,
    ],
    [() => new globalThis.Response("{"), /not JSON$/],
    [
      () =>
        globalThis.Response.json({ releases: [{ package: pinnedPackage }] }),
      /not the contract's$/,
    ],
  ];
  for (const [answer, said] of answers) {
    const { updater, updates } = updaterOf("0.4.0");
    const lines = [];
    await localToolUpdated("https://chuggy.test", updatesOn, {
      fetch: async () => answer(),
      log: (line) => lines.push(line),
      updater,
    });
    assert.deepEqual(updates, []);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^could not read the runner releases https:\/\/chuggy\.test pins: /,
    );
    assert.match(lines[0], said);
  }
});

test("an install that fails is said with its reason, and one another service already made is said as installed", async () => {
  const failed = updaterOf("0.4.0", () => ({
    updated: "Failed",
    reason: "its download answered 404",
  }));
  const already = updaterOf("0.4.0", () => ({
    updated: "AlreadyInstalled",
    version: "0.6.0",
  }));
  const lines = [];
  for (const { updater } of [failed, already])
    await localToolUpdated("https://chuggy.test", updatesOn, {
      fetch: pinsAnswered([pinOf("0.5.0")]).fetch,
      log: (line) => lines.push(line),
      updater,
    });
  assert.deepEqual(lines, [
    "did not update to chuggy-test 0.5.0: its download answered 404",
    "chuggy-test 0.6.0 is installed, and this session serves 0.4.0 until the agent starts its next",
  ]);
});

test("settings the updater refuses are said, and nothing is read", async () => {
  const site = pinsAnswered([pinOf("0.5.0")]);
  const lines = [];
  await localToolUpdated(
    "https://chuggy.test",
    {
      on: true,
      settings: { ...updatesOn.settings, releasePrefix: "http://insecure/" },
    },
    { fetch: site.fetch, log: (line) => lines.push(line) },
  );
  assert.deepEqual(site.asked, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^cannot update this copy: release prefix/);
});

test("the serve ends only once the update it started once connected has ended", async () => {
  const stdin = new EventEmitter();
  const order = [];
  let finish;
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool() {}
    async connect() {
      order.push("connected");
    }
    async close() {
      this.server.onclose?.();
    }
  }
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  let ended = false;
  const served = localToolServe(
    context,
    { McpServer, StdioServerTransport: class {}, z },
    stdin,
    () => {
      order.push("updating");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  ).then(() => {
    ended = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["connected", "updating"]);
  stdin.emit("end");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  finish();
  await served;
  assert.equal(ended, true);
});

test("served with updates on, the site's pin goes to the runner updater once connected, its refusal is said on stderr, and the serve goes on", async (t) => {
  const signIns = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(signIns, { recursive: true, force: true }));
  const stderr = [];
  t.mock.method(process.stderr, "write", (chunk) => stderr.push(String(chunk)));
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stdin = new EventEmitter();
  let connected = false;
  const asked = [];
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool() {}
    async connect() {
      connected = true;
    }
    async close() {
      this.server.onclose?.();
    }
  }
  const served = localToolServed(
    {
      site: "https://chuggy.test",
      workspace: "vteng",
      project: "chuggy",
      version: "0.4.0",
      signIns,
      fetch: async (url) => {
        asked.push({ url: String(url), connected });
        return globalThis.Response.json({ releases: [pinOf("0.5.0")] });
      },
      updates: updatesOn,
    },
    { McpServer, StdioServerTransport: class {}, z },
    stdin,
  );
  while (stderr.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [
    { url: "https://chuggy.test/api/v1/runner-releases", connected: true },
  ]);
  assert.deepEqual(stderr, [
    "did not update to chuggy-test 0.5.0: this runner is installed at /opt/chuggy-test, which is not where npm installs a package globally\n",
  ]);
  stdin.emit("end");
  await served;
  assert.equal(stdout.mock.callCount(), 0);
});

/** A static import or re-export, a bare import, or an `import()`, outside comments. */
const localToolSpecifierPattern =
  /\bimport\s*\(|\b(?:from|import)\s*["']([^"']+)["']/gu;

test("nothing the server's modules reach is loaded later than they are, so an install under it changes nothing it runs", async () => {
  const reached = new Set();
  const pending = [import.meta.resolve("./localTools.mjs")];
  const lazy = [];
  while (pending.length > 0) {
    const module = pending.pop();
    if (reached.has(module)) continue;
    reached.add(module);
    const source = (await readFile(fileURLToPath(module), "utf8")).replace(
      /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu,
      "",
    );
    for (const match of source.matchAll(localToolSpecifierPattern)) {
      const specifier = match[1];
      if (specifier === undefined) lazy.push(module);
      else if (!specifier.startsWith("node:"))
        pending.push(
          /^\.\.?\//u.test(specifier)
            ? new URL(specifier, module).href
            : import.meta.resolve(specifier),
        );
    }
  }
  const named = [...reached].map((module) => module.split("/").at(-1));
  for (const name of ["runnerUpdate.mjs", "fileLock.mjs", "workerPool.js"])
    assert.ok(named.includes(name), `${name} is reached`);
  assert.deepEqual(lazy, []);
});
