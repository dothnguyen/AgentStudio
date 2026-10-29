import type { ManagementError, RoleCatalogItem, RoleCatalogList, RoleChanges, RoleCreateInput } from '../api';

export type RoleFormMode = 'create' | 'edit';
export interface RoleFormValues { id: string; name: string; description: string; instructions: string; skills: string[] }
export type RoleFormField = 'id' | 'name' | 'description' | 'instructions' | 'skills';
export type RoleFormErrors = Partial<Record<RoleFormField, string>>;
export interface RoleSavePlan { create: RoleCreateInput | null; metadata: RoleChanges | null; instructionsChanged: boolean }

export const ROLE_FIELDS: readonly RoleFormField[] = ['id', 'name', 'description', 'instructions', 'skills'];
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 2000;
export const MAX_INSTRUCTION_BYTES = 16384;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SKILL_ID_MESSAGE = "Use 1–64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.";
const encoder = new TextEncoder();

export function emptyRoleForm(): RoleFormValues { return { id: '', name: '', description: '', instructions: '', skills: [] }; }
export function editRoleForm(role: RoleCatalogItem): RoleFormValues {
  return { id: role.id, name: role.name, description: role.description ?? '', instructions: role.instructions.text ?? '', skills: role.skills.map(s => s.id) };
}
export function suggestRoleId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}
export function instructionBytes(text: string): number { return encoder.encode(text).byteLength; }
const nameKey = (name: string) => name.trim().toLocaleLowerCase();

export function validateRoleForm(values: RoleFormValues, mode: RoleFormMode, catalog: RoleCatalogList): RoleFormErrors {
  const errors: RoleFormErrors = {};
  if (mode === 'create') {
    const id = values.id;
    if (!id.trim()) errors.id = 'Enter a role id.';
    else if (!ID_RE.test(id)) errors.id = 'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit.';
    else if (catalog.items.some(r => r.id === id)) errors.id = 'That role id already exists.';
  }
  const name = values.name.trim();
  if (!name) errors.name = 'Enter a role name.';
  else if (name.length > MAX_NAME) errors.name = 'Use 80 characters or fewer.';
  else if (catalog.items.some(r => (mode === 'create' || r.id !== values.id) && nameKey(r.name) === nameKey(name))) errors.name = 'That role name is already in use.';
  if (values.description.trim().length > MAX_DESCRIPTION) errors.description = 'Use 2000 characters or fewer.';
  if (instructionBytes(values.instructions) > MAX_INSTRUCTION_BYTES) errors.instructions = 'Use 16384 UTF-8 bytes or fewer.';
  const seen = new Set<string>();
  for (const raw of values.skills) {
    const skill = raw.trim().toLowerCase();
    if (!SKILL_RE.test(skill)) { errors.skills = SKILL_ID_MESSAGE; break; }
    if (seen.has(skill)) { errors.skills = `Remove the duplicate skill id '${skill}'.`; break; }
    seen.add(skill);
  }
  return errors;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function buildRoleSavePlan(mode: RoleFormMode, base: RoleCatalogItem | null, values: RoleFormValues): RoleSavePlan {
  const name = values.name.trim();
  const description = values.description.trim();
  const skills = values.skills.map(s => s.trim().toLowerCase());
  if (mode === 'create' || !base) {
    const create: RoleCreateInput = { id: values.id, name, skills };
    if (description) create.description = description;
    return { create, metadata: null, instructionsChanged: values.instructions !== '' };
  }
  const changes: RoleChanges = {};
  if (name !== base.name) changes.name = name;
  if (description !== (base.description ?? '').trim()) changes.description = description || null;
  if (!sameList(skills, base.skills.map(s => s.id))) changes.skills = skills;
  return {
    create: null,
    metadata: Object.keys(changes).length ? changes : null,
    instructionsChanged: values.instructions !== (base.instructions.text ?? ''),
  };
}

export function moveRoleSkill(skills: readonly string[], index: number, direction: -1 | 1): string[] {
  const next = [...skills];
  const to = index + direction;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function roleErrorProblems(error: ManagementError): { fields: RoleFormErrors; unmatched: string[] } {
  const fields: RoleFormErrors = {};
  const unmatched: string[] = [];
  const data = error.data as { problems?: unknown } | null | undefined;
  const list = Array.isArray(data?.problems) ? data.problems : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { path?: unknown; message?: unknown };
    const path = typeof p.path === 'string' ? p.path : '';
    const message = typeof p.message === 'string' ? p.message : '';
    const m = /(?:^|\.)(id|name|description|instructions|skills(?:\[\d+\])?)$/.exec(path);
    const field = m ? m[1]!.replace(/\[\d+\]$/, '') as RoleFormField : null;
    if (field) fields[field] = fields[field] ? `${fields[field]} ${message}` : message;
    else unmatched.push(path ? `${path}: ${message}` : message);
  }
  return { fields, unmatched };
}
