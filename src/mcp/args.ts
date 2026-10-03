/**
 * The command line, AIRLOCK_CONFINE and the manifest flags, read as data so they
 * can be tested.
 *
 * Confinement is one of the settings here that makes the gate stricter, so a
 * mistake in it must never be quiet. A pair that was mistyped used to be dropped
 * without a word, and a value that contained an `=` was cut short at it: in both
 * cases the operator believed a boundary was in force that was not. Now a bad
 * pair, or a flag given with no value, stops the proxy before it starts.
 */

export const USAGE = [
  'usage: airlock [--manifest <file> [--manifest-sha <hex>]] -- <command> [args...]',
  '',
  'Wraps a stdio MCP server so every tools/call passes the gate first.',
  '',
  'options:',
  '  --manifest <file>     a reviewed capability manifest: the effects and',
  '                        boundaries an operator asserts for tools the deriver',
  '                        cannot read from name and schema alone.',
  '  --manifest-sha <hex>  the sha256 the manifest must hash to. Without it the',
  '                        manifest is used but reported as unverified.',
  '',
  'environment:',
  '  AIRLOCK_CONFINE   comma-separated boundaries the operator asserts, as',
  '                    parameter=value, e.g. "*.path=/Users/me/projects,*.url=https://example.com"',
  '                    (merged with the manifest; the manifest wins on a shared key)',
].join('\n');

export type Parsed =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | {
      kind: 'run';
      command: string;
      args: string[];
      confinement: Record<string, string>;
      manifestPath?: string;
      manifestSha?: string;
    };

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

/** The value after `--name`, or an error if the flag is there with nothing after it. */
function flagValue(before: string[], name: string): { value?: string } | { error: string } {
  const i = before.indexOf(name);
  if (i === -1) return {};
  const value = before[i + 1];
  if (value === undefined || value.startsWith('-')) {
    return { error: `${name} needs a value` };
  }
  return { value };
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): Parsed {
  const sep = argv.indexOf('--');
  const before = sep === -1 ? argv : argv.slice(0, sep);
  if (before.includes('-h') || before.includes('--help')) return { kind: 'help' };

  const target = sep === -1 ? argv : argv.slice(sep + 1);
  if (target.length === 0) return { kind: 'error', message: USAGE.split('\n')[0] };

  const parsed = parseConfinement(env.AIRLOCK_CONFINE);
  if ('error' in parsed) return { kind: 'error', message: parsed.error };

  // Flags live before `--`. With no `--`, the whole command line is the target
  // and nothing in it is read as a flag, so a server invoked as `airlock node s.js`
  // still works and a `--flag` meant for that server is never stolen.
  const flags = sep === -1 ? [] : before;
  const manifest = flagValue(flags, '--manifest');
  if ('error' in manifest) return { kind: 'error', message: manifest.error };
  const sha = flagValue(flags, '--manifest-sha');
  if ('error' in sha) return { kind: 'error', message: sha.error };
  if (sha.value && !manifest.value) {
    return { kind: 'error', message: '--manifest-sha given without --manifest' };
  }

  return {
    kind: 'run',
    command: target[0],
    args: target.slice(1),
    confinement: parsed.confinement,
    ...(manifest.value ? { manifestPath: manifest.value } : {}),
    ...(sha.value ? { manifestSha: sha.value } : {}),
  };
}
