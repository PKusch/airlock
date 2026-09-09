import type { Confinement, Count } from './constraint.ts';

export type { Confinement, Count };

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
  /**
   * What the tool's own server says about it, from MCP tool annotations. The
   * spec's instruction is that clients MUST treat these as untrusted unless
   * the server is trusted, so they are held apart from `declaredEffects`:
   * never a floor on effects, never a reason to lower anything. They can
   * raise, they can contradict, and they can be quoted to the person. Only
   * hints the server actually wrote are recorded; the spec's defaults are
   * not filled in, because a default is not a statement.
   */
  selfDescription?: SelfDescription;
  parameters: Record<string, ParamSpec>;
}

export interface SelfDescription {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  description?: string;
  /**
   * Marks a parameter as naming a filesystem path, URL, recipient, or amount.
   * `subject` names the things the tool acts on without locating them — entity
   * names, record ids — so the call can at least be counted, if not confined.
   */
  role?: 'path' | 'glob' | 'url' | 'recipient' | 'amount' | 'command' | 'secret' | 'subject';
  /** The directory or host the tool claims to confine itself to. */
  confinedTo?: string;
  /**
   * A number, a boolean or a fixed choice cannot carry a path, a destination or
   * a command. Such a parameter has no role because it needs none, which is a
   * different thing from a free-text or structured parameter that could hold
   * anything and is simply not understood. The gap report tells them apart.
   */
  inert?: boolean;
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
  /**
   * Three-state by construction. There is no boolean here because every past
   * bug of this shape came from one — see `constraint.ts`.
   */
  confinement: Confinement;
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
  /** `unbounded` is a kind, not a number. Zero targets is `exactly(0)`. */
  affected: Count;
  reversibility: ReversibilityName;
  /** Destinations that leave the machine, if any. */
  egress: string[];
  severity: SeverityName;
  signals: Signal[];
  /**
   * For each effect that was inferred rather than declared, the exact text that
   * produced it. An inference a person cannot audit is an assertion, and this
   * gate has no business making assertions it will not show its work for.
   */
  effectEvidence: EffectEvidence[];
  /**
   * Whether the deriver understood what this tool does at all. An empty
   * `effects` used to be read as "does nothing" and scored `none` — the same
   * collapse as `escapes === false`, in the same permissive direction. A tool
   * the vocabulary does not know is a third state, and it is named here.
   */
  recognition: Recognition;
  /** The server's own account, carried through so the card can quote it. */
  selfDescription?: SelfDescription;
}

/**
 * Three sources can tell the deriver what a tool does: a declaration, its own
 * text, or the roles of its parameters. When none of them says anything, the
 * tool is not thereby harmless; it is unrecognised, and the leading verb that
 * failed to match is recorded so a person can judge it for themselves.
 */
export type Recognition =
  | { status: 'recognised' }
  | { status: 'unrecognised'; verb: string };

export interface EffectEvidence {
  effect: EffectKind;
  /** The matched substring, verbatim. */
  matched: string;
  /** Where it was found: `tool name`, `description`, or a parameter role. */
  source: string;
}

/**
 * What the model proposes. Every field is checked before any of it is shown.
 * Free prose is confined to `headline` and `risks`, and even those are scanned.
 */
export interface ProposedConsequence {
  /** Model output arrives as JSON, so this stays a plain shape and is
   *  converted at the verifier boundary. `null` means "I claim unbounded". */
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
