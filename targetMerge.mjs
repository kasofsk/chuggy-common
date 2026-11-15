/**
 * What a work task's `targetMerge` names, merged into its workspace: once
 * before the agent runs, and again once its result is accepted, before the
 * candidate is committed and pushed (`source.mjs`). A task naming no
 * `targetMerge` merges nothing. Its `ref` is the base the ticket lands into,
 * `HEAD` being origin's default branch.
 *
 * A MERGE, NEVER A REBASE, and `--no-ff`, so the candidate still descends from
 * the commit the attempt started from and the target's commits keep their
 * names. A workspace already holding what is merged does not merge it.
 *
 * NO MERGE BRINGS IN A WORKFLOW CHANGE THE JOB CANNOT PUSH. Where
 * `pipelinesWritable` is false, each merge is checked first for a path under
 * `.github/workflows/` it would change against the commit the attempt started
 * from (`sourcePipelinesBrought`), since GitHub refuses such a push whole. At
 * the start the target is then not merged and the briefing says so; at the
 * end the work is pushed without it; and where a failed landing's change is
 * named, which cannot land without that tree, the attempt ends at the push
 * step before its agent runs.
 *
 * AT THE START a clean merge is what the agent builds on, and a conflict is
 * left in progress for the agent, its briefing saying what it is looking at.
 * A failed landing's `change` is merged after the target, every commit of it
 * keeping its message; where the target's merge stopped, the change is left
 * for the agent to merge once that merge is concluded. It is never fetched by
 * its hash, which a forge need not serve, so one the clone of every branch
 * does not hold is not merged. What cannot be fetched, found or merged is
 * logged and the attempt runs without it.
 *
 * AT THE END the target is fetched again, and where it moved past the work the
 * work is committed and the target merged on top. A clean merge is pushed with
 * no turn of the agent's. A conflict there, or one the start left that the
 * agent did not resolve, resumes the same conversation with a nudge naming
 * what was merged, its commit and the files. Every nudge shares
 * `targetMergeNudgesMax`. Once that is spent, or where the runtime cannot
 * resume, the attempt ends as `TargetMergeUnresolved` and nothing is pushed.
 * A resolved merge is committed by the core, and the target fetched again.
 */

import { gitFailureLine } from "./gitRemote.mjs";
import {
  RunStepFailure,
  runCommitFailed,
  runPushFailed,
  runStep,
} from "./runEvidence.mjs";
import {
  sourceCommitHeld,
  sourceConflictsLeft,
  sourceMergeConcluded,
  sourcePipelinesBrought,
  sourceTargetContained,
  sourceTargetMerged,
  sourceWorkCommitted,
} from "./source.mjs";

/** How many times one attempt's agent may be resumed to resolve a merge of its target. */
export const targetMergeNudgesMax = 3;

/** How both sides' claims on one next number are settled, the target's never moved. */
const targetMergeNumbering =
  "Where both sides took the same next number or version, such as a migration's, move this change's own to the next free one and leave what the target holds exactly as it is.";

/** What every nudge tells the agent to do. */
export const targetMergeResolveInstruction = `Resolve each conflicting file so that the intent of both sides survives, and mark it resolved with \`git add\`. ${targetMergeNumbering} Then run the tests. Do not commit, and do not abort the merge, reset or change branches: the merge is committed for you once every file is resolved.`;

/** How a line names `ref`: the remote's default branch by what it is rather than by `HEAD`. */
export function targetMergeName(ref) {
  return ref === "HEAD" ? "origin's default branch" : ref;
}

/** How a line names a failed landing's change. */
const targetMergeChangeName = "the failed landing's change";

/** The identity the agent's own commit of a merge names, since the pod has none while it runs. */
const targetMergeAgentGit =
  "git -c user.name=worker -c user.email=worker@invalid";

/** A run of paths as a nudge lists them. */
function targetMergePaths(paths) {
  return paths.map((path) => `- ${path}`).join("\n");
}

/** What a resumed agent is told when the target moved past its work and merging it stopped on conflicts. */
export function targetMergeMovedNudge({ named, tip, paths }) {
  return [
    `The branch this work lands on, ${named}, moved on while you worked. It is at ${tip} now, and merging it into your work stopped on conflicts in:`,
    targetMergePaths(paths),
    targetMergeResolveInstruction,
  ].join("\n\n");
}

/** What a resumed agent is told when a merge it was left still has conflicts it has not resolved. */
export function targetMergeConflictNudge({ named, tip, paths }) {
  return [
    `The merge of ${named} at ${tip} into your work still has unresolved conflicts in:`,
    targetMergePaths(paths),
    targetMergeResolveInstruction,
  ].join("\n\n");
}

/** The briefing's lines where the start did not merge the target for a workflow change. */
function targetMergeWithheldLines({ named, tip, withheld }) {
  return [
    "## The target branch was not merged",
    `This checkout did not merge ${named} at ${tip}, the branch this work lands on: it holds a change to .github/workflows/ that this job cannot push, in:`,
    targetMergePaths(withheld),
    "Say in your report that the target holds a workflow change this job cannot push, so it was not merged.",
  ];
}

/** The briefing's lines where the start's merge of the target stopped on conflicts. */
function targetMergeConflictedLines({ named, tip, conflicted, change }) {
  const pending = change?.pending === true;
  return [
    "## A merge of the target branch is in progress",
    `This checkout merged ${named} at ${tip}, the branch this work lands on, and the merge stopped on conflicts in:`,
    targetMergePaths(conflicted),
    `Before the ticket's work, resolve each conflicting file so that the intent of both sides survives, and mark it resolved with \`git add\`. ${targetMergeNumbering} Do not abort the merge, reset or change branches.`,
    ...(pending
      ? [
          `The failed landing's change, at commit ${change.commit}, is not merged: it is yours to merge once this merge is concluded. Conclude it with \`${targetMergeAgentGit} commit --no-edit\`, then run \`${targetMergeAgentGit} merge --no-ff --no-edit ${change.commit}\`, which merges every commit of it, each with its message, and resolve any conflict it stops on in the same way.`,
        ]
      : []),
  ];
}

/** The briefing's lines where the start's merge of the failed landing's change stopped on conflicts. */
function targetMergeChangeLines({ change }) {
  return [
    "## A merge of the failed landing's change is in progress",
    `This checkout merged ${targetMergeChangeName}, at commit ${change.commit}, and the merge stopped on conflicts in:`,
    targetMergePaths(change.conflicted),
    `Before the ticket's work, resolve each conflicting file so that the intent of both sides survives, and mark it resolved with \`git add\`. ${targetMergeNumbering} Do not abort the merge, reset or change branches.`,
  ];
}

/** The section the start's merge adds to a briefing, or nothing where it has nothing to say. */
function targetMergeSection(started) {
  if (started === undefined) return undefined;
  if (started.withheld !== undefined) return targetMergeWithheldLines(started);
  if (started.conflicted.length > 0) return targetMergeConflictedLines(started);
  if ((started.change?.conflicted?.length ?? 0) > 0)
    return targetMergeChangeLines(started);
  return undefined;
}

/** `task` as its agent is handed it where the start's merge has something to tell it, and as it was otherwise. */
export function targetMergeBriefed(task, started) {
  const section = targetMergeSection(started);
  if (section === undefined) return task;
  return {
    ...task,
    briefing: {
      ...task.briefing,
      text: `${task.briefing.text}\n\n${section.join("\n\n")}`,
    },
  };
}

/** An attempt whose target's merge was left unresolved, which pushes nothing and is lost rather than failed. */
export class TargetMergeUnresolved extends Error {
  name = "TargetMergeUnresolved";
}

/**
 * The paths under `.github/workflows/` merging `tip` would bring in that this
 * job cannot push, none where its pipelines are writable.
 */
async function targetMergePipelines(where, tip) {
  if (where.task.targetMerge.pipelinesWritable) return [];
  return sourcePipelinesBrought({ ...where, tip });
}

/**
 * The start's merge: `{named, tip, conflicted, withheld, change}`, where the
 * target was fetched, `tip` its commit, `conflicted` the paths its merge left
 * unmerged and `withheld` the workflow paths it was not merged for; `change`,
 * where the task names one, is `{commit, conflicted}` once merged and
 * `{commit, pending: true}` where the target's merge stopped. Nothing where
 * the task names no `targetMerge`, or neither could be fetched, found or
 * merged, which `log` is told. `where` is the `task`, `base`, `directory`, `command`
 * and `git` the workspace's git is run with, `fetched` answers the target's
 * tip, and `said` a failure as it is logged. A failed landing that would bring
 * in a workflow change the job cannot push is raised as the push step.
 */
export async function targetMergedAtStart({ where, fetched, log, said }) {
  const merge = where.task.targetMerge;
  if (merge === undefined) return undefined;
  const named = targetMergeName(merge.ref);
  let tip;
  try {
    tip = await fetched();
  } catch (failure) {
    log(
      `the target ${named} could not be fetched, so this attempt runs without merging it: ${said(failure)}`,
    );
  }
  const contained =
    tip === undefined || (await sourceTargetContained({ ...where, tip }));
  const change = await targetMergeChangeHeld(where, merge.change, log);
  if (change !== undefined)
    await targetMergeLandable(where, {
      named,
      tip: contained ? undefined : tip,
      change,
    });
  const target =
    tip === undefined
      ? undefined
      : await targetMergeStartTarget({
          where,
          named,
          tip,
          contained,
          log,
          said,
        });
  if (change === undefined) return target;
  const merged = await targetMergeStartChange({
    where,
    named,
    change,
    stopped: (target?.conflicted.length ?? 0) > 0,
    log,
    said,
  });
  if (merged === undefined) return target;
  return { ...(target ?? { named, tip, conflicted: [] }), change: merged };
}

/** A failed landing's `change` where the workspace holds it, and nothing where it names none or holds none, which `log` is told. */
async function targetMergeChangeHeld(where, change, log) {
  if (change === undefined) return undefined;
  if (await sourceCommitHeld({ ...where, commit: change })) return change;
  log(
    `${targetMergeChangeName} ${change} is not in the clone, so this attempt runs without merging it`,
  );
  return undefined;
}

/**
 * Refuses, as the push step, a failed landing's rework whose target or change
 * would bring in a workflow change the job cannot push: the ticket cannot land
 * without that tree, so its agent is not run.
 */
async function targetMergeLandable(where, { named, tip, change }) {
  const brought = new Set([
    ...(tip === undefined ? [] : await targetMergePipelines(where, tip)),
    ...(await targetMergePipelines(where, change)),
  ]);
  if (brought.size === 0) return;
  throw new RunStepFailure(
    runPushFailed,
    `merging ${named} and ${targetMergeChangeName} ${change} would change ${[...brought].join(", ")} under .github/workflows/, which this job cannot push, so the attempt ends before its agent runs. The repository's Workflow files setting does not let its jobs change workflow files, and this ticket cannot land without them.`,
  );
}

/** The start's merge of the target, as `targetMergedAtStart` answers it, its change aside. */
async function targetMergeStartTarget({
  where,
  named,
  tip,
  contained,
  log,
  said,
}) {
  if (contained) {
    log(`the workspace already holds ${named} at ${tip}`);
    return { named, tip, conflicted: [] };
  }
  const withheld = await targetMergePipelines(where, tip);
  if (withheld.length > 0) {
    log(
      `${named} at ${tip} changes ${withheld.join(", ")} under .github/workflows/, which this job cannot push, so this attempt runs without merging it`,
    );
    return { named, tip, conflicted: [], withheld };
  }
  try {
    const { conflicted } = await sourceTargetMerged({ ...where, named, tip });
    log(
      conflicted.length === 0
        ? `merged ${named} at ${tip} into the workspace`
        : `merging ${named} at ${tip} stopped on conflicts in ${conflicted.join(", ")}, left for the agent`,
    );
    return { named, tip, conflicted };
  } catch (failure) {
    log(
      `${named} at ${tip} could not be merged, so this attempt runs without it: ${said(failure)}`,
    );
    return undefined;
  }
}

/**
 * The start's merge of a failed landing's change, after the target: `{commit,
 * conflicted}`, or `{commit, pending: true}` where the target's merge
 * `stopped`; nothing where it could not be merged, which `log` is told.
 */
async function targetMergeStartChange({
  where,
  named,
  change,
  stopped,
  log,
  said,
}) {
  if (stopped) {
    log(
      `${targetMergeChangeName} ${change} is left for the agent to merge once its merge of ${named} is concluded`,
    );
    return { commit: change, pending: true };
  }
  if (await sourceTargetContained({ ...where, tip: change })) {
    log(`the workspace already holds ${targetMergeChangeName} ${change}`);
    return { commit: change, conflicted: [] };
  }
  try {
    const { conflicted } = await sourceTargetMerged({
      ...where,
      named: `${targetMergeChangeName} ${change}`,
      tip: change,
    });
    log(
      conflicted.length === 0
        ? `merged ${targetMergeChangeName} ${change} into the workspace`
        : `merging ${targetMergeChangeName} ${change} stopped on conflicts in ${conflicted.join(", ")}, left for the agent`,
    );
    return { commit: change, conflicted };
  } catch (failure) {
    log(
      `${targetMergeChangeName} ${change} could not be merged, so this attempt runs without it: ${said(failure)}`,
    );
    return undefined;
  }
}

/** The merge the start left in progress, as `targetMergedAtEnd` holds one, or nothing. */
function targetMergeLeft(started) {
  if (started === undefined) return undefined;
  if (started.conflicted.length > 0)
    return {
      named: started.named,
      tip: started.tip,
      paths: started.conflicted,
      told: true,
    };
  const change = started.change;
  if ((change?.conflicted?.length ?? 0) > 0)
    return {
      named: targetMergeChangeName,
      tip: change.commit,
      paths: change.conflicted,
      told: true,
    };
  return undefined;
}

/**
 * The end's merge, as `targetMergedAtStart` is handed it, beside `started`, what
 * that answered, and `resume`, which runs the agent's conversation on with a
 * prompt and answers its result, or nothing where the runtime cannot resume.
 * A fetch or merge that fails, or a target bringing in a workflow change the
 * job cannot push, is logged, and the work is pushed as it stands.
 */
export async function targetMergedAtEnd({
  where,
  fetched,
  log,
  said,
  started,
  resume,
}) {
  const merge = where.task.targetMerge;
  if (merge === undefined) return;
  const named = targetMergeName(merge.ref);
  const nudges = { spent: 0 };
  let pending = targetMergeLeft(started);
  const roundsMax = 3 * (targetMergeNudgesMax + 2);
  for (let round = 0; round < roundsMax; round += 1) {
    if (pending !== undefined) {
      pending = await targetMergeSettled({
        where,
        pending,
        nudges,
        resume,
        log,
      });
      continue;
    }
    const merged = await targetMergeMoved({ where, named, fetched, log, said });
    if (merged === undefined) return;
    pending = merged;
  }
  throw new Error(
    `merging ${named} took more than ${String(roundsMax)} rounds`,
  );
}

/**
 * The target fetched and, where it moved past the work, merged on top of the
 * work committed, a commit that is the commit step as the candidate's is: the
 * conflict left, as `targetMergedAtEnd` holds one, or nothing where nothing is
 * left to settle.
 */
async function targetMergeMoved({ where, named, fetched, log, said }) {
  let tip;
  try {
    tip = await fetched();
  } catch (failure) {
    log(
      `the target ${named} could not be fetched, so the work is pushed without merging it: ${said(failure)}`,
    );
    return undefined;
  }
  if (await sourceTargetContained({ ...where, tip })) return undefined;
  await runStep(
    runCommitFailed,
    () => sourceWorkCommitted(where),
    gitFailureLine,
  );
  const withheld = await targetMergePipelines(where, tip);
  if (withheld.length > 0) {
    log(
      `${named} at ${tip} changes ${withheld.join(", ")} under .github/workflows/, which this job cannot push, so the work is pushed without merging it`,
    );
    return undefined;
  }
  let conflicted;
  try {
    ({ conflicted } = await sourceTargetMerged({ ...where, named, tip }));
  } catch (failure) {
    log(
      `${named} at ${tip} could not be merged, so the work is pushed without it: ${said(failure)}`,
    );
    return undefined;
  }
  if (conflicted.length === 0) {
    log(`merged ${named} at ${tip}, which moved past the work`);
    return undefined;
  }
  log(
    `merging ${named} at ${tip} stopped on conflicts in ${conflicted.join(", ")}`,
  );
  return { named, tip, paths: conflicted, told: false };
}

/**
 * One step toward a merge in progress settling: committed where every path is
 * resolved, which settles it, and otherwise the agent resumed with a nudge and
 * the merge still pending. Raised as `TargetMergeUnresolved` where it cannot
 * be resumed, its nudges are spent, or its resumed turn did not pass.
 */
async function targetMergeSettled({ where, pending, nudges, resume, log }) {
  const { named, tip } = pending;
  const left = await sourceConflictsLeft({ ...where, paths: pending.paths });
  if (left.length === 0) {
    await sourceMergeConcluded({ ...where, tip });
    log(`the merge of ${named} at ${tip} is resolved`);
    return undefined;
  }
  const unresolved = `the merge of ${named} at ${tip} is unresolved in ${left.join(", ")}`;
  if (resume === undefined)
    throw new TargetMergeUnresolved(
      `${unresolved}, and the agent's runtime cannot be resumed to resolve it, so the attempt pushes nothing`,
    );
  if (nudges.spent >= targetMergeNudgesMax)
    throw new TargetMergeUnresolved(
      `${unresolved} after ${String(nudges.spent)} resumed turns, so the attempt pushes nothing`,
    );
  const asked = { named, tip, paths: left };
  nudges.spent += 1;
  const { result } = await resume(
    pending.told
      ? targetMergeConflictNudge(asked)
      : targetMergeMovedNudge(asked),
  );
  if (result.verdict !== "Pass")
    throw new TargetMergeUnresolved(
      `${unresolved}, and the agent's resumed turn ended ${result.verdict}, so the attempt pushes nothing`,
    );
  return { ...pending, told: true };
}
