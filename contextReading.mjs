/**
 * What the agent runtime says of its context window, as the contract's
 * readings carry it: a compaction its stream marks, and the window its
 * `Query.getContextUsage` answers. A run and a session both read them, so a
 * compaction is one fact with one reading.
 *
 * IT READS DECLARED FIELDS. `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`
 * declares both: `SDKCompactBoundaryMessage`, a `system` message of subtype
 * `compact_boundary` whose `compact_metadata` names the trigger and the tokens
 * before and after, and `SDKControlGetContextUsageResponse`, the breakdown
 * `/context` draws. Of the breakdown the window keeps what the contract's
 * window holds and nothing else: no grid, no colours, no API usage.
 *
 * A WINDOW THE CONTRACT WOULD REFUSE IS TRIMMED OR LEFT OUT. Each list is cut
 * to the contract's bound and a category of a kind the contract does not name
 * is dropped; a window it still refuses, for a text past its bound or a figure
 * that is no count, is left out whole rather than sent to be refused with what
 * it rides on.
 */

import {
  runCompactionTriggers,
  runContextCategoryKinds,
  runContextItemsMax,
  runModelCharsMax,
} from "@chuggy/worker-contract/workerPlane";

import { rosterLabel } from "./wire.mjs";

/** The contract's trigger for each the runtime declares. */
const contextTriggers = {
  auto: rosterLabel(runCompactionTriggers, "Auto"),
  manual: rosterLabel(runCompactionTriggers, "Manual"),
};

/** The contract's kind for each category kind the runtime declares. */
const contextKinds = {
  used: rosterLabel(runContextCategoryKinds, "Used"),
  free: rosterLabel(runContextCategoryKinds, "Free"),
  buffer: rosterLabel(runContextCategoryKinds, "Buffer"),
  deferred: rosterLabel(runContextCategoryKinds, "Deferred"),
};

/** The contract's label `labels` holds for what the runtime declared, or nothing. */
function contextLabel(labels, declared) {
  return typeof declared === "string" && Object.hasOwn(labels, declared)
    ? labels[declared]
    : undefined;
}

/** Whether the runtime's message marks a compaction of its window. */
export function contextCompacted(message) {
  return message?.type === "system" && message.subtype === "compact_boundary";
}

/** A figure the runtime declared, where it is a count the contract holds. */
function contextCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A compaction's facts as its boundary declares them, or nothing where it
 * names no trigger or no count of the tokens before it. The tokens after are
 * where the runtime counted them.
 */
export function contextCompaction(message) {
  const metadata = message?.compact_metadata;
  const trigger = contextLabel(contextTriggers, metadata?.trigger);
  const tokensBefore = contextCount(metadata?.pre_tokens);
  if (trigger === undefined || tokensBefore === undefined) return undefined;
  const tokensAfter = contextCount(metadata.post_tokens);
  return {
    trigger,
    tokensBefore,
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
  };
}

/** One of the breakdown's lists, each entry as `item` makes it, cut to the contract's bound. */
function contextWindowList(entries, item) {
  return Array.isArray(entries)
    ? entries.slice(0, runContextItemsMax).map(item)
    : [];
}

function contextWindowSkills(skills, scrub) {
  if (skills === undefined || skills === null) return {};
  return {
    skills: {
      total: contextCount(skills.totalSkills),
      included: contextCount(skills.includedSkills),
      tokens: contextCount(skills.tokens),
      items: contextWindowList(skills.skillFrontmatter, (skill) => ({
        name: scrub(skill?.name),
        tokens: contextCount(skill?.tokens),
      })),
    },
  };
}

function contextWindowMessages(breakdown, scrub) {
  if (breakdown === undefined || breakdown === null) return {};
  return {
    messages: {
      toolCalls: contextCount(breakdown.toolCallTokens),
      toolResults: contextCount(breakdown.toolResultTokens),
      attachments: contextCount(breakdown.attachmentTokens),
      assistant: contextCount(breakdown.assistantMessageTokens),
      user: contextCount(breakdown.userMessageTokens),
      byTool: contextWindowList(breakdown.toolCallsByType, (tool) => ({
        name: scrub(tool?.name),
        callTokens: contextCount(tool?.callTokens),
        resultTokens: contextCount(tool?.resultTokens),
      })),
    },
  };
}

/** A name and its tokens, which most of the breakdown's lists are. */
function contextWindowNamed(scrub) {
  return (entry) => ({
    name: scrub(entry?.name),
    tokens: contextCount(entry?.tokens),
  });
}

/**
 * The window a `getContextUsage` answer describes, each text passed through
 * `scrub` and each list cut to the contract's bound. What it does not check is
 * the contract's to refuse, which the reading that carries it asks.
 */
export function contextWindow(usage, scrub) {
  const said = (text) => (typeof text === "string" ? scrub(text) : undefined);
  const autoCompactThreshold = contextCount(usage?.autoCompactThreshold);
  return contextWindowLists(usage, said, {
    model: said(usage?.model)?.slice(0, runModelCharsMax),
    totalTokens: contextCount(usage?.totalTokens),
    maxTokens: contextCount(usage?.maxTokens),
    ...(autoCompactThreshold === undefined ? {} : { autoCompactThreshold }),
  });
}

/** `head` and the breakdown's lists after it. */
function contextWindowLists(usage, scrub, head) {
  return {
    ...head,
    categories: contextWindowList(
      Array.isArray(usage?.categories)
        ? usage.categories.filter(
            (category) =>
              contextLabel(contextKinds, category?.kind) !== undefined,
          )
        : [],
      (category) => ({
        ...contextWindowNamed(scrub)(category),
        kind: contextLabel(contextKinds, category.kind),
      }),
    ),
    memoryFiles: contextWindowList(usage?.memoryFiles, (file) => ({
      path: scrub(file?.path),
      tokens: contextCount(file?.tokens),
    })),
    mcpTools: contextWindowList(usage?.mcpTools, (tool) => ({
      server: scrub(tool?.serverName),
      ...contextWindowNamed(scrub)(tool),
    })),
    systemTools: contextWindowList(
      usage?.systemTools,
      contextWindowNamed(scrub),
    ),
    systemPromptSections: contextWindowList(
      usage?.systemPromptSections,
      contextWindowNamed(scrub),
    ),
    ...contextWindowSkills(usage?.skills, scrub),
    agents: contextWindowList(usage?.agents, (agent) => ({
      type: scrub(agent?.agentType),
      tokens: contextCount(agent?.tokens),
    })),
    ...contextWindowMessages(usage?.messageBreakdown, scrub),
  };
}
