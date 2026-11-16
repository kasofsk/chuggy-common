#!/usr/bin/env node
/**
 * `chuggy <tool> ['<json input>']`: one of the session's chuggy tools, run from
 * its shell against the session the shell credential's four variables name,
 * and its answer printed as the agent would read it.
 *
 * THE TOOLS ARE THE POD'S, unchanged: `chuggyToolDefinitions`, their input
 * shapes and `chuggyToolHandler`, under a context of the command's own built
 * from the variables. Every tool that reaches the API is offered, and the API
 * is the control: it confines the bearer to the session's scope and
 * capabilities. No decision tool is offered, since a decision is staged for a
 * lead's turn and nothing here is one, and no offer tool, since an offer is the
 * call standing in the transcript and a shell's call stands in none.
 *
 * A CALL IS ITS OWN TURN, as it is in `./localTools.mjs`: nothing in a shell
 * says which turn of the session a call belongs to, so each submitted command
 * mints its operation from a turn of its own.
 *
 * A SHELL WITH NO CREDENTIAL IS TOLD WHY: a thread's shell is handed the four
 * variables only where its chat host's settings name `sessionCapabilities`.
 *
 * The exit is `chuggyCommandExits`': an answer, a refusal or failed call, or a
 * call that was never made because the command was misused.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sessionApiOriginVariable,
  sessionBearerVariable,
  sessionProjectVariable,
  sessionTenantVariable,
} from "@chuggy/worker-contract/workerEnvironment";
import { z } from "zod";

import { chuggyRequest } from "./chuggyApi.mjs";
import {
  chuggyToolContext,
  chuggyToolDefinitions,
  chuggyToolHandler,
  chuggyOfferTools,
  chuggyToolImageFiles,
  chuggyToolSignal,
  sessionCapabilityTools,
} from "./chuggyTools.mjs";

/** What the command exits with. */
export const chuggyCommandExits = { answered: 0, refused: 1, misused: 2 };

const chuggyCommandUsage = "usage: chuggy <tool> ['<json input>']";

/** The variables the command's context is built from, by what each names. */
const chuggyCommandVariables = {
  origin: sessionApiOriginVariable,
  bearer: sessionBearerVariable,
  tenant: sessionTenantVariable,
  project: sessionProjectVariable,
};

const chuggyOfferToolNames = new Set(chuggyOfferTools.map((each) => each.name));

/** The capabilities whose tools all reach the API: none admitting an offer. */
const chuggyCommandCapabilities = Object.keys(sessionCapabilityTools).filter(
  (capability) =>
    !sessionCapabilityTools[capability].some((tool) =>
      chuggyOfferToolNames.has(tool),
    ),
);

/** The tools' context for the session `environment`'s four variables name. */
function chuggyCommandContext(environment) {
  const named = Object.fromEntries(
    Object.entries(chuggyCommandVariables).map(([what, variable]) => [
      what,
      environment[variable],
    ]),
  );
  const unset = Object.entries(chuggyCommandVariables)
    .filter(([what]) => typeof named[what] !== "string" || named[what] === "")
    .map(([, variable]) => variable);
  if (unset.length > 0) return { unset };
  return {
    context: chuggyToolContext(
      {
        tenant: named.tenant,
        project: named.project,
        api: { url: named.origin },
      },
      named.bearer,
      {
        capabilities: chuggyCommandCapabilities,
        request: (task, bearer, path, init = {}) =>
          chuggyRequest(task, bearer, path, {
            ...init,
            signal: chuggyToolSignal(),
          }),
        turn: () => randomUUID(),
        staging: { definitions: [] },
        imageFile: chuggyToolImageFiles(environment),
      },
    ),
  };
}

/** The input `text` names, `{}` where it names none, or nothing where it does not parse. */
function chuggyCommandInput(text) {
  if (text === undefined) return { input: {} };
  try {
    return { input: JSON.parse(text) };
  } catch {
    return {};
  }
}

/**
 * One run of the command over `argv`, its tool and input, against the session
 * `environment` names: what it prints on stdout and stderr, and its exit.
 */
export async function chuggyCommand(argv, environment) {
  const misused = (reason) => ({
    exit: chuggyCommandExits.misused,
    out: "",
    err: `chuggy: ${reason}\n${chuggyCommandUsage}\n`,
  });
  const [name, text, ...rest] = argv;
  if (name === undefined || rest.length > 0)
    return misused("name one tool and at most one input");
  const { context, unset } = chuggyCommandContext(environment);
  if (context === undefined)
    return misused(
      `${unset.join(", ")} unset: this shell was handed no credential, and a thread's shell is handed one only where its chat host's settings name sessionCapabilities`,
    );
  const definitions = chuggyToolDefinitions(context);
  const definition = definitions.find((each) => each.name === name);
  if (definition === undefined)
    return misused(
      `no tool is named ${name}; the tools are ${[...new Set(definitions.map((each) => each.name))].join(", ")}`,
    );
  const { input } = chuggyCommandInput(text);
  if (input === undefined) return misused("the input is not JSON");
  const answer = await chuggyToolHandler(definition, z)(input);
  const printed = (answer.content ?? [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
  return {
    exit:
      answer.isError === true
        ? chuggyCommandExits.refused
        : chuggyCommandExits.answered,
    out: `${printed}\n`,
    err: "",
  };
}

if (
  realpathSync(resolve(process.argv[1] ?? "")) ===
  fileURLToPath(import.meta.url)
) {
  const ran = await chuggyCommand(process.argv.slice(2), process.env);
  process.stdout.write(ran.out);
  process.stderr.write(ran.err);
  process.exitCode = ran.exit;
}
