import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildLike, SpawnFn } from '../src/main/childTypes';
import type { ServeClient } from '../src/main/serveClient';

export class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  stdinText = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (c: string) => {
      this.stdinText += c;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  written(): any[] {
    return this.stdinText
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  }

  respond(obj: object): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }

  respondRaw(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.exit(null, 'SIGTERM'));
    return true;
  }
}

export function fakeSpawn(children: FakeChild[]): SpawnFn & { calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  let i = 0;
  const fn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    let c = children[i++];
    if (!c) {
      c = new FakeChild();
      children.push(c);
    }
    return c;
  }) as SpawnFn & { calls: { command: string; args: string[] }[] };
  fn.calls = calls;
  return fn;
}

export const flush = () => new Promise<void>((r) => setImmediate(r));
export const ok = (id: string, data: unknown = {}) => ({ protocol: 'agent-studio/v1', id, ok: true, data });

export async function connect(client: ServeClient, child: FakeChild): Promise<void> {
  const p = client.start();
  await flush();
  await flush();
  child.respond(ok(child.written()[0].id, { backendVersion: 'test' }));
  await p;
}
