/**
 * airlock -- <command to start an MCP server>
 *
 * Wraps a stdio MCP server so every tools/call passes the gate first.
 */
import { startProxy } from './proxy.ts';
import { nodeResolver } from '../core/resolver.node.ts';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const target = sep === -1 ? argv : argv.slice(sep + 1);

if (target.length === 0) {
  console.error('usage: airlock -- <command> [args...]');
  process.exit(2);
}

// Operator-asserted boundaries. The tools cannot declare these themselves, so
// anything not named here is checked without a confinement and says so.
const confinement: Record<string, string> = {};
for (const pair of (process.env.AIRLOCK_CONFINE ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split('=');
  if (key && value) confinement[key.trim()] = value.trim();
}

startProxy(target[0], target.slice(1), { resolver: nodeResolver, confinement });
