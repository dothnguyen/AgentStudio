import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePrepare, realSpawn } from './connection';
import { forwardState, pickedPath, registerIpc } from './ipc';
import { retryOnReload } from './retryOnReload';
import { ServeClient, type StateChange } from './serveClient';
import { buildWindowOptions, isAllowedNavigation } from './windowOptions';

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const indexPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;
  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
  const win = new BrowserWindow(buildWindowOptions(preloadPath));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, indexUrl)) e.preventDefault();
  });
  void win.loadFile(indexPath);

  const configPath = path.join(app.getPath('userData'), 'config.json');
  const client = new ServeClient({ spawn: realSpawn, prepare: makePrepare(realSpawn, process.env, configPath) });
  retryOnReload(win.webContents, client);
  client.on('state', (s: StateChange) => console.log(`[serve] ${s.state}${s.error ? ': ' + s.error : ''}`));
  registerIpc({
    ipcMain,
    client,
    showFolderDialog: async () =>
      pickedPath(await dialog.showOpenDialog(win, { title: 'Choose a workspace folder', properties: ['openDirectory'] })),
  });
  forwardState(client, (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  void client.start();

  app.on('window-all-closed', () => {
    client.stop();
    app.quit();
  });
});
