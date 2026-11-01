import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { AgentDef, OverviewMember, OverviewTeam } from '../api';
import { Icon } from '../icons/Icon';
import { Dialog } from './Dialog';
import { addAgentOption, moveAgentOption, removeAgentOption, validateAgentOptions, type ErrorFeedback, type TeamWrites } from './teamEditModel';
import {
  AGENT_OPTIONS_FOOTER, AGENT_OPTIONS_INTRO, INLINE_AGENT_EXPLANATION,
  agentMeta, agentOptionRow, initialAgentOptions, inlineAgentSummary, isInlineAgentMember, missingAgentIds,
} from './agentOptionsModel';

export interface AgentOptionsDialogProps {
  team: OverviewTeam;
  member: OverviewMember;
  /** Agents catalog, or null when it is unavailable or stale. */
  catalog: readonly AgentDef[] | null;
  /** A team write is in flight; the dialog stays open and ignores Escape. */
  pending: boolean;
  readOnly: boolean;
  writes: TeamWrites;
  onManageAgents?(): void;
  onClose(): void;
  onSaved(): void;
}

type FocusTarget =
  | { kind: 'move-up' | 'move-down' | 'remove'; id: string }
  | { kind: 'next-remove'; index: number }
  | 'add';

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The v7 Edit agent options dialog. It edits only the ordered saved agent id
 * list and saves it through `writes.updateMember(team, memberId, { agents })`.
 */
export function AgentOptionsDialog(props: AgentOptionsDialogProps): JSX.Element {
  const { team, member, catalog, writes } = props;
  const uid = useId();
  const memberId = member.memberId ?? '';
  const initial = useRef(initialAgentOptions(member));
  const [draft, setDraft] = useState<string[]>(initial.current);
  const [useCatalogAgents, setUseCatalogAgents] = useState(() => !isInlineAgentMember(member));
  const [failure, setFailure] = useState<ErrorFeedback | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (failure !== null) errorRef.current?.focus(); }, [failure]);

  useEffect(() => {
    if (focusTarget === null) return;
    let element: HTMLElement | null = null;
    if (focusTarget === 'add') {
      element = document.querySelector<HTMLElement>('.member-agent-options-dialog [data-action="add"]');
    } else if (focusTarget.kind === 'next-remove') {
      const index = Math.min(focusTarget.index, draft.length - 1);
      const id = index >= 0 ? draft[index] : undefined;
      const row = id === undefined ? undefined : rows.current.get(id);
      const removeButton = row?.querySelector<HTMLButtonElement>('[data-action="remove"]') ?? null;
      element = removeButton !== null && !removeButton.disabled
        ? removeButton
        : row?.querySelector<HTMLElement>('button:not([disabled])') ?? null;
      if (element === null) element = document.querySelector<HTMLElement>('.member-agent-options-dialog [data-action="add"]');
    } else {
      const row = rows.current.get(focusTarget.id);
      const direct = row?.querySelector<HTMLElement>(`[data-action="${focusTarget.kind}"]`) ?? null;
      // A move can disable the control it was pressed on (up on the first row),
      // so fall back to another control in the same row instead of losing focus.
      element = direct !== null && !(direct as HTMLButtonElement).disabled
        ? direct
        : row?.querySelector<HTMLElement>('button:not([disabled])') ?? null;
    }
    if (element !== null && element.isConnected) { element.focus(); setFocusTarget(null); }
  }, [draft, focusTarget]);

  function nameOf(id: string): string {
    return agentOptionRow(id, member, catalog).name;
  }

  function move(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const id = draft[index]!;
    setDraft(current => moveAgentOption(current, index, delta));
    setAnnouncement(`${nameOf(id)} moved to position ${target + 1}`);
    setFocusTarget({ kind: delta === -1 ? 'move-up' : 'move-down', id });
    setFailure(null);
  }

  function remove(index: number): void {
    if (draft.length <= 1) return;
    const id = draft[index]!;
    setDraft(current => removeAgentOption(current, index));
    setAnnouncement(`Removed ${nameOf(id)}.`);
    setFocusTarget({ kind: 'next-remove', index });
    setFailure(null);
  }

  function add(agent: AgentDef): void {
    setDraft(current => addAgentOption(current, agent.id));
    setAnnouncement(`Added ${agent.name}.`);
    setFocusTarget('add');
    setFailure(null);
  }

  const missing = missingAgentIds(draft, catalog);
  const validation = useCatalogAgents ? validateAgentOptions(draft, missing) : null;
  const catalogBlocked = useCatalogAgents && catalog === null;
  const unchanged = sameOrder(draft, initial.current);
  const saveDisabled = unchanged || validation !== null || catalogBlocked || props.pending || props.readOnly;
  const inline = inlineAgentSummary(member);
  const available = useCatalogAgents ? (catalog ?? []).filter((agent) => !draft.includes(agent.id)) : [];
  const validationId = `${uid}-validation`;

  function save(): void {
    if (saveDisabled) return;
    setFailure(null);
    void writes.updateMember(team, memberId, { agents: [...draft] }, { inlineFailure: true }).then(outcome => {
      if (outcome.ok) { props.onSaved(); return; }
      if (outcome.feedback !== null) setFailure(outcome.feedback);
    });
  }

  return <Dialog
    title="Edit agent options"
    width={600}
    busy={props.pending}
    onClose={props.onClose}
    footerNote={AGENT_OPTIONS_FOOTER}
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: 'Save', variant: 'primary', disabled: saveDisabled, onClick: save },
    ]}
    className="member-agent-options-dialog"
  >
    <p className="member-agent-options-intro">{AGENT_OPTIONS_INTRO}</p>
    {!useCatalogAgents ? <div className="member-agent-options-inline">
      <p className="member-agent-options-inline-agent">
        <span className="member-agent-options-mark" aria-hidden="true">{inline.mark}</span>
        <span className="member-agent-options-text">
          <span className="member-agent-options-name">Inline agent</span>
          <span className="member-agent-options-meta">{inline.meta}</span>
        </span>
      </p>
      <p className="member-agent-options-note">{INLINE_AGENT_EXPLANATION}</p>
      <button type="button" className="member-agent-options-use-catalog" disabled={props.pending || props.readOnly} onClick={() => setUseCatalogAgents(true)}>Use catalog agents</button>
    </div> : <>
      <ol className="member-agent-options-list" aria-label="Agent options" aria-describedby={validation !== null ? validationId : undefined}>
        {draft.map((id, index) => {
          const row = agentOptionRow(id, member, catalog);
          return <li
            key={id}
            className="member-agent-options-row"
            data-agent-id={id}
            ref={element => { if (element === null) rows.current.delete(id); else rows.current.set(id, element); }}
          >
            <span className="member-agent-options-position">{index + 1}</span>
            <span className="member-agent-options-mark" aria-hidden="true">{row.mark}</span>
            <span className="member-agent-options-text">
              <span className="member-agent-options-name">
                {row.name}
                {index === 0 && <span className="member-agent-options-tag is-default">Default</span>}
                {row.missing && <span className="member-agent-options-tag is-missing">Missing from catalog</span>}
              </span>
              <span className="member-agent-options-meta">{row.meta}</span>
            </span>
            <button type="button" className="member-agent-options-icon" data-action="move-up" aria-label={`Move ${row.name} up`} disabled={props.pending || props.readOnly || index === 0} onClick={() => move(index, -1)}><Icon name="chevron-up" size={14} /></button>
            <button type="button" className="member-agent-options-icon" data-action="move-down" aria-label={`Move ${row.name} down`} disabled={props.pending || props.readOnly || index === draft.length - 1} onClick={() => move(index, 1)}><Icon name="chevron-down" size={14} /></button>
            <button type="button" className="member-agent-options-icon is-danger" data-action="remove" aria-label={`Remove ${row.name}`} disabled={props.pending || props.readOnly || draft.length === 1} onClick={() => remove(index)}><Icon name="trash" size={14} /></button>
          </li>;
        })}
      </ol>
      {validation !== null && <p className="member-agent-options-validation" id={validationId} role="alert">{validation}</p>}
      {!validation && catalogBlocked && <p className="member-agent-options-validation" id={validationId} role="alert">Agent catalog unavailable; options cannot be saved.</p>}
      {available.map(agent => <button
        key={agent.id}
        type="button"
        className="member-agent-options-add"
        data-action="add"
        data-agent-id={agent.id}
        disabled={props.pending || props.readOnly}
        onClick={() => add(agent)}
      >
        <Icon name="plus" size={14} />
        <span className="member-agent-options-text">
          <span className="member-agent-options-name">{`Add ${agent.name}`}</span>
          <span className="member-agent-options-meta">{agentMeta(agent.provider, agent.model ?? null, agent.reasoning ?? null)}</span>
        </span>
      </button>)}
      {catalog !== null && available.length === 0 && draft.length > 0 && <p className="member-agent-options-note">All catalog agents are already options.</p>}
      {props.onManageAgents !== undefined && <button type="button" className="member-agent-options-manage" onClick={props.onManageAgents}>Manage Agents catalog</button>}
    </>}
    <p className="teams-visually-hidden" aria-live="polite">{announcement}</p>
    {failure !== null && <div ref={errorRef} className="member-agent-options-error" role="alert" tabIndex={-1}>
      <p><strong>{failure.title}</strong></p>
      <p><code className="entity-id">{failure.code}</code>: {failure.message}</p>
      {failure.remediation !== null && <p>{failure.remediation}</p>}
      {failure.hint !== null && <p>{failure.hint}</p>}
      {failure.problems.length > 0 && <ul aria-label="Validation problems">{failure.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
    </div>}
  </Dialog>;
}
