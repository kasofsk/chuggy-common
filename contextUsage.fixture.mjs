/**
 * What the worker image's Claude Code answered `getContextUsage({detail:
 * "summary"})` with after one turn, its grid and its longer lists cut short.
 * The suites add the lists this session had none of.
 */
export const contextUsage = {
  categories: [
    {
      name: "System prompt",
      tokens: 141,
      color: "promptBorder",
      kind: "used",
    },
    {
      name: "System tools",
      tokens: 9943,
      color: "inactive",
      kind: "used",
    },
    {
      name: "System tools (deferred)",
      tokens: 19723,
      color: "inactive",
      isDeferred: true,
      kind: "deferred",
    },
    {
      name: "Skills",
      tokens: 3127,
      color: "warning",
      kind: "used",
    },
    {
      name: "Messages",
      tokens: 4446,
      color: "purple_FOR_SUBAGENTS_ONLY",
      kind: "used",
    },
    {
      name: "Autocompact buffer",
      tokens: 33000,
      color: "inactive",
      kind: "buffer",
    },
    {
      name: "Free space",
      tokens: 949343,
      color: "promptBorder",
      kind: "free",
    },
  ],
  totalTokens: 17657,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  autocompactSource: "model-default",
  percentage: 2,
  gridRows: [
    [
      {
        color: "promptBorder",
        isFilled: true,
        categoryName: "System prompt",
        tokens: 141,
        percentage: 0,
        squareFullness: 0.028200000000000003,
      },
      {
        color: "inactive",
        isFilled: true,
        categoryName: "System tools",
        tokens: 9943,
        percentage: 1,
        squareFullness: 1,
      },
    ],
  ],
  model: "claude-opus-5-5[1m]",
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  slashCommands: {
    totalCommands: 20,
    includedCommands: 20,
    tokens: 1417,
  },
  skills: {
    totalSkills: 20,
    includedSkills: 20,
    tokens: 3127,
    skillFrontmatter: [
      {
        name: "comments-describe-the-code:comments-describe-the-code",
        source: "plugin",
        pluginName: "comments-describe-the-code",
        tokens: 138,
      },
      {
        name: "dependencies:dependencies",
        source: "plugin",
        pluginName: "dependencies",
        tokens: 116,
      },
    ],
  },
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 3479,
    assistantMessageTokens: 15,
    userMessageTokens: 10,
    redirectedContextTokens: 0,
    unattributedTokens: 942,
    toolCallsByType: [],
    attachmentsByType: [
      {
        name: "skill_listing",
        tokens: 2529,
      },
      {
        name: "agent_listing_delta",
        tokens: 415,
      },
    ],
  },
  apiUsage: null,
};
