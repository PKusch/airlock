/**
 * The command line and AIRLOCK_CONFINE, read as data so they can be tested.
 *
 * Confinement is the one setting here that makes the gate stricter, so a
 * mistake in it must never be quiet. A pair that was mistyped used to be
 * dropped without a word, and a value that contained an `=` was cut short at
 * it: in both cases the operator believed a boundary was in force that was not.
 * Now a bad pair stops the proxy before it starts.
 */

export const USAGE = [
  'usage: airlock -- <command> [args...]',
  '',
  'Wraps a stdio MCP server so every tools/call passes the gate first.',
  '',
  'environment:',
  '  AIRLOCK_CONFINE   comma-separated boundaries the operator asserts, as',
  '                    parameter=value, e.g. "*.path=/Users/me/projects,*.url=https://example.com"',
].join('\n');

export type Parsed =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; command: string; args: string[]; confinement: Record<string, string> };

export function parseConfinement(raw: string | undefined): { confinement: Record<string, string> } | { error: string } {
  const confinement: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    const key = at === -1 ? '' : pair.slice(0, at).trim();
    const value = at === -1 ? '' : pair.slice(at + 1).trim();
    if (!key || !value) {
      return { error: `AIRLOCK_CONFINE: '${pair}' should look like parameter=value` };
    }
    confinement[key] = value;
  }
  return { confinement };
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): Parsed {
  const sep = argv.indexOf('--');
  const before = sep === -1 ? argv : argv.slice(0, sep);
  if (before.includes('-h') || before.includes('--help')) return { kind: 'help' };

  const target = sep === -1 ? argv : argv.slice(sep + 1);
  if (target.length === 0) return { kind: 'error', message: USAGE.split('\n')[0] };

  const parsed = parseConfinement(env.AIRLOCK_CONFINE);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };

  return { kind: 'run', command: target[0], args: target.slice(1), confinement: parsed.confinement };
}
