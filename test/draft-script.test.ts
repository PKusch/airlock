import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/draft-manifest.ts', ...args], { encoding: 'utf8' });

test('draft: no file given prints usage and exits 2', () => {
  const r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: npm run draft/);
});

test('draft: --help prints usage on stdout and exits 0, not read as a file', () => {
  for (const flag of ['--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, flag);
    assert.match(r.stdout, /usage: npm run draft/);
    assert.equal(r.stderr, '');
  }
});

test('draft: a missing file ends in one plain line, not a stack trace', () => {
  const r = run('does-not-exist.json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /airlock: cannot read 'does-not-exist.json'/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('draft: a file that is not JSON ends in one plain line', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'draft-')), 'bad.json');
  writeFileSync(file, '{bad');
  const r = run(file);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /airlock: cannot read/);
});

test('draft: a tools list prints a manifest on stdout', () => {
  const r = run('corpus/unrecognised-verbs-heldout.json');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).version, 1);
});

test('draft: a tools file saved with a byte-order mark is read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'draft-')), 'bom.json');
  writeFileSync(file, '﻿' + readFileSync('corpus/unrecognised-verbs-heldout.json', 'utf8'));
  const r = run(file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, 1);
});
