import { useRef, useState, type JSX, type ReactNode } from 'react';
import type { BoardSettings, BoardStatuses, BoardWorkflowDetail, BoardWorkflows, CheckSetList, ManagementApi, ManagementError, PromptList, Workspace } from '../api';
import { useDashboardSection } from '../dashboard/useDashboardSection';
import { Dialog } from '../teams/Dialog';
import { SectionError } from '../teams/SectionError';
import {
  addStep, draftToSave, promptOptions, removeStep, renameStep, reorderStep, setRetry, setTarget,
  statusOptions, targetStatusOptions, unreachableStart, updateStep, workflowNameFromTitle,
  type DraftStep, type StepKind, type WorkflowDraft,
} from './workflowDraftModel';
import './workflowEditDialog.css';

type Obj = Record<string, unknown>;
type Status = BoardStatuses['statuses'][number];
type Workflow = BoardWorkflows['workflows'][number];
type Problem = { path: string; message: string };
type NewPrompt = { name: string; source: string };
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const statusOf = (value: unknown): string => typeof value === 'string' ? value : typeof obj(value).status === 'string' ? String(obj(value).status) : '';
const statusName = (statuses: readonly Status[], id: unknown): string => {
  const text = typeof id === 'string' ? id : '';
  return statuses.find(status => status.id === text)?.name || text;
};
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const promptFile = (value: string): string => value && !value.endsWith('.md') ? `${value}.md` : value;
const promptBase = (value: string): string => value.replace(/\.md$/, '');

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
  onOpenPrompt?(name: string): void;
  onDraftChange?(draft: WorkflowDraft): void;
}

export function WorkflowDialog({ workspace, management, draft: initialDraft, onClose, onSaved, onDeleted, onManageStatuses, onOpenPrompt, onDraftChange }: WorkflowDialogProps): JSX.Element {
  const statuses = useDashboardSection<BoardStatuses>(management.boardStatuses, workspace.id);
  const workflows = useDashboardSection<BoardWorkflows>(management.boardWorkflows, workspace.id);
  const board = useDashboardSection<BoardSettings>(management.boardSettings, workspace.id);
  const promptsSection = useDashboardSection<PromptList>(management.prompts, workspace.id);
  const checkSets = useDashboardSection<CheckSetList>(management.checkSets, workspace.id);
  const [draft, setDraft] = useState<WorkflowDraft>(initialDraft);
  const initial = useRef(JSON.stringify(initialDraft));
  const [newPrompts, setNewPrompts] = useState<Record<string, NewPrompt>>({});
  const [dragged, setDragged] = useState<number | null>(null);
  const [problems, setProblems] = useState<Problem[]>(initialDraft.problems.map(problem => ({ path: problem.path, message: problem.message })));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const definition = draft.definition;
  const end = obj(definition.end);
  const limits = obj(definition.limits);
  const statusList = statuses.data?.statuses ?? [];
  const workflowList = workflows.data?.workflows ?? [];
  const promptList = promptsSection.data?.prompts ?? [];
  const commandList = checkSets.data?.commands ?? [];
  const checkSetList = checkSets.data?.checkSets ?? [];
  const roles = board.data?.roles.items ?? [];
  const boardSha = board.data?.board.sha256 ?? null;
  const title = String(definition.title ?? '') || draft.name;
  const isNew = draft.expectedSha256 === null && draft.name === '';
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
  const dirty = JSON.stringify(draft) !== initial.current || Object.keys(newPrompts).length > 0;
  const startOptions = statusOptions(statusList, workflowList, draft.name);
  const targetOptions = targetStatusOptions(statusList, workflowList);
  const warningStart = unreachableStart(draft, workflowList);
  const steps = definition.steps;

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
  function patchStep(index: number, change: (step: DraftStep) => void): void {
    update(updateStep(draft, index, change));
  }
  function setAgentPrompt(index: number, value: string): void {
    const step = steps[index];
    const id = step?.id ?? '';
    patchStep(index, next => { if (next.agent) next.agent.prompt = value; });
    setNewPrompts(current => {
      if (value !== '') {
        if (!current[id]) return current;
        const next = { ...current }; delete next[id]; return next;
      }
      return current[id] ? current : { ...current, [id]: { name: '', source: '' } };
    });
  }
  function setNewPrompt(index: number, change: Partial<NewPrompt>): void {
    const id = steps[index]?.id;
    if (!id) return;
    setNewPrompts(current => ({ ...current, [id]: { ...(current[id] ?? { name: '', source: '' }), ...change } }));
  }
  function setAgentAccess(index: number, value: 'read' | 'write'): void {
    patchStep(index, next => { if (next.agent) next.agent.access = value; });
  }
  function setAgentCommands(index: number, commands: string[]): void {
    patchStep(index, next => { if (next.agent) { if (commands.length) next.agent.delegates = commands; else delete next.agent.delegates; } });
  }
  function setCheck(index: number, value: string): void {
    patchStep(index, next => { if (next.check) next.check.checks = value; });
  }
  function setApproval(index: number, value: string): void {
    patchStep(index, next => { if (next.approval) next.approval.ask = value; });
  }
  function setPass(index: number, value: string): void {
    update(setTarget(draft, index, 'pass', value));
  }
  function setFail(index: number, value: string): void {
    if (value === '__retry') {
      const current = steps[index]?.onFail;
      const earlier = steps.slice(0, index).at(-1);
      if (current && typeof current === 'object') update(setRetry(draft, index, current.retry, current.max));
      else if (earlier) update(setRetry(draft, index, earlier.id, 1));
      return;
    }
    update(setTarget(draft, index, 'fail', value));
  }
  function setRetryValues(index: number, target: string, max: number): void {
    update(setRetry(draft, index, target, Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1)));
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
  ].some(path => problem.path === path || problem.path.startsWith(`${path}.`) || problem.path.startsWith('steps[')));
  function close(): void {
    if (!pending && (!dirty || window.confirm('Discard unsaved workflow changes?'))) onClose();
  }
  function validateNewPrompts(): string | null {
    const seen = new Set<string>();
    for (const step of steps) {
      if (!step.agent || step.agent.prompt !== '') continue;
      const value = newPrompts[step.id];
      if (!value) continue;
      const name = value.name.trim();
      if (!PROMPT_NAME.test(name)) return 'Enter a prompt name with lowercase letters, numbers and hyphens.';
      if (promptList.some(prompt => prompt.name === name)) return `A prompt named "${name}" already exists.`;
      if (seen.has(name)) return `The new prompt "${name}" is used by more than one step.`;
      seen.add(name);
    }
    return null;
  }
  async function save(): Promise<void> {
    if (pending || !boardSha) return;
    setPending(true); setError(''); setProblems([]);
    try {
      let next = draft;
      const name = isNew ? workflowNameFromTitle(String(definition.title ?? '')) : draft.name;
      if (isNew) {
        if (!name) { setError('Give the workflow a name.'); return; }
        if (workflowList.some(workflow => workflow.name === name)) { setError(`A workflow named "${name}" already exists.`); return; }
      }
      const invalid = validateNewPrompts();
      if (invalid) { setError(invalid); return; }
      const created: string[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step.agent || step.agent.prompt !== '') continue;
        const value = newPrompts[step.id];
        if (!value) continue;
        const promptName = value.name.trim();
        const source = value.source ? promptList.find(prompt => prompt.name === value.source) : null;
        const result = await management.savePrompt(workspace.id, { name: promptName, text: source?.text ?? '{{task}}', expectedSha256: null });
        if (!result.ok) {
          if (created.length) {
            setDraft(next); onDraftChange?.(next);
            setNewPrompts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !created.includes(id))));
          }
          setError(result.error.message || 'The new prompt could not be saved.');
          return;
        }
        created.push(step.id);
        next = updateStep(next, index, updated => { if (updated.agent) updated.agent.prompt = `${promptName}.md`; });
      }
      if (created.length) { setDraft(next); onDraftChange?.(next); setNewPrompts({}); }
      const result = await management.saveBoardWorkflow(workspace.id, draftToSave({ ...next, name, expectedBoardSha256: boardSha }));
      if (result.ok) { initial.current = JSON.stringify(next); onSaved?.(result.data); onClose(); }
      else {
        const nextProblems = errorProblems(result.error);
        setProblems(nextProblems);
        setError(nextProblems.length ? '' : result.error.message || 'The workflow could not be saved.');
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
  function routeValue(index: number, outcome: 'pass' | 'fail'): string {
    const step = steps[index];
    if (!step) return outcome === 'pass' ? 'end-pass' : 'end-fail';
    if (outcome === 'pass') return step.onPass ?? (steps[index + 1]?.id ?? 'end-pass');
    const value = step.onFail;
    if (value && typeof value === 'object') return '__retry';
    return value ?? 'end-fail';
  }
  function routeOptions(index: number, outcome: 'pass' | 'fail'): Array<{ value: string; label: string }> {
    const options = outcome === 'pass'
      ? [{ value: 'end-pass', label: 'End: pass' }]
      : [{ value: 'end-fail', label: 'End: fail' }, ...(index > 0 ? [{ value: '__retry', label: 'Retry an earlier step' }] : [])];
    steps.forEach((step, target) => {
      if (target === index) return;
      options.push({ value: step.id, label: target > index ? `Next step: ${step.id}` : `Step: ${step.id}` });
    });
    const current = routeValue(index, outcome);
    if (!options.some(option => option.value === current)) options.push({ value: current, label: `Step: ${current}` });
    return options;
  }
  function promptValue(step: DraftStep): string {
    return step.agent?.prompt ? promptFile(step.agent.prompt) : '';
  }
  function selectedPrompt(step: DraftStep) {
    return promptList.find(prompt => `${prompt.name}.md` === promptValue(step)) ?? null;
  }
  function promptUsers(step: DraftStep, prompt: { name: string; users: Array<{ workflow: string; step: string }> } | null): string[] {
    if (!prompt) return [];
    return [...new Set(prompt.users
      .filter(user => !(user.workflow === draft.name && user.step === step.id))
      .map(user => workflowList.find(workflow => workflow.name === user.workflow)?.title || user.workflow))];
  }
  function checkSetRules(id: string): ReactNode {
    const entry = checkSetList.find(item => item.id === id);
    if (!entry) return <span className="workflow-dialog-hint">Choose a check set to see its rules.</span>;
    return <div className="workflow-check-rules" aria-label={`Rules for ${entry.id}`}>
      {entry.run.map((rule, index) => <div key={`${rule.command}-${index}`}><span>{rule.when.length ? rule.when.join(', ') : 'Always'}</span><span aria-hidden="true"> → </span><code>{rule.command}</code></div>)}
      {entry.otherwise && <div><span>Anything else</span><span aria-hidden="true"> → </span><code>{entry.otherwise}</code></div>}
      {entry.reuseIfTested && <p>Skips a command that already passed on the same code.</p>}
    </div>;
  }
  function stepCard(step: DraftStep, index: number): JSX.Element {
    const kind: StepKind = step.agent ? 'agent' : step.check ? 'check' : step.action ? 'merge' : 'approval';
    const kindLabel = kind === 'merge' ? 'ACTION' : kind.toUpperCase();
    const failValue = routeValue(index, 'fail');
    const retry = step.onFail && typeof step.onFail === 'object' ? step.onFail : null;
    const commands = step.agent?.delegates ?? [];
    const availableCommands = commandList.filter(command => !commands.includes(command.id));
    const prompt = selectedPrompt(step);
    const users = promptUsers(step, prompt);
    const newPrompt = step.agent && promptValue(step) === '' ? newPrompts[step.id] : undefined;
    return <li key={step.id} className={`workflow-step-card ${kind}`} data-step-index={index} onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault();
      if (dragged === null || dragged === index) return;
      update(reorderStep(draft, dragged, index));
      setDragged(null);
    }}>
      <div className="workflow-step-card-head">
        <button type="button" className="workflow-step-drag" aria-label={`Drag ${step.id}`} draggable={!pending} onDragStart={event => { event.dataTransfer?.setData('text/plain', String(index)); setDragged(index); }} onDragEnd={() => setDragged(null)}>⠿</button>
        <span className="workflow-step-number">{index + 1}</span>
        <span className={`workflow-step-kind ${kind}`}>{kindLabel}</span>
        <input className="workflow-step-id" aria-label={`Step ${index + 1} id`} value={step.id} onChange={event => update(renameStep(draft, index, event.target.value))} />
        <button type="button" className="workflow-step-remove" disabled={pending} onClick={() => update(removeStep(draft, index))}>Remove</button>
      </div>
      {kind === 'agent' && step.agent && <>
        <div className="workflow-step-fields two">
          <label><span>Prompt</span><select aria-label="Prompt" value={promptValue(step)} onChange={event => setAgentPrompt(index, event.target.value)}>
            {promptValue(step) && !promptList.some(prompt => `${prompt.name}.md` === promptValue(step)) && <option value={promptValue(step)}>{promptValue(step)}</option>}
            {promptOptions(promptList).map(option => <option key={option.value || 'new'} value={option.value}>{option.label}</option>)}
          </select></label>
          <label><span>The agent may</span><select aria-label="The agent may" value={step.agent.access} onChange={event => setAgentAccess(index, event.target.value === 'read' ? 'read' : 'write')}><option value="write">Edit files</option><option value="read">Only read files</option></select></label>
        </div>
        {(users.length > 0 || (prompt && onOpenPrompt)) && <div className="workflow-prompt-notes">
          {users.length > 0 && <span>Also used by {users.join(', ')}: edits change both.</span>}
          {prompt && <button type="button" className="workflow-dialog-link" disabled={!onOpenPrompt} onClick={() => onOpenPrompt?.(prompt.name)}>Edit {prompt.name}.md →</button>}
        </div>}
        {newPrompt && <div className="workflow-new-prompt" aria-label="New prompt">
          <strong>New prompt</strong>
          <div className="workflow-dialog-grid two">
            <label><span>Name</span><span className="workflow-name-suffix"><input aria-label="New prompt name" value={newPrompt.name} onChange={event => setNewPrompt(index, { name: event.target.value })} /><span>.md</span></span></label>
            <label><span>Start from</span><select aria-label="Start from" value={newPrompt.source} onChange={event => setNewPrompt(index, { source: event.target.value })}><option value="">Blank</option>{promptList.map(prompt => <option key={prompt.name} value={prompt.name}>{prompt.name}.md</option>)}</select></label>
          </div>
          <p className="workflow-dialog-hint">Created when you save the workflow; write it afterwards in Workflow prompts.</p>
        </div>}
        <div className="workflow-commands">
          <span>Commands it may ask the coordinator to run</span>
          <div className="workflow-command-chips">
            {commands.map(command => <span key={command} className="workflow-command-chip">{command}<button type="button" aria-label={`Remove ${command}`} onClick={() => setAgentCommands(index, commands.filter(item => item !== command))}>×</button></span>)}
            <select aria-label="Add command" value="" disabled={availableCommands.length === 0} onChange={event => { if (event.target.value) setAgentCommands(index, [...commands, event.target.value]); }}><option value="">+ Add</option>{availableCommands.map(command => <option key={command.id} value={command.id}>{command.id}</option>)}</select>
          </div>
          <p className="workflow-dialog-hint">The agent stops, the coordinator runs the command, and the same session continues with the result.</p>
        </div>
      </>}
      {kind === 'check' && step.check && <>
        <label className="workflow-step-label"><span>Check set</span><select aria-label="Check set" value={step.check.checks} onChange={event => setCheck(index, event.target.value)}><option value="">Choose a check set</option>{checkSetList.map(set => <option key={set.id} value={set.id}>{set.id}</option>)}{step.check.checks && !checkSetList.some(set => set.id === step.check!.checks) && <option value={step.check.checks}>{step.check.checks}</option>}</select></label>
        {checkSetRules(step.check.checks)}
        <p className="workflow-dialog-hint">The coordinator runs it; no prompt. The next agent step gets the results.</p>
      </>}
      {kind === 'approval' && step.approval && <label className="workflow-step-label"><span>Question for the operator</span><input aria-label="Question for the operator" value={step.approval.ask} onChange={event => setApproval(index, event.target.value)} /></label>}
      {kind === 'approval' && <p className="workflow-dialog-hint">The ticket shows “Waiting for approval” on the board with Approve / Reject. A reject note reaches the next agent step.</p>}
      <div className="workflow-step-fields two">
        <label className="pass"><span>{kind === 'approval' ? 'If approved' : 'If it passes'}</span><select aria-label={kind === 'approval' ? 'If approved' : 'If it passes'} value={routeValue(index, 'pass')} onChange={event => setPass(index, event.target.value)}>{routeOptions(index, 'pass').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="fail"><span>{kind === 'approval' ? 'If rejected' : 'If it fails'}</span><select aria-label={kind === 'approval' ? 'If rejected' : 'If it fails'} value={failValue} onChange={event => setFail(index, event.target.value)}>{routeOptions(index, 'fail').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      {retry && <div className="workflow-retry-row">
        <span>Go back to</span>
        <select aria-label="Retry step" value={retry.retry} onChange={event => setRetryValues(index, event.target.value, retry.max)}>{steps.slice(0, index).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}</select>
        <span>up to</span>
        <input aria-label="Retry times" type="number" min={1} value={retry.max} onChange={event => setRetryValues(index, retry.retry, Number(event.target.value) || 1)} />
        <span>times, then <strong>End: fail</strong></span>
      </div>}
      {fieldProblems([`steps[${index}]`])}
    </li>;
  }

  return <Dialog
    title={isNew ? 'Add workflow' : `Edit workflow: ${title}`}
    subtitle={isNew
      ? <>Saved as <code>.agent-studio/workflows/{workflowNameFromTitle(String(definition.title ?? '')) || '…'}.yaml</code></>
      : <><code>.agent-studio/workflows/{draft.name}.yaml</code>{neighbours.before.length || neighbours.after.length ? <> · {neighbours.before.join(' / ')}{neighbours.before.length ? ' → ' : ''}<strong>{title}</strong>{neighbours.after.length ? <> → {neighbours.after.join(' / ')}</> : null}</> : null}</>}
    width={820}
    className="workflow-dialog"
    busy={pending}
    onClose={close}
    leadingActions={isNew ? [] : [{ label: 'Delete workflow', onClick: () => void remove(), disabled: pending || deleteReason !== null, descriptionId: 'workflow-delete-reason', title: deleteReason ?? 'Delete this workflow' }]}
    actions={[{ label: 'Cancel', onClick: close, disabled: pending }, { label: isNew ? 'Add workflow' : 'Save workflow', variant: 'primary', disabled: pending || !boardSha, onClick: () => void save() }]}
  >
    {!isNew && <span id="workflow-delete-reason" className="sr-only">{deleteReason ?? 'Delete this workflow.'}</span>}
    <SectionError section={statuses} label="Statuses" />
    <SectionError section={workflows} label="Workflows" />
    <SectionError section={board} label="Board settings" />
    <SectionError section={promptsSection} label="Workflow prompts" />
    <SectionError section={checkSets} label="Check sets" />
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
      {steps.length ? <ol className="workflow-dialog-steps" aria-label="Workflow steps">{steps.map(stepCard)}</ol> : <p className="workflow-dialog-hint">No steps yet. Add one below.</p>}
      <div className="workflow-add-step"><span>Add step</span>{([['agent', '+ Agent'], ['check', '+ Check'], ['merge', '+ Merge'], ['approval', '+ Approval']] as const).map(([kind, label]) => <button type="button" key={kind} className="workflow-add-step-button" disabled={pending} onClick={() => update(addStep(draft, kind))}>{label}</button>)}</div>
    </section>

    <section className="workflow-dialog-section" data-section="workflow-ends">
      <h3>4. Where it ends</h3>
      <div className="workflow-dialog-table">
        <label data-field="end.pass"><span className="pass">Passes → set status</span><select value={pass} onChange={event => setEndStatus('pass', event.target.value)}><option value="">Choose a status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.pass'])}</label>
        <label data-field="end.fail"><span className="fail">Fails → set status</span><select value={fail} onChange={event => setEndStatus('fail', event.target.value)}><option value="">Choose a status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{fieldProblems(['end.fail'])}</label>
        <label data-field="end.blocked.returnTo"><span>Blocked</span><span className="workflow-dialog-inline">Mark blocked; when unblocked go to <select aria-label="Return to" value={typeof blocked.returnTo === 'string' ? blocked.returnTo : ''} onChange={event => setBlockedReturn(event.target.value)}><option value="">Start status</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></span>{fieldProblems(['end.blocked.returnTo'])}</label>
      </div>
      {warningStart && <div className="workflow-dialog-warning" role="alert">Nothing sets {statusName(statusList, warningStart)} yet, and tickets cannot start here. Set another workflow's "Passes" to {statusName(statusList, warningStart)}, or tick "Tickets can start here".</div>}
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
