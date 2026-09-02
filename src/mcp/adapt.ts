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

/** Parameter names that betray a role. Ordered — first match wins. */
const ROLE_TELLS: Array<[NonNullable<ParamSpec['role']>, RegExp]> = [
  ['secret', /^(token|secret|api[_-]?key|password|credential|auth)/i],
  ['command', /^(command|cmd|script|shell|exec|code)/i],
  ['amount', /^(amount|total|price|sum|value_cents|cost)/i],
  ['recipient', /^(to|recipient|recipients|email|address|channel|chat_id|phone)/i],
  ['url', /^(url|uri|endpoint|host|webhook|link|href)/i],
  ['glob', /^(pattern|glob|match|filter_pattern)/i],
  ['path', /(^|_)(path|file|filepath|filename|dir|directory|folder|source|destination|target)s?$/i],
];

function inferRole(name: string, prop: { description?: string; format?: string }): ParamSpec['role'] {
  for (const [role, tell] of ROLE_TELLS) {
    if (tell.test(name)) return role;
  }
  if (prop.format === 'uri' || prop.format === 'url') return 'url';
  if (prop.format === 'email') return 'recipient';
  // A description is weaker evidence than a name, so it is consulted last.
  if (prop.description && /\bglob|wildcard|pattern\b/i.test(prop.description)) return 'glob';
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
