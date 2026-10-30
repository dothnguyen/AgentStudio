import { useId, useState, type JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam, RoleCatalogItem } from '../api';
import type { TeamWrites } from './TeamsScreen';
import { memberAgentActions, memberActionKey, type MemberActionInFlight } from './memberAgentActionsModel';
import { MemberForm } from './TeamEditForms';
import { canEditMember, findCatalogRole, memberChanges, memberFormInitial } from './teamEditModel';
import { memberName, memberSourceNote, roleNote, roleText, savedAgentOptionText, providerModelText, liveAgentText, presenceTone, presenceLabel, workText } from './teamsModel';

export interface MemberDetailPanelProps {
  team: OverviewTeam; member: OverviewMember; agents: AgentDef[] | null; roleItems: RoleCatalogItem[] | null; roleCatalogMessage: string | null;
  onViewRole?(roleId: string): void; writes: TeamWrites; pending: boolean; connected: boolean;
  actions: Record<string, MemberActionInFlight>; polling: Record<string, boolean>;
  onSwitch(team: OverviewTeam, member: OverviewMember, id: string, label: string, trigger: HTMLButtonElement): void;
  onResume(team: OverviewTeam, member: OverviewMember, id: string, label: string): void; onBack(): void;
}
export function MemberDetailPanel(props: MemberDetailPanelProps): JSX.Element {
  const { team, member, agents, writes, pending } = props;
  const headingId = useId();
  const [memberForm, setMemberForm] = useState<{ mode: 'edit'; memberId: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const editing = memberForm ? member : null;
  return <section className="teams-member-detail" aria-labelledby={headingId}>
    <button type="button" onClick={props.onBack}>Back to members</button>
    <h3 id={headingId}>{memberName(member)}</h3>
          <p className="panel-note">Member role changes apply the next time the team starts. Edits to shared role instructions apply to new assignments and do not change current assignments.</p>
          <table className="teams-members-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Role</th>
                <th scope="col">Saved options</th>
                <th scope="col">Live agent</th>
                <th scope="col">Status</th>
                <th scope="col">Current work</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {[member].map((m, index) => {
                const source = memberSourceNote(m);
                const role = roleNote(m);
                const catalogRole = m.roleState === 'undefined' || props.roleItems === null ? null : findCatalogRole(props.roleItems, m.role);
                const name = memberName(m);
                const memberId = m.memberId;
                return (
                  <tr key={memberId ?? index}>
                    <td>
                      <span className="teams-member-name">{name}</span>
                      {source !== null && <p className="teams-cell-note">{source}</p>}
                    </td>
                    <td>
                      {catalogRole === null ? (
                        <>
                          {roleText(m)}
                          {role !== null && <p className="teams-role-description">{role}</p>}
                        </>
                      ) : (
                        <>
                          <span className="teams-role-name">{catalogRole.name}</span>
                          {catalogRole.id !== catalogRole.name && <code className="entity-id">{catalogRole.id}</code>}
                          <p className="teams-role-description">{catalogRole.description ?? 'No description'}</p>
                          {props.onViewRole !== undefined && (
                            <button type="button" onClick={() => props.onViewRole?.(catalogRole.id)}>{`View ${catalogRole.name} in Roles`}</button>
                          )}
                        </>
                      )}
                    </td>
                    <td>{m.source === 'runtime' ? 'Not available' : m.agentMode === 'inline'
                      ? `Inline — ${providerModelText(m.provider, m.model)}${m.reasoning ? ` · Reasoning: ${m.reasoning}` : ''}`
                      : <ol>{m.agentOptions.map((option, i) => <li key={`${option.id}-${i}`}>{savedAgentOptionText(option, i)}</li>)}</ol>}</td>
                    <td>{liveAgentText(m)}{(() => {
                      const view = memberAgentActions(team, m, agents, props.connected, memberId ? props.actions[memberActionKey(team.id ?? '', memberId)] ?? null : null);
                      if (!view.visible) return null;
                      return <section className="teams-live-actions" aria-label={`Live agent actions for ${name}`}><h4>Live agent actions</h4><p>{view.activeText}</p><p>{view.availabilityText}</p><p>{view.assignmentText}</p>{view.pendingText && <p>{view.pendingText}</p>}{view.lastResultText && <p>{view.lastResultText}</p>}{view.notice && <p>{view.notice}</p>}{memberId && props.actions[memberActionKey(team.id ?? '', memberId)] && !props.polling[memberActionKey(team.id ?? '', memberId)] && <p role="status">Requesting…</p>}<ul>{view.options.map(option => <li key={option.id}><span>{option.label}{option.active && ' · Active'}{option.holdText && ` · ${option.holdText}`}</span>{!option.active && m.runtime?.configuredAgents?.includes(option.id) && <button type="button" disabled={!option.canSwitch || !team.id || !memberId} onClick={e => props.onSwitch(team, m, option.id, option.label, e.currentTarget)}>Switch</button>}{option.holdText && <button type="button" disabled={!option.canResume || !team.id || !memberId} onClick={() => props.onResume(team, m, option.id, option.label)}>Resume</button>}{option.disabledReason && !(memberId && props.polling[memberActionKey(team.id ?? '', memberId)] && option.disabledReason === 'Requesting…') && <p className="teams-live-reason">{option.disabledReason}</p>}</li>)}</ul></section>;
                    })()}</td>
                    <td>
                      <span className={`status-badge teams-presence teams-tone-${presenceTone(m.presence)}`}>
                        <span className="status-dot" aria-hidden="true" />
                        {presenceLabel(m.presence)}
                      </span>
                    </td>
                    <td>{workText(m.work)}</td>
                    <td className="teams-member-actions">
                      {memberId !== null && canEditMember(team, m) && (confirmRemove === memberId ? (
                        <>
                          <button
                            type="button"
                            aria-label={`Confirm remove ${name}`}
                            disabled={pending}
                            onClick={() => {
                              void writes.removeMember(team, memberId).then((ok) => { if (ok) { setConfirmRemove(null); props.onBack(); } });
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
        {editing !== null && memberForm?.mode === 'edit' && (
          <MemberForm
            key={memberForm.memberId}
            mode="edit"
            heading={`Edit ${memberName(editing)}`}
            initial={memberFormInitial(editing)}
            originalOptions={editing.agentOptions}
            inlineContext={editing.agentMode === 'inline' ? { provider: editing.provider, model: editing.model, reasoning: editing.reasoning } : null}
            agents={agents}
            roles={props.roleItems}
            roleCatalogMessage={props.roleCatalogMessage}
            pending={pending}
            onSubmit={(values) => {
              const changes = memberChanges(memberFormInitial(editing), values);
              if (changes === null) return;
              void writes.updateMember(team, memberForm.memberId, changes).then((ok) => { if (ok) setMemberForm(null); });
            }}
            onCancel={() => setMemberForm(null)}
          />
        )}
  </section>;
}
