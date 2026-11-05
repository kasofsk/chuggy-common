/**
 * The ref a work task's finalizer lands on, merged into its workspace: once
 * before the agent runs, and again once its result is accepted, before the
 * candidate is committed and pushed (`source.mjs`).
 *
 * A MERGE, NEVER A REBASE, and `--no-ff`, so the candidate still descends from
 * the commit the attempt started from and the target's commits keep their
 * names. A workspace already holding the target's tip is not merged.
 *
 * AT THE START a clean merge is what the agent builds on, and a conflict is
 * left in progress for the agent, its briefing saying what it is looking at.
 * A target that cannot be fetched or merged is logged and the attempt runs
 * without it.
 *
 * AT THE END the target is fetched again, and where it moved past the work the
 * work is committed and the target merged on top. A conflict there, or one the
 * start left that the agent did not resolve, resumes the same conversation with
 * a nudge naming the target, its commit and the files. Every nudge shares
 * `targetMergeNudgesMax`. Once that is spent, or where the runtime cannot
 * resume, the attempt ends as `TargetMergeUnresolved` and nothing is pushed.
 * A resolved merge is committed by the core, and the target fetched again.
 */

import { gitFailureLine } from "./gitRemote.mjs";
import { runCommitFailed, runStep } from "./runEvidence.mjs";
import {
  sourceConflictsLeft,
  sourceMergeConcluded,
  sourceTargetContained,
  sourceTargetMerged,
  sourceWorkCommitted,
} from "./source.mjs";

/** How many times one attempt's agent may be resumed to resolve a merge of its target. */
export const targetMergeNudgesMax = 3;

/** What every nudge, and a briefing whose merge stopped, tells the agent to do. */
export const targetMergeResolveInstruction =
  "Resolve each conflicting file so that the intent of both sides survives, and mark it resolved with `git add`. Then run the tests. Do not commit, and do not abort the merge, reset or change branches: the merge is committed for you once every file is resolved.";

/** A run of paths as a nudge lists them. */
function targetMergePaths(paths) {
  return paths.map((path) => `- ${path}`).join("\n");
}

/** What a resumed agent is told when the target moved past its work and merging it stopped on conflicts. */
export function targetMergeMovedNudge({ targetRef, tip, paths }) {
  return [
    `The branch this work lands on, ${targetRef}, moved on while you worked. It is at ${tip} now, and merging it into your work stopped on conflicts in:`,
    targetMergePaths(paths),
    targetMergeResolveInstruction,
  ].join("\n\n");
}

/** What a resumed agent is told when a merge of the target still has conflicts it has not resolved. */
export function targetMergeConflictNudge({ targetRef, tip, paths }) {
  return [
    `The merge of ${targetRef} at ${tip} into your work still has unresolved conflicts in:`,
    targetMergePaths(paths),
    targetMergeResolveInstruction,
  ].join("\n\n");
}

/** `task` as its agent is handed it where the start's merge stopped on conflicts, and as it was otherwise. */
export function targetMergeBriefed(task, started) {
  if (started === undefined || started.conflicted.length === 0) return task;
  const section = [
    "## A merge of the target branch is in progress",
    `This checkout merged ${started.targetRef} at ${started.tip}, the branch this work lands on, and the merge stopped on conflicts in:`,
    targetMergePaths(started.conflicted),
    "Before the ticket's work, resolve each conflicting file so that the intent of both sides survives, and mark it resolved with `git add`. Do not abort the merge, reset or change branches.",
  ].join("\n\n");
  return {
    ...task,
    briefing: { ...task.briefing, text: `${task.briefing.text}\n\n${section}` },
  };
}

/** An attempt whose target's merge was left unresolved, which pushes nothing and is lost rather than failed. */
export class TargetMergeUnresolved extends Error {
  name = "TargetMergeUnresolved";
}

/**
 * The start's merge: `{targetRef, tip, conflicted}`, `conflicted` the paths it
 * left unmerged, where it fetched; nothing where the task names no target or
 * it could not be fetched or merged, which `log` is told. `where` is the
 * `task`, `directory`, `command` and `git` the workspace's git is run with,
 * `fetched` answers the target's tip, and `said` a failure as it is logged.
 */
export async function targetMergedAtStart({ where, fetched, log, said }) {
  const { targetRef } = where.task;
  if (targetRef === undefined) return undefined;
  let tip;
  try {
    tip = await fetched();
  } catch (failure) {
    log(
      `the target ${targetRef} could not be fetched, so this attempt runs without merging it: ${said(failure)}`,
    );
    return undefined;
  }
  if (await sourceTargetContained({ ...where, tip })) {
    log(`the workspace already holds ${targetRef} at ${tip}`);
    return { targetRef, tip, conflicted: [] };
  }
  try {
    const { conflicted } = await sourceTargetMerged({
      ...where,
      targetRef,
      tip,
    });
    log(
      conflicted.length === 0
        ? `merged ${targetRef} at ${tip} into the workspace`
        : `merging ${targetRef} at ${tip} stopped on conflicts in ${conflicted.join(", ")}, left for the agent`,
    );
    return { targetRef, tip, conflicted };
  } catch (failure) {
    log(
      `${targetRef} at ${tip} could not be merged, so this attempt runs without it: ${said(failure)}`,
    );
    return undefined;
  }
}

/**
 * The end's merge, as `targetMergedAtStart` is handed it, beside `started`, what
 * that answered, and `resume`, which runs the agent's conversation on with a
 * prompt and answers its result, or nothing where the runtime cannot resume.
 * A fetch or merge that fails is logged, and the work is pushed as it stands.
 */
export async function targetMergedAtEnd({
  where,
  fetched,
  log,
  said,
  started,
  resume,
}) {
  const { targetRef } = where.task;
  if (targetRef === undefined) return;
  const nudges = { spent: 0 };
  let pending =
    started === undefined || started.conflicted.length === 0
      ? undefined
      : { tip: started.tip, paths: started.conflicted, told: true };
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
    const merged = await targetMergeMoved({ where, fetched, log, said });
    if (merged === undefined) return;
    pending = merged;
  }
  throw new Error(
    `merging ${targetRef} took more than ${String(roundsMax)} rounds`,
  );
}

/**
 * The target fetched and, where it moved past the work, merged on top of the
 * work committed, a commit that is the commit step as the candidate's is: the
 * conflict left, as `targetMergedAtEnd` holds one, or nothing where nothing is
 * left to settle.
 */
async function targetMergeMoved({ where, fetched, log, said }) {
  const { targetRef } = where.task;
  let tip;
  try {
    tip = await fetched();
  } catch (failure) {
    log(
      `the target ${targetRef} could not be fetched, so the work is pushed without merging it: ${said(failure)}`,
    );
    return undefined;
  }
  if (await sourceTargetContained({ ...where, tip })) return undefined;
  await runStep(
    runCommitFailed,
    () => sourceWorkCommitted(where),
    gitFailureLine,
  );
  let conflicted;
  try {
    ({ conflicted } = await sourceTargetMerged({ ...where, targetRef, tip }));
  } catch (failure) {
    log(
      `${targetRef} at ${tip} could not be merged, so the work is pushed without it: ${said(failure)}`,
    );
    return undefined;
  }
  if (conflicted.length === 0) {
    log(`merged ${targetRef} at ${tip}, which moved past the work`);
    return undefined;
  }
  log(
    `merging ${targetRef} at ${tip} stopped on conflicts in ${conflicted.join(", ")}`,
  );
  return { tip, paths: conflicted, told: false };
}

/**
 * One step toward a merge in progress settling: committed where every path is
 * resolved, which settles it, and otherwise the agent resumed with a nudge and
 * the merge still pending. Raised as `TargetMergeUnresolved` where it cannot
 * be resumed, its nudges are spent, or its resumed turn did not pass.
 */
async function targetMergeSettled({ where, pending, nudges, resume, log }) {
  const { targetRef } = where.task;
  const left = await sourceConflictsLeft({ ...where, paths: pending.paths });
  if (left.length === 0) {
    await sourceMergeConcluded(where);
    log(`the merge of ${targetRef} at ${pending.tip} is resolved`);
    return undefined;
  }
  const unresolved = `the merge of ${targetRef} at ${pending.tip} is unresolved in ${left.join(", ")}`;
  if (resume === undefined)
    throw new TargetMergeUnresolved(
      `${unresolved}, and the agent's runtime cannot be resumed to resolve it, so the attempt pushes nothing`,
    );
  if (nudges.spent >= targetMergeNudgesMax)
    throw new TargetMergeUnresolved(
      `${unresolved} after ${String(nudges.spent)} resumed turns, so the attempt pushes nothing`,
    );
  const asked = { targetRef, tip: pending.tip, paths: left };
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
