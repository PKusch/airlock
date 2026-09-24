/**
 * airlock -- <command to start an MCP server>
 *
 * Wraps a stdio MCP server so every tools/call passes the gate first.
 */
import { startProxy } from './proxy.ts';
import { nodeResolver } from '../core/resolver.node.ts';
import { parseCli, USAGE } from './args.ts';

const parsed = parseCli(process.argv.slice(2), process.env);

if (parsed.kind === 'help') {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(parsed.message);
  process.exit(2);
}

// Operator-asserted boundaries. The tools cannot declare these themselves, so
// anything not named here is checked without a confinement and says so.
startProxy(parsed.command, parsed.args, { resolver: nodeResolver, confinement: parsed.confinement });
