import { describe, expect, it } from 'vitest';
import { computeReadiness, hasCycle, isGraphComplete, type TaskGraphNode } from './task-graph.js';

function node(id: string, status: TaskGraphNode['status'], dependsOnTaskIds: string[] = []): TaskGraphNode {
  return { id, status, dependsOnTaskIds };
}

describe('computeReadiness', () => {
  it('marks a dependency-free PENDING task READY', () => {
    const { newlyReady, newlyBlocked } = computeReadiness([node('a', 'PENDING')]);
    expect(newlyReady).toEqual(['a']);
    expect(newlyBlocked).toEqual([]);
  });

  it('does not touch a task that is already READY/RUNNING/terminal', () => {
    const tasks = [node('a', 'READY'), node('b', 'RUNNING'), node('c', 'SUCCEEDED')];
    expect(computeReadiness(tasks)).toEqual({ newlyReady: [], newlyBlocked: [] });
  });

  it('holds a PENDING task back until every dependency has SUCCEEDED', () => {
    const tasks = [node('a', 'RUNNING'), node('b', 'PENDING', ['a'])];
    expect(computeReadiness(tasks)).toEqual({ newlyReady: [], newlyBlocked: [] });
  });

  it('marks READY once every dependency has SUCCEEDED', () => {
    const tasks = [node('a', 'SUCCEEDED'), node('b', 'PENDING', ['a'])];
    expect(computeReadiness(tasks).newlyReady).toEqual(['b']);
  });

  it('requires ALL dependencies, not just one, to succeed', () => {
    const tasks = [node('a', 'SUCCEEDED'), node('b', 'RUNNING'), node('c', 'PENDING', ['a', 'b'])];
    expect(computeReadiness(tasks)).toEqual({ newlyReady: [], newlyBlocked: [] });
  });

  it('permanently blocks a task whose dependency FAILED', () => {
    const tasks = [node('a', 'FAILED'), node('b', 'PENDING', ['a'])];
    expect(computeReadiness(tasks).newlyBlocked).toEqual(['b']);
  });

  it('blocks a task whose dependency was CANCELLED or SKIPPED', () => {
    for (const depStatus of ['CANCELLED', 'SKIPPED'] as const) {
      const tasks = [node('a', depStatus), node('b', 'PENDING', ['a'])];
      expect(computeReadiness(tasks).newlyBlocked).toEqual(['b']);
    }
  });

  it('blocks a task whose dependency id does not exist in the graph', () => {
    const tasks = [node('b', 'PENDING', ['missing'])];
    expect(computeReadiness(tasks).newlyBlocked).toEqual(['b']);
  });

  it('cascades: a task blocked by a failed grandparent is also blocked once its direct parent is blocked', () => {
    // First tick: a fails, b (depends on a) becomes blocked.
    let tasks = [node('a', 'FAILED'), node('b', 'PENDING', ['a']), node('c', 'PENDING', ['b'])];
    let result = computeReadiness(tasks);
    expect(result.newlyBlocked).toEqual(['b']);
    // Apply the transition, recompute: c now sees a BLOCKED dependency.
    tasks = [node('a', 'FAILED'), node('b', 'BLOCKED', ['a']), node('c', 'PENDING', ['b'])];
    result = computeReadiness(tasks);
    expect(result.newlyBlocked).toEqual(['c']);
  });
});

describe('isGraphComplete', () => {
  it('is false while any task is non-terminal', () => {
    expect(isGraphComplete([node('a', 'SUCCEEDED'), node('b', 'READY')])).toBe(false);
  });

  it('is true once every task is terminal, regardless of which terminal state', () => {
    expect(isGraphComplete([node('a', 'SUCCEEDED'), node('b', 'FAILED'), node('c', 'CANCELLED'), node('d', 'SKIPPED')])).toBe(true);
  });

  it('is true for an empty graph', () => {
    expect(isGraphComplete([])).toBe(true);
  });
});

describe('hasCycle', () => {
  it('is false for a simple linear chain', () => {
    expect(hasCycle([node('a', 'PENDING'), node('b', 'PENDING', ['a']), node('c', 'PENDING', ['b'])])).toBe(false);
  });

  it('detects a direct two-node cycle', () => {
    expect(hasCycle([node('a', 'PENDING', ['b']), node('b', 'PENDING', ['a'])])).toBe(true);
  });

  it('detects a longer cycle', () => {
    expect(hasCycle([node('a', 'PENDING', ['c']), node('b', 'PENDING', ['a']), node('c', 'PENDING', ['b'])])).toBe(true);
  });

  it('ignores a dependency id that does not exist in the graph (not a cycle)', () => {
    expect(hasCycle([node('a', 'PENDING', ['missing'])])).toBe(false);
  });
});
