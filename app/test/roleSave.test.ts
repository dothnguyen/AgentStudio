import { describe, expect, it, vi } from 'vitest';
import type { ManagementApi, RoleCatalogItem, RoleCatalogList } from '../src/renderer/api';
import type { RoleFormValues } from '../src/renderer/roles/roleEditModel';
import { INSTRUCTIONS_MESSAGE, PROMPT_TOO_LONG, runRoleSave, TOKENS_MESSAGE, VERIFY_MESSAGE } from '../src/renderer/roles/roleSave';
import { roleItem, rolesFixture } from './rolesFixtures';

const SHA = 'a'.repeat(64);
const DEV_SHA = 'b'.repeat(64);
const NEXT_SHA = 'c'.repeat(64);
const FINAL_SHA = 'd'.repeat(64);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message = 'failed') => ({ ok: false as const, error: { code, message, retryable: false } });

function developer(over: Partial<RoleCatalogItem> = {}): RoleCatalogItem {
  return roleItem('Developer', {
    name: 'Developer',
    description: 'Old description',
    instructions: { state: 'ok', path: '.agent-studio/roles/Developer.md', text: 'Old prompt', sha256: DEV_SHA, bytes: 10 },
    skills: [{ id: 'python-testing', state: 'ok' }],
    ...over,
  });
}

function editRoleForm(role: RoleCatalogItem): RoleFormValues {
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? '',
    instructions: role.instructions.text ?? '',
    skills: role.skills.map(skill => skill.id),
  };
}

function catalog(role: RoleCatalogItem, sha = SHA): RoleCatalogList {
  return rolesFixture({ sha256: sha, items: [role] });
}

function mutation(role: RoleCatalogItem, sha: string) {
  return ok({ workspace: '/w', sha256: sha, role, warnings: [], appliesToNewAssignments: true as const });
}

function setup(steps: {
  updateRole?: ReturnType<typeof vi.fn>;
  updateRoleInstructions?: ReturnType<typeof vi.fn>;
  createRole?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
} = {}) {
  const updateRole = steps.updateRole ?? vi.fn(async () => mutation(developer({ description: 'New description' }), NEXT_SHA));
  const updateRoleInstructions = steps.updateRoleInstructions ?? vi.fn(async () => mutation(developer(), NEXT_SHA));
  const createRole = steps.createRole ?? vi.fn(async () => mutation(developer(), NEXT_SHA));
  const reload = steps.reload ?? vi.fn(async () => ok(catalog(developer(), SHA)));
  const management = { updateRole, updateRoleInstructions, createRole } as unknown as ManagementApi;
  return { management, updateRole, updateRoleInstructions, createRole, reload };
}

function save(parts: ReturnType<typeof setup>, values: ReturnType<typeof editRoleForm>, over: { isLive?: () => boolean; onPhase?: (phase: string) => void; base?: RoleCatalogItem; catalogSha?: string | null } = {}) {
  const base = over.base ?? developer();
  return runRoleSave({
    management: parts.management,
    workspaceId: 'ws',
    session: { mode: 'edit', base, catalogSha: over.catalogSha === undefined ? SHA : over.catalogSha, metadataSaved: false },
    values,
    reload: parts.reload,
    isLive: over.isLive,
    onPhase: over.onPhase as never,
  });
}

describe('shared role save sequence', () => {
  it('writes only the description when only the description changed', async () => {
    const base = developer();
    const updated = developer({ description: 'New description' });
    const parts = setup({ reload: vi.fn(async () => ok(catalog(updated, NEXT_SHA))) });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description' });
    expect(outcome.status).toBe('saved');
    expect(parts.updateRole).toHaveBeenCalledTimes(1);
    expect(parts.updateRole).toHaveBeenCalledWith('ws', 'Developer', { description: 'New description' }, SHA);
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
    expect(parts.reload).toHaveBeenCalledTimes(1);
    expect(outcome.status === 'saved' && outcome.wrote).toBe(true);
  });

  it('writes only the prompt when only the prompt changed', async () => {
    const base = developer();
    const updated = developer({ instructions: { ...base.instructions, text: 'New prompt', sha256: NEXT_SHA } });
    const parts = setup({
      updateRoleInstructions: vi.fn(async () => mutation(updated, FINAL_SHA)),
      reload: vi.fn(async () => ok(catalog(updated, FINAL_SHA))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), instructions: 'New prompt' });
    expect(outcome.status).toBe('saved');
    expect(parts.updateRole).not.toHaveBeenCalled();
    expect(parts.updateRoleInstructions).toHaveBeenCalledTimes(1);
    expect(parts.updateRoleInstructions).toHaveBeenCalledWith('ws', 'Developer', 'New prompt', SHA, DEV_SHA);
    expect(parts.reload).toHaveBeenCalledTimes(1);
  });

  it('writes description, reloads tokens, then writes the prompt when both changed', async () => {
    const base = developer();
    const described = developer({ description: 'New description' });
    const final = developer({ description: 'New description', instructions: { ...base.instructions, text: 'New prompt', sha256: FINAL_SHA } });
    const order: string[] = [];
    let reloads = 0;
    const parts = setup({
      updateRole: vi.fn(async () => { order.push('description'); return mutation(described, NEXT_SHA); }),
      updateRoleInstructions: vi.fn(async () => { order.push('prompt'); return mutation(final, FINAL_SHA); }),
      reload: vi.fn(async () => { order.push('reload'); reloads += 1; return ok(catalog(reloads === 1 ? described : final, reloads === 1 ? NEXT_SHA : FINAL_SHA)); }),
    });
    const phases: string[] = [];
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' }, { onPhase: phase => phases.push(phase) });
    expect(outcome.status).toBe('saved');
    expect(order).toEqual(['description', 'reload', 'prompt', 'reload']);
    expect(parts.updateRoleInstructions).toHaveBeenCalledWith('ws', 'Developer', 'New prompt', NEXT_SHA, DEV_SHA);
    expect(phases).toEqual(['saving_metadata', 'reloading_tokens', 'saving_instructions', 'verifying']);
  });

  it('stops before the prompt when the description write fails', async () => {
    const base = developer();
    const parts = setup({ updateRole: vi.fn(async () => fail('BAD_REQUEST', 'Description rejected')) });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('BAD_REQUEST');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBeNull();
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
    expect(parts.reload).not.toHaveBeenCalled();
  });

  it('reports the partial save and stops when instruction tokens cannot be reloaded', async () => {
    const base = developer();
    const parts = setup({
      updateRole: vi.fn(async () => mutation(developer({ description: 'New description' }), NEXT_SHA)),
      reload: vi.fn(async () => fail('INTERNAL', 'offline')),
    });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(TOKENS_MESSAGE);
    expect(outcome.status === 'failed' && outcome.metadataSaved).toBe(true);
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('reports the partial save when the prompt write fails after the description was saved', async () => {
    const base = developer();
    const described = developer({ description: 'New description' });
    const parts = setup({
      updateRole: vi.fn(async () => mutation(described, NEXT_SHA)),
      updateRoleInstructions: vi.fn(async () => fail('BAD_REQUEST', 'Instructions rejected')),
      reload: vi.fn(async () => ok(catalog(described, NEXT_SHA))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(INSTRUCTIONS_MESSAGE);
    expect(outcome.status === 'failed' && outcome.error.code).toBe('BAD_REQUEST');
  });

  it('reports a failed verification after a write without claiming success', async () => {
    const base = developer();
    const updated = developer({ description: 'New description' });
    let calls = 0;
    const parts = setup({
      updateRole: vi.fn(async () => mutation(updated, NEXT_SHA)),
      reload: vi.fn(async () => (++calls === 1 ? fail('INTERNAL', 'offline') : ok(catalog(updated, NEXT_SHA)))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(VERIFY_MESSAGE);
    expect(outcome.status === 'failed' && outcome.metadataSaved).toBe(true);
  });

  it('turns a thrown write error into an INTERNAL failure without writing the prompt', async () => {
    const base = developer();
    const parts = setup({ updateRole: vi.fn(async () => { throw new Error('boom'); }) });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toEqual({ code: 'INTERNAL', message: 'Error: boom', retryable: false });
    expect(outcome.status === 'failed' && outcome.partialNotice).toBeNull();
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('reports a partial save when the role disappears before the prompt write', async () => {
    const base = developer();
    const parts = setup({
      updateRole: vi.fn(async () => mutation(developer({ description: 'New description' }), NEXT_SHA)),
      reload: vi.fn(async () => ok(rolesFixture({ sha256: NEXT_SHA, items: [] }))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(TOKENS_MESSAGE);
    expect(outcome.status === 'failed' && outcome.error.code).toBe('INTERNAL');
    expect(outcome.status === 'failed' && outcome.error.message).toContain('Role Developer was not found after saving.');
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('reports a verification failure when the role disappears after the prompt write', async () => {
    const base = developer();
    const updated = developer({ instructions: { ...base.instructions, text: 'New prompt', sha256: FINAL_SHA } });
    const parts = setup({
      updateRoleInstructions: vi.fn(async () => mutation(updated, FINAL_SHA)),
      reload: vi.fn(async () => ok(rolesFixture({ sha256: FINAL_SHA, items: [] }))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(VERIFY_MESSAGE);
    expect(outcome.status === 'failed' && outcome.error.code).toBe('INTERNAL');
    expect(parts.updateRoleInstructions).toHaveBeenCalledTimes(1);
  });

  it('surfaces a sha conflict and never writes the prompt', async () => {
    const base = developer();
    const parts = setup({ updateRole: vi.fn(async () => fail('CONFIG_CHANGED', 'changed')) });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('CONFIG_CHANGED');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBeNull();
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
  });

  it('surfaces a sha conflict on a prompt-only change without claiming a partial save', async () => {
    const base = developer();
    const parts = setup({ updateRoleInstructions: vi.fn(async () => fail('CONFIG_CHANGED', 'changed')) });
    const outcome = await save(parts, { ...editRoleForm(base), instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('CONFIG_CHANGED');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBeNull();
    expect(outcome.status === 'failed' && outcome.metadataSaved).toBe(false);
    expect(parts.updateRole).not.toHaveBeenCalled();
  });

  it('reports a prompt conflict after the description was saved as a partial save', async () => {
    const base = developer();
    const described = developer({ description: 'New description' });
    const parts = setup({
      updateRole: vi.fn(async () => mutation(described, NEXT_SHA)),
      updateRoleInstructions: vi.fn(async () => fail('CONFIG_CHANGED', 'changed')),
      reload: vi.fn(async () => ok(catalog(described, NEXT_SHA))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('CONFIG_CHANGED');
    expect(outcome.status === 'failed' && outcome.partialNotice).toBe(INSTRUCTIONS_MESSAGE);
    expect(outcome.status === 'failed' && outcome.metadataSaved).toBe(true);
  });

  it('rejects a prompt over the UTF-8 byte limit before writing anything', async () => {
    const base = developer();
    const parts = setup();
    const outcome = await save(parts, { ...editRoleForm(base), instructions: '€'.repeat(5462) });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.message).toBe(PROMPT_TOO_LONG);
    expect(parts.updateRole).not.toHaveBeenCalled();
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
    expect(parts.reload).not.toHaveBeenCalled();
  });

  it('accepts a prompt of exactly 16384 UTF-8 bytes', async () => {
    const base = developer();
    const longest = 'a'.repeat(16384);
    const updated = developer({ instructions: { ...base.instructions, text: longest, sha256: NEXT_SHA } });
    const parts = setup({
      updateRoleInstructions: vi.fn(async () => mutation(updated, NEXT_SHA)),
      reload: vi.fn(async () => ok(catalog(updated, NEXT_SHA))),
    });
    const outcome = await save(parts, { ...editRoleForm(base), instructions: longest });
    expect(outcome.status).toBe('saved');
    expect(parts.updateRoleInstructions).toHaveBeenCalledWith('ws', 'Developer', longest, SHA, DEV_SHA);
    expect(parts.reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing after the caller goes away', async () => {
    const base = developer();
    let live = true;
    const parts = setup({ updateRole: vi.fn(async () => { live = false; return mutation(developer({ description: 'New description' }), NEXT_SHA); }) });
    const outcome = await save(parts, { ...editRoleForm(base), description: 'New description', instructions: 'New prompt' }, { isLive: () => live });
    expect(outcome.status).toBe('stale');
    expect(parts.updateRoleInstructions).not.toHaveBeenCalled();
    expect(parts.reload).not.toHaveBeenCalled();
  });

  it('creates a role and then writes its prompt through the same sequence', async () => {
    const created = developer({ name: 'QA Lead' });
    const final = developer({ name: 'QA Lead', instructions: { ...created.instructions, text: 'Do QA', sha256: FINAL_SHA } });
    const order: string[] = [];
    let reloads = 0;
    const parts = setup({
      createRole: vi.fn(async () => { order.push('create'); return mutation(created, NEXT_SHA); }),
      updateRoleInstructions: vi.fn(async () => { order.push('prompt'); return mutation(final, FINAL_SHA); }),
      reload: vi.fn(async () => { order.push('reload'); reloads += 1; return ok(catalog(reloads === 1 ? created : final, reloads === 1 ? NEXT_SHA : FINAL_SHA)); }),
    });
    const outcome = await runRoleSave({
      management: parts.management,
      workspaceId: 'ws',
      session: { mode: 'create', base: null, catalogSha: SHA, metadataSaved: false },
      values: { id: 'qa-lead', name: 'QA Lead', description: '', instructions: 'Do QA', skills: [] },
      reload: parts.reload,
    });
    expect(outcome.status).toBe('saved');
    expect(order).toEqual(['create', 'reload', 'prompt', 'reload']);
    expect(parts.updateRoleInstructions).toHaveBeenCalledWith('ws', 'Developer', 'Do QA', NEXT_SHA, DEV_SHA);
  });
});
