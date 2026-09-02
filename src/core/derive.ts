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
  type EffectEvidence,
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

/**
 * Effect inference, rebuilt after auditing 36 real MCP tool definitions.
 *
 * The first version matched word stems anywhere in the name or description,
 * which inferred `delete` for `list_directory` from the word "clearly" and
 * `message_send` for `edit_file` from "replaces". Loose stems over a real
 * corpus produce noise, and noise in a consent gate is indistinguishable from
 * a broken gate.
 *
 * MCP tool names are overwhelmingly `verb_noun` — `read_file`,
 * `delete_entities`, `create_directory`. The leading verb is a far better
 * signal than a substring anywhere, and it is not fooled by nouns:
 * `get-annotated-message` is a `get`, whatever the rest of it says.
 */
const VERB_EFFECTS: Record<string, EffectKind> = {
  get: 'read', read: 'read', list: 'read', search: 'read', find: 'read',
  fetch: 'read', show: 'read', describe: 'read', query: 'read', inspect: 'read',
  open: 'read', view: 'read', count: 'read', check: 'read', tree: 'read',

  write: 'write', create: 'write', update: 'write', edit: 'write', modify: 'write',
  rename: 'write', move: 'write', save: 'write', patch: 'write', append: 'write',
  set: 'write', add: 'write', insert: 'write', copy: 'write', make: 'write',
  gzip: 'write', compress: 'write', format: 'write', toggle: 'write',

  delete: 'delete', remove: 'delete', rm: 'delete', purge: 'delete', wipe: 'delete',
  erase: 'delete', destroy: 'delete', drop: 'delete', prune: 'delete',
  clear: 'delete', clean: 'delete', cleanup: 'delete', truncate: 'delete',

  run: 'execute', exec: 'execute', execute: 'execute', spawn: 'execute',
  invoke: 'execute', trigger: 'execute', eval: 'execute', shell: 'execute',

  upload: 'network_egress', sync: 'network_egress', publish: 'network_egress',
  export: 'network_egress', push: 'network_egress', post: 'network_egress',

  send: 'message_send', email: 'message_send', mail: 'message_send',
  notify: 'message_send', reply: 'message_send', message: 'message_send',

  pay: 'spend', charge: 'spend', purchase: 'spend', buy: 'spend',
  transfer: 'spend', refund: 'spend', checkout: 'spend',
};

/**
 * Verbs that are safe to recognise anywhere in a tool name because they are
 * effectively never used as nouns in an API surface.
 */
const UNAMBIGUOUS_LATER_VERBS = new Set([
  'delete', 'remove', 'purge', 'wipe', 'erase', 'destroy', 'prune', 'truncate',
  'cleanup', 'pay', 'charge', 'refund',
]);

/**
 * Nouns that make a tool sensitive regardless of its verb. `get-env` is a
 * `get`, and environment variables are where API keys live.
 */
const SENSITIVE_NOUNS: Array<[EffectKind, RegExp]> = [
  ['credential_access', /^(env|secret|secrets|token|tokens|credential|credentials|password|passwords|keychain|apikey)$/i],
];

/**
 * Description matching, kept deliberately narrow: explicit verb forms only.
 * A description is weaker evidence than a name and gets to *add* an effect,
 * never to be the sole basis for one that the name contradicts.
 */
const DESCRIPTION_TELLS: Array<[EffectKind, RegExp]> = [
  ['delete', /\b(deletes?|deleting|removes?|removing|erases?|purges?|wipes?|destroys?|permanently remove)\b/i],
  ['execute', /\b(executes?|runs? (?:a )?(?:command|script|shell)|spawns?)\b/i],
  ['network_egress', /\b(uploads?|sends? (?:it |them )?to (?:a )?(?:server|endpoint|url)|publishes?|transmits?)\b/i],
  ['message_send', /\b(sends? (?:an? )?(?:email|message|notification)|emails?|notifies)\b/i],
  ['spend', /\b(charges?|pays?|transfers? funds|makes? a payment)\b/i],
  ['credential_access', /\b(api key|access token|credentials?|password|environment variables?)\b/i],
];

/** Split `get-annotated-message`, `readTextFile`, `read_file` into tokens. */
export function tokenise(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

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
  const effectEvidence: EffectEvidence[] = [];
  const addEffect = (effect: EffectKind, matched: string, source: string) => {
    effects.add(effect);
    effectEvidence.push({ effect, matched, source });
    if (canDeclare && !declared.has(effect)) {
      signals.push({
        code: 'undeclared_effect',
        detail: `'${matched}' in the ${source} implies '${effect}', which the schema does not declare`,
        source: 'tool',
      });
    }
  };

  // The leading verb of the tool name, which is where MCP puts the action.
  const tokens = tokenise(schema.name);
  const verbEffect = tokens.length > 0 ? VERB_EFFECTS[tokens[0]] : undefined;
  if (verbEffect) addEffect(verbEffect, tokens[0], 'tool name');

  // A later token can still name an action, but only for verbs that are almost
  // never nouns. `get-annotated-message` is a `get` whose second token is the
  // noun "message"; treating that as a send is how the audit found this rule
  // over-firing on real schemas. `delete`, `purge` and `wipe` carry no such
  // ambiguity.
  for (const token of tokens.slice(1)) {
    const later = VERB_EFFECTS[token];
    if (later && !effects.has(later) && UNAMBIGUOUS_LATER_VERBS.has(token)) {
      addEffect(later, token, 'tool name');
    }
    for (const [effect, tell] of SENSITIVE_NOUNS) {
      if (tell.test(token) && !effects.has(effect)) addEffect(effect, token, 'tool name');
    }
  }
  for (const [effect, tell] of SENSITIVE_NOUNS) {
    if (tokens.length > 0 && tell.test(tokens[0]) && !effects.has(effect)) {
      addEffect(effect, tokens[0], 'tool name');
    }
  }

  for (const [effect, tell] of DESCRIPTION_TELLS) {
    const hit = tell.exec(schema.description);
    if (hit && !effects.has(effect)) addEffect(effect, hit[0], 'description');
  }

  // --- Targets and effects implied by the actual arguments ------------------
  const targets: Target[] = [];
  let isUnbounded = false;

  for (const [name, spec] of Object.entries(schema.parameters)) {
    const roleEffect = spec.role ? ROLE_EFFECTS[spec.role] : undefined;
    if (roleEffect) addEffect(roleEffect, spec.role!, `parameter '${name}'`);

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
    effectEvidence,
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
