// A server that is more forgiving than JSON.parse, the way real ones can be: it
// accepts a JSON-RPC batch (an array of requests) and tolerates trailing commas.
// A gate that only inspects what *it* can parse as a single request leaves both
// as ways to reach this server unjudged.
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'read_text_file', description: 'Read the complete contents of a file from the file system.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function parseLeniently(line) {
  try { return JSON.parse(line); } catch { /* fall through */ }
  return JSON.parse(line.replace(/,\s*([}\]])/g, '$1'));   // tolerate trailing commas
}
function handle(msg) {
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `EXECUTED ${msg.params.name} ${JSON.stringify(msg.params.arguments)}` }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = parseLeniently(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
});
