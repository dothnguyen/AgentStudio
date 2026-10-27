import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, Result } from '../api';

export type DashboardSectionState = 'loading' | 'ready' | 'error';

export interface DashboardSectionController<T> {
  state: DashboardSectionState;
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  lastUpdatedAt: number | null;
  reload(): Promise<void>;
  reloadFresh?(): Promise<Result<T>>;
}

export type DashboardSection<T> = DashboardSectionController<T>;

type SectionValue<T> = Omit<DashboardSectionController<T>, 'reload' | 'reloadFresh' | 'loading'>;

interface Request<T> {
  sequence: number;
  load: (workspaceId: string) => Promise<Result<T>>;
  workspaceId: string;
  completion: Promise<Result<T>>;
}

export function useDashboardSection<T>(
  load: (workspaceId: string) => Promise<Result<T>>,
  workspaceId: string,
): DashboardSectionController<T> {
  const [value, setValue] = useState<SectionValue<T>>({
    state: 'loading',
    data: null,
    error: null,
    lastUpdatedAt: null,
  });
  const sequence = useRef(0);
  const active = useRef(true);
  const current = useRef({ load, workspaceId });
  const inFlight = useRef<Request<T> | null>(null);
  const loadedWorkspaceId = useRef(workspaceId);
  current.current = { load, workspaceId };

  const start = useCallback((requestLoad: typeof load, requestWorkspaceId: string, resetTime: boolean, fresh = false): Promise<Result<T>> => {
    if (!active.current) return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'Section is inactive.', retryable: false } });
    const pending = inFlight.current;
    if (!fresh && pending?.load === requestLoad && pending.workspaceId === requestWorkspaceId) return pending.completion;

    const request: Request<T> = {
      sequence: ++sequence.current,
      load: requestLoad,
      workspaceId: requestWorkspaceId,
      completion: Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'Request not started.', retryable: false } }),
    };
    inFlight.current = request;
    setValue((previous) => ({
      state: 'loading',
      data: null,
      error: null,
      lastUpdatedAt: resetTime ? null : previous.lastUpdatedAt,
    }));

    let call: Promise<Result<T>>;
    try {
      call = Promise.resolve(requestLoad(requestWorkspaceId));
    } catch (reason) {
      call = Promise.reject(reason);
    }
    request.completion = call.then(
      (result) => {
        if (
          !active.current ||
          sequence.current !== request.sequence ||
          current.current.load !== request.load ||
          current.current.workspaceId !== request.workspaceId
        ) return { ok: false as const, error: { code: 'INTERNAL', message: 'Settings refresh was superseded.', retryable: true } };
        if (inFlight.current === request) inFlight.current = null;
        if (result.ok) {
          setValue({ state: 'ready', data: result.data, error: null, lastUpdatedAt: Date.now() });
        } else {
          setValue((previous) => ({
            state: 'error',
            data: null,
            error: result.error,
            lastUpdatedAt: previous.lastUpdatedAt,
          }));
        }
        return result;
      },
      (reason: unknown) => {
        const error = { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false };
        if (
          !active.current ||
          sequence.current !== request.sequence ||
          current.current.load !== request.load ||
          current.current.workspaceId !== request.workspaceId
        ) return { ok: false as const, error };
        if (inFlight.current === request) inFlight.current = null;
        setValue((previous) => ({
          state: 'error',
          data: null,
          error,
          lastUpdatedAt: previous.lastUpdatedAt,
        }));
        return { ok: false as const, error };
      },
    );
    return request.completion;
  }, []);

  useEffect(() => {
    active.current = true;
    const workspaceChanged = loadedWorkspaceId.current !== workspaceId;
    loadedWorkspaceId.current = workspaceId;
    const pending = inFlight.current;
    if (pending?.load === load && pending.workspaceId === workspaceId) {
      // StrictMode replays an effect's cleanup and setup. Re-adopt the same
      // request after cleanup invalidated its sequence instead of loading twice.
      pending.sequence = sequence.current;
    }
    start(load, workspaceId, workspaceChanged);
    return () => {
      active.current = false;
      ++sequence.current;
    };
  }, [load, start, workspaceId]);

  const reload = useCallback(
    async () => { await start(current.current.load, current.current.workspaceId, false); },
    [start],
  );

  const reloadFresh = useCallback(() => start(current.current.load, current.current.workspaceId, false, true), [start]);
  return { ...value, loading: value.state === 'loading', reload, reloadFresh };
}
