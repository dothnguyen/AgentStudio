import { describe, expect, it } from 'vitest';
import {
  BOARD_NAV_ITEMS,
  BOARDS_DEFAULT_ROUTE,
  NAV_ITEMS,
  boardTicketKey,
  boardTicketRoute,
  findNavItem,
  isBoardRoute,
  workspaceInitials,
} from '../src/renderer/shell/navModel';

describe('NAV_ITEMS', () => {
  it('places_skills_after_roles_and_routing_after_boards_with_their_own_icons', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual(['home', 'teams', 'agents', 'roles', 'skills', 'boards', 'routing', 'configuration']);
    expect(NAV_ITEMS.find((item) => item.id === 'skills')).toEqual({ id: 'skills', label: 'Skills', icon: 'skills' });
    expect(NAV_ITEMS.find((item) => item.id === 'routing')).toEqual({ id: 'routing', label: 'Routing', icon: 'routing' });
  });

  it('boards_is_an_expandable_group_with_current_phase_backlog_and_phases', () => {
    const boards = NAV_ITEMS.find((item) => item.id === 'boards');
    expect(boards?.label).toBe('Boards');
    expect(boards?.icon).toBe('boards');
    expect(boards?.route).toBe(BOARDS_DEFAULT_ROUTE);
    expect(boards?.children).toBe(BOARD_NAV_ITEMS);
    expect(boards?.children?.map((item) => item.id)).toEqual(['boards/current', 'boards/backlog', 'boards/phases']);
    expect(boards?.children?.map((item) => item.label)).toEqual(['Current Phase', 'Backlog', 'Phases']);
    expect(boards?.children?.map((item) => item.icon)).toEqual([undefined, undefined, undefined]);
  });

  it('keeps_the_other_top_level_items_flat', () => {
    for (const item of NAV_ITEMS.filter((entry) => entry.id !== 'boards')) {
      expect(item.children).toBeUndefined();
      expect(item.route).toBeUndefined();
    }
  });
});

describe('board routes', () => {
  it('builds_and_recognises_ticket_routes', () => {
    expect(boardTicketRoute('T-134')).toBe('boards/ticket/T-134');
    expect(boardTicketKey('boards/ticket/T-134')).toBe('T-134');
    expect(boardTicketKey('boards/ticket/T-12')).toBeNull();
    expect(boardTicketKey('boards/current')).toBeNull();
    expect(boardTicketKey('teams')).toBeNull();
  });

  it('recognises_every_boards_route', () => {
    expect(isBoardRoute('boards')).toBe(true);
    expect(isBoardRoute('boards/current')).toBe(true);
    expect(isBoardRoute('boards/backlog')).toBe(true);
    expect(isBoardRoute('boards/phases')).toBe(true);
    expect(isBoardRoute('boards/ticket/T-134')).toBe(true);
    expect(isBoardRoute('teams')).toBe(false);
    expect(isBoardRoute('boardsx')).toBe(false);
  });

  it('finds_children_before_the_group_route_and_the_ticket_group', () => {
    expect(findNavItem(NAV_ITEMS, 'boards/current')?.label).toBe('Current Phase');
    expect(findNavItem(NAV_ITEMS, 'boards/backlog')?.label).toBe('Backlog');
    expect(findNavItem(NAV_ITEMS, 'boards/phases')?.label).toBe('Phases');
    expect(findNavItem(NAV_ITEMS, 'boards')).toBeUndefined();
    expect(findNavItem(NAV_ITEMS, 'home')?.label).toBe('Home');
    expect(findNavItem(NAV_ITEMS, 'boards/ticket/T-134')).toBeUndefined();
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
