import { useCallback, useEffect, useRef, useState } from 'react';

const COPY_STATUS_MS = 3000;

export interface CopyStatusController {
  status: string | null;
  copy(text: string, label: string): void;
}

/** Copies text when possible and announces the outcome for three seconds. Never throws. */
export function useCopyStatus(): CopyStatusController {
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((text: string) => {
    setStatus(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setStatus(null);
    }, COPY_STATUS_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const copy = useCallback((text: string, label: string) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setStatus(null);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      announce(`Could not copy ${label}`);
      return;
    }
    let written: Promise<void>;
    try {
      written = Promise.resolve(clipboard.writeText(text));
    } catch {
      announce(`Could not copy ${label}`);
      return;
    }
    written.then(
      () => announce(`Copied ${label}`),
      () => announce(`Could not copy ${label}`),
    );
  }, [announce]);

  return { status, copy };
}
