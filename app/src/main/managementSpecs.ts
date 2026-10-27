// Static, allowlisted description of the Teams management IPC: one fixed backend command per channel and a
// shape check for the renderer request. Pure (no electron or client imports) so it is easy to test.

export const MANAGEMENT_CHANNELS = {
  managementOverview: 'management:overview',
  managementAgents: 'management:agents',
  managementTeam: 'management:team',
  managementValidateTeam: 'management:validateTeam',
  managementBoardSettings: 'management:boardSettings',
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
  managementUpdateRole: 'management:updateRole',
  managementRunBoard: 'management:runBoard',
  managementStopBoard: 'management:stopBoard',
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

type Kind = 'slug' | 'uuid' | 'sha' | 'nonEmpty' | 'string' | 'stringOrNull' | 'bool' | 'boolOrNull' | 'any';

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
      return typeof value === 'string' && UUID4.test(value) ? null : `${label}: teamId must be a lowercase UUID v4.`;
    case 'sha':
      return typeof value === 'string' && SHA.test(value) ? null : `${label}: expectedSha256 must be a lowercase hex sha256.`;
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
      out[key] = value;
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
  opts: { mutating?: boolean; flatten?: string } = {},
): ManagementSpec {
  const label = `management.${method}`;
  return {
    channel,
    label,
    command,
    mutating: opts.mutating === true,
    parse: (request) => {
      const parsed = parseObject(request, schema, '', label);
      return opts.flatten ? flat(parsed, opts.flatten) : parsed;
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
        ticketFields: { kind: 'any' },
        rules: { kind: 'any' },
        leaseSeconds: { kind: 'any' },
        baseBranch: { kind: 'any' },
        agentTicketStatus: { kind: 'any' },
      },
    },
    expectedSha256: sha,
  }),
  spec(C.managementUpdateRole, 'updateRole', 'role.update', {
    role: { kind: 'nonEmpty', required: true },
    description: { kind: 'stringOrNull', required: true },
    expectedSha256: sha,
  }),
  spec(C.managementRunBoard, 'runBoard', 'board.run', { teamId: { kind: 'uuid', required: true } }, { mutating: true }),
  spec(C.managementStopBoard, 'stopBoard', 'board.stop', {}, { mutating: true }),
];
