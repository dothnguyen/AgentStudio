import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, BoardPhases, BoardSettings, ManagementApi, Result } from '../api';
import { BOARD_CHANGED_EVENT, CURRENT_PHASE_REFRESH_MS } from './CurrentPhaseScreen';

export interface PhasesData {
  phases: BoardPhases;
  settings: BoardSettings;
}

type Value = { state: 'loading' | 'ready' | 'error'; data: PhasesData | null; error: ApiError | null };

async function call<T>(load: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await load(); } catch (reason) {
    return { ok: false, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } };
  }
}

export function usePhasesData(management: ManagementApi, workspaceId: string, refreshMs = CURRENT_PHASE_REFRESH_MS): Value & { reload(): Promise<void>; reconcileCreated(phase: import('../api').BoardPhase): void } {
  const [value, setValue] = useState<Value>({ state: 'loading', data: null, error: null });
  const sequence = useRef(0);
  const hasData = useRef(false);
  const load = useCallback(async (silent: boolean): Promise<void> => {
    const request = ++sequence.current;
    if (!silent || !hasData.current) setValue({ state: 'loading', data: null, error: null });
    const [phases, settings] = await Promise.all([
      call(() => management.boardPhases(workspaceId)),
      call(() => management.boardSettings(workspaceId)),
    ]);
    if (request !== sequence.current) return;
    if (!phases.ok || !settings.ok) {
      hasData.current = false;
      const error = !phases.ok ? phases.error : !settings.ok ? settings.error : null;
      setValue({ state: 'error', data: null, error });
      return;
    }
    hasData.current = true;
    setValue({ state: 'ready', data: { phases: phases.data, settings: settings.data }, error: null });
  }, [management, workspaceId]);

  useEffect(() => {
    hasData.current = false;
    void load(false);
    const timer = refreshMs > 0 ? setInterval(() => { void load(true); }, refreshMs) : null;
    const onChange = (): void => { void load(true); };
    window.addEventListener(BOARD_CHANGED_EVENT, onChange);
    return () => {
      sequence.current += 1;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener(BOARD_CHANGED_EVENT, onChange);
    };
  }, [load, refreshMs]);
  const reload = useCallback(async () => { await load(false); }, [load]);
  const reconcileCreated = useCallback((phase: import('../api').BoardPhase) => {
    setValue(current => {
      if (!current.data) return current;
      const existing = current.data.phases.phases;
      if (existing.some(item => item.slug === phase.slug)) return current;
      const phases = [...existing.map(item => item.position >= phase.position ? { ...item, position: item.position + 1 } : item), phase];
      return { ...current, data: { ...current.data, phases: { ...current.data.phases, phases } } };
    });
  }, []);
  return { ...value, reload, reconcileCreated };
}
