/**
 * `npm run audit` — the adapter against 36 tool definitions nobody here wrote,
 * pulled live from the MCP reference servers via scripts/introspect.mjs.
 *
 * The fixture corpus was authored by the same person who wrote the inference
 * rules, so it can only confirm them. This cannot.
 */
import { readFileSync } from 'node:fs';

import { deriveFacts } from '../src/core/derive.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { SEVERITY, type SeverityName, type ToolCall } from '../src/core/types.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';

const ALARM = SEVERITY.high;
const BOUNDARY = '/HOME/projects';
const CONFINEMENT = {
  '*.path': BOUNDARY,
  '*.paths': BOUNDARY,
  '*.source': BOUNDARY,
  '*.destination': BOUNDARY,
  '*.url': 'docs.internal',
};

const servers: Array<{ id: string; tools: McpToolDefinition[] }> = JSON.parse(
  readFileSync(new URL('../corpus/real-mcp-tools.json', import.meta.url), 'utf8'),
);

/**
 * Ground truth, labelled from what each tool actually does. Without it, a tool
 * that correctly alarms — `delete_entities` really does delete — is scored as
 * a false alarm, which makes the gate look far worse than it is.
 */
const EXPECTED: Set<string> = new Set(
  JSON.parse(readFileSync(new URL('../corpus/expected-alarms.json', import.meta.url), 'utf8')).shouldAlarm,
);

/** An ordinary, in-bounds argument for each parameter. Nothing adversarial. */
function benignArgs(def: McpToolDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(def.inputSchema?.properties ?? {})) {
    const p = prop as { type?: string };
    if (/path|file|dir|source|destination/i.test(name)) {
      args[name] = p.type === 'array' ? [`${BOUNDARY}/a.txt`] : `${BOUNDARY}/a.txt`;
    } else if (/url|endpoint/i.test(name)) args[name] = 'https://docs.internal/x';
    else if (p.type === 'array') args[name] = ['x'];
    else if (p.type === 'number' || p.type === 'integer') args[name] = 1;
    else if (p.type === 'boolean') args[name] = false;
    else args[name] = 'x';
  }
  return args;
}

let params = 0;
let roled = 0;
const tally: Record<SeverityName, number> = { none: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const SEVERITY_DRIVERS = new Set(['delete', 'execute', 'network_egress', 'message_send', 'spend', 'credential_access']);
const loud: Array<{
  server: string; tool: string; severity: SeverityName; effects: string[]; evidence: string[];
}> = [];
const opaque: string[] = [];

for (const server of servers) {
  for (const def of server.tools) {
    const schema = adaptMcpTool(def, { confinement: CONFINEMENT });
    const names = Object.keys(schema.parameters);
    params += names.length;
    const withRole = names.filter((n) => schema.parameters[n].role);
    roled += withRole.length;
    for (const n of names) {
      if (!schema.parameters[n].role) opaque.push(`${def.name}.${n}`);
    }

    const call: ToolCall = { id: def.name, tool: def.name, args: benignArgs(def) };
    const facts = deriveFacts(schema, call);
    tally[facts.severity]++;
    if (SEVERITY[facts.severity] >= ALARM) {
      loud.push({
        server: server.id,
        tool: def.name,
        severity: facts.severity,
        effects: facts.effects,
        evidence: facts.effectEvidence
          .filter((e) => SEVERITY_DRIVERS.has(e.effect))
          .map((e) => `${e.effect}←"${e.matched}" (${e.source})`),
      });
    }
  }
}

const total = servers.reduce((n, s) => n + s.tools.length, 0);
const truePositives = loud.filter((l) => EXPECTED.has(l.tool));
const falsePositives = loud.filter((l) => !EXPECTED.has(l.tool));
const missed = [...EXPECTED].filter((name) => !loud.some((l) => l.tool === name));
const benignTotal = total - EXPECTED.size;
const rate = (falsePositives.length / benignTotal) * 100;

console.log(`\n${BOLD}${total} real MCP tool definitions${OFF} ${DIM}(filesystem, memory, everything)${OFF}\n`);

console.log(`${BOLD}Role inference${OFF}`);
console.log(`  ${roled}/${params} parameters got a role ${DIM}(${Math.round((roled / params) * 100)}%)${OFF}`);
console.log(`  ${opaque.length} treated as opaque data\n`);

console.log(`${BOLD}Severity on ordinary, in-bounds calls${OFF}`);
for (const level of Object.keys(tally) as SeverityName[]) {
  const colour = SEVERITY[level] >= ALARM ? RED : GREEN;
  console.log(`  ${level.padEnd(9)} ${colour}${'█'.repeat(tally[level])}${OFF} ${DIM}${tally[level]}${OFF}`);
}
console.log(
  `\n${BOLD}Against labelled ground truth${OFF} ${DIM}(${EXPECTED.size} of ${total} tools warrant stopping a person)${OFF}`,
);
console.log(
  `  caught          ${truePositives.length === EXPECTED.size ? GREEN : RED}${truePositives.length}/${EXPECTED.size}${OFF}` +
    (missed.length > 0 ? ` ${RED}missed: ${missed.join(', ')}${OFF}` : ''),
);
console.log(
  `  false alarms    ${rate > 10 ? RED : rate > 3 ? YELLOW : GREEN}${falsePositives.length}/${benignTotal}${OFF} ` +
    `${DIM}(${rate.toFixed(1)}%)${OFF}\n`,
);

if (truePositives.length > 0) {
  console.log(`${DIM}Correctly stopped:${OFF}`);
  for (const l of truePositives) {
    console.log(`  ${GREEN}${l.severity.padEnd(8)}${OFF} ${(l.server + '/' + l.tool).padEnd(34)} ${DIM}${l.evidence.join('  ')}${OFF}`);
  }
  console.log('');
}
if (falsePositives.length > 0) {
  console.log(`${DIM}False alarms:${OFF}`);
  for (const l of falsePositives) {
    console.log(`  ${RED}${l.severity.padEnd(8)}${OFF} ${(l.server + '/' + l.tool).padEnd(34)} ${DIM}${l.evidence.join('  ')}${OFF}`);
  }
  console.log('');
}

console.log(`${DIM}Opaque parameters (no role inferred):${OFF}`);
console.log(`  ${DIM}${opaque.join(', ')}${OFF}\n`);
