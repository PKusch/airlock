import {
  REVERSIBILITY,
  SEVERITY,
  type DerivedFacts,
  type ProposedConsequence,
  type Rejection,
  type RenderedConsent,
  type ToolCall,
  type Verdict,
} from './types.ts';
import { normalisePath } from './derive.ts';

/**
 * The verifier is monotone in exactly one direction: a proposed consequence may
 * overstate the danger, and may never understate it. That asymmetry is the
 * whole defence. An attacker who controls the arguments — and therefore
 * anything the narrator reads — always wants the prompt to say *less* than the
 * truth, so a check that only ever rejects downgrades does not need to
 * anticipate the wording of the attack.
 */

/** Language whose job is to move the reader toward approval. Never shown. */
const APPROVAL_DIRECTIVE =
  /\b(safe to (?:approve|proceed|run)|no (?:need|reason) to (?:review|check|worry)|nothing (?:sensitive|important|of note)|routine (?:operation|cleanup|task)|harmless|you can (?:safely )?approve|auto[- ]?approve|proceed without|don'?t worry|no confirmation (?:is )?(?:needed|required)|low risk, |simply click)\b/i;

/** Does `covered` contain `target`, as a path prefix or an exact string? */
function covers(covered: string, target: string): boolean {
  if (covered === target) return true;
  const c = normalisePath(covered);
  const t = normalisePath(target);
  if (c === t) return true;
  return t.startsWith(c.endsWith('/') ? c : c + '/');
}

export function verifyConsequence(
  facts: DerivedFacts,
  proposed: ProposedConsequence,
  call: ToolCall,
): Verdict {
  const rejections: Rejection[] = [];
  const reject = (code: Rejection['code'], detail: string) => rejections.push({ code, detail });

  // --- Shape ---------------------------------------------------------------
  if (!proposed || typeof proposed !== 'object') {
    return { accepted: false, rejections: [{ code: 'malformed', detail: 'Not an object' }] };
  }
  if (!(proposed.severity in SEVERITY)) reject('malformed', `Unknown severity '${proposed.severity}'`);
  if (!(proposed.reversibility in REVERSIBILITY)) {
    reject('malformed', `Unknown reversibility '${proposed.reversibility}'`);
  }
  if (typeof proposed.headline !== 'string' || proposed.headline.trim() === '') {
    reject('malformed', 'Headline is empty');
  }
  if (rejections.length > 0) return { accepted: false, rejections };

  // --- The one-way checks --------------------------------------------------
  if (SEVERITY[proposed.severity] < SEVERITY[facts.severity]) {
    reject(
      'severity_understated',
      `Claimed '${proposed.severity}', derived '${facts.severity}' from ${facts.effects.join(', ')}`,
    );
  }

  if (REVERSIBILITY[proposed.reversibility] < REVERSIBILITY[facts.reversibility]) {
    reject(
      'reversibility_overstated',
      `Claimed '${proposed.reversibility}', derived '${facts.reversibility}'`,
    );
  }

  if (facts.affectedCount === null) {
    if (proposed.affectedCount !== null) {
      reject(
        'count_understated',
        `Claimed exactly ${proposed.affectedCount}, but the target set is a pattern and cannot be bounded`,
      );
    }
  } else if (proposed.affectedCount !== null && proposed.affectedCount < facts.affectedCount) {
    reject('count_understated', `Claimed ${proposed.affectedCount}, derived ${facts.affectedCount}`);
  }

  // --- Completeness: nothing real may be left out ---------------------------
  const scope = proposed.scopePaths ?? [];
  for (const target of facts.targets) {
    if (target.role !== 'path' && target.role !== 'glob') continue;
    if (!scope.some((s) => covers(s, target.value))) {
      reject('scope_incomplete', `'${target.value}' is touched but appears in no stated scope`);
    }
  }

  const statedEgress = proposed.egress ?? [];
  for (const destination of facts.egress) {
    if (!statedEgress.includes(destination)) {
      reject('egress_omitted', `Data reaches '${destination}', which the consequence does not mention`);
    }
  }

  // --- Fabrication: nothing may be invented either --------------------------
  const realValues = new Set(facts.targets.map((t) => t.value));
  for (const stated of [...scope, ...statedEgress]) {
    const isReal = [...realValues].some((real) => covers(stated, real) || covers(real, stated));
    if (!isReal) {
      reject('entity_fabricated', `'${stated}' appears in the consequence but in no argument of the call`);
    }
  }

  // --- Persuasion ----------------------------------------------------------
  for (const text of [proposed.headline, ...(proposed.risks ?? [])]) {
    if (APPROVAL_DIRECTIVE.test(text)) {
      reject('approval_directive', `Text argues for approval rather than describing consequence: "${text}"`);
    }
  }

  if (rejections.length > 0) return { accepted: false, rejections };

  return { accepted: true, rejections: [], rendered: render(facts, proposed, call) };
}

const EFFECT_PROSE: Record<string, string> = {
  read: 'reads data',
  write: 'writes or changes files',
  delete: 'deletes data',
  execute: 'runs a command on this machine',
  network_egress: 'sends data off this machine',
  message_send: 'sends a message as you',
  spend: 'moves money',
  credential_access: 'reads stored credentials',
};

const REVERSIBILITY_PROSE: Record<string, string> = {
  reversible: 'Nothing is changed, so nothing needs undoing.',
  recoverable: 'Changes can be undone, but not automatically.',
  irreversible: 'This cannot be undone once it runs.',
};

/**
 * Lines derived wholly from facts. No part of this depends on the narrator,
 * which is why the rejection path can show all of it too.
 */
function factLines(facts: DerivedFacts): string[] {
  const lines: string[] = [];

  lines.push(`This ${facts.effects.map((e) => EFFECT_PROSE[e] ?? e).join(', and ')}.`);

  const paths = facts.targets.filter((t) => t.role === 'path' || t.role === 'glob');
  if (paths.length > 0) {
    lines.push(
      facts.affectedCount === null
        ? `It applies to everything matching ${paths.map((p) => `'${p.value}'`).join(' and ')} — the number of items is not knowable before it runs.`
        : `It affects ${facts.affectedCount} item${facts.affectedCount === 1 ? '' : 's'}: ${paths.map((p) => `'${p.value}'`).join(', ')}.`,
    );
  }

  const escapes = facts.targets.filter((t) => t.escapesConfinement);
  if (escapes.length > 0) {
    lines.push(
      `It reaches outside the boundary the tool declares for itself: ${escapes.map((e) => `'${e.value}'`).join(', ')}.`,
    );
  }

  if (facts.egress.length > 0) {
    lines.push(`Data leaves this machine, to: ${facts.egress.join(', ')}.`);
  }

  lines.push(REVERSIBILITY_PROSE[facts.reversibility]);

  const undeclared = facts.signals.filter((s) => s.code === 'undeclared_effect');
  if (undeclared.length > 0) {
    lines.push(
      `The tool does not declare everything it does. ${undeclared.length} effect(s) were inferred rather than announced.`,
    );
  }

  if (facts.signals.some((s) => s.code === 'instruction_shaped_argument')) {
    lines.push(
      'An argument to this call contains text written to influence a model. Read the raw call below before approving.',
    );
  }

  return lines;
}

/**
 * Prose assembly for an accepted narration. Every quantity is read from
 * `facts`; the model's text is used only where it is a framing, not a fact.
 */
function render(facts: DerivedFacts, proposed: ProposedConsequence, call: ToolCall): RenderedConsent {
  return {
    title: proposed.headline.trim(),
    severity: facts.severity,
    lines: factLines(facts),
    risks: proposed.risks ?? [],
    rawCall: call,
  };
}

/**
 * What the human sees when no narration survived. Deliberately plain: a failed
 * verification must degrade to the unadorned truth, never to silence and never
 * to a reassuring default.
 */
export function renderFallback(
  facts: DerivedFacts,
  call: ToolCall,
  rejections: Rejection[],
): RenderedConsent {
  const codes = [...new Set(rejections.map((r) => r.code))];
  return {
    title: `Unverified description — showing what the call actually does`,
    severity: facts.severity,
    lines: [
      ...factLines(facts),
      `The plain-language description was withheld: ${codes.join(', ')}.`,
    ],
    risks: [],
    rawCall: call,
  };
}
