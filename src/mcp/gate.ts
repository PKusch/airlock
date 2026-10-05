import { deriveFacts, type PathResolver } from '../core/derive.ts';
import { factualProposal, type Narrator } from '../core/narrate.ts';
import { renderFallback, verifyConsequence } from '../core/verify.ts';
import { SEVERITY, type DerivedFacts, type RenderedConsent, type ToolCall, type Verdict } from '../core/types.ts';
import { adaptMcpTool, adaptationGaps, type AdaptOptions, type McpToolDefinition } from './adapt.ts';

export interface GateOptions extends AdaptOptions {
  resolver?: PathResolver;
  narrator?: Narrator;
  /** At or above this severity a person must approve. Defaults to `high`. */
  threshold?: keyof typeof SEVERITY;
}

export interface GateDecision {
  facts: DerivedFacts;
  verdict: Verdict;
  /** What a person should be shown. Present whether or not narration survived. */
  consent: RenderedConsent;
  requiresApproval: boolean;
  /** What the adapter could not learn from the MCP definition. */
  gaps: string[];
}

/**
 * The severity at or above which a person must approve. An unknown name used to
 * make `SEVERITY[name]` undefined, so `severity >= undefined` was false for every
 * call and nothing was ever stopped: a typo such as 'hihg' turned the gate off
 * without a word. A threshold that is not a severity is refused instead, which
 * fails closed (the proxy turns the throw into a refusal).
 */
export function thresholdRank(threshold: keyof typeof SEVERITY | undefined): number {
  const name = threshold ?? 'high';
  if (!Object.prototype.hasOwnProperty.call(SEVERITY, name)) {
    throw new Error(`threshold '${String(name)}' is not a severity; use one of ${Object.keys(SEVERITY).join(', ')}`);
  }
  return SEVERITY[name];
}

/**
 * The guard. Everything a host needs to decide whether to interrupt someone,
 * and what to put in front of them if it does.
 */
export async function gate(
  def: McpToolDefinition,
  call: ToolCall,
  options: GateOptions = {},
): Promise<GateDecision> {
  const rank = thresholdRank(options.threshold);
  const schema = adaptMcpTool(def, options);
  const facts = deriveFacts(schema, call, { resolver: options.resolver });

  const proposal = options.narrator
    ? await options.narrator(facts, call)
    : factualProposal(facts);

  const verdict = verifyConsequence(facts, proposal, call);
  const consent = verdict.rendered ?? renderFallback(facts, call, verdict.rejections);

  return {
    facts,
    verdict,
    consent,
    requiresApproval: SEVERITY[facts.severity] >= rank,
    gaps: adaptationGaps(schema),
  };
}

/** The consent card as plain text, for hosts with nowhere to render HTML. */
export function formatConsent(decision: GateDecision): string {
  const { consent, facts, gaps } = decision;
  const out = [`[${consent.severity.toUpperCase()}] ${consent.title}`, ''];
  for (const line of consent.lines) out.push(`  ${line}`);
  if (consent.risks.length > 0) {
    out.push('');
    for (const risk of consent.risks) out.push(`  · ${risk}`);
  }
  out.push('', '  The actual call:', `  ${JSON.stringify(consent.rawCall.args)}`);
  if (facts.signals.length > 0) {
    out.push('', '  Signals:');
    for (const s of facts.signals) out.push(`    ${s.code} (${s.source}) — ${s.detail}`);
  }
  if (gaps.length > 0) {
    out.push('', '  What could not be checked:');
    for (const g of gaps) out.push(`    - ${g}`);
  }
  return out.join('\n');
}
