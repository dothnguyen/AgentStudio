import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { BoardStatusInfo } from './boardLaneModel';

export function WorkflowStatusFilter({ options, selected, onChange }: { options: readonly BoardStatusInfo[]; selected: string[]; onChange: (values: string[]) => void }): JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = options.filter(option => `${option.name ?? ''} ${option.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeIndex = Math.min(active, matches.length - 1);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, id]);
  const select = (value: string) => {
    if (!selected.includes(value)) onChange([...selected, value]);
    setQuery(''); setActive(0); setOpen(true); input.current?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); setActive(event.key === 'ArrowDown' ? 0 : Math.max(0, matches.length - 1)); }
      else if (matches.length) setActive(event.key === 'ArrowDown' ? (activeIndex + 1) % matches.length : (activeIndex - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter' || (event.key === ' ' && (() => {
      if (!open || !query) return true;
      const start = event.currentTarget.selectionStart ?? query.length;
      const end = event.currentTarget.selectionEnd ?? start;
      const extended = (query.slice(0, start) + ' ' + query.slice(end)).toLowerCase();
      return !options.some(option => (option.name ?? '').toLowerCase().includes(extended) || option.id.toLowerCase().includes(extended));
    })())) {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (matches[activeIndex]) select(matches[activeIndex].id);
    }
  };
  return <div ref={root} className="boards-workflow-filter" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label htmlFor={`${id}-input`}>Workflow status</label>
    <div className="boards-workflow-control">
      <div className="boards-workflow-inputs">
        {Array.from(new Set(selected)).map(value => <span className="boards-workflow-tag" key={value}>
          <span>{options.find(option => option.id === value)?.name?.trim() || value}</span>
          <button type="button" aria-label={`Remove workflow status: ${options.find(option => option.id === value)?.name?.trim() || value}`} onClick={() => { onChange(selected.filter(item => item !== value)); input.current?.focus(); }}>×</button>
        </span>)}
        <input ref={input} id={`${id}-input`} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} placeholder={selected.length ? 'Add status' : 'All statuses'} value={query} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={keyDown} />
      </div>
      {open && <div className="boards-workflow-popup">
        <div id={`${id}-list`} role="listbox" aria-label="Workflow status options" aria-multiselectable="true">
          {matches.map((option, index) => <div id={`${id}-option-${index}`} key={option.id} role="option" aria-selected={selected.includes(option.id)} className={index === activeIndex ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => select(option.id)}>{option.name?.trim() || option.id}{selected.includes(option.id) && <span aria-hidden="true"> ✓</span>}</div>)}
        </div>
        {matches.length === 0 && <div className="boards-workflow-empty" role="status">No matching statuses</div>}
      </div>}
    </div>
    <span className="visually-hidden" aria-live="polite">{selected.length} workflow statuses selected</span>
  </div>;
}
