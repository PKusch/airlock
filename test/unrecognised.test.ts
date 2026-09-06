import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts, tokenise } from '../src/core/derive.ts';
import { factualProposal } from '../src/core/narrate.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { gate } from '../src/mcp/gate.ts';
import { SEVERITY, type EffectKind, type ToolCall } from '../src/core/types.ts';

/**
 * The verb vocabulary is finite, and ordinary API authors leave it without
 * trying. This corpus measures how often, and pins the answer, so the README's
 * numbers and the deriver's behaviour cannot drift apart unnoticed.
 */

interface Labelled extends McpToolDefinition {
  /** What the tool really does. `null` for a harmless tool. */
  effect: EffectKind | null;
  /** What the deriver currently makes of it. */
  expected: 'caught' | 'unrecognised';
}

const { tools }: { tools: Labelled[] } = JSON.parse(
  readFileSync(new URL('../corpus/unrecognised-verbs.json', import.meta.url), 'utf8'),
);

function benignArgs(def: McpToolDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(def.inputSchema?.properties ?? {})) {
    const p = prop as { type?: string; format?: string };
    if (/path|file|dir|source|destination/i.test(name)) args[name] = '/HOME/projects/a.txt';
    else if (p.format === 'uri' || /url|endpoint/i.test(name)) args[name] = 'https://docs.internal/x';
    else if (p.type === 'array') args[name] = ['x'];
    else if (p.type === 'number' || p.type === 'integer') args[name] = 1;
    else args[name] = 'x';
  }
  return args;
}

const factsFor = (def: Labelled) => {
  const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
  return { call, facts: deriveFacts(adaptMcpTool(def), call) };
};

const observed = (def: Labelled): 'caught' | 'unrecognised' | 'wrong' => {
  const { facts } = factsFor(def);
  if (facts.recognition.status === 'unrecognised') return 'unrecognised';
  return def.effect !== null && facts.effects.includes(def.effect) ? 'caught' : 'wrong';
};

test('the corpus is what it claims: no leading verb is in the vocabulary', () => {
  assert.equal(tools.length, 22);
  for (const def of tools) {
    const { facts } = factsFor(def);
    const fromName = facts.effectEvidence.filter((e) => e.source === 'tool name');
    assert.deepEqual(fromName, [], `${def.name}: '${tokenise(def.name)[0]}' is in the vocabulary after all`);
  }
});

test('the measured split is the one the README reports', () => {
  const consequential = tools.filter((t) => t.effect !== null);
  const harmless = tools.filter((t) => t.effect === null);
  assert.equal(consequential.length, 18);
  assert.equal(harmless.length, 4);

  for (const def of tools) {
    assert.equal(observed(def), def.expected, `${def.name}: expected ${def.expected}`);
  }
  assert.equal(consequential.filter((t) => observed(t) === 'caught').length, 4);
  assert.equal(consequential.filter((t) => observed(t) === 'unrecognised').length, 14);
  assert.ok(harmless.every((t) => observed(t) === 'unrecognised'));
});

test('nothing inferred is not read as nothing happens', () => {
  // The fourth instance of the collapse: an empty effect set used to score
  // `none`, so `retire_entities` came out identical to `ping`.
  for (const def of tools) {
    const { facts } = factsFor(def);
    assert.notEqual(facts.severity, 'none', `${def.name} scored as doing nothing`);
    if (facts.recognition.status === 'unrecognised') {
      assert.ok(SEVERITY[facts.severity] >= SEVERITY.moderate, `${def.name}: unrecognised but below the floor`);
      assert.equal(facts.recognition.verb, tokenise(def.name)[0]);
      assert.ok(facts.signals.some((s) => s.code === 'unrecognised_action'), `${def.name}: no signal raised`);
    }
  }
});

test('an unrecognised tool is told to the human as unknown, not as a read', async () => {
  const def = tools.find((t) => t.name === 'retire_entities')!;
  const { call, facts } = factsFor(def);

  assert.equal(factualProposal(facts).headline, 'What this does could not be determined');

  const decision = await gate(def, call);
  assert.match(decision.consent.lines[0], /^What this does is not known: 'retire_entities'/);
  assert.equal(decision.requiresApproval, false, 'below the default threshold, by design');
  assert.equal((await gate(def, call, { threshold: 'moderate' })).requiresApproval, true);
});

test('recognition does not depend on the arguments', () => {
  // The state is about the definition, so a different call to the same tool
  // cannot flip it — otherwise an argument could talk the gate into knowing.
  const def = tools.find((t) => t.name === 'apply_migration')!;
  const a = deriveFacts(adaptMcpTool(def), { id: 'a', tool: def.name, args: { migration: 'x' } });
  const b = deriveFacts(adaptMcpTool(def), { id: 'b', tool: def.name, args: { migration: 'DROP TABLE users' } });
  assert.deepEqual(a.recognition, b.recognition);
  assert.equal(a.recognition.status, 'unrecognised');
});

test('a harmless unrecognised tool stays below the alarm threshold', () => {
  // The floor is `moderate` because the real corpus's three unrecognised verbs
  // all belong to harmless tools. Stopping for `ping` is how gates get clicked through.
  for (const def of tools.filter((t) => t.effect === null)) {
    const { facts } = factsFor(def);
    assert.ok(SEVERITY[facts.severity] < SEVERITY.high, `${def.name} would interrupt a person`);
  }
});
