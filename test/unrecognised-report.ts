/**
 * `npm run unrecognised` — what the verb vocabulary misses, measured on tools
 * named the way ordinary API authors name things.
 */
import { readFileSync } from 'node:fs';

import { deriveFacts, tokenise } from '../src/core/derive.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import type { EffectKind, ToolCall } from '../src/core/types.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

interface Labelled extends McpToolDefinition {
  effect: EffectKind | null;
  expected: 'caught' | 'unrecognised';
}

const { tools }: { tools: Labelled[] } = JSON.parse(
  readFileSync(new URL('../corpus/unrecognised-verbs.json', import.meta.url), 'utf8'),
);

function benignArgs(def: McpToolDefinition): Record<string, unknown> {
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

const consequential = tools.filter((t) => t.effect !== null);
const harmless = tools.filter((t) => t.effect === null);
const caught: string[] = [];
const missed: string[] = [];

console.log(`\n${BOLD}${tools.length} tools whose leading verb the vocabulary does not know${OFF} ${DIM}(${consequential.length} consequential, ${harmless.length} harmless)${OFF}\n`);

for (const def of tools) {
  const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
  const facts = deriveFacts(adaptMcpTool(def), call);
  const unrecognised = facts.recognition.status === 'unrecognised';
  const hit = def.effect !== null && facts.effects.includes(def.effect);
  if (def.effect !== null) (hit ? caught : missed).push(def.name);

  const mark = def.effect === null
    ? `${DIM}harmless ${OFF}`
    : hit ? `${GREEN}caught   ${OFF}` : `${RED}missed   ${OFF}`;
  const evidence = facts.effectEvidence.map((e) => `${e.effect}←"${e.matched}" (${e.source})`).join('  ');
  console.log(
    `  ${mark} ${def.name.padEnd(24)} ${DIM}${tokenise(def.name)[0].padEnd(10)}${OFF} ` +
      `${(def.effect ?? '—').padEnd(17)} ${unrecognised ? `${YELLOW}${facts.severity} · unrecognised${OFF}` : `${facts.severity} · ${evidence}`}`,
  );
}

console.log(`\n${BOLD}Consequential tools caught anyway${OFF}  ${caught.length}/${consequential.length} ${DIM}(by a description phrase or a parameter role)${OFF}`);
console.log(`${BOLD}Missed${OFF}                            ${RED}${missed.length}/${consequential.length}${OFF} ${DIM}— now reported as unrecognised rather than scored as harmless${OFF}\n`);
