/**
 * One page of a raw transcript, cut into an answer a tool can hand the model.
 *
 * A STORE BATCH IS NOT AN ANSWER. The transcript routes page by store batch,
 * and a batch is bounded by the store's own line bound — which is what one
 * whole answer has to fit inside, envelope and copies included. So the smallest
 * page the route serves is still larger than the largest answer, and a tool
 * that only relayed it would have nothing smaller to offer a caller who asked
 * for less. This cuts below that granularity instead: whole entries while they
 * fit, and a cursor naming where the next answer resumes.
 *
 * THE CURSOR IS THE TWO ARGUMENTS THE CALLER PASSES BACK. `after` is the
 * route's own batch cursor and `entry` is how many of that page's entries this
 * answer has already given, so resuming asks the route the same question and
 * skips what was read. Every answer either gives an entry, moves `after` on, or
 * names no next at all, which is what makes a walk terminate.
 *
 * WHAT GOES OUT IS A COMPOSITION ALREADY WEIGHED. Entries are taken while the
 * answer that carries them fits, each measured against the cursor that would
 * name it; where the page is exhausted the answer is composed instead with the
 * wider cursor that names the next batch, and where that does not fit the
 * narrower one goes out — the same cursor the next call resumes at either way.
 * The only weight this cannot answer for is the route's own fields, which go
 * through unread.
 *
 * AN ENTRY THE ANSWER HAS NO ROOM FOR IS PREVIEWED, NEVER REFUSED. A stored
 * tool result can be most of a line on its own, and a refusal there would stop
 * a walk on an entry the caller cannot make smaller. Its kind, its weight and
 * the head of it go instead, under `preview`, the head shrinking until the
 * answer fits, and the cursor moves past it.
 *
 * THE HELD SET IS NARROWED TO THE ENTRIES ANSWERED. The route decides it over
 * the whole stream and then answers the part of it this page's entries are in,
 * so a slice states its own part by the same filter; carried whole it would be
 * the page's set beside an answer's entries, and it weighs enough to crowd them
 * out. Everything else the route said about the page goes through unaltered,
 * `cut` and `truncated` included, which is what a reader needs the held set to
 * be about.
 *
 * AN ENTRY GOES OUT AS WHAT IT SAYS OF THE SESSION. A thinking block's
 * `signature` is opaque to a reader, the init entry's slash-command, skill and
 * plugin lists are the runtime's rather than the session's, and an entry of a
 * kind in `transcriptEntryTypesOmitted` says nothing of the session at all, so
 * it is left out and counted by kind under `omitted`. Every entry keeps its
 * place, so `entry` counts the page as the route answered it.
 *
 * A RUN'S TRANSCRIPT IS CUT THE SAME WAY, ONCE IT IS ENTRIES. Its route pages
 * by several of the batches its worker wrote, each up to the plane's body bound
 * and each a run of lines that are one event apiece, so `runTranscriptPage`
 * makes every line an entry and the page is cut like any other.
 */

import { Buffer } from "node:buffer";

/**
 * The most of an entry shown in its place. It is a ceiling and not a promise:
 * the head shrinks from it until the answer carrying it fits, because what the
 * answer may weigh is the caller's and this cannot be larger than that.
 */
export const transcriptEntryPreviewCharsMax = 1_024;

/** What this answer states for itself rather than repeating from the page. */
const transcriptPageAnswerReplaces = [
  "entries",
  "nextAfter",
  "held",
  "omitted",
];

/** The kinds of entry that say nothing of the session, which an answer counts rather than gives. */
export const transcriptEntryTypesOmitted = ["rate_limit_event"];

/** What an init entry says of the session, which is all of it an answer gives. */
const transcriptEntryInitFields = [
  "uuid",
  "type",
  "subtype",
  "timestamp",
  "model",
  "cwd",
  "tools",
];

/** One message's content with each thinking block's `signature` dropped. */
function transcriptEntryContentShaped(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block?.type !== "thinking") return block;
    return Object.fromEntries(
      Object.entries(block).filter(([field]) => field !== "signature"),
    );
  });
}

/** One entry as an answer gives it, or nothing where its kind is left out. */
export function transcriptEntryShaped(entry) {
  if (transcriptEntryTypesOmitted.includes(entry?.type)) return undefined;
  if (entry?.type === "system" && entry.subtype === "init")
    return Object.fromEntries(
      Object.entries(entry).filter(([field]) =>
        transcriptEntryInitFields.includes(field),
      ),
    );
  if (!Array.isArray(entry?.message?.content)) return entry;
  return {
    ...entry,
    message: {
      ...entry.message,
      content: transcriptEntryContentShaped(entry.message.content),
    },
  };
}

/** One entry nothing can answer whole: what it is, what it weighs, and its head. */
function transcriptEntryPreview(entry, charsMax) {
  const whole = JSON.stringify(entry);
  return {
    ...(typeof entry?.uuid === "string" ? { uuid: entry.uuid } : {}),
    ...(typeof entry?.type === "string" ? { type: entry.type } : {}),
    bytes: Buffer.byteLength(whole),
    preview: whole.slice(0, charsMax),
  };
}

/**
 * The entries one answer takes from `from` on, each shaped, while `fits` holds
 * of what is taken under the cursor that would name it; and, where the first
 * entry it would give fits nowhere, that entry to preview. An entry left out
 * is always taken first, so every answer moves the cursor.
 */
function transcriptPageAnswerTaken(entries, from, after, fits) {
  let given = [];
  let omitted = {};
  let consumed = from;
  let stop;
  let previewOf;
  for (let index = from; index < entries.length; index += 1) {
    const shaped = transcriptEntryShaped(entries[index]);
    const { type } = entries[index] ?? {};
    const candidate =
      shaped === undefined
        ? { given, omitted: { ...omitted, [type]: (omitted[type] ?? 0) + 1 } }
        : { given: [...given, shaped], omitted };
    if (
      fits(candidate, { after, entry: index + 1 }) ||
      (shaped === undefined && consumed === from)
    ) {
      ({ given, omitted } = candidate);
      consumed = index + 1;
      continue;
    }
    if (given.length === 0 && shaped !== undefined) previewOf = shaped;
    stop = previewOf === undefined ? index : index + 1;
    break;
  }
  return { given, omitted, consumed, stop, previewOf };
}

/**
 * The answer for one route page, given where the caller resumed and what fits.
 * `fits` is the tool's own bound rather than this module's, because what an
 * answer may weigh is a property of the transcript it is stored in.
 */
export function transcriptPageAnswer(page, cursor, fits) {
  const { entries = [], nextAfter } = page ?? {};
  const rest = Object.fromEntries(
    Object.entries(page ?? {}).filter(
      ([field]) => !transcriptPageAnswerReplaces.includes(field),
    ),
  );
  const after = cursor?.after ?? 0;
  const from = cursor?.entry ?? 0;
  const heldOf = (given) => {
    if (!Array.isArray(page?.held)) return {};
    const answered = new Set(
      given.map(({ uuid }) => uuid).filter((uuid) => typeof uuid === "string"),
    );
    return { held: page.held.filter((uuid) => answered.has(uuid)) };
  };
  const composed = (given, omitted, next) =>
    JSON.stringify({
      ...rest,
      ...heldOf(given),
      entries: given,
      ...(Object.keys(omitted).length === 0 ? {} : { omitted }),
      ...(next === undefined ? {} : { next }),
    });
  const previewed = (entry, omitted, next) => {
    let chars = transcriptEntryPreviewCharsMax;
    let text = composed([transcriptEntryPreview(entry, chars)], omitted, next);
    while (!fits(text) && chars > 0) {
      chars = Math.floor(chars / 2);
      text = composed([transcriptEntryPreview(entry, chars)], omitted, next);
    }
    return text;
  };

  const { given, omitted, consumed, stop, previewOf } =
    transcriptPageAnswerTaken(entries, from, after, (taken, next) =>
      fits(composed(taken.given, taken.omitted, next)),
    );

  const beyond =
    nextAfter === undefined || nextAfter === null
      ? undefined
      : { after: nextAfter, entry: 0 };
  const next = stop === undefined ? beyond : { after, entry: stop };
  if (previewOf !== undefined) return previewed(previewOf, omitted, next);
  const text = composed(given, omitted, next);
  return fits(text) || consumed === from
    ? text
    : composed(given, omitted, { after, entry: consumed });
}

/** One line a run's worker wrote, as the JSON event it wrote or, where it is not one, as its text. */
function runTranscriptPageEntry(line) {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

/**
 * A run's transcript page as `transcriptPageAnswer` reads a page: the lines of
 * its batches as entries, in order, and `elided` counting the batches with
 * nothing to read. Where the run is still writing and the route names no later
 * batch, the next page is read after this one's last, so the read that finds
 * nothing past it is the one that names no next, and is the one that answers
 * what the run writes later.
 */
export function runTranscriptPage(page) {
  const { batches, nextAfter, ...rest } = page ?? {};
  const read = Array.isArray(batches) ? batches : [];
  const entries = [];
  let elided = 0;
  for (const batch of read) {
    if (batch?.read !== "Content" || typeof batch.content !== "string") {
      elided += 1;
      continue;
    }
    for (const line of batch.content.split("\n"))
      if (line.length > 0) entries.push(runTranscriptPageEntry(line));
  }
  const last = read.at(-1)?.batch;
  const later =
    nextAfter ??
    (rest.complete === false && Number.isSafeInteger(last) ? last : undefined);
  return {
    ...rest,
    entries,
    elided,
    ...(later === undefined ? {} : { nextAfter: later }),
  };
}
