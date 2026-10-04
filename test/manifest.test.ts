import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { SEVERITY } from '../src/core/types.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseManifest, manifestSha, unmatchedManifestTools, manifestCoverage, duplicateKeys, EFFECT_KINDS } from '../src/mcp/manifest.ts';

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

test('the card says a declared effect was declared, on the accepted and the rejected path alike', async () => {
  const { gate, formatConsent } = await import('../src/mcp/gate.ts');
  const def = { name: 'terminate_instance', description: 'Operate on the given instance.',
    inputSchema: { type: 'object' as const, properties: { instance_id: { type: 'string' } } } };
  const call = { id: 'c2', tool: 'terminate_instance', args: { instance_id: 'i-1' } };

  const reviewed = await gate(def, call, { declaredEffects: { terminate_instance: ['delete'] } });
  assert.match(formatConsent(reviewed), /Declared in advance rather than guessed: deletes data/);

  // a lying narrator is rejected; the fallback card must still carry the line
  const liar = async () => ({ severity: 'none' as const, reversibility: 'reversible' as const, scope: [], egress: [], summary: 'routine' });
  const rejected = await gate(def, call, { declaredEffects: { terminate_instance: ['delete'] }, narrator: liar as never });
  assert.match(formatConsent(rejected), /Declared in advance rather than guessed/);

  const plain = await gate(def, call, {});
  assert.doesNotMatch(formatConsent(plain), /Declared in advance/);
});

test('manifest entries for tools the server does not offer are named', () => {
  const declared = { terminate_instnace: ['delete' as const], get_status: [] as never[] };
  assert.deepEqual(unmatchedManifestTools(declared, ['get_status', 'terminate_instance']), ['terminate_instnace']);
  assert.deepEqual(unmatchedManifestTools(declared, ['get_status', 'terminate_instnace']), []);
  assert.deepEqual(unmatchedManifestTools(undefined, ['x']), []);
});

test('coverage says which offered tools the manifest has not reviewed', () => {
  const declared = { terminate_instance: ['delete' as const] };
  assert.deepEqual(manifestCoverage(declared, ['get_status', 'terminate_instance']),
    { reviewed: ['terminate_instance'], unreviewed: ['get_status'] });
  assert.deepEqual(manifestCoverage({}, ['a', 'b']), { reviewed: [], unreviewed: ['a', 'b'] });
  assert.deepEqual(manifestCoverage(declared, ['terminate_instance', 'terminate_instance']),
    { reviewed: ['terminate_instance'], unreviewed: [] }, 'a repeated name is counted once');
});

test('a "__proto__" tool name is refused, not silently swallowed', () => {
  const r = parseManifest('{"version":1,"effects":{"__proto__":["delete"],"ok_tool":["read"]}}');
  assert.ok(!r.ok);
  assert.match(r.error, /__proto__/);
});

test('a misspelled section is refused, not read as a manifest that declares nothing', () => {
  for (const bad of [
    { version: 1, effect: { terminate_instance: ['delete'] } },
    { version: 1, confinement: { '*.path': '/x' } },
  ]) {
    const r = parseManifest(JSON.stringify(bad));
    assert.ok(!r.ok, JSON.stringify(bad));
    assert.match(r.error, /unknown key/);
  }
  assert.ok(parseManifest(JSON.stringify({ version: 1, confine: {}, effects: {} })).ok, 'the real sections still parse');
});

test('a repeated key would silently downgrade a declaration, so it is refused', () => {
  const r = parseManifest('{"version":1,"effects":{"terminate_instance":["delete"],"terminate_instance":[]}}');
  assert.ok(!r.ok);
  assert.match(r.error, /"terminate_instance" appears more than once/);
});

test('the repeated-key scan finds repeats and only repeats', () => {
  assert.deepEqual(duplicateKeys('{"a":1,"b":2}'), []);
  assert.deepEqual(duplicateKeys('{"a":1,"a":2}'), ['a']);
  // the same key in different objects is ordinary
  assert.deepEqual(duplicateKeys('{"x":{"a":1},"y":{"a":2},"z":[{"a":3},{"a":4}]}'), []);
  // a repeat at depth is still found
  assert.deepEqual(duplicateKeys('{"x":{"a":1,"a":2}}'), ['a']);
  // an escape decodes to the same key
  assert.deepEqual(duplicateKeys('{"a":1,"\\u0061":2}'), ['a']);
  // a string value that looks like a key, braces in strings, an escaped quote
  assert.deepEqual(duplicateKeys('{"a":"a","b":"{ \\"a\\": [","c":"}"}'), []);
  // keys split by whitespace before the colon
  assert.deepEqual(duplicateKeys('{"a" : 1 , "a"\n:2}'), ['a']);
});

test('the committed example has no repeated key', () => {
  assert.deepEqual(duplicateKeys(readFileSync(join(root, 'examples/manifest.json'), 'utf8')), []);
});

test('an empty declared list never clears a tool the gate can read for itself', async () => {
  const { gate } = await import('../src/mcp/gate.ts');
  const def = { name: 'delete_file', description: 'Delete a file.',
    inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
  const call = { id: 'c3', tool: 'delete_file', args: { path: '/a/b' } };

  const without = await gate(def, call, {});
  const claimsNothing = await gate(def, call, { declaredEffects: { delete_file: [] } });
  assert.ok(claimsNothing.facts.effects.includes('delete'), 'the gate still reads the delete');
  assert.ok(SEVERITY[claimsNothing.facts.severity] >= SEVERITY[without.facts.severity], 'and is no more lenient for the claim');
  assert.ok(claimsNothing.facts.signals.some((s) => s.code === 'undeclared_effect'), 'the disagreement is itself recorded');
});

