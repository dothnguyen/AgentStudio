import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import type { BoardSettings, ManagementError, Problem, RoleCatalogItem } from '../../shared/management';
import { statusLabel } from './routingViewModel';

export interface RoutingOption { value: string; label: string; disabled?: boolean }

export function problemsAt(problems: Problem[], path: string): Problem[] {
  return problems.filter(problem => problem.path === path);
}

export function statusOptions(settings: BoardSettings): RoutingOption[] {
  return settings.statuses.map(status => ({ value: status.id, label: statusLabel(settings.statuses, status.id) }));
}

export function roleOptions(settings: BoardSettings, roleItems: RoleCatalogItem[] | null, current: string): RoutingOption[] {
  const options: RoutingOption[] = settings.roles.items.map(role => {
    const label = roleItems?.find(item => item.id === role.id)?.name?.trim();
    return { value: role.id, label: label || role.id };
  });
  if (current !== '' && !options.some(option => option.value === current)) {
    options.push({ value: current, label: current, disabled: true });
  }
  return options;
}

export function workflowOptions(settings: BoardSettings, current: string): RoutingOption[] {
  const options = settings.workflows.map(workflow => ({
    value: workflow.name,
    label: workflow.errors.length > 0 ? `${workflow.name} — unavailable` : workflow.name,
    disabled: workflow.errors.length > 0,
  }));
  if (current !== '' && !options.some(option => option.value === current)) {
    options.push({ value: current, label: `${current} — unavailable`, disabled: true });
  }
  return options;
}

export function workspaceOptions(current: string): RoutingOption[] {
  const options: RoutingOption[] = [
    { value: 'worktree', label: 'Isolated worktree' },
    { value: 'main', label: 'Main workspace' },
    { value: 'none', label: 'No workspace' },
  ];
  // '' means the rule does not set a workspace ("Default" in older boards).
  if (current === '') options.unshift({ value: '', label: 'Default' });
  return options;
}

export interface RoutingDialogFieldProps {
  id: string;
  label: string;
  value: string;
  options: RoutingOption[];
  onChange(value: string): void;
  disabled?: boolean;
  problems?: Problem[];
  hint?: string;
  mono?: boolean;
}

export function RoutingDialogSelect(props: RoutingDialogFieldProps): JSX.Element {
  const { id, label, value, options, onChange, disabled = false, problems = [], hint, mono = false } = props;
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = problems.length > 0 ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return <div className="routing-dialog-field">
    <label className="routing-dialog-label" htmlFor={id}>{label}</label>
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-invalid={problems.length > 0 ? 'true' : undefined}
      aria-describedby={describedBy}
      className={mono ? 'routing-dialog-mono' : undefined}
      onChange={event => onChange(event.target.value)}
    >
      {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {hint !== undefined && <span id={hintId} className="routing-dialog-hint">{hint}</span>}
    <RoutingDialogProblemText id={errorId} problems={problems} />
  </div>;
}

export function RoutingDialogProblemText({ id, problems }: { id?: string; problems: Problem[] }): JSX.Element | null {
  if (problems.length === 0) return null;
  return <span id={id} className="routing-dialog-problem">{problems.map((problem, index) => <span key={`${index}-${problem.path}`}>{problem.path}: {problem.message}</span>)}</span>;
}

export function RoutingDialogSummary({ problems, alert = true }: { problems: Problem[]; alert?: boolean }): JSX.Element | null {
  if (problems.length === 0) return null;
  return <div role={alert ? 'alert' : undefined} className="routing-dialog-summary">
    {problems.map((problem, index) => <p key={`${index}-${problem.path}`}>{problem.path}: {problem.message}</p>)}
  </div>;
}

export interface RoutingDialogFailureProps {
  error: ManagementError | null;
  reloadError: ManagementError | null;
  pending: boolean;
  connected: boolean;
  alert?: boolean;
  onReloadLatest(): void;
  onRetryLatest(): void;
}

/** The conflict, invalid-config and reload failure messages shown inside a routing dialog. */
export function RoutingDialogFailure({ error, reloadError, pending, connected, alert = true, onReloadLatest, onRetryLatest }: RoutingDialogFailureProps): JSX.Element | null {
  const conflictRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error?.code === 'CONFIG_CHANGED') conflictRef.current?.focus();
  }, [error]);
  if (error === null && reloadError === null) return null;
  return <div className="routing-dialog-failure" role={alert ? 'alert' : undefined}>
    {error !== null && <>
      <p><strong>{error.code}: {error.message}</strong></p>
      <p>{error.remediation || (error.code === 'CONFIG_CHANGED' ? 'Reload the latest settings before saving your changes.' : 'Review your changes and try saving again; if the problem persists, check the Agent Studio connection.')}</p>
    </>}
    {reloadError !== null && <p>Reload failed: {reloadError.code}: {reloadError.message}</p>}
    {reloadError !== null && <p>{reloadError.remediation || 'Retry loading the latest settings; if it keeps failing, check the Agent Studio connection.'}</p>}
    {error?.code === 'CONFIG_CHANGED' && <button ref={conflictRef} type="button" data-focus="conflict" disabled={pending || !connected} onClick={onReloadLatest}>Reload latest</button>}
    {reloadError !== null && <button type="button" data-focus="reload-retry" disabled={pending || !connected} onClick={onRetryLatest}>Retry latest settings</button>}
  </div>;
}

export function RoutingDialogSection({ title, children, divided = true }: { title: string; children: ReactNode; divided?: boolean }): JSX.Element {
  return <div className={['routing-dialog-section', divided ? 'is-divided' : ''].filter(Boolean).join(' ')}>
    <h3>{title}</h3>
    {children}
  </div>;
}
