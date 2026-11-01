import type { ManagementApi, ManagementError, RoleCatalogItem, RoleCatalogList, Result } from '../api';
import { buildRoleSavePlan, instructionBytes, MAX_INSTRUCTION_BYTES, type RoleFormMode, type RoleFormValues } from './roleEditModel';

/**
 * Shared role save sequence used by the Roles screen editor and the member
 * details "Role instructions" dialog.
 *
 * Description/metadata is written first (only when it changed), then the
 * catalog is reloaded to obtain fresh instruction tokens, then the prompt file
 * is written (only when it changed), and finally the catalog is reloaded to
 * verify the result. A failure after an earlier write reports which part was
 * saved and which was not.
 */
export type RoleSavePhase = 'idle' | 'saving_metadata' | 'reloading_tokens' | 'saving_instructions' | 'verifying';

export const TOKENS_MESSAGE = 'Metadata and skills were saved, but current instruction tokens could not be loaded. Reload and review before saving instructions.';
export const INSTRUCTIONS_MESSAGE = 'Metadata and skills were saved; shared instructions were not saved.';
export const VERIFY_MESSAGE = 'The save completed, but the catalog could not be reloaded to verify it. Reload and review.';
export const PROMPT_TOO_LONG = 'Use 16384 UTF-8 bytes or fewer.';

export interface RoleSaveSession {
  mode: RoleFormMode;
  base: RoleCatalogItem | null;
  catalogSha: string | null;
  metadataSaved: boolean;
}

export interface RoleSaveRequest {
  management: ManagementApi;
  workspaceId: string;
  session: RoleSaveSession;
  values: RoleFormValues;
  /** Reloads the roles catalog from disk (fresh, without the cached request). */
  reload(): Promise<Result<RoleCatalogList>>;
  /** False once the caller that started the save has gone away. */
  isLive?(): boolean;
  onPhase?(phase: RoleSavePhase): void;
  /** Reports the session changes made before the next write (base and tokens). */
  onSession?(change: Partial<RoleSaveSession>): void;
}

export type RoleSaveOutcome =
  | { status: 'saved'; role: RoleCatalogItem; catalog: RoleCatalogList; wrote: boolean; session: RoleSaveSession }
  | { status: 'failed'; error: ManagementError; partialNotice: string | null; metadataSaved: boolean; session: RoleSaveSession }
  | { status: 'stale' };

export function normalizeRoleError(reason: unknown): ManagementError {
  return { code: 'INTERNAL', message: String(reason), retryable: false };
}

async function guarded<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await run(); } catch (reason) { return { ok: false, error: normalizeRoleError(reason) }; }
}

export async function runRoleSave(request: RoleSaveRequest): Promise<RoleSaveOutcome> {
  const { management, workspaceId, values, reload } = request;
  const live = () => request.isLive?.() ?? true;
  let mode = request.session.mode;
  let base = request.session.base;
  let catalogSha = request.session.catalogSha;
  let metadataSaved = request.session.metadataSaved;
  let wrote = false;
  let roleId = base?.id ?? null;

  if (instructionBytes(values.instructions) > MAX_INSTRUCTION_BYTES) {
    return {
      status: 'failed',
      error: { code: 'BAD_REQUEST', message: PROMPT_TOO_LONG, retryable: false },
      partialNotice: null,
      metadataSaved,
      session: { mode, base, catalogSha, metadataSaved },
    };
  }

  const phase = (next: RoleSavePhase): void => { if (live()) request.onPhase?.(next); };
  const patch = (change: Partial<RoleSaveSession>): boolean => {
    if (!live()) return false;
    request.onSession?.(change);
    return true;
  };
  const fail = (error: ManagementError, partialNotice: string | null): RoleSaveOutcome => ({
    status: 'failed', error, partialNotice, metadataSaved, session: { mode, base, catalogSha, metadataSaved },
  });
  const stale = (): RoleSaveOutcome => ({ status: 'stale' });

  try {
    const plan = buildRoleSavePlan(mode, base, values);
    if (plan.create) {
      phase('saving_metadata');
      const result = await guarded(() => management.createRole(workspaceId, plan.create!, request.session.catalogSha));
      if (!live()) return stale();
      if (!result.ok) return fail(result.error, null);
      wrote = true;
      roleId = result.data.role.id;
      mode = 'edit';
      base = result.data.role;
      catalogSha = result.data.sha256;
      metadataSaved = true;
      if (!patch({ mode, base, catalogSha, metadataSaved })) return stale();
    } else if (plan.metadata && base) {
      phase('saving_metadata');
      const result = await guarded(() => management.updateRole(workspaceId, base!.id, plan.metadata!, catalogSha!));
      if (!live()) return stale();
      if (!result.ok) return fail(result.error, null);
      wrote = true;
      base = result.data.role;
      catalogSha = result.data.sha256;
      metadataSaved = true;
      if (!patch({ base, catalogSha, metadataSaved })) return stale();
    }

    if (!roleId) return fail(normalizeRoleError('Role id is missing.'), null);

    if (plan.instructionsChanged) {
      if (wrote) {
        phase('reloading_tokens');
        const reloaded = await guarded(() => reload());
        if (!live()) return stale();
        const role = reloaded.ok ? reloaded.data.items.find(item => item.id === roleId) : undefined;
        if (!reloaded.ok || !role) {
          return fail(reloaded.ok ? normalizeRoleError(`Role ${roleId} was not found after saving.`) : reloaded.error, TOKENS_MESSAGE);
        }
        base = role;
        catalogSha = reloaded.data.sha256;
        if (!patch({ base, catalogSha })) return stale();
      }
      phase('saving_instructions');
      const result = await guarded(() => management.updateRoleInstructions(workspaceId, roleId!, values.instructions, catalogSha!, base!.instructions.sha256));
      if (!live()) return stale();
      if (!result.ok) return fail(result.error, metadataSaved ? INSTRUCTIONS_MESSAGE : null);
      wrote = true;
      base = result.data.role;
      catalogSha = result.data.sha256;
      if (!patch({ base, catalogSha })) return stale();
    }

    phase('verifying');
    const verified = await guarded(() => reload());
    if (!live()) return stale();
    const role = verified.ok ? verified.data.items.find(item => item.id === roleId) : undefined;
    if (!verified.ok || !role) {
      return fail(verified.ok ? normalizeRoleError(`Role ${roleId} was not found after saving.`) : verified.error, VERIFY_MESSAGE);
    }
    catalogSha = verified.data.sha256;
    base = role;
    metadataSaved = true;
    return { status: 'saved', role, catalog: verified.data, wrote, session: { mode, base, catalogSha, metadataSaved } };
  } catch (reason) {
    if (!live()) return stale();
    return fail(normalizeRoleError(reason), null);
  }
}
