/**
 * `npm run unrecognised` — what the verb vocabulary misses, measured on tools
 * named the way ordinary API authors name things.
 *
 * Two corpora. The first was written before the vocabulary was extended and
 * the extension was written against it, so it can only show that the words it
 * contains are now known. The second was held out: written in the same
 * sitting, from a different prompt, and not checked against the vocabulary.
 * Its number is the estimate of what the extension bought.
 */
import { readFileSync } from 'node:fs';

import { deriveFacts, tokenise } from '../src/core/derive.ts';
import { adaptMcpTool, withoutAnnotations, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { SEVERITY } from '../src/core/types.ts';
import type { EffectKind, ToolCall } from '../src/core/types.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

interface Labelled extends McpToolDefinition {
  effect: EffectKind | null;
}

export type Outcome = 'caught' | 'under-read' | 'unrecognised' | 'harmless';

export function benignArgs(def: McpToolDefinition): Record<string, unknown> {
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

/**
 * caught      — the labelled effect is among those inferred
 * under-read  — something was inferred, but not the labelled effect; the
 *               deriver thinks it knows, and knows too little, which is the
 *               understating direction the whole gate exists to prevent
 * unrecognised — nothing inferred; reported to the person as unknown
 */
export function outcome(def: Labelled): Outcome {
  const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
  const facts = deriveFacts(adaptMcpTool(withoutAnnotations(def)), call);
  if (def.effect === null) return 'harmless';
  if (facts.recognition.status === 'unrecognised') return 'unrecognised';
  return facts.effects.includes(def.effect) ? 'caught' : 'under-read';
}

function report(title: string, file: string) {
  const { tools }: { tools: Labelled[] } = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const consequential = tools.filter((t) => t.effect !== null);
  const harmless = tools.filter((t) => t.effect === null);
  const tally: Record<Outcome, number> = { caught: 0, 'under-read': 0, unrecognised: 0, harmless: 0 };

  console.log(`\n${BOLD}${title}${OFF} ${DIM}(${consequential.length} consequential, ${harmless.length} harmless)${OFF}\n`);
  for (const def of tools) {
    const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
    const facts = deriveFacts(adaptMcpTool(withoutAnnotations(def)), call);
    const o = outcome(def);
    tally[o] += 1;
    const mark =
      o === 'harmless' ? `${DIM}harmless    ${OFF}`
      : o === 'caught' ? `${GREEN}caught      ${OFF}`
      : o === 'under-read' ? `${YELLOW}under-read  ${OFF}`
      : `${RED}unrecognised${OFF}`;
    const evidence = facts.effectEvidence.map((e) => `${e.effect}←"${e.matched}" (${e.source})`).join('  ');
    console.log(
      `  ${mark} ${def.name.padEnd(24)} ${DIM}${tokenise(def.name)[0].padEnd(11)}${OFF} ` +
        `${(def.effect ?? '—').padEnd(17)} ${facts.recognition.status === 'unrecognised' ? `${YELLOW}${facts.severity} · unrecognised${OFF}` : `${facts.severity} · ${evidence}`}`,
    );
  }
  const n = consequential.length;
  console.log(`\n  ${BOLD}caught${OFF} ${GREEN}${tally.caught}/${n}${OFF}   ${BOLD}under-read${OFF} ${YELLOW}${tally['under-read']}/${n}${OFF}   ${BOLD}unrecognised${OFF} ${RED}${tally.unrecognised}/${n}${OFF}` +
    `   ${DIM}harmless still unrecognised: ${harmless.filter((t) => {
      const call: ToolCall = { id: t.name, tool: t.name, args: benignArgs(t) };
      return deriveFacts(adaptMcpTool(t), call).recognition.status === 'unrecognised';
    }).length}/${harmless.length}${OFF}`);
}

/**
 * What the server's own hints add. Same corpus, same calls, with and without
 * the MCP annotations each tool's author would honestly have written. The
 * hints can only raise, so the interesting numbers are how many consequential
 * tools reach the alarm threshold that did not before, and how many harmless
 * ones are dragged up with them.
 */
export function hintsReport(tools: Labelled[]): { alarmedBefore: number; alarmedAfter: number; harmlessRaised: number; contradictions: string[] } {
  const consequential = tools.filter((t) => t.effect !== null);
  const harmless = tools.filter((t) => t.effect === null);
  const sev = (def: McpToolDefinition) => {
    const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
    return deriveFacts(adaptMcpTool(def), call);
  };
  const alarms = (def: McpToolDefinition) => SEVERITY[sev(def).severity] >= SEVERITY.high;
  return {
    alarmedBefore: consequential.filter((t) => alarms(withoutAnnotations(t))).length,
    alarmedAfter: consequential.filter((t) => alarms(t)).length,
    harmlessRaised: harmless.filter((t) => alarms(t) && !alarms(withoutAnnotations(t))).length,
    contradictions: tools.filter((t) => sev(t).signals.some((s) => s.code === 'self_description_contradicted')).map((t) => t.name),
  };
}

function reportHints(title: string, file: string) {
  const { tools }: { tools: Labelled[] } = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  console.log(`
${BOLD}${title}${OFF}
`);
  for (const def of tools) {
    const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
    const before = deriveFacts(adaptMcpTool(withoutAnnotations(def)), call);
    const after = deriveFacts(adaptMcpTool(def), call);
    const a = def.annotations ?? {};
    const hints = [a.readOnlyHint ? 'read-only' : null, a.destructiveHint ? 'destructive' : null, a.openWorldHint ? 'open-world' : null].filter(Boolean).join(', ') || 'writes, closed';
    const moved = before.severity !== after.severity;
    const alarm = SEVERITY[after.severity] >= SEVERITY.high;
    const mark = def.effect === null
      ? (alarm ? `${RED}raised   ${OFF}` : `${DIM}harmless ${OFF}`)
      : alarm ? (moved ? `${GREEN}alarms   ${OFF}` : `${DIM}alarmed  ${OFF}`) : `${YELLOW}still low${OFF}`;
    console.log(`  ${mark} ${def.name.padEnd(24)} ${DIM}${hints.padEnd(28)}${OFF} ${before.severity.padEnd(9)}→ ${after.severity}${after.signals.some((s) => s.code === 'self_description_contradicted') ? `  ${RED}contradicted${OFF}` : ''}`);
  }
  const r = hintsReport(tools);
  const n = tools.filter((t) => t.effect !== null).length;
  console.log(`
  ${BOLD}consequential at the alarm threshold${OFF}  without hints ${r.alarmedBefore}/${n}   with hints ${GREEN}${r.alarmedAfter}/${n}${OFF}   ${BOLD}harmless raised${OFF} ${r.harmlessRaised > 0 ? RED : GREEN}${r.harmlessRaised}/${tools.length - n}${OFF}`);
}

if (process.argv[1] && /unrecognised-report/.test(process.argv[1])) {
  report('First corpus — the vocabulary was extended against these words', '../corpus/unrecognised-verbs.json');
  report('Held-out corpus — written separately, not checked against the vocabulary', '../corpus/unrecognised-verbs-heldout.json');
  reportHints("Held-out corpus with the server's own hints — what the annotations add", '../corpus/unrecognised-verbs-heldout.json');
  console.log();
}
