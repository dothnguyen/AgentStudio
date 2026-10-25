import { EventEmitter } from 'node:events';
import { WSL_NOT_FOUND, type ChildLike, type SpawnFn } from './childTypes';
import { cleanWslText } from './resolveEntry';
import { buildWslArgs } from './wslArgs';

export const PROTOCOL = 'agent-studio/v1';

export type ConnectionState = 'connecting' | 'connected' | 'lost';
export interface StateChange {
  state: ConnectionState;
  error: string | null;
}
export interface ServeErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
}
export interface ServeResponse {
  protocol: string;
  id: string | number | null;
  ok: boolean;
  data?: unknown;
  error?: ServeErrorBody;
}
export interface ConnectTarget {
  distro: string | null;
  entry: string;
  requestTimeoutMs: number;
}
export interface ServeClientOptions {
  spawn: SpawnFn;
  prepare: () => Promise<ConnectTarget>;
}
export type TransportCode = 'TIMEOUT' | 'CONNECTION_LOST' | 'NOT_CONNECTED';

export class ServeError extends Error {
  name = 'ServeError';
  constructor(
    public code: TransportCode,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  command: string;
  resolve: (r: ServeResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ServeClient extends EventEmitter {
  private child: ChildLike | null = null;
  private generation = 0;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private stdoutBuf = '';
  private stderrTail = '';
  private target: ConnectTarget | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private _state: ConnectionState = 'connecting';
  private _lastError: string | null = null;
  private _diagDistro: string | null = null;
  private _diagCommand: string | null = null;

  constructor(private opts: ServeClientOptions) {
    super();
  }

  get state(): ConnectionState {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get diagnostics(): { distro: string | null; command: string | null } {
    return { distro: this._diagDistro, command: this._diagCommand };
  }

  get distro(): string | null {
    return this.target?.distro ?? null;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.run().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  retry(): Promise<void> {
    if (this.starting) return this.starting;
    this.teardown();
    return this.start();
  }

  request(
    command: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<ServeResponse> {
    if (this._state !== 'connected' || !this.child) {
      return Promise.reject(
        new ServeError('NOT_CONNECTED', `Not connected to Agent Studio (state: ${this._state}).`),
      );
    }
    return this.send(command, args, opts.timeoutMs ?? this.target!.requestTimeoutMs, opts.idempotencyKey);
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private setState(state: ConnectionState, error: string | null): void {
    this._state = state;
    this._lastError = error;
    this.emit('state', { state, error } as StateChange);
  }

  private async run(): Promise<void> {
    this._diagDistro = null;
    this._diagCommand = null;
    this.setState('connecting', null);
    let target: ConnectTarget;
    try {
      target = await this.opts.prepare();
    } catch (e) {
      this.setState('lost', (e as Error).message);
      return;
    }
    if (this.stopped) return;
    this.target = target;
    this._diagDistro = target.distro;

    let args: string[];
    try {
      args = buildWslArgs(target.distro, ['--exec', target.entry, 'serve']);
    } catch (e) {
      this.setState('lost', (e as Error).message);
      return;
    }

    this._diagCommand = ['wsl.exe', ...args].join(' ');
    this.generation++;
    const gen = this.generation;
    const child = this.opts.spawn('wsl.exe', args);
    this.child = child;
    this.stdoutBuf = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(gen, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (gen !== this.generation) return;
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => {
      const tail = cleanWslText(this.stderrTail);
      this.onLoss(gen, `serve exited (code ${code}, signal ${signal})` + (tail ? `. stderr: ${tail}` : ''));
    });
    child.on('error', (err) => {
      this.onLoss(gen, err.code === 'ENOENT' ? WSL_NOT_FOUND : `Could not start wsl.exe: ${err.message}`);
    });

    try {
      const resp = await this.send('health', {}, target.requestTimeoutMs);
      if (resp.ok) {
        this.setState('connected', null);
      } else {
        this.teardown();
        this.setState('lost', `serve health check failed: ${resp.error?.code}: ${resp.error?.message}`);
      }
    } catch (e) {
      if (e instanceof ServeError && e.code === 'TIMEOUT') {
        this.teardown();
        this.setState('lost', `serve health check failed: ${e.message}`);
      }
      // CONNECTION_LOST: onLoss (or stop/retry) already handled the state.
    }
  }

  private send(
    command: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    idempotencyKey?: string,
  ): Promise<ServeResponse> {
    return new Promise<ServeResponse>((resolve, reject) => {
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ServeError('TIMEOUT', `serve did not answer "${command}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      const line =
        JSON.stringify({ protocol: PROTOCOL, id, command, args, ...(idempotencyKey ? { idempotencyKey } : {}) }) +
        '\n';
      this.child!.stdin.write(line, 'utf8');
    });
  }

  private onStdout(gen: number, chunk: string): void {
    if (gen !== this.generation) return;
    this.stdoutBuf += chunk;
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() ?? '';
    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this._lastError = `Unreadable line from serve: ${line.slice(0, 200)}`;
        continue;
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) continue;
      const m = msg as ServeResponse;
      if (m.id === null || m.id === undefined) continue;
      const key = String(m.id);
      const p = this.pending.get(key);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(key);
      p.resolve(m);
    }
  }

  private onLoss(gen: number, reason: string): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.child = null;
    this.rejectAll();
    this.setState('lost', reason);
  }

  private rejectAll(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(new ServeError('CONNECTION_LOST', `Connection to serve was lost before "${p.command}" was answered.`));
    }
  }

  private teardown(): void {
    this.rejectAll();
    if (this.child) {
      const child = this.child;
      this.generation++;
      this.child = null;
      child.stdin.end();
      child.kill();
    }
  }
}
