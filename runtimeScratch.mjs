/**
 * How a directory a runner's process makes under its runtime directory is
 * named: what it is for, then the process, so a process leaving can find its
 * own and a restarted one can remove what a predecessor left.
 */

/**
 * @param {"pull" | "job"} kind
 * @param {number} pid
 */
export function runtimeScratch(kind, pid = process.pid) {
  return `${kind}-${String(pid)}-`;
}
