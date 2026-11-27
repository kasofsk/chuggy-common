/**
 * A thread's `ticket_wakes` tool: whether the thread is woken for events on
 * the tickets it drafted. Like a job host's tools it is the session's own, so
 * no capability roster names it, and a thread holds it whatever runs it.
 *
 * IT IS OFFERED ONLY BY A PLANE LISTING `ThreadTicketWakes`, the one that
 * answers a thread's facts with its wakes and takes its choice.
 *
 * A READ IS THE FACTS' AND A CHOICE THE PLANE'S. With no choice the tool reads
 * the thread's facts again, so it answers the host's setting as the host last
 * named it. A choice is put through the plane's own route, and what applies is
 * what either answers, never derived here.
 */

import {
  sessionFactsAnswerSchema,
  sessionPlaneRoutes,
  sessionTicketWakesSchema,
  threadTicketWakeSettings,
} from "@chuggy/worker-contract/sessionPlane";

import { peerImplements } from "./wire.mjs";

/** What the tool may be told: a setting of the thread's own, or `Host` to follow its member's chat host. */
export const sessionTicketWakesChoices = [...threadTicketWakeSettings, "Host"];

const readStatus = 200;
const conflictStatus = 409;

/**
 * Whether a session is offered `ticket_wakes`: a thread whose plane, `peer`,
 * lists `ThreadTicketWakes`.
 *
 * @param {{kind: string}} facts
 * @param {import("@chuggy/worker-contract/workerContract").WorkerContractPeer | undefined} peer
 */
export function sessionTicketWakesOffered(facts, peer) {
  return facts.kind === "Thread" && peerImplements(peer, "ThreadTicketWakes");
}

/** The thread's wakes as its facts carry them, read again from the plane. */
async function sessionTicketWakesRead(session) {
  const { path, method } = sessionPlaneRoutes.facts;
  const response = await session.request(session.task, session.bearer, path, {
    method,
  });
  if (response.status !== readStatus)
    throw new Error(`the worker plane answered ${String(response.status)}`);
  const facts = sessionFactsAnswerSchema.parse(await response.json());
  if (facts.ticketWakes === undefined)
    throw new Error("the worker plane's facts name no ticket wakes");
  return facts.ticketWakes;
}

/** The thread's choice put through the plane, and the wakes it answers. */
async function sessionTicketWakesChosen(session, choice) {
  const { path, method } = sessionPlaneRoutes.ticketWakes;
  const response = await session.request(session.task, session.bearer, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread: choice === "Host" ? null : choice }),
  });
  const body = await response.json().catch(() => undefined);
  if (response.status === readStatus)
    return sessionTicketWakesSchema.parse(body);
  if (response.status === conflictStatus && typeof body?.reason === "string")
    throw new Error(`the worker plane refused the choice: ${body.reason}`);
  throw new Error(`the worker plane answered ${String(response.status)}`);
}

/**
 * The tool, as `./chuggyTools.mjs` defines one, reaching the session plane
 * through `session.request` under the attempt's own bearer.
 *
 * @param {{task: unknown, bearer: string, request: Function}} session
 */
export function sessionTicketWakesDefinitions(session) {
  return [
    {
      name: "ticket_wakes",
      annotations: {
        title: "Ticket wakes",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      exact: true,
      description:
        "Reads or sets whether this thread is woken for events on the tickets it drafted. With no `choice` it answers the thread's own choice, its member's chat host's setting and the one that applies; given one it sets the thread's own and answers the same. The thread's own choice applies where it made one, else its host's setting, else Off. Answers JSON: `thread` and `host`, each absent where none was made, and `effective`.",
      shape: (z) => ({
        choice: z
          .enum(sessionTicketWakesChoices)
          .describe(
            "On or Off to set the thread's own choice, or Host to drop it and follow the chat host's setting; left out, nothing is set.",
          )
          .optional(),
      }),
      call: async (_context, { choice }) =>
        JSON.stringify(
          choice === undefined
            ? await sessionTicketWakesRead(session)
            : await sessionTicketWakesChosen(session, choice),
        ),
    },
  ];
}
