import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentCatalogList,
  AgentDef,
  ManagementApi,
  ManagementResult,
  MemberChanges,
  OverviewTeam,
  TeamOverview,
  Workspace,
} from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
import { MemberForm, TeamNameForm, WriteFeedbackView } from './TeamEditForms';
import {
  addMemberInput,
  canEditMember,
  canEditTeam,
  emptyMemberForm,
  errorFeedback,
  knownRoles,
  liveNote,
  memberChanges,
  memberFormInitial,
  nextStartSuffix,
  problemsSuffix,
  thrownError,
  uneditableNote,
  type MemberFormValues,
  type WriteFeedback,
} from './teamEditModel';
import {
  MAX_CATALOG_PROBLEMS,
  RUNTIME_LABELS,
  agentUsage,
  definitionBadge,
  memberCountText,
  memberName,
  memberProviderModel,
  memberSourceNote,
  orderTeams,
  overviewNotices,
  plural,
  presenceLabel,
  providerModelText,
  roleNote,
  roleText,
  teamKey,
  teamLabel,
  text,
  workText,
} from './teamsModel';

export interface TeamsScreenProps {
  workspace: Workspace;
  management: ManagementApi;
}

export interface TeamWrites {
  rename(team: OverviewTeam, name: string): Promise<boolean>;
  deleteTeam(team: OverviewTeam): Promise<boolean>;
  addMember(team: OverviewTeam, values: MemberFormValues): Promise<boolean>;
  updateMember(team: OverviewTeam, memberId: string, changes: MemberChanges): Promise<boolean>;
  removeMember(team: OverviewTeam, memberId: string): Promise<boolean>;
}

export function TeamsScreen(props: TeamsScreenProps): JSX.Element {
  return <TeamsOverview key={props.workspace.id} {...props} />;
}

function SectionError(props: { section: DashboardSectionController<unknown> }): JSX.Element | null {
  const { section } = props;
  if (section.error === null) return null;
  return (
    <div className="panel-error" role="alert">
      <p><code className="entity-id">{section.error.code}</code>: {section.error.message}</p>
      {typeof section.error.remediation === 'string' && section.error.remediation !== '' && (
        <p>{section.error.remediation}</p>
      )}
      <button type="button" onClick={() => { void section.reload(); }}>Retry</button>
    </div>
  );
}

function TeamsOverview(props: TeamsScreenProps): JSX.Element {
  const overview = useDashboardSection<TeamOverview>(props.management.overview, props.workspace.id);
  const agents = useDashboardSection<AgentCatalogList>(props.management.agents, props.workspace.id);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = refreshing || overview.loading || agents.loading;
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const writeLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function runWrite<T>(
    failTitle: string,
    call: () => Promise<ManagementResult<T>>,
    onOk: (data: T) => { text: string; selectKey?: string | null },
  ): Promise<boolean> {
    if (writeLock.current) return false;
    writeLock.current = true;
    setPending(true);
    setFeedback(null);
    let result: ManagementResult<T>;
    try {
      result = await call();
    } catch (reason) {
      result = { ok: false, error: thrownError(reason) };
    } finally {
      writeLock.current = false;
      if (mounted.current) setPending(false);
    }
    if (!mounted.current) return false;
    if (!result.ok) {
      setFeedback(errorFeedback(failTitle, result.error));
      return false;
    }
    const { text: message, selectKey } = onOk(result.data);
    setFeedback({ kind: 'success', text: message });
    if (selectKey !== undefined) setSelectedKey(selectKey);
    void overview.reload();
    return true;
  }

  const ws = props.workspace.id;
  const mgmt = props.management;
  const writes: TeamWrites = {
    rename: (team, name) => runWrite('Team was not renamed.', () => mgmt.renameTeam(ws, team.id!, name), (d) => ({
      text: `Renamed team to "${d.team.name}".${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    deleteTeam: (team) => runWrite('Team was not deleted.', () => mgmt.deleteTeam(ws, team.id!), () => ({
      text: `Deleted team "${teamLabel(team)}".`,
      selectKey: null,
    })),
    addMember: (team, values) => runWrite('Member was not added.', () => mgmt.addMember(ws, team.id!, addMemberInput(values)), (d) => ({
      text: `Added ${d.member.name} to ${teamLabel(team)}.${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    updateMember: (team, memberId, changes) => runWrite('Member was not saved.', () => mgmt.updateMember(ws, team.id!, memberId, changes), (d) => ({
      text: `Saved ${d.member.name}.${nextStartSuffix(d.appliesOnNextStart)}${problemsSuffix(d.problems)}`,
    })),
    removeMember: (team, memberId) => runWrite('Member was not removed.', () => mgmt.removeMember(ws, team.id!, memberId), (d) => ({
      text: `Removed ${d.removed.name} from ${teamLabel(team)}.${problemsSuffix(d.problems)}`,
    })),
  };

  async function createTeam(name: string): Promise<void> {
    const ok = await runWrite('Team was not created.', () => mgmt.createTeam(ws, { name }), (d) => ({
      text: `Created team "${d.team.name}".${problemsSuffix(d.problems)}`,
      selectKey: d.team.id,
    }));
    if (ok && mounted.current) setCreating(false);
  }

  async function refreshAll(): Promise<void> {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    try {
      await Promise.all([overview.reload(), agents.reload()]);
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }

  const data = overview.state === 'ready' ? overview.data : null;
  const ordered = data === null
    ? []
    : orderTeams(data.teams.map((team, index) => ({ key: teamKey(team, index), team })));
  const selected = ordered.find((item) => item.key === selectedKey) ?? ordered[0] ?? null;
  const notices = data === null ? [] : overviewNotices(data);

  return (
    <div className="teams-screen" data-section="teams">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <nav className="breadcrumb" aria-label="Breadcrumb"><ol><li>Workspace</li><li aria-current="page">Teams</li></ol></nav>
          <h1>Teams</h1>
          <p className="teams-subtitle">Teams and reusable agents defined in this workspace.</p>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="teams-new-button" disabled={pending} onClick={() => setCreating(true)}>
            New team
          </button>
          <button type="button" className="refresh-button" aria-busy={busy} onClick={() => { void refreshAll(); }}>
            <ShellIcon name="refresh" />
            Refresh
          </button>
        </div>
      </header>
      <WriteFeedbackView feedback={feedback} onDismiss={() => setFeedback(null)} />
      {overview.state === 'ready' && notices.length > 0 && (
        <ul className="teams-notices" aria-label="Data notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="teams-layout">
        <section className="dashboard-panel teams-list-panel" aria-labelledby="teams-list-title">
          <h2 id="teams-list-title">Workspace teams</h2>
          {creating && (
            <TeamNameForm
              heading="New team"
              submitLabel="Create team"
              initialName=""
              pending={pending}
              onSubmit={(name) => { void createTeam(name); }}
              onCancel={() => setCreating(false)}
            />
          )}
          {overview.state === 'loading' && <p className="panel-loading" role="status">Loading teams…</p>}
          {overview.state === 'error' && <SectionError section={overview} />}
          {data !== null && ordered.length === 0 && (
            <p className="panel-empty">No teams defined in this workspace.</p>
          )}
          {data !== null && selected !== null && (
            <ul className="teams-card-list">
              {ordered.map((item) => {
                const { team } = item;
                const badge = definitionBadge(team);
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="teams-card"
                      aria-pressed={item.key === selected.key}
                      onClick={() => setSelectedKey(item.key)}
                    >
                      <span className="teams-card-name">{teamLabel(team)}</span>
                      <span className={`status-badge teams-runtime teams-runtime-${team.runtime.state}`}>
                        {RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}
                      </span>
                      <span className="teams-card-facts">{memberCountText(team)}</span>
                      {badge !== null && <span className="status-badge teams-definition">{badge}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {data !== null && selected !== null && (
          <TeamDetailPanel
            key={selected.key}
            team={selected.team}
            overview={data}
            agents={agents.state === 'ready' && agents.data !== null ? agents.data.agents : null}
            writes={writes}
            pending={pending}
          />
        )}
        <AgentCatalogPanel section={agents} overview={data} />
      </div>
    </div>
  );
}

function TeamDetailPanel(props: {
  team: OverviewTeam;
  overview: TeamOverview;
  agents: AgentDef[] | null;
  writes: TeamWrites;
  pending: boolean;
}): JSX.Element {
  const { team, overview, agents, writes, pending } = props;
  const [teamForm, setTeamForm] = useState<'rename' | 'delete' | null>(null);
  const [memberForm, setMemberForm] = useState<{ mode: 'add' } | { mode: 'edit'; memberId: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const editable = canEditTeam(team);
  const unNote = uneditableNote(team);
  const runNote = liveNote(team);
  const editing = memberForm?.mode === 'edit'
    ? team.members.find((m) => m.memberId === memberForm.memberId) ?? null
    : null;
  return (
    <section className="dashboard-panel teams-detail" aria-labelledby="teams-detail-title">
      <h2 id="teams-detail-title">{teamLabel(team)}</h2>
      <p className="teams-detail-facts">
        <span>{memberCountText(team)}</span>
        <span>{`Runtime: ${RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}`}</span>
        {team.runtime.teamId !== null && <code className="entity-id">{team.runtime.teamId}</code>}
      </p>
      {unNote !== null && <p className="panel-note">{unNote}</p>}
      {runNote !== null && <p className="panel-note">{runNote}</p>}
      {editable && (
        <div className="teams-team-actions">
          <button type="button" disabled={pending} onClick={() => setTeamForm('rename')}>Rename team</button>
          <button type="button" disabled={pending} onClick={() => setTeamForm('delete')}>Delete team</button>
          <button type="button" disabled={pending} onClick={() => setMemberForm({ mode: 'add' })}>Add member</button>
        </div>
      )}
      {teamForm === 'rename' && (
        <TeamNameForm
          heading="Rename team"
          submitLabel="Save name"
          initialName={team.name ?? ''}
          pending={pending}
          onSubmit={(name) => { void writes.rename(team, name).then((ok) => { if (ok) setTeamForm(null); }); }}
          onCancel={() => setTeamForm(null)}
        />
      )}
      {teamForm === 'delete' && (
        <div className="teams-confirm" role="group" aria-label="Confirm team deletion">
          <p>{`Delete team "${teamLabel(team)}"? Its definition file is removed.`}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => { void writes.deleteTeam(team).then((ok) => { if (ok) setTeamForm(null); }); }}
          >
            Confirm delete
          </button>
          <button type="button" onClick={() => setTeamForm(null)}>Cancel</button>
        </div>
      )}
      {team.definition.problems.length > 0 && (
        <ul className="teams-problems" aria-label="Definition problems">
          {team.definition.problems.map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
        </ul>
      )}
      {team.members.length === 0 ? (
        <p className="panel-empty">This team has no members.</p>
      ) : (
        <table className="teams-members-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Role</th>
              <th scope="col">Provider / model</th>
              <th scope="col">Status</th>
              <th scope="col">Current work</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {team.members.map((m, index) => {
              const source = memberSourceNote(m);
              const role = roleNote(m);
              const name = memberName(m);
              const memberId = m.memberId;
              return (
                <tr key={memberId ?? index}>
                  <td>
                    <span className="teams-member-name">{name}</span>
                    {source !== null && <p className="teams-cell-note">{source}</p>}
                  </td>
                  <td>
                    {roleText(m)}
                    {role !== null && <p className="teams-role-description">{role}</p>}
                  </td>
                  <td>{memberProviderModel(m)}</td>
                  <td><span className="status-badge teams-presence">{presenceLabel(m.presence)}</span></td>
                  <td>{workText(m.work)}</td>
                  <td className="teams-member-actions">
                    {memberId !== null && canEditMember(team, m) && (confirmRemove === memberId ? (
                      <>
                        <button
                          type="button"
                          aria-label={`Confirm remove ${name}`}
                          disabled={pending}
                          onClick={() => {
                            void writes.removeMember(team, memberId).then((ok) => { if (ok) setConfirmRemove(null); });
                          }}
                        >
                          Confirm remove
                        </button>
                        <button type="button" aria-label={`Cancel removing ${name}`} onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Edit ${name}`}
                          disabled={pending}
                          onClick={() => setMemberForm({ mode: 'edit', memberId })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${name}`}
                          disabled={pending}
                          onClick={() => setConfirmRemove(memberId)}
                        >
                          Remove
                        </button>
                      </>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {team.membersTruncated && <p className="panel-note">{`Showing the first ${team.members.length} members.`}</p>}
      {memberForm?.mode === 'add' && (
        <MemberForm
          mode="add"
          heading="Add member"
          initial={emptyMemberForm()}
          inlineProvider={null}
          agents={agents}
          roles={knownRoles(overview)}
          pending={pending}
          onSubmit={(values) => { void writes.addMember(team, values).then((ok) => { if (ok) setMemberForm(null); }); }}
          onCancel={() => setMemberForm(null)}
        />
      )}
      {editing !== null && memberForm?.mode === 'edit' && (
        <MemberForm
          key={memberForm.memberId}
          mode="edit"
          heading={`Edit ${memberName(editing)}`}
          initial={memberFormInitial(editing)}
          inlineProvider={editing.source === 'inline' ? (editing.provider ?? 'unknown') : null}
          agents={agents}
          roles={knownRoles(overview)}
          pending={pending}
          onSubmit={(values) => {
            const changes = memberChanges(memberFormInitial(editing), values);
            if (changes === null) return;
            void writes.updateMember(team, memberForm.memberId, changes).then((ok) => { if (ok) setMemberForm(null); });
          }}
          onCancel={() => setMemberForm(null)}
        />
      )}
    </section>
  );
}

function AgentCatalogPanel(props: {
  section: DashboardSectionController<AgentCatalogList>;
  overview: TeamOverview | null;
}): JSX.Element {
  const { section, overview } = props;
  const data = section.state === 'ready' ? section.data : null;
  const problems = data?.problems ?? [];
  return (
    <section className="dashboard-panel teams-catalog" aria-labelledby="teams-catalog-title">
      <h2 id="teams-catalog-title">Agent catalog</h2>
      {section.state === 'loading' && <p className="panel-loading" role="status">Loading agent catalog…</p>}
      {section.state === 'error' && <SectionError section={section} />}
      {data !== null && (
        <>
          {problems.length > 0 && (
            <div className="panel-note teams-catalog-problems">
              <p>agents.json has problems:</p>
              <ul>
                {problems.slice(0, MAX_CATALOG_PROBLEMS).map((p, i) => <li key={i}>{`${p.path}: ${p.message}`}</li>)}
              </ul>
              {problems.length > MAX_CATALOG_PROBLEMS && (
                <p>{`…and ${plural(problems.length - MAX_CATALOG_PROBLEMS, 'more problem', 'more problems')}`}</p>
              )}
            </div>
          )}
          {data.agents.length === 0 ? (
            <p className="panel-empty">No reusable agents defined.</p>
          ) : (
            <ul className="teams-catalog-list">
              {data.agents.map((a, index) => {
                const id = text(a.id);
                const reasoning = text(a.reasoning);
                return (
                  <li key={id ?? index} className="teams-agent">
                    <h3 className="teams-agent-name">{text(a.name) ?? id ?? 'Unnamed agent'}</h3>
                    {id !== null && <code className="entity-id">{id}</code>}
                    <p className="teams-agent-meta">
                      <span>{providerModelText(text(a.provider), text(a.model))}</span>
                      {reasoning !== null && <span>{`Reasoning: ${reasoning}`}</span>}
                    </p>
                    <p className="teams-agent-description">{text(a.description) ?? 'No description'}</p>
                    <p className="teams-agent-usage">{agentUsage(overview, id)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
