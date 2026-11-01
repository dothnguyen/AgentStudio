// Operator-only capture: npm run capture:roles (Windows; needs the Electron binary).
// Renders the Roles v2 list, role page and dialogs at 1440x1240 and writes
// them to design/roles-catalog-v2/captures/.
import { app, BrowserWindow, session } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WIDTH = 1440;
const HEIGHT = 1240;
const READY_TIMEOUT_MS = 20000;

const appDir = path.resolve(__dirname, '..', '..');
const pagePath = path.join(appDir, 'dist', 'capture', 'index.html');
const outDir = path.resolve(appDir, '..', 'design', 'roles-catalog-v2', 'captures');

interface Mode {
  file: string;
  role: string | null;
  /** Dialog opened after the role page (or the list, for New role). */
  dialog: { label: string; title: string } | null;
}

const MODES: Mode[] = [
  { file: 'list.png', role: null, dialog: null },
  { file: 'detail.png', role: 'TeamLead', dialog: null },
  { file: 'edit-overview.png', role: 'TeamLead', dialog: { label: 'Edit overview', title: 'Edit overview' } },
  { file: 'edit-instructions.png', role: 'TeamLead', dialog: { label: 'Edit shared instructions', title: 'Edit TeamLead instructions' } },
  { file: 'edit-skills.png', role: 'TeamLead', dialog: { label: 'Edit skills', title: 'Edit skills' } },
  { file: 'new-role.png', role: null, dialog: { label: 'New role', title: 'New role' } },
  { file: 'delete-role.png', role: 'ProductOwner', dialog: { label: 'Delete role', title: 'Delete ProductOwner?' } },
];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Closing one capture window must not quit the app before the next mode runs.
app.on('window-all-closed', () => undefined);

app.whenReady().then(capture).then(
  (code) => app.exit(code),
  (error: unknown) => {
    console.error(`capture:roles: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  },
);

async function evaluate<T>(win: BrowserWindow, script: string): Promise<T> {
  return win.webContents.executeJavaScript(script) as Promise<T>;
}

async function waitFor(win: BrowserWindow, script: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await evaluate<boolean>(win, script)) return;
    if (Date.now() >= deadline) throw new Error(`${label} was not ready within 20 s.`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
  }
}

async function captureOne(win: BrowserWindow, mode: Mode): Promise<void> {
  await win.loadFile(pagePath, { query: { app: 'roles' } });
  await waitFor(win, "document.documentElement.dataset.captureReady === 'true'", 'the Roles capture page');
  if (mode.role !== null) {
    await evaluate(win, `document.querySelector('[data-role-id=${JSON.stringify(mode.role)}]')?.click()`);
    await waitFor(win, "document.querySelector('[data-section=\"roles\"] .roles-page') !== null", `the ${mode.role} role page`);
  }
  if (mode.dialog !== null) {
    const label = mode.dialog.label === 'New role'
      ? '.roles-new-button'
      : mode.dialog.label === 'Delete role'
        ? '.roles-role-delete'
        : `button[aria-label=${JSON.stringify(mode.dialog.label)}]`;
    await evaluate(win, `document.querySelector(${JSON.stringify(label)})?.click()`);
    await waitFor(
      win,
      `(() => { const d = document.querySelector('[role="dialog"], [role="alertdialog"]'); return d !== null && (d.textContent ?? '').includes(${JSON.stringify(mode.dialog.title)}); })()`,
      `the ${mode.dialog.label} dialog`,
    );
  }
  await evaluate(win, `(async () => { if ('fonts' in document) await document.fonts.ready; if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); await new Promise(resolve => setTimeout(resolve, 400)); return true; })()`);
  win.webContents.invalidate();
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const size = image.getSize();
  const output = size.width === WIDTH && size.height === HEIGHT ? image : image.resize({ width: WIDTH, height: HEIGHT });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, mode.file), output.toPNG());
  console.log(`capture:roles: wrote ${mode.file}.`);
}

async function capture(): Promise<number> {
  if (!fs.existsSync(pagePath)) {
    throw new Error('dist/capture/index.html is missing. Run "npm run capture:roles", which builds it first.');
  }
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    resizable: false,
    backgroundColor: '#111316',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.showInactive();
  try {
    for (const mode of MODES) await captureOne(win, mode);
  } finally {
    win.destroy();
  }
  // Pin the generated bytes so the capture test fails when an image is stale
  // or only partly regenerated, not merely when it stops being a PNG.
  const files = Object.fromEntries(MODES.map(({ file }) => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(outDir, file))).digest('hex');
    return [file, hash];
  }));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ width: WIDTH, height: HEIGHT, files }, null, 2)}\n`);
  console.log(`capture:roles: wrote ${MODES.length} screenshots to design/roles-catalog-v2/captures/.`);
  return 0;
}
