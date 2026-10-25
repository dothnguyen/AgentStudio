import { app, BrowserWindow, session } from 'electron';
import { spawn as cpSpawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpawnFn } from './childTypes';
import { loadConfig } from './config';
import { resolveEntry } from './resolveEntry';
import { ServeClient, type StateChange } from './serveClient';
import { buildWindowOptions, isAllowedNavigation } from './windowOptions';

const spawnFn: SpawnFn = (cmd, args) =>
  cpSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const indexPath = path.join(app.getAppPath(), 'renderer', 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;
  const win = new BrowserWindow(buildWindowOptions());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, indexUrl)) e.preventDefault();
  });
  void win.loadFile(indexPath);

  const configPath = path.join(app.getPath('userData'), 'config.json');
  const client = new ServeClient({
    spawn: spawnFn,
    prepare: async () => {
      const c = loadConfig(process.env, configPath);
      const entry = await resolveEntry(spawnFn, c);
      return { distro: c.distro, entry, requestTimeoutMs: c.requestTimeoutMs };
    },
  });
  client.on('state', (s: StateChange) => console.log(`[serve] ${s.state}${s.error ? ': ' + s.error : ''}`));
  void client.start();

  app.on('window-all-closed', () => {
    client.stop();
    app.quit();
  });
});
