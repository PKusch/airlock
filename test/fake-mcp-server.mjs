// A minimal stdio MCP server. Tool definitions are shaped like the real ones:
// a name, a prose description, a JSON Schema, and for one tool the four MCP
// annotation hints, which real servers send and which the gate may only use
// to raise. The last tool's name is outside the deriver's vocabulary on
// purpose: the only thing the gate can know about it is what the server says.
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'read_text_file',
    description: 'Read the complete contents of a file from the file system.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file with new content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email message to a recipient.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', format: 'email' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'body'],
    },
  },
  {
    name: 'scrub_records',
    description: 'Scrubs the matching records from the archive.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `EXECUTED ${msg.params.name}` }] },
    });
  }
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
