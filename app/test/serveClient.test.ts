import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSL_NOT_FOUND } from '../src/main/childTypes';
import { ServeClient, ServeError, type ConnectTarget, type StateChange } from '../src/main/serveClient';
import { FakeChild, connect, fakeSpawn, flush, ok } from './fakeChild';

const ENTRY = '/home/me/.local/bin/agent-studio';
const target = (over: Partial<ConnectTarget> = {}): ConnectTarget => ({
  distro: 'Ubuntu',
  entry: ENTRY,
  requestTimeoutMs: 1000,
  ...over,
});

function setup(prepare: () => Promise<ConnectTarget> = async () => target()) {
  const children = [new FakeChild()];
  const spawn = fakeSpawn(children);
  const client = new ServeClient({ spawn, prepare });
  const events: StateChange[] = [];
  client.on('state', (s: StateChange) => events.push(s));
  return { children, spawn, client, events, child: children[0] };
}

async function caught(p: Promise<unknown>): Promise<ServeError> {
  try {
    await p;
  } catch (e) {
    return e as ServeError;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('spawn and handshake', () => {
  it('spawns wsl.exe with an argument array and sends health', async () => {
    const { client, spawn, child } = setup();
    await connect(client, child);
    expect(spawn.calls[0]).toEqual({ command: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', ENTRY, 'serve'] });
    expect(child.written()[0]).toEqual({ protocol: 'agent-studio/v1', id: '1', command: 'health', args: {} });
  });

  it('omits -d when distro is null', async () => {
    const { client, spawn, child } = setup(async () => target({ distro: null }));
    await connect(client, child);
    expect(spawn.calls[0].args).toEqual(['--exec', ENTRY, 'serve']);
  });

  it('refuses an unsafe entry path without spawning', async () => {
    const bad = '/home/me/my app/agent-studio';
    const { client, spawn } = setup(async () => target({ entry: bad }));
    await client.start();
    expect(client.state).toBe('lost');
    expect(client.lastError).toMatch(new RegExp(`^Refusing to put '${bad}'`));
    expect(spawn.calls.length).toBe(0);
  });

  it('emits connecting then connected', async () => {
    const { client, child, events } = setup();
    await connect(client, child);
    expect(events).toEqual([
      { state: 'connecting', error: null },
      { state: 'connected', error: null },
    ]);
  });

  it('start twice before handshake spawns once', async () => {
    const { client, spawn, child } = setup();
    const p1 = client.start();
    const p2 = client.start();
    await flush();
    await flush();
    child.respond(ok(child.written()[0].id));
    await Promise.all([p1, p2]);
    expect(spawn.calls.length).toBe(1);
  });

  it('retry during preparation joins the existing start', async () => {
    let release!: (value: ConnectTarget) => void;
    const prepared = new Promise<ConnectTarget>((resolve) => { release = resolve; });
    const { client, spawn, child } = setup(() => prepared);
    const first = client.start();
    const retry = client.retry();
    expect(retry).toBe(first);
    release(target());
    await flush();
    await flush();
    child.respond(ok(child.written()[0].id));
    await first;
    expect(spawn.calls).toHaveLength(1);
  });

  it('stop during preparation prevents the child from spawning', async () => {
    let release!: (value: ConnectTarget) => void;
    const prepared = new Promise<ConnectTarget>((resolve) => { release = resolve; });
    const { client, spawn, events } = setup(() => prepared);
    const starting = client.start();
    await flush();
    client.stop();
    release(target());
    await starting;
    expect(spawn.calls).toHaveLength(0);
    expect(events).toEqual([{ state: 'connecting', error: null }]);
  });

  it('handshake ok:false loses the connection and kills the child', async () => {
    const { client, child } = setup();
    const p = client.start();
    await flush();
    await flush();
    child.respond({
      protocol: 'agent-studio/v1',
      id: '1',
      ok: false,
      error: { code: 'INTERNAL', message: 'bad', retryable: false },
    });
    await p;
    expect(client.state).toBe('lost');
    expect(client.lastError).toBe('serve health check failed: INTERNAL: bad');
    expect(child.killed).toBe(true);
  });

  it('handshake timeout loses the connection and kills the child', async () => {
    const { client, child } = setup();
    const p = client.start();
    await flush();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(client.state).toBe('lost');
    expect(client.lastError).toBe('serve health check failed: serve did not answer "health" within 1000 ms');
    expect(child.killed).toBe(true);
  });

  it('wsl.exe missing yields one lost event with WSL_NOT_FOUND', async () => {
    const { client, child, events } = setup();
    const p = client.start();
    await flush();
    await flush();
    child.emit('error', Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }));
    child.exit(-4058);
    await p;
    const lost = events.filter((e) => e.state === 'lost');
    expect(lost).toEqual([{ state: 'lost', error: WSL_NOT_FOUND }]);
  });

  it('prepare failure is lost with the message and no spawn', async () => {
    const { client, spawn } = setup(async () => {
      throw new Error('cfg broken');
    });
    await client.start();
    expect(client.state).toBe('lost');
    expect(client.lastError).toBe('cfg broken');
    expect(spawn.calls.length).toBe(0);
  });
});

describe('requests', () => {
  it('keeps user text on stdin only', async () => {
    const { client, spawn, child } = setup();
    await connect(client, child);
    const text = "a b; rm -rf ~ 'q' $(x) %PATH%\nü😀";
    void client.request('debug.echo', { text });
    expect(spawn.calls.length).toBe(1);
    expect(spawn.calls[0].args).toEqual(['-d', 'Ubuntu', '--exec', ENTRY, 'serve']);
    expect(child.written()[1].args.text).toBe(text);
  });

  it('resolves with the full envelope', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    child.respond(ok('2', { x: 1 }));
    expect(await p).toEqual({ protocol: 'agent-studio/v1', id: '2', ok: true, data: { x: 1 } });
  });

  it('matches a numeric response id to the pending request id', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    child.respond({ protocol: 'agent-studio/v1', id: 2, ok: true, data: { numericId: true } });
    expect((await p).data).toEqual({ numericId: true });
  });

  it('matches out-of-order responses by id', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const a = client.request('snapshot');
    const b = client.request('snapshot');
    child.respond(ok('3', { n: 'B' }));
    child.respond(ok('2', { n: 'A' }));
    expect((await a).data).toEqual({ n: 'A' });
    expect((await b).data).toEqual({ n: 'B' });
  });

  it('resolves ok:false as data', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    const env = {
      protocol: 'agent-studio/v1',
      id: '2',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'x', retryable: false },
    };
    child.respond(env);
    expect(await p).toEqual(env);
  });

  it('ignores garbage, null-id and unknown-id lines', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    child.respondRaw('not json\n');
    child.respond({
      protocol: 'agent-studio/v1',
      id: null,
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'm', retryable: false },
    });
    child.respond(ok('999'));
    child.respond(ok('2', { done: true }));
    expect((await p).data).toEqual({ done: true });
    expect(client.lastError).toMatch(/^Unreadable line from serve: not json/);
    expect(client.state).toBe('connected');
  });

  it('handles chunked and CRLF lines', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    child.respondRaw('{"protocol":"agent-studio/v1","id":"2",');
    await flush();
    child.respondRaw('"ok":true,"data":{}}\r\n');
    expect((await p).ok).toBe(true);
  });

  it('times out without killing the child or changing state', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const p = client.request('snapshot');
    const assertion = caught(p);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await assertion;
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('serve did not answer "snapshot" within 1000 ms');
    expect(child.killed).toBe(false);
    expect(client.state).toBe('connected');
    child.respond(ok('2'));
    const next = client.request('snapshot');
    child.respond(ok('3'));
    expect((await next).ok).toBe(true);
  });

  it('honours a per-call timeout', async () => {
    const { client, child } = setup();
    await connect(client, child);
    const assertion = caught(client.request('snapshot', {}, { timeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(50);
    expect((await assertion).message).toBe('serve did not answer "snapshot" within 50 ms');
  });

  it('sends idempotencyKey when given', async () => {
    const { client, child } = setup();
    await connect(client, child);
    void client.request('x.mutate', { a: 1 }, { idempotencyKey: 'k1' });
    expect(child.written()[1].idempotencyKey).toBe('k1');
  });
});

describe('loss and retry', () => {
  async function lose() {
    const s = setup();
    await connect(s.client, s.child);
    const a = caught(s.client.request('snapshot'));
    const b = caught(s.client.request('snapshot'));
    s.child.stderr.write('boom\n');
    await flush();
    s.child.exit(1);
    return { ...s, a, b };
  }

  it('child exit rejects pending and emits lost with reason', async () => {
    const { a, b, events } = await lose();
    for (const e of [await a, await b]) {
      expect(e.code).toBe('CONNECTION_LOST');
      expect(e.message).toBe('Connection to serve was lost before "snapshot" was answered.');
    }
    expect(events[events.length - 1]).toEqual({
      state: 'lost',
      error: 'serve exited (code 1, signal null). stderr: boom',
    });
  });

  it('never restarts or re-sends automatically', async () => {
    const { client, spawn, events, a, b } = await lose();
    await a;
    await b;
    const n = events.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(spawn.calls.length).toBe(1);
    expect(events.length).toBe(n);
    const err = await caught(client.request('health'));
    expect(err.code).toBe('NOT_CONNECTED');
    expect(err.message).toBe('Not connected to Agent Studio (state: lost).');
  });

  it('retry after loss starts a fresh child without re-sending', async () => {
    const { client, spawn, children, events, a, b } = await lose();
    await a;
    await b;
    const before = events.length;
    const second = new FakeChild();
    children.push(second);
    const p = client.retry();
    await flush();
    await flush();
    second.respond(ok(second.written()[0].id));
    await p;
    expect(spawn.calls.length).toBe(2);
    expect(events.slice(before).map((e) => e.state)).toEqual(['connecting', 'connected']);
    const w = second.written();
    expect(w.length).toBe(1);
    expect(w[0].command).toBe('health');
    expect(w[0].id).not.toBe('1');
  });

  it('retry while connected kills the old child and rejects pending', async () => {
    const { client, children, events, child } = setup();
    await connect(client, child);
    const pend = caught(client.request('snapshot'));
    const p = client.retry();
    expect(child.killed).toBe(true);
    expect((await pend).code).toBe('CONNECTION_LOST');
    await flush();
    await flush();
    expect(events.filter((e) => e.state === 'lost').length).toBe(0);
    children[1].respond(ok(children[1].written()[0].id));
    await p;
    expect(client.state).toBe('connected');
  });

  it('ignores delayed loss events from an earlier child after retry connects', async () => {
    const { client, children, events, child } = setup();
    await connect(client, child);
    const p = client.retry();
    await flush();
    await flush();
    const replacement = children[1];
    replacement.respond(ok(replacement.written()[0].id));
    await p;

    const eventCount = events.length;
    child.emit('exit', 1, null);
    expect(client.state).toBe('connected');
    expect(events).toHaveLength(eventCount);
  });

  it('stop kills the child, emits nothing and blocks retry', async () => {
    const { client, spawn, child, events } = setup();
    await connect(client, child);
    const n = events.length;
    client.stop();
    await flush();
    expect(child.killed).toBe(true);
    expect(events.length).toBe(n);
    await client.retry();
    expect(spawn.calls.length).toBe(1);
  });

  it('start after stop does not prepare or spawn', async () => {
    let prepares = 0;
    const children = [new FakeChild()];
    const spawn = fakeSpawn(children);
    const client = new ServeClient({
      spawn,
      prepare: async () => {
        prepares += 1;
        return target();
      },
    });
    client.stop();
    await client.start();
    expect(prepares).toBe(0);
    expect(spawn.calls).toHaveLength(0);
  });
});
