import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { adaptMcpTool, adaptationGaps, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { gate } from '../src/mcp/gate.ts';
import { deriveFacts } from '../src/core/derive.ts';
import { SEVERITY } from '../src/core/types.ts';
import { BENIGN_CALLS, BENIGN_TOOLS } from '../src/fixtures/benign.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ---------------------------------------------------------------------------
// Adapting definitions that carry no capability information at all.
// ---------------------------------------------------------------------------

const READ_FILE: McpToolDefinition = {
  name: 'read_text_file',
  description: 'Read the complete contents of a file from the file system.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const SEND_EMAIL: McpToolDefinition = {
  name: 'send_email',
  description: 'Send an email message to a recipient.',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string', format: 'email' }, body: { type: 'string' } },
  },
};

test('roles are inferred from parameter names and formats', () => {
  assert.equal(adaptMcpTool(READ_FILE).parameters.path.role, 'path');
  assert.equal(adaptMcpTool(SEND_EMAIL).parameters.to.role, 'recipient');
  assert.equal(adaptMcpTool(SEND_EMAIL).parameters.body.role, undefined, 'opaque data stays opaque');
});

test('the adapter reports what it could not learn', () => {
  const gaps = adaptationGaps(adaptMcpTool(READ_FILE));
  assert.ok(gaps.some((g) => g.includes('No declared effects')));
  assert.ok(gaps.some((g) => g.includes('No boundary declared')));
});

test('an operator-supplied boundary is honoured, and closes the gap', () => {
  const schema = adaptMcpTool(READ_FILE, { confinement: { '*.path': '/HOME/projects' } });
  assert.equal(schema.parameters.path.confinedTo, '/HOME/projects');
  assert.ok(!adaptationGaps(schema).some((g) => g.includes('No boundary declared')));
});

test('gating a real-shaped MCP call surfaces the escape', async () => {
  const decision = await gate(
    READ_FILE,
    { id: 'm1', tool: 'read_text_file', args: { path: '/HOME/projects/../.ssh/id_rsa' } },
    { confinement: { '*.path': '/HOME/projects' } },
  );
  assert.equal(decision.facts.severity, 'critical');
  assert.equal(decision.requiresApproval, true);
  assert.ok(decision.consent.rawCall.args.path);
});

// ---------------------------------------------------------------------------
// End to end, through an actual child process over actual stdio.
// ---------------------------------------------------------------------------

function driveProxy(requests: object[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const proxy = spawn(
      process.execPath,
      ['--experimental-strip-types', join(root, 'src/mcp/cli.ts'), '--', process.execPath, join(here, 'fake-mcp-server.mjs')],
      { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, AIRLOCK_CONFINE: '*.path=/HOME/projects' } },
    );

    const received: any[] = [];
    const timer = setTimeout(() => {
      proxy.kill();
      reject(new Error(`timed out with ${received.length}/${requests.length} responses`));
    }, 15000);

    createInterface({ input: proxy.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      received.push(JSON.parse(line));
      if (received.length === requests.length) {
        clearTimeout(timer);
        proxy.kill();
        resolve(received);
      }
    });

    // Sent in order; the proxy must learn tools/list before the calls land.
    for (const r of requests) proxy.stdin.write(JSON.stringify(r) + '\n');
  });
}

test('the proxy forwards ordinary calls and withholds dangerous ones', async () => {
  const responses = await driveProxy([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: '/HOME/projects/README.md' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: '/HOME/projects/../.ssh/id_rsa' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } },
  ]);

  const byId = new Map(responses.map((r) => [r.id, r]));

  assert.ok(byId.get(1).result.tools.length > 0, 'tools/list passes through');

  const ordinary = byId.get(2);
  assert.equal(ordinary.error, undefined, 'an ordinary read is not interrupted');
  assert.match(ordinary.result.content[0].text, /EXECUTED read_text_file/);

  const dangerous = byId.get(3);
  assert.ok(dangerous.error, 'the escape was withheld');
  assert.match(dangerous.error.message, /Airlock withheld/);
  assert.match(dangerous.error.message, /CRITICAL/);
  assert.equal(dangerous.error.data.severity, 'critical');
  assert.ok(!('result' in dangerous), 'and never reached the server');

  const unknown = byId.get(4);
  assert.ok(unknown.error, 'a tool we never saw declared is refused');
  assert.match(unknown.error.message, /no tool definition/);
});


// ---------------------------------------------------------------------------
// Absence of a declaration channel is not absence of a declaration.
// ---------------------------------------------------------------------------

test('no declaration channel does not count against a tool', () => {
  // Regression: MCP has no field for effects, so every adapted tool looked as
  // though it were concealing one. That escalated everything and swamped the
  // signal the check exists to carry.
  const noChannel = adaptMcpTool(SEND_EMAIL); // declaredEffects: undefined
  const declaredNothing = { ...noChannel, declaredEffects: [] };
  const call = { id: 'd1', tool: 'send_email', args: { to: 'x@example.com', body: 'hi' } };

  const a = deriveFacts(noChannel, call);
  const b = deriveFacts(declaredNothing, call);

  assert.ok(!a.signals.some((s) => s.code === 'undeclared_effect'), 'nothing could be declared');
  assert.ok(b.signals.some((s) => s.code === 'undeclared_effect'), 'but this tool chose not to');
  assert.ok(SEVERITY[b.severity] >= SEVERITY[a.severity], 'declining to declare is evidence');
});

test('asserted boundaries bring the MCP alarm rate to zero on ordinary calls', () => {
  // The deployment finding: MCP publishes no boundaries, so an operator has to
  // assert them. Without that assertion the gate interrupts ordinary work.
  const confinement = {
    '*.path': '/HOME/projects',
    '*.url': 'docs.internal',
    '*.endpoint': 'api.weather.example',
  };

  const fired = (c: Record<string, string> | undefined) =>
    BENIGN_CALLS.filter((call) => {
      const tool = BENIGN_TOOLS[call.tool];
      const schema = adaptMcpTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(Object.keys(tool.parameters).map((n) => [n, { type: 'string' }])),
          },
        },
        { confinement: c },
      );
      return SEVERITY[deriveFacts(schema, call).severity] >= SEVERITY.high;
    }).length;

  assert.ok(fired(undefined) > 0, 'unasserted, the gate interrupts ordinary work');
  assert.equal(fired(confinement), 0, 'asserted, it does not');
});
