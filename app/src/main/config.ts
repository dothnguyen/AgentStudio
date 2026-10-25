import * as fs from 'node:fs';
import { SAFE_ARG } from './wslArgs';

export interface AppConfig {
  distro: string | null;
  entryPath: string | null;
  requestTimeoutMs: number;
}

export const DEFAULT_CONFIG: AppConfig = { distro: null, entryPath: null, requestTimeoutMs: 30000 };

export class ConfigError extends Error {
  name = 'ConfigError';
}

const ALLOWED = 'allowed characters: A-Z a-z 0-9 . _ / : @ + = ~ -';

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function pick(envVal: unknown, fileVal: unknown): unknown {
  if (isSet(envVal)) return envVal;
  if (isSet(fileVal)) return fileVal;
  return undefined;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  configFilePath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): AppConfig {
  let file: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFile(configFilePath);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== 'ENOENT') {
      throw new ConfigError(`Could not read settings file ${configFilePath}: ${err.message}`);
    }
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new ConfigError(`Could not read settings file ${configFilePath}: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`Could not read settings file ${configFilePath}: not a JSON object`);
    }
    file = parsed as Record<string, unknown>;
  }

  const distro = pick(env.AGENT_STUDIO_DISTRO, file.distro);
  const entryPath = pick(env.AGENT_STUDIO_ENTRY, file.entryPath);
  const timeoutRaw = pick(env.AGENT_STUDIO_REQUEST_TIMEOUT_MS, file.requestTimeoutMs);

  if (distro !== undefined && !(typeof distro === 'string' && SAFE_ARG.test(distro))) {
    throw new ConfigError(`Invalid setting distro: ${JSON.stringify(distro)} (${ALLOWED})`);
  }
  if (entryPath !== undefined) {
    if (!(typeof entryPath === 'string' && SAFE_ARG.test(entryPath))) {
      throw new ConfigError(`Invalid setting entryPath: ${JSON.stringify(entryPath)} (${ALLOWED})`);
    }
    if (!entryPath.startsWith('/')) {
      throw new ConfigError(
        `Invalid setting entryPath: ${JSON.stringify(entryPath)} (must be an absolute WSL path such as /home/you/.local/bin/agent-studio)`,
      );
    }
  }
  let timeout = DEFAULT_CONFIG.requestTimeoutMs;
  if (timeoutRaw !== undefined) {
    const n = typeof timeoutRaw === 'string' ? Number(timeoutRaw) : timeoutRaw;
    if (!(typeof n === 'number' && Number.isInteger(n) && n >= 1000 && n <= 600000)) {
      throw new ConfigError(
        `Invalid setting requestTimeoutMs: ${JSON.stringify(timeoutRaw)} (must be an integer between 1000 and 600000)`,
      );
    }
    timeout = n;
  }
  return {
    distro: distro === undefined ? null : (distro as string),
    entryPath: entryPath === undefined ? null : (entryPath as string),
    requestTimeoutMs: timeout,
  };
}
