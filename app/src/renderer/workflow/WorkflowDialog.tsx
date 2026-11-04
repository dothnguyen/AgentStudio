import { useRef, useState, type JSX, type ReactNode } from 'react';
import type { BoardSettings, BoardStatuses, BoardWorkflowDetail, BoardWorkflows, ManagementApi, ManagementError, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { Dialog } from '../teams/Dialog';
import { SectionError } from '../teams/SectionError';
import { draftToSave, statusOptions, targetStatusOptions, type WorkflowDraft } from './workflowDraftModel';
import './workflowEditDialog.css';

type Obj = Record<string, unknown>;
type Status = BoardStatuses['statuses'][number];
type Workflow = BoardWorkflows['workflows'][number];
type Problem = { path: string; message: string };
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const statusOf = (value: unknown): string => typeof value === 'string' ? value : typeof obj(value).status === 'string' ? String(obj(value).status) : '';
const statusName = (statuses: readonly Status[], id: unknown): string => {
  const text = typeof id === 'string' ? id : '';
  return statuses.find(status => status.id === text)?.name || text;
};

function errorProblems(error: ManagementError): Problem[] {
  const data = error.data as { problems?: unknown } | null;
  if (!Array.isArray(data?.problems)) return [];
  return data.problems.flatMap(item => {
    const value = obj(item);
    return typeof value.path === 'string' && typeof value.message === 'string' ? [{ path: value.path, message: value.message }] : [];
  });
}

/** Workflow neighbours on the pass path, from the routing card model's workflow data. */
export function workflowNeighbours(workflows: readonly Workflow[], name: string): { before: string[]; after: string[] } {
  const current = workflows.find(workflow => workflow.name === name);
  if (!current) return { before: [], after: [] };
  const label = (workflow: Workflow) => workflow.title || workflow.name;
  const before = workflows.filter(workflow => workflow.name !== name && statusOf(workflow.end.pass) === current.startsAt).map(label);
  const after = workflows.filter(workflow => workflow.name !== name && workflow.startsAt === statusOf(current.end.pass)).map(label);
  return { before, after };
}

/** The reason Delete workflow cannot run yet, or null when it can. */
export function workflowDeleteReason(draft: WorkflowDraft, statuses: readonly Status[]): string | null {
  if (!draft.expectedSha256) return 'The workflow has not been loaded from the board yet.';
  const running = statuses.find(status => status.id === draft.definition.whileRunning);
  if (running && running.ticketCount > 0) return `Tickets are in ${running.name || running.id}`;
  return null;
}

export interface WorkflowDialogProps {
  workspace: Workspace;
  management: ManagementApi;
  draft: WorkflowDraft;
  onClose(): void;
  onSaved?(detail: BoardWorkflowDetail): void;
  onDeleted?(name: string): void;
  onManageStatuses?(): void;
  onDraftChange?(draft: WorkflowDraft): void;
}

export function WorkflowDialog({ workspace, management, draft: initialDraft, onClose, onSaved, onDeleted, onManageStatuses, onDraftChange }: WorkflowDialogProps): JSX.Element {
  const statuses = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const workflows = useDashboardSection<BoardWorkflows>(management.boardWorkflows, workspace.id);
  const board = useDashboardSection<BoardSettings>(management.boardSettings, workspace.id);
  const [draft, setDraft] = useState<WorkflowDraft>(initialDraft);
  const initial = useRef(JSON.stringify(initialDraft));
  const [problems, setProblems] = useState<Problem[]>(initialDraft.problems.map(problem => ({ path: problem.path, message: problem.message })));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const definition = draft.definition;
  const end = obj(definition.end);
  const limits = obj(definition.limits);
  const statusList = statuses.data?.statuses ?? [];
  const workflowList = workflows.data?.workflows ?? [];
  const roles = board.data?.roles.items ?? [];
  const boardSha = board.data?.board.sha256 ?? null;
  const title = String(definition.title ?? '') || draft.name;
  const startsAt = String(definition.startsAt ?? '');
  const whileRunning = String(definition.whileRunning ?? '');
  const workspaceMode = String(definition.workspace ?? 'main');
  const role = typeof definition.role === 'string' ? definition.role : '';
  const failure = obj(limits.failuresInARow);
  const createdTickets = typeof definition.createdTickets === 'string' ? definition.createdTickets : '';
  const pass = statusOf(end.pass);
  const fail = statusOf(end.fail);
  const blocked = obj(end.blocked);
  const release = obj(obj(end.pass).releaseCreatedTickets);
  const neighbours = workflowNeighbours(workflowList, draft.name);
  const deleteReason = statuses.data ? workflowDeleteReason(draft, statusList) : 'Waiting for the board statuses…';
  const dirty = JSON.stringify(draft) !== initial.current;
  const startOptions = statusOptions(statusList, workflowList, draft.name);
  const targetOptions = targetStatusOptions(statusList, workflowList);

  function update(next: WorkflowDraft): void {
    setDraft(next);
    onDraftChange?.(next);
    if (error) setError('');
    if (problems.length) setProblems([]);
  }
  function setField(key: string, value: unknown): void {
    update({ ...draft, definition: { ...definition, [key]: value } });
  }
  function removeField(key: string): void {
    const next = { ...definition }; delete next[key];
    update({ ...draft, definition: next });
  }
  function setEndStatus(key: 'pass' | 'fail', value: string): void {
    const previous = end[key];
    const next = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? { ...obj(previous), status: value } : value;
    update({ ...draft, definition: { ...definition, end: { ...end, [key]: next } } });
  }
  function setBlockedReturn(value: string): void {
    const next: Obj = { ...blocked, ...(value ? { returnTo: value } : {}) };
    if (!value) delete next.returnTo;
    if (!next.status) next.status = 'blocked';
    update({ ...draft, definition: { ...definition, end: { ...end, blocked: next } } });
  }
  function setRelease(field: 'from' | 'to', value: string): void {
    const currentPass: Obj = typeof end.pass === 'object' && end.pass !== null && !Array.isArray(end.pass) ? { ...obj(end.pass) } : { status: pass };
    const nextRelease = { ...obj(currentPass.releaseCreatedTickets) };
    if (value) nextRelease[field] = value; else delete nextRelease[field];
    if (Object.keys(nextRelease).length) currentPass.releaseCreatedTickets = nextRelease; else delete currentPass.releaseCreatedTickets;
    update({ ...draft, definition: { ...definition, end: { ...end, pass: currentPass } } });
  }
  function setLimits(next: Obj): void {
    if (Object.keys(next).length) setField('limits', next); else removeField('limits');
  }
  function setWorkspace(value: string): void {
    const next: WorkflowDraft['definition'] = { ...definition, workspace: value };
    if (value !== 'worktree') { delete next.syncBase; delete next.waitForDependencies; }
    update({ ...draft, definition: next });
  }
  function setStart(key: 'allowed' | 'default', value: boolean): void {
    update({ ...draft, start: key === 'allowed' ? { allowed: value, default: value ? draft.start.default : false } : { ...draft.start, default: value } });
  }
  function fieldProblems(paths: readonly string[]): ReactNode {
    const matches = problems.filter(problem => paths.some(path => problem.path === path || problem.path.startsWith(`${path}.`)));
    return matches.length ? <span className="workflow-dialog-problem" role="alert">{matches.map((problem, index) => <span key={`${problem.path}-${index}`}>{index ? ' ' : ''}{problem.message}</span>)}</span> : null;
  }
  const unmatched = problems.filter(problem => ![
    'title', 'startsAt', 'whileRunning', 'role', 'workspace', 'syncBase', 'waitForDependencies', 'createdTickets',
    'end.pass', 'end.fail', 'end.blocked.returnTo', 'end.pass.releaseCreatedTickets.from',
    'end.pass.releaseCreatedTickets.to', 'limits.maxRuns', 'limits.failuresInARow.count',
    'limits.failuresInARow.status', 'limits.onFailPriority', 'start.allowed', 'start.default',
  ].some(path => problem.path === path || problem.path.startsWith(`${path}.`)));
  function close(): void {
    if (!pending && (!dirty || window.confirm('Discard unsaved workflow changes?'))) onClose();
  }
  async function save(): Promise<void> {
    if (pending || !boardSha) return;
    setPending(true); setError(''); setProblems([]);
    try {
      const result = await management.saveBoardWorkflow(workspace.id, draftToSave({ ...draft, expectedBoardSha256: boardSha }));
      if (result.ok) { initial.current = JSON.stringify(draft); onSaved?.(result.data); onClose(); }
      else {
        const next = errorProblems(result.error);
        setProblems(next);
        setError(next.length ? '' : result.error.message || 'The workflow could not be saved.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(false); }
  }
  async function remove(): Promise<void> {
    if (pending || deleteReason || !draft.expectedSha256) return;
    if (!window.confirm(`Delete workflow "${title}"?`)) return;
    setPending(true); setError('');
    try {
      const result = await management.deleteBoardWorkflow(workspace.id, { name: draft.name, expectedSha256: draft.expectedSha256 });
      if (result.ok) { onDeleted?.(draft.name); onClose(); } else setError(result.error.message || 'The workflow could not be deleted.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(false); }
  }

  return <Dialog
    title={`Edit workflow: ${title}`}
    subtitle={<><code>.agent-studio/workflows/{draft.name}.yaml</code>{neighbours.before.length || neighbours.after.length ? <> · {neighbours.before.join(' / ')}{neighbours.before.length ? ' → ' : ''}<strong>{title}</strong>{neighbours.after.length ? <> → {neighbours.after.join(' / ')}</> : null}</> : null}</>}
    width={820}
    className="workflow-dialog"
    busy={pending}
    onClose={close}
    leadingActions={[{ label: 'Delete workflow', onClick: () => void remove(), disabled: pending || deleteReason !== null, descriptionId: 'workflow-delete-reason', title: deleteReason ?? 'Delete this workflow' }]}
    actions={[{ label: 'Cancel', onClick: close, disabled: pending }, { label: 'Save workflow', variant: 'primary', disabled: pending || !boardSha, onClick: () => void save() }]}
  >
    <span id="workflow-delete-reason" className="sr-only">{deleteReason ?? 'Delete this workflow.'}</span>
    <SectionError section={statuses} label="Statuses" />
    <SectionError section={workflows} label="Workflows" />
    <SectionError section={board} label="Board settings" />
    {error && <p className="workflow-dialog-summary" role="alert">{error}</p>}
    {unmatched.length > 0 && <div className="workflow-dialog-summary" role="alert">{unmatched.map((problem, index) => <p key={`${problem.path}-${index}`}><code>{problem.path}</code>: {problem.message}</p>)}</div>}

    <section className="workflow-dialog-section" data-section="workflow-name">
      <h3>1. Name and statuses</h3>
      <div className="workflow-dialog-grid three">
        <label data-field="title"><span>Name</span><input value={String(definition.title ?? '')} onChange={event => setField('title', event.target.value)} />{fieldProblems(['title'])}</label>
        <label data-field="startsAt"><span>Starts when a ticket is in</span><select value={startsAt} onChange={event => setField('startsAt', event.target.value)}><option value="">Choose a status</option>{startOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['startsAt'])}</label>
        <label data-field="whileRunning"><span>Status while running</span><select value={whileRunning} onChange={event => setField('whileRunning', event.target.value)}><option value="">Choose a status</option>{startOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['whileRunning'])}</label>
      </div>
      <div className="workflow-dialog-note-row"><span>Only statuses no other workflow uses are listed.</span><button type="button" className="workflow-dialog-link" disabled={!onManageStatuses} onClick={onManageStatuses}>Manage statuses →</button></div>
    </section>

    <section className="workflow-dialog-section" data-section="workflow-who">
      <h3>2. Who and where</h3>
      <div className="workflow-dialog-grid two">
        <label data-field="role"><span>Role</span><select value={role} onChange={event => event.target.value ? setField('role', event.target.value) : removeField('role')}><option value="">Automatic (no agent steps)</option>{roles.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}{role && !roles.some(item => item.id === role) ? <option value={role}>{role}</option> : null}</select>{fieldProblems(['role'])}</label>
        <label data-field="workspace"><span>Works in</span><select value={workspaceMode} onChange={event => setWorkspace(event.target.value)}><option value="worktree">Isolated worktree</option><option value="main">Main workspace</option><option value="none">No workspace</option></select>{fieldProblems(['workspace'])}</label>
      </div>
      {workspaceMode === 'worktree' && <div className="workflow-dialog-grid two">
        <label className="workflow-dialog-check" data-field="syncBase"><input type="checkbox" checked={definition.syncBase === true} onChange={event => setField('syncBase', event.target.checked)} /><span>Sync the base branch first</span>{fieldProblems(['syncBase'])}</label>
        <label className="workflow-dialog-check" data-field="waitForDependencies"><input type="checkbox" checked={definition.waitForDependencies === true} onChange={event => setField('waitForDependencies', event.target.checked)} /><span>Wait until its dependencies are done</span>{fieldProblems(['waitForDependencies'])}</label>
      </div>}
      <p className="workflow-dialog-hint">Any free member with the role picks the next ticket; there is no limit on how many run at once.</p>
    </section>

    <section className="workflow-dialog-section" data-section="workflow-steps">
      <div className="workflow-dialog-section-head"><h3>3. Steps</h3><span>Run in order by the same member; the ticket stays in {statusName(statusList, whileRunning) || 'its running status'}.</span></div>
      {definition.steps.length ? <ol className="workflow-dialog-steps" aria-label="Workflow steps">{definition.steps.map((step, index) => <li key={`${step.id}-${index}`}><span className="workflow-step-number">{index + 1}</span><span className={`workflow-step-kind ${step.agent ? 'agent' : step.check ? 'check' : step.action ? 'action' : 'approval'}`}>{step.agent ? 'AGENT' : step.check ? 'CHECK' : step.action ? 'ACTION' : 'APPROVAL'}</span><code>{step.id}</code><span className="workflow-dialog-hint">{step.agent ? step.agent.prompt || 'No prompt yet' : step.check ? `check set ${step.check.checks || '—'}` : step.approval ? step.approval.ask || 'No question yet' : 'merge'}</span></li>)}</ol> : <p className="workflow-dialog-hint">No steps yet. Add them in the steps editor.</p>}
    </section>

    <section className="workflow-dialog-section" data-section="workflow-ends">
      <h3>4. Where it ends</h3>
      <div className="workflow-dialog-table">
        <label data-field="end.pass"><span className="pass">Passes → set status</span><select value={pass} onChange={event => setEndStatus('pass', event.target.value)}><option value="">Choose a status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.pass'])}</label>
        <label data-field="end.fail"><span className="fail">Fails → set status</span><select value={fail} onChange={event => setEndStatus('fail', event.target.value)}><option value="">Choose a status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.fail'])}</label>
        <label data-field="end.blocked.returnTo"><span>Blocked</span><span className="workflow-dialog-inline">Mark blocked; when unblocked go to <select aria-label="Return to" value={typeof blocked.returnTo === 'string' ? blocked.returnTo : ''} onChange={event => setBlockedReturn(event.target.value)}><option value="">Start status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></span>{fieldProblems(['end.blocked.returnTo'])}</label>
      </div>
      <p className="workflow-dialog-hint">Paused runs (usage limit, crash) and cancelled runs go back to {statusName(statusList, startsAt) || 'the start status'} and never count as a fail. A question from the agent waits for your answer and then continues.</p>
      <details className="workflow-dialog-details">
        <summary>Tickets this workflow creates</summary>
        <div>
          <label data-field="createdTickets"><span>New tickets the agent creates wait in</span><select value={createdTickets} onChange={event => event.target.value ? setField('createdTickets', event.target.value) : removeField('createdTickets')}><option value="">— (normal start status)</option>{startOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['createdTickets'])}</label>
          <div className="workflow-dialog-grid two">
            <label data-field="end.pass.releaseCreatedTickets.from"><span>On pass, release tickets this ticket created from</span><select aria-label="Release from" value={typeof release.from === 'string' ? release.from : ''} onChange={event => setRelease('from', event.target.value)}><option value="">—</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.pass.releaseCreatedTickets.from'])}</label>
            <label data-field="end.pass.releaseCreatedTickets.to"><span>to</span><select aria-label="Release to" value={typeof release.to === 'string' ? release.to : ''} onChange={event => setRelease('to', event.target.value)}><option value="">—</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.pass.releaseCreatedTickets.to'])}</label>
          </div>
        </div>
      </details>
    </section>

    <section className="workflow-dialog-section" data-section="workflow-limits">
      <h3>5. Limits</h3>
      <div className="workflow-dialog-grid three">
        <div className="workflow-dialog-card" data-field="limits.maxRuns">
          <label className="workflow-dialog-check"><input type="checkbox" checked={typeof limits.maxRuns === 'number'} onChange={event => { const next = { ...limits }; if (event.target.checked) next.maxRuns = 1; else delete next.maxRuns; setLimits(next); }} /><span>Max runs per ticket</span></label>
          {typeof limits.maxRuns === 'number' ? <label className="workflow-dialog-inline">Block after <input aria-label="Max runs" type="number" min={1} value={limits.maxRuns} onChange={event => setLimits({ ...limits, maxRuns: Math.max(1, Number(event.target.value) || 1) })} /> runs</label> : <span className="workflow-dialog-hint">No run limit.</span>}
          {fieldProblems(['limits.maxRuns'])}
        </div>
        <div className="workflow-dialog-card" data-field="limits.failuresInARow">
          <label className="workflow-dialog-check"><input type="checkbox" checked={typeof failure.count === 'number'} onChange={event => { const next = { ...limits }; if (event.target.checked) next.failuresInARow = { count: 1, status: failure.status || startsAt || '' }; else delete next.failuresInARow; setLimits(next); }} /><span>Escalate repeated fails</span></label>
          {typeof failure.count === 'number' ? <div className="workflow-dialog-limit-row"><label className="workflow-dialog-inline">After <input aria-label="Failures in a row" type="number" min={1} value={failure.count} onChange={event => setLimits({ ...limits, failuresInARow: { ...failure, count: Math.max(1, Number(event.target.value) || 1) } })} /> fails in a row, set</label><select aria-label="Failure status" value={typeof failure.status === 'string' ? failure.status : ''} onChange={event => setLimits({ ...limits, failuresInARow: { ...failure, count: typeof failure.count === 'number' ? failure.count : 1, status: event.target.value } })}><option value="">Choose a status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div> : <span className="workflow-dialog-hint">After N fails in a row, set another status.</span>}
          {fieldProblems(['limits.failuresInARow.count', 'limits.failuresInARow.status'])}
        </div>
        <div className="workflow-dialog-card" data-field="limits.onFailPriority">
          <label className="workflow-dialog-check"><input type="checkbox" checked={typeof limits.onFailPriority === 'number'} onChange={event => { const next = { ...limits }; if (event.target.checked) next.onFailPriority = 0; else delete next.onFailPriority; setLimits(next); }} /><span>Raise priority after a fail</span></label>
          {typeof limits.onFailPriority === 'number' ? <label className="workflow-dialog-inline">Set priority to <input aria-label="Priority after a fail" type="number" min={0} value={limits.onFailPriority} onChange={event => setLimits({ ...limits, onFailPriority: Math.max(0, Number(event.target.value) || 0) })} /></label> : <span className="workflow-dialog-hint">So a failed ticket is picked up first.</span>}
          {fieldProblems(['limits.onFailPriority'])}
        </div>
      </div>
    </section>

    <section className="workflow-dialog-section" data-section="workflow-start">
      <h3>6. Starting here</h3>
      <div className="workflow-dialog-grid two">
        <label className="workflow-dialog-check start" data-field="start.allowed"><input type="checkbox" checked={draft.start.allowed} onChange={event => setStart('allowed', event.target.checked)} /><span><strong>Tickets can start here</strong><small>Offered in Move to Todo.</small></span>{fieldProblems(['start.allowed'])}</label>
        <label className="workflow-dialog-check start" data-field="start.default"><input type="checkbox" checked={draft.start.default} disabled={!draft.start.allowed} onChange={event => setStart('default', event.target.checked)} /><span><strong>Default start</strong><small>Preselected; only one workflow.</small></span>{fieldProblems(['start.default'])}</label>
      </div>
    </section>
  </Dialog>;
}
