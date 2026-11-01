import type { BoardSettings, BoardSettingsChanges, FailureLimitPolicy, ManagementError, Problem } from '../../shared/management';

export type WorkspaceMode = '' | 'main' | 'worktree' | 'none';
export type EditableRuleField = 'status' | 'role' | 'workflow' | 'workspace' | 'onPass' | 'onFail' | 'onBlocked';
export type NewRuleKind = 'agent' | 'action';
export interface RoutingDraft { baseBranch: string; rules: Array<Record<string, unknown>> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = <T,>(value: T): T => structuredClone(value);
export function createRoutingDraft(settings: BoardSettings): RoutingDraft | null {
  const config = settings.board.config;
  if (settings.board.state !== 'ok' || !object(config) || !Array.isArray(config.rules) || !config.rules.every(object)) return null;
  return { baseBranch: settings.worktree.baseBranch ?? 'main', rules: clone(config.rules) };
}
export function updateRuleField(draft: RoutingDraft, index: number, field: EditableRuleField, value: string): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (!rule) return { ...draft, rules };
  if (field === 'status') rule.when = { ...(object(rule.when) ? rule.when : {}), status: value };
  else if (field === 'workspace') {
    if (value === '') delete rule.workspace; else rule.workspace = value;
    // The backend only accepts syncBase on a worktree rule, so moving the rule
    // out of a worktree drops the flag instead of leaving an invalid rule.
    if (value !== 'worktree') delete rule.syncBase;
  }
  else if (field === 'onBlocked' && value === '') delete rule.onBlocked;
  else rule[field] = value;
  return { ...draft, rules };
}
/** The source status of a draft rule, or null when the rule has no valid shape. */
export function ruleStatus(rule: Record<string, unknown> | undefined): string | null {
  return rule && object(rule.when) && typeof rule.when.status === 'string' ? rule.when.status : null;
}
/** A rule is an action rule when it carries `action`; the backend has no `type` key on stored rules. */
export function isActionRule(rule: Record<string, unknown> | undefined): boolean {
  return object(rule) && 'action' in rule;
}
/** Status ids that do not have a rule yet, in board order. */
export function unusedStatuses(draft: RoutingDraft, settings: BoardSettings): string[] {
  const used = new Set(draft.rules.map(ruleStatus).filter((status): status is string => status !== null));
  return settings.statuses.map(status => status.id).filter(id => !used.has(id));
}
/** Append a new rule for a free status, or return the draft unchanged when the status is unknown or already used. */
export function addRule(draft: RoutingDraft, settings: BoardSettings, status: string, kind: NewRuleKind = 'agent'): RoutingDraft {
  const rules = clone(draft.rules);
  if (!settings.statuses.some(candidate => candidate.id === status) || rules.some(rule => ruleStatus(rule) === status)) {
    return { ...draft, rules };
  }
  const done = settings.statuses.find(candidate => candidate.kind === 'done')?.id ?? settings.statuses[settings.statuses.length - 1]?.id ?? status;
  const initial = settings.statuses.find(candidate => candidate.kind === 'initial')?.id ?? settings.statuses[0]?.id ?? status;
  if (kind === 'action') {
    rules.push({ when: { status }, action: 'merge', onPass: done, onFail: initial });
  } else {
    const available = settings.workflows.filter(workflow => workflow.errors.length === 0);
    const role = settings.roles.items.find(candidate => available.some(workflow => workflow.roles.includes(candidate.id)))?.id
      ?? settings.roles.items[0]?.id ?? '';
    const workflow = available.find(candidate => candidate.roles.includes(role))?.name ?? available[0]?.name ?? '';
    rules.push({ when: { status }, role, workflow, workspace: 'worktree', syncBase: true, onPass: done, onFail: initial });
  }
  return { ...draft, rules };
}
/** Remove a rule unless its status is a protected route. */
export function removeRule(draft: RoutingDraft, index: number, settings: BoardSettings): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (!rule) return { ...draft, rules };
  const status = ruleStatus(rule);
  if (status !== null && settings.protectedRoutes.some(route => route.status === status)) return { ...draft, rules };
  rules.splice(index, 1);
  return { ...draft, rules };
}
/** Turn the sync-base flag on or off without touching other raw fields. */
export function setRuleSyncBase(draft: RoutingDraft, index: number, enabled: boolean): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (!rule) return { ...draft, rules };
  if (enabled) rule.syncBase = true; else delete rule.syncBase;
  return { ...draft, rules };
}
/** Is this problem shown next to an editable field rather than in the dialog summary? */
export function isRuleFieldProblem(path: string, index: number, agent: boolean, statusField: boolean): boolean {
  const prefix = `rules[${index}].`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest === 'when.status') return statusField;
  if (rest === 'onPass' || rest === 'onFail') return true;
  if (rest === 'role' || rest === 'workflow' || rest === 'workspace') return agent;
  return agent && (rest === 'onBlocked' || rest === 'onFailureLimit.count' || rest === 'onFailureLimit.status');
}
export function failureLimitOf(rule: Record<string, unknown> | undefined): FailureLimitPolicy | null {
  const policy = rule?.onFailureLimit;
  return object(policy) && typeof policy.count === 'number' && typeof policy.status === 'string' ? { count: policy.count, status: policy.status } : null;
}
export function setRuleFailureLimit(draft: RoutingDraft, index: number, count: number, status: string): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (!rule) return { ...draft, rules };
  rule.onFailureLimit = { count, status };
  return { ...draft, rules };
}
export function updateFailureLimit(draft: RoutingDraft, index: number, field: 'count' | 'status', value: number | string): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (!rule || !object(rule.onFailureLimit)) return { ...draft, rules };
  rule.onFailureLimit = { ...rule.onFailureLimit, [field]: value };
  return { ...draft, rules };
}
export function removeRuleFailureLimit(draft: RoutingDraft, index: number): RoutingDraft {
  const rules = clone(draft.rules); const rule = rules[index];
  if (rule) delete rule.onFailureLimit;
  return { ...draft, rules };
}
export function validateRoutingDraft(draft: RoutingDraft, settings: BoardSettings): Problem[] {
  const problems: Problem[] = []; const add = (path: string, message: string) => problems.push({ path, message });
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.baseBranch)) add('baseBranch', 'Use 1–64 lowercase letters, numbers, or hyphens, starting with a letter or number.');
  const statuses = new Set(settings.statuses.map(s => s.id)); const seen = new Set<unknown>();
  draft.rules.forEach((rule, i) => {
    const prefix = `rules[${i}]`; const status = object(rule.when) ? rule.when.status : undefined;
    for (const [path, value] of [['when.status', status], ['onPass', rule.onPass], ['onFail', rule.onFail], ...(rule.onBlocked ? [['onBlocked', rule.onBlocked]] : [])]) {
      if (typeof value !== 'string' || !statuses.has(value)) add(`${prefix}.${path}`, 'Choose a status from this board.');
    }
    if (seen.has(status)) add(`${prefix}.when.status`, `Only one rule can start from status "${String(status)}".`); seen.add(status);
    const action = isActionRule(rule);
    if (!action) {
      if (!settings.roles.items.some(r => r.id === rule.role)) add(`${prefix}.role`, 'Choose a configured role.');
      const workflow = settings.workflows.find(w => w.name === rule.workflow);
      if (!workflow || workflow.errors.length) add(`${prefix}.workflow`, 'Choose a valid workflow.');
      else if (!workflow.roles.includes(String(rule.role))) add(`${prefix}.workflow`, `The workflow must use role "${String(rule.role)}".`);
      if (rule.workspace !== undefined && rule.workspace !== '' && !['main', 'worktree', 'none'].includes(String(rule.workspace))) add(`${prefix}.workspace`, 'Choose Default, Main workspace, Isolated worktree, or No workspace.');
    } else if (rule.action !== 'merge') add(`${prefix}.action`, 'Only the configured merge action can be edited here.');
    if ((status === 'merge-conflict' || status === 'plan-merge-conflict') && (action || rule.role !== 'TeamLead')) add(`${prefix}.role`, 'This protected merge-conflict route must use TeamLead.');
    if ('onFailureLimit' in rule) {
      const policy = rule.onFailureLimit;
      if (action) add(`${prefix}.onFailureLimit`, 'Failure escalation is available only for agent rules.');
      if (!object(policy) || Object.keys(policy).some(key => key !== 'count' && key !== 'status')) add(`${prefix}.onFailureLimit`, 'Failure escalation needs a count and a target status.');
      else {
        if (!(typeof policy.count === 'number' && Number.isInteger(policy.count) && policy.count >= 1)) add(`${prefix}.onFailureLimit.count`, 'Enter a positive whole number.');
        if (typeof policy.status !== 'string' || !statuses.has(policy.status)) add(`${prefix}.onFailureLimit.status`, 'Choose a status from this board.');
      }
    }
  });
  const initial = settings.statuses.find(s => s.kind === 'initial')?.id; const visited = new Set<string>(); const queue = initial ? [initial] : [];
  while (queue.length) { const status = queue.shift()!; if (visited.has(status)) continue; visited.add(status); for (const rule of draft.rules) if (object(rule.when) && rule.when.status === status) for (const next of [rule.onPass, rule.onFail, rule.onBlocked, !isActionRule(rule) && object(rule.onFailureLimit) && typeof rule.onFailureLimit.status === 'string' && statuses.has(rule.onFailureLimit.status) ? rule.onFailureLimit.status : undefined]) if (typeof next === 'string' && next) queue.push(next); }
  if (!settings.statuses.some(s => s.kind === 'done' && visited.has(s.id))) add('rules', 'No routing path reaches a done status.');
  return problems;
}
export function boardSettingsChanges(draft: RoutingDraft, settings: BoardSettings): BoardSettingsChanges | null {
  const changes: BoardSettingsChanges = {};
  if (draft.baseBranch !== (settings.worktree.baseBranch ?? 'main')) changes.baseBranch = draft.baseBranch;
  if (JSON.stringify(draft.rules) !== JSON.stringify(settings.board.config?.rules)) changes.rules = clone(draft.rules);
  return Object.keys(changes).length ? changes : null;
}
export function errorProblems(error: ManagementError): Problem[] {
  if (!object(error.data) || !Array.isArray(error.data.problems)) return [];
  return error.data.problems.filter((p: unknown): p is Problem => object(p) && typeof p.path === 'string' && typeof p.message === 'string').map((p: Problem) => ({ path: p.path, message: p.message }));
}
