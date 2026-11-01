import type { JSX, RefObject } from 'react';
import type { RoleCatalogItem } from '../api';
import { Icon } from '../icons/Icon';
import { SectionCard } from '../teams/SectionCard';
import { memberInitials } from '../teams/teamsModel';
import { instructionBytes, MAX_INSTRUCTION_BYTES } from './roleEditModel';
import {
  assignedMemberLabels,
  INSTRUCTION_MESSAGES,
  roleDisplayLabel,
  roleInitials,
  roleIssueSummary,
  roleRuntimeState,
  roleUsageProblems,
  roleUsageSummary,
} from './rolesModel';

export interface RolePageProps {
  role: RoleCatalogItem;
  /** Disables every card Edit action and exposes its reason through aria-describedby. */
  editDisabled: boolean;
  editReason: string | null;
  onEditOverview(): void;
  onEditSkills(): void;
  onEditInstructions(): void;
  onBack(): void;
  onDelete(): void;
  /** Null when Delete is allowed; otherwise the reason shown under the header. */
  deleteDisabledReason: string | null;
  onOpenMember?(teamId: string, memberId: string): void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  deleteRef?: RefObject<HTMLButtonElement | null>;
}

const SAVE_NOTICE = 'Saved changes apply to new assignments. Assignments already running keep the instructions they started with.';

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/** The list keeps its compact "1 running"; the page spells out the assignment count. */
function runningAssignmentsText(running: string | null): string {
  if (running === null) return 'Running assignments unknown';
  const match = /^(\d+) running$/.exec(running);
  if (match === null) return running;
  return `${match[1]} running assignment${match[1] === '1' ? '' : 's'}`;
}

function PermissionNotice(): JSX.Element {
  return <div className="roles-notice">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
    <span>{SAVE_NOTICE}</span>
  </div>;
}

/** Read-only role page: header, section cards and the delete entry point. */
export function RolePage(props: RolePageProps): JSX.Element {
  const { role } = props;
  const label = roleDisplayLabel(role);
  const description = role.description?.trim();
  const units = roleUsageSummary(role);
  const incompleteMembers = units.members === 'Usage incomplete';
  const unused = units.members === 'Unused';
  const usageText = unused ? 'Unused' : incompleteMembers ? 'Usage incomplete' : `Used by ${units.members}`;
  const usageTone = unused ? 'is-muted' : incompleteMembers ? 'is-incomplete' : 'is-used';
  const runningText = runningAssignmentsText(units.running);
  const deleteReason = props.deleteDisabledReason ?? 'No member uses this role, so it can be deleted.';
  const deleteDisabled = props.deleteDisabledReason !== null;
  const reasonTone = role.usage.blocking || props.deleteDisabledReason !== null ? 'is-warning' : 'is-muted';
  const editReasonId = 'roles-mutation-reason';
  const instructions = role.instructions;
  const hasText = (instructions.state === 'ok' || instructions.state === 'truncated')
    && instructions.text !== null && instructions.text.trim() !== '';
  const bytes = instructions.bytes ?? (instructions.text === null ? null : instructionBytes(instructions.text));
  const instructionMessage = hasText ? null
    : instructions.state === 'ok' || instructions.state === 'truncated' ? 'This instruction file is empty.'
    : INSTRUCTION_MESSAGES[instructions.state] ?? 'Shared instructions are unavailable.';
  const members = assignedMemberLabels(role);
  const usageProblems = roleUsageProblems(role);
  const issueCount = role.warnings.length + role.problems.length + usageProblems.length;
  const runtime = roleRuntimeState(role);
  const instructionsPath = instructions.path?.trim() || null;

  return <>
    <div className="roles-role-top">
    <header className="roles-role-header">
      <nav aria-label="Breadcrumb" className="roles-breadcrumb"><ol>
        <li><button type="button" className="roles-back" onClick={props.onBack}>Roles</button></li>
        <li aria-current="page">{label}</li>
      </ol></nav>
      <div className="roles-role-heading-row">
        <div className="roles-role-identity">
          <span className="roles-role-avatar" aria-hidden="true">{roleInitials(role)}</span>
          <div className="roles-role-identity-text">
            <div className="roles-role-title-row">
              <h1 className="roles-role-heading" tabIndex={-1} ref={props.headingRef}>{label}</h1>
              <code className="roles-role-id-chip">{role.id}</code>
              <span className={`roles-role-usage-pill ${usageTone}`}>{usageText}</span>
            </div>
            <span className="roles-role-running">{runningText}</span>
          </div>
        </div>
        <button ref={props.deleteRef} type="button" className="roles-role-delete" disabled={deleteDisabled} aria-describedby="roles-delete-reason" onClick={props.onDelete}>
          <Icon name="trash" size={14} />
          Delete role
        </button>
      </div>
      <p id="roles-delete-reason" className={`roles-role-reason ${reasonTone}`}>{deleteReason}</p>
    </header>
    <PermissionNotice />
    </div>
    <div className="roles-role-layout">
      <div className="roles-role-main">
        <SectionCard
          title="Overview"
          subtitle="Name and description shown in Roles and on member pages."
          className="roles-overview-card"
          action={{
            label: 'Edit',
            ariaLabel: 'Edit overview',
            disabled: props.editDisabled,
            descriptionId: props.editDisabled ? editReasonId : undefined,
            onClick: props.onEditOverview,
          }}
        >
          <dl className="roles-overview-grid">
            <div><dt>Name</dt><dd>{role.name?.trim() || role.id}</dd></div>
            <div><dt>Role id</dt><dd><code className="roles-overview-id">{role.id}</code></dd></div>
            {label !== role.id && <div><dt>Display name</dt><dd>{label}</dd></div>}
            <div className="roles-overview-description"><dt>Description</dt><dd>{description || 'No description'}</dd></div>
          </dl>
          {props.editReason && <p id={editReasonId} className="roles-edit-reason">{props.editReason}</p>}
        </SectionCard>

        <SectionCard
          title="Shared instructions"
          subtitle="Read when an assignment starts. Later edits apply to new assignments only."
          className="roles-instructions-card"
          action={{
            label: 'Edit',
            ariaLabel: 'Edit shared instructions',
            disabled: props.editDisabled,
            descriptionId: props.editDisabled ? editReasonId : undefined,
            onClick: props.onEditInstructions,
          }}
        >
          {(instructionsPath || (hasText && bytes !== null)) && <div className="roles-instructions-head">
            {instructionsPath && <span className="roles-instructions-file"><Icon name="document" size={13} /><code>{instructionsPath}</code></span>}
            {hasText && instructions.text !== null && bytes !== null && <span className="roles-instructions-count">
              {`${lineCount(instructions.text)} lines · ${bytes.toLocaleString('en-US')} / ${MAX_INSTRUCTION_BYTES.toLocaleString('en-US')} bytes`}
            </span>}
          </div>}
          {hasText
            ? <div className="roles-instructions-preview">
              <pre>{instructions.text}</pre>
              <div className="roles-instructions-fade" aria-hidden="true" />
            </div>
            : <p className="roles-instructions-empty">{instructionMessage}</p>}
          {instructions.state === 'truncated' && <p className="roles-instructions-empty">Instruction content is truncated.</p>}
        </SectionCard>

        {issueCount > 0 && <SectionCard
          title="Warnings and problems"
          subtitle={roleIssueSummary(role)}
          className="roles-warning-card"
        >
          {role.warnings.length > 0 && <div className="roles-warning-group">
            <h3>Warnings</h3>
            <ul className="roles-warning-list">{role.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
          </div>}
          {role.problems.length > 0 && <div className="roles-warning-group">
            <h3>Role problems</h3>
            <ul className="roles-warning-list">{role.problems.map((problem, index) => <li key={`${index}-${problem.path}`}>{problem.path ? `${problem.path}: ` : ''}{problem.message}</li>)}</ul>
          </div>}
          {usageProblems.length > 0 && <div className="roles-warning-group">
            <h3>Assignment source problems</h3>
            <ul className="roles-warning-list">{usageProblems.map((problem, index) => <li key={`${index}-${problem.path}`}>{problem.path ? `${problem.path}: ` : ''}{problem.message}</li>)}</ul>
          </div>}
        </SectionCard>}
      </div>

      <aside className="roles-role-aside" aria-label="Role skills and assignments">
        <SectionCard
          title="Skills"
          subtitle="Skill files the role can use."
          className="roles-skills-card"
          action={{
            label: 'Edit',
            ariaLabel: 'Edit skills',
            disabled: props.editDisabled,
            descriptionId: props.editDisabled ? editReasonId : undefined,
            onClick: props.onEditSkills,
          }}
        >
          {role.skills.length === 0
            ? <p className="roles-skills-empty">No skills configured.</p>
            : <div className="roles-skill-chips">{role.skills.map((skill, index) => <span key={`${skill.id}:${index}`} className={`roles-skill-chip${skill.state === 'ok' ? '' : ' roles-skill-chip-missing'}`}>
              {skill.id}{skill.state !== 'ok' && <><span aria-hidden="true"> · </span><span className="roles-skill-missing-label">missing</span></>}
            </span>)}</div>}
        </SectionCard>

        <SectionCard title="Used by" subtitle="Change a member's role from its page." className="roles-usedby-card">
          {role.usage.partial && <p className="roles-usedby-note">Assigned-member results are incomplete.</p>}
          {runtime !== 'connected' && <p className="roles-usedby-note">Live assignments are unavailable; saved assignments remain shown.</p>}
          {members.length === 0
            ? (!role.usage.partial && <p className="roles-usedby-empty">No saved or live member assignments found.</p>)
            : <ul className="roles-usedby-list">{members.map((member, index) => {
              const meta = [member.team, member.states.join(' and '), member.runtime].filter((part): part is string => part !== null && part !== '').join(' · ');
              const teamId = member.teamId;
              const memberId = member.memberId;
              return <li className="roles-usedby-row" key={`${member.key}:${index}`}>
                <span className="roles-usedby-avatar" aria-hidden="true">{memberInitials(member.member)}</span>
                <span className="roles-usedby-text">
                  <span className="roles-usedby-name">{member.member}</span>
                  <span className="roles-usedby-meta">{meta}</span>
                  {(teamId !== null || memberId !== null) && <span className="roles-visually-hidden">{teamId !== null ? `Team id ${teamId}. ` : ''}{memberId !== null ? `Member id ${memberId}.` : ''}</span>}
                </span>
                {teamId !== null && memberId !== null && props.onOpenMember !== undefined && <button
                  type="button"
                  className="roles-usedby-open"
                  aria-label={`Open ${member.member}`}
                  onClick={() => props.onOpenMember?.(teamId, memberId)}
                >Open</button>}
              </li>;
            })}</ul>}
          <p className="roles-usedby-disclaimer">Roles do not grant permissions and do not choose agents; those come from team and agent settings.</p>
        </SectionCard>
      </aside>
    </div>
  </>;
}
