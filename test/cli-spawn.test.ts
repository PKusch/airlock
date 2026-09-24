import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a server command that does not exist gets one line and exit 127, not a stack trace', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'src/mcp/cli.ts'), '--', '/nonexistent/airlock-test-server'], { encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /airlock: could not start '\/nonexistent\/airlock-test-server'/);
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event|at .*node:/);
});
