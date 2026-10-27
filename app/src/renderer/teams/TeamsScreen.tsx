import { useRef, useState, type JSX } from 'react';
import type { AgentCatalogList, ManagementApi, OverviewTeam, TeamOverview, Workspace } from '../api';
import { useDashboardSection, type DashboardSectionController } from '../dashboard/useDashboardSection';
import { ShellIcon } from '../shell/ShellIcon';
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
          <button type="button" className="refresh-button" aria-busy={busy} onClick={() => { void refreshAll(); }}>
            <ShellIcon name="refresh" />
            Refresh
          </button>
        </div>
      </header>
      {overview.state === 'ready' && notices.length > 0 && (
        <ul className="teams-notices" aria-label="Data notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="teams-layout">
        <section className="dashboard-panel teams-list-panel" aria-labelledby="teams-list-title">
          <h2 id="teams-list-title">Workspace teams</h2>
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
        {data !== null && selected !== null && <TeamDetailPanel team={selected.team} />}
        <AgentCatalogPanel section={agents} overview={data} />
      </div>
    </div>
  );
}

function TeamDetailPanel(props: { team: OverviewTeam }): JSX.Element {
  const { team } = props;
  return (
    <section className="dashboard-panel teams-detail" aria-labelledby="teams-detail-title">
      <h2 id="teams-detail-title">{teamLabel(team)}</h2>
      <p className="teams-detail-facts">
        <span>{memberCountText(team)}</span>
        <span>{`Runtime: ${RUNTIME_LABELS[team.runtime.state] ?? team.runtime.state}`}</span>
        {team.runtime.teamId !== null && <code className="entity-id">{team.runtime.teamId}</code>}
      </p>
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
            </tr>
          </thead>
          <tbody>
            {team.members.map((m, index) => {
              const source = memberSourceNote(m);
              const role = roleNote(m);
              return (
                <tr key={m.memberId ?? index}>
                  <td>
                    <span className="teams-member-name">{memberName(m)}</span>
                    {source !== null && <p className="teams-cell-note">{source}</p>}
                  </td>
                  <td>
                    {roleText(m)}
                    {role !== null && <p className="teams-role-description">{role}</p>}
                  </td>
                  <td>{memberProviderModel(m)}</td>
                  <td><span className="status-badge teams-presence">{presenceLabel(m.presence)}</span></td>
                  <td>{workText(m.work)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {team.membersTruncated && <p className="panel-note">{`Showing the first ${team.members.length} members.`}</p>}
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
