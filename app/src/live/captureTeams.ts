// Operator-only capture: npm run capture:teams (Windows; needs the Electron binary).
// Renders the Teams v4 fixture at 1440x1000 and writes actual + design|actual|difference images.
import { app, BrowserWindow, nativeImage, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { composeComparison, DIFF_TOLERANCE, type RawImage } from './imageCompare';

const WIDTH = 1440;
const HEIGHT = 1000;
const READY_TIMEOUT_MS = 15000;

const appDir = path.resolve(__dirname, '..', '..');
const pagePath = path.join(appDir, 'dist', 'capture', 'index.html');
const designPath = path.resolve(appDir, '..', 'design', 'teams-overview-v4.png');
const outDir = path.join(appDir, 'test-results');
const actualPath = path.join(outDir, 'teams-overview-v4-actual.png');
const comparePath = path.join(outDir, 'teams-overview-v4-compare.png');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(capture).then(
  (code) => app.exit(code),
  (error: unknown) => {
    console.error(`capture:teams: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  },
);

async function capture(): Promise<number> {
  if (!fs.existsSync(pagePath)) {
    throw new Error('dist/capture/index.html is missing. Run "npm run capture:teams", which builds it first.');
  }
  if (!fs.existsSync(designPath)) throw new Error(`design image not found: ${designPath}`);

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
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadFile(pagePath);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const state = await win.webContents.executeJavaScript(
      "({ ready: document.documentElement.dataset.captureReady === 'true', error: document.documentElement.dataset.captureError ?? null })",
    ) as { ready: boolean; error: string | null };
    if (state.error !== null) throw new Error(`the capture page reported: ${state.error}`);
    if (state.ready) break;
    if (Date.now() >= deadline) throw new Error('the Teams overview was not ready within 15 s.');
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
  }

  let image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const captured = image.getSize();
  if (captured.width !== WIDTH || captured.height !== HEIGHT) {
    console.warn(`capture:teams: captured ${captured.width}x${captured.height}, resized to ${WIDTH}x${HEIGHT} (check display scaling).`);
    image = image.resize({ width: WIDTH, height: HEIGHT });
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(actualPath, image.toPNG());

  let design = nativeImage.createFromPath(designPath);
  if (design.isEmpty()) throw new Error(`design image could not be read: ${designPath}`);
  const designSize = design.getSize();
  if (designSize.width !== WIDTH || designSize.height !== HEIGHT) {
    design = design.resize({ width: WIDTH, height: HEIGHT });
  }

  const toRaw = (img: Electron.NativeImage): RawImage => ({ ...img.getSize(), data: img.toBitmap() });
  const result = composeComparison(toRaw(design), toRaw(image));
  const comparison = nativeImage.createFromBitmap(result.image.data, { width: result.image.width, height: result.image.height });
  fs.writeFileSync(comparePath, comparison.toPNG());

  console.log(`capture:teams: wrote test-results/teams-overview-v4-actual.png and test-results/teams-overview-v4-compare.png; ${result.differing} of ${result.total} pixels (${(100 * result.differing / result.total).toFixed(2)}%) differ by more than ${DIFF_TOLERANCE}.`);
  win.destroy();
  return 0;
}
