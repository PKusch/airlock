import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts, tokenise } from '../src/core/derive.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { SEVERITY, type ToolCall } from '../src/core/types.ts';

/**
 * Against 36 tool definitions pulled from the MCP reference servers
 * (`npm run introspect`). The fixture corpus was written by the same person as
 * the inference rules and can only confirm them; this corpus was not, and it
 * found four real defects the fixtures never could.
 */

const servers: Array<{ id: string; tools: McpToolDefinition[] }> = JSON.parse(
  readFileSync(new URL('../corpus/real-mcp-tools.json', import.meta.url), 'utf8'),
);
const EXPECTED: Set<string> = new Set(
  JSON.parse(readFileSync(new URL('../corpus/expected-alarms.json', import.meta.url), 'utf8')).shouldAlarm,
);
const allTools = servers.flatMap((s) => s.tools);
const BOUNDARY = '/HOME/projects';
const CONFINEMENT = { '*.path': BOUNDARY, '*.paths': BOUNDARY, '*.source': BOUNDARY, '*.destination': BOUNDARY, '*.url': 'docs.internal' };

function benignArgs(def: McpToolDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(def.inputSchema?.properties ?? {})) {
    const p = prop as { type?: string };
    if (/path|file|dir|source|destination/i.test(name)) args[name] = p.type === 'array' ? [`${BOUNDARY}/a.txt`] : `${BOUNDARY}/a.txt`;
    else if (/url|endpoint/i.test(name)) args[name] = 'https://docs.internal/x';
    else if (p.type === 'array') args[name] = ['x'];
    else if (p.type === 'number' || p.type === 'integer') args[name] = 1;
    else if (p.type === 'boolean') args[name] = false;
    else args[name] = 'x';
  }
  return args;
}

const alarms = () =>
  allTools.filter((def) => {
    const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
    const facts = deriveFacts(adaptMcpTool(def, { confinement: CONFINEMENT }), call);
    return SEVERITY[facts.severity] >= SEVERITY.high;
  });

test('the corpus is the real one', () => {
  assert.equal(allTools.length, 36);
  assert.ok(allTools.some((t) => t.name === 'read_text_file'));
});

test('every tool that warrants stopping a person does', () => {
  const caught = alarms().map((t) => t.name);
  const missed = [...EXPECTED].filter((n) => !caught.includes(n));
  assert.deepEqual(missed, [], 'a genuinely dangerous tool passed silently');
});

test('no ordinary tool interrupts', () => {
  const spurious = alarms().map((t) => t.name).filter((n) => !EXPECTED.has(n));
  assert.deepEqual(spurious, [], 'ordinary tools reached the alarm threshold');
});

// --- The four defects the real corpus exposed, each pinned ------------------

test('a stem no longer matches an unrelated word', () => {
  // `list_directory` inferred `delete` from the word "clearly" in its
  // description, back when tells were matched as loose stems.
  const listDirectory = allTools.find((t) => t.name === 'list_directory')!;
  const facts = deriveFacts(adaptMcpTool(listDirectory), { id: 'x', tool: 'list_directory', args: { path: '/a' } });
  assert.ok(!facts.effects.includes('delete'), 'inferred a delete from prose');
  assert.ok(/clearly/i.test(listDirectory.description ?? ''), 'the trap is still in the corpus');
});

test('a noun in a tool name is not read as a verb', () => {
  // `get-annotated-message` inferred `message_send` from its second token.
  const def = allTools.find((t) => t.name === 'get-annotated-message')!;
  const facts = deriveFacts(adaptMcpTool(def), { id: 'x', tool: def.name, args: { messageType: 'x' } });
  assert.ok(!facts.effects.includes('message_send'), 'a "get" was read as a send');
  assert.equal(tokenise(def.name)[0], 'get');
});

test('a parameter is matched on tokens, not on a prefix', () => {
  // `topic` was given the `recipient` role because `^to` matches it.
  const def = allTools.find((t) => t.name === 'simulate-research-query')!;
  const schema = adaptMcpTool(def);
  assert.equal(schema.parameters.topic?.role, undefined, '"topic" is not a recipient');
});

test('format:uri is honoured even when the parameter is named "data"', () => {
  // The inverse case: this one *should* fire. gzip-file-as-resource fetches an
  // arbitrary remote URL through a parameter whose name gives nothing away.
  const def = allTools.find((t) => t.name === 'gzip-file-as-resource')!;
  const schema = adaptMcpTool(def);
  assert.equal(schema.parameters.data.role, 'url');
  const facts = deriveFacts(schema, { id: 'x', tool: def.name, args: { data: 'https://example.com/x' } });
  assert.ok(facts.effects.includes('network_egress'));
});

test('environment access is treated as credential access', () => {
  const def = allTools.find((t) => t.name === 'get-env')!;
  const facts = deriveFacts(adaptMcpTool(def), { id: 'x', tool: 'get-env', args: {} });
  assert.ok(facts.effects.includes('credential_access'));
  assert.equal(facts.severity, 'critical');
});

test('every inferred effect can name the text that produced it', () => {
  // An inference a person cannot audit is an assertion.
  for (const def of allTools) {
    const facts = deriveFacts(adaptMcpTool(def), { id: 'x', tool: def.name, args: benignArgs(def) });
    for (const effect of facts.effects) {
      assert.ok(
        facts.effectEvidence.some((e) => e.effect === effect),
        `${def.name}: '${effect}' inferred with no evidence recorded`,
      );
    }
  }
});
