import type { BoardWorkflowDetail, BoardWorkflows, BoardStatuses } from '../../shared/management';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const statusId = (v: unknown): string => typeof v === 'string' ? v : str(obj(v).status);
export type RoutingGroup = 'main' | 'detour' | 'unreachable';
export interface RoutingStep { n: number; kind: string; id: string; detail: string; pass: string; fail: string }
export interface RoutingCard {
  name: string; title: string; file: string; group: RoutingGroup; colour: 'blue' | 'purple' | 'amber' | 'grey';
  startTag: string | null; startsAt: string; whileRunning: string; role: string; worksIn: string;
  steps: RoutingStep[]; pass: string; fail: string; blocked: string | null; release: string | null;
  limits: string[]; createdTickets: string | null; summary: string; searchText: string;
}
export interface RoutingCards { cards: RoutingCard[]; problems: Array<{ workflow: string; message: string }> }

/** Build display-only routing data. Details enrich catalog summaries whose steps omit transitions. */
export function buildRoutingCards(board: BoardWorkflows, statuses: BoardStatuses, starts: { todoEntry: string[]; todoDefault: string | null }, details: BoardWorkflowDetail[] = []): RoutingCards {
  const names = new Map(statuses.statuses.map(s => [s.id, s.name]));
  const label = (id: string) => names.get(id) ?? id;
  const traverse = (passOnly: boolean) => {
    const reached = new Set(starts.todoEntry); const queue = [...reached];
    while (queue.length) {
      const current = queue.shift()!;
      for (const wf of board.workflows.filter(w => w.startsAt === current)) {
        for (const key of passOnly ? ['pass'] : ['pass', 'fail', 'blocked']) {
          const end = wf.end[key];
          for (const next of [statusId(end), ...(!passOnly && key === 'blocked' ? [str(obj(end).returnTo)] : [])]) if (next && !reached.has(next)) { reached.add(next); queue.push(next); }
        }
        if (!passOnly) {
          const failure = statusId(wf.limits.failuresInARow);
          if (failure && !reached.has(failure)) { reached.add(failure); queue.push(failure); }
        }
      }
    }
    return reached;
  };
  const main = traverse(true), reachable = traverse(false);
  const problems: RoutingCards['problems'] = [];
  const cards = board.workflows.map((wf): RoutingCard => {
    const group: RoutingGroup = main.has(wf.startsAt) ? 'main' : reachable.has(wf.startsAt) ? 'detour' : 'unreachable';
    if (group === 'unreachable') {
      const hasIncoming = board.workflows.some(other =>
        Object.values(other.end).some(end => statusId(end) === wf.startsAt) ||
        str(obj(other.end.blocked).returnTo) === wf.startsAt ||
        statusId(other.limits.failuresInARow) === wf.startsAt);
      const reason = hasIncoming ? `${label(wf.startsAt)} cannot be reached from a start status` : `no workflow ends in ${label(wf.startsAt)} and tickets cannot start there`;
      problems.push({ workflow: wf.name, message: `${wf.title} — ${reason}, so it never runs.` });
    }
    const definition = obj(details.find(d => d.name === wf.name)?.definition);
    const raw = (Array.isArray(definition.steps) ? definition.steps : Array.isArray(definition.stages) ? definition.stages : wf.steps).map(obj);
    const steps = raw.map((step, i): RoutingStep => {
      const id = str(step.id); const agent = obj(step.agent); const check = obj(step.check);
      const kind = step.agent ? 'agent' : step.action || step.stepKind === 'action' || step.kind === 'action' ? 'action' : step.approval || step.stepKind === 'approval' || step.kind === 'approval' ? 'approval' : step.check || step.checks || step.type === 'validation' || step.kind === 'validation' ? 'check' : step.type === 'agent' || step.kind === 'work' || step.kind === 'verdict' ? 'agent' : str(step.kind) || str(step.type);
      const prompt = (str(agent.prompt) || str(step.promptSource) || str(step.promptFile)).split('/').pop() || '';
      const checkSet = str(check.checks) || str(step.checks);
      const pieces = kind === 'agent' ? [prompt && (prompt.endsWith('.md') ? prompt : `${prompt}.md`), (agent.access === 'write' || step.permission === 'workspace_write') ? 'edits files' : (agent.access === 'read' || step.permission === 'read_only') ? 'read only' : '', Array.isArray(agent.delegates ?? step.delegates) ? `may ask for ${(agent.delegates ?? step.delegates as unknown[] as string[]).toString().replace(/,/g, ', ')}` : ''] : kind === 'check' ? [checkSet ? `check set ${checkSet}` : ''] : [str(step.action) || str(step.stepValue) || str(obj(step.approval).ask)];
      const target = (value: unknown, fallback: string): string => {
        const retry = obj(value); const targetId = str(retry.retry) || str(value) || fallback;
        if (targetId === '$succeed' || targetId === 'end-pass') return 'end: pass';
        if (targetId === '$fail' || targetId === 'end-fail') return 'end: fail';
        const index = raw.findIndex(s => s.id === targetId);
        if (index < 0) return targetId;
        const max = typeof retry.max === 'number' ? retry.max : index <= i && typeof raw[index]?.maxVisits === 'number' ? (raw[index]!.maxVisits as number) - 1 : 0;
        return index <= i && max > 0 ? `back to step ${index + 1}, up to ${max} times, then end: fail` : `step ${index + 1} (${targetId})`;
      };
      const next = obj(step.next);
      return { n: i + 1, kind, id, detail: pieces.filter(Boolean).join(' · '), pass: target(step.onPass ?? next.pass ?? next.done, i + 1 < raw.length ? str(raw[i + 1]?.id) : 'end-pass'), fail: target(step.onFail ?? next.fail, 'end-fail') };
    });
    const pass = label(statusId(wf.end.pass)), fail = label(statusId(wf.end.fail));
    const blockedEnd = obj(wf.end.blocked); const blocked = statusId(wf.end.blocked) ? `${label(statusId(wf.end.blocked))}${str(blockedEnd.returnTo) ? `, back to ${label(str(blockedEnd.returnTo))}` : ''}` : null;
    const release = obj(obj(wf.end.pass).releaseCreatedTickets);
    const limits: string[] = [];
    if (typeof wf.limits.maxRuns === 'number') limits.push(`Max ${wf.limits.maxRuns} runs, then blocked`);
    const failures = obj(wf.limits.failuresInARow);
    if (typeof failures.count === 'number') limits.push(`${failures.count} failures in a row, then ${label(str(failures.status))}`);
    if (typeof wf.limits.onFailPriority === 'number') limits.push(`Priority ${wf.limits.onFailPriority} after a fail`);
    const works = wf.role === null && raw.some(s => s.action === 'merge' || s.stepKind === 'action' || s.kind === 'action') ? 'Runs on the board, one ticket at a time' : wf.workspace === 'worktree' ? 'Isolated worktree' : wf.workspace === 'none' ? 'No workspace' : 'Main workspace';
    const role = wf.role ?? 'Automatic'; const startsAt = label(wf.startsAt); const whileRunning = label(wf.whileRunning);
    return { name: wf.name, title: wf.title, file: `${wf.name}.yaml`, group, colour: group === 'unreachable' ? 'grey' : group === 'detour' ? 'amber' : wf.role === null ? 'purple' : 'blue', startTag: starts.todoEntry.includes(wf.startsAt) ? starts.todoDefault === wf.startsAt ? 'START HERE · DEFAULT' : 'START HERE' : null, startsAt, whileRunning, role, worksIn: [works, wf.syncBase ? 'sync base first' : '', wf.waitForDependencies ? 'waits for dependencies' : ''].filter(Boolean).join(' · '), steps, pass, fail, blocked, release: release.from && release.to ? `Then moves the tickets it created from ${label(str(release.from))} to ${label(str(release.to))}.` : null, limits, createdTickets: wf.createdTickets ? `Tickets the agent creates wait in ${label(wf.createdTickets)}.` : null, summary: `${startsAt} → ${whileRunning} · ${role} · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} · pass ${pass} · fail ${fail}`, searchText: [wf.title, startsAt, whileRunning, pass, fail, blocked ?? '', role, ...limits, wf.createdTickets ? label(wf.createdTickets) : '', release.from ? label(str(release.from)) : '', release.to ? label(str(release.to)) : '', ...steps.map(s => s.detail)].join(' ').toLowerCase() };
  });
  return { cards, problems };
}
export function filterRoutingCards(cards: RoutingCard[], query: string): RoutingCard[] {
  const needle = query.trim().toLowerCase();
  return needle ? cards.filter(card => card.searchText.includes(needle)) : cards;
}
