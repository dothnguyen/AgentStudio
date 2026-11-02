import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, BoardPhases, BoardSettings, BoardTicketList, ManagementApi, Result } from '../api';
import { BOARD_CHANGED_EVENT, CURRENT_PHASE_REFRESH_MS } from './CurrentPhaseScreen';

export interface BacklogData {
  phases: BoardPhases;
  settings: BoardSettings;
  tickets: BoardTicketList;
}

type Value = { state: 'loading' | 'ready' | 'error'; data: BacklogData | null; error: ApiError | null };

async function call<T>(load: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await load(); } catch (reason) {
    return { ok: false, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } };
  }
}

export function useBacklogData(management: ManagementApi, workspaceId: string, refreshMs = CURRENT_PHASE_REFRESH_MS): Value & { reload(): Promise<void> } {
  const [value, setValue] = useState<Value>({ state: 'loading', data: null, error: null });
  const sequence = useRef(0);
  const hasData = useRef(false);
  const load = useCallback(async (silent: boolean): Promise<void> => {
    const request = ++sequence.current;
    if (!silent || !hasData.current) setValue({ state: 'loading', data: null, error: null });
    const [phases, settings, tickets] = await Promise.all([
      call(() => management.boardPhases(workspaceId)),
      call(() => management.boardSettings(workspaceId)),
      call(() => management.boardTickets(workspaceId, {})),
    ]);
    if (request !== sequence.current) return;
    if (!phases.ok || !settings.ok || !tickets.ok) {
      hasData.current = false;
      const error = !phases.ok ? phases.error : !settings.ok ? settings.error : !tickets.ok ? tickets.error : null;
      setValue({ state: 'error', data: null, error });
      return;
    }
    hasData.current = true;
    setValue({ state: 'ready', data: { phases: phases.data, settings: settings.data, tickets: tickets.data }, error: null });
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
  return { ...value, reload };
}
