// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardToolbar } from '../src/renderer/boards/BoardToolbar';
import { DEFAULT_BOARD_FILTERS, filterBoardTickets } from '../src/renderer/boards/boardFilters';
import { boardTicketSummary } from './boardFixtures';

afterEach(cleanup);

function Toolbar() {
  const [filters, setFilters] = useState({ ...DEFAULT_BOARD_FILTERS, query: 'release', blockedOnly: true });
  const tickets = [boardTicketSummary({ key: 'T-1', title: 'release', workflowStatus: 'dev-ready', activity: { state: 'blocked', note: 'blocked' } }), boardTicketSummary({ key: 'T-2', title: 'release', workflowStatus: 'qa-ready', activity: { state: 'blocked', note: 'blocked' } }), boardTicketSummary({ key: 'T-3', title: 'other', workflowStatus: 'dev-ready' })];
  return <BoardToolbar filters={filters} workflowStatuses={[{ id: 'dev-ready', name: 'Development ready' }, { id: 'qa-ready', name: 'Quality review' }, { id: 'other', name: '   ' }]} resultCount={filterBoardTickets(tickets, filters).length} onChange={setFilters} />;
}

describe('BoardToolbar workflow status filter', () => {
  it('filters options by name or id, selects multiple statuses without duplicates, and removes chips', async () => {
    const user = userEvent.setup();
    const view = render(<Toolbar />);
    const input = view.getByRole('combobox', { name: 'Workflow status' });
    await user.click(input);
    expect(view.getByRole('option', { name: 'other' })).toBeTruthy();
    await user.type(input, 'development');
    expect(view.queryByRole('option', { name: 'Quality review' })).toBeNull();
    await user.click(view.getByRole('option', { name: 'Development ready' }));
    expect(view.getByRole('button', { name: 'Remove workflow status: Development ready' })).toBeTruthy();
    expect(view.getByText('1 ticket')).toBeTruthy();
    expect(view.getByRole('option', { name: 'Development ready' }).getAttribute('aria-selected')).toBe('true');
    await user.click(view.getByRole('option', { name: 'Development ready' }));
    expect(view.getAllByRole('button', { name: 'Remove workflow status: Development ready' })).toHaveLength(1);
    await user.type(input, 'qa-ready');
    await user.click(view.getByRole('option', { name: 'Quality review' }));
    expect(view.getByText('2 tickets')).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Remove workflow status: Development ready' }));
    expect(document.activeElement).toBe(input);
    expect(view.getByText('1 ticket')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Remove workflow status: Development ready' })).toBeNull();
    expect(view.getByRole('button', { name: 'Remove workflow status: Quality review' })).toBeTruthy();
  });

  it('supports keyboard navigation, selection, escape and outside focus or click', async () => {
    const user = userEvent.setup();
    const view = render(<Toolbar />);
    const input = view.getByRole('combobox', { name: 'Workflow status' });
    input.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(view.getByRole('button', { name: 'Remove workflow status: Quality review' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await user.keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(view.getByRole('button', { name: 'Remove workflow status: Development ready' })).toBeTruthy();
    await user.click(view.getByRole('button', { name: 'Blocked only' }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(view.getByRole('button', { name: 'Remove workflow status: Quality review' })).toBeTruthy();
    await user.click(input);
    fireEvent.mouseDown(document.body);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('selects a filtered active option with Space while allowing spaces in matching names', async () => {
    const user = userEvent.setup();
    const view = render(<Toolbar />);
    const input = view.getByRole('combobox', { name: 'Workflow status' });
    await user.click(input);
    await user.type(input, 'qa-ready');
    await user.keyboard(' ');
    expect(view.getByRole('button', { name: 'Remove workflow status: Quality review' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await user.type(input, 'Development');
    await user.keyboard(' ');
    expect((input as HTMLInputElement).value).toBe('Development ');
    await user.type(input, 'ready');
    expect(view.getByRole('option', { name: 'Development ready' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(view.getByRole('button', { name: 'Remove workflow status: Development ready' })).toBeTruthy();
  });

  it('announces an empty result and retains other toolbar filters', async () => {
    const user = userEvent.setup();
    const view = render(<Toolbar />);
    const input = view.getByRole('combobox', { name: 'Workflow status' });
    await user.type(input, 'missing');
    expect(view.getByRole('status').textContent).toBe('No matching statuses');
    expect(within(view.container).getByRole('button', { name: 'Blocked only' }).getAttribute('aria-pressed')).toBe('true');
    expect((view.getByPlaceholderText('Search tickets') as HTMLInputElement).value).toBe('release');
  });
});
