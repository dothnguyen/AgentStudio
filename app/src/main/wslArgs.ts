export const SAFE_ARG = /^[A-Za-z0-9._/:@+=~-]+$/;

export function assertSafeArg(value: string): void {
  if (!SAFE_ARG.test(value)) {
    throw new Error(`Refusing to put '${value}' on the wsl.exe command line; only fixed literals are allowed there.`);
  }
}

export function buildWslArgs(distro: string | null, argv: string[]): string[] {
  if (distro !== null) assertSafeArg(distro);
  for (const a of argv) assertSafeArg(a);
  return distro !== null ? ['-d', distro, ...argv] : [...argv];
}
