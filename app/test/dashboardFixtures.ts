import { vi } from 'vitest';
import type {
  DashboardActivity,
  DashboardApi,
  DashboardBoard,
  DashboardTeamRuntime,
  DashboardTeams,
  Result,
  Workspace,
} from '../src/renderer/api';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export const workspaceA: Workspace = { id: 'ws-a', name: 'Alpha', path: '/work/alpha', missing: false, exists: true };
export const workspaceB: Workspace = { id: 'ws-b', name: 'Beta', path: '/work/beta', missing: false, exists: true };

export function teamsFixture(label: string): DashboardTeams {
  return {
    workspace: label,
    truncated: false,
    teams: [
      {
        id: `${label}-run`,
        name: `${label} running team`,
        members: 2,
        runtime: {
          teamId: `${label}-run`,
          status: 'running',
          memberCount: 2,
          availability: { busy: 1 } as unknown as DashboardTeamRuntime['availability'],
          activeAssignments: 1,
        },
      },
      { id: `${label}-stop`, name: `${label} stopped team`, members: 1, runtime: null },
    ],
  };
}

export function boardFixture(label: string): DashboardBoard {
  return {
    workspace: label,
    currentPhase: { slug: 'p1', name: `${label} phase`, status: 'open' },
    columns: [
      { status: 'todo', kind: 'initial', title: 'To do', count: 1 },
      { status: 'in-review', kind: null, title: 'In review', count: 1 },
    ],
    totals: { active: 1, blocked: 1, done: 0 },
    tickets: [
      {
        key: 'T-001', title: `${label} blocked ticket`, status: 'in-review', priority: 1, phase: 'p1',
        activity: { state: 'blocked', agent: 'dev', role: 'developer' },
      },
    ],
  };
}

export function activityFixture(label: string): DashboardActivity {
  const kinds = ['team', 'assignment', 'workflow', 'ticket'] as const;
  return {
    workspace: label,
    dbId: 'db',
    head: 4,
    entries: kinds.map((kind, index) => ({
      id: `${label}:${kind}`,
      at: `2026-01-0${index + 1}T01:02:03.000Z`,
      kind,
      name: kind,
      summary: `${label} ${kind} happened`,
    })),
  };
}

export function readyApi(label = 'ready') {
  const teams = vi.fn(async (): Promise<Result<DashboardTeams>> => ({ ok: true, data: teamsFixture(label) }));
  const board = vi.fn(async (): Promise<Result<DashboardBoard>> => ({ ok: true, data: boardFixture(label) }));
  const activity = vi.fn(async (): Promise<Result<DashboardActivity>> => ({ ok: true, data: activityFixture(label) }));
  return { api: { teams, board, activity } as DashboardApi, teams, board, activity };
}
