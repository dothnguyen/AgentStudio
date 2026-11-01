import type { JSX } from 'react';
import type { BoardSettings, RoleCatalogItem, TeamOverview } from '../../shared/management';
import { Icon } from '../icons/Icon';
import { SectionCard } from '../teams/SectionCard';
import { memberCountText, memberInitials, memberName, teamLabel } from '../teams/teamsModel';
import {
  protectedState,
  roleCoverage,
  roleMember,
  roleRef,
  runningTeams,
  statusName,
  statusTone,
  workflowErrorText,
  workflowLabel,
  workspaceLabel,
} from './routingViewModel';

export type RoutingTeamsState = 'loading' | 'ready' | 'error';

export interface RoutingReadViewProps {
  settings: BoardSettings;
  roleItems: RoleCatalogItem[] | null;
  teams?: TeamOverview | null;
  teamsState?: RoutingTeamsState;
  onViewRole?(roleId: string): void;
  onOpenTeam?(teamId: string | null): void;
  onOpenTeams?(): void;
  /** False makes Add rule and every row Edit button read-only. */
  canEdit?: boolean;
  pending?: boolean;
  /** Why editing is disabled; shown once and referenced by the disabled buttons. */
  editReason?: string | null;
  /** False when every board status already has a rule. */
  hasFreeStatus?: boolean;
  onEditRule?(index: number): void;
  onAddRule?(): void;
  onEditWorktrees?(): void;
}

function initial(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? '?';
}

function StatusDot({ settings, status }: { settings: BoardSettings; status: string }): JSX.Element {
  return <span className={`routing-status-dot routing-status-dot-${statusTone(settings.statuses, status)}`} aria-hidden="true" />;
}

function StatusChip({ settings, status }: { settings: BoardSettings; status: string }): JSX.Element {
  return <span className="routing-status-chip"><span className="routing-chip-arrow" aria-hidden="true">→</span><StatusDot settings={settings} status={status} /><span>{statusName(settings.statuses, status)}</span></span>;
}

function RoleCell({ role, order, roleItems, onViewRole }: { role: string | null; order: number; roleItems: RoleCatalogItem[] | null; onViewRole?(roleId: string): void }): JSX.Element {
  const ref = roleRef(role, roleItems);
  if (ref.kind === 'none') return <span className="routing-rule-meta">No role</span>;
  if (ref.kind === 'missing') {
    return <span className="routing-role-line"><span className="routing-role-avatar" aria-hidden="true">{initial(ref.id)}</span><code className="routing-mono">{ref.id}</code> <span className="routing-problem">Role not in catalog</span></span>;
  }
  if (ref.kind === 'catalog-unavailable') {
    return <span className="routing-role-line"><span className="routing-role-avatar" aria-hidden="true">{initial(ref.id)}</span><code className="routing-mono">{ref.id}</code> <span className="panel-note">Role catalog unavailable</span></span>;
  }
  return <span className="routing-role-line"><span className="routing-role-avatar" aria-hidden="true">{initial(ref.label)}</span>{onViewRole ? <button type="button" className="routing-role-link" aria-label={`View ${ref.label} in Roles (rule ${order})`} onClick={() => onViewRole(ref.id)}>{ref.label}</button> : <span>{ref.label}</span>}{ref.label !== ref.id && <code className="routing-mono routing-role-id">{ref.id}</code>}</span>;
}

function actionTitle(action: string | null): string {
  if (action === null || action === '') return '—';
  return `${action.charAt(0).toLocaleUpperCase()}${action.slice(1)}`;
}

function configWarnings(settings: BoardSettings): string[] {
  const warnings: string[] = [];
  if (settings.board.state === 'missing') warnings.push('No workspace board is configured, so no routing is shown.');
  if (settings.board.state === 'invalid') warnings.push('The workspace board configuration is invalid. Routing cannot be shown until it is repaired.');
  if (settings.board.message) warnings.push(settings.board.message);
  for (const problem of settings.board.problems) warnings.push(`${problem.path}: ${problem.message}`);
  if (settings.roles.state !== 'ok') warnings.push(settings.roles.message ?? `Workspace roles are ${settings.roles.state}.`);
  return warnings;
}

function limitText(rule: BoardSettings['rules'][number]): string {
  const parts: string[] = [];
  if (rule.maxRounds !== null) parts.push(`Max ${rule.maxRounds} rounds`);
  if (rule.priority !== null) parts.push(`priority ${rule.priority}`);
  return parts.length > 0 ? parts.join(' · ') : 'No limits';
}

function TeamCard({ teams, teamsState, onOpenTeam, onOpenTeams }: { teams: TeamOverview | null; teamsState: RoutingTeamsState; onOpenTeam?(teamId: string | null): void; onOpenTeams?(): void }): JSX.Element {
  const running = runningTeams(teams);
  return <SectionCard title="Autonomous execution" subtitle="The team that works the board." className="routing-summary-card routing-execution-card">
    {running.length > 0 ? <ul className="routing-team-list" aria-label="Running teams">{running.map((team, index) => {
      const name = teamLabel(team);
      return <li className="routing-team" key={team.id ?? team.runtime.teamId ?? index}>
        <div className="routing-team-line">
          <span className="routing-team-avatar" aria-hidden="true">{memberInitials(name)}</span>
          <span className="routing-team-info"><span className="routing-team-name">{name}</span><span className="routing-team-count">{memberCountText(team)}</span></span>
          <span className="routing-running-pill"><span className="routing-running-dot" aria-hidden="true" />Running</span>
        </div>
        <button type="button" className="routing-link-button" aria-label={`Open ${name}`} onClick={() => onOpenTeam?.(team.id)}>Open team</button>
      </li>;
    })}</ul>
      : teamsState === 'loading'
        ? <p className="routing-summary-note">Loading teams…</p>
        : teamsState === 'error'
          ? <div className="routing-summary-empty"><p className="routing-summary-note">Teams are unavailable.</p><button type="button" className="routing-link-button" onClick={() => onOpenTeams?.()}>Open Teams</button></div>
          : teams !== null && !teams.runtimeState.available
            ? <div className="routing-summary-empty"><p className="routing-summary-note">Live team state is unavailable, so running teams cannot be shown.</p><button type="button" className="routing-link-button" onClick={() => onOpenTeams?.()}>Open Teams</button></div>
            : <div className="routing-summary-empty"><p className="routing-summary-note">No team is running. Tickets are not worked automatically until a team starts.</p><button type="button" className="routing-link-button" onClick={() => onOpenTeams?.()}>Open Teams</button></div>}
  </SectionCard>;
}

export function RoutingReadView({ settings, roleItems, teams = null, teamsState, onViewRole, onOpenTeam, onOpenTeams, canEdit = false, pending = false, editReason = null, hasFreeStatus = true, onEditRule, onAddRule, onEditWorktrees }: RoutingReadViewProps): JSX.Element {
  const state: RoutingTeamsState = teamsState ?? (teams === null ? 'loading' : 'ready');
  const activeTeams = runningTeams(teams);
  const runtimeUnavailable = teams !== null && !teams.runtimeState.available;
  const coverage = roleCoverage(settings, teams, roleItems);
  const warnings = configWarnings(settings);
  const editable = canEdit && !pending;
  const addReasonId = !hasFreeStatus ? 'routing-add-rule-reason' : !editable ? (editReason !== null ? 'routing-edit-reason' : undefined) : undefined;
  const addRule = onAddRule === undefined ? undefined : {
    label: 'Add rule',
    ariaLabel: 'Add rule',
    icon: 'plus' as const,
    onClick: onAddRule,
    disabled: !editable || !hasFreeStatus,
    descriptionId: !editable || !hasFreeStatus ? addReasonId : undefined,
  };
  return <div className="routing-read-view">
    {editReason !== null && <p id="routing-edit-reason" className="routing-edit-reason">{editReason}</p>}
    <div className="routing-summary-grid">
      <TeamCard teams={teams} teamsState={state} onOpenTeam={onOpenTeam} onOpenTeams={onOpenTeams} />
      <SectionCard
        title="Worktrees"
        subtitle="Where isolated work starts from."
        className="routing-summary-card routing-worktrees-card"
        action={onEditWorktrees === undefined ? undefined : {
          label: 'Edit',
          ariaLabel: 'Edit worktrees',
          onClick: onEditWorktrees,
          disabled: !editable,
          descriptionId: !editable && editReason !== null ? 'routing-edit-reason' : undefined,
        }}
      >
        <dl className="routing-worktree-list">
          <div><dt>Base branch</dt><dd><code className="routing-mono">{settings.worktree.baseBranch ?? 'unavailable'}</code></dd></div>
        </dl>
      </SectionCard>
      <SectionCard title="Role coverage" subtitle="Roles the rules use, and who fills them." className="routing-summary-card routing-coverage-card">
        {coverage.known ? <>
          <p className="routing-coverage-count">{`${coverage.filled} of ${coverage.total} roles have a member`}</p>
          {coverage.running ? <>
            {coverage.truncated
              ? <p className="routing-summary-note">The running team returned only part of its members, so a role without a member may still be filled.</p>
              : coverage.gaps.map(gap => <p className="routing-coverage-gap" key={gap.role}><Icon name="warning" size={14} tone="warning" />{`${gap.label} has no member in the running team, so tickets in ${gap.statuses.join(', ')} will wait.`}</p>)}
          </> : <p className="routing-summary-note">No team is running</p>}
        </> : <p className="routing-summary-note">{state === 'error' || runtimeUnavailable ? 'Role coverage is unavailable.' : 'Loading role coverage…'}</p>}
      </SectionCard>
    </div>

    <SectionCard title="Rules" subtitle="Each status has at most one rule. A ticket in that status is worked as described." className="routing-rules-card" action={addRule}>
      <div className="routing-rules-body">
        {!hasFreeStatus && <p id="routing-add-rule-reason" className="routing-edit-reason">Every status already has a rule.</p>}
        {warnings.length > 0 && <div className="routing-warnings">{warnings.map((warning, index) => <p className="routing-warning-note" key={index}><Icon name="warning" size={14} tone="warning" /><span>{warning}</span></p>)}</div>}
        {settings.rules.length > 0 ? <div className="routing-table-wrap" role="region" aria-label="Routing transitions (scrollable)" tabIndex={0}>
          <div className="routing-rules-inner">
            <div className="routing-rules-header">
              {['#', 'When a ticket is in', 'Then', 'If it passes', 'If it fails', 'Limits'].map(label => <span key={label}>{label}</span>)}
              <span aria-hidden="true" />
            </div>
            <ol className="routing-rules-list" aria-label="Routing transitions">{settings.rules.map(rule => {
              const protection = protectedState(settings, rule.status);
              const route = settings.protectedRoutes.find(candidate => candidate.status === rule.status);
              const member = roleMember(teams, rule.role);
              const missingEscalationHandler = rule.onFailureLimit !== null && !settings.rules.some(candidate => candidate.status === rule.onFailureLimit!.status);
              return <li className="routing-rule-row" key={rule.index} data-rule-index={rule.index}>
                <span className="routing-rule-index">{rule.index + 1}</span>
                <span className="routing-rule-cell">
                  <span className="routing-status-line"><StatusDot settings={settings} status={rule.status} /><span className="routing-status-name">{statusName(settings.statuses, rule.status)}</span></span>
                  <code className="routing-mono routing-status-id">{rule.status}</code>
                  {protection === 'protected' && <span className="routing-tag routing-tag-protected"><Icon name="lock" size={10} />Protected</span>}
                  {protection === 'needs-repair' && <>
                    <span className="routing-tag routing-tag-repair"><Icon name="warning" size={10} />Needs repair</span>
                    <span className="routing-repair-note">{`Change the rule for ${rule.status} to use role ${route?.role ?? 'the required role'}.`}</span>
                  </>}
                </span>
                <span className="routing-rule-cell">
                  {rule.type === 'agent' ? <>
                    <RoleCell role={rule.role} order={rule.index + 1} roleItems={roleItems} onViewRole={onViewRole} />
                    <code className="routing-mono routing-workflow">{workflowLabel(settings.workflows, rule.workflow)}</code>
                    {activeTeams.length > 0 && (member.member
                      ? <span className="routing-worked-by">{`Worked by ${memberName(member.member)}`}</span>
                      : member.known
                        ? <span className="routing-worked-by-missing"><Icon name="warning" size={12} tone="warning" />No member in the running team</span>
                        : <span className="routing-worked-by-unknown"><Icon name="warning" size={12} tone="warning" />Member for this role is unknown; the running team returned only part of its members.</span>)}
                  </> : <>
                    <span className="routing-action-name"><Icon name="git-branch" size={12} />{actionTitle(rule.action)}</span>
                    <span className="routing-rule-meta">Built-in action, no agent</span>
                  </>}
                </span>
                <span className="routing-rule-cell"><StatusChip settings={settings} status={rule.onPass} /></span>
                <span className="routing-rule-cell">
                  <StatusChip settings={settings} status={rule.onFail} />
                  {rule.onFailureLimit !== null && <span className="routing-rule-meta">{`After ${rule.onFailureLimit.count} ${rule.onFailureLimit.count === 1 ? 'fail' : 'fails'} → ${statusName(settings.statuses, rule.onFailureLimit.status)}`}</span>}
                  {missingEscalationHandler && <span className="routing-rule-warning">{`No rule starts from ${statusName(settings.statuses, rule.onFailureLimit!.status)}; escalated tickets wait there.`}</span>}
                  {rule.onBlocked !== null && <span className="routing-rule-meta">{`If blocked → ${statusName(settings.statuses, rule.onBlocked)}`}</span>}
                </span>
                <span className="routing-rule-cell">
                  <span className="routing-rule-meta">{rule.type === 'action' ? 'Runs on the board' : `${workspaceLabel(rule.workspace)}${rule.syncBase ? ' · sync base' : ''}`}</span>
                  <span className="routing-rule-meta">{limitText(rule)}</span>
                </span>
                <span className="routing-rule-action">
                  {onEditRule !== undefined && <button
                    type="button"
                    className="routing-edit-rule"
                    data-focus-rule={rule.index}
                    aria-label={`Edit rule ${rule.index + 1}, ${statusName(settings.statuses, rule.status)}`}
                    aria-describedby={!editable && editReason !== null ? 'routing-edit-reason' : undefined}
                    disabled={!editable}
                    onClick={() => onEditRule(rule.index)}
                  >Edit</button>}
                </span>
              </li>;
            })}</ol>
          </div>
        </div> : settings.board.state === 'ok' && <p className="panel-empty routing-rules-empty">This workspace board has no routing rules.</p>}
      </div>
    </SectionCard>

    <SectionCard title="Workflows" subtitle="Workflow availability used by the rules." className="routing-workflows-card">
      {settings.workflows.length > 0 ? <ul className="routing-workflow-list" aria-label="Workflow availability">{settings.workflows.map((workflow, index) => <li className="routing-workflow-item" key={`${workflow.name}:${index}`}>
        <div className="routing-workflow-line"><code className="routing-mono">{workflow.name}</code><span className="routing-workflow-kind">{workflow.builtin ? 'built-in' : 'workspace'}</span>{workflow.errors.length > 0 && <span className="routing-tag routing-tag-unavailable">unavailable</span>}</div>
        <p className="routing-workflow-roles">{`Roles: ${workflow.roles.length > 0 ? workflow.roles.join(', ') : 'none'}`}</p>
        {workflow.errors.map((error, errorIndex) => <p className="routing-workflow-error" key={errorIndex}>{workflowErrorText(error)}</p>)}
      </li>)}</ul> : <p className="panel-empty">No workflows were returned.</p>}
    </SectionCard>
  </div>;
}
