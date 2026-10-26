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

  it('defines the dark workbench palette, focus treatment, and reduced-motion fallback', () => {
    const styles = read('src/renderer/styles.css');
    expect(styles).toContain('--bg: #181818');
    expect(styles).toContain('--surface: #1f1f1f');
    expect(styles).toContain('--accent: #0e639c');
    expect(styles).toContain(':focus-visible');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('width: min(720px, 100%)');
    expect(styles).toContain('width: min(520px, 100%)');
    expect(styles).toContain('outline: 2px solid var(--focus)');
  });

  it('keeps missing-folder status visible at narrow window widths', () => {
    const styles = read('src/renderer/styles.css');
    expect(styles).not.toMatch(/@media \(max-width: 560px\)[\s\S]*?\.badge-missing\s*\{\s*display:\s*none/);
  });

  it('keeps key text and primary controls above WCAG AA contrast', () => {
    const styles = read('src/renderer/styles.css');
    const token = (name: string) => {
      const match = styles.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      expect(match, `missing color token ${name}`).toBeTruthy();
      return match![1];
    };
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255);
      const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };

    expect(contrast(token('--text'), token('--bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--text-muted'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('--accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('applies visible keyboard focus and disables motion under reduced-motion preference', () => {
    const styles = read('src/renderer/styles.css');
    expect(styles).toMatch(/button:focus-visible[\s\S]*?outline:\s*2px solid var\(--focus\)/);
    expect(styles).toMatch(/\.ws-row:focus-visible\s*\{[^}]*border-color:\s*var\(--focus\)/);
    expect(styles).toMatch(/\.workspace-shell\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:[^;}]*240px/);
    expect(styles).toMatch(/\.workspace-name,[\s\S]*?\.workspace-path\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
    expect(styles).toMatch(/\.workspace-sidebar nav button\[aria-current="page"\]\s*\{/);
    expect(styles).toMatch(/\.workspace-sidebar nav button:focus-visible\s*\{/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*0\.01ms !important[\s\S]*?transition-duration:\s*0\.01ms !important/);
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
