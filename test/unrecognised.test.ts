import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts, tokenise } from '../src/core/derive.ts';
import { factualProposal } from '../src/core/narrate.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { gate } from '../src/mcp/gate.ts';
import { SEVERITY, type EffectKind, type ToolCall } from '../src/core/types.ts';
import { benignArgs, outcome, type Outcome } from './unrecognised-report.ts';

/**
 * The verb vocabulary is finite, and ordinary API authors leave it without
 * trying. Two corpora measure how often and pin the answer, so the README's
 * numbers and the deriver's behaviour cannot drift apart unnoticed.
 *
 * The first corpus was measured (4 of 18 caught), and the vocabulary was then
 * extended against it. The second was held out. Only the second says anything
 * about what the extension bought.
 */

interface Labelled extends McpToolDefinition {
  effect: EffectKind | null;
  expected?: Outcome;
}

const load = (file: string): Labelled[] =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).tools;

const first = load('../corpus/unrecognised-verbs.json');
const heldOut = load('../corpus/unrecognised-verbs-heldout.json');

const factsFor = (def: Labelled) => {
  const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
  return { call, facts: deriveFacts(adaptMcpTool(def), call) };
};

const tally = (tools: Labelled[]) => {
  const t: Record<Outcome, number> = { caught: 0, 'under-read': 0, unrecognised: 0, harmless: 0 };
  for (const def of tools) t[outcome(def)] += 1;
  return t;
};

/** Evidence that the *leading verb of the name* was recognised — the new verbs' only channel. */
const leadingVerbEvidence = (def: Labelled) =>
  factsFor(def).facts.effectEvidence.filter((e) => e.source === 'tool name' && e.matched === tokenise(def.name)[0]);

test('first corpus: the words the vocabulary was extended against are now known', () => {
  assert.equal(first.length, 22);
  for (const def of first) assert.equal(outcome(def), def.expected, def.name);
  assert.deepEqual(tally(first), { caught: 17, 'under-read': 1, unrecognised: 0, harmless: 4 });
});

test('held-out corpus: the leading verbs are outside the vocabulary, before and after', () => {
  assert.equal(heldOut.length, 28);
  for (const def of heldOut) {
    assert.deepEqual(leadingVerbEvidence(def), [], `${def.name}: '${tokenise(def.name)[0]}' is in the vocabulary`);
  }
});

test('held-out corpus: what the extension bought on words it was not written against', () => {
  // 19 of 22 consequential tools are still unrecognised. The three catches
  // come from the mechanisms that existed before the extension — a description
  // phrase, a parameter role, a sensitive noun — and not from any new verb.
  assert.deepEqual(tally(heldOut), { caught: 3, 'under-read': 0, unrecognised: 19, harmless: 6 });
  const caught = heldOut.filter((t) => outcome(t) === 'caught').map((t) => t.name).sort();
  assert.deepEqual(caught, ['invite_member', 'reveal_secret', 'wire_funds']);
  for (const def of heldOut) if (outcome(def) === 'caught') assert.deepEqual(leadingVerbEvidence(def), [], def.name);
});

test('under-read is named: the deriver thinks it knows, and knows too little', () => {
  // `reset` is mapped to write because reset_password and reset_counter are
  // writes. reset_workspace destroys uncommitted work, and comes out milder
  // than it is with no "unknown" line on the card. This is the understating
  // direction the gate exists to prevent, and it is now a state the report
  // shows rather than one it hides inside "caught".
  const def = first.find((t) => t.name === 'reset_workspace')!;
  const { facts } = factsFor(def);
  assert.equal(facts.recognition.status, 'recognised');
  assert.deepEqual(facts.effects, ['write']);
  assert.equal(facts.severity, 'moderate');
  assert.equal(outcome(def), 'under-read');
});

test('nothing inferred is not read as nothing happens', () => {
  // The fourth instance of the collapse: an empty effect set used to score
  // `none`, so `retire_entities` came out identical to `ping`.
  for (const def of [...first, ...heldOut]) {
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
  const def = heldOut.find((t) => t.name === 'terminate_instance')!;
  const { call, facts } = factsFor(def);

  assert.equal(factualProposal(facts).headline, 'What this does could not be determined');

  const decision = await gate(def, call);
  assert.match(decision.consent.lines[0], /^What this does is not known: 'terminate_instance'/);
  assert.equal(decision.requiresApproval, false, 'below the default threshold, by design');
  assert.equal((await gate(def, call, { threshold: 'moderate' })).requiresApproval, true);
});

test('recognition does not depend on the arguments', () => {
  // The state is about the definition, so a different call to the same tool
  // cannot flip it — otherwise an argument could talk the gate into knowing.
  const def = heldOut.find((t) => t.name === 'void_transaction')!;
  const a = deriveFacts(adaptMcpTool(def), { id: 'a', tool: def.name, args: { transactionId: 'x' } });
  const b = deriveFacts(adaptMcpTool(def), { id: 'b', tool: def.name, args: { transactionId: 'DROP TABLE users' } });
  assert.deepEqual(a.recognition, b.recognition);
  assert.equal(a.recognition.status, 'unrecognised');
});

test('a harmless unrecognised tool stays below the alarm threshold', () => {
  // The floor is `moderate` because the real corpus's three unrecognised verbs
  // all belong to harmless tools. Stopping for `ping` is how gates get clicked through.
  for (const def of [...first, ...heldOut].filter((t) => t.effect === null)) {
    const { facts } = factsFor(def);
    assert.ok(SEVERITY[facts.severity] < SEVERITY.high, `${def.name} would interrupt a person`);
  }
});
