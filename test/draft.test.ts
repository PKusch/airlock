import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { draftEntries, draftManifest } from '../src/mcp/draft.ts';
import { parseManifest } from '../src/mcp/manifest.ts';
import type { McpToolDefinition } from '../src/mcp/adapt.ts';

const tool = (name: string, description: string): McpToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
});

const tools = [
  tool('get_status', 'Read the status of a job.'),
  tool('terminate_instance', 'Shut the instance down for good.'),
];

test('a recognised tool carries the effects the gate already infers', () => {
  const [status] = draftEntries([tools[0]]);
  assert.equal(status.recognised, true);
  assert.ok(status.effects.includes('read'));
});

test('a tool the vocabulary does not know is marked TODO, not guessed', () => {
  const [term] = draftEntries([tools[1]]);
  assert.equal(term.recognised, false);
  assert.deepEqual(term.effects, ['TODO']);
});

test('the draft lists tools that need a person first', () => {
  const names = Object.keys(JSON.parse(draftManifest(tools)).effects);
  assert.deepEqual(names, ['terminate_instance', 'get_status']);
});

test('an unedited draft with a TODO in it is refused as a manifest', () => {
  const text = draftManifest([tool('zorp_flange', 'Does a thing.')]);
  const entries = draftEntries([tool('zorp_flange', 'Does a thing.')]);
  assert.equal(entries[0].recognised, false, 'the test tool must be one the vocabulary cannot place');
  const parsed = parseManifest(text);
  assert.equal(parsed.ok, false);
});

test('a draft made only of recognised tools is a valid manifest', () => {
  const text = draftManifest([tools[0]]);
  assert.equal(parseManifest(text).ok, true);
});

test('the draft covers every tool in the held-out corpus', () => {
  const { tools: corpus } = JSON.parse(readFileSync(new URL('../corpus/unrecognised-verbs-heldout.json', import.meta.url), 'utf8'));
  const names = Object.keys(JSON.parse(draftManifest(corpus)).effects).sort();
  assert.deepEqual(names, corpus.map((t: { name: string }) => t.name).sort());
});
