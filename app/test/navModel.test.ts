import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, workspaceInitials } from '../src/renderer/shell/navModel';

describe('NAV_ITEMS', () => {
  it('places_skills_after_roles_and_routing_after_boards_with_their_own_icons', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual(['home', 'teams', 'agents', 'roles', 'skills', 'boards', 'routing', 'configuration']);
    expect(NAV_ITEMS.find((item) => item.id === 'skills')).toEqual({ id: 'skills', label: 'Skills', icon: 'skills' });
    expect(NAV_ITEMS.find((item) => item.id === 'routing')).toEqual({ id: 'routing', label: 'Routing', icon: 'routing' });
  });
});

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
