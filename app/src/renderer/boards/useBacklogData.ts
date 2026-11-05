import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, BoardPhases, BoardSettings, BoardTicketList, BoardTicketSummary, ManagementApi, Result } from '../api';
import { BOARD_CHANGED_EVENT, CURRENT_PHASE_REFRESH_MS } from './CurrentPhaseScreen';

type PhaseData = { state: 'loading' | 'ready' | 'error'; tickets: BoardTicketList | null; error: ApiError | null; refreshing?: boolean };
export interface BacklogData { phases: BoardPhases; settings: BoardSettings }
type Value = { state: 'loading' | 'ready' | 'error'; data: BacklogData | null; error: ApiError | null; refreshError: ApiError | null };

async function call<T>(load: () => Promise<Result<T>>): Promise<Result<T>> {
  try { return await load(); } catch (reason) {
    return { ok: false, error: { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason), retryable: false } };
  }
}

export function useBacklogData(management: ManagementApi, workspaceId: string, refreshMs = CURRENT_PHASE_REFRESH_MS): Value & { phaseData: Record<string, PhaseData>; loadPhase(slug: string, force?: boolean): Promise<void>; reload(): Promise<void>; reconcile(ticket: BoardTicketSummary, changes: Partial<BoardTicketSummary>): void } {
  const [value, setValue] = useState<Value>({ state: 'loading', data: null, error: null, refreshError: null });
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
    const previous = cache.current[slug];
    const loaded = previous?.tickets != null;
    const request = (phaseSequence.current[slug] ?? 0) + 1;
    phaseSequence.current[slug] = request;
    // A background refresh keeps the loaded rows visible; loading UI is for a first read only.
    updatePhase(slug, loaded
      ? { state: 'ready', tickets: previous!.tickets, error: previous!.error, refreshing: true }
      : { state: 'loading', tickets: null, error: null, refreshing: false });
    const result = await call(() => management.boardTickets(workspaceId, slug ? { phase: slug } : { unassigned: true }));
    if (phaseSequence.current[slug] !== request) return;
    if (result.ok) updatePhase(slug, { state: 'ready', tickets: result.data, error: null, refreshing: false });
    else if (loaded) updatePhase(slug, { state: 'error', tickets: previous!.tickets, error: result.error, refreshing: false });
    else updatePhase(slug, { state: 'error', tickets: null, error: result.error, refreshing: false });
  }, [management, workspaceId, updatePhase]);
  const load = useCallback(async (silent: boolean) => {
    const request = ++sequence.current;
    const background = silent && hasData.current;
    if (!background) setValue({ state: 'loading', data: null, error: null, refreshError: null });
    const [phases, settings] = await Promise.all([call(() => management.boardPhases(workspaceId)), call(() => management.boardSettings(workspaceId))]);
    if (request !== sequence.current) return;
    if (!phases.ok || !settings.ok) {
      const error = !phases.ok ? phases.error : !settings.ok ? settings.error : null;
      if (background) {
        // Keep the last successful content visible and offer a non-destructive retry.
        setValue(current => current.data ? { ...current, refreshError: error } : { state: 'error', data: null, error, refreshError: null });
        return;
      }
      hasData.current = false;
      setValue({ state: 'error', data: null, error, refreshError: null });
      return;
    }
    hasData.current = true;
    setValue({ state: 'ready', data: { phases: phases.data, settings: settings.data }, error: null, refreshError: null });
    const known = new Set(phases.data.phases.map(phase => phase.slug));
    const stale = Object.keys(cache.current).filter(slug => slug !== '' && !known.has(slug));
    if (stale.length > 0) {
      const next = { ...cache.current };
      for (const slug of stale) {
        delete next[slug];
        phaseSequence.current[slug] = (phaseSequence.current[slug] ?? 0) + 1;
      }
      cache.current = next;
      setPhaseData(cache.current);
    }
    const current = phases.data.phases.find(phase => phase.current)?.slug;
    const slugs = new Set([...Object.keys(cache.current), ...(current ? [current] : [])]);
    await Promise.all([...slugs].filter(slug => !slug || known.has(slug)).map(slug => fetchPhase(slug, true)));
  }, [management, workspaceId, fetchPhase]);
  useEffect(() => {
    cache.current = {}; phaseSequence.current = {}; setPhaseData({}); hasData.current = false;
    void load(false);
    const timer = refreshMs > 0 ? setInterval(() => { void load(true); }, refreshMs) : null;
    const onChange = () => { void load(true); };
    window.addEventListener(BOARD_CHANGED_EVENT, onChange);
    return () => { sequence.current += 1; for (const slug of Object.keys(phaseSequence.current)) phaseSequence.current[slug]! += 1; if (timer !== null) clearInterval(timer); window.removeEventListener(BOARD_CHANGED_EVENT, onChange); };
  }, [load, refreshMs]);
  const reconcile = useCallback((ticket: BoardTicketSummary, changes: Partial<BoardTicketSummary>) => {
    const updated = { ...ticket, ...changes };
    const oldSlug = ticket.phase ?? '';
    const newSlug = updated.phase ?? '';
    const next = { ...cache.current };
    for (const slug of new Set([oldSlug, newSlug])) {
      const entry = next[slug];
      if (!entry?.tickets) continue;
      const remaining = entry.tickets.tickets.filter(item => item.key !== ticket.key);
      next[slug] = { ...entry, tickets: { ...entry.tickets, tickets: slug === newSlug ? [...remaining, updated] : remaining } };
      phaseSequence.current[slug] = (phaseSequence.current[slug] ?? 0) + 1;
    }
    cache.current = next;
    setPhaseData(next);
    if (oldSlug !== newSlug) setValue(current => current.data ? { ...current, data: { ...current.data, phases: { ...current.data.phases, phases: current.data.phases.phases.map(phase => ({ ...phase, ticketCount: phase.ticketCount + (phase.slug === newSlug ? 1 : 0) - (phase.slug === oldSlug ? 1 : 0) })), unassignedTicketCount: (current.data.phases.unassignedTicketCount ?? 0) + (newSlug === '' ? 1 : 0) - (oldSlug === '' ? 1 : 0) } } } : current);
  }, []);
  return { ...value, phaseData, reconcile, loadPhase: (slug, force) => fetchPhase(slug, force), reload: () => load(true) };
}
