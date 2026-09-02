import type { EffectKind, ParamSpec, ToolSchema } from '../core/types.ts';

/**
 * Adapting a real MCP tool definition into something the deriver can reason
 * about.
 *
 * The honest problem: MCP tool definitions carry no capability annotations.
 * There is no `declaredEffects`, and nothing anywhere says which directory a
 * filesystem tool is supposed to stay inside. Everything the deriver relies on
 * has to be inferred from a name, a description and a JSON Schema — which is a
 * weaker position than the fixture catalogue, and the calibration numbers
 * should be read with that in mind.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, { type?: string; description?: string; format?: string; items?: unknown }>;
    required?: string[];
  };
}

/**
 * Parameter roles, matched on *tokens* rather than prefixes.
 *
 * The prefix version inferred `recipient` for a parameter named `topic`,
 * because `^to` matches it. Splitting `excludePatterns` and `topic` into
 * tokens first fixes that class outright, and picks up `excludePatterns` as a
 * glob, which the prefix version missed.
 */
const ROLE_TOKENS: Array<[NonNullable<ParamSpec['role']>, Set<string>]> = [
  ['secret', new Set(['token', 'tokens', 'secret', 'secrets', 'apikey', 'password', 'credential', 'credentials', 'auth'])],
  ['command', new Set(['command', 'cmd', 'script', 'shell', 'exec', 'argv'])],
  ['amount', new Set(['amount', 'price', 'cost', 'total', 'fee'])],
  ['recipient', new Set(['to', 'recipient', 'recipients', 'mailto', 'addressee', 'chatid'])],
  ['url', new Set(['url', 'urls', 'uri', 'endpoint', 'webhook', 'href'])],
  ['glob', new Set(['pattern', 'patterns', 'glob', 'globs', 'wildcard'])],
  ['path', new Set(['path', 'paths', 'file', 'files', 'filepath', 'filename', 'dir', 'dirs', 'directory', 'directories', 'folder', 'source', 'destination'])],
];

/** Split `excludePatterns`, `chat_id`, `to` into lowercase tokens. */
export function tokenise(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function inferRole(name: string, prop: { description?: string; format?: string }): ParamSpec['role'] {
  const tokens = new Set(tokenise(name));
  for (const [role, vocabulary] of ROLE_TOKENS) {
    for (const token of tokens) {
      if (vocabulary.has(token)) return role;
    }
  }
  if (prop.format === 'uri' || prop.format === 'url') return 'url';
  if (prop.format === 'email') return 'recipient';
  // A description is weaker evidence than a name, so it is consulted last.
  if (prop.description && /\b(glob|wildcard) pattern\b/i.test(prop.description)) return 'glob';
  if (prop.description && /\b(file|directory|folder) path\b/i.test(prop.description)) return 'path';
  return undefined;
}

function mapType(t: string | undefined): ParamSpec['type'] {
  switch (t) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'string[]';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

export interface AdaptOptions {
  /**
   * Boundaries the operator asserts, because the tool cannot. Keyed by
   * `toolName.paramName` or `*.paramName` for every tool. Without these the
   * deriver has no confinement to check against, and says so.
   */
  confinement?: Record<string, string>;
  /** Effects the operator knows about that the schema does not reveal. */
  declaredEffects?: Record<string, EffectKind[]>;
}

export function adaptMcpTool(def: McpToolDefinition, options: AdaptOptions = {}): ToolSchema {
  const parameters: Record<string, ParamSpec> = {};

  for (const [name, prop] of Object.entries(def.inputSchema.properties ?? {})) {
    const role = inferRole(name, prop);
    parameters[name] = {
      type: mapType(prop.type),
      description: prop.description,
      ...(role ? { role } : {}),
      ...(role
        ? confinementFor(options.confinement, def.name, name)
        : {}),
    };
  }

  return {
    name: def.name,
    description: def.description ?? '',
    // MCP declares no effects. Anything supplied here came from an operator,
    // not from the tool, and is still treated as a floor rather than a ceiling.
    declaredEffects: options.declaredEffects?.[def.name],
    parameters,
  };
}

function confinementFor(
  confinement: Record<string, string> | undefined,
  tool: string,
  param: string,
): { confinedTo?: string } {
  if (!confinement) return {};
  const boundary = confinement[`${tool}.${param}`] ?? confinement[`*.${param}`];
  return boundary ? { confinedTo: boundary } : {};
}

/**
 * What the adapter could not learn. Surfaced so an operator can see exactly
 * how much of the gate is running on inference.
 */
export function adaptationGaps(schema: ToolSchema): string[] {
  const gaps: string[] = [];
  if (!schema.declaredEffects || schema.declaredEffects.length === 0) {
    gaps.push('No declared effects — every effect is inferred from tool text and parameter names.');
  }
  const roled = Object.entries(schema.parameters).filter(([, p]) => p.role);
  const unconfined = roled.filter(([, p]) => !p.confinedTo);
  if (unconfined.length > 0) {
    gaps.push(
      `No boundary declared for: ${unconfined.map(([n]) => n).join(', ')} — confinement cannot be checked.`,
    );
  }
  const unroled = Object.entries(schema.parameters).filter(([, p]) => !p.role);
  if (unroled.length > 0) {
    gaps.push(`No role inferred for: ${unroled.map(([n]) => n).join(', ')} — treated as opaque data.`);
  }
  return gaps;
}
