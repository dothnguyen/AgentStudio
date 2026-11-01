import { useEffect, useId, useRef, type JSX } from 'react';
import type { BoardSettings, ManagementError, Problem, RoleCatalogItem } from '../../shared/management';
import { Dialog, type DialogAction } from './Dialog';
import { Icon } from '../icons/Icon';
import {
  addRule,
  boardSettingsChanges,
  isActionRule,
  isRuleFieldProblem,
  removeRuleFailureLimit,
  ruleStatus,
  setRuleFailureLimit,
  setRuleSyncBase,
  unusedStatuses,
  updateFailureLimit,
  updateRuleField,
  type NewRuleKind,
  type RoutingDraft,
} from './routingSettingsModel';
import { protectedState, statusName } from './routingViewModel';
import {
  problemsAt,
  roleOptions,
  RoutingDialogFailure,
  RoutingDialogProblemText,
  RoutingDialogSection,
  RoutingDialogSelect,
  RoutingDialogSummary,
  statusOptions,
  workflowOptions,
  workspaceOptions,
} from './RoutingDialogParts';

export type RoutingRuleDialogMode = 'edit' | 'add';

export interface RoutingRuleDialogProps {
  mode: RoutingRuleDialogMode;
  settings: BoardSettings;
  draft: RoutingDraft;
  /** Index of the rule in the draft (the appended rule in add mode). */
  index: number;
  problems: Problem[];
  pending: boolean;
  saved: boolean;
  editable: boolean;
  connected: boolean;
  roleItems: RoleCatalogItem[] | null;
  error: ManagementError | null;
  reloadError: ManagementError | null;
  alert?: boolean;
  onDraftChange(draft: RoutingDraft): void;
  onSave(): void;
  onRemove?(): void;
  onClose(): void;
  onReloadLatest(): void;
  onRetryLatest(): void;
}

const valueOf = (value: unknown): string => typeof value === 'string' ? value : '';
const objectOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The v1 routing dialog: one rule (edit) or one new rule (add). */
export function RoutingRuleDialog(props: RoutingRuleDialogProps): JSX.Element {
  const { mode, settings, draft, index, problems, pending, saved, editable, connected, roleItems, error, reloadError, alert = true } = props;
  const uid = useId();
  const id = (name: string): string => `${uid}-${name}`;
  const failureRef = useRef<HTMLInputElement>(null);
  const focusFailure = useRef(false);
  const rule = draft.rules[index];
  const when = objectOf(rule?.when);
  const status = valueOf(when.status);
  const agent = !isActionRule(rule);
  const protection = protectedState(settings, status);
  // A new rule for a free protected status is not a protected route yet; the
  // backend checks the role it is given. Only an existing protected rule locks.
  const protectedRoute = mode === 'edit' && protection !== null;
  const failure = rule && 'onFailureLimit' in rule;
  const policy = objectOf(rule?.onFailureLimit);
  const count = typeof policy.count === 'number' ? policy.count : Number.NaN;
  const target = valueOf(policy.status);
  const blocked = valueOf(rule?.onBlocked);
  const workspace = valueOf(rule?.workspace);
  const syncBase = rule?.syncBase === true;
  const disabled = !editable || pending || saved;
  const conflict = error?.code === 'CONFIG_CHANGED';
  const changes = boardSettingsChanges(draft, settings);
  const canSave = editable && !pending && !saved && !conflict && problems.length === 0 && changes !== null;
  const summary = problems.filter(problem => !isRuleFieldProblem(problem.path, index, agent, mode === 'add'));
  const fieldProblems = (path: string): Problem[] => problemsAt(problems, `rules[${index}].${path}`);
  const statusChoices = settings.statuses.filter(candidate => candidate.id === status || unusedStatuses(draft, settings).includes(candidate.id));
  const baseBranch = settings.worktree.baseBranch?.trim() || 'main';
  const protectedNoteId = id('protected-note');
  useEffect(() => {
    if (failure && focusFailure.current) {
      focusFailure.current = false;
      failureRef.current?.focus();
    }
  }, [failure]);

  function changeKind(kind: NewRuleKind): void {
    if ((kind === 'action') === !agent) return;
    const source = ruleStatus(rule);
    if (source === null) return;
    const previous = { ...draft, rules: draft.rules.slice(0, index) };
    props.onDraftChange(addRule(previous, settings, source, kind));
  }

  const leadingActions: DialogAction[] | undefined = mode === 'edit' && props.onRemove !== undefined
    ? [{
      label: 'Remove rule',
      variant: 'danger',
      icon: 'trash',
      disabled: protectedRoute || pending || saved || !editable,
      descriptionId: protectedRoute ? protectedNoteId : undefined,
      onClick: props.onRemove,
    }]
    : undefined;

  return <Dialog
    title={mode === 'add' ? 'Add rule' : `Edit rule ${index + 1}`}
    subtitle={mode === 'add' ? 'Choose the status the rule is for and what happens to tickets in it.' : `When a ticket is in ${statusName(settings.statuses, status)}`}
    width={720}
    busy={pending || saved}
    onClose={props.onClose}
    leadingActions={leadingActions}
    footerNote={protectedRoute ? 'Protected routes cannot be removed' : 'Applies to every team using this board'}
    actions={[
      { label: 'Cancel', onClick: props.onClose },
      { label: mode === 'add' ? 'Add rule' : 'Save rule', variant: 'primary', disabled: !canSave, onClick: props.onSave },
    ]}
    className="routing-dialog routing-rule-dialog"
  >
    <RoutingDialogFailure error={error} reloadError={reloadError} pending={pending} connected={connected} alert={alert} onReloadLatest={props.onReloadLatest} onRetryLatest={props.onRetryLatest} />
    <RoutingDialogSummary problems={summary} alert={alert && error === null && reloadError === null} />

    {protectedRoute && <div className="routing-dialog-note" id={protectedNoteId}>
      <Icon name="lock" size={14} />
      <span>This is a protected route. Its workflow and workspace are fixed so merge conflicts keep being resolved; you can still change the role and what happens next.</span>
    </div>}

    {mode === 'add' && <RoutingDialogSection title="When a ticket is in" divided={false}>
      <RoutingDialogSelect
        id={id('status')}
        label="Status"
        value={status}
        options={statusOptions({ ...settings, statuses: settings.statuses.filter(candidate => statusChoices.some(choice => choice.id === candidate.id)) })}
        disabled={disabled}
        problems={fieldProblems('when.status')}
        hint="Only statuses without a rule are listed."
        onChange={value => props.onDraftChange(updateRuleField(draft, index, 'status', value))}
      />
      <div role="radiogroup" aria-label="What happens" className="routing-dialog-options">
        <button type="button" role="radio" aria-checked={agent} disabled={disabled} className="routing-dialog-option" onClick={() => changeKind('agent')}>
          <span className="routing-dialog-radio" aria-hidden="true" />
          <span className="routing-dialog-option-text"><span className="routing-dialog-option-title">An agent works it</span><span className="routing-dialog-option-hint">A member with the chosen role runs a workflow.</span></span>
        </button>
        <button type="button" role="radio" aria-checked={!agent} disabled={disabled} className="routing-dialog-option" onClick={() => changeKind('action')}>
          <span className="routing-dialog-radio" aria-hidden="true" />
          <span className="routing-dialog-option-text"><span className="routing-dialog-option-title">Built-in action: merge</span><span className="routing-dialog-option-hint">The board merges the work. No agent involved.</span></span>
        </button>
      </div>
    </RoutingDialogSection>}

    <RoutingDialogSection title="Then" divided={mode === 'edit'}>
      {agent ? <>
        <div className="routing-dialog-grid">
          <RoutingDialogSelect id={id('role')} label="Role" value={valueOf(rule?.role)} options={roleOptions(settings, roleItems, valueOf(rule?.role))} disabled={disabled} problems={fieldProblems('role')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'role', value))} />
          <RoutingDialogSelect id={id('workflow')} label="Workflow" mono value={valueOf(rule?.workflow)} options={workflowOptions(settings, valueOf(rule?.workflow))} disabled={disabled || protectedRoute} problems={fieldProblems('workflow')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'workflow', value))} />
          <RoutingDialogSelect id={id('workspace')} label="Works in" value={workspace} options={workspaceOptions(workspace)} disabled={disabled || protectedRoute} problems={fieldProblems('workspace')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'workspace', value))} />
        </div>
        {workspace === 'worktree' && <div className="routing-dialog-switch-row">
          <span className="routing-dialog-switch-text">
            <span className="routing-dialog-switch-title">Sync the base branch first</span>
            <span className="routing-dialog-switch-hint">{`Bring the worktree up to date with ${baseBranch} before the agent starts.`}</span>
          </span>
          <button type="button" role="switch" aria-checked={syncBase} aria-label="Sync the base branch first" disabled={disabled} className="routing-switch" onClick={() => props.onDraftChange(setRuleSyncBase(draft, index, !syncBase))}>
            <span className="routing-switch-thumb" aria-hidden="true" />
          </button>
        </div>}
      </> : <p className="routing-dialog-action-copy">Runs the built-in merge action. No role or workflow to choose.</p>}
    </RoutingDialogSection>

    <RoutingDialogSection title="Next status">
      <div className="routing-dialog-grid">
        <RoutingDialogSelect id={id('on-pass')} label="If it passes" value={valueOf(rule?.onPass)} options={statusOptions(settings)} disabled={disabled} problems={fieldProblems('onPass')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'onPass', value))} />
        <RoutingDialogSelect id={id('on-fail')} label="If it fails" value={valueOf(rule?.onFail)} options={statusOptions(settings)} disabled={disabled} problems={fieldProblems('onFail')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'onFail', value))} />
        {agent && <RoutingDialogSelect id={id('on-blocked')} label="If it is blocked" value={blocked} options={[{ value: '', label: 'Leave as is' }, ...statusOptions(settings)]} disabled={disabled} problems={fieldProblems('onBlocked')} onChange={value => props.onDraftChange(updateRuleField(draft, index, 'onBlocked', value))} />}
      </div>
    </RoutingDialogSection>

    {agent && <RoutingDialogSection title="Escalation">
      <div className="routing-dialog-switch-row">
        <span className="routing-dialog-switch-text">
          <span className="routing-dialog-switch-title">Escalate after repeated failures</span>
          <span className="routing-dialog-switch-hint">Send the ticket somewhere else once it keeps failing here.</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={failure}
          aria-label="Escalate after repeated failures"
          disabled={disabled}
          className="routing-switch"
          onClick={() => {
            if (!failure) focusFailure.current = true;
            props.onDraftChange(failure
              ? removeRuleFailureLimit(draft, index)
              : setRuleFailureLimit(draft, index, 1, settings.statuses[0]?.id ?? ''));
          }}
        >
          <span className="routing-switch-thumb" aria-hidden="true" />
        </button>
      </div>
      {failure && <div className="routing-dialog-grid routing-dialog-escalation">
        <div className="routing-dialog-field">
          <label className="routing-dialog-label" htmlFor={id('failure-count')}>After this many fails</label>
          <input
            ref={failureRef}
            id={id('failure-count')}
            type="number"
            min="1"
            step="1"
            value={Number.isNaN(count) ? '' : count}
            disabled={disabled}
            aria-invalid={fieldProblems('onFailureLimit.count').length > 0 ? 'true' : undefined}
            aria-describedby={fieldProblems('onFailureLimit.count').length > 0 ? id('failure-count-error') : undefined}
            onChange={event => props.onDraftChange(updateFailureLimit(draft, index, 'count', event.target.value === '' ? Number.NaN : Number(event.target.value)))}
          />
          <RoutingDialogProblemText id={id('failure-count-error')} problems={fieldProblems('onFailureLimit.count')} />
        </div>
        <RoutingDialogSelect
          id={id('failure-status')}
          label="Move it to"
          value={target}
          options={target !== '' && !settings.statuses.some(candidate => candidate.id === target)
            ? [{ value: target, label: `${target} — unknown status`, disabled: true }, ...statusOptions(settings)]
            : statusOptions(settings)}
          disabled={disabled}
          problems={fieldProblems('onFailureLimit.status')}
          onChange={value => props.onDraftChange(updateFailureLimit(draft, index, 'status', value))}
        />
      </div>}
    </RoutingDialogSection>}
  </Dialog>;
}
