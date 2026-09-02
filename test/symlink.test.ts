import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveFacts, escapesConfinementResolved } from '../src/core/derive.ts';
import { nodeResolver } from '../src/core/resolver.node.ts';
import { SEVERITY, type ToolSchema } from '../src/core/types.ts';

/**
 * A real symlink on a real filesystem. The lexical check cannot see this —
 * there is no `..` anywhere in the argument — which is exactly why the README
 * named it as an open hole before this test existed.
 */
function makeTrap() {
  const root = mkdtempSync(join(tmpdir(), 'airlock-'));
  const confined = join(root, 'projects');
  const secrets = join(root, 'secrets');
  mkdirSync(confined);
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'id_rsa'), 'PRIVATE KEY');
  // Inside the confined directory, pointing out of it.
  symlinkSync(secrets, join(confined, 'archive'));
  return { root, confined, trap: join(confined, 'archive', 'id_rsa') };
}

test('the lexical check cannot see a symlink escape', () => {
  const { root, confined, trap } = makeTrap();
  try {
    const withoutResolver = escapesConfinementResolved(trap, confined, undefined);
    assert.equal(withoutResolver.escapes, false, 'string inspection sees nothing wrong');
    assert.equal(withoutResolver.resolved, false, 'and reports that it did not resolve');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the filesystem resolver catches it', () => {
  const { root, confined, trap } = makeTrap();
  try {
    const check = escapesConfinementResolved(trap, confined, nodeResolver);
    assert.equal(check.escapes, true);
    assert.equal(check.via, 'filesystem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink escape reaches critical and carries its own signal', () => {
  const { root, confined, trap } = makeTrap();
  try {
    const schema: ToolSchema = {
      name: 'read_file',
      description: 'Read a file from the project.',
      declaredEffects: ['read'],
      parameters: { path: { type: 'string', role: 'path', confinedTo: confined } },
    };
    const call = { id: 's1', tool: 'read_file', args: { path: trap } };

    const blind = deriveFacts(schema, call);
    assert.ok(SEVERITY[blind.severity] < SEVERITY.high, 'without a resolver it reads as ordinary');

    const seeing = deriveFacts(schema, call, { resolver: nodeResolver });
    assert.equal(seeing.severity, 'critical');
    assert.ok(seeing.signals.some((s) => s.code === 'symlink_escape'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unresolvable path is reported as unknown, never as safe', () => {
  const schema: ToolSchema = {
    name: 'read_file',
    description: 'Read a file from the project.',
    declaredEffects: ['read'],
    parameters: { path: { type: 'string', role: 'path', confinedTo: '/HOME/projects' } },
  };
  const facts = deriveFacts(
    schema,
    { id: 's2', tool: 'read_file', args: { path: '/HOME/projects/not-on-this-disk.txt' } },
    { resolver: nodeResolver },
  );
  assert.ok(
    facts.signals.some((s) => s.code === 'unresolved_path'),
    'the human is told the check was string-only',
  );
});

test('a resolver cannot launder a lexical escape', () => {
  // If the string says `..`, no amount of resolution makes it acceptable.
  const { root, confined } = makeTrap();
  try {
    const check = escapesConfinementResolved(join(confined, '..', 'secrets'), confined, nodeResolver);
    assert.equal(check.escapes, true);
    assert.equal(check.via, 'lexical');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
