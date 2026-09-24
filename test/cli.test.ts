import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCli, parseConfinement } from '../src/mcp/args.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'src/mcp/cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AIRLOCK_CONFINE: '', ...env },
  });

test('a boundary is read as parameter=value, splitting at the first "=" only', () => {
  assert.deepEqual(parseConfinement('*.path=/a/b'), { confinement: { '*.path': '/a/b' } });
  assert.deepEqual(parseConfinement('*.url=https://x.test/?q=1&r=2'), {
    confinement: { '*.url': 'https://x.test/?q=1&r=2' },
  });
  assert.deepEqual(parseConfinement(' *.path = /a , *.url = https://x '), {
    confinement: { '*.path': '/a', '*.url': 'https://x' },
  });
  assert.deepEqual(parseConfinement(undefined), { confinement: {} });
  assert.deepEqual(parseConfinement(''), { confinement: {} });
});

test('a mistyped boundary is an error, never a boundary that quietly is not there', () => {
  for (const bad of ['garbage', '*.path=', '=/a', '*.path=/a,oops', '*.path']) {
    const r = parseConfinement(bad);
    assert.ok('error' in r, bad);
    assert.match((r as { error: string }).error, /should look like parameter=value/, bad);
  }
});

test('the command line: help, missing command, and a normal run', () => {
  assert.deepEqual(parseCli(['--help'], {}), { kind: 'help' });
  assert.deepEqual(parseCli(['-h'], {}), { kind: 'help' });
  assert.equal(parseCli([], {}).kind, 'error');
  assert.equal(parseCli(['--'], {}).kind, 'error');
  assert.deepEqual(parseCli(['--', 'npx', 'server', '--help'], {}), {
    kind: 'run', command: 'npx', args: ['server', '--help'], confinement: {},
  });
  const bad = parseCli(['--', 'x'], { AIRLOCK_CONFINE: 'oops' });
  assert.equal(bad.kind, 'error');
});

test('--help prints usage and exits 0, instead of trying to start a server called --help', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: airlock/);
  assert.match(r.stdout, /AIRLOCK_CONFINE/);
});

test('a bad AIRLOCK_CONFINE stops the proxy before it starts, with exit 2', () => {
  const r = cli(['--', process.execPath, '-e', '0'], { AIRLOCK_CONFINE: '*.path' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AIRLOCK_CONFINE: '\*\.path' should look like parameter=value/);
});
