import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCli, parseConfinement } from '../src/mcp/args.ts';
import { manifestSha } from '../src/mcp/manifest.ts';

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

test('the manifest flags: parsed before "--", and not stolen from the command after it', () => {
  assert.deepEqual(parseCli(['--manifest', 'm.json', '--', 'srv'], {}), {
    kind: 'run', command: 'srv', args: [], confinement: {}, manifestPath: 'm.json',
  });
  const pin = 'abc123'.padEnd(64, '0');
  assert.deepEqual(parseCli(['--manifest', 'm.json', '--manifest-sha', pin, '--', 'srv'], {}), {
    kind: 'run', command: 'srv', args: [], confinement: {}, manifestPath: 'm.json', manifestSha: pin,
  });
  // a --manifest meant for the wrapped server (after --) is left alone
  const r = parseCli(['--', 'srv', '--manifest', 'x'], {});
  assert.equal(r.kind, 'run');
  assert.deepEqual((r as { args: string[] }).args, ['--manifest', 'x']);
  assert.ok(!('manifestPath' in r));
});

test('a pin that is not a sha256 is called that, not reported as a mismatch', () => {
  const good = 'a'.repeat(64);
  assert.equal(parseCli(['--manifest', 'm.json', '--manifest-sha', good, '--', 'srv'], {}).kind, 'run');
  assert.equal(parseCli(['--manifest', 'm.json', '--manifest-sha', good.toUpperCase(), '--', 'srv'], {}).kind, 'run');
  for (const bad of ['abc123', 'sha256:' + good, good + 'a', 'g'.repeat(64)]) {
    const r = parseCli(['--manifest', 'm.json', '--manifest-sha', bad, '--', 'srv'], {});
    assert.equal(r.kind, 'error', bad);
    assert.match((r as { message: string }).message, /64 hex characters/, bad);
  }
});

test('a manifest flag with no value, or a sha with no manifest, is refused', () => {
  assert.equal(parseCli(['--manifest', '--', 'srv'], {}).kind, 'error');
  assert.equal(parseCli(['--manifest-sha', 'abc', '--', 'srv'], {}).kind, 'error');
});

test('a manifest whose sha does not match the pin stops the proxy, exit 2', () => {
  const dir = join(root, 'test');
  const m = join(dir, '.tmp-manifest.json');
  writeFileSync(m, JSON.stringify({ version: 1, effects: { terminate_instance: ['delete'] } }));
  try {
    const r = cli(['--manifest', m, '--manifest-sha', '0'.repeat(64), '--', process.execPath, '-e', '0']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not match --manifest-sha/);
  } finally {
    rmSync(m, { force: true });
  }
});

test('a malformed manifest stops the proxy, exit 2', () => {
  const dir = join(root, 'test');
  const m = join(dir, '.tmp-bad-manifest.json');
  writeFileSync(m, JSON.stringify({ version: 1, effects: { t: ['destroy'] } }));
  try {
    const r = cli(['--manifest', m, '--', process.execPath, '-e', '0']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown effect "destroy"/);
  } finally {
    rmSync(m, { force: true });
  }
});

test('a missing manifest file stops the proxy, exit 2', () => {
  const r = cli(['--manifest', join(root, 'test', 'does-not-exist.json'), '--', process.execPath, '-e', '0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read manifest/);
});

test('a boundary the manifest and AIRLOCK_CONFINE disagree on is said out loud', () => {
  const m = join(root, 'test', '.tmp-conflict-manifest.json');
  writeFileSync(m, JSON.stringify({ version: 1, confine: { '*.path': '/from/manifest' } }));
  try {
    const r = cli(['--manifest', m, '--', process.execPath, '-e', '0'], { AIRLOCK_CONFINE: '*.path=/from/env' });
    assert.match(r.stderr, /AIRLOCK_CONFINE sets \*\.path=\/from\/env, the manifest says \/from\/manifest; using the manifest/);
  } finally {
    rmSync(m, { force: true });
  }
});

test('a verified manifest is confirmed on stderr, with counts', () => {
  const m = join(root, 'test', '.tmp-verified-manifest.json');
  const text = JSON.stringify({ version: 1, confine: { '*.path': '/p' }, effects: { a: ['delete'], b: ['spend'] } });
  writeFileSync(m, text);
  try {
    const r = cli(['--manifest', m, '--manifest-sha', manifestSha(text), '--', process.execPath, '-e', '0']);
    assert.match(r.stderr, /verified — 2 tool\(s\), 1 boundary\(ies\)/);
  } finally {
    rmSync(m, { force: true });
  }
});
