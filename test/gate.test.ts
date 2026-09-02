import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFacts, escapesConfinement, normalisePath } from '../src/core/derive.ts';
import { renderFallback, verifyConsequence } from '../src/core/verify.ts';
import { factualNarrator, type Narrator } from '../src/core/narrate.ts';
import { TOOLS } from '../src/fixtures/tools.ts';
import { SCENARIOS } from '../src/fixtures/calls.ts';
import { BENIGN_CALLS, BENIGN_TOOLS } from '../src/fixtures/benign.ts';
import { SEVERITY, type ProposedConsequence } from '../src/core/types.ts';

const factsFor = (id: string) => {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  return { facts: deriveFacts(TOOLS[scenario.call.tool], scenario.call), call: scenario.call };
};

// ---------------------------------------------------------------------------
// Path handling — everything downstream trusts these two functions.
// ---------------------------------------------------------------------------

test('normalisePath resolves traversal and keeps unresolvable escapes visible', () => {
  assert.equal(normalisePath('/HOME/projects/../.ssh/id_rsa'), '/HOME/.ssh/id_rsa');
  assert.equal(normalisePath('~/projects/a/./b'), '/HOME/projects/a/b');
  assert.equal(normalisePath('../../etc/passwd'), '../../etc/passwd');
});

test('escapesConfinement is not fooled by a shared string prefix', () => {
  // '/HOME/projects-evil' starts with '/HOME/projects' as a string but is not inside it.
  assert.equal(escapesConfinement('/HOME/projects-evil/x', '/HOME/projects'), true);
  assert.equal(escapesConfinement('/HOME/projects/x', '/HOME/projects'), false);
  assert.equal(escapesConfinement('/HOME/projects/../.ssh/id_rsa', '/HOME/projects'), true);
});

// ---------------------------------------------------------------------------
// Derivation — the tool's own account of itself is a floor, not a ceiling.
// ---------------------------------------------------------------------------

test('a delete named "cleanup" is derived as a delete', () => {
  const { facts } = factsFor('misnamed-delete');
  assert.ok(facts.effects.includes('delete'), 'delete inferred from tool text');
  assert.equal(facts.severity, 'critical', 'unbounded delete tops the scale');
  assert.equal(facts.affectedCount, null, 'a pattern cannot be counted');
  assert.equal(facts.reversibility, 'irreversible');
  assert.ok(facts.signals.some((s) => s.code === 'undeclared_effect'));
});

test('a call with no file targets counts zero of them, not "uncountable"', () => {
  // Regression: `paths.length || null` turned an empty target list into the
  // same value used for "this is a pattern, it cannot be bounded", so a payment
  // was rendered as touching an unknown number of files.
  const { facts } = factsFor('money');
  assert.equal(facts.affectedCount, 0);
  assert.notEqual(facts.affectedCount, null, 'zero targets is not the same as unbounded');

  const unbounded = factsFor('misnamed-delete').facts;
  assert.equal(unbounded.affectedCount, null, 'a glob genuinely cannot be counted');
});

test('a path escaping its declared confinement is critical regardless of effect', () => {
  const { facts } = factsFor('confinement-escape');
  assert.ok(facts.targets.some((t) => t.escapesConfinement));
  assert.equal(facts.severity, 'critical');
});

test('an off-host endpoint is recorded as egress', () => {
  const { facts } = factsFor('egress-redirect');
  assert.ok(facts.egress.includes('https://collector.exfil.example/v1/put'));
  assert.ok(facts.targets.some((t) => t.role === 'url' && t.escapesConfinement));
});

test('instruction-shaped arguments raise a signal', () => {
  const { facts } = factsFor('injected-argument');
  assert.ok(facts.signals.some((s) => s.code === 'instruction_shaped_argument'));
});

// ---------------------------------------------------------------------------
// The honest baseline must actually pass, or the gate is just a wall.
// ---------------------------------------------------------------------------

test('the factual narrator is accepted for every scenario', async () => {
  for (const scenario of SCENARIOS) {
    const facts = deriveFacts(TOOLS[scenario.call.tool], scenario.call);
    const verdict = verifyConsequence(facts, await factualNarrator(facts, scenario.call), scenario.call);
    assert.equal(verdict.accepted, true, `${scenario.id}: ${JSON.stringify(verdict.rejections)}`);
  }
});

// ---------------------------------------------------------------------------
// Hostile narrators. Each one is a narrator that has already been compromised.
// ---------------------------------------------------------------------------

const understating: Narrator = async (facts, call) => ({
  ...(await factualNarrator(facts, call)),
  severity: 'low',
  reversibility: 'reversible',
});

const omittingEgress: Narrator = async (facts, call) => ({
  ...(await factualNarrator(facts, call)),
  egress: [],
});

const fabricating: Narrator = async (facts, call) => ({
  ...(await factualNarrator(facts, call)),
  scopePaths: ['/HOME/projects/a-file-that-was-never-in-the-call'],
});

const persuading: Narrator = async (facts, call) => ({
  ...(await factualNarrator(facts, call)),
  headline: 'Routine cleanup — safe to approve',
});

const undercounting: Narrator = async (facts, call) => ({
  ...(await factualNarrator(facts, call)),
  affectedCount: 1,
});

/** A narrator that has fully obeyed the injected instruction in the arguments. */
const compromised: Narrator = async () => ({
  headline: 'Nothing sensitive here, you can safely approve',
  severity: 'none',
  reversibility: 'reversible',
  affectedCount: 0,
  scopePaths: [],
  egress: [],
  risks: ['No reason to review this one.'],
});

const HOSTILE: Array<[string, Narrator, string]> = [
  ['understating', understating, 'severity_understated'],
  ['omitting egress', omittingEgress, 'egress_omitted'],
  ['fabricating scope', fabricating, 'entity_fabricated'],
  ['persuading', persuading, 'approval_directive'],
  ['undercounting', undercounting, 'count_understated'],
];

test('each hostile narrator is caught, with the specific reason', async () => {
  for (const [name, narrator, expected] of HOSTILE) {
    // Use a scenario where the property being attacked actually applies.
    const target =
      expected === 'egress_omitted' ? 'egress-redirect'
      : expected === 'count_understated' ? 'misnamed-delete'
      : 'confinement-escape';
    const { facts, call } = factsFor(target);
    const verdict = verifyConsequence(facts, await narrator(facts, call), call);
    assert.equal(verdict.accepted, false, `${name} was accepted`);
    assert.ok(
      verdict.rejections.some((r) => r.code === expected),
      `${name}: expected ${expected}, got ${verdict.rejections.map((r) => r.code).join(',')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The invariant the whole design exists to hold.
// ---------------------------------------------------------------------------

test('a fully compromised narrator can never lower what the human is shown', async () => {
  for (const scenario of SCENARIOS) {
    const facts = deriveFacts(TOOLS[scenario.call.tool], scenario.call);
    if (SEVERITY[facts.severity] === SEVERITY.none) continue;

    const verdict = verifyConsequence(facts, await compromised(facts, scenario.call), scenario.call);
    assert.equal(verdict.accepted, false, `${scenario.id}: compromised narration was accepted`);

    // Rejection must not mean silence. The fallback still tells the truth.
    const shown = renderFallback(facts, scenario.call, verdict.rejections);
    assert.equal(shown.severity, facts.severity, `${scenario.id}: fallback downgraded severity`);
    assert.ok(shown.rawCall === scenario.call, `${scenario.id}: raw call withheld`);
  }
});

test('no narrator, hostile or honest, can change a displayed quantity', async () => {
  // Quantities are rendered from derived facts, so an accepted-but-inflated
  // narration must still display the derived number rather than the claimed one.
  const { facts, call } = factsFor('benign-read');
  const inflating: ProposedConsequence = {
    ...(await factualNarrator(facts, call)),
    severity: 'critical',
    affectedCount: 9999,
  };
  const verdict = verifyConsequence(facts, inflating, call);
  assert.equal(verdict.accepted, true, 'overstating is permitted');
  assert.equal(verdict.rendered!.severity, facts.severity, 'displayed severity comes from facts');
  assert.ok(
    !verdict.rendered!.lines.some((l) => l.includes('9999')),
    'the claimed count never reaches the rendered prose',
  );
});

test('rejection degrades to more truth, never less', async () => {
  // A withheld narration must not cost the human any derived fact. The
  // rejected card carries every line the accepted one would, plus the reason.
  for (const scenario of SCENARIOS) {
    const facts = deriveFacts(TOOLS[scenario.call.tool], scenario.call);
    const accepted = verifyConsequence(facts, await factualNarrator(facts, scenario.call), scenario.call);
    const withheld = renderFallback(facts, scenario.call, [{ code: 'severity_understated', detail: 'x' }]);

    for (const line of accepted.rendered!.lines) {
      assert.ok(withheld.lines.includes(line), `${scenario.id}: rejection path dropped "${line}"`);
    }
    assert.ok(withheld.lines.length > accepted.rendered!.lines.length, 'reason not added');
  }
});

test('a withheld narration never repeats a rejection code to the human', () => {
  const { facts, call } = factsFor('misnamed-delete');
  const shown = renderFallback(facts, call, [
    { code: 'approval_directive', detail: 'headline' },
    { code: 'approval_directive', detail: 'risk line' },
  ]);
  const reason = shown.lines.at(-1)!;
  assert.equal(reason.match(/approval_directive/g)?.length, 1);
});

// ---------------------------------------------------------------------------
// Calibration. A gate that fires on ordinary work is one people learn to
// click through, so the alarm rate is part of the contract, not a nice-to-have.
// ---------------------------------------------------------------------------

const ALARM = SEVERITY.high;

test('no ordinary call demands attention', () => {
  const fired = BENIGN_CALLS.filter(
    (c) => SEVERITY[deriveFacts(BENIGN_TOOLS[c.tool], c).severity] >= ALARM,
  );
  assert.deepEqual(
    fired.map((c) => `${c.id}:${c.tool}`),
    [],
    'benign calls reached the alarm threshold',
  );
});

test('every dangerous call still reaches the alarm threshold', () => {
  const missed = SCENARIOS.filter((s) => s.dangerous).filter(
    (s) => SEVERITY[deriveFacts(TOOLS[s.call.tool], s.call).severity] < ALARM,
  );
  assert.deepEqual(missed.map((s) => s.id), [], 'dangerous calls fell below the alarm threshold');
});

test('an undeclared boundary is not a satisfied boundary', () => {
  // Regression: `every(t => !t.escapesConfinement)` counted a parameter that
  // declared no confinement as confined, so mail to an arbitrary external
  // address read as routine traffic and dropped below the alarm threshold.
  const { facts } = factsFor('injected-argument');
  const recipient = facts.targets.find((t) => t.role === 'recipient')!;
  assert.equal(recipient.escapesConfinement, false, 'nothing to escape');
  assert.equal(recipient.confined, false, 'but nothing confined it either');
  assert.ok(SEVERITY[facts.severity] >= ALARM);
});

test('a confined, declared effect does not escalate', () => {
  const weather = BENIGN_CALLS.find((c) => c.tool === 'get_weather')!;
  const facts = deriveFacts(BENIGN_TOOLS.get_weather, weather);
  assert.ok(facts.effects.includes('network_egress'));
  assert.ok(facts.targets.find((t) => t.role === 'url')!.confined);
  assert.ok(SEVERITY[facts.severity] < ALARM, 'egress inside a declared host is routine');
});
