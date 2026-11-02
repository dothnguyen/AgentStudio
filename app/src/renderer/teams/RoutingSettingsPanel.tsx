import { useEffect, useRef, useState, type JSX } from 'react';
import type { BoardSettings, ManagementApi, ManagementError, Problem, RoleCatalogItem, TeamOverview } from '../../shared/management';
import { RoutingReadView, type RoutingTeamsState } from './RoutingReadView';
import type { DashboardSectionController } from '../dashboard/useDashboardSection';
import {
  addRule,
  addWorkflowStatus,
  updateWorkflowStatus,
  removeWorkflowStatus,
  moveWorkflowStatus,
  boardSettingsChanges,
  createRoutingDraft,
  errorProblems,
  isActionRule,
  isRuleFieldProblem,
  removeRule,
  ruleStatus,
  unusedStatuses,
  validateRoutingDraft,
  type RoutingDraft,
} from './routingSettingsModel';
import { statusName } from './routingViewModel';
import { RoutingRuleDialog } from './RoutingRuleDialog';
import { RoutingRemoveRuleDialog } from './RoutingRemoveRuleDialog';
import { Dialog } from './Dialog';
import { RoutingDialogFailure, RoutingDialogProblemText, RoutingDialogSummary, problemsAt } from './RoutingDialogParts';
import { RoutingWorktreesDialog } from './RoutingWorktreesDialog';

export interface RoutingSettingsPanelProps { workspaceId: string; management: ManagementApi; section: DashboardSectionController<BoardSettings>; connected: boolean; alert?: boolean; announce?: boolean; onLocalErrorChange?(active: boolean): void; roleItems?: RoleCatalogItem[] | null; onViewRole?(roleId: string): void; teams?: TeamOverview | null; teamsState?: RoutingTeamsState; onOpenTeam?(teamId: string | null): void; onOpenTeams?(): void }

type DialogState =
  | { kind: 'edit' | 'add'; settings: BoardSettings; index: number; draft: RoutingDraft }
  | { kind: 'remove'; settings: BoardSettings; index: number; draft: RoutingDraft; problems: Problem[] }
  | { kind: 'statuses'; settings: BoardSettings; draft: RoutingDraft }
  | { kind: 'worktrees'; settings: BoardSettings; draft: RoutingDraft };

type FocusTarget = { kind: 'rule'; index: number } | { kind: 'add' } | { kind: 'worktrees' };

export function RoutingSettingsPanel({ workspaceId, management, section, connected, alert = true, announce = true, onLocalErrorChange, roleItems = null, onViewRole, teams = null, teamsState, onOpenTeam, onOpenTeams }: RoutingSettingsPanelProps): JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pending, setPending] = useState(false); const lock = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ManagementError | null>(null); const [notice, setNotice] = useState('');
  const [reloadError, setReloadError] = useState<ManagementError | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const lastSettings = useRef<BoardSettings | null>(null);
  if (section.data) lastSettings.current = section.data;
  const settings = section.data ?? lastSettings.current;
  const fresh = section.data !== null && section.error === null && !section.loading;
  const baseDraft = settings ? createRoutingDraft(settings) : null;
  const freeStatuses = baseDraft && settings ? unusedStatuses(baseDraft, settings) : [];
  const hasFreeStatus = baseDraft === null || freeStatuses.length > 0;

  const editReason = ((): string | null => {
    if (pending) return 'A save is in progress.';
    if (!connected) return 'Editing is unavailable while disconnected from the backend.';
    if (!fresh) return 'Routing settings are not up to date. Refresh them before editing.';
    if (!settings) return 'Routing settings are unavailable.';
    if (settings.board.state !== 'ok') return 'The workspace board configuration is not available.';
    if (settings.roles.state !== 'ok') return 'The workspace roles are not available.';
    if (!settings.board.sha256 || !settings.roles.sha256) return 'The settings concurrency token is missing; refresh and retry.';
    if (baseDraft === null) return 'The routing rules are not editable.';
    return null;
  })();
  const canEdit = editReason === null;

  const dialogProblems = ((): Problem[] => {
    if (dialog === null) return [];
    if (dialog.kind === 'remove') {
      return [...dialog.problems, ...(error?.code === 'BOARD_CONFIG_INVALID' ? errorProblems(error) : [])];
    }
    const client = validateRoutingDraft(dialog.draft, dialog.settings);
    const server = error?.code === 'BOARD_CONFIG_INVALID' ? errorProblems(error) : [];
    return [...client, ...server];
  })();
  const summaryProblems = ((): Problem[] => {
    if (dialog === null) return [];
    if (dialog.kind === 'remove') return dialogProblems;
    if (dialog.kind === 'statuses') return dialogProblems.filter(problem => !/^(workflowStatuses|todoEntry|todoDefault)/.test(problem.path));
    if (dialog.kind === 'worktrees') return dialogProblems.filter(problem => problem.path !== 'baseBranch');
    const rule = dialog.draft.rules[dialog.index];
    const agent = !isActionRule(rule);
    return dialogProblems.filter(problem => !isRuleFieldProblem(problem.path, dialog.index, agent, dialog.kind === 'add'));
  })();
  const localAlert = !!(reloadError || error || summaryProblems.length > 0);
  useEffect(() => { onLocalErrorChange?.(localAlert); return () => onLocalErrorChange?.(false); }, [localAlert, onLocalErrorChange]);

  function requestFocus(target: FocusTarget): void { setFocusTarget(target); }
  useEffect(() => {
    if (focusTarget === null) return;
    const selector = focusTarget.kind === 'rule' ? `[data-focus-rule="${focusTarget.index}"]`
      : focusTarget.kind === 'add' ? 'button[aria-label="Add rule"]'
        : 'button[aria-label="Edit worktrees"]';
    const element = rootRef.current?.querySelector<HTMLElement>(selector);
    if (!element) return;
    element.focus();
    setFocusTarget(null);
  }, [focusTarget, dialog, settings]);

  async function refreshLatest(): Promise<boolean> {
    try {
      if (section.reloadFresh) {
        const result = await section.reloadFresh();
        if (!result.ok) { setReloadError(result.error); return false; }
      } else { await section.reload(); }
      setReloadError(null); return true;
    } catch (reason) {
      setReloadError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false });
      return false;
    }
  }

  function openDialog(next: DialogState): void {
    setDialog(next); setError(null); setReloadError(null); setSaved(false); setNotice('');
  }

  function openEdit(index: number): void {
    if (!canEdit || settings === null) return;
    const snapshot = settings; const draft = createRoutingDraft(snapshot);
    if (draft === null) return;
    openDialog({ kind: 'edit', settings: snapshot, index, draft });
  }

  function openAdd(): void {
    if (!canEdit || settings === null) return;
    const snapshot = settings; const draft = createRoutingDraft(snapshot);
    if (draft === null) return;
    const free = unusedStatuses(draft, snapshot);
    if (free.length === 0) return;
    const next = addRule(draft, snapshot, free[0]!, 'agent');
    openDialog({ kind: 'add', settings: snapshot, index: next.rules.length - 1, draft: next });
  }

  function openWorktrees(): void {
    if (!canEdit || settings === null) return;
    const snapshot = settings; const draft = createRoutingDraft(snapshot);
    if (draft === null) return;
    openDialog({ kind: 'worktrees', settings: snapshot, draft });
  }

  function openRemove(): void {
    if (dialog === null || dialog.kind !== 'edit') return;
    openDialog({ kind: 'remove', settings: dialog.settings, index: dialog.index, draft: dialog.draft, problems: [] });
  }

  function changeDraft(draft: RoutingDraft): void {
    setDialog(current => current !== null && current.kind !== 'remove' ? { ...current, draft } : current);
    setError(current => current?.code === 'CONFIG_CHANGED' ? current : null);
    setNotice('');
  }

  function closeDialog(): void {
    const current = dialog;
    setDialog(null); setError(null); setReloadError(null); setSaved(false); setNotice('');
    if (current === null) return;
    requestFocus(current.kind === 'remove' ? { kind: 'rule', index: current.index } : current.kind === 'edit' ? { kind: 'rule', index: current.index } : current.kind === 'add' ? { kind: 'add' } : { kind: 'worktrees' });
  }

  function successText(current: DialogState): string {
    if (current.kind === 'edit') return `Saved rule ${current.index + 1}.`;
    if (current.kind === 'add') return `Added a rule for ${statusName(current.settings.statuses, ruleStatus(current.draft.rules[current.index]) ?? '')}.`;
    if (current.kind === 'remove') return `Removed the rule for ${statusName(current.settings.statuses, ruleStatus(current.draft.rules[current.index]) ?? '')}.`;
    return current.kind === 'statuses' ? 'Saved workflow settings.' : 'Saved base branch.';
  }

  function successFocus(current: DialogState): FocusTarget {
    if (current.kind === 'edit' || current.kind === 'add') return { kind: 'rule', index: current.index };
    if (current.kind === 'remove') return { kind: 'add' };
    return { kind: 'worktrees' };
  }

  async function reloadDialog(): Promise<void> {
    if (lock.current) return;
    const current = dialog;
    lock.current = true; setPending(true);
    try {
      if (await refreshLatest()) {
        const text = current !== null && saved ? successText(current) : '';
        const target = current === null ? null : saved ? successFocus(current) : current.kind === 'remove' ? { kind: 'rule' as const, index: current.index } : current.kind === 'edit' ? { kind: 'rule' as const, index: current.index } : current.kind === 'add' ? { kind: 'add' as const } : { kind: 'worktrees' as const };
        setDialog(null); setSaved(false); setError(null); setReloadError(null); setNotice(text);
        if (target !== null) requestFocus(target);
      }
    } catch (reason) {
      setReloadError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false });
    } finally {
      lock.current = false; setPending(false);
    }
  }

  async function save(): Promise<void> {
    if (lock.current || dialog === null || dialog.kind === 'remove' || !canEdit) return;
    const current = dialog; const snapshot = current.settings;
    if (validateRoutingDraft(current.draft, snapshot).length > 0) return;
    const changes = boardSettingsChanges(current.draft, snapshot);
    if (changes === null) return;
    lock.current = true; setPending(true); setError(null); setNotice('');
    try {
      const result = await management.updateBoardSettings(workspaceId, changes, snapshot.board.sha256!);
      if (!result.ok) { setError(result.error); return; }
      setSaved(true);
      if (await refreshLatest()) {
        const text = successText(current); const target = successFocus(current);
        setDialog(null); setSaved(false); setError(null); setReloadError(null); setNotice(text); requestFocus(target);
      }
    } catch (reason) {
      setError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false });
    } finally {
      lock.current = false; setPending(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (lock.current || dialog === null || dialog.kind !== 'remove' || !canEdit) return;
    const current = dialog; const snapshot = current.settings;
    const candidate = removeRule(current.draft, current.index, snapshot);
    const problems = validateRoutingDraft(candidate, snapshot);
    if (problems.length > 0) { setDialog({ ...current, problems }); setNotice(''); return; }
    const changes = boardSettingsChanges(candidate, snapshot);
    if (changes === null) return;
    lock.current = true; setPending(true); setError(null); setNotice('');
    try {
      const result = await management.updateBoardSettings(workspaceId, changes, snapshot.board.sha256!);
      if (!result.ok) { setError(result.error); return; }
      setSaved(true);
      if (await refreshLatest()) {
        const text = successText(current);
        setDialog(null); setSaved(false); setError(null); setReloadError(null); setNotice(text); requestFocus({ kind: 'add' });
      }
    } catch (reason) {
      setError({ code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false });
    } finally {
      lock.current = false; setPending(false);
    }
  }

  const failureAlert = alert;
  return <section ref={rootRef} tabIndex={-1} className="routing-settings" aria-label="Workspace board routing">
    {section.loading && <p className="panel-loading" role={announce ? 'status' : undefined}>{settings ? 'Refreshing routing settings… Showing previously loaded data.' : 'Loading settings…'}</p>}
    {section.error && <div className="panel-error" role={alert && !localAlert ? 'alert' : undefined}>{settings && <p>Showing previously loaded data.</p>}<p>{section.error.code}: {section.error.message}</p><p>{section.error.remediation || 'Retry loading routing settings; if it keeps failing, check the Agent Studio connection.'}</p><button type="button" data-focus="section-retry" onClick={() => void (async () => { const result = section.reloadFresh ? await section.reloadFresh() : (await section.reload(), null); if (result?.ok === false) { rootRef.current?.querySelector<HTMLElement>('[data-focus="section-retry"]')?.focus(); } else { rootRef.current?.focus(); } })()}>Retry</button></div>}
    {!connected && settings && <p className="panel-note">Disconnected from the backend. Routing is read-only until the connection returns.</p>}
    {settings && (section.error !== null || section.data === null) && <p className="panel-note">Showing the last loaded routing; it may be out of date.</p>}
    {settings && <>
      {roleItems === null && <p className="panel-note">Role names are unavailable; rules show stable role ids.</p>}
      {notice && <p role={announce && !section.loading ? 'status' : undefined}>{notice}</p>}
      {settings.board.config?.version === 3 && <section className="routing-dialog-section">
        <h2>Workflow statuses</h2>
        <ul>{settings.workflowStatuses.map(status => <li key={status.id}>{status.id} — {status.name || status.id} — {status.kind || 'No kind'}</li>)}</ul>
        <p>Todo entry: {settings.todoEntry.join(', ') || 'None'}; default: {settings.todoDefault || 'None'}</p>
        <button type="button" disabled={!canEdit} onClick={() => { if (baseDraft) openDialog({ kind: 'statuses', settings, draft: baseDraft }); }}>Edit workflow statuses and Todo entry</button>
      </section>}
      <RoutingReadView
        settings={settings}
        roleItems={roleItems}
        teams={teams}
        teamsState={teamsState}
        onViewRole={onViewRole}
        onOpenTeam={onOpenTeam}
        onOpenTeams={onOpenTeams}
        canEdit={canEdit}
        pending={pending}
        editReason={editReason}
        hasFreeStatus={hasFreeStatus}
        onEditRule={openEdit}
        onAddRule={openAdd}
        onEditWorktrees={openWorktrees}
      />
      {dialog !== null && (dialog.kind === 'edit' || dialog.kind === 'add') && <RoutingRuleDialog
        mode={dialog.kind === 'add' ? 'add' : 'edit'}
        settings={dialog.settings}
        draft={dialog.draft}
        index={dialog.index}
        problems={dialogProblems}
        pending={pending}
        saved={saved}
        editable={canEdit}
        connected={connected}
        roleItems={roleItems}
        error={error}
        reloadError={reloadError}
        alert={failureAlert}
        onDraftChange={changeDraft}
        onSave={() => void save()}
        onRemove={dialog.kind === 'edit' ? openRemove : undefined}
        onClose={closeDialog}
        onReloadLatest={() => void reloadDialog()}
        onRetryLatest={() => void reloadDialog()}
      />}
      {dialog !== null && dialog.kind === 'statuses' && <Dialog title="Workflow statuses" onClose={closeDialog} busy={pending || saved} actions={[{ label: 'Cancel', onClick: closeDialog }, { label: 'Save workflow settings', variant: 'primary', disabled: !canEdit || pending || saved || error?.code === 'CONFIG_CHANGED' || dialogProblems.length > 0 || boardSettingsChanges(dialog.draft, dialog.settings) === null, onClick: () => void save() }]}>
        <RoutingDialogFailure error={error} reloadError={reloadError} pending={pending} connected={connected} alert={alert} onReloadLatest={() => void reloadDialog()} onRetryLatest={() => void reloadDialog()} />
        <RoutingDialogSummary problems={summaryProblems} />
        <RoutingDialogProblemText problems={problemsAt(dialogProblems, 'workflowStatuses')} />
        {dialog.draft.workflowStatuses.map((status, i) => <div key={i} className="routing-dialog-grid">
          {(['id', 'name'] as const).map(field => <label key={field}>{field === 'id' ? 'ID' : 'Name'}<input value={typeof status[field] === 'string' ? status[field] as string : ''} disabled={!canEdit || pending || saved} onChange={event => changeDraft(updateWorkflowStatus(dialog.draft, i, field, event.target.value))} /><RoutingDialogProblemText problems={problemsAt(dialogProblems, `workflowStatuses[${i}].${field}`)} /></label>)}
          <label>Kind<select value={typeof status.kind === 'string' ? status.kind : ''} disabled={!canEdit || pending || saved} onChange={event => changeDraft(updateWorkflowStatus(dialog.draft, i, 'kind', event.target.value))}><option value="">None</option><option value="initial">Initial</option><option value="done">Done</option><option value="closed">Closed</option></select><RoutingDialogProblemText problems={problemsAt(dialogProblems, `workflowStatuses[${i}].kind`)} /></label>
          <RoutingDialogProblemText problems={problemsAt(dialogProblems, `workflowStatuses[${i}]`)} />
          <button type="button" disabled={!canEdit || pending || saved || i === 0} onClick={() => changeDraft(moveWorkflowStatus(dialog.draft, i, -1))}>Move up</button><button type="button" disabled={!canEdit || pending || saved || i === dialog.draft.workflowStatuses.length - 1} onClick={() => changeDraft(moveWorkflowStatus(dialog.draft, i, 1))}>Move down</button><button type="button" disabled={!canEdit || pending || saved} onClick={() => changeDraft(removeWorkflowStatus(dialog.draft, i))}>Remove</button>
        </div>)}
        <button type="button" disabled={!canEdit || pending || saved} onClick={() => changeDraft(addWorkflowStatus(dialog.draft))}>Add status</button>
        <h3>Todo entry</h3>
        {dialog.draft.rules.filter(rule => !isActionRule(rule)).map(rule => ruleStatus(rule)).filter((status): status is string => status !== null).map(status => <label key={status}><input type="checkbox" checked={dialog.draft.todoEntry.includes(status)} disabled={!canEdit || pending || saved} onChange={event => { const todoEntry = event.target.checked ? [...dialog.draft.todoEntry, status] : dialog.draft.todoEntry.filter(value => value !== status); changeDraft({ ...dialog.draft, todoEntry, todoDefault: todoEntry.includes(dialog.draft.todoDefault ?? '') ? dialog.draft.todoDefault : todoEntry[0] ?? null }); }} />{statusName(dialog.settings.statuses, status)}</label>)}
        <RoutingDialogProblemText problems={dialogProblems.filter(problem => /^todoEntry(?:\[|$)/.test(problem.path))} />
        <label>Default<select value={dialog.draft.todoDefault ?? ''} disabled={!canEdit || pending || saved} onChange={event => changeDraft({ ...dialog.draft, todoDefault: event.target.value || null })}><option value="">Choose a default</option>{dialog.draft.todoEntry.map(status => <option key={status} value={status}>{statusName(dialog.settings.statuses, status)}</option>)}</select><RoutingDialogProblemText problems={problemsAt(dialogProblems, 'todoDefault')} /></label>
      </Dialog>}
      {dialog !== null && dialog.kind === 'worktrees' && <RoutingWorktreesDialog
        settings={dialog.settings}
        draft={dialog.draft}
        problems={dialogProblems}
        pending={pending}
        saved={saved}
        editable={canEdit}
        connected={connected}
        error={error}
        reloadError={reloadError}
        alert={failureAlert}
        onDraftChange={changeDraft}
        onSave={() => void save()}
        onClose={closeDialog}
        onReloadLatest={() => void reloadDialog()}
        onRetryLatest={() => void reloadDialog()}
      />}
      {dialog !== null && dialog.kind === 'remove' && <RoutingRemoveRuleDialog
        statusName={statusName(dialog.settings.statuses, ruleStatus(dialog.draft.rules[dialog.index]) ?? '')}
        problems={dialogProblems}
        pending={pending}
        saved={saved}
        editable={canEdit}
        connected={connected}
        error={error}
        reloadError={reloadError}
        alert={failureAlert}
        onConfirm={() => void confirmRemove()}
        onClose={closeDialog}
        onReloadLatest={() => void reloadDialog()}
        onRetryLatest={() => void reloadDialog()}
      />}
    </>}
  </section>;
}
