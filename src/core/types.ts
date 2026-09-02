/**
 * Airlock — consent for agent tool calls, where the consequence is derived
 * and verified rather than narrated.
 *
 * The load-bearing idea: a model never writes the sentence a human reads.
 * It proposes a *typed* consequence; the verifier checks that proposal against
 * facts derived deterministically from the call; the prose shown to the human
 * is rendered in code from what survived.
 */

/** What a tool does to the world. Ordered by nothing — this is a set, not a scale. */
export type EffectKind =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network_egress'
  | 'message_send'
  | 'spend'
  | 'credential_access';

/**
 * Severity is an integer so that "the narration may not understate" is a
 * comparison rather than a judgement call.
 */
export const SEVERITY = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 } as const;
export type SeverityName = keyof typeof SEVERITY;
export type SeverityRank = (typeof SEVERITY)[SeverityName];

/**
 * Reversibility is likewise ranked, ascending in badness, so a claim that the
 * call is easier to undo than it really is fails the same numeric test.
 */
export const REVERSIBILITY = { reversible: 0, recoverable: 1, irreversible: 2 } as const;
export type ReversibilityName = keyof typeof REVERSIBILITY;
export type ReversibilityRank = (typeof REVERSIBILITY)[ReversibilityName];

/** A tool as advertised by whoever is offering it. Untrusted metadata. */
export interface ToolSchema {
  name: string;
  description: string;
  /**
   * Effects the tool admits to. Treated as a *floor*, never a ceiling — a tool
   * that declares nothing is not thereby harmless, it is merely undeclared.
   *
   * The `undefined` / `[]` distinction is load-bearing. `[]` means the tool had
   * a way to declare its effects and declared none, which is itself evidence.
   * `undefined` means there was no declaration channel — as in MCP, which has
   * no such field — and absence of evidence is not evidence.
   */
  declaredEffects?: EffectKind[];
  parameters: Record<string, ParamSpec>;
}

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  description?: string;
  /** Marks a parameter as naming a filesystem path, URL, recipient, or amount. */
  role?: 'path' | 'glob' | 'url' | 'recipient' | 'amount' | 'command' | 'secret';
  /** The directory or host the tool claims to confine itself to. */
  confinedTo?: string;
}

/** A concrete pending invocation. Arguments are attacker-controlled. */
export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** One concrete thing a call will touch, and how we know. */
export interface Target {
  value: string;
  role: NonNullable<ParamSpec['role']>;
  /** True when the value resolves outside the parameter's declared confinement. */
  escapesConfinement: boolean;
  /**
   * True only when the parameter declared a boundary AND this value is inside
   * it. A parameter that declared no boundary is not thereby compliant with
   * one — treating those as the same thing let an email to an arbitrary
   * external address read as confined traffic.
   */
  confined: boolean;
}

/** Why the deriver concluded something. Every fact carries its own provenance. */
export interface Signal {
  code: string;
  detail: string;
  /** Which parameter (or `tool`) produced this signal. */
  source: string;
}

/** Deterministic facts about a call. No model involved in producing these. */
export interface DerivedFacts {
  callId: string;
  tool: string;
  effects: EffectKind[];
  targets: Target[];
  /** `null` means the count cannot be bounded from the arguments alone. */
  affectedCount: number | null;
  reversibility: ReversibilityName;
  /** Destinations that leave the machine, if any. */
  egress: string[];
  severity: SeverityName;
  signals: Signal[];
}

/**
 * What the model proposes. Every field is checked before any of it is shown.
 * Free prose is confined to `headline` and `risks`, and even those are scanned.
 */
export interface ProposedConsequence {
  headline: string;
  severity: SeverityName;
  reversibility: ReversibilityName;
  affectedCount: number | null;
  /** Must cover every derived target. */
  scopePaths: string[];
  egress: string[];
  /** Consequence-framed, second person, what could happen to the user. */
  risks: string[];
}

export type RejectionCode =
  | 'severity_understated'
  | 'reversibility_overstated'
  | 'count_understated'
  | 'scope_incomplete'
  | 'egress_omitted'
  | 'entity_fabricated'
  | 'approval_directive'
  | 'malformed';

export interface Rejection {
  code: RejectionCode;
  detail: string;
}

export interface Verdict {
  /** True only when every check passed. A single rejection fails the whole narration. */
  accepted: boolean;
  rejections: Rejection[];
  /** Present when accepted — the prose is rendered from facts, not copied from the model. */
  rendered?: RenderedConsent;
}

/** What the human actually sees. Assembled in code. */
export interface RenderedConsent {
  title: string;
  severity: SeverityName;
  lines: string[];
  risks: string[];
  /** Always shown: the unedited call, so approval is never only of the prose. */
  rawCall: ToolCall;
}
