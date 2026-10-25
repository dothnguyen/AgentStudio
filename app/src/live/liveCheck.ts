import * as fs from 'node:fs';
import * as path from 'node:path';
import { WSL_NOT_FOUND } from '../main/childTypes';
import { loadConfig } from '../main/config';
import { makePrepare, realSpawn } from '../main/connection';
import { runWsl } from '../main/resolveEntry';
import { ServeClient, ServeError, type ConnectTarget } from '../main/serveClient';
import type { SpawnFn } from '../main/childTypes';
import {
  allDistinct,
  lastJsonLine,
  parseArgs,
  toWslRepoPath,
  waitForState,
  withWslEnvVar,
  type LiveOptions,
} from './liveSupport';

const HELPER_REL = 'scripts/live/app-live-helper.py';
const NO_DISTRO = 'agent-studio-no-such-distro';
const NO_ENTRY = '/nonexistent/agent-studio';
const NO_WSL_EXE = 'agent-studio-no-such-wsl.exe';
const STATE_TIMEOUT_MS = 20000;

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

class Abort extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function runLiveCheck(opts: LiveOptions): Promise<number> {
  if (process.platform !== 'win32') {
    console.log('The live check must run on Windows (PowerShell): it drives wsl.exe from Windows.');
    return 2;
  }
  const steps: Step[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  // Runs fn; fn returns a detail string, or throws. Returns the detail when it passed.
  const step = async (name: string, abort: boolean, fn: () => Promise<string>): Promise<void> => {
    try {
      record(name, true, await fn());
    } catch (e) {
      record(name, false, (e as Error).message);
      if (abort) throw new Abort(name);
    }
  };
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  let cfg: ReturnType<typeof loadConfig>;
  let configPath = '';
  let repoRoot = '';
  let helper = '';
  try {
    if (opts.distro) process.env.AGENT_STUDIO_DISTRO = opts.distro;
    if (opts.entry) process.env.AGENT_STUDIO_ENTRY = opts.entry;
    configPath = path.join(process.env.APPDATA ?? '', 'agent-studio-app', 'config.json');
    cfg = loadConfig(process.env, configPath);
    repoRoot = path.resolve(__dirname, '..', '..', '..');
    const repoWsl = opts.repoWsl ?? toWslRepoPath(repoRoot);
    helper = repoWsl + '/' + HELPER_REL;
    record('config', true, `distro=${cfg.distro ?? '(default)'} helper=${helper}`);
  } catch (e) {
    record('config', false, (e as Error).message);
    console.log('LIVE CHECK FAIL');
    return 1;
  }

  let root: string | undefined;
  let state: string | undefined;
  let workspace = '';
  let client: ServeClient | undefined;
  let target: ConnectTarget | undefined;
  let cleanList: unknown = null;
  let init: unknown = null;
  let listAfterInit: unknown = null;
  let lostReason: string | null = null;
  const failureModes: { wslMissing: string | null; distroMissing: string | null; notInstalled: string | null } = {
    wslMissing: null,
    distroMissing: null,
    notInstalled: null,
  };
  const helperRun = (...args: string[]) => runWsl(realSpawn, cfg.distro, ['--exec', '/usr/bin/python3', helper, ...args]);

  try {
    await step('setup', true, async () => {
      const r = await helperRun('setup');
      need(r.exitCode === 0, `${r.stdout} ${r.stderr}`.trim());
      const j = lastJsonLine(r.stdout) as any;
      root = j.root;
      state = j.state;
      workspace = j.workspace;
      process.env.XDG_STATE_HOME = state;
      process.env.WSLENV = withWslEnvVar(process.env.WSLENV, 'XDG_STATE_HOME');
      return `temp state ${state}`;
    });

    await step('connect', true, async () => {
      const prepare = makePrepare(realSpawn, process.env, configPath);
      client = new ServeClient({
        spawn: realSpawn,
        prepare: async () => {
          target = await prepare();
          return target;
        },
      });
      await client.start();
      need(client.state === 'connected', String(client.lastError));
      return `connected via ${target?.entry}`;
    });
    const c = client!;

    await step('temp-state', true, async () => {
      const r = await c.request('health');
      const got = (r.data as any)?.stateDir?.path;
      need(r.ok && got === state + '/agent-studio', `serve uses ${got}, not the temp state; WSLENV did not forward XDG_STATE_HOME`);
      return `serve uses ${got}`;
    });

    await step('clean-list', false, async () => {
      const r = await c.request('workspace.list');
      cleanList = r.data;
      console.log(`workspace.list (clean state): ${JSON.stringify(r.data)}`);
      need(r.ok && (r.data as any).workspaces.length === 0, 'expected an empty list');
      return 'empty';
    });

    await step('init', true, async () => {
      const r = await runWsl(realSpawn, cfg.distro, ['--exec', target!.entry, 'init', '--path', workspace, '--json']);
      const env = lastJsonLine(r.stdout) as any;
      init = env;
      need(r.exitCode === 0 && env.ok === true, `init failed (exit ${r.exitCode}): ${r.stdout} ${r.stderr}`.trim());
      return `initialised ${workspace}`;
    });

    await step('list-after-init', false, async () => {
      const r = await c.request('workspace.list');
      listAfterInit = r.data;
      console.log(`workspace.list (after init): ${JSON.stringify(r.data)}`);
      const ws = (r.data as any).workspaces;
      need(
        r.ok && ws.length === 1 && ws[0].path === workspace && ws[0].name === 'ws' && ws[0].exists === true && ws[0].missing === false,
        'expected exactly the ws workspace',
      );
      return 'one workspace: ws';
    });

    await step('kill-serve', false, async () => {
      const r = await helperRun('kill-serve', '--state', state!);
      need(r.exitCode === 0 && (lastJsonLine(r.stdout) as any).killed.length === 1, `kill failed: ${r.stdout} ${r.stderr}`.trim());
      const s = await waitForState(c, 'lost', STATE_TIMEOUT_MS);
      lostReason = s.error;
      need(/^serve exited \(code /.test(s.error ?? ''), `unexpected reason: ${s.error}`);
      return `lost: ${s.error}`;
    });

    await step('no-auto-reconnect', false, async () => {
      let err: unknown = null;
      try {
        await c.request('workspace.list');
      } catch (e) {
        err = e;
      }
      need(err instanceof ServeError && err.code === 'NOT_CONNECTED', `expected NOT_CONNECTED, got ${err}`);
      need(c.state === 'lost', `state is ${c.state}`);
      return 'request rejected with NOT_CONNECTED';
    });

    await step('retry', false, async () => {
      await c.retry();
      need(c.state === 'connected', `state is ${c.state}: ${c.lastError}`);
      const r = await c.request('workspace.list');
      need(
        r.ok && JSON.stringify((r.data as any).workspaces) === JSON.stringify((listAfterInit as any)?.workspaces),
        'list differs after retry',
      );
      c.stop();
      return 'reconnected, same list';
    });

    const lose = async (spawn: SpawnFn, env: Record<string, string | undefined>): Promise<string> => {
      const fc = new ServeClient({ spawn, prepare: makePrepare(spawn, env, configPath) });
      await fc.start();
      const reason = fc.lastError;
      const st = fc.state;
      fc.stop();
      need(st === 'lost', `expected lost, state is ${st}`);
      return String(reason);
    };
    await step('wsl-missing', false, async () => {
      const spawn: SpawnFn = (cmd, args) => realSpawn(cmd === 'wsl.exe' ? NO_WSL_EXE : cmd, args);
      failureModes.wslMissing = await lose(spawn, process.env);
      need(failureModes.wslMissing === WSL_NOT_FOUND, failureModes.wslMissing);
      return failureModes.wslMissing;
    });
    await step('distro-missing', false, async () => {
      failureModes.distroMissing = await lose(realSpawn, { ...process.env, AGENT_STUDIO_DISTRO: NO_DISTRO });
      need(
        failureModes.distroMissing.startsWith(`WSL could not run anything in distro '${NO_DISTRO}'`),
        failureModes.distroMissing,
      );
      return failureModes.distroMissing;
    });
    await step('not-installed', false, async () => {
      failureModes.notInstalled = await lose(realSpawn, { ...process.env, AGENT_STUDIO_ENTRY: NO_ENTRY });
      need(failureModes.notInstalled.startsWith(`agent-studio is not installed at ${NO_ENTRY} in `), failureModes.notInstalled);
      return failureModes.notInstalled;
    });
    await step('distinct', false, async () => {
      need(
        allDistinct([failureModes.wslMissing, failureModes.distroMissing, failureModes.notInstalled, lostReason].map(String)),
        'failure reasons are not distinct',
      );
      return 'four distinct reasons';
    });
  } catch (e) {
    if (!(e instanceof Abort)) record('unexpected', false, (e as Error).message);
  } finally {
    client?.stop();
    if (root) {
      if (opts.keep) {
        console.log(`Kept temp dirs: ${root}`);
      } else {
        try {
          const r = await helperRun('cleanup', '--root', root);
          if (r.exitCode === 0) console.log(`Removed temp dirs: ${root}`);
          else record('cleanup', false, `${r.stdout} ${r.stderr}`.trim());
        } catch (e) {
          record('cleanup', false, (e as Error).message);
        }
      }
    }
  }

  const pass = steps.every((s) => s.ok);
  const outFile = opts.out ?? path.join(repoRoot, 'scripts', 'windows', 'app-live-check-evidence.json');
  const evidence = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    distro: cfg.distro,
    entry: target?.entry ?? null,
    stateDir: state ?? null,
    workspace: workspace || null,
    steps,
    cleanList,
    init,
    listAfterInit,
    lostReason,
    failureModes,
    result: pass ? 'pass' : 'fail',
  };
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${outFile}`);
  console.log(pass ? 'LIVE CHECK PASS' : 'LIVE CHECK FAIL');
  return pass ? 0 : 1;
}

if (require.main === module) {
  let opts: LiveOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  runLiveCheck(opts!).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
