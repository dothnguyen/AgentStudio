import type { JSX } from 'react';
import type { BoardSettings, Problem } from '../../shared/management';
import type { EditableRuleField, RoutingDraft } from './routingSettingsModel';
export interface RoutingEditFormProps { draft: RoutingDraft; settings: BoardSettings; problems: Problem[]; pending: boolean; connected: boolean; locked: boolean; canEdit: boolean; conflict: boolean; onChange(index: number, field: EditableRuleField, value: string): void; onBaseBranchChange(value: string): void; onSubmit(): void; onCancel(): void }
const modes: Record<string, string> = { '': 'Default', main: 'Main workspace', worktree: 'Isolated worktree', none: 'No workspace' };
const val = (v: unknown) => typeof v === 'string' ? v : '';
export function RoutingEditForm({ draft, settings, problems, pending, connected, locked, canEdit, conflict, onChange, onBaseBranchChange, onSubmit, onCancel }: RoutingEditFormProps): JSX.Element {
  function field(index: number, name: EditableRuleField, label: string, value: string, options: Array<{ value: string; label: string; disabled?: boolean }>) {
    const path = `rules[${index}].${name === 'status' ? 'when.status' : name}`; const matches = problems.filter(p => p.path === path); const id = `routing-${index}-${name}`;
    return <label htmlFor={id}>{label}<select id={id} value={value} disabled={pending || !connected || locked} aria-invalid={matches.length > 0} aria-describedby={matches.length ? `${id}-error` : undefined} onChange={e => onChange(index, name, e.target.value)}>{options.map(o => <option key={o.value} value={o.value} disabled={o.disabled && o.value !== value}>{o.label}</option>)}</select>{matches.length > 0 && <span id={`${id}-error`} className="routing-problem">{matches.map(p => <span key={p.message}>{path}: {p.message}</span>)}</span>}</label>;
  }
  const statusOptions = settings.statuses.map(s => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id })) ?? [];
  const summaryProblems = problems.filter(p => {
    if (p.path === 'baseBranch') return false;
    const match = /^rules\[(\d+)\]\.(when\.status|role|workflow|workspace|onPass|onFail|onBlocked)$/.exec(p.path);
    if (!match || !draft?.rules[Number(match[1])]) return true;
    return ['role', 'workflow', 'workspace', 'onBlocked'].includes(match[2]) && draft.rules[Number(match[1])].type !== 'agent';
  });
  return <form onSubmit={e => { e.preventDefault(); onSubmit(); }}>
        <label htmlFor="routing-base">Base branch<input id="routing-base" value={draft.baseBranch} disabled={pending || !connected || locked} aria-invalid={problems.some(p => p.path === 'baseBranch')} aria-describedby={problems.some(p => p.path === 'baseBranch') ? 'routing-base-error' : undefined} onChange={e => onBaseBranchChange(e.target.value)} /></label>
        {problems.filter(p => p.path === 'baseBranch').map(p => <p id="routing-base-error" className="routing-problem" key={p.message}>{p.path}: {p.message}</p>)}
        <div className="routing-rule-grid">{draft.rules.map((r, i) => { const when = r.when && typeof r.when === 'object' ? r.when as Record<string, unknown> : {}; return <fieldset key={i}><legend>Rule {i + 1} — {val(r.type)}</legend>
          {field(i, 'status', 'Source status', val(when.status), statusOptions)}
          {r.type === 'agent' ? <>{field(i, 'role', 'Role', val(r.role), settings.roles.items.map(x => ({ value: x.id, label: x.id })))}{field(i, 'workflow', 'Workflow', val(r.workflow), settings.workflows.map(x => ({ value: x.name, label: `${x.name}${x.errors.length ? ' — unavailable' : ''}`, disabled: !!x.errors.length })))}{field(i, 'workspace', 'Workspace', val(r.workspace), Object.entries(modes).map(([value, label]) => ({ value, label })))}</> : <p>Action: {val(r.action)}</p>}
          {field(i, 'onPass', 'Pass status', val(r.onPass), statusOptions)}{field(i, 'onFail', 'Fail status', val(r.onFail), statusOptions)}{r.type === 'agent' && field(i, 'onBlocked', 'Blocked status', val(r.onBlocked), [{ value: '', label: 'None' }, ...statusOptions])}
        </fieldset>; })}</div>
        {summaryProblems.length > 0 && <div role="alert" className="routing-problem">{summaryProblems.map((p, i) => <p key={i}>{p.path}: {p.message}</p>)}</div>}
        <button type="submit" disabled={!canEdit || pending || locked || problems.length > 0 || conflict}>Save</button> <button type="button" disabled={pending || locked} onClick={onCancel}>Cancel</button>
      </form>;
}
