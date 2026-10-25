import type { BrowserWindowConstructorOptions } from 'electron';

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function buildWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 750,
    minWidth: 640,
    minHeight: 480,
    title: 'Agent Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
    },
  };
}

export function isAllowedNavigation(url: string, indexUrl: string): boolean {
  return url === indexUrl;
}
