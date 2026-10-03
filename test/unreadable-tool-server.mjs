// A server with a tool the lexical deriver cannot read: its name uses no verb the
// vocabulary knows, its one parameter has no role, and it sends no annotation. The
// only way to know it deletes is an operator who has read it — i.e. a manifest.
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'get_status', description: 'Return the current status.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } } } },
  { name: 'terminate_instance', description: 'Operate on the given instance.',
    inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'] } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `EXECUTED ${msg.params.name}` }] } });
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
