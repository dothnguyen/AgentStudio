import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagementApi, ManagementError, RoleCatalogList, Result } from '../api';
import type { RoleFormValues } from './roleEditModel';
import { runRoleSave, type RoleSaveOutcome, type RoleSavePhase, type RoleSaveSession } from './roleSave';

export interface UseRoleSaveOptions {
  management: ManagementApi;
  workspaceId: string;
  reload(): Promise<Result<RoleCatalogList>>;
}

export interface RoleSaveController {
  pending: boolean;
  phase: RoleSavePhase;
  error: ManagementError | null;
  partialNotice: string | null;
  save(session: RoleSaveSession, values: RoleFormValues): Promise<RoleSaveOutcome>;
  clear(): void;
}

/**
 * Small state holder around the shared {@link runRoleSave} sequence. It keeps
 * the dialog busy state, progress label and failure feedback in one place.
 */
export function useRoleSave(options: UseRoleSaveOptions): RoleSaveController {
  const { management, workspaceId, reload } = options;
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<RoleSavePhase>('idle');
  const [error, setError] = useState<ManagementError | null>(null);
  const [partialNotice, setPartialNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const clear = useCallback(() => {
    setError(null);
    setPartialNotice(null);
    setPhase('idle');
  }, []);

  const save = useCallback(async (session: RoleSaveSession, values: RoleFormValues): Promise<RoleSaveOutcome> => {
    if (lock.current) return { status: 'stale' };
    lock.current = true;
    setPending(true);
    setError(null);
    setPartialNotice(null);
    try {
      const outcome = await runRoleSave({
        management,
        workspaceId,
        session,
        values,
        reload,
        isLive: () => mounted.current,
        onPhase: next => { if (mounted.current) setPhase(next); },
      });
      if (!mounted.current) return { status: 'stale' };
      setPending(false);
      setPhase('idle');
      if (outcome.status === 'failed') {
        setError(outcome.error);
        setPartialNotice(outcome.partialNotice);
      }
      return outcome;
    } finally {
      lock.current = false;
    }
  }, [management, workspaceId, reload]);

  return { pending, phase, error, partialNotice, save, clear };
}
