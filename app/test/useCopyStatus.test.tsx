// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCopyStatus } from '../src/renderer/ui/useCopyStatus';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

describe('useCopyStatus', () => {
  it('announces a successful copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { result } = renderHook(() => useCopyStatus());
    expect(result.current.status).toBeNull();
    await act(async () => { result.current.copy('team-1', 'Team id'); });
    expect(writeText).toHaveBeenCalledWith('team-1');
    expect(result.current.status).toBe('Copied Team id');
  });

  it('announces a rejected clipboard write instead of throwing', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useCopyStatus());
    await act(async () => { result.current.copy('team-1', 'Team id'); });
    expect(result.current.status).toBe('Could not copy Team id');
  });

  it('announces the failure when there is no clipboard API', () => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    const { result } = renderHook(() => useCopyStatus());
    act(() => { result.current.copy('team-1', 'Team id'); });
    expect(result.current.status).toBe('Could not copy Team id');
  });

  it('never throws when writeText throws synchronously', () => {
    setClipboard({ writeText: () => { throw new Error('nope'); } });
    const { result } = renderHook(() => useCopyStatus());
    act(() => { expect(() => result.current.copy('team-1', 'Team id')).not.toThrow(); });
    expect(result.current.status).toBe('Could not copy Team id');
  });

  it('clears the announcement after three seconds', async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useCopyStatus());
    await act(async () => {
      result.current.copy('team-1', 'Team id');
      await Promise.resolve();
    });
    expect(result.current.status).toBe('Copied Team id');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.status).toBeNull();
  });
});
