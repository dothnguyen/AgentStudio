// Operator-only capture: npm run capture:routing (Windows; needs the Electron binary).
// Renders the Routing v1 screen and dialogs at 1440x1447 and writes
// them to design/routing-v1/captures/.
import { app, BrowserWindow, session } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WIDTH = 1440;
const HEIGHT = 1447;
const READY_TIMEOUT_MS = 20000;

const appDir = path.resolve(__dirname, '..', '..');
const pagePath = path.join(appDir, 'dist', 'capture', 'index.html');
const outDir = path.resolve(appDir, '..', 'design', 'routing-v1', 'captures');

interface Mode {
  file: string;
  /** Accessible name of the row action or card action that opens the rule dialog. */
  action: string | null;
  /** Removes the rule from the open edit dialog. */
  remove?: boolean;
  /** Heading of the edit dialog opened by `action`, when it differs from the final dialog title. */
  openTitle?: string;
  /** Value chosen in the "If it fails" select after the dialog opens. */
  setFail?: string;
  /** Heading of the expected dialog, or null for the screen itself. */
  title: string | null;
  alertDialog?: boolean;
}

const ADD_RULE = 'Add rule';

const MODES: Mode[] = [
  { file: 'overview.png', action: null, title: null },
  { file: 'edit-rule.png', action: 'Edit rule 3, Merge conflict', title: 'Edit rule 3' },
  { file: 'edit-action-rule.png', action: 'Edit rule 1, Merge ready', title: 'Edit rule 1' },
  { file: 'new-rule.png', action: ADD_RULE, title: 'Add rule', setFail: 'backlog' },
  { file: 'remove-rule.png', action: 'Edit rule 8, Dev ready', remove: true, openTitle: 'Edit rule 8', title: 'Remove the rule for Dev ready?', alertDialog: true },
  { file: 'worktrees.png', action: 'Edit worktrees', title: 'Edit worktrees' },
];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Closing one capture window must not quit the app before the next mode runs.
app.on('window-all-closed', () => undefined);

app.whenReady().then(capture).then(
  (code) => app.exit(code),
  (error: unknown) => {
    console.error(`capture:routing: ${error instanceof Error ? error.message : String(error)}`);
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
  await win.loadFile(pagePath, { query: { app: 'routing' } });
  await waitFor(win, "document.documentElement.dataset.captureReady === 'true'", 'the Routing capture page');
  if (mode.action !== null) {
    await evaluate(win, `(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
      const target = buttons.find(button => button.getAttribute('aria-label') === ${JSON.stringify(mode.action)});
      if (target) target.click();
    })()`);
    const role = mode.alertDialog === true && mode.remove !== true ? 'alertdialog' : 'dialog';
    const selector = `[role="${role}"]`;
    const expected = mode.openTitle ?? mode.title;
    await waitFor(
      win,
      `(() => { const d = document.querySelector(${JSON.stringify(selector)}); return d !== null && (d.textContent ?? '').includes(${JSON.stringify(expected)}); })()`,
      `the ${expected} dialog`,
    );
  }
  if (mode.setFail !== undefined) {
    await evaluate(win, `(() => {
      const label = Array.from(document.querySelectorAll('[role="dialog"] label'))
        .find(candidate => (candidate.textContent ?? '').trim().startsWith('If it fails'));
      const select = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
      if (select instanceof HTMLSelectElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, ${JSON.stringify(mode.setFail)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }
  if (mode.remove === true) {
    await evaluate(win, `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(candidate => candidate.textContent?.trim() === 'Remove rule');
      if (button) button.click();
    })()`);
    await waitFor(
      win,
      `(() => { const d = document.querySelector('[role="alertdialog"]'); return d !== null && (d.textContent ?? '').includes(${JSON.stringify(mode.title)}); })()`,
      `the ${mode.title} dialog`,
    );
  }
  await evaluate(win, `(async () => { if ('fonts' in document) await document.fonts.ready; if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); await new Promise(resolve => setTimeout(resolve, 400)); return true; })()`);
  win.webContents.invalidate();
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const size = image.getSize();
  const output = size.width === WIDTH && size.height === HEIGHT ? image : image.resize({ width: WIDTH, height: HEIGHT });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, mode.file), output.toPNG());
  console.log(`capture:routing: wrote ${mode.file}.`);
}

async function capture(): Promise<number> {
  if (!fs.existsSync(pagePath)) {
    throw new Error('dist/capture/index.html is missing. Run "npm run capture:routing", which builds it first.');
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
  const files = Object.fromEntries(MODES.map(({ file }) => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(outDir, file))).digest('hex');
    return [file, hash];
  }));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ width: WIDTH, height: HEIGHT, files }, null, 2)}\n`);
  console.log(`capture:routing: wrote ${MODES.length} screenshots to design/routing-v1/captures/.`);
  return 0;
}
