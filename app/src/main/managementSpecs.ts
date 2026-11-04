// Static, allowlisted description of the Teams management IPC: one fixed backend command per channel and a
// shape check for the renderer request. Pure (no electron or client imports) so it is easy to test.

export const MANAGEMENT_CHANNELS = {
  managementOverview: 'management:overview',
  managementAgents: 'management:agents',
  managementTeam: 'management:team',
  managementValidateTeam: 'management:validateTeam',
  managementBoardSettings: 'management:boardSettings',
  managementBoardWorkflows: 'management:boardWorkflows',
  managementBoardWorkflow: 'management:boardWorkflow',
  managementPrompts: 'management:prompts',
  managementPrompt: 'management:prompt',
  managementCheckSets: 'management:checkSets',
  managementBoardStatuses: 'management:boardStatuses',
  managementBoardPhases: 'management:boardPhases',
  managementBoardTickets: 'management:boardTickets',
  managementBoardTicket: 'management:boardTicket',
  managementCreateAgent: 'management:createAgent',
  managementUpdateAgent: 'management:updateAgent',
  managementDeleteAgent: 'management:deleteAgent',
  managementCreateTeam: 'management:createTeam',
  managementRenameTeam: 'management:renameTeam',
  managementDeleteTeam: 'management:deleteTeam',
  managementAddMember: 'management:addMember',
  managementUpdateMember: 'management:updateMember',
  managementRemoveMember: 'management:removeMember',
  managementUpdateBoardSettings: 'management:updateBoardSettings',
  managementRoles: 'management:roles',
  managementCreateRole: 'management:createRole',
  managementUpdateRole: 'management:updateRole',
  managementUpdateRoleInstructions: 'management:updateRoleInstructions',
  managementDeleteRole: 'management:deleteRole',
  managementSkills: 'management:skills',
  managementSkill: 'management:skill',
  managementCreateSkill: 'management:createSkill',
  managementUpdateSkill: 'management:updateSkill',
  managementDeleteSkill: 'management:deleteSkill',
  managementUpdateSkillRoles: 'management:updateSkillRoles',
  managementRunBoard: 'management:runBoard',
  managementStopBoard: 'management:stopBoard',
  managementSwitchMemberAgent: 'management:switchMemberAgent',
  managementResumeMemberAgent: 'management:resumeMemberAgent',
  managementResetUsage: 'management:resetUsage',
  managementRetryRun: 'management:retryRun',
  managementCancelRun: 'management:cancelRun',
  managementTicketMove: 'management:ticketMove',
  managementTicketWorkflow: 'management:ticketWorkflow',
  managementRetryTicket: 'management:retryTicket',
  managementUnblockTicket: 'management:unblockTicket',
  managementApproveCommand: 'management:approveCommand',
  managementRejectCommand: 'management:rejectCommand',
  managementCancelCommand: 'management:cancelCommand',
  managementAttachInfo: 'management:attachInfo',
  managementStartTeam: 'management:startTeam',
  managementStopTeam: 'management:stopTeam',
} as const;

export interface ManagementSpec {
  channel: string;
  label: string;
  command: string;
  mutating: boolean;
  /** Returns the backend args WITHOUT `workspace`, or an error message. */
  parse(request: Record<string, unknown>): Record<string, unknown> | string;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_INSTRUCTION_BYTES = 16384;
const MAX_SKILL_BYTES = 32768;
const MAX_SKILL_ROLES = 100;

type Kind = 'slug' | 'uuid' | 'sha' | 'nonEmpty' | 'string' | 'stringOrNull' | 'bool' | 'boolOrNull' | 'any' | 'stringArrayOfSlugs' | 'true'
  | 'roleId' | 'roleName' | 'roleDescription' | 'roleDescriptionOrNull' | 'instructionText' | 'skillIds' | 'shaOrNull'
  | 'skillId' | 'skillText' | 'roleIds'
  | 'ticketKey' | 'reason' | 'boardColumn' | 'workflowStatus';

interface Field {
  kind: Kind;
  required?: boolean;
}
interface ObjectField {
  object: Record<string, Field>;
  required?: boolean;
  nonEmpty?: boolean;
}
type FieldSpec = Field | ObjectField;

function checkValue(kind: Kind, value: unknown, field: string, label: string): string | null {
  switch (kind) {
    case 'slug':
      return typeof value === 'string' && SLUG.test(value)
        ? null
        : `${label}: ${field} must be a slug (lowercase letters, digits, '-'; at most 64 characters).`;
    case 'uuid':
      return typeof value === 'string' && UUID4.test(value) ? null : `${label}: ${field} must be a lowercase UUID v4.`;
    case 'boardColumn':
      return typeof value === 'string' && ['backlog', 'todo', 'in-progress', 'done', 'closed'].includes(value) ? null : `${label}: ${field} must be a board column.`;
    case 'workflowStatus':
      return typeof value === 'string' && value.length > 0 && value.length <= 64 && !LONE_SURROGATE.test(value) ? null : `${label}: ${field} must be a non-empty string of at most 64 characters.`;
    case 'ticketKey':
      return typeof value === 'string' && /^T-\d{3,}$/.test(value)
        ? null
        : `${label}: ${field} must be a ticket key (T- followed by at least three digits).`;
    case 'reason':
      if (typeof value !== 'string') return `${label}: ${field} must be a string.`;
      if (LONE_SURROGATE.test(value)) return `${label}: ${field} must not contain unpaired surrogates.`;
      return value.length <= 500 ? null : `${label}: ${field} must be at most 500 characters.`;
    case 'stringArrayOfSlugs':
      if (!Array.isArray(value) || value.length === 0) return `${label}: ${field} must be a non-empty array of slugs.`;
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || !SLUG.test(value[i])) return `${label}: ${field}[${i}] must be a slug (lowercase letters, digits, '-'; at most 64 characters).`;
      }
      return new Set(value).size === value.length ? null : `${label}: ${field} must not contain duplicates.`;
    case 'true':
      return value === true ? null : `${label}: ${field} must be true.`;
    case 'sha':
      return typeof value === 'string' && SHA.test(value) ? null : `${label}: ${field} must be a lowercase hex sha256.`;
    case 'shaOrNull':
      return value === null || (typeof value === 'string' && SHA.test(value)) ? null : `${label}: ${field} must be a lowercase hex sha256 or null.`;
    case 'roleId':
      return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 64
        ? null
        : `${label}: ${field} must be a non-empty string of at most 64 characters.`;
    case 'roleName':
      return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128
        ? null
        : `${label}: ${field} must be a non-empty string of at most 128 characters.`;
    case 'roleDescription':
    case 'roleDescriptionOrNull':
      if (value === null && kind === 'roleDescriptionOrNull') return null;
      if (typeof value !== 'string') return `${label}: ${field} must be a string${kind === 'roleDescriptionOrNull' ? ' or null' : ''}.`;
      return value.length <= 2000 ? null : `${label}: ${field} must be at most 2000 characters.`;
    case 'instructionText':
      if (typeof value !== 'string') return `${label}: ${field} must be a string.`;
      if (LONE_SURROGATE.test(value)) return `${label}: ${field} must not contain unpaired surrogates.`;
      return new TextEncoder().encode(value).length <= MAX_INSTRUCTION_BYTES
        ? null
        : `${label}: ${field} must be at most ${MAX_INSTRUCTION_BYTES} UTF-8 bytes.`;
    case 'skillIds':
      if (!Array.isArray(value)) return `${label}: ${field} must be an array of skill ids.`;
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || !SKILL_ID.test(value[i])) return `${label}: ${field}[${i}] must be a valid skill id.`;
      }
      return new Set(value).size === value.length ? null : `${label}: ${field} must not contain duplicates.`;
    case 'skillId':
      return typeof value === 'string' && SKILL_ID.test(value)
        ? null
        : `${label}: ${field} must be a skill id (lowercase letters, digits, '.', '_', '-'; at most 64 characters).`;
    case 'skillText':
      if (typeof value !== 'string') return `${label}: ${field} must be a string.`;
      if (LONE_SURROGATE.test(value)) return `${label}: ${field} must not contain unpaired surrogates.`;
      return new TextEncoder().encode(value).length <= MAX_SKILL_BYTES
        ? null
        : `${label}: ${field} must be at most ${MAX_SKILL_BYTES} UTF-8 bytes.`;
    case 'roleIds':
      if (!Array.isArray(value)) return `${label}: ${field} must be an array of role ids.`;
      if (value.length > MAX_SKILL_ROLES) return `${label}: ${field} must have at most ${MAX_SKILL_ROLES} roles.`;
      for (let i = 0; i < value.length; i++) {
        const err = checkValue('roleId', value[i], `${field}[${i}]`, label);
        if (err) return err;
      }
      return new Set(value).size === value.length ? null : `${label}: ${field} must not contain duplicates.`;
    case 'nonEmpty':
      return typeof value === 'string' && value.trim().length > 0 ? null : `${label}: ${field} must be a non-empty string.`;
    case 'string':
      return typeof value === 'string' ? null : `${label}: ${field} must be a string.`;
    case 'stringOrNull':
      return typeof value === 'string' || value === null ? null : `${label}: ${field} must be a string or null.`;
    case 'bool':
      return typeof value === 'boolean' ? null : `${label}: ${field} must be a boolean.`;
    case 'boolOrNull':
      return typeof value === 'boolean' || value === null ? null : `${label}: ${field} must be a boolean or null.`;
    default:
      return null;
  }
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[], prefix: string, label: string): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return null;
  return `${label}: unknown field(s): ${extra.map((k) => prefix + k).sort().join(', ')}.`;
}

/** Validates `obj` against `schema`; returns the copied present keys (in schema order) or an error message. */
function parseObject(
  obj: Record<string, unknown>,
  schema: Record<string, FieldSpec>,
  prefix: string,
  label: string,
): Record<string, unknown> | string {
  const bad = unknownKeys(obj, Object.keys(schema), prefix, label);
  if (bad) return bad;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const name = prefix + key;
    const value = obj[key];
    if (value === undefined) {
      if (spec.required) return `${label}: ${name} is required.`;
      continue;
    }
    if ('object' in spec) {
      if (!isPlainObject(value)) return `${label}: ${name} must be an object.`;
      const nested = parseObject(value, spec.object, `${name}.`, label);
      if (typeof nested === 'string') return nested;
      if (spec.nonEmpty && Object.keys(nested).length === 0) return `${label}: ${name} must have at least one field.`;
      out[key] = nested;
    } else {
      const err = checkValue(spec.kind, value, name, label);
      if (err) return err;
      out[key] = spec.kind === 'stringArrayOfSlugs' || spec.kind === 'skillIds' || spec.kind === 'roleIds' ? [...value as string[]] : value;
    }
  }
  return out;
}

function flat(parsed: Record<string, unknown> | string, key: string): Record<string, unknown> | string {
  if (typeof parsed === 'string') return parsed;
  const { [key]: nested, ...rest } = parsed;
  return { ...rest, ...(nested as Record<string, unknown>) };
}

function spec(
  channel: string,
  method: string,
  command: string,
  schema: Record<string, FieldSpec>,
  opts: { mutating?: boolean; flatten?: string; map?: (flat: Record<string, unknown>) => Record<string, unknown> } = {},
): ManagementSpec {
  const label = `management.${method}`;
  return {
    channel,
    label,
    command,
    mutating: opts.mutating === true,
    parse: (request) => {
      const parsed = parseObject(request, schema, '', label);
      const out = opts.flatten ? flat(parsed, opts.flatten) : parsed;
      return opts.map && typeof out !== 'string' ? opts.map(out) : out;
    },
  };
}

const C = MANAGEMENT_CHANNELS;
const teamDefId: Field = { kind: 'slug', required: true };
const agentDefId: Field = { kind: 'slug', required: true };
const memberId: Field = { kind: 'slug', required: true };
const sha: Field = { kind: 'sha' };

export const MANAGEMENT_SPECS: readonly ManagementSpec[] = [
  spec(C.managementOverview, 'overview', 'team.overview', {}),
  spec(C.managementAgents, 'agents', 'agentdef.list', {}),
  spec(C.managementTeam, 'team', 'teamdef.show', { teamDefId }),
  spec(C.managementValidateTeam, 'validateTeam', 'teamdef.validate', { teamDefId }),
  spec(C.managementBoardSettings, 'boardSettings', 'board.settings', {}),
  spec(C.managementBoardWorkflows, 'boardWorkflows', 'board.workflows', {}),
  spec(C.managementBoardWorkflow, 'boardWorkflow', 'boardworkflow.show', { name: { kind: 'slug', required: true } }),
  spec(C.managementPrompts, 'prompts', 'prompt.list', {}),
  spec(C.managementPrompt, 'prompt', 'prompt.show', { name: { kind: 'slug', required: true } }),
  spec(C.managementCheckSets, 'checkSets', 'checkset.list', {}),
  spec(C.managementBoardStatuses, 'boardStatuses', 'board.statuses', {}),
  spec(C.managementBoardPhases, 'boardPhases', 'phase.list', {}),
  spec(C.managementBoardTickets, 'boardTickets', 'ticket.list', {
    phase: { kind: 'slug' },
    unassigned: { kind: 'bool' },
  }, {
    map: ({ phase, unassigned }) => unassigned === true ? { summary: true, unassigned: true } : phase === undefined ? { summary: true } : { summary: true, phase },
  }),
  spec(C.managementBoardTicket, 'boardTicket', 'ticket.show', {
    key: { kind: 'ticketKey', required: true },
  }),
  spec(C.managementCreateAgent, 'createAgent', 'agentdef.create', {
    agent: {
      required: true,
      object: {
        id: { kind: 'slug' },
        name: { kind: 'string' },
        description: { kind: 'string' },
        provider: { kind: 'string' },
        model: { kind: 'string' },
        reasoning: { kind: 'string' },
      },
    },
  }),
  spec(C.managementUpdateAgent, 'updateAgent', 'agentdef.update', {
    agentDefId,
    changes: {
      required: true,
      nonEmpty: true,
      object: {
        name: { kind: 'string' },
        provider: { kind: 'string' },
        description: { kind: 'stringOrNull' },
        model: { kind: 'stringOrNull' },
        reasoning: { kind: 'stringOrNull' },
      },
    },
  }),
  spec(C.managementDeleteAgent, 'deleteAgent', 'agentdef.delete', { agentDefId }),
  spec(C.managementCreateTeam, 'createTeam', 'teamdef.create', {
    name: { kind: 'nonEmpty', required: true },
    teamDefId: { kind: 'slug' },
  }),
  spec(C.managementRenameTeam, 'renameTeam', 'teamdef.rename', {
    teamDefId,
    name: { kind: 'nonEmpty', required: true },
  }),
  spec(C.managementDeleteTeam, 'deleteTeam', 'teamdef.delete', { teamDefId }),
  spec(
    C.managementAddMember,
    'addMember',
    'teamdef.member.add',
    {
      teamDefId,
      member: {
        required: true,
        object: {
          memberId: { kind: 'slug' },
          name: { kind: 'nonEmpty' },
          role: { kind: 'nonEmpty' },
          agent: { kind: 'slug' },
          agents: { kind: 'stringArrayOfSlugs' },
          provider: { kind: 'nonEmpty' },
          model: { kind: 'nonEmpty' },
          reasoning: { kind: 'nonEmpty' },
          canAddTickets: { kind: 'bool' },
        },
      },
    },
    { flatten: 'member' },
  ),
  spec(
    C.managementUpdateMember,
    'updateMember',
    'teamdef.member.update',
    {
      teamDefId,
      memberId,
      changes: {
        required: true,
        nonEmpty: true,
        object: {
          name: { kind: 'nonEmpty' },
          role: { kind: 'nonEmpty' },
          agent: { kind: 'slug' },
          agents: { kind: 'stringArrayOfSlugs' },
          provider: { kind: 'nonEmpty' },
          model: { kind: 'stringOrNull' },
          reasoning: { kind: 'stringOrNull' },
          canAddTickets: { kind: 'boolOrNull' },
        },
      },
    },
    { flatten: 'changes' },
  ),
  spec(C.managementRemoveMember, 'removeMember', 'teamdef.member.remove', { teamDefId, memberId }),
  spec(C.managementUpdateBoardSettings, 'updateBoardSettings', 'board.settings.update', {
    changes: {
      required: true,
      nonEmpty: true,
      object: {
        statuses: { kind: 'any' },
        workflowStatuses: { kind: 'any' },
        todoEntry: { kind: 'any' },
        todoDefault: { kind: 'any' },
        ticketFields: { kind: 'any' },
        rules: { kind: 'any' },
        leaseSeconds: { kind: 'any' },
        baseBranch: { kind: 'any' },
        agentTicketStatus: { kind: 'any' },
      },
    },
    expectedSha256: sha,
  }),
  spec(C.managementRoles, 'roles', 'role.list', {}),
  spec(C.managementCreateRole, 'createRole', 'role.create', {
    input: {
      required: true,
      object: {
        id: { kind: 'slug' },
        name: { kind: 'roleName', required: true },
        description: { kind: 'roleDescription' },
        skills: { kind: 'skillIds' },
      },
    },
    expectedRolesSha256: { kind: 'shaOrNull', required: true },
  }, {
    map: ({ input, expectedRolesSha256 }) => ({ role: input, expectedSha256: expectedRolesSha256 }),
  }),
  spec(C.managementUpdateRole, 'updateRole', 'role.update', {
    roleId: { kind: 'roleId', required: true },
    changes: {
      required: true,
      nonEmpty: true,
      object: {
        name: { kind: 'roleName' },
        description: { kind: 'roleDescriptionOrNull' },
        skills: { kind: 'skillIds' },
      },
    },
    expectedRolesSha256: { kind: 'sha', required: true },
  }, {
    flatten: 'changes',
    map: ({ roleId, expectedRolesSha256, ...rest }) => ({ role: roleId, ...rest, expectedSha256: expectedRolesSha256 }),
  }),
  spec(C.managementUpdateRoleInstructions, 'updateRoleInstructions', 'role.instructions.update', {
    roleId: { kind: 'roleId', required: true },
    text: { kind: 'instructionText', required: true },
    expectedRolesSha256: { kind: 'sha', required: true },
    expectedInstructionsSha256: { kind: 'shaOrNull', required: true },
  }, {
    map: ({ roleId, ...rest }) => ({ role: roleId, ...rest }),
  }),
  spec(C.managementDeleteRole, 'deleteRole', 'role.delete', {
    roleId: { kind: 'roleId', required: true },
    confirmation: {
      required: true,
      object: {
        expectedRolesSha256: { kind: 'sha', required: true },
        expectedInstructionsSha256: { kind: 'shaOrNull', required: true },
      },
    },
  }, {
    flatten: 'confirmation',
    map: ({ roleId, ...rest }) => ({ role: roleId, ...rest }),
  }),
  spec(C.managementSkills, 'skills', 'skill.list', {}),
  spec(C.managementSkill, 'skill', 'skill.show', {
    skillId: { kind: 'skillId', required: true },
  }, {
    map: ({ skillId, ...rest }) => ({ skill: skillId, ...rest }),
  }),
  spec(C.managementCreateSkill, 'createSkill', 'skill.create', {
    skill: {
      required: true,
      object: {
        id: { kind: 'skillId', required: true },
        text: { kind: 'skillText', required: true },
      },
    },
  }),
  spec(C.managementUpdateSkill, 'updateSkill', 'skill.update', {
    skillId: { kind: 'skillId', required: true },
    text: { kind: 'skillText', required: true },
    expectedSha256: { kind: 'sha', required: true },
  }, {
    map: ({ skillId, ...rest }) => ({ skill: skillId, ...rest }),
  }),
  spec(C.managementDeleteSkill, 'deleteSkill', 'skill.delete', {
    skillId: { kind: 'skillId', required: true },
    expectedRolesSha256: { kind: 'shaOrNull', required: true },
    expectedSha256: { kind: 'shaOrNull', required: true },
  }, {
    map: ({ skillId, ...rest }) => ({ skill: skillId, ...rest }),
  }),
  spec(C.managementUpdateSkillRoles, 'updateSkillRoles', 'skill.roles.update', {
    skillId: { kind: 'skillId', required: true },
    roles: { kind: 'roleIds', required: true },
    expectedRolesSha256: { kind: 'shaOrNull', required: true },
  }, {
    map: ({ skillId, ...rest }) => ({ skill: skillId, ...rest }),
  }),
  spec(C.managementRunBoard, 'runBoard', 'board.run', { teamId: { kind: 'uuid', required: true } }, { mutating: true }),
  spec(C.managementSwitchMemberAgent, 'switchMemberAgent', 'team.member.switch', {
    teamDefId, memberId, agent: { kind: 'slug', required: true },
    confirmation: { object: { cancelActive: { kind: 'true', required: true }, assignmentId: { kind: 'uuid', required: true } } },
  }, { mutating: true, flatten: 'confirmation' }),
  spec(C.managementResumeMemberAgent, 'resumeMemberAgent', 'team.member.resume', {
    teamDefId, memberId, agent: { kind: 'slug', required: true },
  }, { mutating: true }),
  spec(C.managementStopBoard, 'stopBoard', 'board.stop', {}, { mutating: true }),
  spec(C.managementResetUsage, 'resetUsage', 'team.usage.reset', {
    teamDefId, provider: { kind: 'slug', required: true },
  }, { mutating: true }),
  spec(C.managementRetryRun, 'retryRun', 'workflow.retry', {
    workflowRunId: { kind: 'uuid', required: true },
  }, { mutating: true }),
  spec(C.managementCancelRun, 'cancelRun', 'workflow.cancel', {
    workflowRunId: { kind: 'uuid', required: true },
  }, { mutating: true }),
  spec(C.managementTicketMove, 'ticketMove', 'ticket.move', {
    key: { kind: 'ticketKey', required: true }, to: { kind: 'boardColumn', required: true },
    workflowStatus: { kind: 'workflowStatus' }, reason: { kind: 'reason' }, force: { kind: 'bool' },
  }, { mutating: true }),
  spec(C.managementTicketWorkflow, 'ticketWorkflow', 'ticket.workflow', {
    key: { kind: 'ticketKey', required: true }, to: { kind: 'workflowStatus', required: true }, reason: { kind: 'reason' },
  }, { mutating: true }),
  spec(C.managementRetryTicket, 'retryTicket', 'ticket.retry', {
    key: { kind: 'ticketKey', required: true },
  }, { mutating: true }),
  spec(C.managementUnblockTicket, 'unblockTicket', 'ticket.unblock', {
    key: { kind: 'ticketKey', required: true },
    to: { kind: 'slug' },
  }, { mutating: true }),
  spec(C.managementApproveCommand, 'approveCommand', 'command.approve', {
    requestId: { kind: 'uuid', required: true },
  }, { mutating: true }),
  spec(C.managementRejectCommand, 'rejectCommand', 'command.reject', {
    requestId: { kind: 'uuid', required: true },
    reason: { kind: 'reason' },
  }, { mutating: true }),
  spec(C.managementCancelCommand, 'cancelCommand', 'command.cancel', {
    requestId: { kind: 'uuid', required: true },
    reason: { kind: 'reason' },
  }, { mutating: true }),
  spec(C.managementAttachInfo, 'attachInfo', 'team.attach', {
    teamId: { kind: 'uuid', required: true },
  }),
  spec(C.managementStartTeam, 'startTeam', 'team.start', {
    teamDefId,
  }, { mutating: true }),
  spec(C.managementStopTeam, 'stopTeam', 'team.stop', {
    teamId: { kind: 'uuid', required: true },
  }, { mutating: true }),
];
