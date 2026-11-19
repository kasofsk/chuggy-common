import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  chuggyToolCapabilities,
  chuggyToolServerName,
  chuggyToolTimeoutMs,
} from "@chuggy/worker-contract/sessionTools";
import {
  signInStoreDirectory,
  signInStoreFileName,
  signInStoreText,
} from "@chuggy/worker-contract/signInStore";
import { z } from "zod";

import {
  accessTokenExpiresHeader,
  accessTokenWarningDays,
} from "@chuggy/worker-contract/accessToken";

import {
  chuggyProjectTools,
  chuggySubmissionRepeatDescription,
  chuggyToolAnswerBytes,
  chuggyToolAnswerBytesMax,
} from "./chuggyTools.mjs";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

import { localTokenStore } from "./localTokenStore.mjs";
import {
  localToolAskRefusal,
  localToolContext,
  localToolEndSignals,
  localToolInstructions,
  localToolRepeatDescription,
  localToolRequest,
  localToolServe,
  localToolServed,
  localToolServer,
  localToolReleasesBytesMax,
  localToolSignInFile,
  localToolTokenAccess,
  localToolTokenExpiringNote,
  localToolTokenNotFoundNote,
  localToolTokenNoteBytesMax,
  localToolTokenNotHeld,
  localToolTokenRefused,
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

test("a call goes under the person's token, and a 401 is asked once more under another", async () => {
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

test("a person's agent is given every project tool, under one project's routes", async () => {
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

test("a person's agent is given every thread settings, placement, agent-account and pull request merge tool", () => {
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
  });
  const { registered, sdk } = sdkOf();
  localToolServer(context, sdk);
  const served = new Set(registered.map(({ name }) => name));

  for (const capability of [
    "ProjectSettings",
    "AgentAccounts",
    "ProposalMerge",
  ]) {
    assert.ok(chuggyToolCapabilities[capability].length > 0, capability);
    for (const tool of chuggyToolCapabilities[capability])
      assert.ok(served.has(tool), tool);
  }
});

test("the server's instructions say how to change the project's thread settings and merge a ticket's pull request", () => {
  const instructions = localToolInstructions({
    tenant: "vteng",
    project: "chuggy",
  });
  assert.match(
    instructions,
    /^To change the project's thread settings: read_docs the page "A project's thread settings", then read_lead_settings and update_lead_settings\.$/mu,
  );
  assert.match(
    instructions,
    /^To merge a ticket's pull request: read_ticket_landings, ask the person whether they want chuggy to merge it, then merge_pull_request\.$/mu,
  );
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
    /^Releasing starts nothing: once its dependencies are Done the ticket waits Pending until a person who may dispatch dispatches it: by dispatch_ticket on the word of the person you act for, or by another person who may dispatch\.$/mu,
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

/**
 * The tools served with the global fetch answering the site's configuration
 * and its issuer's discovery, and `answered` every other request.
 */
async function servedOf(t, asked, answered) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const requested = String(url);
    if (requested === "https://chuggy.test/config.json")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        audience: "https://chuggy.test/api",
      });
    if (requested === "https://auth.test/.well-known/openid-configuration")
      return globalThis.Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/oauth2/auth",
        token_endpoint: "https://auth.test/oauth2/token",
      });
    return answered(requested, init);
  });
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const handlers = new Map();
  let closed;
  const closing = new Promise((resolve) => {
    closed = resolve;
  });
  class McpServer {
    constructor() {
      this.server = {};
    }
    registerTool(name, _config, handler) {
      handlers.set(name, handler);
    }
    async connect() {}
    async close() {
      closed();
      this.server.onclose?.();
    }
  }
  const served = localToolServed(
    {
      site: "https://chuggy.test",
      workspace: "vteng",
      project: "chuggy",
      version: "1",
      environment: {},
      ...asked,
    },
    { McpServer, StdioServerTransport: class {}, z },
    stdin,
    signals,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return {
    called: (name, input) => handlers.get(name)(input),
    ended: async () => {
      stdin.emit("end");
      await served;
    },
    served,
    signals,
    closing,
    /** Ends the serve by the end of input or the signal `by`. */
    endedBy: (by) => (by === "end" ? stdin.emit("end") : signals.emit(by, by)),
  };
}

test("served with the global fetch, a call with no sign-in is answered with a page, and the end of input ends it", async (t) => {
  const signIns = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(signIns, { recursive: true, force: true }));
  const served = await servedOf(
    t,
    { signIns, surroundings: { home: signIns, configHome: undefined } },
    async () => new globalThis.Response("", { status: 404 }),
  );
  const answer = await served.called("read_ticket", { ticket: 7 });
  assert.equal(answer.isError, true);
  const text = answer.content.map(({ text }) => text).join("");
  assert.match(
    text,
    /not signed in to https:\/\/chuggy\.test: this call needs the person signed in, so give them this address, in full, in your next message, whatever else you are doing: https:\/\/auth\.test\/oauth2\/auth\?\S+ Call the tool again once they say they have signed in\./,
  );
  await served.ended();
});

test("served, a sign-in kept in the contract's store is renewed with no sign-in page, and one an earlier copy kept is moved there", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const surroundings = { home, configHome: join(home, "config") };
  const store = signInStoreDirectory(surroundings);
  const kept = join(store, signInStoreFileName("https://chuggy.test"));
  const signIns = join(home, "earlier");
  const earlier = localToolSignInFile(signIns, "https://chuggy.test");
  const sites = [
    { formerly: undefined, stored: "renewal-setup" },
    { formerly: "renewal-earlier", stored: undefined },
  ];
  for (const { formerly, stored } of sites) {
    await rm(kept, { force: true });
    await mkdir(store, { recursive: true });
    await mkdir(signIns, { recursive: true });
    if (stored !== undefined) await writeFile(kept, signInStoreText(stored));
    if (formerly !== undefined) await writeFile(earlier, `${formerly}\n`);
    const spent = [];
    const served = await servedOf(
      t,
      { signIns, surroundings },
      async (requested, init) => {
        if (requested !== "https://auth.test/oauth2/token")
          return globalThis.Response.json({ ticket: 7 });
        spent.push(new URLSearchParams(init.body).get("refresh_token"));
        return globalThis.Response.json({
          access_token: "access-1",
          refresh_token: "renewal-mcp",
          expires_in: 3_600,
        });
      },
    );
    const answer = await served.called("read_ticket", { ticket: 7 });
    assert.equal(answer.isError, undefined);
    assert.deepEqual(spent, [stored ?? formerly]);
    assert.equal(await readFile(kept, "utf8"), signInStoreText("renewal-mcp"));
    await assert.rejects(readFile(earlier), { code: "ENOENT" });
    await served.ended();
  }
});

/**
 * The tools served over a store holding `renewal-0`, with a call's renewal of
 * it sent and unanswered; `answer` answers it with `renewal-1`, and `stored`
 * is what the store holds once the serve has ended.
 */
async function renewingOf(t) {
  const home = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const surroundings = { home, configHome: undefined };
  const directory = signInStoreDirectory(surroundings);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, signInStoreFileName("https://chuggy.test")),
    signInStoreText("renewal-0"),
  );
  let sent;
  const sending = new Promise((resolve) => {
    sent = resolve;
  });
  let answered;
  const served = await servedOf(
    t,
    { signIns: join(home, "earlier"), surroundings },
    async (requested) => {
      if (requested !== "https://auth.test/oauth2/token")
        return globalThis.Response.json({ ticket: 7 });
      sent();
      return new Promise((resolve) => {
        answered = resolve;
      });
    },
  );
  const store = localTokenStore({ directory, origin: "https://chuggy.test" });
  const call = served.called("read_ticket", { ticket: 7 });
  await sending;
  let ended = false;
  const stored = served.served.then(async () => {
    ended = true;
    return {
      renewal: await store.read(),
      access: await store.accessRead("renewal-1"),
    };
  });
  return {
    served,
    call,
    stored,
    ended: () => ended,
    answer: () =>
      answered(
        globalThis.Response.json({
          access_token: "access-1",
          refresh_token: "renewal-1",
          expires_in: 3_600,
        }),
      ),
  };
}

test("served, a renewal sent before the end of input or an ending signal is stored, token and access record, before the serve ends", async (t) => {
  for (const by of ["end", ...localToolEndSignals]) {
    const renewing = await renewingOf(t);
    renewing.served.endedBy(by);
    await renewing.served.closing;
    renewing.answer();
    const { renewal, access } = await renewing.stored;
    assert.equal(renewal, "renewal-1", by);
    assert.equal(access?.accessToken, "access-1", by);
    await renewing.call;
    for (const signal of localToolEndSignals)
      assert.equal(renewing.served.signals.listenerCount(signal), 0);
  }
});

test("served, an ending signal after the end of input, while a sent renewal is unanswered, is still held and the renewal stored", async (t) => {
  const renewing = await renewingOf(t);
  const { signals } = renewing.served;
  renewing.served.endedBy("end");
  await renewing.served.closing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewing.ended(), false);
  for (const signal of localToolEndSignals)
    assert.ok(signals.listenerCount(signal) > 0, signal);
  signals.emit("SIGTERM", "SIGTERM");
  renewing.answer();
  const { renewal, access } = await renewing.stored;
  assert.equal(renewal, "renewal-1");
  assert.equal(access?.accessToken, "access-1");
  await renewing.call;
  for (const signal of localToolEndSignals)
    assert.equal(signals.listenerCount(signal), 0);
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
      environment: {},
      surroundings: { home: signIns, configHome: undefined },
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

const dayMs = 24 * 60 * 60 * 1_000;

/** An access token as chuggy mints one. */
function accessTokenOf() {
  return `chgp_${randomBytes(32).toString("base64url")}`;
}

/** Whether `text` holds the token's secret or any eight characters of it. */
function holdsTokenPart(text, token) {
  for (let start = 0; start + 8 <= token.length; start += 1)
    if (text.includes(token.slice(start, start + 8))) return true;
  return false;
}

/**
 * The tools served with `CHUGGY_TOKEN` set to `value` over an empty home,
 * `answered` answering each API request; `requests` are those it was sent,
 * `stderr` what was written there, and `home()` every path left in the home.
 */
async function tokenServedOf(t, value, answered) {
  const home = await mkdtemp(join(tmpdir(), "local-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stderr = [];
  t.mock.method(process.stderr, "write", (chunk) => stderr.push(String(chunk)));
  const requests = [];
  const served = await servedOf(
    t,
    {
      signIns: join(home, "earlier"),
      surroundings: { home, configHome: join(home, "config") },
      environment: { CHUGGY_TOKEN: value },
    },
    async (requested, init) => {
      requests.push({ requested, init });
      return answered(requested, init);
    },
  );
  return {
    ...served,
    requests,
    stderr,
    home: () => readdir(home, { recursive: true }),
  };
}

/** A ticket's answer whose token expiry header is `expires`, absent where undefined. */
function ticketAnswered(expires, status = 200) {
  return globalThis.Response.json(
    { ticket: 7 },
    {
      status,
      headers:
        expires === undefined ? {} : { [accessTokenExpiresHeader]: expires },
    },
  );
}

/** The text items of an answer. */
function textsOf(answer) {
  return answer.content.map(({ text }) => text);
}

test("served under a CHUGGY_TOKEN access token, each request presents it, and no sign-in is begun nor its store reached", async (t) => {
  const token = accessTokenOf();
  const served = await tokenServedOf(t, token, () => ticketAnswered());
  for (const ticket of [7, 8]) {
    const answer = await served.called("read_ticket", { ticket });
    assert.equal(answer.isError, undefined);
    assert.equal(answer.content.length, 1);
  }
  await served.ended();
  assert.deepEqual(
    served.requests.map(({ requested, init }) => [
      requested,
      init.headers.authorization,
    ]),
    [7, 8].map((ticket) => [
      `https://chuggy.test/api/v1/tenants/vteng/projects/chuggy/tickets/${String(ticket)}`,
      `Bearer ${token}`,
    ]),
  );
  // `servedOf` answers the site's configuration and its issuer itself, so a
  // sign-in begun would be the only reader of either, and none reached here.
  assert.equal(globalThis.fetch.mock.callCount(), served.requests.length);
  assert.deepEqual(await served.home(), []);
});

test("under a token, a 401 is one request, answered as the token refused with its remedy and no part of the token", async (t) => {
  const token = accessTokenOf();
  const served = await tokenServedOf(t, token, () =>
    ticketAnswered(undefined, 401),
  );
  const answer = await served.called("read_ticket", { ticket: 7 });
  await served.ended();
  assert.equal(served.requests.length, 1);
  assert.equal(answer.isError, true);
  assert.deepEqual(textsOf(answer), [localToolTokenRefused]);
  assert.match(
    localToolTokenRefused,
    /deleted, it expired, or it belongs to another site/u,
  );
  assert.match(
    localToolTokenRefused,
    /make a new one in the project's Settings → Access tokens and set CHUGGY_TOKEN to it/u,
  );
  assert.ok(!holdsTokenPart(JSON.stringify(answer), token));
  assert.ok(!holdsTokenPart(served.stderr.join(""), token));
  assert.deepEqual(await served.home(), []);
});

test("a CHUGGY_TOKEN that is not an access token is never sent: every call says so, read_docs too, and no sign-in is begun", async (t) => {
  for (const value of [
    "ghp_notachuggytoken",
    `CHGP_${"a".repeat(43)}`,
    `chgp_${"a".repeat(42)}`,
  ]) {
    const served = await tokenServedOf(t, value, () => ticketAnswered());
    for (const [name, input] of [
      ["read_ticket", { ticket: 7 }],
      ["read_docs", {}],
      [
        "release_draft",
        { ticket: 4, authoringVersion: 2, configurationRevision: "r1" },
      ],
    ]) {
      const answer = await served.called(name, input);
      assert.equal(answer.isError, true, name);
      assert.deepEqual(textsOf(answer), [localToolTokenNotHeld], name);
      assert.ok(!holdsTokenPart(JSON.stringify(answer), value), name);
    }
    await served.ended();
    assert.equal(globalThis.fetch.mock.callCount(), 0, value);
    assert.deepEqual(await served.home(), [], value);
  }
});

test("an empty CHUGGY_TOKEN is unset, and a call is answered with the sign-in page", async (t) => {
  const served = await tokenServedOf(t, "", () => ticketAnswered());
  const answer = await served.called("read_ticket", { ticket: 7 });
  await served.ended();
  assert.equal(answer.isError, true);
  assert.match(
    textsOf(answer).join(""),
    /not signed in to https:\/\/chuggy\.test: /u,
  );
  assert.equal(served.requests.length, 0);
});

test("with the token's expiry within its warning days, each answer ends with the expiry note and one stderr line is written", async (t) => {
  const expires = new Date(Date.now() + 3 * dayMs).toISOString();
  const token = accessTokenOf();
  const served = await tokenServedOf(t, token, () => ticketAnswered(expires));
  const note = localToolTokenExpiringNote(Date.parse(expires));
  for (const ticket of [7, 8]) {
    const answer = await served.called("read_ticket", { ticket });
    assert.equal(answer.isError, undefined);
    assert.equal(answer.content.length, 2);
    assert.deepEqual(answer.content[1], { type: "text", text: note });
  }
  await served.ended();
  assert.match(
    note,
    new RegExp(
      `expires at ${expires}: before then, make a new one in the project's Settings → Access tokens and set CHUGGY_TOKEN to it\\.$`,
      "u",
    ),
  );
  assert.deepEqual(served.stderr, [`${note}\n`]);
  assert.ok(!holdsTokenPart(served.stderr.join(""), token));
});

test("an expiry past the warning days, or none, or one unreadable, adds nothing and writes nothing", async (t) => {
  for (const expires of [
    new Date(Date.now() + (accessTokenWarningDays + 1) * dayMs).toISOString(),
    undefined,
    "soon",
  ]) {
    const served = await tokenServedOf(t, accessTokenOf(), () =>
      ticketAnswered(expires),
    );
    const answer = await served.called("read_ticket", { ticket: 7 });
    await served.ended();
    assert.equal(answer.isError, undefined, expires);
    assert.equal(answer.content.length, 1, expires);
    assert.deepEqual(served.stderr, [], expires);
  }
});

test("the token's newest expiry is the one kept, read from every answer", async () => {
  const access = localToolTokenAccess(accessTokenOf(), {
    log: () => undefined,
  });
  const near = Date.now() + dayMs;
  const far = near + 30 * dayMs;
  const headers = [far, near, undefined].map((at) =>
    at === undefined ? undefined : new Date(at).toISOString(),
  );
  const context = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    access,
    request: async () => ticketAnswered(headers.shift()),
  });
  for (let call = 0; call < 3; call += 1)
    await context.request(context.task, undefined, "/api/v1/x");
  assert.equal(access.expiresAtMs, far);
});

test("a 404 under a token ends the answer with the other-project note, and one under a sign-in adds nothing", async (t) => {
  const served = await tokenServedOf(t, accessTokenOf(), () =>
    ticketAnswered(undefined, 404),
  );
  const answer = await served.called("read_ticket", { ticket: 7 });
  await served.ended();
  assert.equal(answer.isError, true);
  assert.equal(answer.content.length, 2);
  assert.match(answer.content[0].text, /^HTTP 404\n/u);
  assert.deepEqual(answer.content[1], {
    type: "text",
    text: localToolTokenNotFoundNote,
  });

  const signedIn = localToolContext({
    site: "https://chuggy.test",
    tenant: "vteng",
    project: "chuggy",
    version: "1",
    signIn: signInOf(["token"]),
    request: apiOf([404]).request,
  });
  const { registered, sdk } = sdkOf();
  localToolServer(signedIn, sdk);
  const readTicket = registered.find(({ name }) => name === "read_ticket");
  const relayed = await readTicket.handler({ ticket: 7 });
  assert.equal(relayed.content.length, 1);
});

test("an answer already filling what one answer may weigh is given no note, and stays within it", async (t) => {
  const expires = new Date(Date.now() + dayMs).toISOString();
  const head = chuggyToolAnswerBytes("HTTP 404\n");
  const body = "a".repeat(chuggyToolAnswerBytesMax - head);
  const served = await tokenServedOf(
    t,
    accessTokenOf(),
    () =>
      new globalThis.Response(body, {
        status: 404,
        headers: { [accessTokenExpiresHeader]: expires },
      }),
  );
  const answer = await served.called("read_ticket", { ticket: 7 });
  await served.ended();
  assert.equal(answer.content.length, 1);
  assert.equal(
    chuggyToolAnswerBytes(answer.content[0].text),
    chuggyToolAnswerBytesMax,
  );
  assert.deepEqual(served.stderr, [
    `${localToolTokenExpiringNote(Date.parse(expires))}\n`,
  ]);
});

test("each note is within its bound, for any expiry a date can name", () => {
  for (const note of [
    localToolTokenNotFoundNote,
    localToolTokenExpiringNote(Date.parse("+275760-09-13T00:00:00.000Z")),
    localToolTokenExpiringNote(0),
  ])
    assert.ok(chuggyToolAnswerBytes(note) <= localToolTokenNoteBytesMax, note);
});

test("under a token, the instructions say whom the tools act as and to pass a refusal on, with no sign-in or steering sentence, and the rest unchanged", () => {
  const task = { tenant: "vteng", project: "chuggy" };
  const signedIn = localToolInstructions(task).split("\n");
  const token = localToolInstructions(
    task,
    localToolTokenAccess(accessTokenOf(), { log: () => undefined }),
  );
  assert.doesNotMatch(token, /signed in|sign-in/u);
  assert.doesNotMatch(
    token,
    /update_lead_settings|update_placement|merge_pull_request/u,
  );
  assert.match(
    token,
    /^These tools are the only way to read or act on chuggy from here, and they act as the person who made the access token they are given, in this project only\. When a call answers that the token was refused, pass that on to the person/mu,
  );
  assert.match(
    token,
    /^Changing the project's thread settings or its placement, and merging a ticket's pull request, are, like approvals, the person's to do in the console\.$/mu,
  );
  const lines = token.split("\n");
  assert.deepEqual(
    lines.filter((_line, index) => index !== 1).slice(0, -1),
    signedIn.filter((_line, index) => index !== 1).slice(0, -2),
  );
});
