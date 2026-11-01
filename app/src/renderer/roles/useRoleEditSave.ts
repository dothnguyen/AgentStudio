import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagementApi, ManagementError, Result, RoleCatalogItem, RoleCatalogList } from '../api';
import type { RoleFormMode, RoleFormValues } from './roleEditModel';
import { runRoleSave, type RoleSaveOutcome, type RoleSavePhase, type RoleSaveSession } from './roleSave';

export interface UseRoleEditSaveOptions {
  management: ManagementApi;
  workspaceId: string;
  /** "create" has no base role; "edit" keeps the role the dialog was opened with. */
  mode: RoleFormMode;
  role: RoleCatalogItem | null;
  catalogSha: string | null;
  /** Reloads the roles catalog from disk (fresh, without the cached request). */
  reload(): Promise<Result<RoleCatalogList>>;
  /** Reports the busy state so the owning screen can disable other role actions. */
  onPendingChange?(pending: boolean): void;
}

export interface RoleEditSaveController {
  pending: boolean;
  phase: RoleSavePhase;
  error: ManagementError | null;
  partialNotice: string | null;
  /** Writes the draft through the shared role save sequence. */
  save(values: RoleFormValues): Promise<RoleSaveOutcome>;
  /**
   * Reloads current values after a conflict and keeps the draft. The next save
   * uses the refreshed catalog token and role base.
   */
  reloadCurrent(): Promise<Result<RoleCatalogList>>;
  /**
   * Dismisses a save failure after the person edits the draft again. A conflict
   * keeps its message and Reload action: retrying without fresh tokens would
   * only conflict again.
   */
  clearError(): void;
  clear(): void;
}

/**
 * Dialog-level state around {@link runRoleSave}. It keeps the session base and
 * catalog token across retries, so a partially saved draft (for example
 * description written but instructions rejected) continues from the values the
 * backend already accepted instead of overwriting them with a stale token.
 */
export function useRoleEditSave(options: UseRoleEditSaveOptions): RoleEditSaveController {
  const { management, workspaceId, reload, mode, role, catalogSha } = options;
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<RoleSavePhase>('idle');
  const [error, setError] = useState<ManagementError | null>(null);
  const [partialNotice, setPartialNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const base = useRef<RoleCatalogItem | null>(role);
  const sha = useRef<string | null>(catalogSha);
  const modeRef = useRef<RoleFormMode>(mode);
  const metadataSaved = useRef(false);
  const pendingChange = useRef(options.onPendingChange);
  pendingChange.current = options.onPendingChange;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingChange.current?.(false);
    };
  }, []);

  const setBusy = useCallback((next: boolean) => {
    if (!mounted.current) return;
    setPending(next);
    pendingChange.current?.(next);
  }, []);

  const clearError = useCallback(() => {
    setError(current => current !== null && current.code === 'CONFIG_CHANGED' ? current : null);
  }, []);

  const clear = useCallback(() => {
    setError(null);
    setPartialNotice(null);
    setPhase('idle');
  }, []);

  const save = useCallback(async (values: RoleFormValues): Promise<RoleSaveOutcome> => {
    if (lock.current) return { status: 'stale' };
    lock.current = true;
    setBusy(true);
    setError(null);
    setPartialNotice(null);
    const session: RoleSaveSession = {
      mode: modeRef.current,
      base: base.current,
      catalogSha: sha.current,
      metadataSaved: metadataSaved.current,
    };
    try {
      const outcome = await runRoleSave({
        management,
        workspaceId,
        session,
        values,
        reload,
        isLive: () => mounted.current,
        onPhase: next => { if (mounted.current) setPhase(next); },
        onSession: change => {
          if (change.mode !== undefined) { modeRef.current = change.mode; session.mode = change.mode; }
          if (change.base !== undefined) { base.current = change.base; session.base = change.base; }
          if (change.catalogSha !== undefined) { sha.current = change.catalogSha; session.catalogSha = change.catalogSha; }
          if (change.metadataSaved !== undefined) { metadataSaved.current = change.metadataSaved; session.metadataSaved = change.metadataSaved; }
        },
      });
      if (!mounted.current) return { status: 'stale' };
      setBusy(false);
      setPhase('idle');
      if (outcome.status === 'failed') {
        setError(outcome.error);
        setPartialNotice(outcome.partialNotice);
      }
      return outcome;
    } finally {
      lock.current = false;
    }
  }, [management, workspaceId, mode, reload, setBusy]);

  const reloadCurrent = useCallback(async (): Promise<Result<RoleCatalogList>> => {
    const result = await reload();
    if (mounted.current && result.ok) {
      sha.current = result.data.sha256;
      const current = base.current;
      if (current !== null && modeRef.current === 'edit') {
        const fresh = result.data.items.find(item => item.id === current.id);
        if (fresh !== undefined) {
          base.current = fresh;
        }
      }
    }
    return result;
  }, [reload, mode]);

  return { pending, phase, error, partialNotice, save, reloadCurrent, clearError, clear };
}
