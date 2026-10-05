import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gate, thresholdRank } from '../src/mcp/gate.ts';
import { startProxy } from '../src/mcp/proxy.ts';
import { SEVERITY } from '../src/core/types.ts';

const DELETE_FILE = { name: 'delete_file', description: 'Delete a file.',
  inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
const call = { id: 't1', tool: 'delete_file', args: { path: '/a/b' } };

test('every real severity is a usable threshold, and the default is high', () => {
  for (const name of Object.keys(SEVERITY) as Array<keyof typeof SEVERITY>) {
    assert.equal(thresholdRank(name), SEVERITY[name]);
  }
  assert.equal(thresholdRank(undefined), SEVERITY.high);
});

test('a threshold that is not a severity is refused, never read as "stop nothing"', () => {
  // 'hihg' used to give severity >= undefined, which is false for everything.
  for (const bad of ['hihg', 'HIGH', '', 'toString', 'constructor', '__proto__']) {
    assert.throws(() => thresholdRank(bad as never), /is not a severity/, bad);
  }
});

test('gate fails closed on a typo instead of letting a delete through', async () => {
  const ok = await gate(DELETE_FILE, call, { threshold: 'high' });
  assert.equal(ok.requiresApproval, true, 'the delete is stopped at the default');
  await assert.rejects(gate(DELETE_FILE, call, { threshold: 'hihg' as never }), /is not a severity/);
});

test('a lower threshold still stops more, and a higher one less', async () => {
  const moderate = await gate(DELETE_FILE, call, { threshold: 'moderate' });
  const critical = await gate(DELETE_FILE, call, { threshold: 'critical' });
  assert.equal(moderate.requiresApproval, true);
  assert.equal(critical.requiresApproval, SEVERITY[critical.facts.severity] >= SEVERITY.critical);
});

test('the proxy refuses to start with a bad threshold, before spawning the server', () => {
  assert.throws(() => startProxy(process.execPath, ['-e', '0'], { threshold: 'hihg' as never }), /is not a severity/);
});
