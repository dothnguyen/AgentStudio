import { describe, expect, it } from 'vitest';
import { workspaceInitials } from '../src/renderer/shell/navModel';

describe('workspaceInitials', () => {
  it('workspace_initials_use_first_letters_of_two_words', () => {
    expect(workspaceInitials('Agent Studio')).toBe('AS');
    expect(workspaceInitials('A very long workspace name')).toBe('AV');
    expect(workspaceInitials('my-project_x')).toBe('MP');
  });

  it('workspace_initials_handle_single_word_and_empty', () => {
    expect(workspaceInitials('agentstudio')).toBe('AG');
    expect(workspaceInitials('x')).toBe('X');
    expect(workspaceInitials('   ')).toBe('?');
    expect(workspaceInitials('')).toBe('?');
  });
});
