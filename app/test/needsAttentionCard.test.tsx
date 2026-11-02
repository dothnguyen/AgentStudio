// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionRow } from '../src/renderer/boards/attentionModel';
import { NeedsAttentionCard } from '../src/renderer/boards/NeedsAttentionCard';

afterEach(cleanup);

function row(index: number): AttentionRow {
  return {
    id: `blocked-T-${100 + index}`,
    source: 'blocked',
    key: `T-${100 + index}`,
    title: `Ticket ${100 + index}`,
    reason: 'A run stopped.',
    ticketKey: `T-${100 + index}`,
  };
}

describe('NeedsAttentionCard', () => {
  it('renders nothing when no row needs attention', () => {
    const view = render(<NeedsAttentionCard rows={[]} />);
    expect(view.container.innerHTML).toBe('');
  });

  it('shows the count and each row with an Open button', () => {
    const onOpenTicket = vi.fn();
    const view = render(
      <NeedsAttentionCard rows={[row(0), row(1)]} onOpenTicket={onOpenTicket} />,
    );

    expect(view.getByRole('heading', { name: 'Needs attention · 2' })).toBeTruthy();
    expect(view.getAllByRole('listitem')).toHaveLength(2);
    expect(view.getByText('Ticket 100')).toBeTruthy();
    expect(view.getAllByText('A run stopped.')).toHaveLength(2);

    fireEvent.click(view.getByRole('button', { name: 'Open T-101' }));
    expect(onOpenTicket).toHaveBeenCalledWith('T-101');
  });

  it('shows four rows then a Show N more button that reveals the rest', () => {
    const view = render(<NeedsAttentionCard rows={[row(0), row(1), row(2), row(3), row(4), row(5)]} />);

    expect(view.getAllByRole('listitem')).toHaveLength(4);
    expect(view.queryByText('Ticket 104')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Show 2 more' }));
    expect(view.getAllByRole('listitem')).toHaveLength(6);
    expect(view.getByText('Ticket 105')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Show fewer' })).toBeTruthy();
  });

  it('disables the Open button when ticketKey is null', () => {
    const onOpenTicket = vi.fn();
    const rows: AttentionRow[] = [{
      id: 'cmd-1',
      source: 'command',
      key: 'run-123',
      title: 'A delegated command waits for approval: app-deps',
      reason: 'Requested by Engineer. It needs a human to approve it.',
      ticketKey: null,
    }];
    const view = render(<NeedsAttentionCard rows={rows} onOpenTicket={onOpenTicket} />);

    const button = view.getByRole('button', { name: 'Open run-123' });
    expect(button.hasAttribute('disabled')).toBe(true);

    fireEvent.click(button);
    expect(onOpenTicket).not.toHaveBeenCalled();
  });

  it('marks rows with data-source attribute for styling', () => {
    const rows: AttentionRow[] = [
      { id: 'blocked-1', source: 'blocked', key: 'T-100', title: 'Blocked ticket', reason: 'Stopped.', ticketKey: 'T-100' },
      { id: 'cmd-1', source: 'command', key: 'T-101', title: 'Command pending', reason: 'Awaiting approval.', ticketKey: 'T-101' },
      { id: 'run-1', source: 'run', key: 'T-102', title: 'Run paused', reason: 'At stage qa.', ticketKey: 'T-102' },
    ];
    const view = render(<NeedsAttentionCard rows={rows} />);

    const items = view.getAllByRole('listitem');
    expect(items[0].getAttribute('data-source')).toBe('blocked');
    expect(items[1].getAttribute('data-source')).toBe('command');
    expect(items[2].getAttribute('data-source')).toBe('run');
  });

  it('does not call onOpenTicket when callback is undefined', () => {
    const view = render(<NeedsAttentionCard rows={[row(0)]} />);

    fireEvent.click(view.getByRole('button', { name: 'Open T-100' }));
    // Should not throw, and no error should occur
    expect(view.getByText('Ticket 100')).toBeTruthy();
  });

  it('shows no Show more button when there are exactly 4 rows', () => {
    const view = render(<NeedsAttentionCard rows={[row(0), row(1), row(2), row(3)]} />);

    expect(view.getAllByRole('listitem')).toHaveLength(4);
    expect(view.queryByRole('button', { name: /Show.*more/ })).toBeNull();
  });

  it('toggles expansion state with Show fewer button', () => {
    const view = render(<NeedsAttentionCard rows={[row(0), row(1), row(2), row(3), row(4), row(5), row(6)]} />);

    fireEvent.click(view.getByRole('button', { name: 'Show 3 more' }));
    expect(view.getAllByRole('listitem')).toHaveLength(7);

    fireEvent.click(view.getByRole('button', { name: 'Show fewer' }));
    expect(view.getAllByRole('listitem')).toHaveLength(4);
  });

  it('renders row title and reason in separate spans', () => {
    const rows: AttentionRow[] = [{
      id: 'blocked-1',
      source: 'blocked',
      key: 'T-100',
      title: 'This is the title',
      reason: 'This is the reason',
      ticketKey: 'T-100',
    }];
    const view = render(<NeedsAttentionCard rows={rows} />);

    const titleElement = view.getByText('This is the title');
    const reasonElement = view.getByText('This is the reason');
    expect(titleElement.classList.contains('boards-attention-row-title')).toBe(true);
    expect(reasonElement.classList.contains('boards-attention-reason')).toBe(true);
  });
});
