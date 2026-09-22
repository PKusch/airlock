import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts } from '../src/core/derive.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { SEVERITY, type ToolSchema } from '../src/core/types.ts';

/**
 * The severity ladder was calibrated for loudness, not meaning: every rule in
 * `deriveSeverity` keyed off which verb a tool used, and none of them looked
 * at how many things a call actually names. `affected` — the same count the
 * consent card shows and the verifier will not let a narrator understate —
 * was computed and then discarded. A `write` that names one record and a
 * `write` that names five thousand, spelled out explicitly rather than with a
 * glob, scored identically at `moderate`: below the alarm threshold, in both
 * cases. `deriveSeverity` now escalates a bounded call whose explicit scope
 * is large (`LARGE_SCOPE`, see derive.ts): one more level, on the same
 * "raise-only, never lowers" ladder as every other signal here. These tests
 * pin the four concrete cases that exposed the gap and are unaffected by the
 * two prior severity signals (`self_description_contradicted`,
 * `privilege_change_detected`) — this one fires from scope alone.
 */

const servers: Array<{ tools: McpToolDefinition[] }> = JSON.parse(
  readFileSync(new URL('../corpus/real-mcp-tools.json', import.meta.url), 'utf8'),
);
const real = servers.flatMap((s) => s.tools);
const realDef = (name: string) => real.find((t) => t.name === name)!;

const derive = (d: McpToolDefinition, args: Record<string, unknown>) =>
  deriveFacts(adaptMcpTool(d), { id: 'x', tool: d.name, args });

const names = (n: number, prefix = 'entity') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

// --- Case 1: delete_entities, the real memory-server tool ---------------------
// Deleting one named entity and deleting five hundred were scored the same,
// `high`, because a non-glob delete never reached `critical` regardless of
// how many names were in the array. A careful reviewer would not treat those
// as the same call.

test('delete_entities: one name is high, five hundred is critical', () => {
  const def = realDef('delete_entities');
  assert.equal(derive(def, { entityNames: names(1) }).severity, 'high');
  assert.equal(derive(def, { entityNames: names(3) }).severity, 'high', 'three stays under the scope threshold, same as real-corpus.test.ts');
  assert.equal(derive(def, { entityNames: names(500) }).severity, 'critical');
});

// --- Case 2: create_entities, the real memory-server tool ---------------------
// Bulk-creating three thousand entities in one call is not "housekeeping
// with extra steps" the way the ladder treated it: it stayed `moderate`,
// which is below the alarm threshold, whatever the count.

test('create_entities: one entity is moderate, three thousand crosses the alarm threshold', () => {
  const def: McpToolDefinition = {
    name: 'create_entities',
    description: 'Create multiple new entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, entityType: { type: 'string' } } },
        },
      },
    },
  };
  const one = derive(def, { entities: [{ name: 'x', entityType: 't' }] });
  const many = derive(def, { entities: names(3000).map((n) => ({ name: n, entityType: 't' })) });
  assert.equal(one.severity, 'moderate');
  assert.ok(SEVERITY[one.severity] < SEVERITY.high, 'a single create should not alarm');
  assert.equal(many.severity, 'high');
  assert.ok(many.signals.some((s) => s.code === 'large_bounded_scope'));
});

// --- Case 3: a synthetic bulk write, CRM-shaped --------------------------------
// `update_records` is an ordinary, ungently-named write. Nothing about the
// tool name or description is alarming; what makes five thousand records
// different from one is purely how many the call names, and severity never
// looked.

const updateRecords: ToolSchema = {
  name: 'update_records',
  description: 'Updates the given fields on the matching records.',
  parameters: {
    recordIds: { type: 'string[]', role: 'subject' },
    fields: { type: 'object' },
  },
};

test('update_records: one record is moderate, five thousand crosses the alarm threshold', () => {
  const one = deriveFacts(updateRecords, { id: 'x', tool: 'update_records', args: { recordIds: names(1, 'r'), fields: { status: 'closed' } } });
  const many = deriveFacts(updateRecords, { id: 'x', tool: 'update_records', args: { recordIds: names(5000, 'r'), fields: { status: 'closed' } } });
  assert.equal(one.severity, 'moderate');
  assert.equal(many.severity, 'high');
  const signal = many.signals.find((s) => s.code === 'large_bounded_scope');
  assert.ok(signal);
  assert.match(signal!.detail, /5000/);
});

// --- Case 4: a synthetic bulk write, finance-shaped ----------------------------
// `apply_discount` uses a write verb the vocabulary already knows (`apply`),
// nothing destructive-sounding, and nothing a privilege or annotation signal
// would touch — the scope is the only thing that makes discounting fifty
// thousand orders different from discounting one.

const applyDiscount: ToolSchema = {
  name: 'apply_discount',
  description: 'Applies a percentage discount to the given orders.',
  parameters: {
    orderIds: { type: 'string[]', role: 'subject' },
    percentOff: { type: 'number', inert: true },
  },
};

test('apply_discount: one order is moderate, fifty thousand crosses the alarm threshold', () => {
  const one = deriveFacts(applyDiscount, { id: 'x', tool: 'apply_discount', args: { orderIds: names(1, 'o'), percentOff: 10 } });
  const many = deriveFacts(applyDiscount, { id: 'x', tool: 'apply_discount', args: { orderIds: names(50000, 'o'), percentOff: 90 } });
  assert.equal(one.severity, 'moderate');
  assert.equal(many.severity, 'high');
});

// --- The escalation must not fire on scope alone, or on reads -----------------

test('a large glob match is unaffected: it was already critical, and unbounded is not bounded', () => {
  // Guards against double-booking the same call under two different signals.
  const glob: ToolSchema = {
    name: 'cleanup_workspace',
    description: 'Cleans up workspace files matching a pattern.',
    parameters: { pattern: { type: 'string', role: 'glob' } },
  };
  const facts = deriveFacts(glob, { id: 'x', tool: 'cleanup_workspace', args: { pattern: '/HOME/projects/**/*' } });
  assert.equal(facts.severity, 'critical');
  assert.ok(!facts.signals.some((s) => s.code === 'large_bounded_scope'), 'the unbounded signal already covers this call');
});

test('a large bounded read is not escalated: no evidence a bulk read is what this closes', () => {
  const bulkRead: ToolSchema = {
    name: 'read_multiple_files',
    description: 'Reads the contents of multiple files simultaneously.',
    parameters: { paths: { type: 'string[]', role: 'path', confinedTo: '/HOME/projects' } },
  };
  const facts = deriveFacts(bulkRead, {
    id: 'x',
    tool: 'read_multiple_files',
    args: { paths: names(500, '/HOME/projects/file').map((p) => `${p}.txt`) },
  });
  assert.equal(facts.severity, 'low');
  assert.ok(!facts.signals.some((s) => s.code === 'large_bounded_scope'));
});

test('the threshold is a boundary, not a vibe: nineteen does not fire, twenty does', () => {
  const below = deriveFacts(updateRecords, { id: 'x', tool: 'update_records', args: { recordIds: names(19, 'r'), fields: {} } });
  const at = deriveFacts(updateRecords, { id: 'x', tool: 'update_records', args: { recordIds: names(20, 'r'), fields: {} } });
  assert.equal(below.severity, 'moderate');
  assert.equal(at.severity, 'high');
});
