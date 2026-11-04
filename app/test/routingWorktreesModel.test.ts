import { describe, expect, it } from 'vitest';
import { createWorktreesDraft, errorProblems, validateWorktreesDraft, worktreesChanges } from '../src/renderer/teams/routingWorktreesModel';
import { routingSettingsFixture } from './teamsFixtures';

describe('routing worktrees draft model', () => {
  it('creates a draft from the board base branch and falls back to main', () => {
    const settings = routingSettingsFixture();
    expect(createWorktreesDraft(settings)).toEqual({ baseBranch: 'main' });
    expect(createWorktreesDraft({ ...settings, worktree: { ...settings.worktree, baseBranch: 'release-2' } })).toEqual({ baseBranch: 'release-2' });
    expect(createWorktreesDraft({ ...settings, worktree: { ...settings.worktree, baseBranch: null } })).toEqual({ baseBranch: 'main' });
  });

  it('refuses a draft when the board configuration is not available', () => {
    const settings = routingSettingsFixture();
    expect(createWorktreesDraft({ ...settings, board: { ...settings.board, state: 'invalid' } })).toBeNull();
    expect(createWorktreesDraft({ ...settings, board: { ...settings.board, state: 'missing' } })).toBeNull();
  });

  it('validates the base branch like the backend', () => {
    expect(validateWorktreesDraft({ baseBranch: 'main' })).toEqual([]);
    expect(validateWorktreesDraft({ baseBranch: 'release-2' })).toEqual([]);
    expect(validateWorktreesDraft({ baseBranch: '2-release' })).toEqual([]);
    for (const baseBranch of ['', 'INVALID', '-leading', 'under_score', 'a'.repeat(65)]) {
      expect(validateWorktreesDraft({ baseBranch })).toEqual([
        { path: 'baseBranch', message: 'Use 1–64 lowercase letters, numbers, or hyphens, starting with a letter or number.' },
      ]);
    }
  });

  it('returns only the changed base branch, or null when nothing changed', () => {
    const settings = routingSettingsFixture();
    expect(worktreesChanges({ baseBranch: 'main' }, settings)).toBeNull();
    expect(worktreesChanges({ baseBranch: 'release-2' }, settings)).toEqual({ baseBranch: 'release-2' });
    expect(worktreesChanges({ baseBranch: 'main' }, { ...settings, worktree: { ...settings.worktree, baseBranch: null } })).toBeNull();
  });

  it('reads structured board problems from an error and ignores malformed ones', () => {
    expect(errorProblems({ code: 'BOARD_CONFIG_INVALID', message: 'invalid', retryable: false, data: { problems: [{ path: 'baseBranch', message: 'Rejected branch' }, null, { path: 1, message: 'x' }, { path: 'rules', message: 'Rejected rules', extra: 1 }] } }))
      .toEqual([{ path: 'baseBranch', message: 'Rejected branch' }, { path: 'rules', message: 'Rejected rules' }]);
    expect(errorProblems({ code: 'INTERNAL', message: 'no data', retryable: false })).toEqual([]);
    expect(errorProblems({ code: 'INTERNAL', message: 'wrong data', retryable: false, data: { problems: 'nope' } })).toEqual([]);
  });
});
