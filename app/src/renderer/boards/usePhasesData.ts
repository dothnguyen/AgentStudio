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

export function usePhasesData(management: ManagementApi, workspaceId: string, refreshMs = CURRENT_PHASE_REFRESH_MS): Value & { reload(): Promise<void>; refresh(): Promise<void>; reconcileCreated(phase: import('../api').BoardPhase): void; reconcileCurrent(slug: string): void } {
  const [value, setValue] = useState<Value>({ state: 'loading', data: null, error: null });
  const sequence = useRef(0);
  const hasData = useRef(false);
  const ignoreNextBoardChange = useRef(false);
  const createdPhases = useRef(new Map<string, import('../api').BoardPhase>());
  const load = useCallback(async (silent: boolean): Promise<void> => {
    const request = ++sequence.current;
    if (!silent || !hasData.current) setValue(current => ({ state: 'loading', data: silent ? current.data : null, error: null }));
    const [phases, settings] = await Promise.all([
      call(() => management.boardPhases(workspaceId)),
      call(() => management.boardSettings(workspaceId)),
    ]);
    if (request !== sequence.current) return;
    if (!phases.ok || !settings.ok) {
      if (silent && hasData.current) {
        const error = !phases.ok ? phases.error : !settings.ok ? settings.error : null;
        setValue(current => ({ ...current, state: 'ready', error }));
        return;
      }
      hasData.current = false;
      const error = !phases.ok ? phases.error : !settings.ok ? settings.error : null;
      setValue({ state: 'error', data: null, error });
      return;
    }
    hasData.current = true;
    // A read that races the write, or comes from a briefly stale API snapshot,
    // must not remove a phase already acknowledged by createPhase.
    const remote = phases.data.phases;
    const missingCreated = [...createdPhases.current.values()].filter(created => !remote.some(item => item.slug === created.slug));
    const merged = missingCreated.length
      ? [...remote.map(item => item.position >= Math.min(...missingCreated.map(created => created.position)) ? { ...item, position: item.position + missingCreated.length } : item), ...missingCreated]
      : remote;
    setValue({ state: 'ready', data: { phases: { ...phases.data, phases: merged }, settings: settings.data }, error: null });
  }, [management, workspaceId]);

  useEffect(() => {
    hasData.current = false;
    void load(false);
    const timer = refreshMs > 0 ? setInterval(() => { void load(true); }, refreshMs) : null;
    const onChange = (): void => {
      if (ignoreNextBoardChange.current) { ignoreNextBoardChange.current = false; return; }
      void load(true);
    };
    window.addEventListener(BOARD_CHANGED_EVENT, onChange);
    return () => {
      sequence.current += 1;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener(BOARD_CHANGED_EVENT, onChange);
    };
  }, [load, refreshMs]);
  const reload = useCallback(async () => { await load(false); }, [load]);
  const reconcileCreated = useCallback((phase: import('../api').BoardPhase) => {
    // Invalidate reads started before the mutation so an older snapshot cannot erase it.
    sequence.current += 1;
    setValue(current => {
      if (!current.data) return current;
      const existing = current.data.phases.phases;
      if (existing.some(item => item.slug === phase.slug)) return current;
      if (!createdPhases.current.has(phase.slug)) createdPhases.current.set(phase.slug, phase);
      const phases = [...existing.map(item => item.position >= phase.position ? { ...item, position: item.position + 1 } : item), phase];
      return { ...current, data: { ...current.data, phases: { ...current.data.phases, phases } } };
    });
  }, []);
  const reconcileCurrent = useCallback((slug: string) => {
    sequence.current += 1;
    setValue(current => {
      if (!current.data) return current;
      const selected = current.data.phases.phases.find(item => item.slug === slug);
      if (!selected) return current;
      return { ...current, data: { ...current.data, phases: { ...current.data.phases, currentPhase: selected, phases: current.data.phases.phases.map(item => ({ ...item, current: item.slug === slug })) } } };
    });
    // Notify navigation and other board views, but do not immediately overwrite
    // this optimistic reconciliation with a read that can still be stale.
    ignoreNextBoardChange.current = true;
    window.dispatchEvent(new Event(BOARD_CHANGED_EVENT));
  }, []);
  const refresh = useCallback(async () => { await load(true); }, [load]);
  return { ...value, reload, refresh, reconcileCreated, reconcileCurrent };
}
