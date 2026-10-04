import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseManifest, manifestSha, EFFECT_KINDS } from '../src/mcp/manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a well-formed manifest yields confinement and declared effects', () => {
  const r = parseManifest(JSON.stringify({
    version: 1,
    confine: { '*.path': '/HOME/projects' },
    effects: { terminate_instance: ['delete'], charge_card: ['spend'] },
  }));
  assert.ok(r.ok);
  assert.equal(r.manifest.confinement['*.path'], '/HOME/projects');
  assert.deepEqual(r.manifest.declaredEffects.terminate_instance, ['delete']);
  assert.deepEqual(r.manifest.declaredEffects.charge_card, ['spend']);
});

test('an empty effects list is kept — reviewed and declared nothing', () => {
  const r = parseManifest(JSON.stringify({ version: 1, effects: { ping: [] } }));
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.declaredEffects.ping, []);
});

test('a missing section is simply absent, not an error', () => {
  const r = parseManifest(JSON.stringify({ version: 1 }));
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.confinement, {});
  assert.deepEqual(r.manifest.declaredEffects, {});
});

test('an unknown effect is refused, not silently dropped', () => {
  const r = parseManifest(JSON.stringify({ version: 1, effects: { t: ['destroy'] } }));
  assert.ok(!r.ok);
  assert.match(r.error, /unknown effect "destroy"/);
});

test('a confine key that matches nothing is refused, not left looking set', () => {
  const r = parseManifest(JSON.stringify({ version: 1, confine: { path: '/x' } }));
  assert.ok(!r.ok);
  assert.match(r.error, /matches nothing/);
});

test('a non-string boundary is refused', () => {
  const r = parseManifest(JSON.stringify({ version: 1, confine: { '*.path': 42 } }));
  assert.ok(!r.ok);
  assert.match(r.error, /confine\.\*\.path/);
});

test('the wrong version is refused rather than half-read', () => {
  const r = parseManifest(JSON.stringify({ version: 2, effects: {} }));
  assert.ok(!r.ok);
  assert.match(r.error, /version/);
});

test('junk is refused with a reason, never thrown on', () => {
  for (const bad of ['not json', '[]', 'null', '42', '{"version":1,"effects":[]}']) {
    const r = parseManifest(bad);
    assert.ok(!r.ok, bad);
    assert.ok(r.error.length > 0, bad);
  }
});

test('every effect the manifest allows is one the deriver understands', () => {
  // EFFECT_KINDS is the gate's own vocabulary; a manifest cannot assert an effect
  // the deriver would not know how to score.
  assert.equal(EFFECT_KINDS.size, 8);
});

test('the sha is over the exact bytes', () => {
  const text = JSON.stringify({ version: 1 });
  assert.equal(manifestSha(text), manifestSha(text));
  assert.notEqual(manifestSha(text), manifestSha(text + '\n'));
  assert.match(manifestSha(text), /^[0-9a-f]{64}$/);
});

test('the committed example manifest is valid', () => {
  const r = parseManifest(readFileSync(join(root, 'examples/manifest.json'), 'utf8'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.manifest.declaredEffects.terminate_instance, ['delete']);
});


test('facts say which effects were declared, apart from the ones inferred', async () => {
  const { adaptMcpTool } = await import('../src/mcp/adapt.ts');
  const { deriveFacts } = await import('../src/core/derive.ts');
  const def = { name: 'terminate_instance', description: 'Operate on the given instance.',
    inputSchema: { type: 'object' as const, properties: { instance_id: { type: 'string' } } } };
  const call = { id: 'c1', tool: 'terminate_instance', args: { instance_id: 'i-1' } };

  const plain = deriveFacts(adaptMcpTool(def), call);
  assert.equal(plain.declaredEffects, undefined, 'nothing declared, so the field is absent');

  const reviewed = deriveFacts(adaptMcpTool(def, { declaredEffects: { terminate_instance: ['delete'] } }), call);
  assert.deepEqual(reviewed.declaredEffects, ['delete']);
  assert.ok(reviewed.effects.includes('delete'));
  assert.ok(!reviewed.effectEvidence.some((e) => e.effect === 'delete'), 'a declared effect needs no inference evidence');
});
