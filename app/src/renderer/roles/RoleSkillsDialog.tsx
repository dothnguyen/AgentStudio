import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { ManagementApi, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import { Dialog } from '../teams/Dialog';
import { RoleDialogFeedback } from './RoleDialogFeedback';
import { roleErrorProblems, validateRoleForm, type RoleFormValues } from './roleEditModel';
import { useRoleEditSave } from './useRoleEditSave';

export interface RoleSkillsDialogProps {
  role: RoleCatalogItem;
  catalog: RoleCatalogList;
  catalogSha: string | null;
  management: ManagementApi;
  workspaceId: string;
  reload(): Promise<Result<RoleCatalogList>>;
  onSaved(role: RoleCatalogItem): void;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
  /** Footer link that discards the draft and opens the standalone Skills list. */
  onManageSkills?(): void;
}

interface SkillRow {
  id: string;
  missing: boolean;
}

/**
 * The role page Skills dialog: one checkbox row per available skill plus any
 * configured skill that no longer exists. A removed missing skill stays out of
 * the list for the rest of the draft instead of being offered again.
 */
export function RoleSkillsDialog(props: RoleSkillsDialogProps): JSX.Element {
  const { role, catalog } = props;
  const uid = useId();
  const errorId = `${uid}-error`;
  const firstRef = useRef<HTMLButtonElement>(null);
  const initialSelected = useRef(role.skills.map(skill => skill.id));
  const [dismissedMissing, setDismissedMissing] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected.current));
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);
  const save = useRoleEditSave({
    management: props.management,
    workspaceId: props.workspaceId,
    mode: 'edit',
    role,
    catalogSha: props.catalogSha,
    reload: props.reload,
    onPendingChange: props.onPendingChange,
  });

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Rows follow the current catalog so a conflict reload can add newly
  // available skills without discarding the draft. A missing configured skill
  // that the person unchecks stays out for the rest of the draft.
  const available = catalog.availableSkills;
  const availableSet = new Set(available);
  const rows: SkillRow[] = [
    ...available.map(id => ({ id, missing: false })),
    ...role.skills
      .map(skill => skill.id)
      .filter(id => !availableSet.has(id) && !dismissedMissing.has(id))
      .map(id => ({ id, missing: true })),
  ];

  const initialSet = new Set(initialSelected.current);
  const skills = [
    ...initialSelected.current.filter(id => selected.has(id)),
    ...rows.filter(row => !row.missing && !initialSet.has(row.id) && selected.has(row.id)).map(row => row.id),
  ];
  const values: RoleFormValues = {
    id: role.id,
    name: role.name,
    description: role.description ?? '',
    instructions: role.instructions.text ?? '',
    skills,
  };
  const errors = validateRoleForm(values, 'edit', catalog);
  const serverSkills = save.error === null ? undefined : roleErrorProblems(save.error).fields.skills;
  const skillsError = errors.skills ?? serverSkills;
  const same = selected.size === initialSet.size && [...selected].every(id => initialSet.has(id));
  const saveDisabled = save.pending || same || skillsError !== undefined;

  const toggle = (row: SkillRow) => {
    setReloaded(false);
    save.clearError();
    const checked = selected.has(row.id);
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.delete(row.id); else next.add(row.id);
      return next;
    });
    if (checked && row.missing) setDismissedMissing(current => new Set(current).add(row.id));
  };

  const submit = async (): Promise<void> => {
    if (saveDisabled) return;
    const outcome = await save.save(values);
    if (outcome.status === 'saved') props.onSaved(outcome.role);
  };

  const reload = async (): Promise<void> => {
    setReloadFailure(null);
    setReloaded(false);
    const result = await save.reloadCurrent();
    if (result.ok) {
      save.clear();
      setReloaded(true);
    } else {
      setReloadFailure(`Reload failed: ${result.error.code}: ${result.error.message}`);
    }
  };

  return <Dialog
    title="Edit skills"
    width={560}
    busy={save.pending}
    onClose={props.onCancel}
    footerNote="Saved to roles.json"
    leadingActions={props.onManageSkills === undefined ? undefined : [{
      label: 'Manage skills',
      className: 'dialog-action-link',
      onClick: props.onManageSkills,
    }]}
    initialFocus={firstRef}
    className="role-skills-dialog"
    actions={[
      { label: 'Cancel', onClick: props.onCancel },
      { label: save.pending ? 'Saving…' : 'Save', variant: 'primary', disabled: saveDisabled, onClick: () => { void submit(); } },
    ]}
  >
    <div
      role="group"
      aria-label="Skills"
      className="role-skill-options"
      aria-describedby={skillsError ? errorId : undefined}
    >
      {rows.length === 0 && <p className="role-dialog-hint">No skills are available.</p>}
      {rows.map((row, index) => {
        const checked = selected.has(row.id);
        return <button
          key={row.id}
          ref={index === 0 ? firstRef : undefined}
          type="button"
          role="checkbox"
          aria-checked={checked}
          className={`role-skill-option${checked ? ' is-checked' : ''}${row.missing ? ' is-missing' : ''}`}
          disabled={save.pending}
          onClick={() => toggle(row)}
        >
          <span className="role-skill-check" aria-hidden="true">{checked && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0b1220" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}</span>
          <span className="role-skill-option-id">{row.id}</span>
          {row.missing && <span className="role-skill-missing-label">missing</span>}
        </button>;
      })}
    </div>
    {skillsError && <p id={errorId} className="role-dialog-field-error">{skillsError}</p>}
    <RoleDialogFeedback
      error={save.error}
      partialNotice={save.partialNotice}
      reloadFailure={reloadFailure}
      reloaded={reloaded}
      pending={save.pending}
      onReload={() => { void reload(); }}
    />
  </Dialog>;
}
