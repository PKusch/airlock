/**
 * airlock [--manifest <file> [--manifest-sha <hex>]] -- <command to start an MCP server>
 *
 * Wraps a stdio MCP server so every tools/call passes the gate first.
 */
import { readFileSync } from 'node:fs';

import { startProxy } from './proxy.ts';
import { nodeResolver } from '../core/resolver.node.ts';
import { parseCli, USAGE } from './args.ts';
import { parseManifest, manifestSha, type Manifest } from './manifest.ts';

const parsed = parseCli(process.argv.slice(2), process.env);

if (parsed.kind === 'help') {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(parsed.message);
  process.exit(2);
}

/** Load the manifest, verify it against the pinned sha, and fail closed on any doubt. */
function loadManifest(path: string, expectedSha?: string): Manifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`airlock: cannot read manifest '${path}': ${(e as Error).message}`);
    process.exit(2);
  }
  // Integrity first: a manifest that is not the one the operator reviewed must
  // not steer the gate, even to parse it. A mismatch is more likely a swap than
  // a typo, so it stops the proxy rather than warning.
  if (expectedSha !== undefined) {
    const actual = manifestSha(text);
    if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
      console.error(`airlock: manifest '${path}' does not match --manifest-sha`);
      console.error(`  expected ${expectedSha}`);
      console.error(`  actual   ${actual}`);
      process.exit(2);
    }
  } else {
    console.error(`airlock: manifest '${path}' is used but unverified (no --manifest-sha). Its sha256 is:`);
    console.error(`  ${manifestSha(text)}`);
  }
  const result = parseManifest(text);
  if (!result.ok) {
    console.error(`airlock: manifest '${path}': ${result.error}`);
    process.exit(2);
  }
  return result.manifest;
}

const manifest = parsed.manifestPath ? loadManifest(parsed.manifestPath, parsed.manifestSha) : undefined;

// The reviewed manifest wins on a shared boundary key: AIRLOCK_CONFINE is an
// ad-hoc override, the manifest is the thing someone read and pinned.
const confinement = { ...parsed.confinement, ...(manifest?.confinement ?? {}) };

startProxy(parsed.command, parsed.args, {
  resolver: nodeResolver,
  confinement,
  declaredEffects: manifest?.declaredEffects,
});
