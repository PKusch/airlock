// A server that echoes the exact line it was sent, so a test can see what the proxy
// really forwarded. It offers one ordinary tool and one path tool.
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'get_message', description: 'Read a message.', inputSchema: { type: 'object', properties: { message_id: { type: 'number' } } } },
  { name: 'read_text_file', description: 'Read the complete contents of a file from the file system.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  // answer with the id spelled exactly as it arrived (a string splice, not a re-serialisation)
  const idText = (/"id":\s*([^,}\s]+)/.exec(line) ?? [])[1] ?? 'null';
  const body = m.method === 'tools/list'
    ? { tools: TOOLS }
    : { content: [{ type: 'text', text: 'SERVER SAW: ' + line }] };
  process.stdout.write(`{"jsonrpc":"2.0","id":${idText},"result":${JSON.stringify(body)}}\n`);
});
