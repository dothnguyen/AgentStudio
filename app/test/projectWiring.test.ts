import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = path.join(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(appDir, relativePath), 'utf8');

describe('Electron project wiring', () => {
  it('provides isolated npm build, start, test, and typecheck scripts', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.main).toBe('dist/main/main.js');
    expect(pkg.scripts).toEqual({
      build: 'tsc -p tsconfig.json && vite build',
      typecheck: 'tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json --noEmit',
      start: 'npm run build && electron .',
      test: 'vitest run',
      'live-check': 'npm run build && node dist/live/liveCheck.js',
    });
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(fs.existsSync(path.join(appDir, 'package-lock.json'))).toBe(true);
  });

  it('vite builds the renderer for file:// loading', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("base: './'");
    expect(vite).toContain("root: 'src/renderer'");
    expect(vite).toContain("outDir: '../../dist/renderer'");
    expect(JSON.parse(read('package.json')).dependencies ?? {}).toEqual({});
  });

  it('opens a local renderer window and starts the serve client from main', () => {
    const main = read('src/main/main.ts');
    expect(main).toContain('new BrowserWindow(buildWindowOptions(preloadPath))');
    expect(main).toContain("path.join(__dirname, '..', 'preload', 'preload.js')");
    expect(main).toContain('registerIpc({');
    expect(main).toContain('forwardState(client,');
    expect(main).toContain('win.loadFile(indexPath)');
    expect(main).toContain("path.join(app.getAppPath(), 'dist', 'renderer', 'index.html')");
    expect(main).toContain('retryOnReload(win.webContents, client)');
    expect(main).toContain('void client.start()');
    expect(main).toContain("console.log(`[serve] ${s.state}");
  });

  it('blocks remote navigation, popups, and renderer permission requests', () => {
    const main = read('src/main/main.ts');
    expect(main).toContain('pathToFileURL(indexPath).href');
    expect(main).toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'/);
    expect(main).toMatch(/on\('will-navigate',[\s\S]*?if\s*\(!isAllowedNavigation\(url, indexUrl\)\)\s*e\.preventDefault\(\)/);
    expect(main).toMatch(/setPermissionRequestHandler\([\s\S]*?cb\(false\)/);
  });

  it('spawns only wsl.exe with argv and piped stdio, with shell disabled', () => {
    const main = read('src/main/connection.ts');
    expect(main).toMatch(/cpSpawn\(cmd, args, \{\s*stdio: \['pipe', 'pipe', 'pipe'\],\s*windowsHide: true,\s*shell: false,?\s*\}\)/);
    expect(main).not.toMatch(/\b(?:exec|execSync)\s*\(/);
    expect(main).not.toContain('shell: true');
    expect(main).toContain('export const realSpawn: SpawnFn');
    expect(read('src/main/main.ts')).toContain('spawn: realSpawn');
  });

  it('documents the distro configuration and Windows run commands', () => {
    const readme = read('README.md');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm start');
    expect(readme).toContain('AGENT_STUDIO_DISTRO');
    expect(readme).toContain('config.json');
    expect(readme).toContain('wsl -l -v');
  });
});
