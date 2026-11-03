import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, BoardPhases, BoardSettings, BoardTicketList, ManagementApi, Result } from '../api';
import { BOARD_CHANGED_EVENT, CURRENT_PHASE_REFRESH_MS } from './CurrentPhaseScreen';

type PhaseData = { state: 'loading' | 'ready' | 'error'; tickets: BoardTicketList | null; error: ApiError | null };
export interface BacklogData { phases: BoardPhases; settings: BoardSettings }
type Value = { state: 'loading' | 'ready' | 'error'; data: BacklogData | null; error: ApiError | null };

async function call<T>(load: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await load(); } catch (reason) {
    return { ok: false, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } };
  }
}

export function useBacklogData(management: ManagementApi, workspaceId: string, refreshMs = CURRENT_PHASE_REFRESH_MS): Value & { phaseData: Record<string, PhaseData>; loadPhase(slug: string, force?: boolean): Promise<void>; reload(): Promise<void> } {
  const [value, setValue] = useState<Value>({ state: 'loading', data: null, error: null });
  const [phaseData, setPhaseData] = useState<Record<string, PhaseData>>({});
  const cache = useRef<Record<string, PhaseData>>({});
  const sequence = useRef(0);
  const phaseSequence = useRef<Record<string, number>>({});
  const hasData = useRef(false);
  const updatePhase = useCallback((slug: string, next: PhaseData) => {
    cache.current = { ...cache.current, [slug]: next };
    setPhaseData(cache.current);
  }, []);
  const fetchPhase = useCallback(async (slug: string, force = false) => {
    if (!force && cache.current[slug]) return;
    const request = (phaseSequence.current[slug] ?? 0) + 1;
    phaseSequence.current[slug] = request;
    updatePhase(slug, { state: 'loading', tickets: cache.current[slug]?.tickets ?? null, error: null });
    const result = await call(() => management.boardTickets(workspaceId, slug ? { phase: slug } : { unassigned: true }));
    if (phaseSequence.current[slug] !== request) return;
    updatePhase(slug, result.ok ? { state: 'ready', tickets: result.data, error: null } : { state: 'error', tickets: null, error: result.error });
  }, [management, workspaceId, updatePhase]);
  const load = useCallback(async (silent: boolean) => {
    const request = ++sequence.current;
    if (!silent || !hasData.current) setValue({ state: 'loading', data: null, error: null });
    const [phases, settings] = await Promise.all([call(() => management.boardPhases(workspaceId)), call(() => management.boardSettings(workspaceId))]);
    if (request !== sequence.current) return;
    if (!phases.ok || !settings.ok) {
      hasData.current = false;
      setValue({ state: 'error', data: null, error: !phases.ok ? phases.error : !settings.ok ? settings.error : null });
      return;
    }
    hasData.current = true;
    setValue({ state: 'ready', data: { phases: phases.data, settings: settings.data }, error: null });
    const current = phases.data.phases.find(phase => phase.current)?.slug;
    const slugs = new Set([...Object.keys(cache.current), ...(current ? [current] : [])]);
    await Promise.all([...slugs].filter(slug => !slug || phases.data.phases.some(phase => phase.slug === slug)).map(slug => fetchPhase(slug, true)));
  }, [management, workspaceId, fetchPhase]);
  useEffect(() => {
    cache.current = {}; phaseSequence.current = {}; setPhaseData({}); hasData.current = false;
    void load(false);
    const timer = refreshMs > 0 ? setInterval(() => { void load(true); }, refreshMs) : null;
    const onChange = () => { void load(true); };
    window.addEventListener(BOARD_CHANGED_EVENT, onChange);
    return () => { sequence.current += 1; for (const slug of Object.keys(phaseSequence.current)) phaseSequence.current[slug]! += 1; if (timer !== null) clearInterval(timer); window.removeEventListener(BOARD_CHANGED_EVENT, onChange); };
  }, [load, refreshMs]);
  return { ...value, phaseData, loadPhase: (slug, force) => fetchPhase(slug, force), reload: () => load(true) };
}
