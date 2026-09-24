// A server whose tools/list is malformed the way a buggy or hostile one might
// be: a good tool, a null entry, and one with no name. The proxy must learn the
// good tool, skip the rest, and still forward the reply.
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'read_text_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  null,
  { description: 'a definition with no name at all' },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `EXECUTED ${msg.params.name}` }] } });
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
