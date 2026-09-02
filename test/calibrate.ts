/**
 * `npm run calibrate` — how loud is the gate on an ordinary day?
 *
 * A benign call rendering `high` or `critical` is a false alarm: those are the
 * levels that mean "stop and read". `moderate` and below are informational and
 * are not counted against the gate.
 */
import { deriveFacts } from '../src/core/derive.ts';
import { SEVERITY, type SeverityName } from '../src/core/types.ts';
import { BENIGN_CALLS, BENIGN_TOOLS } from '../src/fixtures/benign.ts';
import { SCENARIOS } from '../src/fixtures/calls.ts';
import { TOOLS } from '../src/fixtures/tools.ts';
import { adaptMcpTool, type McpToolDefinition } from '../src/mcp/adapt.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const OFF = '\x1b[0m';

const ALARM = SEVERITY.high; // at or above this, the gate demands attention

const tally: Record<SeverityName, number> = { none: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const falseAlarms: Array<{ id: string; tool: string; severity: SeverityName; why: string[] }> = [];

for (const call of BENIGN_CALLS) {
  const facts = deriveFacts(BENIGN_TOOLS[call.tool], call);
  tally[facts.severity]++;
  if (SEVERITY[facts.severity] >= ALARM) {
    falseAlarms.push({
      id: call.id,
      tool: call.tool,
      severity: facts.severity,
      why: facts.signals.map((s) => `${s.code}:${s.source}`),
    });
  }
}

// The adversarial set is the other half of the measurement: a gate that never
// false-alarms because it never fires at all is not an improvement.
const dangerous = SCENARIOS.filter((s) => s.dangerous);
let caught = 0;
const missed: string[] = [];
for (const scenario of dangerous) {
  const facts = deriveFacts(TOOLS[scenario.call.tool], scenario.call);
  if (SEVERITY[facts.severity] >= ALARM) caught++;
  else missed.push(`${scenario.id} (${facts.severity})`);
}

const rate = (falseAlarms.length / BENIGN_CALLS.length) * 100;

console.log(`\n${BOLD}Benign corpus — ${BENIGN_CALLS.length} ordinary calls${OFF}`);
for (const level of Object.keys(tally) as SeverityName[]) {
  const n = tally[level];
  const bar = '█'.repeat(n);
  const colour = SEVERITY[level] >= ALARM ? RED : GREEN;
  console.log(`  ${level.padEnd(9)} ${colour}${bar}${OFF} ${DIM}${n}${OFF}`);
}

console.log(
  `\n${BOLD}False alarm rate${OFF}  ${rate > 20 ? RED : GREEN}${rate.toFixed(0)}%${OFF} ` +
    `${DIM}(${falseAlarms.length}/${BENIGN_CALLS.length} benign calls demanded attention)${OFF}`,
);
console.log(
  `${BOLD}Adversarial recall${OFF} ${caught === dangerous.length ? GREEN : RED}${caught}/${dangerous.length}${OFF} ` +
    `${DIM}(dangerous calls that reached the alarm threshold)${OFF}\n`,
);

if (missed.length > 0) console.log(`${RED}Missed:${OFF} ${missed.join(', ')}\n`);

if (falseAlarms.length > 0) {
  console.log(`${DIM}Benign calls that fired:${OFF}`);
  for (const f of falseAlarms) {
    console.log(`  ${RED}${f.severity.padEnd(8)}${OFF} ${f.tool.padEnd(16)} ${DIM}${f.why.join(' ') || '(no signal — ladder alone)'}${OFF}`);
  }
  console.log('');
}


// ---------------------------------------------------------------------------
// The same corpus, stripped to what an MCP server actually publishes: a name,
// a description and a JSON Schema. No declared effects, no confinement. This
// is the number that matters for a real deployment.
// ---------------------------------------------------------------------------

function asMcpDefinition(tool: (typeof BENIGN_TOOLS)[string]): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([n, p]) => [n, { type: 'string', description: p.description }]),
      ),
    },
  };
}

function measure(label: string, confinement: Record<string, string> | undefined) {
  let fired = 0;
  const offenders = new Map<string, SeverityName>();
  for (const call of BENIGN_CALLS) {
    const schema = adaptMcpTool(asMcpDefinition(BENIGN_TOOLS[call.tool]), { confinement });
    const facts = deriveFacts(schema, call);
    if (SEVERITY[facts.severity] >= ALARM) {
      fired++;
      offenders.set(call.tool, facts.severity);
    }
  }
  const pct = (fired / BENIGN_CALLS.length) * 100;
  console.log(
    `  ${label.padEnd(34)} ${pct > 20 ? RED : GREEN}${String(Math.round(pct)).padStart(3)}%${OFF} ` +
      `${DIM}(${fired}/${BENIGN_CALLS.length})${OFF}` +
      (offenders.size > 0 ? `${DIM}  ← ${[...offenders.keys()].join(', ')}${OFF}` : ''),
  );
}

console.log(`${BOLD}Under real MCP conditions${OFF} ${DIM}(no declared effects, no declared boundaries)${OFF}`);
measure('as published, nothing asserted', undefined);
measure('operator asserts path boundaries', { '*.path': '/HOME/projects' });
measure('…plus url boundaries', { '*.path': '/HOME/projects', '*.url': 'docs.internal', '*.endpoint': 'api.weather.example' });
console.log('');
