import { yamlSteps } from './workflowYamlSteps';
import type { BoardWorkflowDetail, BoardWorkflowSummary, BoardStatuses, PromptDetail, WorkflowProblem } from '../api';

type Status = BoardStatuses['statuses'][number];
export type Retry = { retry: string; max: number; then: 'end-fail' };
export type StepKind = 'agent' | 'check' | 'merge' | 'approval';
export type DraftStep = { id: string; agent?: { prompt: string; access: 'read' | 'write'; delegates?: string[] }; check?: { checks: string }; action?: 'merge'; approval?: { ask: string }; passRequires?: string[]; onPass?: string; onFail?: string | Retry };
export interface WorkflowDraft { name: string; definition: Record<string, unknown> & { steps: DraftStep[] }; start: { allowed: boolean; default: boolean }; expectedSha256: string | null; expectedBoardSha256?: string; problems: WorkflowProblem[] }
const copy = <T>(x: T): T => structuredClone(x);
const obj = (x: unknown): Record<string, any> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, any> : {};
const route = (x: unknown): string => x === '$succeed' ? 'end-pass' : x === '$fail' ? 'end-fail' : typeof x === 'string' ? x : 'end-fail';
export function draftFromWorkflow(show: BoardWorkflowDetail, boardSha256?: string): WorkflowDraft {
  const source = copy(show.definition ?? {});
  // Compilation folds overlapping retry limits together. Prefer the original JSON
  // steps where possible, since those limits cannot be recovered from stages.
  try { const original = JSON.parse(show.text); if (Array.isArray(original?.steps)) source.steps = original.steps; } catch { const original = yamlSteps(show.text); if (original) source.steps = original; else if (source.compiledSteps && show.text.trim()) throw new Error('Cannot safely read workflow source steps.'); }
  const stages = Array.isArray(source.stages) ? source.stages.map(obj) : [];
  const steps: DraftStep[] = Array.isArray(source.steps) ? copy(source.steps as DraftStep[]) : stages.map((s, i) => {
    const next = obj(s.next); const step: DraftStep = { id: s.id, onPass: route(next.pass), onFail: route(next.fail) };
    if (s.type === 'agent') { step.agent = { prompt: String(s.promptSource ?? '').replace(/^workflows\/prompts\//, ''), access: s.permission === 'read_only' ? 'read' : 'write' }; if (s.delegates) step.agent.delegates = copy(s.delegates); if (s.passRequires?.length) step.passRequires = copy(s.passRequires); }
    else if (s.stepKind === 'action') step.action = 'merge';
    else if (s.stepKind === 'approval') step.approval = { ask: s.stepValue ?? '' };
    else step.check = { checks: s.checks ?? '' };
    const target = stages.findIndex(t => t.id === next.fail);
    if (source.compiledSteps && target >= 0 && target < i && s.maxVisits > 1) step.onFail = { retry: next.fail, max: s.maxVisits - 1, then: 'end-fail' };
    return step;
  });
  for (const key of ['name', 'sourceSha256', 'warnings', 'stages', 'compiledSteps']) delete source[key];
  return { name: show.name, definition: { ...source, steps }, start: copy(show.start), expectedSha256: show.sha256, ...(boardSha256 ? { expectedBoardSha256: boardSha256 } : {}), problems: copy(show.problems) };
}
export function emptyDraft(): WorkflowDraft { return { name: '', definition: { version: 2, title: '', startsAt: '', whileRunning: '', end: { pass: '', fail: '' }, steps: [] }, start: { allowed: false, default: false }, expectedSha256: null, problems: [] }; }
export function draftToSave(d: WorkflowDraft) { return { name: d.name, definition: copy(d.definition), start: copy(d.start), expectedSha256: d.expectedSha256, ...(d.expectedBoardSha256 ? { expectedBoardSha256: d.expectedBoardSha256 } : {}) }; }
function edit(d: WorkflowDraft, fn: (steps: DraftStep[]) => void): WorkflowDraft { const result = copy(d); fn(result.definition.steps); return result; }
export function addStep(d: WorkflowDraft, kind: StepKind): WorkflowDraft { return edit(d, steps => { let id: string = kind; let n = 2; while (steps.some(s => s.id === id)) id = `${kind}_${n++}`; const s: DraftStep = { id }; if (kind === 'agent') s.agent = { prompt: '', access: 'write' }; if (kind === 'check') s.check = { checks: '' }; if (kind === 'merge') s.action = 'merge'; if (kind === 'approval') s.approval = { ask: '' }; steps.push(s); }); }
export function removeStep(d: WorkflowDraft, index: number): WorkflowDraft { return edit(d, steps => { if (index < 0 || index >= steps.length) return; if (index > 0 && steps[index - 1].onPass === undefined) steps[index - 1].onPass = 'end-fail'; const [removed] = steps.splice(index, 1); for (const s of steps) { if (s.onPass === removed.id) s.onPass = 'end-fail'; if (s.onFail === removed.id || (typeof s.onFail === 'object' && s.onFail.retry === removed.id)) s.onFail = 'end-fail'; if (s.passRequires) s.passRequires = s.passRequires.filter(id => id !== removed.id); } }); }
export function moveStep(d: WorkflowDraft, index: number, direction: 'up' | 'down'): WorkflowDraft { return edit(d, steps => { const to = index + (direction === 'up' ? -1 : 1); if (index >= 0 && index < steps.length && to >= 0 && to < steps.length) [steps[index], steps[to]] = [steps[to], steps[index]]; }); }
export function renameStep(d: WorkflowDraft, index: number, id: string): WorkflowDraft { return edit(d, steps => { if (!steps[index]) return; const old = steps[index].id; steps[index].id = id; for (const s of steps) { if (s.onPass === old) s.onPass = id; if (s.onFail === old) s.onFail = id; else if (typeof s.onFail === 'object' && s.onFail.retry === old) s.onFail.retry = id; if (s.passRequires) s.passRequires = s.passRequires.map(x => x === old ? id : x); } }); }
export function setTarget(d: WorkflowDraft, index: number, outcome: 'pass' | 'fail', target: string | undefined): WorkflowDraft { return edit(d, steps => { if (steps[index]) { const key = outcome === 'pass' ? 'onPass' : 'onFail'; if (target === undefined) delete steps[index][key]; else steps[index][key] = target; } }); }
export function setRetry(d: WorkflowDraft, index: number, target: string, max: number): WorkflowDraft { return edit(d, steps => { if (steps[index]) steps[index].onFail = { retry: target, max, then: 'end-fail' }; }); }
export function statusOptions(statuses: readonly Status[], workflows: readonly BoardWorkflowSummary[], currentName: string) { const used = new Set(workflows.filter(w => w.name !== currentName).flatMap(w => [w.startsAt, w.whileRunning])); return statuses.filter(s => s.kind === null && !used.has(s.id)).map(s => ({ value: s.id, label: s.name || s.id })); }
export function targetStatusOptions(statuses: readonly Status[], workflows: readonly BoardWorkflowSummary[]) { return statuses.map(s => { const starts = workflows.filter(w => w.startsAt === s.id); return { value: s.id, label: `${s.name || s.id}${starts.length ? ` (starts ${starts.map(w => w.title).join(', ')})` : ''}` }; }); }
export function promptOptions(prompts: readonly PromptDetail[]) { return [...prompts.map(p => ({ value: `${p.name}.md`, label: `${p.name}.md` })), { value: '', label: '+ New prompt…' }]; }
export function validateDraft(d: WorkflowDraft, statuses: readonly Status[], workflows: readonly BoardWorkflowSummary[], backendProblems: readonly WorkflowProblem[] = []): WorkflowProblem[] {
  const problems = [...d.problems, ...backendProblems].map(p => ({ path: p.path, message: p.message })); const add = (path: string, message: string) => { if (!problems.some(p => p.path === path && p.message === message)) problems.push({ path, message }); };
  const steps = d.definition.steps; if (steps.length < 1 || steps.length > 20) add('steps', 'steps must contain 1-20 items'); const ids = new Set<string>();
  steps.forEach((s, i) => { const p = `steps[${i}]`; if (!/^[a-z][a-z0-9_]{0,31}$/.test(s.id)) add(`${p}.id`, 'id must match [a-z][a-z0-9_]{0,31}'); else if (ids.has(s.id)) add(`${p}.id`, `duplicate stage id "${s.id}"`); ids.add(s.id); if (['agent', 'check', 'action', 'approval'].filter(k => Object.prototype.hasOwnProperty.call(s, k)).length !== 1) add(p, 'step needs exactly one kind'); if (s.agent && !s.agent.prompt.trim()) add(`${p}.agent.prompt`, 'Choose a prompt.'); if (s.check && !s.check.checks.trim()) add(`${p}.check`, 'check requires a non-empty checks value'); if (s.approval && !s.approval.ask.trim()) add(`${p}.approval`, 'requires non-empty text'); if (s.onFail && typeof s.onFail === 'object' && !Array.isArray(s.onFail)) { const retry = s.onFail; const keys = Object.keys(retry); if (keys.length !== 3 || !['retry', 'max', 'then'].every(k => keys.includes(k)) || retry.then !== 'end-fail') add(`${p}.onFail`, 'retry requires retry, max and then: end-fail'); if (!steps.slice(0, i).some(x => x.id === retry.retry)) add(`${p}.onFail.retry`, 'retry must name an earlier step'); if (!Number.isInteger(retry.max) || retry.max < 1) add(`${p}.onFail.max`, 'max must be a positive integer'); } });
  if (steps.some(s => s.agent) && !(typeof d.definition.role === 'string' && d.definition.role.trim())) add('role', 'A workflow with an agent step requires a role.'); const others = workflows.filter(w => w.name !== d.name);
  for (const key of ['startsAt', 'whileRunning'] as const) { const value = d.definition[key]; if (typeof value !== 'string' || !value) add(key, 'Choose a status.'); else if (!statuses.some(s => s.id === value && s.kind === null)) add(key, 'Choose a valid status with no kind.'); else if (others.some(w => w.startsAt === value || w.whileRunning === value)) add(key, `Status '${value}' is already used by another workflow.`); }
  if (d.definition.startsAt && d.definition.startsAt === d.definition.whileRunning) add('whileRunning', 'Status is also a workflow start status.'); return problems;
}
