/**
 * Speak just enough MCP to ask a real server what tools it offers, and write
 * the definitions out as a corpus. The point is to test the adapter against
 * schemas nobody here wrote.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';

const TARGETS = [
  { id: 'filesystem', cmd: ['node', 'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', process.cwd()] },
  { id: 'memory', cmd: ['node', 'node_modules/@modelcontextprotocol/server-memory/dist/index.js'] },
  { id: 'everything', cmd: ['node', 'node_modules/@modelcontextprotocol/server-everything/dist/index.js'] },
];

function introspect({ id, cmd }) {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
    const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
    const done = (tools, note) => {
      clearTimeout(timer);
      proc.kill();
      resolve({ id, tools, note });
    };
    const timer = setTimeout(() => done([], 'timed out'), 20000);

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      }
      if (msg.id === 2) done(msg.result?.tools ?? [], msg.error ? JSON.stringify(msg.error) : null);
    });

    proc.on('error', () => done([], 'failed to start'));

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'airlock-introspect', version: '0.1.0' },
      },
    });
  });
}

const results = [];
for (const target of TARGETS) {
  const r = await introspect(target);
  console.log(`${target.id.padEnd(12)} ${String(r.tools.length).padStart(3)} tools${r.note ? '  (' + r.note + ')' : ''}`);
  results.push(r);
}

mkdirSync('corpus', { recursive: true });
writeFileSync('corpus/real-mcp-tools.json', JSON.stringify(results, null, 2));
console.log(`\nwrote corpus/real-mcp-tools.json — ${results.reduce((n, r) => n + r.tools.length, 0)} tool definitions`);
