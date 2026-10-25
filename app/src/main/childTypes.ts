import type { Readable, Writable } from 'node:stream';

export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): this;
}

export type SpawnFn = (command: string, args: string[]) => ChildLike;

export const WSL_NOT_FOUND = 'wsl.exe was not found on this computer. Install WSL (wsl --install) and try again.';
