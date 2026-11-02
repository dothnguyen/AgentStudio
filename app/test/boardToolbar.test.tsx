// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardToolbar } from '../src/renderer/boards/BoardToolbar';
import { DEFAULT_BOARD_FILTERS } from '../src/renderer/boards/boardFilters';

describe('BoardToolbar workflow status filter', () => {
  it('offers named and fallback statuses and reports all selected values with other filters preserved', () => {
    const onChange = vi.fn();
    const filters = { ...DEFAULT_BOARD_FILTERS, query: 'release', blockedOnly: true };
    const view = render(<BoardToolbar
      filters={filters}
      workflowStatuses={[
        { id: 'dev-ready', name: 'Development ready' },
        { id: 'qa-ready', name: '   ' },
      ]}
      resultCount={2}
      onChange={onChange}
    />);

    const select = view.getByLabelText('Workflow status') as HTMLSelectElement;
    expect(select.multiple).toBe(true);
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['Development ready', 'qa-ready']);

    select.options[0].selected = true;
    select.options[1].selected = true;
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      workflowStatuses: ['dev-ready', 'qa-ready'],
    });
  });
});
