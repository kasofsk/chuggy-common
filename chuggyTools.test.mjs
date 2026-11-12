import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";
import { URL } from "node:url";

import {
  sessionCapabilities,
  sessionStoreBatchBytesMax,
} from "@chuggy/worker-contract/sessionPlane";
import {
  agenticRefusalsAnsweredMax,
  allChuggyTools,
  briefLineCharsMax,
  chuggyDocsIndex,
  chuggyToolCapabilities,
  chuggyToolDocsResponseBytesMax,
  chuggyToolEpicViewResponseBytesMax,
  chuggyToolImageResponseBytesMax,
  chuggyToolLandingQueuesResponseBytesMax,
  chuggyToolLeadSettingsResponseBytesMax,
  chuggyToolPrefix,
  chuggyToolResponseBytesMax,
  chuggyToolRunErrorResponseBytesMax,
  chuggyToolRunTranscriptResponseBytesMax,
  chuggyToolTicketLandingBytesMax,
  chuggyToolTicketLandingsResponseBytesMax,
  chuggyToolTimeoutMs,
  epicPageLimitMax,
  epicContentBytesMax,
  epicSummaryCharsMax,
  epicTicketsMax,
  epicTitleCharsMax,
  landingQueueTicketsAnsweredMax,
  nativeHttpPageItemsMax,
  runTranscriptBatchBytesMax,
  runTranscriptPageBatchesMax,
  selectorHistoryLimitMax,
  selectorProjectOverridesSchema,
  threadTurnsAnsweredMax,
  ticketLandingsAnsweredMax,
} from "@chuggy/worker-contract/sessionTools";
import { workerPlaneUploadBytesMax } from "@chuggy/worker-contract/workerPlane";
import { z } from "zod";

import {
  chuggyRequestAttemptsMax,
  chuggyRequestRetryMs,
} from "./chuggyApi.mjs";
import {
  chuggyOperationIdentity,
  chuggyToolAnswerBytes,
  chuggyToolAnswerBytesMax,
  chuggyToolAnswerCopiesInEntry,
  chuggyToolAnswerEnvelopeBytesMax,
  chuggyMemberTools,
  chuggyProjectTools,
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
  chuggyToolImageFiles,
  chuggyToolServer,
  chuggyToolSignal,
  chuggyTranscriptBodyBytesMax,
  readAtPathChildCharsMax,
  sessionAllowedTools,
  sessionBuiltInTools,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";
import { leadDecisionStaging } from "./leadDecision.mjs";
import { credentialScrub, runTranscriptEventBytesMax } from "./runEvidence.mjs";
import { leadRoster, threadRoster } from "./sessionHarness.fixture.mjs";
import { sessionStoreAdapter } from "./sessionStore.mjs";

const task = {
  tenant: "vteng",
  project: "chuggy",
  api: { url: "https://api.test:8443" },
};
const bearer = "chgs_0123456789abcdef0123456789abcdef";
const everyCapability = Object.keys(sessionCapabilityTools);

function apiOf(answer) {
  const calls = [];
  return {
    calls,
    request: async (_task, _bearer, path, init) => {
      calls.push({ path, method: init?.method ?? "GET", init });
      const given = answer?.(path, init) ?? { status: 200, body: "{}" };
      return {
        status: given.status,
        text: async () => given.body ?? "",
      };
    },
  };
}

function toolsOf(services = {}, answer) {
  const api = apiOf(answer);
  const staging = services.staging ?? leadDecisionStaging();
  const context = chuggyToolContext(task, bearer, {
    capabilities: everyCapability,
    request: api.request,
    turn: () => "turn-1",
    staging,
    ...services,
  });
  const held = new Map(
    chuggyToolDefinitions(context).map((definition) => [
      definition.name,
      chuggyToolHandler(definition, z),
    ]),
  );
  return { api, staging, context, call: (name, args) => held.get(name)(args) };
}

function textOf(answer) {
  return answer.content[0].text;
}

test("a tool the roster does not grant is never registered", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);

  assert.deepEqual(registered([]), []);
  assert.deepEqual(registered(["RepositoryRead"]), []);
  assert.deepEqual(
    registered(["LeadDecision"]),
    sessionCapabilityTools.LeadDecision,
  );
  assert.deepEqual(
    registered(everyCapability).sort(),
    [...allChuggyTools].sort(),
  );
});

/**
 * Every tool that takes a brief, each with what its `brief` parameter says. The
 * brief is described there rather than in the tool's description, which
 * Claude Code cuts.
 */
function briefTakers() {
  return chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  )
    .filter((definition) => "brief" in definition.shape(z))
    .map(({ name, shape }) => ({
      name,
      description: shape(z).brief.description ?? "",
    }));
}

/**
 * `brief` is an open object on the wire, so a session learns what one carries
 * from the parameter's description alone. A tool that takes one and does not
 * name the title is a tool that files untitled tickets.
 */
test("every tool that takes a brief names the title it carries", () => {
  const taking = briefTakers();

  assert.deepEqual(taking.map(({ name }) => name).sort(), [
    "create_draft",
    "file_dependent",
    "revise_draft",
  ]);
  for (const { name, description } of taking) {
    assert.ok(description.includes("`title`"), `${name} names no title`);
    assert.ok(
      description.includes("always give one"),
      `${name} does not ask for one`,
    );
  }
});

/**
 * What bounds an intent, which a model cannot infer from an open object. An
 * intent is bounded as a whole, so a description that gives one a line bound
 * has the model break sentences the door never asked it to break.
 */
test("every tool that takes a brief says an intent is bounded as a whole, and gives it no line bound", () => {
  const taking = briefTakers();

  assert.notEqual(taking.length, 0, "no tool takes a brief");
  for (const { name, description } of taking) {
    const [, intent] = /`intent` is ([^;]*);/u.exec(description) ?? [];
    assert.ok(intent !== undefined, `${name} does not say what an intent is`);
    assert.ok(
      intent.includes("bounded only as a whole"),
      `${name} does not say what bounds an intent`,
    );
    assert.ok(
      intent.includes("no bound on a line of it or on how many lines it has"),
      `${name} does not say an intent's lines are free`,
    );
    assert.equal(
      intent.includes("break"),
      false,
      `${name} tells a session where to break an intent`,
    );
  }
});

/** Which bound each read's page is held to is written here; the bound itself is the contract's. */
const pageBounds = {
  list_tickets: nativeHttpPageItemsMax,
  list_drafts: nativeHttpPageItemsMax,
  list_epics: epicPageLimitMax,
  read_epic_history: epicPageLimitMax,
  list_configurations: nativeHttpPageItemsMax,
  read_decision_log: selectorHistoryLimitMax,
  read_refusals: agenticRefusalsAnsweredMax,
  list_executions: nativeHttpPageItemsMax,
  read_thread: threadTurnsAnsweredMax,
  list_projects: nativeHttpPageItemsMax,
  read_my_thread: threadTurnsAnsweredMax,
};

test("every read that takes a limit admits its route's bound and no more", () => {
  const limited = chuggyToolDefinitions(
    chuggyToolContext(task, bearer, {
      capabilities: everyCapability,
      staging: leadDecisionStaging(),
    }),
  ).filter((definition) => "limit" in definition.shape(z));

  assert.deepEqual(
    limited.map(({ name }) => name).sort(),
    Object.keys(pageBounds).sort(),
  );
  for (const { name, shape } of limited) {
    const { limit } = shape(z);
    assert.ok(
      limit.safeParse(pageBounds[name]).success,
      `${name} at its bound`,
    );
    assert.ok(
      !limit.safeParse(pageBounds[name] + 1).success,
      `${name} past it`,
    );
  }
});

test("the server the runtime is handed carries exactly the tools the roster admits", () => {
  const seen = [];
  const sdk = {
    z,
    tool: (name, description, shape, handler) => ({
      name,
      description,
      shape,
      handler,
    }),
    createSdkMcpServer: (options) => {
      seen.push(options);
      return options;
    },
  };

  const server = chuggyToolServer(
    chuggyToolContext(task, bearer, {
      capabilities: ["ProjectRead"],
      staging: leadDecisionStaging(),
    }),
    sdk,
  );

  assert.equal(seen.length, 1);
  assert.equal(server.timeout, chuggyToolTimeoutMs);
  assert.deepEqual(
    server.tools.map(({ name }) => name),
    sessionCapabilityTools.ProjectRead,
  );
  for (const { description } of server.tools)
    assert.ok(description.length > 0, "a registered tool describes nothing");
});

/**
 * The decision channel through the server's own registration, which is where a
 * staged answer meets the protocol. The tools' own suite holds each answer's
 * text; this holds the bridge that carries it.
 */
test("a decision tool the server registers answers a well-formed result", async () => {
  const staging = leadDecisionStaging();
  staging.reset(
    JSON.stringify({ candidates: [{ ticket: 4, ticketVersion: 2 }] }),
  );
  const { api, call } = toolsOf({ staging });

  const answer = await call("dispatch", {
    ticket: 4,
    expectedTicketVersion: 2,
  });

  assert.deepEqual(answer.content, [
    { type: "text", text: "dispatch staged for ticket 4" },
  ]);
  assert.ok(answer.isError === undefined);
  assert.equal(api.calls.length, 0, "a decision tool wrote something");
  assert.equal(staging.document().dispatches.length, 1);
});

test("every read answers one page, relays the route's own body and names its cursor", async () => {
  const body = JSON.stringify({ tickets: [], nextAfter: 41 });
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("list_tickets", { after: 40, limit: 25 });

  assert.equal(api.calls.length, 1, "one tool call walked more than one page");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy?after=40&limit=25",
  );
  assert.equal(api.calls[0].method, "GET");
  assert.equal(textOf(answer), `HTTP 200\n${body}`);
  assert.ok(answer.isError === undefined);
});

test("a page larger than the pod draws is refused rather than answered cut", async () => {
  assert.ok(
    chuggyToolAnswerBytesMax < chuggyToolResponseBytesMax,
    "a body cut at the draw bound is over the answer bound, which is what refuses it",
  );
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: "x".repeat(70_000),
  }));

  const answer = await call("read_ticket", { ticket: 7 });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /larger than the/);
  assert.ok(!textOf(answer).includes("xxx"), "a cut body was answered anyway");
});

/**
 * What the refusal tells the model to do, which is nothing it can do for a tool
 * with no page bound and nothing again for one already asking for a single item.
 * A remedy the caller has already taken is a loop.
 */
test("the refusal names what this caller can lower, and says so where there is nothing", async () => {
  const body = "x".repeat(70_000);
  for (const [name, args, remedy] of [
    [
      "list_executions",
      { limit: 100 },
      /list_executions is already asking for one; move past it with cursor\.$/,
    ],
    [
      "list_tickets",
      { limit: 1 },
      /list_tickets is already asking for one; move past it with after\.$/,
    ],
    [
      "list_tickets",
      { order: "RecentActivity", limit: 1 },
      /list_tickets is already asking for one, so this one cannot be answered\.$/,
    ],
    [
      "read_refusals",
      {},
      /read_refusals is already asking for one, so this one cannot be answered\.$/,
    ],
    [
      "read_thread",
      { session: "t-1", limit: 1 },
      /read_thread is already asking for one; move past it with before\.$/,
    ],
    [
      "read_execution",
      { execution: "e-1" },
      /read_execution takes no limit, so this one cannot be answered\.$/,
    ],
  ]) {
    const answer = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body })),
    );

    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), remedy, name);
  }

  // Every roster array is capped, and zod stops at the cap, so a refusal too
  // large to store takes a shape that is not.
  const refused = await chuggyToolHandler(
    {
      name: "uncapped",
      shape: (held) => ({ phase: held.array(held.string().min(1)) }),
      call: () => "",
    },
    z,
  )({ phase: Array.from({ length: 4_096 }, () => "") });

  assert.equal(refused.isError, true);
  assert.match(
    textOf(refused),
    /uncapped refused its arguments and asked for nothing\.$/,
  );
});

/**
 * The bound at its own edge, over the relays that answer a route's body. The
 * weight is the escaped one because that is what the entry's line is charged,
 * and a page under the wire bound can be over this one.
 */
test("an answer at the bound is served and one over it never reaches the model", async () => {
  const head = "HTTP 200\n";
  const room = chuggyToolAnswerBytesMax - chuggyToolAnswerBytes(head);
  for (const [name, args] of [
    ["list_executions", { limit: 100 }],
    ["read_thread", { session: "t-1", limit: 32 }],
  ]) {
    const at = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body: "x".repeat(room) })),
    );
    const over = await routeOf(
      name,
      args,
      apiOf(() => ({ status: 200, body: "x".repeat(room + 1) })),
    );

    assert.ok(at.isError === undefined, name);
    assert.equal(
      chuggyToolAnswerBytes(textOf(at)),
      chuggyToolAnswerBytesMax,
      name,
    );
    assert.equal(over.isError, true, name);
    assert.match(textOf(over), /larger than the/, name);
    assert.ok(!textOf(over).includes("xxx"), name);
  }
});

/**
 * The tool #569 was filed on, against a batch of the size the plane refused
 * that session for. The route pages by store batch and a batch is bounded by
 * the store's own line bound, so the answer has to be cut below the page.
 */
test("a thread transcript of one full batch is read whole, page by page, under the bound", async () => {
  const entries = Array.from({ length: 89 }, (_, index) => ({
    uuid: `u-${String(index)}`,
    type: "assistant",
    message: { role: "assistant", content: "x".repeat(700) },
  }));
  const body = JSON.stringify({
    stream: "t-1",
    entries,
    held: ["u-1"],
    elided: 0,
    truncated: false,
  });
  assert.ok(
    chuggyToolAnswerBytes(body) > chuggyToolAnswerBytesMax,
    "the batch under test is smaller than one answer",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));
  const read = [];
  let cursor = {};

  for (let page = 0; page < 64; page += 1) {
    const answer = await call("read_thread_transcript", {
      session: "t-1",
      ...cursor,
    });

    assert.ok(answer.isError === undefined, `page ${String(page)} was refused`);
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
      `page ${String(page)} is over the bound`,
    );
    const given = JSON.parse(textOf(answer));
    read.push(...given.entries.map(({ uuid }) => uuid));
    if (given.next === undefined) break;
    cursor = given.next;
  }

  assert.deepEqual(
    read,
    entries.map(({ uuid }) => uuid),
    "the transcript was not read whole",
  );
  assert.ok(api.calls.length > 1, "one answer carried a whole batch");
  assert.ok(
    api.calls.every(({ path }) => path.includes("limit=1")),
    "a transcript read asked for more than the batch it cuts from",
  );
});

/**
 * The lead's transcript at the weight its route answered on a live project: a
 * page under the bound as the route sends it and over it as an answer escapes
 * it. It is answered in part, and the read after resumes inside the same batch.
 */
test("a lead transcript page a little over the bound is answered across two reads", async () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    uuid: `u-${String(index)}`,
    type: "assistant",
    message: { role: "assistant", content: "x".repeat(936) },
  }));
  const body = JSON.stringify({
    stream: "lead-1",
    entries,
    elided: 0,
    truncated: false,
    nextAfter: 1,
  });
  assert.ok(
    Buffer.byteLength(body) <= chuggyToolAnswerBytesMax &&
      chuggyToolAnswerBytes(body) > chuggyToolAnswerBytesMax,
    "the page under test is not one the bound falls inside",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const answers = [await call("read_lead_transcript", {})];
  const first = JSON.parse(textOf(answers[0]));
  answers.push(await call("read_lead_transcript", first.next));
  const second = JSON.parse(textOf(answers[1]));

  for (const answer of answers) {
    assert.ok(answer.isError === undefined);
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
    );
  }
  assert.deepEqual(first.next, { after: 0, entry: first.entries.length });
  assert.ok(first.entries.length > 0 && second.entries.length > 0);
  assert.deepEqual([...first.entries, ...second.entries], entries);
  assert.deepEqual(second.next, { after: 1, entry: 0 });
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [
      "/api/v1/tenants/vteng/projects/chuggy/lead/transcript?limit=1",
      "/api/v1/tenants/vteng/projects/chuggy/lead/transcript?after=0&limit=1",
    ],
  );
});

/** One batch of a run's transcript as its route answers it, a line for each event. */
function runBatchOf(batch, events) {
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return {
    batch,
    recordedAt: "2026-10-22T12:00:00.000Z",
    bytes: Buffer.byteLength(content),
    read: "Content",
    content,
  };
}

/** One page of a run's transcript as its route answers it. */
function runPageOf(batches, fields = {}) {
  return JSON.stringify({
    batches,
    observedAt: "2026-10-22T12:00:05.000Z",
    complete: true,
    ...fields,
  });
}

/** One event a run wrote, its text `filler` repeated `count` times. */
function runEventOf(uuid, filler, count) {
  return {
    type: "assistant",
    uuid,
    message: { role: "assistant", content: filler.repeat(count) },
  };
}

/** A run's transcript read the way a caller reads it, page after page: the events given whole, those previewed, and every answer. */
async function runWalked(call, pagesMax) {
  const read = [];
  const previews = [];
  const answers = [];
  let cursor = {};
  for (let page = 0; page < pagesMax; page += 1) {
    const answer = await call("read_run_transcript", {
      execution: "e-1",
      attempt: "a-1",
      ...cursor,
    });
    answers.push(answer);
    assert.ok(answer.isError === undefined, `page ${String(page)} was refused`);
    const given = JSON.parse(textOf(answer));
    for (const entry of given.entries)
      if (entry.preview === undefined) read.push(entry);
      else previews.push(entry);
    if (given.next === undefined) return { read, previews, answers };
    cursor = given.next;
  }
  assert.fail("the walk did not terminate");
}

test("a run transcript page of the most batches, each full, is read whole, page by page, under the bound", async () => {
  const events = [];
  const batches = [];
  for (let batch = 1; batch <= runTranscriptPageBatchesMax; batch += 1) {
    const held = [];
    for (;;) {
      const event = runEventOf(
        `r-${String(batch)}-${String(held.length)}`,
        'say "x" ',
        512,
      );
      if (
        runBatchOf(batch, [...held, event]).bytes > runTranscriptBatchBytesMax
      )
        break;
      held.push(event);
    }
    events.push(...held);
    batches.push(runBatchOf(batch, held));
  }
  const body = runPageOf(batches);
  assert.ok(
    Buffer.byteLength(body) > chuggyTranscriptBodyBytesMax &&
      Buffer.byteLength(body) <= chuggyToolRunTranscriptResponseBytesMax,
    "the page under test is not one only the run's own draw bound admits",
  );
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const { read, previews, answers } = await runWalked(call, 1_024);

  assert.deepEqual(read, events, "the transcript was not read whole");
  assert.deepEqual(previews, []);
  for (const answer of answers)
    assert.ok(
      chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax,
    );
  assert.ok(answers.length > runTranscriptPageBatchesMax);
  assert.ok(
    api.calls.every(({ path }) =>
      /\/executions\/e-1\/attempts\/a-1\/transcript(\?after=0)?$/u.test(path),
    ),
    "a read moved off the page its walk had not finished",
  );
});

test("a run event of the largest size, too heavy for one answer as the transcript escapes it, is previewed and the walk moves past it", async () => {
  const empty = runEventOf("r-2", "", 0);
  const heavy = runEventOf(
    "r-2",
    "\\",
    Math.floor(
      (runTranscriptEventBytesMax - Buffer.byteLength(JSON.stringify(empty))) /
        2,
    ),
  );
  const line = JSON.stringify(heavy);
  assert.ok(Buffer.byteLength(line) <= runTranscriptEventBytesMax);
  assert.ok(chuggyToolAnswerBytes(line) > chuggyToolAnswerBytesMax);
  const light = [runEventOf("r-1", "x", 40), runEventOf("r-3", "x", 40)];
  const body = runPageOf([runBatchOf(1, [light[0], heavy, light[1]])]);
  const { call } = toolsOf({}, () => ({ status: 200, body }));

  const { read, previews } = await runWalked(call, 8);

  assert.deepEqual(read, light);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].uuid, "r-2");
  assert.equal(previews[0].type, "assistant");
  assert.equal(previews[0].bytes, Buffer.byteLength(line));
});

test("a run transcript page at its draw bound is read, and one past it is refused", async () => {
  const page = runPageOf([runBatchOf(1, [runEventOf("r-1", "x", 8)])]);
  const at = `${page}${" ".repeat(
    chuggyToolRunTranscriptResponseBytesMax - Buffer.byteLength(page),
  )}`;
  const args = { execution: "e-1", attempt: "a-1" };

  const read = await routeOf(
    "read_run_transcript",
    args,
    apiOf(() => ({ status: 200, body: at })),
  );
  const over = await routeOf(
    "read_run_transcript",
    args,
    apiOf(() => ({ status: 200, body: `${at} ` })),
  );

  assert.ok(read.isError === undefined);
  assert.equal(JSON.parse(textOf(read)).entries.length, 1);
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolRunTranscriptResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

/** What `read_run_error` answers when its route answers `content`, read from the route it names. */
async function runErrorRead(content) {
  const api = apiOf(() => ({
    status: 200,
    body: JSON.stringify({ read: "Content", content }),
  }));
  const answer = await routeOf(
    "read_run_error",
    { execution: "e-1", attempt: "a-1" },
    api,
  );
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    ["/api/v1/tenants/vteng/projects/chuggy/executions/e-1/attempts/a-1/error"],
  );
  return answer;
}

test("an attempt's error text is answered whole, with its size", async () => {
  const content =
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";

  const answer = await runErrorRead(content);

  assert.ok(answer.isError === undefined);
  assert.deepEqual(JSON.parse(textOf(answer)), {
    bytes: Buffer.byteLength(content),
    content,
  });
});

test("an error text as large as an upload, every line of it coloured, is answered by the longest end that fits, with the size of the whole", async () => {
  const why = "the line that says why\n";
  const line = "\u001b[31m\u0001rror\u001b[0m: \u001b[2Kstep\n";
  const head = line.repeat(
    Math.floor(
      (workerPlaneUploadBytesMax - Buffer.byteLength(why)) /
        Buffer.byteLength(line),
    ),
  );
  const content = `${head}${"\u001b".repeat(
    workerPlaneUploadBytesMax -
      Buffer.byteLength(head) -
      Buffer.byteLength(why),
  )}${why}`;
  const body = JSON.stringify({ read: "Content", content });
  assert.equal(Buffer.byteLength(content), workerPlaneUploadBytesMax);
  assert.ok(
    Buffer.byteLength(body) > chuggyToolResponseBytesMax &&
      Buffer.byteLength(body) <= chuggyToolRunErrorResponseBytesMax,
    "the text under test is not one only the error text's own draw bound admits",
  );

  const answer = await runErrorRead(content);

  assert.ok(answer.isError === undefined);
  assert.ok(chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax);
  const { bytes, tail, ...rest } = JSON.parse(textOf(answer));
  assert.deepEqual(rest, {});
  assert.equal(bytes, workerPlaneUploadBytesMax);
  assert.ok(content.endsWith(tail) && tail.endsWith(why));
  assert.ok(
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes, tail: content.slice(-tail.length - 1) }),
    ) > chuggyToolAnswerBytesMax,
    "a longer end would have fit",
  );
});

test("an error text's end is the longest that fits, and starts on a whole character, never inside a surrogate pair", async () => {
  for (let pad = 0; pad < 8; pad += 1) {
    const content = `${"\u{1F600}y".repeat(12_000)}${"z".repeat(pad)}`;

    const answer = await runErrorRead(content);

    const { tail } = JSON.parse(textOf(answer));
    assert.ok(content.endsWith(tail), String(pad));
    assert.ok(
      tail.isWellFormed(),
      `the end of pad ${String(pad)} splits a pair`,
    );
    const before = [...content.slice(0, content.length - tail.length)].at(-1);
    assert.ok(
      chuggyToolAnswerBytes(
        JSON.stringify({
          bytes: Buffer.byteLength(content),
          tail: `${before}${tail}`,
        }),
      ) > chuggyToolAnswerBytesMax,
      `a longer end of pad ${String(pad)} would have fit`,
    );
  }
});

test("a plain error text's end is the longest that fits", async () => {
  const content = "a".repeat(100_000);

  const answer = await runErrorRead(content);

  const { bytes, tail } = JSON.parse(textOf(answer));
  assert.ok(content.endsWith(tail));
  assert.ok(
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes, tail: content.slice(-tail.length - 1) }),
    ) > chuggyToolAnswerBytesMax,
    "a longer end would have fit",
  );
});

test("an error text too large to answer whole is answered by an end that leaves some out, even where the whole would fit as an end", async () => {
  const fitsAs = (key, text) =>
    chuggyToolAnswerBytes(
      JSON.stringify({ bytes: Buffer.byteLength(text), [key]: text }),
    ) <= chuggyToolAnswerBytesMax;
  let content = "";
  for (let length = chuggyToolAnswerBytesMax; !content; length -= 1) {
    const text = "a".repeat(length);
    if (!fitsAs("content", text) && fitsAs("tail", text)) content = text;
    assert.ok(length > 0, "no text found to test");
  }

  const answer = await runErrorRead(content);

  const { bytes, tail, ...rest } = JSON.parse(textOf(answer));
  assert.deepEqual(rest, {});
  assert.equal(bytes, content.length);
  assert.equal(tail, content.slice(1));
});

test("an attempt with no error text is answered as having none, and not as a failure", async () => {
  const api = apiOf(() => ({
    status: 404,
    body: JSON.stringify({
      error: { code: "NotFound", message: "Resource not found." },
    }),
  }));

  const answer = await routeOf(
    "read_run_error",
    { execution: "e-1", attempt: "a-1" },
    api,
  );

  assert.ok(answer.isError === undefined);
  assert.match(textOf(answer), /^This attempt has no error text/u);
});

test("an error text the plane cannot answer now, or cannot verify, is relayed as the refusal it is", async () => {
  for (const [status, code] of [
    [409, "RunErrorCorrupt"],
    [503, "RunErrorUnavailable"],
  ]) {
    const body = JSON.stringify({ error: { code, message: code } });

    const answer = await routeOf(
      "read_run_error",
      { execution: "e-1", attempt: "a-1" },
      apiOf(() => ({ status, body })),
    );

    assert.equal(answer.isError, true, code);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, code);
  }
});

test("an error text route's body that is not one error text is refused rather than answered", async () => {
  for (const body of [
    "{}",
    "not JSON",
    JSON.stringify({ read: "Content", content: 7 }),
    JSON.stringify({ read: "Missing", content: "x" }),
  ]) {
    const answer = await routeOf(
      "read_run_error",
      { execution: "e-1", attempt: "a-1" },
      apiOf(() => ({ status: 200, body })),
    );

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not one error text/u, body);
  }
});

test("an error text's answer at its draw bound is read, and one past it is refused", async () => {
  const body = JSON.stringify({ read: "Content", content: "x" });
  const at = `${body}${" ".repeat(
    chuggyToolRunErrorResponseBytesMax - Buffer.byteLength(body),
  )}`;
  const args = { execution: "e-1", attempt: "a-1" };

  const read = await routeOf(
    "read_run_error",
    args,
    apiOf(() => ({ status: 200, body: at })),
  );
  const over = await routeOf(
    "read_run_error",
    args,
    apiOf(() => ({ status: 200, body: `${at} ` })),
  );

  assert.deepEqual(JSON.parse(textOf(read)), { bytes: 1, content: "x" });
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolRunErrorResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

/** A ticket's landings read over a route answering `body`, and the one path it asked. */
async function landingsRead(body, status = 200) {
  const api = apiOf(() => ({ status, body }));
  const answer = await routeOf("read_ticket_landings", { ticket: 7 }, api);
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    ["/api/v1/tenants/vteng/projects/chuggy/tickets/7/landings"],
  );
  return answer;
}

/**
 * A landing of the cycle given weighing `bytes` as the route answers it, of
 * backslashes, the text an answer's escaping weighs twice: every byte of a JSON
 * text escapes to at most two, and a backslash is one that does.
 */
function landingWeighing(cycle, bytes) {
  const landing = { state: "Held", cycle, held: "", pad: "" };
  const fixed = Buffer.byteLength(JSON.stringify(landing));
  const held = Math.floor((bytes - fixed) / 2);
  const weighed = {
    ...landing,
    held: "\\".repeat(held),
    pad: "a".repeat(bytes - fixed - 2 * held),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(weighed)), bytes);
  return weighed;
}

/** Whether `landings` as one answer would fit, `truncated` as given. */
function landingsFit(landings, truncated) {
  return (
    chuggyToolAnswerBytes(JSON.stringify({ landings, truncated })) <=
    chuggyToolAnswerBytesMax
  );
}

test("a ticket's landings that fit one answer are answered whole, as JSON", async () => {
  for (const truncated of [false, true]) {
    const body = {
      landings: [
        { state: "Failed", cycle: 1 },
        { state: "AwaitingMerge", cycle: 2 },
      ],
      truncated,
    };

    const answer = await landingsRead(JSON.stringify(body));

    assert.ok(answer.isError === undefined);
    assert.deepEqual(JSON.parse(textOf(answer)), body);
  }
  const none = await landingsRead(
    JSON.stringify({ landings: [], truncated: false }),
  );
  assert.deepEqual(JSON.parse(textOf(none)), {
    landings: [],
    truncated: false,
  });
});

test("the heaviest landings the route answers are drawn whole, and the newest that fit are answered", async () => {
  const landings = Array.from({ length: ticketLandingsAnsweredMax }, (_, at) =>
    landingWeighing(at + 1, chuggyToolTicketLandingBytesMax),
  );
  const body = JSON.stringify({ landings, truncated: false });
  assert.ok(
    Buffer.byteLength(body) > chuggyToolResponseBytesMax &&
      Buffer.byteLength(body) <= chuggyToolTicketLandingsResponseBytesMax,
    "the landings under test are not ones only their own draw bound admits",
  );

  const answer = await landingsRead(body);

  assert.ok(answer.isError === undefined, textOf(answer));
  assert.ok(chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax);
  const answered = JSON.parse(textOf(answer));
  assert.equal(answered.truncated, true);
  assert.ok(
    answered.landings.length > 0,
    "the newest landing was not answered",
  );
  assert.deepEqual(
    answered.landings,
    landings.slice(-answered.landings.length),
  );
  assert.ok(
    !landingsFit(landings.slice(-answered.landings.length - 1), true),
    "an older landing would have fit",
  );
});

test("landings left out to fit say so, and the route's own truncation is kept where every one fits", async () => {
  const landings = Array.from({ length: ticketLandingsAnsweredMax }, (_, at) =>
    landingWeighing(at + 1, 4_000),
  );
  const fit = landings.findLastIndex(
    (_, at) => !landingsFit(landings.slice(at), true),
  );
  assert.ok(fit > 0, "every landing under test fits one answer");

  const cut = JSON.parse(
    textOf(await landingsRead(JSON.stringify({ landings, truncated: false }))),
  );
  const whole = JSON.parse(
    textOf(
      await landingsRead(
        JSON.stringify({ landings: landings.slice(fit + 1), truncated: true }),
      ),
    ),
  );

  assert.deepEqual(cut, { landings: landings.slice(fit + 1), truncated: true });
  assert.deepEqual(whole, cut);
});

test("a newest landing too large alone is refused rather than cut", async () => {
  const landing = landingWeighing(1, chuggyToolAnswerBytesMax);

  const answer = await landingsRead(
    JSON.stringify({ landings: [landing], truncated: false }),
  );

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /newest landing is larger alone/u);
});

test("a ticket the project does not have, and a landings read the plane refuses, are relayed as the refusal they are", async () => {
  for (const [status, code] of [
    [404, "NotFound"],
    [503, "Unavailable"],
  ]) {
    const body = JSON.stringify({ error: { code, message: code } });

    const answer = await landingsRead(body, status);

    assert.equal(answer.isError, true, code);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, code);
  }
});

test("a landings route's body that is not a ticket's landings is refused rather than answered", async () => {
  for (const body of [
    "{}",
    "not JSON",
    "null",
    JSON.stringify({ landings: {}, truncated: false }),
    JSON.stringify({ landings: [], truncated: "no" }),
    JSON.stringify({
      landings: Array.from({ length: ticketLandingsAnsweredMax + 1 }, () => ({
        state: "Failed",
      })),
      truncated: false,
    }),
  ]) {
    const answer = await landingsRead(body);

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not a ticket's landings/u, body);
  }
});

test("a landings answer at its draw bound is read, and one past it is refused", async () => {
  const body = JSON.stringify({ landings: [], truncated: false });
  const at = `${body}${" ".repeat(
    chuggyToolTicketLandingsResponseBytesMax - Buffer.byteLength(body),
  )}`;

  const read = await landingsRead(at);
  const over = await landingsRead(`${at} `);

  assert.deepEqual(JSON.parse(textOf(read)), {
    landings: [],
    truncated: false,
  });
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolTicketLandingsResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

/** A project's landing queues read over a route answering `body`, and the one path it asked. */
async function landingQueuesRead(body, status = 200) {
  const api = apiOf(() => ({ status, body }));
  const answer = await routeOf("read_landing_queues", {}, api);
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    ["/api/v1/tenants/vteng/projects/chuggy/landing-queues"],
  );
  return answer;
}

/**
 * A queue held by `holder` with `waiters` behind it, naming `target` where one
 * is given, in a repository whose name is `repositoryChars` backslashes, the
 * text an answer's escaping weighs twice, and then `repositorySuffix`.
 */
function landingQueueOf(
  holder,
  waiters,
  repositoryChars = 1,
  { repositorySuffix = "", target } = {},
) {
  return {
    repository: `${"\\".repeat(repositoryChars)}${repositorySuffix}`,
    ...(target === undefined ? {} : { target }),
    holder,
    waiting: Array.from({ length: waiters }, (_, at) => holder * 1_000 + at),
  };
}

test("a project's landing queues that fit one answer are answered as the route answered them", async () => {
  for (const truncated of [false, true]) {
    const body = {
      queues: [
        { repository: "https://git.test/a.git", holder: 3, waiting: [] },
        {
          repository: "https://git.test/b.git",
          target: "release",
          holder: 5,
          waiting: [8, 13],
        },
      ],
      truncated,
    };

    const answer = await landingQueuesRead(JSON.stringify(body));

    assert.ok(answer.isError === undefined);
    assert.deepEqual(JSON.parse(textOf(answer)), body);
  }
  const none = await landingQueuesRead(
    JSON.stringify({ queues: [], truncated: false }),
  );
  assert.deepEqual(JSON.parse(textOf(none)), { queues: [], truncated: false });
});

/** Whether `left` comes before `right` in the route's order: by repository, then target, a queue naming none first. */
function landingQueueBefore(left, right) {
  return left.repository === right.repository
    ? (left.target ?? "") < (right.target ?? "")
    : left.repository < right.repository;
}

test("landing queues past one answer keep the route's first whole queues in its order and say truncated", async () => {
  const waiters = landingQueueTicketsAnsweredMax / 4 - 1;
  const queues = [
    ["a", undefined, 13],
    ["a", "main", 2],
    ["a", "release", 8],
    ["b", "main", 1],
  ].map(([repositorySuffix, target, holder]) =>
    landingQueueOf(holder, waiters, 2_000, { repositorySuffix, target }),
  );
  assert.ok(
    queues.every(
      (queue, at) => at === 0 || landingQueueBefore(queues[at - 1], queue),
    ),
    "the queues under test are in the route's order",
  );
  const body = JSON.stringify({ queues, truncated: false });
  assert.ok(
    chuggyToolAnswerBytes(body) > chuggyToolAnswerBytesMax &&
      Buffer.byteLength(body) <= chuggyToolLandingQueuesResponseBytesMax,
    "the queues under test fit one answer, or only past their draw bound",
  );

  const answer = await landingQueuesRead(body);

  assert.ok(answer.isError === undefined, textOf(answer));
  assert.ok(chuggyToolAnswerBytes(textOf(answer)) <= chuggyToolAnswerBytesMax);
  const answered = JSON.parse(textOf(answer));
  assert.equal(answered.truncated, true);
  assert.ok(answered.queues.length > 0, "no queue was answered");
  assert.deepEqual(answered.queues, queues.slice(0, answered.queues.length));
  assert.ok(
    chuggyToolAnswerBytes(
      JSON.stringify({
        queues: queues.slice(0, answered.queues.length + 1),
        truncated: true,
      }),
    ) > chuggyToolAnswerBytesMax,
    "a later queue would have fit",
  );
});

test("a route's first queue too large alone is refused rather than cut", async () => {
  const queue = landingQueueOf(1, 0, chuggyToolAnswerBytesMax);

  const answer = await landingQueuesRead(
    JSON.stringify({ queues: [queue], truncated: false }),
  );

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /the route's first queue is larger alone/u);
});

test("a landing queues read the plane refuses is relayed as the refusal it is", async () => {
  for (const [status, code] of [
    [403, "Forbidden"],
    [503, "Unavailable"],
  ]) {
    const body = JSON.stringify({ error: { code, message: code } });

    const answer = await landingQueuesRead(body, status);

    assert.equal(answer.isError, true, code);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, code);
  }
});

test("a landing queues route's body that is not a project's landing queues is refused rather than answered", async () => {
  for (const body of [
    "{}",
    "not JSON",
    "null",
    JSON.stringify({ queues: {}, truncated: false }),
    JSON.stringify({ queues: [], truncated: "no" }),
    JSON.stringify({
      queues: Array.from(
        { length: landingQueueTicketsAnsweredMax + 1 },
        (_, at) => landingQueueOf(at + 1, 0),
      ),
      truncated: false,
    }),
  ]) {
    const answer = await landingQueuesRead(body);

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not a project's landing queues/u, body);
  }
});

test("a landing queues answer at its draw bound is read, and one past it is refused", async () => {
  const body = JSON.stringify({ queues: [], truncated: false });
  const at = `${body}${" ".repeat(
    chuggyToolLandingQueuesResponseBytesMax - Buffer.byteLength(body),
  )}`;

  const read = await landingQueuesRead(at);
  const over = await landingQueuesRead(`${at} `);

  assert.deepEqual(JSON.parse(textOf(read)), { queues: [], truncated: false });
  assert.equal(over.isError, true);
  assert.match(
    textOf(over),
    new RegExp(
      `larger than the ${String(chuggyToolLandingQueuesResponseBytesMax)} bytes`,
      "u",
    ),
  );
});

test("read_landing_queues says what a holder and a waiter are, that a lone ticket waits on nobody, that no target is not the default branch, and what truncated means", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "read_landing_queues",
  );
  for (const claim of [
    /Its `holder` is the one ticket that may land on that reference now/,
    /`waiting` the tickets ranked behind it, in rank order, none of which lands there before the holder stops holding it/,
    /A ticket alone in a queue is its holder and waits on nobody/,
    /a queue naming no `target` being its tickets' that name none, which is a different queue from one naming the default branch/,
    /It answers the route's first whole queues one answer holds, in the route's order, by repository and then target, `truncated` where it leaves later ones out or the route left tickets out/,
  ])
    assert.match(description, claim);
});

test("a raise too large to store is refused like any other answer", async () => {
  const huge = "x".repeat(chuggyToolAnswerBytesMax);
  const api = {
    request: async () => {
      throw new Error(huge);
    },
  };

  const answer = await routeOf("read_ticket", { ticket: 7 }, api);

  assert.equal(answer.isError, true);
  assert.ok(!textOf(answer).includes("xxx"), "the raise was answered whole");
  assert.match(textOf(answer), /larger than the/);
});

/**
 * The entry a tool answer becomes, captured off a transcript the pinned runtime
 * wrote rather than composed here. An entry this suite composed would hold the
 * shape this suite believes in, which is what the bound is derived from.
 */
function capturedEntry() {
  return JSON.parse(
    readFileSync(new URL("./toolAnswerEntry.fixture.json", import.meta.url)),
  );
}

test("the captured entry carries one answer as many times as the bound divides by", () => {
  const entry = capturedEntry();
  const inMessage = entry.message.content[0].content[0].text;

  assert.equal(entry.toolUseResult[0].text, inMessage, "the copies differ");
  assert.equal(
    JSON.stringify(entry).split(JSON.stringify(inMessage).slice(1, -1)).length -
      1,
    chuggyToolAnswerCopiesInEntry,
    "the entry carries the answer a different number of times than the bound divides by",
  );
});

test("the reserve is wider than the captured envelope by more than the whole of it", () => {
  const entry = capturedEntry();
  entry.message.content[0].content[0].text = "";
  entry.toolUseResult[0].text = "";

  assert.ok(
    Buffer.byteLength(JSON.stringify(entry)) * 2 <=
      chuggyToolAnswerEnvelopeBytesMax,
    `the captured envelope weighs ${String(Buffer.byteLength(JSON.stringify(entry)))} bytes against a reserve of ${String(chuggyToolAnswerEnvelopeBytesMax)}`,
  );
});

/**
 * The tool's bound held against the store's, through that entry. The answer at
 * the bound goes into both copies, because that is where the runtime puts it.
 */
test("a maximal answer inside the captured entry is one batch the store can post", async () => {
  const posted = [];
  const store = sessionStoreAdapter(
    { workerPlane: { url: "http://worker-plane.test:3001" } },
    "chgs_b",
    {
      request: async (_task, _bearer, _path, init) => {
        posted.push(init.body);
        return { status: 204 };
      },
      scrub: (text) => text,
    },
  );
  const entry = capturedEntry();
  const text = `HTTP 200\n${"x".repeat(
    chuggyToolAnswerBytesMax - chuggyToolAnswerBytes("HTTP 200\n"),
  )}`;
  entry.message.content[0].content[0].text = text;
  entry.toolUseResult[0].text = text;

  await store.append({ sessionId: entry.sessionId }, [entry]);

  assert.equal(chuggyToolAnswerBytes(text), chuggyToolAnswerBytesMax);
  assert.equal(posted.length, 1);
  assert.ok(
    posted[0].length <= sessionStoreBatchBytesMax,
    `the entry posted ${String(posted[0].length)} bytes and one batch holds ${String(sessionStoreBatchBytesMax)}`,
  );
});

/** One tool's own definition behind its handler, with no session's roster between. */
function routeOf(name, args, api) {
  const definition = chuggyProjectTools.find((held) => held.name === name);
  return chuggyToolHandler(
    {
      ...definition,
      call: (called) =>
        definition.call(
          chuggyToolContext(task, bearer, { request: api.request }),
          called,
        ),
    },
    z,
  )(args);
}

/** Each read, with arguments, and the route under the project it reaches. */
const readRoutes = [
  [["read_ticket", { ticket: 7 }], "/tickets/7"],
  [["read_draft", { ticket: 7 }], "/drafts/7"],
  [["list_drafts", { limit: 5 }], "/drafts?limit=5"],
  [
    ["list_configurations", { limit: 5 }],
    "/configurations?latest=true&limit=5",
  ],
  [
    ["list_configurations", { limit: 5, latest: false }],
    "/configurations?latest=false&limit=5",
  ],
  [["read_configuration", { revision: "r/1" }], "/configurations/r%2F1"],
  [
    ["read_decision_log", { after: 3, limit: 2 }],
    "/selector-history?after=3&limit=2",
  ],
  [["read_refusals", { limit: 4 }], "/agentic-refusals?limit=4"],
  [["read_ticket_refusals", { ticket: 9 }], "/tickets/9/agentic-refusals"],
  [["read_ticket_landings", { ticket: 9 }], "/tickets/9/landings"],
  [["read_landing_queues", {}], "/landing-queues"],
  [["read_lead", {}], "/lead"],
  [
    ["read_lead_transcript", { after: 2, entry: 3 }],
    "/lead/transcript?after=2&limit=1",
  ],
  [
    ["list_executions", { ticket: 3, state: ["Running"] }],
    "/executions?ticket=3&state=Running",
  ],
  [["read_execution", { execution: "e-1" }], "/executions/e-1"],
  [
    [
      "read_run_transcript",
      { execution: "e-1", attempt: "a-1", after: 2, entry: 3 },
    ],
    "/executions/e-1/attempts/a-1/transcript?after=2",
  ],
  [
    ["read_run_error", { execution: "e-1", attempt: "a-1" }],
    "/executions/e-1/attempts/a-1/error",
  ],
  [["read_operation", { operation: "o-1" }], "/operations/o-1"],
  [["initialize_draft", { revision: "r1" }], "/draft-initializations/r1"],
  [["list_threads", {}], "/threads"],
  [["read_thread", { session: "thread-1/a" }], "/threads/thread-1%2Fa"],
  [
    ["read_thread", { session: "thread-1", before: 7, limit: 32 }],
    "/threads/thread-1?before=7&limit=32",
  ],
  [
    ["read_thread_transcript", { session: "thread-1", after: 2, entry: 3 }],
    "/threads/thread-1/transcript?after=2&limit=1",
  ],
  [["list_repositories", {}], "/repositories"],
  [["read_abilities", {}], "/abilities"],
  [
    ["fetch_image", { artifact: "image/png:ce47" }],
    "/artifacts/image%2Fpng%3Ace47",
  ],
];

test("each read reaches the route its roster names, and only it", async () => {
  for (const [[name, args], suffix] of readRoutes) {
    const api = apiOf();

    await routeOf(name, args, api);

    assert.equal(
      api.calls[0].path,
      `/api/v1/tenants/vteng/projects/chuggy${suffix}`,
      name,
    );
  }
});

test("read_abilities answers the session's principal and permits as its route answered them, and sends nothing", async () => {
  const body = JSON.stringify({
    principal: "session:thread-1",
    mutate: true,
    dispatch: false,
    manageSelector: false,
    overrideTicketConfig: false,
    skipPlannedEvaluations: true,
    administer: false,
  });
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("read_abilities", {});

  assert.deepEqual(
    api.calls.map(({ path, method }) => [method, path]),
    [["GET", "/api/v1/tenants/vteng/projects/chuggy/abilities"]],
  );
  assert.equal(api.calls[0].init.body, undefined);
  assert.equal(textOf(answer), `HTTP 200\n${body}`);
  assert.ok(answer.isError === undefined);
});

/** A listing of one plain, one retired and one unreached binding, as the route answers it. */
const repositoriesListed = [
  {
    repository: "https://github.com/vteng/chuggy.git",
    boundAt: "2026-10-01T00:00:00.000Z",
    landing: { mode: "PullRequest" },
    pipelinesWritable: false,
    configured: true,
    configurationsHeld: { result: "Imported", count: 2 },
  },
  {
    repository: "https://github.com/vteng/chuggy-common.git",
    boundAt: "2026-10-02T00:00:00.000Z",
    landing: { mode: "Push" },
    pipelinesWritable: false,
    retiredAt: "2026-10-03T00:00:00.000Z",
    configured: false,
  },
  {
    repository: "https://github.com/vteng/chuggy-docs.git",
    boundAt: "2026-10-04T00:00:00.000Z",
    landing: { mode: "PullRequest" },
    pipelinesWritable: true,
    configured: true,
    configurationsHeld: { result: "Bootstrapped", revision: "r0" },
    workerReach: {
      reach: "Unselected",
      installationId: "42",
      settingsUrl: "https://github.com/settings/installations/42",
    },
  },
];

test("the project's repositories are read from its own repositories route, and each row says whether a ticket may be filed in it and is otherwise as answered", async () => {
  const { api, call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({ repositories: repositoriesListed }),
  }));

  const answer = await call("list_repositories", {});

  assert.deepEqual(
    api.calls.map(({ path, method }) => [method, path]),
    [["GET", "/api/v1/tenants/vteng/projects/chuggy/repositories"]],
  );
  assert.ok(answer.isError === undefined);
  const [status, body] = textOf(answer).split("\n");
  assert.equal(status, "HTTP 200");
  const [plain, retired, unreached] = JSON.parse(body).repositories;
  assert.deepEqual(plain, { ...repositoriesListed[0], fileable: true });
  assert.deepEqual(retired, {
    ...repositoriesListed[1],
    fileable: false,
    fileableReason:
      "Retired at 2026-10-03T00:00:00.000Z, so a draft naming it is refused.",
  });
  assert.deepEqual(unreached, {
    ...repositoriesListed[2],
    fileable: false,
    fileableReason:
      "Not reached by the worker app (workerReach Unselected), so a ticket in it stops at its clone.",
  });
});

test("a binding the forge could not say the worker app reaches is not fileable, and says so", async () => {
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({
      repositories: [
        { ...repositoriesListed[0], workerReach: { reach: "Unknown" } },
      ],
    }),
  }));

  const [row] = JSON.parse(
    textOf(await call("list_repositories", {})).split("\n")[1],
  ).repositories;

  assert.equal(row.fileable, false);
  assert.match(
    row.fileableReason,
    /could not say whether the worker app reaches it/,
  );
});

/** A page of a Ready catalog revision, an Incomplete one and an Authored one, as the route answers it. */
const configurationsListed = {
  configurations: [
    {
      readiness: "Ready",
      revision: "r3",
      parent: "r2",
      digest: "sha256:cd",
      createdAt: "2026-10-05T00:00:00.000Z",
      provenance: {
        source: "Repository",
        repository: "https://github.com/vteng/chuggy.git",
        commit: "c3",
        path: "main.json",
        name: "main",
      },
      version: { name: "main", number: 3 },
      image: "registry.example/worker@sha256:ef",
      worker: { name: "chuggy-worker", version: "1" },
      practices: ["review"],
      finalization: { approvalRequired: false },
      evaluationStagesCount: 2,
      catalog: {
        workloads: ["build"],
        plans: ["full"],
        finalizers: ["merge"],
        defaults: { work: "build", evaluation: "full", finalization: "merge" },
      },
    },
    {
      readiness: "Incomplete",
      revision: "r2",
      digest: "sha256:ab",
      createdAt: "2026-10-04T00:00:00.000Z",
      provenance: {
        source: "Repository",
        repository: "https://github.com/vteng/chuggy-docs.git",
        commit: "c2",
        path: "docs.json",
        name: "docs",
      },
    },
    {
      readiness: "Ready",
      revision: "r0",
      digest: "sha256:00",
      createdAt: "2026-10-01T00:00:00.000Z",
      provenance: { source: "Authored" },
      version: { name: "bootstrap", number: 1 },
      image: "registry.example/worker@sha256:01",
      practices: [],
      finalization: { approvalRequired: true },
      evaluationStagesCount: 1,
    },
  ],
  nextCursor: "page-2",
};

test("a page of configuration revisions is answered as each one's revision, name, repository, readiness and catalog, and its cursor", async () => {
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify(configurationsListed),
  }));

  const answer = await call("list_configurations", {});

  assert.ok(answer.isError === undefined);
  const [status, body] = textOf(answer).split("\n");
  assert.equal(status, "HTTP 200");
  assert.deepEqual(JSON.parse(body), {
    configurations: [
      {
        revision: "r3",
        name: "main",
        repository: "https://github.com/vteng/chuggy.git",
        readiness: "Ready",
        catalog: configurationsListed.configurations[0].catalog,
      },
      {
        revision: "r2",
        name: "docs",
        repository: "https://github.com/vteng/chuggy-docs.git",
        readiness: "Incomplete",
      },
      { revision: "r0", name: "bootstrap", readiness: "Ready" },
    ],
    nextCursor: "page-2",
  });
});

/** A draft's initialization as the route answers it, its configuration's canonical document included. */
const draftInitialized = {
  configuration: {
    partition: "vteng/chuggy",
    revision: "r1",
    canonical: JSON.stringify({ version: 2, prompt: "x".repeat(4_096) }),
    digest: "sha256:ab",
    version: 2,
  },
  fence: { projectSequence: 12, configurationDigest: "sha256:ab" },
  defaults: { program: { 1: { evaluators: [] } }, dependencies: [] },
  choices: { programStagesMax: 4, evaluatorsMax: 8 },
  dependencyCandidates: [3, 5],
  dependencyCandidatesTruncated: false,
  commandedCheckStage: 1,
  commandedCheckStageNote: "stage 1",
};

test("a draft's initialization is answered without its configuration's canonical document or its dependency candidates, and otherwise as answered", async () => {
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify(draftInitialized),
  }));

  const answer = await call("initialize_draft", { revision: "r1" });

  assert.ok(answer.isError === undefined);
  const [status, body] = textOf(answer).split("\n");
  assert.equal(status, "HTTP 200");
  const { canonical, ...identified } = draftInitialized.configuration;
  assert.ok(canonical.length > 0);
  const expected = { ...draftInitialized, configuration: identified };
  delete expected.dependencyCandidates;
  delete expected.dependencyCandidatesTruncated;
  assert.deepEqual(JSON.parse(body), expected);
  assert.ok(!body.includes("canonical"), "the canonical document was answered");
  assert.ok(
    !body.includes("dependencyCandidates"),
    "the dependency candidates were answered",
  );
});

/** A configuration route's body carrying `document` as its canonical. */
function configurationAnswered(document) {
  return JSON.stringify({
    partition: { tenant: task.tenant, project: task.project },
    revision: "r1",
    canonical: JSON.stringify(document),
    digest: "sha256:ab",
  });
}

/** The tools with the configuration route answering `document`. */
function configurationToolsOf(document) {
  return toolsOf({}, () => ({
    status: 200,
    body: configurationAnswered(document),
  }));
}

/** A read_configuration answer that is no refusal, parsed past its status line. */
function configurationRead(answer) {
  assert.equal(answer.isError, undefined, textOf(answer));
  const text = textOf(answer);
  assert.equal(text.slice(0, text.indexOf("\n")), "HTTP 200");
  return JSON.parse(text.slice(text.indexOf("\n") + 1));
}

/**
 * Every piece of a string or every entry of an outline at `path`, read on by
 * `offset` until nothing is left, with how many answers that took. The reads
 * are bounded by the characters they could ever answer.
 */
async function configurationReadOn(call, path, length) {
  const pieces = [];
  let offset;
  for (let reads = 1; reads <= length; reads += 1) {
    const read = configurationRead(
      await call("read_configuration", { revision: "r1", path, offset }),
    );
    assert.equal(read.offset, offset ?? 0);
    pieces.push(read);
    const left = read.charsLeft ?? read.entriesLeft;
    if (left === 0) return pieces;
    offset = read.offset + (read.text?.length ?? read.outline.length);
    assert.match(read.note, new RegExp(`offset ${String(offset)} reads on`));
  }
  assert.fail("the reads never reached the end");
}

/** A prompt as long as `chars`, escaped twice over in a route's body and holding a pair that is one code point. */
function configurationPrompt(chars) {
  return 'Read "the diff" 🙂.\n'.repeat(chars / 20);
}

/** A catalog whose canonical fits a configuration, and whose route body is more than one answer holds and more than an ordinary read draws. */
const catalogOverBounds = {
  version: 2,
  workloads: Object.fromEntries(
    ["work", "review", "security", "docs", "tests"].map((name) => [
      name,
      { prompt: configurationPrompt(10_000), model: "opus" },
    ]),
  ),
  plans: { standard: { stages: [{ name: "review", evaluators: ["review"] }] } },
  finalizers: { land: { landing: "PullRequest" } },
  defaults: { work: "work", evaluation: "standard", finalization: "land" },
};

test("a catalog over both bounds is answered as an outline with no path, and a workload and its prompt whole by path", async () => {
  const body = configurationAnswered(catalogOverBounds);
  assert.ok(Buffer.byteLength(body) > chuggyToolResponseBytesMax);
  const { call } = configurationToolsOf(catalogOverBounds);

  const outline = configurationRead(
    await call("read_configuration", { revision: "r1" }),
  );
  assert.deepEqual(outline.path, []);
  assert.equal(outline.kind, "object");
  assert.equal(outline.entriesLeft, 0);
  assert.deepEqual(outline.outline, [
    { key: "version", value: 2 },
    {
      key: "workloads",
      kind: "object",
      entries: 5,
      chars: JSON.stringify(catalogOverBounds.workloads).length,
    },
    { key: "plans", value: catalogOverBounds.plans },
    { key: "finalizers", value: catalogOverBounds.finalizers },
    { key: "defaults", value: catalogOverBounds.defaults },
  ]);
  assert.match(outline.note, /Append an entry's key to path/);

  assert.deepEqual(
    configurationRead(
      await call("read_configuration", {
        revision: "r1",
        path: ["workloads", "review"],
      }),
    ),
    catalogOverBounds.workloads.review,
  );
  assert.equal(
    configurationRead(
      await call("read_configuration", {
        revision: "r1",
        path: ["workloads", "review", "prompt"],
      }),
    ),
    catalogOverBounds.workloads.review.prompt,
  );
});

test("a prompt too long for one answer is read to its end by offset, never split inside a code point", async () => {
  const prompt = `${configurationPrompt(20_000)}${"🙂".repeat(10_000)}`;
  const { call } = configurationToolsOf({
    version: 2,
    workloads: { review: { prompt } },
  });
  const path = ["workloads", "review", "prompt"];

  const pieces = await configurationReadOn(call, path, prompt.length);

  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.text.isWellFormed());
  assert.equal(pieces.map(({ text }) => text).join(""), prompt);
  const past = await call("read_configuration", {
    revision: "r1",
    path,
    offset: prompt.length + 1,
  });
  assert.equal(past.isError, true);
  assert.match(textOf(past), /past the end of this string/);
});

test("an outline too long for one answer is read to its end by offset", async () => {
  const workloads = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => [
      `workload-${String(index)}`,
      { prompt: `${"p".repeat(180)}${String(index)}` },
    ]),
  );
  for (const child of Object.values(workloads))
    assert.ok(JSON.stringify(child).length <= readAtPathChildCharsMax);
  const { call } = configurationToolsOf({ version: 2, workloads });

  const pieces = await configurationReadOn(
    call,
    ["workloads"],
    Object.keys(workloads).length,
  );

  assert.ok(pieces.length > 1);
  assert.deepEqual(
    pieces.flatMap(({ outline }) => outline),
    Object.entries(workloads).map(([key, value]) => ({ key, value })),
  );
});

test("a version 1 document is navigated as a catalog is", async () => {
  const prompt = configurationPrompt(40_000);
  const document = {
    worker: { mode: { type: "SingleAgent", agent: "Claude" } },
    review: { prompt },
    evaluations: [{ prompt: "check" }],
  };
  const { call } = configurationToolsOf(document);

  const outline = configurationRead(
    await call("read_configuration", { revision: "r1" }),
  );
  assert.deepEqual(
    outline.outline.map(({ key }) => key),
    ["worker", "review", "evaluations"],
  );
  assert.deepEqual(outline.outline[1], {
    key: "review",
    kind: "object",
    entries: 1,
    chars: JSON.stringify(document.review).length,
  });
  for (const path of [
    ["evaluations", 0],
    ["evaluations", "0"],
  ])
    assert.deepEqual(
      configurationRead(
        await call("read_configuration", { revision: "r1", path }),
      ),
      document.evaluations[0],
    );
  const pieces = await configurationReadOn(
    call,
    ["review", "prompt"],
    prompt.length,
  );
  assert.equal(pieces.map(({ text }) => text).join(""), prompt);
});

test("a configuration that fits one answer is answered as the route answered it", async () => {
  const body = configurationAnswered({
    version: 2,
    workloads: { review: { prompt: "Review it." } },
  });
  const { call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("read_configuration", { revision: "r1" });

  assert.equal(answer.isError, undefined);
  assert.equal(textOf(answer), `HTTP 200\n${body}`);
});

test("a configuration whose route body is more than one answer holds, and whose document is not, is answered as its document whole", async () => {
  const document = {
    version: 2,
    workloads: { review: { prompt: configurationPrompt(17_000) } },
  };
  const head = "HTTP 200\n";
  assert.ok(
    chuggyToolAnswerBytes(`${head}${configurationAnswered(document)}`) >
      chuggyToolAnswerBytesMax,
  );
  assert.ok(
    chuggyToolAnswerBytes(`${head}${JSON.stringify(document)}`) <=
      chuggyToolAnswerBytesMax,
  );
  const { call } = configurationToolsOf(document);

  const answer = await call("read_configuration", { revision: "r1" });

  assert.equal(textOf(answer), `${head}${JSON.stringify(document)}`);
  assert.deepEqual(configurationRead(answer), document);
});

test("a path the configuration does not hold is refused, naming what is there", async () => {
  const { call } = configurationToolsOf(catalogOverBounds);
  const refused = async (path) => {
    const answer = await call("read_configuration", { revision: "r1", path });
    assert.equal(answer.isError, true, path.join("/"));
    return textOf(answer);
  };

  assert.equal(
    await refused(["workloads", "lint"]),
    'the configuration holds no "lint" at ["workloads"], which is an object whose keys are ["work","review","security","docs","tests"].',
  );
  assert.equal(
    await refused(["plans", "standard", "stages", 1]),
    'the configuration holds no 1 at ["plans","standard","stages"], which is an array whose indices are 0 to 0.',
  );
  assert.equal(
    await refused(["version", "name"]),
    'the configuration holds no "name" at ["version"], which is a number and holds no keys.',
  );
});

test("a draft's initialization is answered for a catalog whose route body is more than an ordinary read draws", async () => {
  const body = JSON.stringify({
    ...draftInitialized,
    configuration: {
      ...draftInitialized.configuration,
      canonical: JSON.stringify(catalogOverBounds),
    },
  });
  assert.ok(Buffer.byteLength(body) > chuggyToolResponseBytesMax);
  const { call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("initialize_draft", { revision: "r1" });

  assert.equal(answer.isError, undefined, textOf(answer));
  const answered = JSON.parse(textOf(answer).split("\n")[1]);
  assert.deepEqual(answered.fence, draftInitialized.fence);
  assert.ok(!("canonical" in answered.configuration));
});

/** A request that hangs until its signal aborts, then rejects with that signal's reason, as fetch does. */
async function requestHung(_task, _bearer, _path, init) {
  await new Promise((resolve) => {
    init.signal.addEventListener("abort", resolve, { once: true });
  });
  throw init.signal.reason;
}

test("a call its tool signal aborts names the tool and the timeout, and says which tools may be called again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call } = toolsOf({
    request: (task, bearer, path, init) =>
      requestHung(task, bearer, path, { ...init, signal: chuggyToolSignal() }),
  });

  for (const [name, args] of [
    ["list_repositories", {}],
    [
      "release_draft",
      { ticket: 4, authoringVersion: 2, configurationRevision: "r1" },
    ],
  ]) {
    const answered = call(name, args);
    await new Promise(setImmediate);
    t.mock.timers.tick(chuggyToolTimeoutMs);
    const answer = await answered;

    assert.equal(answer.isError, true, name);
    assert.equal(
      textOf(answer),
      `${name} ended at its ${String(chuggyToolTimeoutMs / 1_000)}-second timeout: a read tool (every list_* and read_*) may simply be called again, while a write tool's outcome is learned through read_operation where it answered an operation id.`,
    );
  }
});

test("a timeout that is not the tool signal's answers the raise itself", async () => {
  const { call } = toolsOf({
    request: async () => {
      throw new globalThis.DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    },
  });

  const answer = await call("release_draft", {
    ticket: 4,
    authoringVersion: 2,
    configurationRevision: "r1",
  });

  assert.equal(answer.isError, true);
  assert.equal(textOf(answer), "The operation was aborted due to timeout");
});

test("a call that raises anything but its timeout answers the raise itself", async () => {
  const { call } = toolsOf({
    request: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });

  const answer = await call("list_repositories", {});

  assert.equal(answer.isError, true);
  assert.equal(textOf(answer), "connect ECONNREFUSED");
});

test("a refused read of each reshaped tool is relayed as the refusal it is", async () => {
  const refusal = JSON.stringify({ error: "NotFound" });
  const { call } = toolsOf({}, () => ({ status: 404, body: refusal }));

  for (const [name, args] of [
    ["list_repositories", {}],
    ["list_configurations", {}],
    ["initialize_draft", { revision: "r1" }],
  ]) {
    const answer = await call(name, args);
    assert.equal(answer.isError, true, name);
    assert.equal(textOf(answer), `HTTP 404\n${refusal}`, name);
  }
});

test("a body that is not the listing, the page or the initialization the contract answers is refused rather than answered", async () => {
  for (const body of [
    "not json",
    "null",
    JSON.stringify({ repositories: [7] }),
  ]) {
    const { call } = toolsOf({}, () => ({ status: 200, body }));
    const answer = await call("list_repositories", {});
    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not this project's repositories/, body);
  }
  for (const body of [
    "not json",
    "null",
    JSON.stringify({ configurations: [7] }),
  ]) {
    const { call } = toolsOf({}, () => ({ status: 200, body }));
    const answer = await call("list_configurations", {});
    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /not a page of configuration revisions/, body);
  }
  const { call } = toolsOf({}, () => ({
    status: 200,
    body: JSON.stringify({ configuration: "r1" }),
  }));
  const answer = await call("initialize_draft", { revision: "r1" });
  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /not a draft's initialization/);
});

/** An image's bytes, opening as a PNG does, and the route's answer carrying them. */
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const pngAnswered = {
  content: png.toString("base64"),
  mediaType: "image/png",
  encoding: "base64",
};

/** A temporary directory of the suite's own, removed when the test ends. */
async function temporaryOf(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The tools with each image they read written under `temporary`, every route answering `answer`. */
function imageToolsOf(temporary, answer) {
  return toolsOf(
    { imageFile: chuggyToolImageFiles({ TMPDIR: temporary }) },
    answer,
  );
}

/** Every file the tools wrote under `temporary`, named from it. */
async function writtenUnder(temporary) {
  const written = [];
  for (const directory of await readdir(temporary))
    for (const file of await readdir(join(temporary, directory)))
      written.push(join(directory, file));
  return written.sort();
}

test("an image is read from its project's artifact route into a new file of this user's alone, and the answer names the file", async (t) => {
  const temporary = await temporaryOf(t);
  const { api, call } = imageToolsOf(temporary, () => ({
    status: 200,
    body: JSON.stringify(pngAnswered),
  }));

  const first = await call("fetch_image", { artifact: "image/png:ce47" });
  const second = await call("fetch_image", { artifact: "image/png:ce47" });

  assert.deepEqual(
    api.calls.map(({ path, method }) => [method, path]),
    Array.from({ length: 2 }, () => [
      "GET",
      "/api/v1/tenants/vteng/projects/chuggy/artifacts/image%2Fpng%3Ace47",
    ]),
  );
  const written = await writtenUnder(temporary);
  assert.equal(written.length, 2, "a read did not write a new file");
  for (const [at, answer] of [first, second].entries()) {
    const file = join(temporary, written[at]);
    assert.ok(answer.isError === undefined, textOf(answer));
    assert.equal(
      textOf(answer),
      `image/png, ${String(png.byteLength)} bytes, written to ${file}. Open that file with Read to see the image.`,
    );
    assert.ok(isAbsolute(file));
    assert.match(written[at], /^chuggy-tool-images-[^/]+\/\d+\.png$/u);
    assert.deepEqual(await readFile(file), png);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!textOf(answer).includes(pngAnswered.content));
  }
  assert.equal(
    dirname(written[0]),
    dirname(written[1]),
    "one context's reads were written to two directories",
  );
});

test("a refused image read is relayed as its status and body, and writes nothing", async (t) => {
  const temporary = await temporaryOf(t);
  for (const status of [403, 404]) {
    const body = JSON.stringify({ error: { code: "NotFound" } });
    const { api, call } = imageToolsOf(temporary, () => ({ status, body }));

    const answer = await call("fetch_image", { artifact: "image/png:ce47" });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 1, "a refused read was asked again");
  }
  assert.deepEqual(await readdir(temporary), []);
});

test("an image answer not in the route's shape is an error, and writes nothing", async (t) => {
  const temporary = await temporaryOf(t);
  for (const body of [
    "not json",
    "null",
    JSON.stringify({}),
    JSON.stringify({ ...pngAnswered, content: 7 }),
    JSON.stringify({ ...pngAnswered, mediaType: "image/svg+xml" }),
    JSON.stringify({ ...pngAnswered, encoding: "utf8" }),
    JSON.stringify({ ...pngAnswered, content: "*not base64*" }),
    JSON.stringify({ ...pngAnswered, content: "iVBORw0KGgoBAg" }),
  ]) {
    const { call } = imageToolsOf(temporary, () => ({ status: 200, body }));

    const answer = await call("fetch_image", { artifact: "image/png:ce47" });

    assert.equal(answer.isError, true, body);
    assert.match(textOf(answer), /nothing was written\.$/u, body);
    assert.ok(!textOf(answer).includes(body), body);
  }
  assert.deepEqual(await readdir(temporary), []);
});

/**
 * The bound at its own edge. The image's answer is held to the contract's
 * image bound rather than to an ordinary answer's, and is refused past it
 * rather than decoded from what fit.
 */
test("an image answer at the route's bound is read, and one past it is refused rather than cut", async (t) => {
  const temporary = await temporaryOf(t);
  const body = JSON.stringify(pngAnswered);
  const padded = (bytes) =>
    `${body}${" ".repeat(bytes - Buffer.byteLength(body))}`;
  assert.ok(chuggyToolImageResponseBytesMax > chuggyToolResponseBytesMax);

  const at = await imageToolsOf(temporary, () => ({
    status: 200,
    body: padded(chuggyToolImageResponseBytesMax),
  })).call("fetch_image", { artifact: "image/png:ce47" });
  const over = await imageToolsOf(temporary, () => ({
    status: 200,
    body: padded(chuggyToolImageResponseBytesMax + 1),
  })).call("fetch_image", { artifact: "image/png:ce47" });

  assert.ok(at.isError === undefined, textOf(at));
  assert.equal(over.isError, true);
  assert.match(textOf(over), /larger than the/u);
  assert.equal((await writtenUnder(temporary)).length, 1);
});

/**
 * The capability that admits the read, which is the only thing that keeps it
 * from a roster: a roster without ProjectRead neither registers nor allows it.
 */
test("fetch_image is registered and allowed under ProjectRead, and under nothing else", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);
  const others = everyCapability.filter((held) => held !== "ProjectRead");
  const qualified = `${chuggyToolPrefix}fetch_image`;

  assert.ok(registered(["ProjectRead"]).includes("fetch_image"));
  assert.ok(
    sessionAllowedTools(["ProjectRead"]).allowedTools.includes(qualified),
  );
  assert.ok(!registered(others).includes("fetch_image"));
  assert.ok(sessionAllowedTools(others).disallowedTools.includes(qualified));
  for (const roster of [leadRoster, threadRoster])
    assert.ok(registered([...roster]).includes("fetch_image"));
});

/** The docs tools, each fetch the docs host is asked recorded and answered by `answer`. */
function docsToolsOf(answer) {
  const fetched = [];
  const tools = toolsOf({
    docsFetch: async (url, init) => {
      fetched.push({ url: String(url), init });
      return answer(String(url));
    },
  });
  return { ...tools, fetched };
}

const docsPage = new URL("guide/tickets.md", chuggyDocsIndex).href;

test("read_docs with no page answers the index the contract names, verbatim", async () => {
  const index = "# chuggy\n\n- [Tickets](https://example.test/x.md)\n";
  const { api, call, fetched } = docsToolsOf(
    () => new globalThis.Response(index),
  );

  const answer = await call("read_docs", {});

  assert.equal(answer.isError, undefined, textOf(answer));
  assert.equal(textOf(answer), index);
  assert.deepEqual(
    fetched.map(({ url }) => url),
    [chuggyDocsIndex],
  );
  assert.equal(api.calls.length, 0, "the docs were asked of chuggy's API");
});

test("read_docs with a page under the index's directory answers that page, verbatim", async () => {
  const markdown = "# Tickets\n\nA ticket is … ✓\n";
  const { call, fetched } = docsToolsOf(
    () => new globalThis.Response(markdown),
  );

  const answer = await call("read_docs", { page: docsPage });

  assert.equal(answer.isError, undefined, textOf(answer));
  assert.equal(textOf(answer), markdown);
  assert.deepEqual(
    fetched.map(({ url }) => url),
    [docsPage],
  );
});

test("read_docs refuses a page outside the index's directory without fetching anything", async () => {
  const directory = new URL(".", chuggyDocsIndex);
  for (const page of [
    "not a url",
    "https://example.test/llms.txt",
    `http://${directory.host}${directory.pathname}guide.md`,
    `https://${directory.host}:8443${directory.pathname}guide.md`,
    new URL("../other/guide.md", directory).href,
    `${directory.href}../other/guide.md`,
    `${directory.href.slice(0, -1)}line/guide.md`,
    `${directory.origin}/kasofsk/chuggy/main/README.md`,
  ]) {
    const { call, fetched } = docsToolsOf(
      () => new globalThis.Response("leaked"),
    );

    const answer = await call("read_docs", { page });

    assert.equal(answer.isError, true, page);
    assert.match(textOf(answer), /nothing was fetched\.$/u, page);
    assert.deepEqual(fetched, [], page);
  }
});

test("read_docs refuses a body past the contract's bound rather than cutting it", async () => {
  const over = "x".repeat(chuggyToolDocsResponseBytesMax + 1);
  for (const response of [
    () => new globalThis.Response(over),
    () =>
      new globalThis.Response(over, {
        headers: { "content-length": String(Buffer.byteLength(over)) },
      }),
  ]) {
    const { call } = docsToolsOf(response);

    const answer = await call("read_docs", { page: docsPage });

    assert.equal(answer.isError, true);
    assert.match(
      textOf(answer),
      new RegExp(
        `larger than the ${String(chuggyToolDocsResponseBytesMax)} bytes`,
        "u",
      ),
    );
    assert.ok(!textOf(answer).includes("xxxx"));
  }
});

test("read_docs answers a status other than a 2xx as a refusal, and not its body", async () => {
  for (const status of [301, 404, 500]) {
    const { call } = docsToolsOf(
      () =>
        new globalThis.Response("the host's own page", {
          status,
          headers: status === 301 ? { location: "https://example.test/" } : {},
        }),
    );

    const answer = await call("read_docs", {});

    assert.equal(answer.isError, true, String(status));
    assert.equal(
      textOf(answer),
      `the docs host answered HTTP ${String(status)} for ${chuggyDocsIndex}.`,
    );
  }
});

test("read_docs sends the docs host no header of chuggy's, follows no redirect, and is bounded in time", async () => {
  const { call, fetched } = docsToolsOf(() => new globalThis.Response("# x"));

  await call("read_docs", {});
  await call("read_docs", { page: docsPage });

  for (const { init } of fetched) {
    assert.deepEqual(Object.keys(init).sort(), ["redirect", "signal"]);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof globalThis.AbortSignal);
    assert.ok(!JSON.stringify(init).includes(bearer));
  }
});

/**
 * Every identity a tool puts in a path segment, given one that carries the
 * separator. A segment is model-chosen text bounded only by `identity(z)`, so
 * an unencoded one is a tool that reaches a route its roster does not name:
 * `new URL(path, origin)` resolves `..` before the request is made, which is
 * how `…/threads/../lead/transcript` becomes the lead's route. The assertion is
 * on the RESOLVED pathname rather than on the string this file built, because
 * the string is not what the API is asked for.
 */
test("an identity carrying a separator stays inside the route its tool names", async () => {
  const escaping = "../lead";
  const escaped = "..%2Flead";
  const partition = "/api/v1/tenants/vteng/projects/chuggy";
  const cases = [
    [
      ["read_configuration", { revision: escaping }],
      `/configurations/${escaped}`,
    ],
    [["read_execution", { execution: escaping }], `/executions/${escaped}`],
    [
      ["read_run_transcript", { execution: escaping, attempt: escaping }],
      `/executions/${escaped}/attempts/${escaped}/transcript`,
    ],
    [
      ["read_run_error", { execution: escaping, attempt: escaping }],
      `/executions/${escaped}/attempts/${escaped}/error`,
    ],
    [["read_operation", { operation: escaping }], `/operations/${escaped}`],
    [
      ["initialize_draft", { revision: escaping }],
      `/draft-initializations/${escaped}`,
    ],
    [["read_thread", { session: escaping }], `/threads/${escaped}`],
    [
      ["read_thread_transcript", { session: escaping }],
      `/threads/${escaped}/transcript`,
    ],
    [["fetch_image", { artifact: escaping }], `/artifacts/${escaped}`],
  ];
  for (const [[name, args], suffix] of cases) {
    const api = apiOf();

    await routeOf(name, args, api);

    assert.equal(api.calls.length, 1, name);
    assert.equal(
      new URL(api.calls[0].path, "https://api.test").pathname,
      `${partition}${suffix}`,
      name,
    );
  }
});

test("a thread read past its bound is refused before it asks, and within it asks", async () => {
  for (const [name, args] of [
    ["read_thread", { session: "" }],
    ["read_thread", { session: "t-1", limit: 0 }],
    ["read_thread", { session: "t-1", limit: 33 }],
    ["read_thread", { session: "t-1", before: 0 }],
    ["read_thread_transcript", { session: "t-1", entry: -1 }],
    ["read_thread_transcript", { session: "" }],
  ]) {
    const api = apiOf();

    const answer = await routeOf(name, args, api);

    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(api.calls.length, 0, name);
  }
  const api = apiOf();

  await routeOf("read_thread_transcript", { session: "t-1", entry: 0 }, api);

  assert.equal(api.calls.length, 1, "a transcript at its cursor was refused");
});

test("an argument past its bound is refused before any call is made", async () => {
  const { api, call } = toolsOf();

  for (const [name, args] of [
    ["read_ticket", { ticket: 0 }],
    ["list_tickets", { limit: 101 }],
    ["read_decision_log", { limit: 51 }],
    ["read_refusals", { limit: 33 }],
    ["read_lead_transcript", { after: -1 }],
    ["read_execution", { execution: "" }],
    ["fetch_image", { artifact: "" }],
    ["fetch_image", { artifact: "x".repeat(257) }],
  ]) {
    const answer = await call(name, args);

    assert.equal(answer.isError, true, name);
  }
  assert.equal(api.calls.length, 0, "a refused argument still reached the API");
});

test("a write relays the status and the body the API answered, unaltered", async () => {
  for (const status of [409, 422, 429]) {
    const body = JSON.stringify({ error: "Stale", status });
    const { api, call } = toolsOf({}, () => ({ status, body }));

    const answer = await call("delete_draft", {
      ticket: 4,
      expectedVersion: 2,
    });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 1, "a refused write was asked again");
    assert.equal(
      api.calls[0].path,
      "/api/v1/tenants/vteng/projects/chuggy/drafts/4?expectedVersion=2",
    );
    assert.equal(api.calls[0].method, "DELETE");
  }
});

test("a write is written in the versioned media type the API requires", async () => {
  const { api, call } = toolsOf();

  await call("revise_draft", {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });

  assert.equal(api.calls[0].method, "PUT");
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body), {
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });
});

/** A draft's version starts at one, so a fence at zero is one no draft ever had. */
test("a draft fenced at version zero is refused before any call, and one at version one is asked", async () => {
  const revision = {
    ticket: 4,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  };
  for (const [name, args] of [
    ["revise_draft", revision],
    ["delete_draft", { ticket: 4 }],
  ]) {
    const refused = toolsOf();
    const asked = toolsOf();

    const answer = await refused.call(name, { ...args, expectedVersion: 0 });
    await asked.call(name, { ...args, expectedVersion: 1 });

    assert.equal(answer.isError, true, name);
    assert.equal(refused.api.calls.length, 0, `${name} asked at version 0`);
    assert.equal(asked.api.calls.length, 1, `${name} refused version 1`);
  }
});

/**
 * The fence is a value the session reads off an answer, so the parameter says
 * which answer and which field: a session that fenced on the ticket's own
 * `version` would be refused at every write.
 */
test("a draft write's expected version says it is the draft's authoringVersion, from one, and what a stale one answers", () => {
  for (const name of ["revise_draft", "delete_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const described = tool?.shape(z).expectedVersion?.description ?? "";

    for (const said of [
      /draft's `authoringVersion`/,
      /read_draft/,
      /a new draft is at 1/,
      /refused with the draft's `currentVersion`/,
    ])
      assert.match(described, said, name);
  }
});

/**
 * A new draft's fence is the project's journal head, which a Succeeded
 * operation moves and a draft write does not, so the parameter says where it
 * is read and what moves it, that a stale one is
 * answered with the head to send again, and that a project which is not active
 * refuses at every head: a session told only "stale" reads again for ever.
 */
test("a new draft's expected project sequence says it is the project head, and what a stale one and an inactive project answer", () => {
  for (const name of ["create_draft", "file_dependent"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const described = tool?.shape(z).expectedProjectSequence?.description ?? "";

    for (const said of [
      /`fence\.projectSequence` initialize_draft answered/,
      /which only an operation on the project that Succeeded moves, whoever submitted it/,
      /no draft write \(create_draft, file_dependent, revise_draft, delete_draft\) moves it/,
      /\(DraftInitializationStale\) with the head it is at now as `currentProjectSequence`/,
      /the same write may be sent again with/,
      /Where nothing else has moved it since, the `decidedSequence` of your last Succeeded operation is the head to pass next/,
      /\(ProjectNotActive\), naming its `lifecycle`/,
    ])
      assert.match(described, said, name);
  }
});

/**
 * A revision replaces the brief whole, so what read_draft answered and the
 * session leaves out is cleared: the parameter names each field a session
 * would not think to send back.
 */
test("a revision's brief says to send back the repository and the images read_draft answered", () => {
  const tool = chuggyProjectTools.find((held) => held.name === "revise_draft");
  assert.match(
    tool?.shape(z).brief?.description ?? "",
    /send back the `repository` and `images` read_draft answered or the revision clears them/,
  );
});

test("a write names the media type only when it sends a body", async () => {
  const { api, call } = toolsOf();

  await call("revise_draft", {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  });
  await call("delete_draft", { ticket: 4, expectedVersion: 2 });

  const [withBody, withoutBody] = api.calls;
  assert.equal(withBody.method, "PUT");
  assert.equal(
    withBody.init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.equal(typeof withBody.init.body, "string");
  assert.equal(withoutBody.method, "DELETE");
  assert.equal("body" in withoutBody.init, false);
  assert.equal(
    "content-type" in withoutBody.init.headers,
    false,
    "a bodyless write names a JSON body it does not send",
  );
});

const dependent = {
  parent: 7,
  relation: "FollowUp",
  configurationRevision: "r1",
  configurationDigest: "d1",
  expectedProjectSequence: 12,
  authoring: { dependencies: [7] },
  brief: { title: "t" },
};

test("a dependent is filed with its parent among the draft's dependencies", async () => {
  const { api, call } = toolsOf();

  await call("file_dependent", dependent);

  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/drafts",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body).authoring, {
    dependencies: [7],
  });
});

/** The schema is what refuses a prerequisite, so its description points at the write that files one. */
test("a dependent's relation admits FollowUp alone, and a prerequisite is refused before anything is asked", async () => {
  const { api, call } = toolsOf();

  assert.deepEqual(
    chuggyProjectTools.find(({ name }) => name === "file_dependent").shape(z)
      .relation.options,
    ["FollowUp"],
  );
  assert.match(
    parameterDescribed("file_dependent", "relation"),
    /a prerequisite of a ticket is a revise_draft of its draft's dependencies/,
  );
  const answer = await call("file_dependent", {
    ...dependent,
    relation: "Prerequisite",
  });

  assert.equal(answer.isError, true);
  assert.equal(api.calls.length, 0);
});

test("a dependent that does not carry its parent is refused", async () => {
  const { api, call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    authoring: { dependencies: [8] },
  });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /does not name ticket 7/);
  assert.equal(api.calls.length, 0);
});

test("a relation outside the roster never reaches the refusal that explains one", async () => {
  const { call } = toolsOf();

  const answer = await call("file_dependent", {
    ...dependent,
    relation: "Supersedes",
  });

  assert.equal(answer.isError, true);
});

test("releasing a draft submits one operation and answers its id, not an outcome", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Accepted" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });

  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(body.mutation, {
    mutation: "ReleaseDraft",
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

test("revoking a ticket submits one operation naming that ticket and nothing else, and answers its id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("revoke_ticket", { ticket: 26 });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["mutation", "operation"]);
  assert.deepEqual(body.mutation, { mutation: "RevokeTicket", ticket: 26 });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
  assert.ok(answer.isError === undefined);
});

test("updating a ticket submits one operation naming the ticket, the revision read and the draft's, and answers its id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, () => ({ status: 202, body: accepted }));

  const answer = await call("update_ticket", {
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["mutation", "operation"]);
  assert.deepEqual(body.mutation, {
    mutation: "UpdateTicket",
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[0].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

/** A dispatch view page holding `candidates`, as the route answers one. */
function dispatchViewPage(candidates) {
  return JSON.stringify({
    result: "Page",
    token: {},
    candidates,
    notificationCursor: 0,
  });
}

test("dispatching a ticket reads its version from the dispatch view and submits it, answering the operation's id", async () => {
  const accepted = JSON.stringify({ operation: "o", state: "Pending" });
  const { api, call } = toolsOf({}, (_path, init) =>
    init?.method === "POST"
      ? { status: 202, body: accepted }
      : {
          status: 200,
          body: dispatchViewPage([{ ticket: 26, ticketVersion: 41 }]),
        },
  );

  const answer = await call("dispatch_ticket", { ticket: 26 });

  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].method, "GET");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/dispatch-view?after=25&limit=1",
  );
  assert.equal(api.calls[1].method, "POST");
  assert.equal(
    api.calls[1].path,
    "/api/v1/tenants/vteng/projects/chuggy/operations",
  );
  const body = JSON.parse(api.calls[1].init.body);
  assert.deepEqual(body.mutation, {
    mutation: "ManualDispatch",
    ticket: 26,
    expectedTicketVersion: 41,
  });
  assert.equal(
    body.operation,
    chuggyOperationIdentity("turn-1", body.mutation),
  );
  assert.equal(api.calls[1].init.headers["idempotency-key"], body.operation);
  assert.equal(textOf(answer), `HTTP 202\n${accepted}`);
});

test("the first ticket is read from the start of the dispatch view", async () => {
  const { api, call } = toolsOf({}, () => ({
    status: 200,
    body: dispatchViewPage([]),
  }));

  await call("dispatch_ticket", { ticket: 1 });

  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/dispatch-view?limit=1",
  );
});

test("a ticket the dispatch view does not hold is answered and nothing is submitted", async () => {
  for (const candidates of [[], [{ ticket: 27, ticketVersion: 41 }]]) {
    const { api, call } = toolsOf({}, () => ({
      status: 200,
      body: dispatchViewPage(candidates),
    }));

    const answer = await call("dispatch_ticket", { ticket: 26 });

    assert.equal(answer.isError, true);
    assert.match(textOf(answer), /ticket 26 cannot be dispatched now/);
    assert.match(textOf(answer), /nothing was submitted/);
    assert.equal(api.calls.length, 1);
  }
});

test("a dispatch view being rebuilt, refused or unreadable submits nothing", async () => {
  for (const [given, said] of [
    [{ status: 200, body: JSON.stringify({ result: "Reset" }) }, /rebuilt/],
    [
      { status: 403, body: JSON.stringify({ error: { code: "Forbidden" } }) },
      /^HTTP 403/,
    ],
    [{ status: 200, body: "{}" }, /not a dispatch view/],
    [
      {
        status: 200,
        body: dispatchViewPage([{ ticket: 26, ticketVersion: "41" }]),
      },
      /not a dispatch view/,
    ],
  ]) {
    const { api, call } = toolsOf({}, () => given);

    const answer = await call("dispatch_ticket", { ticket: 26 });

    assert.equal(answer.isError, true);
    assert.match(textOf(answer), said);
    assert.equal(api.calls.length, 1);
  }
});

test("the dispatch tool says whose word it takes and that it is the owner's own dispatch", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "dispatch_ticket",
  );

  for (const said of [
    /on your owner's word only/,
    /your owner's dispatch/,
    /Pending ticket whose dependencies are all Done/,
    /TicketChanged/,
    /read_operation/,
  ])
    assert.match(description, said);
});

test("one call revokes one ticket: a list, a ticket that is no number and no ticket at all reach nothing", async () => {
  const { api, call } = toolsOf();

  for (const args of [
    { ticket: [26, 27] },
    { ticket: 0 },
    { ticket: "26" },
    {},
  ])
    assert.equal((await call("revoke_ticket", args)).isError, true);
  assert.equal(api.calls.length, 0);
});

test("a revocation the machine refuses is relayed unaltered and never asked again", async () => {
  const body = JSON.stringify({ error: { code: "MutationNotAdmitted" } });
  const { api, call } = toolsOf({}, () => ({ status: 409, body }));

  const answer = await call("revoke_ticket", { ticket: 25 });

  assert.equal(textOf(answer), `HTTP 409\n${body}`);
  assert.equal(answer.isError, true);
  assert.equal(api.calls.length, 1);
});

/**
 * A session learns what revoking does from the description alone, and the two
 * things it cannot learn anywhere else are that a revocation is final and that
 * it settles one ticket: the dependents of a revoked ticket wait until an
 * update drops it or they are revoked too.
 */
test("the revocation tool says it is final, whose word it takes and what is left behind it", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "revoke_ticket",
  );

  for (const said of [
    /on your owner's word only/,
    /ends the ticket for good/,
    /undoes nothing that already landed/,
    /revokes no other ticket/,
    /`revokedDependencies`/,
    /an update that drops them \(revise_draft, then update_ticket\) lets it start/,
    /otherwise it can only be revoked too/,
    /read_operation/,
  ])
    assert.match(description, said);
});

/**
 * A ticket runs on the agent of the configuration it is released against, and
 * the listing answers no agent, so the read is where a session finds one and
 * its description is what says where.
 */
test("the configuration read says where the agent that does the work is named", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;

  assert.match(described("read_configuration"), /`worker\.mode`/);
  assert.match(described("read_configuration"), /the agent/);
  assert.match(described("read_configuration"), /a model/);
  assert.match(described("list_configurations"), /read_configuration/);
});

/**
 * What the server does with a brief that no answer shows until it is too late
 * to act on: that its checks need a commanded Check stage, where the
 * initialization says which one, and a program running it, where a brief
 * naming no landing takes one and that the write says whose it took, and that
 * a proposal's branch is never the default one. Every tool that takes a brief
 * says it on its `brief` parameter.
 */
const briefClaims = [
  /\{title\?, intent, links, images\?, checks\?/,
  /`images` are this project's images the work is handed, each by the identity fetch_image takes/,
  new RegExp(
    `each one line of 1 to ${String(briefLineCharsMax)} characters with no tab, line break or other control character in it`,
    "u",
  ),
  /`commandedCheckStage`, its program stage key, counted from one/,
  /`commandedCheckStageNote` \(the same stage and, for a catalog, its plan, or that none does and which plans would\)/,
  /whose program leaves out that stage, or for a catalog the evaluator in it that runs commands, is refused when it is released whoever releases it \(ProgramSkipsBriefChecks\)/,
  /where it answers none a draft carrying checks is refused/,
  /\(BriefChecksUncommanded\)/,
  /the commit the change started from in CHUG_CHANGE_BASE, unset where that is unknown/,
  /runs under sh -eu with the commit/,
  /reads it as \$\{CHUG_CHANGE_BASE-\} and runs everything where that is empty/,
  /a brief naming none takes, on a version 2 catalog, the landing of the finalizer its selection lands with where that finalizer names one, and otherwise its repository's landing default/,
  /for a newly bound repository is a pull request/,
  /`landing`, the mode and target it stored, and its `source`: Brief, Finalizer, Repository, or Default for a brief naming no repository/,
  /never the default branch/,
  /\(ProposalBaseIsHead\)/,
  /A 400 names the rule the brief broke, and for a check its position in `checks`, counted from zero/,
];

test("every tool that takes a brief says on its parameter what the server does with one", () => {
  const taking = briefTakers();

  assert.notEqual(taking.length, 0, "no tool takes a brief");
  for (const { name, description } of taking)
    for (const claim of briefClaims) assert.match(description, claim, name);
});

/** What a release or an update of a draft running less than its plan is answered, and what lets it through. */
const programShortClaims = [
  /runs less than its configuration plans/,
  /an evaluator of a stage it keeps/,
  /skip_planned_evaluations permit, which its administrators hold/,
  /403 ProgramSkipsPlannedEvaluations and nothing is submitted/,
  /`defaults\.program`/,
];

/** What one parameter of a project tool is described as, where an agent fills it in. */
function parameterDescribed(tool, parameter) {
  const field = chuggyProjectTools.find(({ name }) => name === tool).shape(z)[
    parameter
  ];
  return field.description ?? field.unwrap().description ?? "";
}

/**
 * What the server does that no answer shows until it is too late to act on:
 * that the refusal ledgers hold none of a command's refusals, that a
 * submission repeated in one turn answers the settled operation, that a
 * project has no lead before a release, who may release a program running
 * less than its plan, that stages run in order and a stage's evaluators side
 * by side, which stage a brief's checks join, what a ticket's run totals sum,
 * and what a binding says of its repository. Each is said in the description
 * of the tool the session reads it from.
 */
test("the descriptions say what the server does where a session reads it", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const ledger = [
    /refusals to dispatch a released ticket/,
    /and nothing else/,
    /read_operation/,
  ];
  const said = {
    read_refusals: ledger,
    read_ticket_refusals: ledger,
    release_draft: [
      /same turn is the same operation/,
      /other than Pending/,
      /revise_draft/,
      ...programShortClaims,
    ],
    update_ticket: programShortClaims,
    revoke_ticket: [/same turn is the same operation/, /other than Pending/],
    read_lead: [
      /None, and `absence\.reason` says why/,
      /`Paused`: [^.]*, so no ticket is picked up automatically; it must be resumed by someone who may, and this reason is answered ahead of the others\./,
      /`NotNeeded`: no refusal stands/,
      /before anything is released/,
      /release a ticket/,
      /`absence\.since` is when that refusal began/,
      /`RunnerOffline`: [^.]*, so the project's runner must be running\./,
      /`HostedRunsNotGranted`: [^.]*, so an admin must grant them\./,
    ],
    initialize_draft: [
      /run in that order/,
      /a failed stage ends evaluation/,
      /`choices\.programStagesMax`/,
      /`commandedCheckStage` is the stage a brief's `checks` join, by its program stage key, counted from one as `defaults\.program` keys are/,
      /`commandedCheckStageNote` says it in words/,
      /`configuration` is answered without its `canonical`; read_configuration answers the document/,
    ],
    read_ticket: [
      /`escalation\.failed`, which read_run_error takes to read the attempt's error text/,
      /`runTotals`, what every run of its executions reported, summed/,
      /`costUsdMicros`, millionths of a dollar at the runtime's list price/,
      /per model in `models`/,
      /A ticket no run has reported for carries none/,
    ],
    read_configuration: [
      /evaluation stages run in the order listed and a failed stage ends evaluation/,
      /the evaluators of one stage run in parallel/,
      /each evaluator of a plan stage names its own workload/,
      /review lenses that should run side by side belong in one stage/,
    ],
    list_repositories: [
      /oldest first/,
      /`repository` is its clone URL/,
      /`landing` is its landing default/,
      /`configured` says whether the project holds configurations for it/,
      /Bootstrapped, the project's bootstrap `revision`/,
      /A retired binding carries `retiredAt`, and a draft write naming it is refused/,
      /`pipelinesWritable` says whether its jobs may write its pipeline definitions, and `workerReach`, present only where the worker app cannot be said to reach it, says why/,
      /A ticket may be filed in any binding not retired, and one holding no configurations releases its tickets under the project's bootstrap\. Each row's `fileable` says whether to file a ticket there: false, with `fileableReason` saying why, where it is retired or carries `workerReach`/,
    ],
    fetch_image: [
      /written to a new file/,
      /that file's path, its media type and its size in bytes/,
      /open the file with Read/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

/** What a second ticket is filed without asking again, and a failed import read beside the configurations still held. */
test("the descriptions say where the head after a command, a program's keys, dependencies and a repository's configurations are read", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const said = {
    read_operation: [
      /A Succeeded operation carries `decidedSequence`, the project's journal head the command moved it to\./,
    ],
    initialize_draft: [
      /^The defaults and the fence a new draft is filed against/,
      /each stage's `key` and each evaluator's `key` are positions counted from one in the configuration's plan, and passing it unchanged runs the whole plan/,
      /Dependencies are chosen from list_tickets\./,
    ],
    list_repositories: [
      /`configurationsHeld` what it holds now/,
      /`lastImport` is the newest import attempt, and it can fail while earlier imported revisions stay usable/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

/** What a newcomer filing a first ticket asks before acting. */
test("read_abilities says who the session is and what it may do", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const said = {
    read_abilities: [
      /^Who this session acts as and what it may do on this project, read live\./,
      /Call it once before acting\./,
      /`principal` is the session's own principal, encoded as a ticket's `creator` is, so the tickets whose `creator` is it are yours/,
      /`dispatch`, `skipPlannedEvaluations` and `writeEpic` among them: read a permit here rather than learning it from a refusal/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

test("fetch_image says on its parameter which identity it takes", () => {
  assert.match(
    parameterDescribed("fetch_image", "artifact"),
    /by the identity a message's images section or a brief names it by/,
  );
});

/** The phase filter takes exact phase names, so its parameter names them. */
test("list_tickets says which values its phase filter takes", () => {
  const description = parameterDescribed("list_tickets", "phase");
  for (const said of [
    /`phase` takes one or more of Pending, Work, Evaluation, Finalization, Done, Escalated and Revoked, matched exactly/,
    /or `NonTerminal` alone/,
    /left out, it lists every phase/,
  ])
    assert.match(description, said);
});

/**
 * The executions route takes one or more distinct execution statuses or
 * `NonTerminal` alone, and answers anything else 400, so the schema refuses
 * it before it is sent and the parameter names the field it matches.
 */
test("list_executions takes only the states its route takes, named as read_execution answers them", async () => {
  const { api, call } = toolsOf({}, () => ({ status: 200, body: "{}" }));
  const statuses = [
    "Queued",
    "Admitted",
    "Launching",
    "Running",
    "Terminal",
    "Cancelled",
  ];

  for (const state of [statuses, ["NonTerminal"]]) {
    const answer = await call("list_executions", { state });
    assert.equal(answer.isError, undefined, state.join());
  }
  for (const state of [
    [],
    ["Pending"],
    ["Registered"],
    ["NonTerminal", "Running"],
    ["Running", "Running"],
    [...statuses, "Queued"],
  ]) {
    const answer = await call("list_executions", { state });
    assert.equal(answer.isError, true, state.join());
  }
  assert.equal(api.calls.length, 2);
  assert.match(
    parameterDescribed("list_executions", "state"),
    /whose `status`, as read_execution answers it, is one of these, each named once, or `NonTerminal` alone/,
  );
});

test("list_tickets lists by recent activity on the server's own cursor, and by number unchanged without it", async () => {
  const { api, call } = toolsOf({}, () => ({ status: 200, body: "{}" }));

  await call("list_tickets", {
    order: "RecentActivity",
    cursor: "eyJ0aWNrZXQiOjd9",
    limit: 25,
  });
  await call("list_tickets", { after: 40, limit: 25, phase: ["Done"] });

  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [
      "/api/v1/tenants/vteng/projects/chuggy?limit=25&order=RecentActivity&cursor=eyJ0aWNrZXQiOjd9",
      "/api/v1/tenants/vteng/projects/chuggy?after=40&limit=25&phase=Done",
    ],
  );
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "list_tickets",
  );
  for (const said of [
    /`order: "RecentActivity"` lists them newest activity first/,
    /answering `nextCursor` for the next page, which `cursor` resumes from/,
  ])
    assert.match(parameterDescribed("list_tickets", "order"), said);
  assert.match(
    description,
    /A page may hold fewer than `limit`, and only `nextAfter`, or `nextCursor`, present says there are more/,
  );
});

/** A first ticket is filed from these descriptions alone, so they open with what one needs. */
test("the draft writes open their brief with the minimum brief and say what authoring is", () => {
  for (const name of ["create_draft", "revise_draft"]) {
    const shape = chuggyProjectTools
      .find((held) => held.name === name)
      .shape(z);
    assert.ok(
      shape.brief.description.startsWith(
        'The minimum brief is {title, intent, links: [], repository: <clone URL from list_repositories>, branch: "refs/heads/<a new branch of your own>"}.\n`brief` is {title?',
      ),
      name,
    );
    assert.match(
      shape.authoring.description ?? "",
      /^`authoring` is \{program, dependencies\}: pass initialize_draft's `defaults` unchanged unless you mean otherwise, and `dependencies` are ticket numbers chosen from list_tickets\.$/,
      name,
    );
  }
});

test("release_draft says releasing starts no work, and who starts it", () => {
  const { description } = chuggyProjectTools.find(
    ({ name }) => name === "release_draft",
  );
  assert.match(
    description,
    /Releasing makes the ticket Pending and starts no work: the project's lead dispatches it when its dependencies are Done, or a person who may dispatch does\./,
  );
  assert.match(
    description,
    /A Pending ticket with no open dependencies waits on the lead's dispatch decision or on a dispatch by someone who may, and read_lead answers whether a lead is active and, where none, why\./,
  );
});

test("a ticket's landings are described as the route answers them, and read_ticket points at them", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const claims = [
    /the newest one answer holds, oldest first, `truncated` where it leaves older ones out/,
    /Each landing carries its `state`/,
    /Unavailable \(it could not go through and escalated: as the newest, its ticket waits on a person; an older one stays after a resume\)/,
    /`failureKind` where it failed, such as MergeConflict, QueueChecksFailed \(the merge queue removed its pull request twice for failed checks; its work went back to Work\) or RecheckRequired/,
    /RecheckRequired, with `recheck` unless recorded before re-checks kept one: its `reason`, TargetMoved \(the target moved past the accepted commit\), StackTreeDiffers \(the merge's tree is not its stack's\) or MergedTreeDiffers \(its merged pull request left a tree its work was not checked on\), and `baseRef`, the base checked against, where present/,
    /A Held landing carries `hold`, and an Unavailable one the `hold` it escalated from where one is recorded: its `kind`, [^.]*, and `since`, when a hold of that kind began/,
    /`hold\.removal`, where its pull request left the merge queue, is the forge's `reason`, such as `manual`, and the `actor` removing it, where named/,
    /An AwaitingMerge landing carries `wait`: its `reason` \(Blocked by the forge's rules, as where the queue will not take it yet; HeadMoved; or Queued, waiting its turn\) and `checkedAt`, when the forge was last heard about its merge/,
    /`proposal` is the pull request [^.]*: its `url`, [^.]*its `mergeability`, and `mergeState`, GitHub's `mergeable_state`/,
    /its `status` as chuggy last read it, [^.]*so a Proposed landing's is the one it opened with/,
    /`conflict` is the paths its newest attempt conflicted on, `truncated` where they were cut/,
  ];
  for (const claim of claims)
    assert.match(described("read_ticket_landings"), claim);
  assert.match(
    described("read_ticket"),
    /Where its work is landing, waits to land or escalated at landing, read_ticket_landings says how/,
  );
});

/**
 * A revised draft changes nothing its Pending ticket runs until update_ticket
 * releases it, so revise_draft says so, and update_ticket says whose word it
 * takes, what it is fenced on and the refusals that fence answers.
 */
test("updating a ticket says whose word it takes and what refuses it, and a revision that it waits for one", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;

  for (const claim of [
    /on your owner's word only/,
    /\(TicketNotPending\)/,
    /\(TicketRevisionStale\)/,
    /dropping one is never refused/,
    /\(DependenciesRevoked\)/,
    /\(DependencyCycle\)/,
    /same turn is the same operation/,
  ])
    assert.match(described("update_ticket"), claim);
  assert.match(
    parameterDescribed("update_ticket", "expectedRevision"),
    /`expectedRevision` is the ticket's `revision` as read_ticket answers it/,
  );
  assert.match(
    described("revise_draft"),
    /A Pending ticket's draft takes a revision too, which its ticket runs only once update_ticket releases it/,
  );
});

/**
 * What a session reading a run is told: that what the run wrote is as
 * untrusted as the run, how its transcript is read on while it is still
 * writing, and that an attempt with no error text has none rather than failing
 * to be read.
 */
test("the run reads say the run's text is untrusted and how each is read", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;
  const said = {
    read_run_transcript: [
      /as untrusted as anything a run wrote/,
      /`elided`, how many of the batches this page was cut from could not be read, so pages cut from the same batches repeat the count/,
      /`complete`, whether the run has ended/,
      /pass its `after` and `entry` back/,
      /the same read again answers what it wrote since/,
    ],
    read_run_error: [
      /as untrusted as anything a run wrote/,
      /\{bytes, content\}, or \{bytes, tail\} with the text's end/,
      /An attempt with none answers that it has none/,
      /`escalation\.failed`/,
      /`error\.bytes`/,
    ],
  };

  for (const [tool, claims] of Object.entries(said))
    for (const claim of claims) assert.match(described(tool), claim, tool);
});

test("two releases in one turn are two operations, and one repeated is one", async () => {
  const { api, call } = toolsOf({}, () => ({ status: 202, body: "{}" }));
  const release = (ticket) =>
    call("release_draft", {
      ticket,
      authoringVersion: 3,
      configurationRevision: "r1",
    });

  await release(4);
  await release(9);
  await release(4);

  const ids = api.calls.map(({ init }) => JSON.parse(init.body).operation);
  const keys = api.calls.map(({ init }) => init.headers["idempotency-key"]);
  assert.notEqual(
    ids[0],
    ids[1],
    "two releases of different drafts in one turn collide on one operation, and the second is an idempotency conflict naming nothing the lead can act on",
  );
  assert.equal(ids[0], ids[2], "one call repeated minted a second operation");
  assert.deepEqual(keys, ids, "the key and the operation are not the same");
});

test("a command's identity is a value the caller cannot have guessed", () => {
  const mutation = {
    mutation: "ReleaseDraft",
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  };

  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-1", { ...mutation, ticket: 9 }),
  );
  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-1", { ...mutation, authoringVersion: 4 }),
  );
  assert.notEqual(
    chuggyOperationIdentity("turn-1", mutation),
    chuggyOperationIdentity("turn-2", mutation),
  );
});

test("the same release repeated in one turn is the same operation, and a new turn is a new one", async () => {
  let turn = "turn-1";
  const { api, call } = toolsOf({ turn: () => turn }, () => ({
    status: 202,
    body: "{}",
  }));
  const args = { ticket: 4, authoringVersion: 3, configurationRevision: "r1" };

  await call("release_draft", args);
  await call("release_draft", args);
  turn = "turn-2";
  await call("release_draft", args);

  const ids = api.calls.map(({ init }) => JSON.parse(init.body).operation);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test("a command submitted with no turn claimed is refused rather than minted", async () => {
  const { api, call } = toolsOf({ turn: () => undefined });

  const answer = await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: "r1",
  });

  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /no turn is claimed/);
  assert.equal(api.calls.length, 0);
});

const origination = {
  configurationRevision: "r1",
  configurationDigest: "d1",
  expectedProjectSequence: 12,
  authoring: { dependencies: [] },
  brief: { title: "what the member asked for" },
};

test("an originated draft is filed at the drafts route, fenced and derived from nothing", async () => {
  const filed = JSON.stringify({ ticket: 14, version: 1 });
  const { api, call } = toolsOf({}, () => ({ status: 201, body: filed }));

  const answer = await call("create_draft", origination);

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/drafts",
  );
  assert.equal(
    api.calls[0].init.headers["content-type"],
    "application/vnd.chuggy.v1+json",
  );
  assert.deepEqual(JSON.parse(api.calls[0].init.body), origination);
  assert.equal(textOf(answer), `HTTP 201\n${filed}`);
  assert.ok(answer.isError === undefined);
});

test("an origination the API refuses is relayed unaltered and never asked again", async () => {
  const body = JSON.stringify({ error: "StaleProjectSequence" });
  const { api, call } = toolsOf({}, () => ({ status: 409, body }));

  const answer = await call("create_draft", origination);

  assert.equal(textOf(answer), `HTTP 409\n${body}`);
  assert.equal(answer.isError, true);
  assert.equal(api.calls.length, 1);
});

test("an origination without the fence the route requires never reaches it", async () => {
  const { api, call } = toolsOf();

  for (const missing of [
    "configurationRevision",
    "configurationDigest",
    "expectedProjectSequence",
    "authoring",
    "brief",
  ]) {
    const answer = await call(
      "create_draft",
      Object.fromEntries(
        Object.entries(origination).filter(([field]) => field !== missing),
      ),
    );

    assert.equal(answer.isError, true, missing);
  }
  assert.equal(api.calls.length, 0);
});

/** A catalog selection, which a draft on a catalog carries to the route as it was given. */
const selection = { work: "build-sonnet", evaluation: "standard" };

/**
 * Catches a secret the model read in its shell sent onward by a project tool:
 * in a body, a path, a query or a key the shape lets through, or the
 * operation minted from what was asked rather than from what was sent, so two
 * calls the API sees as one would be two operations.
 */
test("what a project tool sends is scrubbed of the session's secrets, and its operation minted from what is sent", async () => {
  const held = "AKIAIOSFODNN7EXAMPLE-wJalrXUtnFEMI";
  const scrub = credentialScrub([held]);
  const { api, call, context } = toolsOf({ scrub });
  const redacted = scrub(held);

  await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: `r-${held}`,
  });
  await call("release_draft", {
    ticket: 4,
    authoringVersion: 3,
    configurationRevision: `r-${redacted}`,
  });
  await call("read_configuration", { revision: held });
  await call("list_tickets", { phase: [held] });
  await chuggyToolDefinitions(context)
    .find(({ name }) => name === "create_draft")
    .call({ ...origination, brief: { title: "t", [held]: held } });

  assert.equal(api.calls.length, 5);
  for (const { path, init } of api.calls) {
    assert.ok(!path.includes(held), path);
    assert.ok(!String(init?.body ?? "").includes(held), path);
  }
  const [sent, again] = api.calls.map(({ init }) =>
    JSON.parse(init?.body ?? "{}"),
  );
  assert.equal(
    sent.mutation.configurationRevision,
    `r-${redacted}`,
    "the release sent was not the scrubbed one",
  );
  assert.equal(sent.operation, again.operation);
  assert.ok(
    api.calls[2].path.endsWith(
      `/configurations/${encodeURIComponent(redacted)}`,
    ),
  );
  assert.deepEqual(
    new URL(api.calls[3].path, "https://api.test").searchParams.getAll("phase"),
    [redacted],
  );
  assert.deepEqual(JSON.parse(api.calls[4].init.body).brief, {
    title: "t",
    [redacted]: redacted,
  });
});

/**
 * Files, depends and revises a draft once with `field` set to `value` and once
 * without it, and holds that the route was sent it exactly where it was given.
 */
async function draftWritesCarry(field, value) {
  const { api, call } = toolsOf();
  const revision = {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  };

  for (const [tool, args] of [
    ["create_draft", origination],
    ["file_dependent", dependent],
    ["revise_draft", revision],
  ]) {
    await call(tool, { ...args, [field]: value });
    await call(tool, args);
  }

  assert.equal(api.calls.length, 6);
  for (const [index, held] of api.calls.entries()) {
    const body = JSON.parse(held.init.body);
    if (index % 2 === 0) assert.deepEqual(body[field], value, held.path);
    else assert.equal(field in body, false, held.path);
  }
}

test("a draft filed or revised with a selection carries it to the route, and one without carries none", async () => {
  await draftWritesCarry("selection", selection);
});

test("a draft's defaults are initialized under the selection it will carry", async () => {
  const { api, call } = toolsOf();

  await call("initialize_draft", { revision: "r1", ...selection });

  assert.equal(
    api.calls[0].path,
    "/api/v1/tenants/vteng/projects/chuggy/draft-initializations/r1?work=build-sonnet&evaluation=standard",
  );
});

/** A catalog override changing one workload's model, which a draft carries to the route as it was given. */
const overrides = {
  workloads: {
    build: {
      worker: {
        mode: {
          type: "SingleAgent",
          agent: "Codex",
          arguments: [],
          model: "gpt-5-codex",
        },
        setup: [],
        files: [],
      },
    },
  },
};

test("a draft filed or revised with overrides carries them to the route, and one without carries none", async () => {
  await draftWritesCarry("overrides", overrides);
});

/** What a revision must send back is what read_draft answers, so the draft's read carries its overrides through. */
test("read_draft answers the overrides the draft holds", async () => {
  const body = JSON.stringify({ ticket: 4, authoringVersion: 2, overrides });
  const { call } = toolsOf({}, () => ({ status: 200, body }));

  const answer = await call("read_draft", { ticket: 4 });

  assert.equal(textOf(answer), `HTTP 200\n${body}`);
});

/** The overrides are explained on their own parameter, which no tool description's cut reaches. */
test("each draft tool's overrides parameter says what an override replaces and where to read it from", () => {
  for (const name of ["create_draft", "file_dependent", "revise_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const description = tool?.shape(z).overrides?.description ?? "";
    assert.match(description, /`workloads`|\{workloads\}/u, name);
    assert.match(description, /whole `worker`/u, name);
    assert.match(description, /read_configuration with a `path`/u, name);
  }
  assert.match(
    chuggyProjectTools.find(({ name }) => name === "revise_draft")?.shape(z)
      .overrides?.description ?? "",
    /send back the `overrides` read_draft answered/u,
  );
});

/** The selection is explained on its own parameter, which no tool description's cut reaches. */
test("each draft tool's selection parameter says what a selection is", () => {
  for (const name of ["create_draft", "file_dependent", "revise_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    assert.match(tool?.shape(z).selection?.description ?? "", /catalog/u, name);
  }
});

test("each draft tool's selection parameter names the revision a ticket follows", () => {
  for (const name of ["create_draft", "file_dependent", "revise_draft"]) {
    const tool = chuggyProjectTools.find((held) => held.name === name);
    const described = tool?.shape(z).selection?.description ?? "";
    assert.match(described, /`configuration` is "Pinned" or "Latest"/u, name);
    assert.match(described, /`defaults\.configuration`, or Pinned/u, name);
    assert.match(described, /leaves out part of its plan does not move/u, name);
    assert.match(described, /refused there/u, name);
  }
});

test("read_ticket says what a following ticket's `following` answers", () => {
  const described = chuggyProjectTools.find(
    ({ name }) => name === "read_ticket",
  ).description;
  assert.match(
    described,
    /carries `following`: its `verdict`, one of Current, Moves, Held or Trimmed, and for Held the `code`/u,
  );
});

const epicContentGiven = {
  title: "Search",
  summary: "Find things",
  description: "All of search.",
  visibility: "Active",
  tickets: [4, 5],
};

/** The content revise_epic is given without a description, which it keeps. */
const epicContentKeptGiven = {
  title: epicContentGiven.title,
  summary: epicContentGiven.summary,
  visibility: epicContentGiven.visibility,
  tickets: epicContentGiven.tickets,
};

/** A project's lead settings as the route answers them, `overrides` replacing what the project sets. */
function leadSettingsRead(overrides = leadSettingsOverrides, revision = 5) {
  const effective = {
    revision: 9,
    projectRevision: revision,
    mode: "Running",
    installationMode: "Running",
    dispatchMode: "Automatic",
    basePrompt: "Base.",
    northStar: "North.",
    threadStandingRules: "Rules.",
    modelAllowlist: [],
    toolAllowlist: [],
    limits: {},
    installationLimits: {},
    operationalContextMaxAgeMs: 60_000,
    leadOffering: "Own",
  };
  return {
    partition: { tenant: task.tenant, project: task.project },
    revision,
    overrides,
    effective,
  };
}

/** What a project's settings override, each kind of field among them. */
const leadSettingsOverrides = {
  northStar: "Ship the worker core.",
  basePrompt: "You are the lead.",
  mode: "Running",
  modelAllowlist: ["claude-opus-5-5"],
  limits: { tokensPerDecision: 100, toolCallsPerDecision: 20 },
};

/** A project's placement as the route answers it. */
const placementRead = {
  thread: { route: "InCluster", source: "Default" },
  lead: { route: "InCluster", source: "Project" },
  leadOffering: "Subsidized",
  leadOfferings: ["Own", "Subsidized"],
  choices: ["InCluster", "Pool"],
  runners: { mine: "Unregistered", project: "Live" },
};

/** What every project tool is driven with where a suite drives them all. */
const projectToolArguments = {
  list_tickets: {},
  read_ticket: { ticket: 7 },
  read_draft: { ticket: 7 },
  list_drafts: {},
  list_configurations: {},
  read_configuration: { revision: "r1" },
  read_decision_log: {},
  read_refusals: {},
  read_ticket_refusals: { ticket: 7 },
  read_ticket_landings: { ticket: 7 },
  read_landing_queues: {},
  read_lead: {},
  read_lead_transcript: {},
  list_executions: {},
  read_execution: { execution: "e-1" },
  read_run_transcript: { execution: "e-1", attempt: "a-1" },
  read_run_error: { execution: "e-1", attempt: "a-1" },
  read_operation: { operation: "o-1" },
  list_threads: {},
  read_thread: { session: "t-1" },
  read_thread_transcript: { session: "t-1" },
  list_repositories: {},
  fetch_image: { artifact: "image/png:ce47" },
  read_docs: {},
  read_abilities: {},
  list_epics: {},
  read_epic: { epic: 3 },
  read_epic_history: { epic: 3 },
  read_epic_graph: { epic: 3 },
  initialize_draft: { revision: "r1" },
  file_dependent: dependent,
  revise_draft: {
    ticket: 4,
    expectedVersion: 2,
    configurationRevision: "r1",
    authoring: { dependencies: [] },
    brief: { title: "t" },
  },
  delete_draft: { ticket: 4, expectedVersion: 2 },
  release_draft: {
    ticket: 4,
    authoringVersion: 2,
    configurationRevision: "r1",
  },
  create_draft: origination,
  revoke_ticket: { ticket: 26 },
  dispatch_ticket: { ticket: 26 },
  update_ticket: {
    ticket: 26,
    expectedRevision: 3,
    authoringVersion: 2,
    configurationRevision: "r1",
  },
  create_epic: epicContentGiven,
  revise_epic: { epic: 3, expectedRevision: 5, ...epicContentGiven },
  add_epic_tickets: { epic: 3, tickets: [9] },
  remove_epic_tickets: { epic: 3, tickets: [4] },
  read_lead_settings: {},
  update_lead_settings: { expectedRevision: 5, set: { mode: "Paused" } },
  read_placement: {},
  update_placement: { lead: "Pool" },
};

/** What every member tool is driven with where a suite drives them all. */
const memberToolArguments = {
  read_my_abilities: {},
  list_projects: {},
  list_my_threads: {},
  read_my_thread: { session: "session-9" },
  list_my_runners: {},
  read_chat_host: {},
};

/** Every tool's arguments, project and member alike. */
const toolArguments = { ...projectToolArguments, ...memberToolArguments };

/**
 * Catches a tool built on a route outside its session's own project, which the
 * API refuses a session bearer however the membership reads: an inventory of
 * every project the principal sees is one.
 */
test("every project tool reaches its own session's project and nothing outside it", async () => {
  const partition = "/api/v1/tenants/vteng/projects/chuggy";
  assert.deepEqual(
    chuggyProjectTools.map(({ name }) => name).sort(),
    Object.keys(projectToolArguments).sort(),
  );
  for (const definition of chuggyProjectTools) {
    const api = apiOf();

    await definition.call(
      chuggyToolContext(task, bearer, {
        request: api.request,
        docsFetch: async () => new globalThis.Response("# docs"),
        turn: () => "turn-1",
      }),
      projectToolArguments[definition.name],
    );

    if (definition.name === "read_docs") {
      assert.equal(api.calls.length, 0, "read_docs asked chuggy's API");
      continue;
    }
    assert.equal(api.calls.length, 1, definition.name);
    const { pathname } = new URL(api.calls[0].path, task.api.url);
    assert.ok(
      pathname === partition || pathname.startsWith(`${partition}/`),
      `${definition.name} reached ${pathname}`,
    );
  }
});

test("origination, revocation, updating and dispatching are registered for a thread's roster and for no lead's", () => {
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);

  assert.deepEqual(registered(["DraftOriginate"]), [
    "create_draft",
    "revoke_ticket",
    "update_ticket",
    "create_epic",
    "revise_epic",
    "add_epic_tickets",
    "remove_epic_tickets",
  ]);
  assert.deepEqual(registered(["TicketDispatch"]), ["dispatch_ticket"]);
  for (const tool of [
    "create_draft",
    "revoke_ticket",
    "update_ticket",
    "create_epic",
    "revise_epic",
    "add_epic_tickets",
    "remove_epic_tickets",
    "dispatch_ticket",
  ]) {
    assert.ok(registered([...threadRoster]).includes(tool), tool);
    assert.ok(
      !registered([...leadRoster]).includes(tool),
      `a lead's roster registered ${tool}`,
    );
  }
});

/** What each offer tool is driven with where a suite drives them all, `navigate` with a page carrying a field beside its name. */
const offerToolArguments = {
  navigate: { page: "TicketNew", draft: 7 },
  offer_release: { ticket: 4, authoringVersion: 2 },
  offer_revoke: { ticket: 26, revision: 3 },
};

test("the offer tools are registered under ThreadOffer alone, and no roster without it reaches one", () => {
  const offers = Object.keys(offerToolArguments);
  const registered = (capabilities) =>
    chuggyToolDefinitions(
      chuggyToolContext(task, bearer, {
        capabilities,
        staging: leadDecisionStaging(),
      }),
    ).map(({ name }) => name);
  const without = everyCapability.filter(
    (capability) => capability !== "ThreadOffer",
  );

  assert.deepEqual(registered(["ThreadOffer"]), offers);
  assert.deepEqual(
    registered(without).filter((name) => offers.includes(name)),
    [],
  );
  const { allowedTools, disallowedTools } = sessionAllowedTools(without);
  for (const offer of offers) {
    assert.ok(!allowedTools.includes(`${chuggyToolPrefix}${offer}`), offer);
    assert.ok(disallowedTools.includes(`${chuggyToolPrefix}${offer}`), offer);
  }
});

test("each offer tool takes the contract's shape and answers without asking any route", async () => {
  for (const [name, args] of Object.entries(offerToolArguments)) {
    const { api, call } = toolsOf();

    const answer = await call(name, args);

    assert.ok(answer.isError === undefined, name);
    assert.equal(api.calls.length, 0, name);
  }
});

test("navigate answers the page it was given, a field beside its name included", async () => {
  for (const page of [
    { page: "TicketNew", draft: 7 },
    { page: "TicketNew", from: 3 },
    { page: "TicketNew" },
    { page: "Ticket", ticket: 41 },
    { page: "Settings", section: "ProjectPlacement" },
    { page: "Repository", repository: "github.com/acme/atlas" },
    { page: "Inbox" },
  ]) {
    const { call } = toolsOf();

    const answer = await call("navigate", page);

    assert.ok(answer.isError === undefined, JSON.stringify(page));
    assert.deepEqual(
      JSON.parse(/^.*? to (\{.*\})\.$/u.exec(textOf(answer))[1]),
      page,
    );
  }
});

test("each offer tool refuses an input the contract does not parse, as an error that asks no route", async () => {
  for (const [name, args, why] of [
    ["navigate", { page: "Nowhere" }, /page/u],
    ["navigate", { page: "Ticket" }, /navigate names no page/u],
    ["navigate", { page: "Inbox", ticket: 4 }, /navigate names no page/u],
    [
      "navigate",
      { page: "TicketNew", from: 3, draft: 7 },
      /navigate names no page/u,
    ],
    ["navigate", { page: "Settings", section: "Nowhere" }, /section/u],
    ["offer_release", { ticket: 4 }, /authoringVersion/u],
    ["offer_release", { ticket: 4, authoringVersion: -1 }, /authoringVersion/u],
    ["offer_revoke", { ticket: 26 }, /revision/u],
    ["offer_revoke", { ticket: 26, revision: 0 }, /revision/u],
    ["navigate", { page: "Inbox", tab: "Unread" }, /tab/u],
    [
      "offer_release",
      { ticket: 4, authoringVersion: 2, revision: 3 },
      /revision/u,
    ],
    [
      "offer_revoke",
      { ticket: 26, revision: 3, authoringVersion: 2 },
      /authoringVersion/u,
    ],
  ]) {
    const { api, call } = toolsOf();

    const answer = await call(name, args);

    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(textOf(answer), why);
    assert.equal(api.calls.length, 0, name);
  }
});

/**
 * The runtime validates a call against the schema it was handed before the
 * handler sees it, so an undeclared key the handed schema drops never reaches
 * the handler's own check, and still stands in the call the console reads.
 */
test("the server hands the runtime an offer tool's input as a schema that refuses an undeclared key", () => {
  const server = chuggyToolServer(
    chuggyToolContext(task, bearer, {
      capabilities: ["ThreadOffer"],
      staging: leadDecisionStaging(),
    }),
    {
      z,
      tool: (name, description, schema) => ({ name, schema }),
      createSdkMcpServer: (options) => options,
    },
  );

  for (const { name, schema } of server.tools) {
    const args = offerToolArguments[name];
    assert.equal(schema.safeParse(args).success, true, name);
    assert.equal(schema.safeParse({ ...args, extra: 1 }).success, false, name);
  }
});

/**
 * Every project tool through the handler a session is given, which is where a
 * tool that answered without asking stood: a suite that drives the definition
 * passes whatever is between it and the session.
 */
test("every project tool a session holds asks its route, read_docs the docs host, and answers what it was answered", async (t) => {
  const temporary = await temporaryOf(t);
  for (const { name } of chuggyProjectTools) {
    const docs = [];
    const { api, call } = toolsOf(
      {
        imageFile: chuggyToolImageFiles({ TMPDIR: temporary }),
        docsFetch: async (url) => {
          docs.push(String(url));
          return new globalThis.Response("# docs");
        },
      },
      (path) => ({
        status: 200,
        body: path.includes("/artifacts/")
          ? JSON.stringify(pngAnswered)
          : path.endsWith("/error")
            ? JSON.stringify({ read: "Content", content: "x" })
            : path.endsWith("/landings")
              ? JSON.stringify({ landings: [], truncated: false })
              : path.endsWith("/landing-queues")
                ? JSON.stringify({ queues: [], truncated: false })
                : path.includes("/dispatch-view")
                  ? dispatchViewPage([{ ticket: 26, ticketVersion: 41 }])
                  : path.endsWith("/repositories")
                    ? JSON.stringify({ repositories: [] })
                    : path.includes("/configurations?")
                      ? JSON.stringify({ configurations: [] })
                      : path.endsWith("/epics/3")
                        ? JSON.stringify(epicRead)
                        : path.includes("/draft-initializations/")
                          ? JSON.stringify(draftInitialized)
                          : path.endsWith("/selector-settings")
                            ? JSON.stringify(leadSettingsRead())
                            : path.endsWith("/session-placement")
                              ? JSON.stringify(placementRead)
                              : "{}",
      }),
    );

    const answer = await call(name, projectToolArguments[name]);

    const asked =
      {
        dispatch_ticket: 2,
        read_docs: 0,
        add_epic_tickets: 2,
        remove_epic_tickets: 2,
        update_lead_settings: 2,
        update_placement: 2,
      }[name] ?? 1;
    assert.equal(api.calls.length, asked, name);
    assert.equal(docs.length, name === "read_docs" ? 1 : 0, name);
    assert.ok(answer.isError === undefined, name);
  }
});

/** A member's own session's task: its tenant and its API, and no project at all, so a tool that read one would raise. */
const memberTask = { tenant: "vteng", api: { url: task.api.url } };

/**
 * A member's own session's tools over a fake chuggy, which records each
 * request with the bearer it carried and answers what `answer` makes of its
 * path, or an empty body.
 */
function memberToolsOf(answer) {
  const calls = [];
  const docs = [];
  const context = chuggyToolContext(memberTask, bearer, {
    capabilities: ["MemberRead"],
    request: async (_task, carried, path, init) => {
      calls.push({ bearer: carried, path, method: init?.method ?? "GET" });
      const given = answer?.(path) ?? { status: 200, body: "{}" };
      return { status: given.status, text: async () => given.body };
    },
    docsFetch: async (url) => {
      docs.push(String(url));
      return new globalThis.Response("# docs");
    },
    turn: () => "turn-1",
  });
  const held = new Map(
    chuggyToolDefinitions(context).map((definition) => [
      definition.name,
      chuggyToolHandler(definition, z),
    ]),
  );
  return { calls, docs, held, call: (name, args) => held.get(name)(args) };
}

test("a member's own session is served its member tools and read_docs, and no project or decision tool", () => {
  const { held } = memberToolsOf();

  assert.deepEqual(
    [...held.keys()].sort(),
    [...chuggyToolCapabilities.MemberRead].sort(),
  );
  assert.deepEqual(
    [...held.keys()].filter((name) => name !== "read_docs").sort(),
    chuggyMemberTools.map(({ name }) => name).sort(),
  );
});

/** Catches a member tool built on a project's route, which the API refuses a member's own session's bearer outright. */
test("every member tool asks its own tenant's route under the session's bearer, and names no project", async () => {
  const asked = {
    read_my_abilities: [{}, "/api/v1/tenants/vteng/chat/abilities"],
    list_projects: [
      { after: "alpha", limit: 2 },
      "/api/v1/tenants/vteng/chat/projects?after=alpha&limit=2",
    ],
    list_my_threads: [{}, "/api/v1/tenants/vteng/chat/threads"],
    read_my_thread: [
      { session: "session 9", before: 4, limit: 2 },
      "/api/v1/tenants/vteng/chat/threads/session%209?before=4&limit=2",
    ],
    list_my_runners: [{}, "/api/v1/tenants/vteng/personal-runner"],
    read_chat_host: [{}, "/api/v1/tenants/vteng/chat-host"],
  };
  assert.deepEqual(
    Object.keys(asked).sort(),
    chuggyMemberTools.map(({ name }) => name).sort(),
  );
  for (const [name, [args, path]] of Object.entries(asked)) {
    const { calls, docs, call } = memberToolsOf(() => ({
      status: 200,
      body: '{"read":"yes"}',
    }));

    const answer = await call(name, args);

    assert.equal(answer.isError, undefined, name);
    assert.equal(textOf(answer), 'HTTP 200\n{"read":"yes"}', name);
    assert.deepEqual(calls, [{ bearer, path, method: "GET" }], name);
    assert.deepEqual(docs, [], name);
  }
});

test("a member's own session reads the docs from the docs host and asks chuggy's API nothing", async () => {
  const { calls, docs, call } = memberToolsOf();

  const answer = await call("read_docs", {});

  assert.equal(answer.isError, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(docs, [chuggyDocsIndex]);
});

test("a member tool relays a refusal as the API answered it", async () => {
  for (const [name, status, body] of [
    ["list_my_runners", 404, '{"code":"NotFound"}'],
    ["read_chat_host", 404, '{"code":"NotFound"}'],
    ["read_my_thread", 404, '{"code":"NotFound"}'],
    ["list_projects", 403, '{"code":"Forbidden"}'],
    ["read_my_abilities", 401, '{"action":"stop"}'],
  ]) {
    const { calls, call } = memberToolsOf(() => ({ status, body }));

    const answer = await call(name, memberToolArguments[name]);

    assert.equal(answer.isError, true, name);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`, name);
    assert.equal(calls.length, 1, name);
  }
});

test("a member tool refuses arguments outside its shape and asks nothing", async () => {
  const { calls, call } = memberToolsOf();

  for (const [name, args] of [
    ["read_my_thread", {}],
    ["read_my_thread", { session: "" }],
    ["read_my_thread", { session: "s", before: 0 }],
    ["read_my_thread", { session: "s", limit: threadTurnsAnsweredMax + 1 }],
    ["list_projects", { limit: nativeHttpPageItemsMax + 1 }],
    ["list_projects", { after: "" }],
  ]) {
    const answer = await call(name, args);
    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(calls, []);
});

/**
 * Each member tool names the fields its route answers and what that route
 * leaves out: projects in retention are never listed, the thread listing is
 * capped with no marker of what it cut, a project's thread and a member with
 * no runner or host are each answered 404, and a page's turns are oldest first.
 */
test("each member tool is described as its route answers it", () => {
  const described = (tool) =>
    chuggyMemberTools.find(({ name }) => name === tool).description;
  const claims = {
    read_my_abilities: [
      /`principal`, their principal, encoded as a ticket's `creator` is/,
      /`openUnscopedChat`, `executeHosted`, `registerPersonalRunner` and `administerTenant`, each true or false/,
    ],
    list_projects: [
      /in identity order, none in retention/,
      /its `lifecycle` \(Active, Suspended, IntegrityBlocked or Deleting\) and `role`/,
      /may hold fewer, or none, and only `nextAfter`, present, says there are more/,
    ],
    list_my_threads: [
      /Their own open threads come first, then their other open ones, then the rest, each by when it last moved, newest first/,
      /as many as one answer holds, so an older one past them is not listed/,
      /its `state` \(Open or Closed\)/,
      /`lastActivityAt`, when it last moved, and `hidden`/,
    ],
    read_my_thread: [
      /`turns`, the newest before `before`, oldest first/,
      /`nextBefore`, present, is the cursor for the turns before them/,
      /A project's thread, or a session that is not one of theirs, is answered 404/,
    ],
    list_my_runners: [
      /`polledAt`, its newest poll, absent until it polls, `live`/,
      /`executionsLive`, the same of its newest poll for executions alone, which may be older/,
      /the version chuggy `pinned` for it where it pins one, absent where it named none; and `projects`/,
      /Answers 404 where they have none/,
    ],
    read_chat_host: [
      /`polledAt`, its newest poll, absent until it polls, `live`/,
      /the version chuggy `pinned` for it where it pins one, absent where it named none/,
      /Answers 404 where they have none/,
    ],
  };
  assert.deepEqual(
    Object.keys(claims).sort(),
    chuggyMemberTools.map(({ name }) => name).sort(),
  );
  for (const [tool, said] of Object.entries(claims))
    for (const claim of said) assert.match(described(tool), claim, tool);
  assert.doesNotMatch(described("list_projects"), /Retention\)/);
  assert.doesNotMatch(described("list_my_threads"), /Orphaned/);
});

/** The `limit` one request asked with, or nothing where it asked with none. */
function limitAsked({ path }) {
  const asked = new URL(path, task.api.url).searchParams.get("limit");
  return asked === null ? undefined : Number(asked);
}

/**
 * The executions read at the weight an item ran on a live project, where a
 * page of fifty was refused and the model was left to guess a limit. The
 * route answers as many items as it is asked for and the cursor past them.
 */
test("a page too large is asked for again at half its limit until one fits, and that page is answered", async () => {
  const { api, call } = toolsOf({}, (path) => {
    const items = Array.from({ length: limitAsked({ path }) }, (_, at) => ({
      at,
      held: "x".repeat(1_400),
    }));
    return {
      status: 200,
      body: JSON.stringify({ items, nextCursor: `c-${String(items.length)}` }),
    };
  });

  const answer = await call("list_executions", {
    ticket: 3,
    state: ["Running"],
    cursor: "c-0",
    limit: 50,
  });

  const asked =
    "/api/v1/tenants/vteng/projects/chuggy/executions?ticket=3&state=Running&cursor=c-0&limit=";
  assert.deepEqual(
    api.calls.map(({ path }) => path),
    [`${asked}50`, `${asked}25`, `${asked}12`],
  );
  assert.ok(answer.isError === undefined);
  const page = JSON.parse(textOf(answer).slice("HTTP 200\n".length));
  assert.equal(page.items.length, 12);
  assert.equal(page.nextCursor, "c-12");
});

/** A page as `name`'s route answers one, empty or holding `bytes` in one item; list_configurations parses its page, so its item is a revision. */
function pageBodyOf(name, bytes) {
  if (name !== "list_configurations")
    return bytes === undefined ? "{}" : "x".repeat(bytes);
  return JSON.stringify({
    configurations:
      bytes === undefined
        ? []
        : [
            {
              readiness: "Incomplete",
              revision: "x".repeat(bytes),
              provenance: { source: "Authored" },
            },
          ],
  });
}

test("a call that gave no limit asks again from half the largest its shape admits", async () => {
  for (const [name, max] of Object.entries(pageBounds)) {
    const { api, call } = toolsOf({}, (path) => ({
      status: 200,
      body: pageBodyOf(
        name,
        limitAsked({ path }) === undefined
          ? chuggyToolAnswerBytesMax
          : undefined,
      ),
    }));

    const answer = await call(name, toolArguments[name]);

    assert.ok(answer.isError === undefined, name);
    assert.equal(textOf(answer), `HTTP 200\n${pageBodyOf(name)}`, name);
    assert.deepEqual(
      api.calls.map(limitAsked),
      [undefined, Math.floor(max / 2)],
      name,
    );
  }
});

/**
 * Every paged read against an item too large alone, from the largest page it
 * admits, which is the most one call can ask. Each ask is a read the client may
 * repeat with a wait between, so the waits of every ask are added up here and
 * held under the tool's own timeout: past it, a refusal would reach the model
 * as a timeout that says nothing.
 */
test("an item too large alone is refused once one is asked for, inside what a tool call may wait", async () => {
  for (const [name, max] of Object.entries(pageBounds)) {
    const { api, call } = toolsOf({}, () => ({
      status: 200,
      body: pageBodyOf(name, chuggyToolAnswerBytesMax),
    }));

    const answer = await call(name, {
      ...toolArguments[name],
      limit: max,
    });

    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), /is already asking for one/, name);
    const limits = api.calls.map(limitAsked);
    assert.equal(limits[0], max, name);
    assert.equal(limits.at(-1), 1, name);
    for (const [at, limit] of limits.slice(1).entries())
      assert.equal(limit, Math.floor(limits[at] / 2), name);
    assert.ok(
      limits.length * (chuggyRequestAttemptsMax - 1) * chuggyRequestRetryMs <
        chuggyToolTimeoutMs,
      `${name} can wait out its own timeout`,
    );
  }
});

test("every subset of the capabilities admits its tools and disallows the rest", () => {
  const every = [
    ...sessionBuiltInTools,
    ...allChuggyTools.map((tool) => `${chuggyToolPrefix}${tool}`),
  ];
  for (let subset = 0; subset < 2 ** everyCapability.length; subset += 1) {
    const held = everyCapability.filter(
      (_, index) => ((subset >> index) & 1) === 1,
    );
    const admitted = new Set(
      held.flatMap((name) =>
        sessionCapabilityTools[name].map((tool) =>
          sessionBuiltInTools.includes(tool)
            ? tool
            : `${chuggyToolPrefix}${tool}`,
        ),
      ),
    );

    const { allowedTools, disallowedTools } = sessionAllowedTools(held);

    assert.deepEqual(new Set(allowedTools), admitted, held.join(","));
    assert.deepEqual(
      [...allowedTools, ...disallowedTools].sort(),
      [...every].sort(),
      held.join(","),
    );
  }
});

/**
 * The runtime's own tool-discovery tool is admitted by no capability, and a
 * built-in the roster does not carry is in NEITHER list — governed by
 * `permissionMode: "bypassPermissions"` alone, which is no roster at all. So a
 * roster that merely declines to grant it still offers it, and a lead that
 * reaches for it has the whole decision it was in refused against
 * `toolAllowlist`, which is derived from the roster and cannot name it.
 */
test("the runtime's tool-discovery tool is denied by name to every roster", () => {
  const discovery = "ToolSearch";

  for (const [capability, tools] of Object.entries(sessionCapabilityTools))
    assert.ok(!tools.includes(discovery), `${capability} admits it`);
  for (const held of [[], [...leadRoster], everyCapability]) {
    const { allowedTools, disallowedTools } = sessionAllowedTools(held);

    assert.ok(
      disallowedTools.includes(discovery),
      `${held.join(",")} does not deny it by name`,
    );
    assert.ok(!allowedTools.includes(discovery), `${held.join(",")} allows it`);
  }
});

test("a session with no ProjectRead disallows every chuggy read by name", () => {
  const { allowedTools, disallowedTools } = sessionAllowedTools([
    "RepositoryRead",
    "LeadDecision",
  ]);

  for (const tool of sessionCapabilityTools.ProjectRead) {
    const name = `${chuggyToolPrefix}${tool}`;
    assert.ok(disallowedTools.includes(name), `${name} was not disallowed`);
    assert.ok(!allowedTools.includes(name), `${name} was allowed`);
  }
});

test("a capability this image does not know admits nothing", () => {
  const { allowedTools, disallowedTools } = sessionAllowedTools(["Telepathy"]);

  assert.deepEqual(allowedTools, []);
  assert.equal(
    disallowedTools.length,
    sessionBuiltInTools.length + allChuggyTools.length,
  );
});

// Claude Code cuts an MCP tool's description at this many characters, so a
// clause past it is one the agent never reads.
const toolDescriptionCharsMax = 2048;

test("every tool's description is whole within what Claude Code passes an agent", () => {
  for (const { name, description } of chuggyProjectTools)
    assert.ok(
      description.length <= toolDescriptionCharsMax,
      `${name}: ${String(description.length)}`,
    );
});

/** An epic as its route reads it. */
const epicRead = {
  number: 3,
  revision: 5,
  title: "Search",
  summary: "Find things",
  visibility: "Active",
  progress: { byPhase: { Done: 1, Pending: 1 }, done: 1, total: 2 },
  status: "in_progress",
  waitingOnOutside: [],
  description: "All of search.",
  tickets: [4, 5],
};

const epicsPath = "/api/v1/tenants/vteng/projects/chuggy/epics";

/** A fake chuggy that holds one epic: reads answer it, writes answer `written` in turn. */
function epicApi(written) {
  const answers = [...written];
  return toolsOf({}, (_path, init) =>
    (init?.method ?? "GET") === "GET"
      ? { status: 200, body: JSON.stringify(epicRead) }
      : answers.shift(),
  );
}

test("each epic tool reaches the route the contract names for it", async () => {
  for (const [[name, args], suffix] of [
    [["list_epics", {}], "/epics"],
    [
      [
        "list_epics",
        {
          search: "find",
          visibility: "All",
          ticket: 4,
          sort: "title",
          after: 2,
          limit: 5,
        },
      ],
      "/epics?search=find&visibility=All&ticket=4&sort=title&after=2&limit=5",
    ],
    [["read_epic", { epic: 3 }], "/epics/3"],
    [
      ["read_epic_history", { epic: 3, after: 2, limit: 5 }],
      "/epics/3/history?after=2&limit=5",
    ],
    [["read_epic_graph", { epic: 3 }], "/epics/3/graph"],
    [["list_tickets", { epic: 3, limit: 5 }], "?limit=5&epic=3"],
  ]) {
    const api = apiOf();

    await routeOf(name, args, api);

    assert.equal(
      api.calls[0].path,
      `/api/v1/tenants/vteng/projects/chuggy${suffix}`,
      name,
    );
    assert.equal(api.calls[0].method, "GET", name);
  }
});

test("create_epic writes the content at the epics route as a Create", async () => {
  const saved = JSON.stringify({ epic: 8, revision: 1 });
  const { api, call } = toolsOf({}, () => ({ status: 200, body: saved }));

  const answer = await call("create_epic", epicContentGiven);

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, "POST");
  assert.equal(api.calls[0].path, epicsPath);
  assert.deepEqual(JSON.parse(api.calls[0].init.body), {
    kind: "Create",
    content: epicContentGiven,
  });
  assert.equal(textOf(answer), `HTTP 200\n${saved}`);
  assert.ok(answer.isError === undefined);
});

test("revise_epic writes whole against the revision it was given, and a refusal is relayed unaltered and never asked again", async () => {
  const body = JSON.stringify({
    error: { code: "StaleRevision", message: "stale" },
    current: 6,
  });
  const { api, call } = toolsOf({}, () => ({ status: 409, body }));

  const answer = await call("revise_epic", {
    epic: 3,
    expectedRevision: 5,
    ...epicContentGiven,
  });

  assert.equal(api.calls.length, 1);
  assert.deepEqual(JSON.parse(api.calls[0].init.body), {
    kind: "Revise",
    epic: 3,
    expected: 5,
    content: epicContentGiven,
  });
  assert.equal(textOf(answer), `HTTP 409\n${body}`);
  assert.equal(answer.isError, true);
});

test("an epic write past the title, summary, content or tickets bound is refused before any call is made", async () => {
  const { api, call } = toolsOf();
  const tooMany = Array.from({ length: epicTicketsMax + 1 }, (_, i) => i + 1);

  for (const content of [
    { ...epicContentGiven, title: "t".repeat(epicTitleCharsMax + 1) },
    { ...epicContentGiven, summary: "s".repeat(epicSummaryCharsMax + 1) },
    { ...epicContentGiven, description: "d".repeat(epicContentBytesMax + 1) },
    { ...epicContentGiven, visibility: "All" },
    { ...epicContentGiven, tickets: tooMany },
  ])
    assert.equal((await call("create_epic", content)).isError, true);
  for (const tool of ["add_epic_tickets", "remove_epic_tickets"])
    assert.equal(
      (await call(tool, { epic: 3, tickets: tooMany })).isError,
      true,
    );
  assert.equal(api.calls.length, 0);
});

test("an epic's title and summary are bounded in code points, as the API counts them", async () => {
  const saved = JSON.stringify({ epic: 8, revision: 1 });
  const { api, call } = toolsOf({}, () => ({ status: 200, body: saved }));
  const astral = "\u{1F50D}";

  const answer = await call("create_epic", {
    ...epicContentGiven,
    title: astral.repeat(epicTitleCharsMax),
    summary: astral.repeat(epicSummaryCharsMax),
  });

  assert.ok(answer.isError === undefined, textOf(answer));
  assert.equal(api.calls.length, 1);
});

test("add_epic_tickets reads the epic and revises it with only its members changed", async () => {
  const saved = JSON.stringify({ epic: 3, revision: 6 });
  const { api, call } = epicApi([{ status: 200, body: saved }]);

  const answer = await call("add_epic_tickets", { epic: 3, tickets: [9, 4] });

  assert.deepEqual(
    api.calls.map(({ method }) => method),
    ["GET", "POST"],
  );
  assert.equal(api.calls[0].path, `${epicsPath}/3`);
  assert.deepEqual(JSON.parse(api.calls[1].init.body), {
    kind: "Revise",
    epic: 3,
    expected: 5,
    content: {
      title: "Search",
      summary: "Find things",
      description: "All of search.",
      visibility: "Active",
      tickets: [4, 5, 9],
    },
  });
  assert.equal(textOf(answer), `HTTP 200\n${saved}`);
});

test("remove_epic_tickets drops the named members that are in the epic and leaves the rest", async () => {
  const { api, call } = epicApi([{ status: 200, body: "{}" }]);

  await call("remove_epic_tickets", { epic: 3, tickets: [4, 99] });

  assert.deepEqual(JSON.parse(api.calls[1].init.body).content.tickets, [5]);
});

test("a membership change that changes nothing writes nothing", async () => {
  for (const [name, tickets, said] of [
    ["add_epic_tickets", [4, 5], /already holds those tickets/],
    ["remove_epic_tickets", [99], /holds none of those tickets/],
  ]) {
    const { api, call } = epicApi([]);

    const answer = await call(name, { epic: 3, tickets });

    assert.deepEqual(
      api.calls.map(({ method }) => method),
      ["GET"],
      name,
    );
    assert.match(textOf(answer), said, name);
    assert.match(textOf(answer), /stays at revision 5/, name);
    assert.ok(answer.isError === undefined, name);
  }
});

test("a membership write that went stale is read and written once more, from a fresh read", async () => {
  const stale = {
    status: 409,
    body: JSON.stringify({
      error: { code: "StaleRevision", message: "stale" },
      current: 6,
    }),
  };
  const saved = JSON.stringify({ epic: 3, revision: 7 });
  const newer = {
    ...epicRead,
    revision: 6,
    title: "Search v2",
    tickets: [4, 5, 6],
  };
  let posts = 0;
  const { api, call } = toolsOf({}, (_path, init) => {
    if ((init?.method ?? "GET") === "GET")
      return {
        status: 200,
        body: JSON.stringify(posts === 0 ? epicRead : newer),
      };
    posts += 1;
    return posts === 1 ? stale : { status: 200, body: saved };
  });

  const answer = await call("add_epic_tickets", { epic: 3, tickets: [9] });

  assert.deepEqual(
    api.calls.map(({ method }) => method),
    ["GET", "POST", "GET", "POST"],
  );
  const retried = JSON.parse(api.calls[3].init.body);
  assert.equal(retried.expected, 6);
  assert.equal(retried.content.title, "Search v2");
  assert.deepEqual(retried.content.tickets, [4, 5, 6, 9]);
  assert.equal(textOf(answer), `HTTP 200\n${saved}`);
});

test("a second stale membership write and any other refusal are relayed, not asked again", async () => {
  const stale = {
    status: 409,
    body: JSON.stringify({ error: { code: "StaleRevision", message: "s" } }),
  };
  const twice = epicApi([stale, stale]);

  const answer = await twice.call("add_epic_tickets", {
    epic: 3,
    tickets: [9],
  });

  assert.equal(twice.api.calls.length, 4);
  assert.equal(textOf(answer), `HTTP 409\n${stale.body}`);
  assert.equal(answer.isError, true);

  const unknown = {
    status: 409,
    body: JSON.stringify({
      error: { code: "UnknownTickets", message: "u" },
      tickets: [9],
    }),
  };
  const once = epicApi([unknown]);

  const refused = await once.call("add_epic_tickets", {
    epic: 3,
    tickets: [9],
  });

  assert.equal(once.api.calls.length, 2);
  assert.equal(textOf(refused), `HTTP 409\n${unknown.body}`);
});

test("a membership change reads an epic whose content is at its cap, past an ordinary read's bound", async () => {
  const content = { ...epicRead, description: "" };
  const spare =
    epicContentBytesMax -
    Buffer.byteLength(
      JSON.stringify({
        title: content.title,
        summary: content.summary,
        description: "",
        visibility: content.visibility,
        tickets: content.tickets,
      }),
    );
  const heaviest = { ...content, description: "d".repeat(spare) };
  const body = JSON.stringify(heaviest);
  assert.ok(Buffer.byteLength(body) > chuggyToolResponseBytesMax);
  assert.ok(Buffer.byteLength(body) <= chuggyToolEpicViewResponseBytesMax);
  const saved = JSON.stringify({ epic: 3, revision: 6 });
  const { api, call } = toolsOf({}, (_path, init) =>
    (init?.method ?? "GET") === "GET"
      ? { status: 200, body }
      : { status: 200, body: saved },
  );

  const answer = await call("remove_epic_tickets", { epic: 3, tickets: [4] });

  assert.equal(textOf(answer), `HTTP 200\n${saved}`);
  assert.equal(
    JSON.parse(api.calls[1].init.body).content.description,
    heaviest.description,
  );
});

/**
 * An epic whose content is at its cap and whose fields beside it are at their
 * heaviest, escaping included, with a description holding pairs that are one
 * code point, so its view is more than one answer holds.
 */
function epicAtCap() {
  const heavy = {
    ...epicRead,
    title: '"'.repeat(epicTitleCharsMax),
    summary: "\u0001".repeat(epicSummaryCharsMax),
    tickets: Array.from(
      { length: epicTicketsMax },
      (_, i) => Number.MAX_SAFE_INTEGER - i,
    ),
    waitingOnOutside: Array.from(
      { length: epicTicketsMax },
      () => Number.MAX_SAFE_INTEGER,
    ),
  };
  const contentBytes = (description) =>
    Buffer.byteLength(
      JSON.stringify({
        title: heavy.title,
        summary: heavy.summary,
        description,
        visibility: heavy.visibility,
        tickets: heavy.tickets,
      }),
    );
  const line = 'Ship "search" 🙂.\n';
  let description = line.repeat(
    Math.floor(
      (epicContentBytesMax - contentBytes("")) /
        (contentBytes(line) - contentBytes("")),
    ),
  );
  while (contentBytes(`${description}d`) <= epicContentBytesMax)
    description += "d";
  return { ...heavy, description };
}

test("read_epic answers an epic that fits as the route answered it, and one at its cap as its description in pieces that read on to the whole", async () => {
  const fits = epicApi([]);
  assert.equal(
    textOf(await fits.call("read_epic", { epic: 3 })),
    `HTTP 200\n${JSON.stringify(epicRead)}`,
  );

  const heaviest = epicAtCap();
  const body = JSON.stringify(heaviest);
  assert.ok(Buffer.byteLength(body) > chuggyToolResponseBytesMax);
  assert.ok(Buffer.byteLength(body) <= chuggyToolEpicViewResponseBytesMax);
  const { call } = toolsOf({}, () => ({ status: 200, body }));
  const { description, ...fields } = heaviest;
  let read = "";
  let offset;
  for (let reads = 1; reads <= description.length; reads += 1) {
    const answer = await call("read_epic", { epic: 3, offset });
    assert.equal(answer.isError, undefined, textOf(answer));
    const text = textOf(answer);
    assert.ok(chuggyToolAnswerBytes(text) <= chuggyToolAnswerBytesMax);
    assert.equal(text.slice(0, text.indexOf("\n")), "HTTP 200");
    const piece = JSON.parse(text.slice(text.indexOf("\n") + 1));
    for (const [key, value] of Object.entries(fields))
      assert.deepEqual(piece[key], value, key);
    assert.equal(piece.descriptionOffset, offset ?? 0);
    assert.equal(piece.descriptionChars, description.length);
    read += piece.description;
    if (piece.descriptionCharsLeft === 0) break;
    offset = piece.descriptionOffset + piece.description.length;
    assert.match(piece.note, new RegExp(`offset ${String(offset)} reads on`));
  }
  assert.ok(offset !== undefined, "the epic at its cap was answered whole");
  assert.equal(read, description);

  const past = await call("read_epic", {
    epic: 3,
    offset: description.length + 1,
  });
  assert.equal(past.isError, true);
  assert.match(textOf(past), /past the end of this epic's description/);
});

test("revise_epic sent no description keeps the one the epic holds, at its cap, and writes it against the revision it was given", async () => {
  const heaviest = epicAtCap();
  const saved = JSON.stringify({ epic: 3, revision: 6 });
  const { api, call } = toolsOf({}, (_path, init) =>
    (init?.method ?? "GET") === "GET"
      ? { status: 200, body: JSON.stringify(heaviest) }
      : { status: 200, body: saved },
  );

  const answer = await call("revise_epic", {
    epic: 3,
    expectedRevision: 5,
    ...epicContentKeptGiven,
  });

  assert.equal(textOf(answer), `HTTP 200\n${saved}`);
  assert.deepEqual(
    api.calls.map(({ method, path }) => [method, path]),
    [
      ["GET", `${epicsPath}/3`],
      ["POST", epicsPath],
    ],
  );
  assert.deepEqual(JSON.parse(api.calls[1].init.body), {
    kind: "Revise",
    epic: 3,
    expected: 5,
    content: { ...epicContentKeptGiven, description: heaviest.description },
  });
});

test("revise_epic sent no description writes nothing where the epic cannot be read", async () => {
  const body = JSON.stringify({ error: { code: "NotFound", message: "n" } });
  for (const [status, text, said] of [
    [404, body, `HTTP 404\n${body}`],
    [
      200,
      JSON.stringify({ number: 3 }),
      /not an epic as the contract answers one/,
    ],
  ]) {
    const { api, call } = toolsOf({}, () => ({ status, body: text }));

    const answer = await call("revise_epic", {
      epic: 3,
      expectedRevision: 5,
      ...epicContentKeptGiven,
    });

    assert.deepEqual(
      api.calls.map(({ method }) => method),
      ["GET"],
    );
    if (typeof said === "string") assert.equal(textOf(answer), said);
    else assert.match(textOf(answer), said);
    assert.equal(answer.isError, true);
  }
});

test("a membership change on an epic that cannot be read relays the read's refusal and writes nothing", async () => {
  const body = JSON.stringify({ error: { code: "NotFound", message: "n" } });
  const { api, call } = toolsOf({}, () => ({ status: 404, body }));

  const answer = await call("remove_epic_tickets", { epic: 3, tickets: [4] });

  assert.equal(api.calls.length, 1);
  assert.equal(textOf(answer), `HTTP 404\n${body}`);
  assert.equal(answer.isError, true);
});

test("create_draft carries its epic, and an epic that is missing or Archived is relayed as the API refused it", async () => {
  for (const [status, code] of [
    [409, "MissingEpic"],
    [409, "ArchivedEpic"],
    [409, "ManyTickets"],
    [409, "LargeContent"],
  ]) {
    const body = JSON.stringify({ error: { code, message: "m" } });
    const { api, call } = toolsOf({}, () => ({ status, body }));

    const answer = await call("create_draft", { ...origination, epic: 3 });

    assert.equal(JSON.parse(api.calls[0].init.body).epic, 3);
    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 1, "a refused epic was asked again");
  }
});

test("the epic tools are described: the writes name their refusals and the ability that admits them", () => {
  const described = (tool) =>
    chuggyProjectTools.find(({ name }) => name === tool).description;

  for (const tool of [
    "create_epic",
    "revise_epic",
    "add_epic_tickets",
    "remove_epic_tickets",
  ])
    for (const said of [
      /StaleRevision/,
      /UnknownTickets/,
      /ManyTickets/,
      /read_abilities/,
    ])
      assert.match(described(tool), said, tool);
  assert.match(described("read_ticket"), /`epics`/);
  assert.match(described("list_tickets"), /`epics`/);
  assert.match(
    parameterDescribed("list_tickets", "epic"),
    /only the tickets in this epic/,
  );
  assert.match(
    parameterDescribed("create_draft", "epic"),
    /refused 409 .*MissingEpic, ArchivedEpic, ManyTickets or LargeContent/,
  );
});

/** The settings route of the suite's project. */
const leadSettingsPath =
  "/api/v1/tenants/vteng/projects/chuggy/selector-settings";

/** The placement route of the suite's project. */
const placementPath = "/api/v1/tenants/vteng/projects/chuggy/session-placement";

/** The tools with the settings route reading `read` and writing whatever `written` answers, which is a 200 at revision 6 where it is left out. */
function leadSettingsToolsOf(read, written) {
  return toolsOf({}, (_path, init) =>
    (init?.method ?? "GET") === "GET"
      ? { status: 200, body: JSON.stringify(read) }
      : (written?.(init) ?? {
          status: 200,
          body: JSON.stringify(
            leadSettingsRead(JSON.parse(init.body).overrides, 6),
          ),
        }),
  );
}

/** The largest count in `1..2**20` that `admits` admits, which a schema's own bound is found by. */
function admittedMost(admits) {
  let low = 1;
  let high = 2 ** 20;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (admits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The heaviest settings the contract admits: every text and allowlist of the
 * overrides and of the effective settings at the most its schema admits, each
 * character one JSON escapes into six.
 */
function leadSettingsHeaviest() {
  const { basePrompt, modelAllowlist } = selectorProjectOverridesSchema.shape;
  const heavy = (chars) => "\u0001".repeat(chars);
  const text = heavy(
    admittedMost((chars) => basePrompt.safeParse(heavy(chars)).success),
  );
  const nameChars = admittedMost(
    (chars) => modelAllowlist.safeParse([heavy(chars)]).success,
  );
  const allowlist = Array.from(
    {
      length: admittedMost(
        (names) =>
          modelAllowlist.safeParse(Array(names).fill(heavy(nameChars))).success,
      ),
    },
    (_, index) => `${heavy(nameChars - 1)}${String(index % 10)}`,
  );
  const texts = {
    basePrompt: text,
    northStar: text,
    threadStandingRules: text,
    modelAllowlist: allowlist,
    toolAllowlist: allowlist,
  };
  const settings = leadSettingsRead({
    ...leadSettingsOverrides,
    ...texts,
  });
  assert.ok(
    selectorProjectOverridesSchema.safeParse(settings.overrides).success,
  );
  return { ...settings, effective: { ...settings.effective, ...texts } };
}

/** Whether a read_lead_settings answer at `path` is a piece of the value there, rather than the value whole. */
function leadSettingsPiece(read, path) {
  return (
    read !== null &&
    typeof read === "object" &&
    typeof read.note === "string" &&
    JSON.stringify(read.path) === JSON.stringify(path) &&
    ("outline" in read || "text" in read)
  );
}

/**
 * The value at `path` in the settings, read by `path` and `offset` alone: a
 * piece read on until nothing is left, and an outline's entry whose child is
 * not written whole read at its own `path`. `budget.reads` bounds the reads.
 */
async function leadSettingsWalked(call, path, budget) {
  const entries = [];
  let text = "";
  let offset;
  for (;;) {
    budget.reads -= 1;
    assert.ok(budget.reads >= 0, "the reads never reached the end");
    const read = configurationRead(
      await call("read_lead_settings", { path, offset }),
    );
    if (!leadSettingsPiece(read, path)) return read;
    assert.equal(read.offset, offset ?? 0);
    if (read.kind === "string") {
      text += read.text;
      if (read.charsLeft === 0) return text;
      offset = read.offset + read.text.length;
      continue;
    }
    for (const entry of read.outline)
      entries.push([
        entry.key,
        "value" in entry
          ? entry.value
          : await leadSettingsWalked(call, [...path, entry.key], budget),
      ]);
    if (read.entriesLeft === 0)
      return read.kind === "array"
        ? entries.map(([, value]) => value)
        : Object.fromEntries(entries);
    offset = read.offset + read.outline.length;
  }
}

test("read_lead_settings answers the heaviest settings in pieces that fit, which read by path and offset make the whole", async () => {
  const heaviest = leadSettingsHeaviest();
  const body = JSON.stringify(heaviest);
  assert.ok(Buffer.byteLength(body) > chuggyToolResponseBytesMax);
  assert.ok(Buffer.byteLength(body) <= chuggyToolLeadSettingsResponseBytesMax);
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  const outline = configurationRead(await call("read_lead_settings", {}));
  assert.ok(leadSettingsPiece(outline, []));
  assert.deepEqual(
    outline.outline.map(({ key }) => key),
    Object.keys(heaviest),
  );
  assert.deepEqual(
    await leadSettingsWalked(call, [], { reads: 10_000 }),
    heaviest,
  );
  assert.ok(api.calls.every(({ path }) => path === leadSettingsPath));
  assert.ok(api.calls.every(({ method }) => method === "GET"));
});

test("read_lead_settings answers settings that fit as the route answered them, and a refusal unaltered", async () => {
  const body = JSON.stringify(leadSettingsRead());
  const fits = toolsOf({}, () => ({ status: 200, body }));
  assert.equal(
    textOf(await fits.call("read_lead_settings", {})),
    `HTTP 200\n${body}`,
  );
  assert.deepEqual(
    configurationRead(
      await fits.call("read_lead_settings", { path: ["overrides", "limits"] }),
    ),
    leadSettingsOverrides.limits,
  );
  const missing = await fits.call("read_lead_settings", {
    path: ["overrides", "leadModel"],
  });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /^the lead settings hold no "leadModel"/u);

  const refusal = JSON.stringify({ error: { code: "NotFound", message: "n" } });
  const hidden = toolsOf({}, () => ({ status: 404, body: refusal }));
  const answer = await hidden.call("read_lead_settings", {});
  assert.equal(textOf(answer), `HTTP 404\n${refusal}`);
  assert.equal(answer.isError, true);
});

test("update_lead_settings keeps a field it is not sent, at its longest, drops one it clears and replaces limits whole, under the revision it was given", async () => {
  const heaviest = leadSettingsHeaviest();
  const { api, call } = leadSettingsToolsOf(heaviest);

  const answer = await call("update_lead_settings", {
    expectedRevision: 4,
    set: { mode: "Paused", limits: { dispatchesPerDecision: 1 } },
    clear: ["northStar"],
  });

  assert.equal(textOf(answer), `HTTP 200\n${JSON.stringify({ revision: 6 })}`);
  assert.equal(answer.isError, undefined);
  assert.deepEqual(
    api.calls.map(({ method, path }) => [method, path]),
    [
      ["GET", leadSettingsPath],
      ["PUT", leadSettingsPath],
    ],
  );
  const kept = { ...heaviest.overrides };
  delete kept.northStar;
  assert.deepEqual(JSON.parse(api.calls[1].init.body), {
    expectedRevision: 4,
    overrides: {
      ...kept,
      mode: "Paused",
      limits: { dispatchesPerDecision: 1 },
    },
  });
});

test("update_lead_settings relays settings that moved as their code and revision, and never writes again", async () => {
  const conflict = {
    error: {
      code: "SettingsRevisionConflict",
      message: "The selector settings moved under this write.",
    },
    settings: leadSettingsRead(leadSettingsOverrides, 7),
    movedBy: { kind: "User", subject: "u-1" },
  };
  const { api, call } = leadSettingsToolsOf(leadSettingsRead(), () => ({
    status: 409,
    body: JSON.stringify(conflict),
  }));

  const answer = await call("update_lead_settings", {
    expectedRevision: 5,
    set: { mode: "Paused" },
  });

  assert.equal(
    textOf(answer),
    `HTTP 409\n${JSON.stringify({ code: "SettingsRevisionConflict", revision: 7 })}`,
  );
  assert.equal(answer.isError, true);
  assert.deepEqual(
    api.calls.map(({ method }) => method),
    ["GET", "PUT"],
  );
});

test("update_lead_settings relays every other answer of its write as the API gave it", async () => {
  for (const [status, body] of [
    [
      409,
      JSON.stringify({
        error: { code: "AutomaticDispatchUnavailable", message: "a" },
      }),
    ],
    [
      503,
      JSON.stringify({
        error: {
          code: "SettingsWriteContended",
          message: "The request can be retried.",
        },
      }),
    ],
    [404, JSON.stringify({ error: { code: "NotFound", message: "n" } })],
    [413, JSON.stringify({ error: { code: "BodyTooLarge", message: "b" } })],
  ]) {
    const { api, call } = leadSettingsToolsOf(leadSettingsRead(), () => ({
      status,
      body,
    }));

    const answer = await call("update_lead_settings", {
      expectedRevision: 5,
      clear: ["basePrompt"],
    });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 2, String(status));
  }
});

test("a settings read the API refuses is relayed by update_lead_settings, which writes nothing", async () => {
  const body = JSON.stringify({ error: { code: "NotFound", message: "n" } });
  const { api, call } = toolsOf({}, () => ({ status: 404, body }));

  const answer = await call("update_lead_settings", {
    expectedRevision: 5,
    set: { mode: "Paused" },
  });

  assert.equal(textOf(answer), `HTTP 404\n${body}`);
  assert.deepEqual(
    api.calls.map(({ method }) => method),
    ["GET"],
  );
});

test("each settings and placement tool's refusal sends no request", async () => {
  const { api, call } = toolsOf();

  for (const [name, args] of [
    ["read_lead_settings", { path: [{}] }],
    ["read_lead_settings", { offset: -1 }],
    ["update_lead_settings", { expectedRevision: 5 }],
    ["update_lead_settings", { expectedRevision: 5, set: {}, clear: [] }],
    ["update_lead_settings", { set: { mode: "Paused" } }],
    ["update_lead_settings", { expectedRevision: 5, set: { mode: "Off" } }],
    ["update_lead_settings", { expectedRevision: 5, set: { pause: true } }],
    [
      "update_lead_settings",
      { expectedRevision: 5, set: { basePrompt: "b".repeat(2 ** 20) } },
    ],
    [
      "update_lead_settings",
      { expectedRevision: 5, set: { limits: { dispatchesPerDecision: 0 } } },
    ],
    ["update_lead_settings", { expectedRevision: 5, clear: ["pause"] }],
    [
      "update_lead_settings",
      {
        expectedRevision: 5,
        set: { northStar: "n", mode: "Paused" },
        clear: ["mode"],
      },
    ],
    ["update_placement", {}],
    ["update_placement", { lead: "Elsewhere" }],
    ["update_placement", { leadOffering: "Free" }],
  ]) {
    const answer = await call(name, args);
    assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(api.calls, []);
});

test("read_placement relays the placement as the route answered it", async () => {
  const body = JSON.stringify(placementRead);
  const { api, call } = toolsOf({}, () => ({ status: 200, body }));

  assert.equal(textOf(await call("read_placement", {})), `HTTP 200\n${body}`);
  assert.deepEqual(
    api.calls.map(({ method, path }) => [method, path]),
    [["GET", placementPath]],
  );
});

test("update_placement writes every route read and always names the offering, a bare Pool lead running on its own", async () => {
  for (const [args, written] of [
    [
      { lead: "Pool" },
      { thread: "InCluster", lead: "Pool", leadOffering: "Own" },
    ],
    [
      { thread: "Pool" },
      { thread: "Pool", lead: "InCluster", leadOffering: "Subsidized" },
    ],
    [
      { lead: "InCluster" },
      { thread: "InCluster", lead: "InCluster", leadOffering: "Subsidized" },
    ],
    [
      { leadOffering: "Own" },
      { thread: "InCluster", lead: "InCluster", leadOffering: "Own" },
    ],
  ]) {
    const { api, call } = toolsOf({}, () => ({
      status: 200,
      body: JSON.stringify(placementRead),
    }));

    const answer = await call("update_placement", args);

    assert.equal(answer.isError, undefined, textOf(answer));
    assert.deepEqual(
      api.calls.map(({ method, path }) => [method, path]),
      [
        ["GET", placementPath],
        ["PUT", placementPath],
      ],
    );
    assert.deepEqual(
      JSON.parse(api.calls[1].init.body),
      written,
      JSON.stringify(args),
    );
  }
});

test("update_placement relays the API's refusal of its write unaltered", async () => {
  for (const [status, code] of [
    [403, "HostedRunsNotGranted"],
    [422, "LeadOfferingNotAdmitted"],
  ]) {
    const body = JSON.stringify({ error: { code, message: "m" } });
    const { api, call } = toolsOf({}, (_path, init) =>
      (init?.method ?? "GET") === "GET"
        ? { status: 200, body: JSON.stringify(placementRead) }
        : { status, body },
    );

    const answer = await call("update_placement", {
      lead: "InCluster",
      leadOffering: "Subsidized",
    });

    assert.equal(textOf(answer), `HTTP ${String(status)}\n${body}`);
    assert.equal(answer.isError, true);
    assert.equal(api.calls.length, 2);
  }
});

test("no session's roster allows a settings tool", () => {
  const settings = chuggyToolCapabilities.ProjectSettings.map(
    (tool) => `${chuggyToolPrefix}${tool}`,
  );
  assert.ok(settings.length > 0);
  for (let subset = 0; subset < 2 ** sessionCapabilities.length; subset += 1) {
    const roster = sessionCapabilities.filter(
      (_, index) => ((subset >> index) & 1) === 1,
    );
    const { allowedTools, disallowedTools } = sessionAllowedTools(roster);
    for (const tool of settings) {
      assert.ok(!allowedTools.includes(tool), `${roster.join(",")} ${tool}`);
      assert.ok(disallowedTools.includes(tool), `${roster.join(",")} ${tool}`);
    }
  }
});
