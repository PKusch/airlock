/**
 * A starting point for a manifest. The operator still has to read each tool.
 *
 * Tools the deriver does not recognise are written with the placeholder effect
 * "TODO", which `parseManifest` refuses, so an unedited draft can never be loaded
 * and mistaken for a review. Tools it does recognise carry the effects it already
 * infers, so the person reviewing sees what the gate thinks and adds what is missing.
 */
import { deriveFacts } from '../core/derive.ts';
import { adaptMcpTool, withoutAnnotations, type McpToolDefinition } from './adapt.ts';
import type { ToolCall } from '../core/types.ts';

export interface DraftEntry {
  tool: string;
  recognised: boolean;
  effects: string[];
}

/** Arguments that look ordinary, so the deriver reads the tool and not the values. */
function ordinaryArgs(def: McpToolDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(def.inputSchema?.properties ?? {})) {
    const p = prop as { type?: string; format?: string };
    if (/path|file|dir|source|destination/i.test(name)) args[name] = '/HOME/projects/a.txt';
    else if (p.format === 'uri' || /url|endpoint/i.test(name)) args[name] = 'https://docs.internal/x';
    else if (p.type === 'array') args[name] = ['x'];
    else if (p.type === 'number' || p.type === 'integer') args[name] = 1;
    else args[name] = 'x';
  }
  return args;
}

/** What the deriver makes of each tool from its name and schema alone, annotations set aside. */
export function draftEntries(tools: McpToolDefinition[]): DraftEntry[] {
  return tools.map((def) => {
    const call: ToolCall = { id: def.name, tool: def.name, args: ordinaryArgs(def) };
    const facts = deriveFacts(adaptMcpTool(withoutAnnotations(def)), call);
    const recognised = facts.recognition.status !== 'unrecognised';
    return { tool: def.name, recognised, effects: recognised ? [...facts.effects] : ['TODO'] };
  });
}

/** The draft manifest as text: unrecognised tools first, so the ones that need a person come first. */
export function draftManifest(tools: McpToolDefinition[]): string {
  const entries = draftEntries(tools).sort(
    (a, b) => Number(a.recognised) - Number(b.recognised) || a.tool.localeCompare(b.tool),
  );
  const effects: Record<string, string[]> = {};
  for (const e of entries) effects[e.tool] = e.effects;
  return JSON.stringify({ version: 1, effects }, null, 2) + '\n';
}
