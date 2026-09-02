import {
  REVERSIBILITY,
  SEVERITY,
  type DerivedFacts,
  type EffectKind,
  type ParamSpec,
  type ReversibilityName,
  type SeverityName,
  type Signal,
  type Target,
  type ToolCall,
  type ToolSchema,
} from './types.ts';

/**
 * Deterministic derivation. No model runs here, and nothing in this file may
 * consult the tool's own claims about how dangerous it is — a tool's
 * `declaredEffects` is a floor we add to, never a ceiling we trust.
 */

/** Words that betray an effect the tool may not have declared. */
const EFFECT_TELLS: Array<[EffectKind, RegExp]> = [
  // Matched as stems (`clean` catches `clearing`, `cleanup`, `cleaned`), because
  // an effect wrongly inferred costs a louder prompt while an effect missed
  // costs the user the thing the prompt existed to prevent.
  ['delete', /\b(delete|remov|rm|purge|wipe|eras|destroy|drop|prune|clean|clear|truncat)\w*/i],
  ['write', /\b(write|creat|updat|modif|edit|renam|mov|overwrit|sav|patch)\w*/i],
  ['execute', /\b(exec|run|spawn|shell|command|script|eval)\w*/i],
  ['network_egress', /\b(upload|post|fetch|http|url|webhook|sync|publish|export)\w*/i],
  ['message_send', /\b(send|sent|email|mail|message|dm|notif|repl|sms|slack)\w*/i],
  ['spend', /\b(pay|payment|charg|purchas|buy|transfer|invoic|refund|checkout)\w*/i],
  ['credential_access', /\b(secret|token|credential|password|api[_ -]?key|keychain|auth)\w*/i],
  ['read', /\b(read|list|get|search|find|quer|inspect|show)\w*/i],
];

/** A parameter's role implies an effect regardless of what the tool says. */
const ROLE_EFFECTS: Partial<Record<NonNullable<ParamSpec['role']>, EffectKind>> = {
  command: 'execute',
  url: 'network_egress',
  recipient: 'message_send',
  amount: 'spend',
  secret: 'credential_access',
};

/**
 * Text that looks addressed to a model rather than to the tool. Detected here
 * only to raise a signal — the defence against it lives in the verifier, which
 * refuses downgrades no matter how persuasively they are argued.
 */
const INSTRUCTION_SHAPED =
  /\b(ignore|disregard|override)\b.{0,40}\b(previous|prior|above|earlier|instruction|rule)|"?\bsystem\b"?\s*:|\bno (?:confirmation|approval) (?:is )?(?:needed|required)\b|\bauto[- ]?approve\b|\bthis is (?:a )?(?:routine|safe|harmless)\b|\bdo not (?:warn|alert|prompt|ask)\b/i;

/** Normalise a POSIX-ish path without pulling in `node:path` (this runs in the browser too). */
export function normalisePath(raw: string): string {
  const expanded = raw.replace(/^~(?=\/|$)/, '/HOME');
  const isAbsolute = expanded.startsWith('/');
  const out: string[] = [];
  for (const segment of expanded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Popping past the root of a relative path is what an escape looks like,
      // so preserve the '..' rather than silently swallowing it.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

/** True when `candidate` does not sit inside `root` after normalisation. */
export function escapesConfinement(candidate: string, root: string): boolean {
  const c = normalisePath(candidate);
  const r = normalisePath(root);
  if (c.startsWith('..')) return true;
  // Absolute candidate against an absolute root: plain prefix test on segments.
  if (c === r) return false;
  return !c.startsWith(r.endsWith('/') ? r : r + '/');
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

const GLOB_CHARS = /[*?[\]{}]/;

export function deriveFacts(schema: ToolSchema, call: ToolCall): DerivedFacts {
  const signals: Signal[] = [];
  const effects = new Set<EffectKind>(schema.declaredEffects ?? []);
  const declared = new Set<EffectKind>(schema.declaredEffects ?? []);

  // --- Effects inferred from how the tool names and describes itself ---------
  const prose = `${schema.name} ${schema.description}`;
  for (const [effect, tell] of EFFECT_TELLS) {
    if (!tell.test(prose)) continue;
    effects.add(effect);
    if (!declared.has(effect)) {
      signals.push({
        code: 'undeclared_effect',
        detail: `Tool text implies '${effect}' but the schema does not declare it`,
        source: 'tool',
      });
    }
  }

  // --- Targets and effects implied by the actual arguments ------------------
  const targets: Target[] = [];
  let unbounded = false;

  for (const [name, spec] of Object.entries(schema.parameters)) {
    const roleEffect = spec.role ? ROLE_EFFECTS[spec.role] : undefined;
    if (roleEffect) {
      effects.add(roleEffect);
      if (!declared.has(roleEffect)) {
        signals.push({
          code: 'undeclared_effect',
          detail: `Parameter role '${spec.role}' implies '${roleEffect}', undeclared by the tool`,
          source: name,
        });
      }
    }

    const raw = call.args[name];
    if (raw === undefined || raw === null) continue;

    const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];

    if (INSTRUCTION_SHAPED.test(values.join(' '))) {
      signals.push({
        code: 'instruction_shaped_argument',
        detail: `Argument '${name}' contains text addressed to a model rather than data`,
        source: name,
      });
    }

    if (!spec.role) continue;

    for (const value of values) {
      let escapes = false;

      if (spec.role === 'path' || spec.role === 'glob') {
        if (spec.confinedTo) escapes = escapesConfinement(value, spec.confinedTo);
        if (spec.role === 'glob' || GLOB_CHARS.test(value)) {
          unbounded = true;
          signals.push({
            code: 'unbounded_target_set',
            detail: `'${value}' is a pattern — the number of things it matches cannot be known from the call`,
            source: name,
          });
        }
      } else if (spec.role === 'url') {
        const host = hostOf(value);
        if (spec.confinedTo && host && host !== spec.confinedTo.toLowerCase()) escapes = true;
      }

      if (escapes) {
        signals.push({
          code: 'confinement_escape',
          detail: `'${value}' resolves outside the declared boundary '${spec.confinedTo}'`,
          source: name,
        });
      }

      targets.push({ value, role: spec.role, escapesConfinement: escapes });
    }
  }

  const egress = targets.filter((t) => t.role === 'url' || t.role === 'recipient').map((t) => t.value);

  return {
    callId: call.id,
    tool: call.tool,
    effects: [...effects].sort(),
    targets,
    // `null` means genuinely uncountable, and nothing else. A call with no
    // file targets at all counts zero of them — collapsing those two into the
    // same value made a payment read as touching an unbounded set of files.
    affectedCount: unbounded ? null : targets.filter((t) => t.role === 'path').length,
    reversibility: deriveReversibility(effects),
    egress,
    severity: deriveSeverity(effects, targets, unbounded, signals),
    signals,
  };
}

function deriveReversibility(effects: Set<EffectKind>): ReversibilityName {
  // Anything that has already left the machine, been spent, or been executed
  // cannot be walked back by this system, whatever the tool offers.
  if (
    effects.has('delete') ||
    effects.has('spend') ||
    effects.has('message_send') ||
    effects.has('network_egress') ||
    effects.has('execute')
  ) {
    return 'irreversible';
  }
  if (effects.has('write')) return 'recoverable';
  return 'reversible';
}

function deriveSeverity(
  effects: Set<EffectKind>,
  targets: Target[],
  unbounded: boolean,
  signals: Signal[],
): SeverityName {
  let rank: number = SEVERITY.none;
  const raise = (to: SeverityName) => {
    rank = Math.max(rank, SEVERITY[to]);
  };

  if (effects.has('read')) raise('low');
  if (effects.has('write')) raise('moderate');
  if (effects.has('network_egress') || effects.has('message_send')) raise('high');
  if (effects.has('delete') || effects.has('execute')) raise('high');
  if (effects.has('spend') || effects.has('credential_access')) raise('critical');

  // An unbounded destructive set and an escape past the declared boundary are
  // each enough on their own to take a call to the top of the scale.
  if (unbounded && (effects.has('delete') || effects.has('execute'))) raise('critical');
  if (targets.some((t) => t.escapesConfinement)) raise('critical');
  if (signals.some((s) => s.code === 'undeclared_effect') && rank >= SEVERITY.moderate) raise('high');

  return (Object.keys(SEVERITY) as SeverityName[]).find((k) => SEVERITY[k] === rank) ?? 'none';
}

export const RANK = { SEVERITY, REVERSIBILITY };
