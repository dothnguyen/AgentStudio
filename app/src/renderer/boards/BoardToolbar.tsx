import type { JSX } from 'react';
import type { BoardStatusInfo } from './boardLaneModel';
import { filteredCountLabel, type BoardFilters } from './boardFilters';

export interface BoardToolbarProps {
  filters: BoardFilters;
  workflowStatuses: readonly BoardStatusInfo[];
  /** The number of tickets that pass every filter. */
  resultCount: number;
  onChange(filters: BoardFilters): void;
}

function SearchIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

/** Search, activity toggles and the filtered ticket count above the board. */
export function BoardToolbar(props: BoardToolbarProps): JSX.Element {
  const { filters } = props;
  return (
    <div className="boards-toolbar">
      <div className="boards-toolbar-controls">
        <label className="boards-search">
          <SearchIcon />
          <span className="visually-hidden">Search tickets</span>
          <input
            type="text"
            placeholder="Search tickets"
            value={filters.query}
            onChange={(event) => { props.onChange({ ...filters, query: event.target.value }); }}
          />
        </label>
        <label className="boards-workflow-filter">
          Workflow status
          <select multiple value={filters.workflowStatuses} onChange={(event) => {
            props.onChange({ ...filters, workflowStatuses: Array.from(event.currentTarget.selectedOptions, (option) => option.value) });
          }}>
            {props.workflowStatuses.map((status) => <option key={status.id} value={status.id}>{status.name?.trim() || status.id}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="boards-filter-chip"
          aria-pressed={filters.blockedOnly}
          onClick={() => { props.onChange({ ...filters, blockedOnly: !filters.blockedOnly }); }}
        >
          Blocked only
        </button>
        <button
          type="button"
          className="boards-filter-chip"
          aria-pressed={filters.workingOnly}
          onClick={() => { props.onChange({ ...filters, workingOnly: !filters.workingOnly }); }}
        >
          Working now
        </button>
        <button
          type="button"
          className="boards-filter-chip"
          aria-pressed={filters.hideEmpty}
          onClick={() => { props.onChange({ ...filters, hideEmpty: !filters.hideEmpty }); }}
        >
          Hide empty columns
        </button>
      </div>
      <span className="boards-toolbar-count">{filteredCountLabel(props.resultCount)}</span>
    </div>
  );
}
