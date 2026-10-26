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
}

export type DashboardSection<T> = DashboardSectionController<T>;

type SectionValue<T> = Omit<DashboardSectionController<T>, 'reload' | 'loading'>;

interface Request<T> {
  sequence: number;
  load: (workspaceId: string) => Promise<Result<T>>;
  workspaceId: string;
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

  const start = useCallback((requestLoad: typeof load, requestWorkspaceId: string, resetTime: boolean): Promise<void> => {
    if (!active.current) return Promise.resolve();
    const pending = inFlight.current;
    if (pending?.load === requestLoad && pending.workspaceId === requestWorkspaceId) return Promise.resolve();

    const request: Request<T> = {
      sequence: ++sequence.current,
      load: requestLoad,
      workspaceId: requestWorkspaceId,
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
    return call.then(
      (result) => {
        if (
          !active.current ||
          sequence.current !== request.sequence ||
          current.current.load !== request.load ||
          current.current.workspaceId !== request.workspaceId
        ) return;
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
      },
      (reason: unknown) => {
        if (
          !active.current ||
          sequence.current !== request.sequence ||
          current.current.load !== request.load ||
          current.current.workspaceId !== request.workspaceId
        ) return;
        if (inFlight.current === request) inFlight.current = null;
        setValue((previous) => ({
          state: 'error',
          data: null,
          error: {
            code: 'INTERNAL',
            message: reason instanceof Error ? reason.message : String(reason),
            retryable: false,
          },
          lastUpdatedAt: previous.lastUpdatedAt,
        }));
      },
    );
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
    () => start(current.current.load, current.current.workspaceId, false),
    [start],
  );

  return { ...value, loading: value.state === 'loading', reload };
}
