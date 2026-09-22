/**
 * Mission task graph (Phase 10, §11/§12) — pure functions over a plain array
 * of task rows, no I/O. A task cannot run until every task in
 * `dependsOnTaskIds` has SUCCEEDED. A dependency that is itself stuck in a
 * non-success dead end — FAILED/CANCELLED/SKIPPED, or already BLOCKED by
 * *its own* dependency — permanently blocks its dependents too, rather than
 * leaving them silently PENDING forever. Nothing in this codebase ever
 * transitions a task back out of BLOCKED (no "retry a blocked task" path
 * exists in `loop.ts`), so BLOCKED is treated as terminal here exactly like
 * the four failure/cancellation statuses.
 */

export type TaskGraphStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'BLOCKED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SKIPPED';

export interface TaskGraphNode {
  id: string;
  status: TaskGraphStatus;
  dependsOnTaskIds: string[];
}

const TERMINAL_NON_SUCCESS = new Set<TaskGraphStatus>(['FAILED', 'CANCELLED', 'SKIPPED', 'BLOCKED']);
const TERMINAL = new Set<TaskGraphStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED', 'BLOCKED']);

export interface ReadinessResult {
  /** Task ids that were PENDING and have every dependency SUCCEEDED — the
   *  caller should transition these to READY. */
  newlyReady: string[];
  /** Task ids that were PENDING but depend (transitively) on a task that
   *  terminated without success — the caller should transition these to
   *  BLOCKED, since they can now never become ready. */
  newlyBlocked: string[];
}

/**
 * Recomputes readiness for every PENDING task, given the current status of
 * all tasks in the mission. Call after any task's status changes.
 */
export function computeReadiness(tasks: TaskGraphNode[]): ReadinessResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const newlyReady: string[] = [];
  const newlyBlocked: string[] = [];

  for (const task of tasks) {
    if (task.status !== 'PENDING') continue;
    if (task.dependsOnTaskIds.length === 0) {
      newlyReady.push(task.id);
      continue;
    }
    const blocked = task.dependsOnTaskIds.some((depId) => {
      const dep = byId.get(depId);
      return !dep || TERMINAL_NON_SUCCESS.has(dep.status);
    });
    if (blocked) {
      newlyBlocked.push(task.id);
      continue;
    }
    const allSucceeded = task.dependsOnTaskIds.every((depId) => byId.get(depId)?.status === 'SUCCEEDED');
    if (allSucceeded) newlyReady.push(task.id);
  }
  return { newlyReady, newlyBlocked };
}

/** Whether every task in the mission has reached a terminal state — the
 *  loop stops scheduling new work once true (§20/§21). */
export function isGraphComplete(tasks: TaskGraphNode[]): boolean {
  return tasks.every((t) => TERMINAL.has(t.status));
}

/** Detects a cycle in `dependsOnTaskIds` — the planner must never produce
 *  one, but this is a cheap defensive check before persisting a plan. */
export function hasCycle(tasks: TaskGraphNode[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();

  function visit(id: string): boolean {
    const s = state.get(id);
    if (s === 'visiting') return true;
    if (s === 'done') return false;
    state.set(id, 'visiting');
    const node = byId.get(id);
    for (const dep of node?.dependsOnTaskIds ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  }

  return tasks.some((t) => visit(t.id));
}
