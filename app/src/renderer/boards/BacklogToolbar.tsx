import { useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { BoardPhases, BoardSettings, BoardTicketSummary } from '../api';
import { activeFilterCount, DEFAULT_BACKLOG_FILTERS, ownersOf, type BacklogFilters } from './backlogFilters';

type Option = { value: string; label: string };

function MultiSelect({ label, options, selected, onChange }: { label: string; options: Option[]; selected: string[]; onChange: (values: string[]) => void }): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const inputs = Array.from(panel.current?.querySelectorAll<HTMLInputElement>('input') ?? []);
      const index = inputs.indexOf(document.activeElement as HTMLInputElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : inputs.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + inputs.length) % inputs.length;
      inputs[next]?.focus();
    }
  };
  return <div className="boards-backlog-multi" onKeyDown={keyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={button} type="button" className="boards-filter-chip" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>{label}{selected.length > 0 && ` · ${selected.length}`}</button>
    {open && <div ref={panel} id={id} className="boards-backlog-popover" role="dialog" aria-label={`${label} options`}>
      {options.map(option => <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => onChange(selected.includes(option.value) ? selected.filter(value => value !== option.value) : [...selected, option.value])} />{option.label}</label>)}
    </div>}
  </div>;
}

const activityOptions: Option[] = [
  { value: 'working', label: 'Working' }, { value: 'blocked', label: 'Blocked' },
  { value: 'waiting', label: 'Waits for dependencies' }, { value: 'ready', label: 'Ready' }, { value: 'finished', label: 'Finished' },
];

export function BacklogToolbar({ filters, onChange, settings, phases, tickets, resultCount }: { filters: BacklogFilters; onChange: (filters: BacklogFilters) => void; settings: BoardSettings; phases: BoardPhases; tickets: BoardTicketSummary[]; resultCount: number }): JSX.Element {
  const statuses = settings.statuses.map(status => ({ value: status.id, label: status.name || status.id }));
  const phaseOptions = phases.phases.map(phase => ({ value: phase.slug, label: phase.name }));
  const update = (patch: Partial<BacklogFilters>) => onChange({ ...filters, ...patch });
  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  if (filters.query) chips.push({ key: 'query', label: `Search: ${filters.query}`, remove: () => update({ query: '' }) });
  for (const [field, title, options] of [['statuses', 'Status', statuses], ['phases', 'Phase', phaseOptions], ['activity', 'Activity', activityOptions]] as const) {
    for (const value of filters[field]) chips.push({ key: `${field}-${value}`, label: `${title}: ${options.find(option => option.value === value)?.label ?? value}`, remove: () => update({ [field]: filters[field].filter(item => item !== value) }) });
  }
  if (filters.owner !== null) chips.push({ key: 'owner', label: `Owner: ${filters.owner}`, remove: () => update({ owner: null }) });
  if (filters.priority !== 'any') chips.push({ key: 'priority', label: `Priority: ${{ urgent: 'Urgent', normal: 'Normal', low: 'Low' }[filters.priority]}`, remove: () => update({ priority: 'any' }) });
  if (filters.hasOpenDeps !== 'any') chips.push({ key: 'deps', label: `Dependencies: ${filters.hasOpenDeps === 'yes' ? 'Has open dependencies' : 'No open dependencies'}`, remove: () => update({ hasOpenDeps: 'any' }) });
  return <section className="boards-backlog-toolbar" aria-label="Backlog filters">
    <div className="boards-toolbar boards-backlog-toolbar-row">
      <label className="boards-search"><span className="visually-hidden">Search tickets</span><input placeholder="Search tickets" value={filters.query} onChange={event => update({ query: event.target.value })} /></label>
      <MultiSelect label="Status" options={statuses} selected={filters.statuses} onChange={statuses => update({ statuses })} />
      <MultiSelect label="Phase" options={phaseOptions} selected={filters.phases} onChange={phases => update({ phases })} />
      <MultiSelect label="Activity" options={activityOptions} selected={filters.activity} onChange={activity => update({ activity: activity as BacklogFilters['activity'] })} />
      <label className="boards-backlog-select">Owner <select value={filters.owner ?? ''} onChange={event => update({ owner: event.target.value || null })}><option value="">Anyone</option>{ownersOf(tickets).map(owner => <option key={owner} value={owner}>{owner}</option>)}</select></label>
      <label className="boards-backlog-select">Priority <select value={filters.priority} onChange={event => update({ priority: event.target.value as BacklogFilters['priority'] })}><option value="any">Any</option><option value="urgent">Urgent</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
      <label className="boards-backlog-select">Dependencies <select value={filters.hasOpenDeps} onChange={event => update({ hasOpenDeps: event.target.value as BacklogFilters['hasOpenDeps'] })}><option value="any">Any</option><option value="yes">Has open dependencies</option><option value="no">No open dependencies</option></select></label>
      <label className="boards-backlog-select boards-backlog-sort">Sort <select value={filters.sort} onChange={event => update({ sort: event.target.value as BacklogFilters['sort'] })}><option value="priority">Priority</option><option value="key">Newest</option><option value="updated">Recently updated</option><option value="status">Status</option></select></label>
    </div>
    {activeFilterCount(filters) > 0 && <div className="boards-backlog-active">{chips.map(chip => <button key={chip.key} type="button" className="boards-filter-chip" aria-label={`Remove ${chip.label}`} onClick={chip.remove}>{chip.label} <span aria-hidden="true">×</span></button>)}<button type="button" onClick={() => onChange({ ...DEFAULT_BACKLOG_FILTERS, sort: filters.sort })}>Clear all</button><span className="boards-toolbar-count">{resultCount} of {tickets.length} tickets</span></div>}
  </section>;
}
