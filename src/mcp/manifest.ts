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
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: `unsupported manifest version ${JSON.stringify(obj.version)} (this build reads version 1)` };
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
      confinement[key] = value;
    }
  }

  const declaredEffects: Record<string, EffectKind[]> = {};
  if (obj.effects !== undefined) {
    if (!obj.effects || typeof obj.effects !== 'object' || Array.isArray(obj.effects)) {
      return { ok: false, error: '"effects" must be an object of tool names to effect lists' };
    }
    for (const [tool, value] of Object.entries(obj.effects as Record<string, unknown>)) {
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
