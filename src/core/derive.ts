import {
  canDeclare as declarationOffered,
  countCovers,
  declaredSet,
  exactly,
  isSatisfied,
  isViolated,
  unbounded as UNBOUNDED,
  type Confinement,
  type Count,
  type Declaration,
} from './constraint.ts';
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

/**
 * Canonicalises a path by following whatever the filesystem actually does.
 * The core has to run in a browser, where there is no filesystem, so this is
 * injected rather than imported — see `resolver.node.ts` for the real one.
 */
export interface PathResolver {
  /** Canonical path with links followed, or `null` if it cannot be resolved. */
  realpath(path: string): string | null;
}

/** True when `candidate` does not sit inside `root`, by string alone. */
export function escapesConfinement(candidate: string, root: string): boolean {
  const c = normalisePath(candidate);
  const r = normalisePath(root);
  if (c.startsWith('..')) return true;
  // Absolute candidate against an absolute root: plain prefix test on segments.
  if (c === r) return false;
  return !c.startsWith(r.endsWith('/') ? r : r + '/');
}

/**
 * Confinement check with a resolver in play. Lexical escape is still decisive —
 * a resolver that says "inside" cannot overrule `../` — but a path that looks
 * innocent lexically and lands outside once links are followed is caught here.
 * This is the symlink case: no `..` appears anywhere in the argument.
 */
export function escapesConfinementResolved(
  candidate: string,
  root: string,
  resolver: PathResolver | undefined,
): { escapes: boolean; resolved: boolean; via: 'lexical' | 'filesystem' } {
  if (escapesConfinement(candidate, root)) return { escapes: true, resolved: true, via: 'lexical' };
  if (!resolver) return { escapes: false, resolved: false, via: 'lexical' };

  const realCandidate = resolver.realpath(candidate);
  const realRoot = resolver.realpath(root);
  // An unresolvable path is not thereby safe; it is unknown, and the caller is
  // told so rather than being handed a quiet `false`.
  if (realCandidate === null || realRoot === null) {
    return { escapes: false, resolved: false, via: 'filesystem' };
  }
  return {
    escapes: escapesConfinement(realCandidate, realRoot),
    resolved: true,
    via: 'filesystem',
  };
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

const GLOB_CHARS = /[*?[\]{}]/;

export interface DeriveOptions {
  /** Supply one to catch confinement escapes that only exist on disk. */
  resolver?: PathResolver;
}

export function deriveFacts(schema: ToolSchema, call: ToolCall, options: DeriveOptions = {}): DerivedFacts {
  const signals: Signal[] = [];
  const declaration: Declaration<EffectKind> =
    schema.declaredEffects === undefined
      ? { channel: 'absent' }
      : { channel: 'available', declared: schema.declaredEffects };
  const declared = declaredSet(declaration);
  const effects = new Set<EffectKind>(declared);
  /** Whether failing to declare is evidence about this tool at all. */
  const canDeclare = declarationOffered(declaration);

  // --- Effects inferred from how the tool names and describes itself ---------
  const prose = `${schema.name} ${schema.description}`;
  for (const [effect, tell] of EFFECT_TELLS) {
    if (!tell.test(prose)) continue;
    effects.add(effect);
    if (canDeclare && !declared.has(effect)) {
      signals.push({
        code: 'undeclared_effect',
        detail: `Tool text implies '${effect}' but the schema does not declare it`,
        source: 'tool',
      });
    }
  }

  // --- Targets and effects implied by the actual arguments ------------------
  const targets: Target[] = [];
  let isUnbounded = false;

  for (const [name, spec] of Object.entries(schema.parameters)) {
    const roleEffect = spec.role ? ROLE_EFFECTS[spec.role] : undefined;
    if (roleEffect) {
      effects.add(roleEffect);
      if (canDeclare && !declared.has(roleEffect)) {
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
      let confinement: Confinement = { status: 'undeclared' };

      if (spec.role === 'path' || spec.role === 'glob') {
        if (spec.confinedTo) {
          const check = escapesConfinementResolved(value, spec.confinedTo, options.resolver);
          if (check.escapes) {
            confinement = { status: 'escaped', boundary: spec.confinedTo, via: check.via };
            if (check.via === 'filesystem') {
              signals.push({
                code: 'symlink_escape',
                detail: `'${value}' stays inside '${spec.confinedTo}' as written, but resolves outside it on disk`,
                source: name,
              });
            }
          } else if (!check.resolved && options.resolver) {
            // The boundary exists but could not be tested. That is a third
            // outcome, and it is not 'inside'.
            confinement = {
              status: 'unverifiable',
              boundary: spec.confinedTo,
              reason: 'path could not be resolved on disk',
            };
            signals.push({
              code: 'unresolved_path',
              detail: `'${value}' could not be resolved on disk — confinement was checked by string only`,
              source: name,
            });
          } else {
            confinement = { status: 'inside', boundary: spec.confinedTo };
          }
        }
        if (spec.role === 'glob' || GLOB_CHARS.test(value)) {
          isUnbounded = true;
          signals.push({
            code: 'unbounded_target_set',
            detail: `'${value}' is a pattern — the number of things it matches cannot be known from the call`,
            source: name,
          });
        }
      } else if (spec.role === 'url' && spec.confinedTo) {
        const host = hostOf(value);
        confinement =
          host === null
            ? { status: 'unverifiable', boundary: spec.confinedTo, reason: 'no host could be parsed' }
            : host === spec.confinedTo.toLowerCase()
              ? { status: 'inside', boundary: spec.confinedTo }
              : { status: 'escaped', boundary: spec.confinedTo, via: 'lexical' };
      }

      if (isViolated(confinement)) {
        signals.push({
          code: 'confinement_escape',
          detail: `'${value}' resolves outside the declared boundary '${spec.confinedTo}'`,
          source: name,
        });
      }

      targets.push({ value, role: spec.role, confinement });
    }
  }

  const egress = targets.filter((t) => t.role === 'url' || t.role === 'recipient').map((t) => t.value);
  const hasArbitraryCommand = targets.some((t) => t.role === 'command');

  return {
    callId: call.id,
    tool: call.tool,
    effects: [...effects].sort(),
    targets,
    // `null` means genuinely uncountable, and nothing else. A call with no
    // file targets at all counts zero of them — collapsing those two into the
    // same value made a payment read as touching an unbounded set of files.
    affected: isUnbounded ? UNBOUNDED : exactly(targets.filter((t) => t.role === 'path').length),
    reversibility: deriveReversibility(effects),
    egress,
    severity: deriveSeverity(effects, targets, isUnbounded, signals, declared, hasArbitraryCommand, canDeclare),
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
  isUnbounded: boolean,
  signals: Signal[],
  declared: Set<EffectKind>,
  hasArbitraryCommand: boolean,
  canDeclare: boolean,
): SeverityName {
  let rank: number = SEVERITY.none;
  const raise = (to: SeverityName) => {
    rank = Math.max(rank, SEVERITY[to]);
  };

  // Whether a destination was checkable at all. An egress the tool confined to
  // a host, which the argument then matched, is a different thing from an
  // egress to wherever the argument happened to point.
  const egressTargets = targets.filter((t) => t.role === 'url');
  const egressConfined = egressTargets.length > 0 && egressTargets.every((t) => isSatisfied(t.confinement));
  const recipients = targets.filter((t) => t.role === 'recipient');
  const recipientsConfined = recipients.length > 0 && recipients.every((t) => isSatisfied(t.confinement));

  if (effects.has('read')) raise('low');
  if (effects.has('write')) raise('moderate');

  // Executing the tool's own fixed operation is ordinary; executing a string
  // somebody handed it is not.
  if (effects.has('execute')) raise(hasArbitraryCommand ? 'high' : 'moderate');

  // Egress that stayed inside a declared boundary is routine traffic. Egress
  // to an unconstrained destination is the thing worth stopping for.
  if (effects.has('network_egress')) raise(egressConfined ? 'moderate' : 'high');
  if (effects.has('message_send')) raise(recipientsConfined ? 'moderate' : 'high');

  if (effects.has('delete')) raise(isUnbounded ? 'critical' : 'high');
  if (effects.has('spend') || effects.has('credential_access')) raise('critical');

  if (isUnbounded && effects.has('execute')) raise('critical');

  // Escaping a boundary the tool declared for itself is the strongest signal
  // available: the tool stated a limit and the argument left it.
  if (targets.some((t) => isViolated(t.confinement))) raise('critical');

  // An effect the tool did not admit to is worth one level on its own — the
  // schema was wrong about what this tool does, so the rest of it is suspect.
  // Only when declaring was possible. A protocol with no field for effects —
  // MCP has none — makes every tool look like it is hiding something, which
  // escalates everything and destroys the signal it was meant to carry.
  const undeclaredConsequential =
    canDeclare && [...effects].some((e) => !declared.has(e) && e !== 'read' && e !== 'write');
  if (undeclaredConsequential) raise(rank >= SEVERITY.high ? 'critical' : 'high');
  void signals;

  return (Object.keys(SEVERITY) as SeverityName[]).find((k) => SEVERITY[k] === rank) ?? 'none';
}

export const RANK = { SEVERITY, REVERSIBILITY };

void countCovers; // re-exported for consumers via constraint.ts
export type { Count };
