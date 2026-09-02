import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canDeclare,
  countCovers,
  declaredSet,
  exactly,
  isSatisfied,
  isUnchecked,
  isViolated,
  unbounded,
  type Confinement,
} from '../src/core/constraint.ts';

/**
 * These pin the primitives rather than any one caller. Three separate bugs in
 * this codebase were the same mistake — a missing constraint scored as a
 * satisfied one — so the property is asserted here, once, over every variant,
 * instead of being re-litigated at each call site.
 */

const ALL_VARIANTS: Confinement[] = [
  { status: 'inside', boundary: '/root' },
  { status: 'escaped', boundary: '/root', via: 'lexical' },
  { status: 'escaped', boundary: '/root', via: 'filesystem' },
  { status: 'undeclared' },
  { status: 'unverifiable', boundary: '/root', reason: 'could not resolve' },
];

test('exactly one variant counts as satisfied', () => {
  const satisfied = ALL_VARIANTS.filter(isSatisfied);
  assert.equal(satisfied.length, 1);
  assert.equal(satisfied[0].status, 'inside');
});

test('not-violated is never the same question as satisfied', () => {
  // This is the bug, stated directly. Every variant that is not a violation
  // must NOT thereby be a satisfaction.
  const notViolated = ALL_VARIANTS.filter((c) => !isViolated(c));
  const wronglySatisfied = notViolated.filter((c) => c.status !== 'inside' && isSatisfied(c));
  assert.deepEqual(wronglySatisfied, [], 'a non-violation was scored as compliance');
  assert.ok(notViolated.length > 1, 'there is more than one way not to be a violation');
});

test('every variant is exactly one of satisfied, violated or unchecked', () => {
  for (const c of ALL_VARIANTS) {
    const hits = [isSatisfied(c), isViolated(c), isUnchecked(c)].filter(Boolean).length;
    assert.equal(hits, 1, `${c.status} matched ${hits} states`);
  }
});

test('an undeclared boundary is unchecked, not satisfied and not violated', () => {
  const c: Confinement = { status: 'undeclared' };
  assert.equal(isSatisfied(c), false);
  assert.equal(isViolated(c), false);
  assert.equal(isUnchecked(c), true);
});

test('a boundary that could not be tested is unchecked, not satisfied', () => {
  const c: Confinement = { status: 'unverifiable', boundary: '/root', reason: 'gone' };
  assert.equal(isSatisfied(c), false);
  assert.equal(isUnchecked(c), true);
});

// ---------------------------------------------------------------------------

test('unbounded is not a quantity, and zero is not unbounded', () => {
  assert.equal(countCovers(exactly(0), exactly(0)), true, 'zero covers zero');
  assert.equal(countCovers(exactly(0), unbounded), false, 'zero does not cover unbounded');
  assert.equal(countCovers(exactly(9999), unbounded), false, 'no number covers unbounded');
  assert.equal(countCovers(unbounded, unbounded), true);
  assert.equal(countCovers(unbounded, exactly(3)), true, 'overstating is allowed');
  assert.equal(countCovers(exactly(2), exactly(3)), false, 'understating is not');
  assert.equal(countCovers(exactly(4), exactly(3)), true);
});

// ---------------------------------------------------------------------------

test('no declaration channel yields no declarations and no evidence', () => {
  assert.equal(canDeclare({ channel: 'absent' }), false);
  assert.equal(declaredSet({ channel: 'absent' }).size, 0);

  // The distinction that matters: both produce an empty set, but only one of
  // them means the tool chose to say nothing.
  assert.equal(canDeclare({ channel: 'available', declared: [] }), true);
  assert.equal(declaredSet({ channel: 'available', declared: [] }).size, 0);
});
