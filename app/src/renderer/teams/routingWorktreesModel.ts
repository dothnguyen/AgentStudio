import type { BoardSettings, BoardSettingsChanges, ManagementError, Problem } from '../../shared/management';

/** The only routing setting still edited on the Routing screen: where isolated worktrees start. */
export interface WorktreesDraft { baseBranch: string }

const BASE_BRANCH = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE_BRANCH_PROBLEM = 'Use 1–64 lowercase letters, numbers, or hyphens, starting with a letter or number.';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A draft of the worktree base branch, or null when the board configuration cannot be edited. */
export function createWorktreesDraft(settings: BoardSettings): WorktreesDraft | null {
  if (settings.board.state !== 'ok') return null;
  return { baseBranch: settings.worktree.baseBranch ?? 'main' };
}

export function validateWorktreesDraft(draft: WorktreesDraft): Problem[] {
  return BASE_BRANCH.test(draft.baseBranch) ? [] : [{ path: 'baseBranch', message: BASE_BRANCH_PROBLEM }];
}

/** Only the base branch changed by this dialog; null means there is nothing to save. */
export function worktreesChanges(draft: WorktreesDraft, settings: BoardSettings): BoardSettingsChanges | null {
  if (draft.baseBranch === (settings.worktree.baseBranch ?? 'main')) return null;
  return { baseBranch: draft.baseBranch };
}

export function errorProblems(error: ManagementError): Problem[] {
  if (!object(error.data) || !Array.isArray(error.data.problems)) return [];
  return error.data.problems.filter((p: unknown): p is Problem => object(p) && typeof p.path === 'string' && typeof p.message === 'string').map((p: Problem) => ({ path: p.path, message: p.message }));
}
