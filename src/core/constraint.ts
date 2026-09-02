/**
 * Three-state results for checks that might not have been possible.
 *
 * Every bug of one particular kind in this codebase came from a boolean:
 * `escapes === false` was read as "inside the boundary" when it also meant
 * "no boundary was ever declared"; `0` targets was stored as `null` and read
 * as "uncountable"; a protocol with no field for effects was read as a tool
 * declining to name them. In each case a *missing* constraint was scored as a
 * *satisfied* one, which is the direction that quietly lets things through.
 *
 * A boolean cannot hold the third state, so these types exist to make the
 * conflation unrepresentable rather than merely unfixed. There is deliberately
 * no `!violated` shortcut anywhere: the only way to a positive answer is
 * `isSatisfied`, which is true for exactly one variant.
 */

/** The outcome of checking a value against a boundary someone declared. */
export type Confinement =
  | { status: 'inside'; boundary: string }
  | { status: 'escaped'; boundary: string; via: 'lexical' | 'filesystem' }
  /** No boundary was ever declared. Nothing was checked, and nothing passed. */
  | { status: 'undeclared' }
  /** A boundary exists but the check could not be completed. */
  | { status: 'unverifiable'; boundary: string; reason: string };

/** True for exactly one variant. There is no other way to get `true`. */
export function isSatisfied(c: Confinement): boolean {
  return c.status === 'inside';
}

/** True only for a boundary that was declared and then left. */
export function isViolated(c: Confinement): boolean {
  return c.status === 'escaped';
}

/** True when nothing was actually established either way. */
export function isUnchecked(c: Confinement): boolean {
  return c.status === 'undeclared' || c.status === 'unverifiable';
}

/** How many things a call touches. `unbounded` is not a quantity. */
export type Count = { kind: 'exact'; n: number } | { kind: 'unbounded' };

export const exactly = (n: number): Count => ({ kind: 'exact', n });
export const unbounded: Count = { kind: 'unbounded' };

/** A claimed count is adequate only if it is at least the derived one. */
export function countCovers(claimed: Count, derived: Count): boolean {
  if (derived.kind === 'unbounded') return claimed.kind === 'unbounded';
  if (claimed.kind === 'unbounded') return true; // overstating is always allowed
  return claimed.n >= derived.n;
}

/**
 * What a tool said about its own effects — distinguishing a tool that had the
 * opportunity and declined from a protocol that never offered one.
 */
export type Declaration<T> =
  | { channel: 'available'; declared: T[] }
  | { channel: 'absent' };

export function declaredSet<T>(d: Declaration<T>): Set<T> {
  return new Set(d.channel === 'available' ? d.declared : []);
}

/** Whether failing to declare something is evidence about this tool at all. */
export function canDeclare<T>(d: Declaration<T>): boolean {
  return d.channel === 'available';
}
