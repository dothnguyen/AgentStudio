// Operator-only capture: npm run capture:skills (Windows; needs the Electron binary).
// Renders the Skills v1 list, page, missing page and dialogs at 1440x1160 and
// writes them to design/skills-v1/captures/.
import { app, BrowserWindow, session } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WIDTH = 1440;
const HEIGHT = 1160;
const READY_TIMEOUT_MS = 20000;

const appDir = path.resolve(__dirname, '..', '..');
const pagePath = path.join(appDir, 'dist', 'capture', 'index.html');
const outDir = path.resolve(appDir, '..', 'design', 'skills-v1', 'captures');

interface Mode {
  file: string;
  skill: string | null;
  /** Dialog opened after the skill page (or the list, for New skill). */
  dialog: { label: string; title: string } | null;
}

const MODES: Mode[] = [
  { file: 'list.png', skill: null, dialog: null },
  { file: 'detail.png', skill: 'code-search', dialog: null },
  { file: 'detail-missing.png', skill: 'legacy-notes', dialog: null },
  { file: 'edit-content.png', skill: 'code-search', dialog: { label: 'Edit skill content', title: 'Edit code-search' } },
  { file: 'edit-roles.png', skill: 'code-search', dialog: { label: 'Edit roles that use this skill', title: 'Roles that use code-search' } },
  { file: 'new-skill.png', skill: null, dialog: { label: 'New skill', title: 'New skill' } },
  { file: 'delete-skill.png', skill: 'ts-testing', dialog: { label: 'Delete skill', title: 'Delete ts-testing?' } },
];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Closing one capture window must not quit the app before the next mode runs.
app.on('window-all-closed', () => undefined);

app.whenReady().then(capture).then(
  (code) => app.exit(code),
  (error: unknown) => {
    console.error(`capture:skills: ${error instanceof Error ? error.message : String(error)}`);
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
  await win.loadFile(pagePath, { query: { app: 'skills' } });
  await waitFor(win, "document.documentElement.dataset.captureReady === 'true'", 'the Skills capture page');
  if (mode.skill !== null) {
    await evaluate(win, `document.querySelector('[data-skill-id=${JSON.stringify(mode.skill)}]')?.click()`);
    await waitFor(win, "document.querySelector('[data-section=\"skills\"] .skills-page') !== null", `the ${mode.skill} skill page`);
  }
  if (mode.dialog !== null) {
    const label = mode.dialog.label === 'New skill'
      ? '.skills-new-button'
      : mode.dialog.label === 'Delete skill'
        ? '.skills-delete-button'
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
  console.log(`capture:skills: wrote ${mode.file}.`);
}

async function capture(): Promise<number> {
  if (!fs.existsSync(pagePath)) {
    throw new Error('dist/capture/index.html is missing. Run "npm run capture:skills", which builds it first.');
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
  console.log(`capture:skills: wrote ${MODES.length} screenshots to design/skills-v1/captures/.`);
  return 0;
}
