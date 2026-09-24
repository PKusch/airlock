import type { EffectKind, ParamSpec, SelfDescription, ToolSchema } from '../core/types.ts';

/**
 * Adapting a real MCP tool definition into something the deriver can reason
 * about.
 *
 * The honest problem, corrected: this file used to say MCP tool definitions
 * carry no capability annotations. They do — since the 2025-03-26 revision a
 * tool may carry `annotations` with four hints (readOnlyHint, destructiveHint,
 * idempotentHint, openWorldHint), and every one of the 36 reference tools in
 * the corpus does. What is still true: there is no `declaredEffects` in the
 * deriver's vocabulary, nothing says which directory a filesystem tool stays
 * inside, and the spec says clients MUST treat the hints as untrusted unless
 * the server is. So the hints are carried as `selfDescription`: quoted,
 * allowed to raise, never allowed to lower. Everything else is still inferred
 * from a name, a description and a JSON Schema.
 */

/** One property of a JSON Schema, as far as the adapter reads it. */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  format?: string;
  items?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaProperty>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  /** MCP tool annotations. Hints, and untrusted by the spec's own wording. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: {
    type: 'object';
    properties?: Record<string, JsonSchemaProperty>;
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
  // Not routed to an effect the way `command` or `url` are — a parameter
  // named `role` is common on perfectly ordinary reads and filters, and on
  // its own it is too weak a signal. It only feeds the privilege-change
  // detector in derive.ts, which requires the tool's own name or description
  // to use a privilege verb as well. See "Privilege changes" in the README.
  ['privilege', new Set(['role', 'roles', 'permission', 'permissions', 'scope', 'scopes'])],
  ['command', new Set(['command', 'cmd', 'script', 'shell', 'exec', 'argv'])],
  ['amount', new Set(['amount', 'price', 'cost', 'total', 'fee'])],
  ['recipient', new Set(['to', 'recipient', 'recipients', 'mailto', 'addressee', 'chatid'])],
  ['url', new Set(['url', 'urls', 'uri', 'endpoint', 'webhook', 'href'])],
  ['glob', new Set(['pattern', 'patterns', 'glob', 'globs', 'wildcard'])],
  ['path', new Set(['path', 'paths', 'file', 'files', 'filepath', 'filename', 'dir', 'dirs', 'directory', 'directories', 'folder', 'source', 'destination'])],
  // Last, because it claims nothing about where or how, only about how many.
  // `name` on its own is left out: `gzip-file-as-resource.name` is an output
  // filename, and one wrong subject would count something that is not acted on.
  ['subject', new Set(['names', 'ids', 'identifiers'])],
];

/** Split `excludePatterns`, `chat_id`, `to` into lowercase tokens. */
export function tokenise(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function inferRole(name: string, prop: JsonSchemaProperty): ParamSpec['role'] {
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
  if (prop.description && /\b(?:array|list) of \w+ (?:names|ids)\b/i.test(prop.description)) return 'subject';
  return undefined;
}

/**
 * Roles for the fields inside each element of an array of objects.
 *
 * The same token rules as a top-level parameter come first, so a field called
 * `path`, `url` or `command` means what it would mean on its own, and a field
 * called `to` is still read as a recipient unless rule A applies. Then two
 * rules that only make sense inside an element. Every rule here can only add
 * a role to a field that had none before; nothing is taken away from a
 * top-level parameter.
 */
const NAMES_A_THING = /\bname of the (?:entity|entities|node|nodes|record|records|item|items)\b/i;

function inferNestedRole(name: string, prop: JsonSchemaProperty): ParamSpec['role'] {
  const tokens = tokenise(name);
  // A. `to` on its own is the one token in the vocabulary that is also the
  // ordinary word for the far end of any link. In `create_relations` it is
  // described as "The name of the entity where the relation ends", and reading
  // it as a recipient would put a message send on a knowledge-graph edit. So
  // when the schema says in words that the value names an entity or node, the
  // bare token gives way. Only the bare token: `recipient`, `mailto` and
  // `format: email` still win, and a `to` described any other way is still a
  // recipient.
  if (tokens.length === 1 && tokens[0] === 'to' && !prop.format && NAMES_A_THING.test(prop.description ?? '')) {
    return 'subject';
  }
  // B. The top-level rules, unchanged.
  const role = inferRole(name, prop);
  if (role) return role;
  // C. A field whose last word is `name` (`name`, `entityName`) inside an
  // element names that element. At top level this rule is left out, because
  // `gzip-file-as-resource.name` is an output file name and nothing is done
  // to it. Inside a list of things, a wrong reading costs a count that is too
  // high, which is the direction a consent card is allowed to err in.
  if (tokens.length > 0 && tokens[tokens.length - 1] === 'name') return 'subject';
  // D. A field the schema describes as the name of an entity or node, such as
  // `from` in a relation. Description is weaker evidence than a name, so it is
  // consulted last, and the phrase is narrow: "name of the output file" does
  // not match.
  if (NAMES_A_THING.test(prop.description ?? '')) return 'subject';
  return undefined;
}

/** The declared properties of each element, if this is an array of objects with any. */
function elementProperties(prop: JsonSchemaProperty): Record<string, JsonSchemaProperty> | undefined {
  if (prop.type !== 'array' || !prop.items || typeof prop.items !== 'object') return undefined;
  const items = prop.items as JsonSchemaProperty;
  if (items.type !== 'object' || !items.properties || Object.keys(items.properties).length === 0) return undefined;
  return items.properties;
}

/** A value that cannot carry a target, whatever it says. */
function isInert(prop: { type?: string; enum?: unknown[] }): boolean {
  return prop.type === 'number' || prop.type === 'integer' || prop.type === 'boolean' || Array.isArray(prop.enum);
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

  // A tool definition is the server's own output, and the server is exactly the
  // party this gate does not trust. A hostile or buggy one can send a missing
  // inputSchema or a null property node; neither may be allowed to throw, or the
  // call it describes would slip past the gate uninspected. An unreadable node
  // carries nothing to derive from, so it is adapted as an opaque parameter —
  // still visible to adaptationGaps — rather than dropped or crashed on.
  const schema = def.inputSchema as McpToolDefinition['inputSchema'] | null | undefined;
  const properties = (schema && typeof schema === 'object' ? schema.properties : undefined) ?? {};
  for (const [name, entry] of Object.entries(properties)) {
    const prop = entry && typeof entry === 'object' ? entry : ({} as JsonSchemaProperty);
    parameters[name] = adaptParameter(def.name, name, prop, inferRole(name, prop), options);
  }

  const selfDescription = selfDescriptionOf(def.annotations);
  return {
    name: def.name,
    description: def.description ?? '',
    // MCP has no field for effects in the deriver's vocabulary. Anything
    // supplied here came from an operator, not from the tool, and is treated
    // as a floor rather than a ceiling. The tool's own hints go elsewhere.
    declaredEffects: options.declaredEffects?.[def.name],
    ...(selfDescription ? { selfDescription } : {}),
    parameters,
  };
}

/**
 * One parameter, and the fields of its elements if it has any. `path` is the
 * name a boundary is keyed by: `edits` at top level, `edits[].newText` inside.
 */
function adaptParameter(
  tool: string,
  path: string,
  prop: JsonSchemaProperty,
  role: ParamSpec['role'],
  options: AdaptOptions,
): ParamSpec {
  const fields = role ? undefined : elementProperties(prop);
  const nested = fields
    ? Object.fromEntries(
        Object.entries(fields).map(([field, fieldProp]) => [
          field,
          adaptParameter(tool, `${path}[].${field}`, fieldProp, inferNestedRole(field, fieldProp), options),
        ]),
      )
    : undefined;
  return {
    type: mapType(prop.type),
    description: prop.description,
    ...(role ? { role } : {}),
    ...(!role && isInert(prop) ? { inert: true } : {}),
    ...(role ? confinementFor(options.confinement, tool, path) : {}),
    ...(nested ? { nested } : {}),
  };
}

/**
 * Every parameter the gate reads, with structured payloads opened up: a
 * parameter with declared element fields is replaced by those fields, named
 * `edits[].oldText`. This is what "roled, inert or opaque" is counted over.
 */
export function parameterLeaves(parameters: Record<string, ParamSpec>, prefix = ''): Array<[string, ParamSpec]> {
  const out: Array<[string, ParamSpec]> = [];
  for (const [name, spec] of Object.entries(parameters)) {
    const path = prefix ? `${prefix}[].${name}` : name;
    if (spec.nested) out.push(...parameterLeaves(spec.nested, path));
    else out.push([path, spec]);
  }
  return out;
}

/**
 * Only what the server actually wrote. The spec gives each hint a default
 * (readOnly false, destructive true, idempotent false, openWorld true), and
 * filling those in would let a server that wrote nothing "declare" that it
 * is destructive and open-world. A default is not a statement.
 */
export function selfDescriptionOf(a: McpToolDefinition['annotations']): SelfDescription | undefined {
  if (!a) return undefined;
  const s: SelfDescription = {};
  if (typeof a.readOnlyHint === 'boolean') s.readOnly = a.readOnlyHint;
  if (typeof a.destructiveHint === 'boolean') s.destructive = a.destructiveHint;
  if (typeof a.idempotentHint === 'boolean') s.idempotent = a.idempotentHint;
  if (typeof a.openWorldHint === 'boolean') s.openWorld = a.openWorldHint;
  return Object.keys(s).length > 0 ? s : undefined;
}

/** The same definition with the server's hints removed, for measuring what they add. */
export function withoutAnnotations(def: McpToolDefinition): McpToolDefinition {
  const { annotations: _dropped, ...rest } = def;
  return rest;
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
    gaps.push(
      schema.selfDescription
        ? "No declared effects — every effect is inferred from tool text and parameter names. The server's annotations are quoted, not trusted."
        : 'No declared effects — every effect is inferred from tool text and parameter names, and the server sent no annotations.',
    );
  }
  // Only a place can have a boundary. An amount, a command or a subject name
  // has nowhere to be confined to, so its absence of one is not a gap.
  const BOUNDABLE = new Set(['path', 'glob', 'url', 'recipient']);
  const leaves = parameterLeaves(schema.parameters);
  const roled = leaves.filter(([, p]) => p.role && BOUNDABLE.has(p.role));
  const unconfined = roled.filter(([, p]) => !p.confinedTo);
  if (unconfined.length > 0) {
    gaps.push(
      `No boundary declared for: ${unconfined.map(([n]) => n).join(', ')} — confinement cannot be checked.`,
    );
  }
  // Two kinds of parameter get no role, and only one of them is a gap. A
  // number, a boolean or a fixed choice cannot smuggle a path or a destination;
  // free text can. A structured payload whose fields are declared is not
  // listed as a whole any more, because the gate reads its fields; the fields
  // it still cannot place are listed by name. What is left is scanned for text
  // addressed to a model, but no path, destination or name is found in it.
  const opaque = leaves.filter(([, p]) => !p.role && !p.inert);
  if (opaque.length > 0) {
    gaps.push(
      `No role inferred for: ${opaque.map(([n]) => n).join(', ')} — treated as opaque data. It is scanned for text addressed to a model, and nothing it points at is checked.`,
    );
  }
  return gaps;
}
