/**
 * A reviewed capability manifest.
 *
 * The deriver's effect inference is lexical, and the README is honest about what
 * that misses: a tool whose name and parameters never say what it does — a
 * `terminate_instance` that deletes, a `grant_role` worded outside the privilege
 * vocabulary — is not caught, and no amount of vocabulary closes it without
 * tuning on the very corpus that measures the gap. The actual fix, named there,
 * is a signature over a reviewed manifest.
 *
 * This is that manifest, read as data so it can be tested. An operator who has
 * read a tool writes down what it really does and what it may touch; the file is
 * verified against a hash the operator pins out of band, so a server or agent
 * that later swaps it cannot launder a dangerous tool past the gate. The effects
 * it declares are a floor the deriver adds to, exactly like `declaredEffects` —
 * the manifest is a trusted channel for them, not a new kind of trust in the
 * tool itself.
 */
import { createHash } from 'node:crypto';

import type { AdaptOptions } from './adapt.ts';
import type { EffectKind } from '../core/types.ts';

/** The eight effects the deriver understands, as a runtime set for validation. */
export const EFFECT_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  'read', 'write', 'delete', 'execute',
  'network_egress', 'message_send', 'spend', 'credential_access',
]);

const KNOWN_KEYS: ReadonlySet<string> = new Set(['version', 'confine', 'effects']);

export interface Manifest extends AdaptOptions {
  confinement: Record<string, string>;
  declaredEffects: Record<string, EffectKind[]>;
}

export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; error: string };

/** The sha256 of the manifest's exact bytes, as the operator pins it. */
export function manifestSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Keys that appear more than once in the same JSON object, in the order met.
 * JSON.parse keeps the last of two identical keys and says nothing, so a manifest
 * with `"terminate_instance": ["delete"]` and, further down,
 * `"terminate_instance": []` would quietly declare nothing. Only called on text
 * JSON.parse has already accepted, so it walks the structure without re-checking
 * it. Keys are compared after decoding, so "a" and "\u0061" are the same key.
 */
export function duplicateKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string> | null> = []; // a Set for an object, null for an array
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const token = JSON.parse(text.slice(i, j + 1)) as string;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const seen = stack[stack.length - 1];
      if (seen && text[k] === ':') {
        if (seen.has(token)) dups.push(token);
        seen.add(token);
      }
      i = j;
    }
  }
  return dups;
}

/**
 * Read a manifest's text into confinement and declared effects, or one reason it
 * is not a manifest. Nothing here throws: a hand-edited or damaged file must fail
 * closed with a message, never slip through as an empty manifest that asserts
 * nothing.
 */
export function parseManifest(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'a manifest is a JSON object' };
  }
  const repeated = duplicateKeys(text);
  if (repeated.length > 0) {
    return { ok: false, error: `${repeated.map((k) => JSON.stringify(k)).join(', ')} appears more than once; the last would silently win, so say it once` };
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: `unsupported manifest version ${JSON.stringify(obj.version)} (this build reads version 1)` };
  }

  // A misspelled section name ("effect" for "effects", "confinement" for
  // "confine") would be skipped, and the manifest would parse cleanly while
  // declaring nothing: review that looks done and is not. Refuse any key this
  // build does not read.
  const unknown = Object.keys(obj).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => JSON.stringify(k)).join(', ')}; a manifest has "version", "confine" and "effects"` };
  }

  const confinement: Record<string, string> = {};
  if (obj.confine !== undefined) {
    if (!obj.confine || typeof obj.confine !== 'object' || Array.isArray(obj.confine)) {
      return { ok: false, error: '"confine" must be an object of parameter patterns to boundaries' };
    }
    for (const [key, value] of Object.entries(obj.confine as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, error: `"confine.${key}" must be a non-empty string` };
      }
      // A key the deriver can never match is a boundary the operator thinks is in
      // force but is not. Confinement is looked up as `tool.param` or `*.param`,
      // so a key with no dot (`"path"` for `"*.path"`) would silently apply to
      // nothing. Refuse it rather than let it look set.
      if (!key.includes('.')) {
        return { ok: false, error: `"confine.${key}" should be tool.param or *.param (it has no dot, so it matches nothing)` };
      }
      confinement[key] = value;
    }
  }

  const declaredEffects: Record<string, EffectKind[]> = {};
  if (obj.effects !== undefined) {
    if (!obj.effects || typeof obj.effects !== 'object' || Array.isArray(obj.effects)) {
      return { ok: false, error: '"effects" must be an object of tool names to effect lists' };
    }
    for (const [tool, value] of Object.entries(obj.effects as Record<string, unknown>)) {
      // `declaredEffects["__proto__"] = x` replaces the object's prototype rather
      // than adding an entry, so the tool would be silently left out while the
      // manifest still parsed. Refuse it instead of passing a manifest that says
      // less than it appears to.
      if (tool === '__proto__') {
        return { ok: false, error: '"effects" cannot be keyed "__proto__" (it would not be recorded)' };
      }
      if (!Array.isArray(value)) {
        return { ok: false, error: `"effects.${tool}" must be a list of effects` };
      }
      for (const e of value) {
        if (typeof e !== 'string' || !EFFECT_KINDS.has(e as EffectKind)) {
          return { ok: false, error: `"effects.${tool}" has an unknown effect ${JSON.stringify(e)}; allowed: ${[...EFFECT_KINDS].join(', ')}` };
        }
      }
      declaredEffects[tool] = value as EffectKind[];
    }
  }

  return { ok: true, manifest: { confinement, declaredEffects } };
}

/**
 * Manifest entries that name a tool the server does not offer. An entry for
 * `terminate_instnace` applies to nothing, yet looks like review happened, which
 * is the same quiet failure as a boundary that matches no parameter. Checked once
 * the server's own tools/list has arrived, since that is the first moment the
 * names can be compared.
 */
export function unmatchedManifestTools(
  declaredEffects: Record<string, EffectKind[]> | undefined,
  offered: Iterable<string>,
): string[] {
  const have = new Set(offered);
  return Object.keys(declaredEffects ?? {}).filter((tool) => !have.has(tool)).sort();
}

/**
 * How much of what the server offers a manifest actually covers. A tool with no
 * entry is not thereby unsafe, but it is still judged by the lexical guess the
 * manifest exists to replace, and an operator who loaded one should be able to
 * see how many tools that still is.
 */
export function manifestCoverage(
  declaredEffects: Record<string, EffectKind[]> | undefined,
  offered: Iterable<string>,
): { reviewed: string[]; unreviewed: string[] } {
  const reviewedNames = new Set(Object.keys(declaredEffects ?? {}));
  const reviewed: string[] = [];
  const unreviewed: string[] = [];
  for (const name of new Set(offered)) (reviewedNames.has(name) ? reviewed : unreviewed).push(name);
  return { reviewed: reviewed.sort(), unreviewed: unreviewed.sort() };
}

