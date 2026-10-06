import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The proxy lives exactly as long as the conversation. It used to run on forever when
 * the client disconnected (leaving the wrapped server running, one orphan per session)
 * and when the server died (leaving the client waiting on a dead pipe).
 */
function start(serverScript: string) {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-life-'));
  const pidFile = join(dir, 'pid');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${serverScript}`;
  const proxy = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/mcp/cli.ts'), '--', process.execPath, '-e', code],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; ms: number }>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => { proxy.kill(); reject(new Error('the proxy was still running')); }, 8000);
    proxy.on('exit', (c) => { clearTimeout(timer); resolve({ code: c, ms: Date.now() - t0 }); });
  });
  const serverPid = async () => {
    for (let i = 0; i < 60 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    return Number(readFileSync(pidFile, 'utf8'));
  };
  return { proxy, exited, serverPid, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('when the client disconnects the proxy exits, and the server it wrapped does not outlive it', async () => {
  const s = start('process.stdin.resume()');           // exits when its stdin closes
  try {
    const pid = await s.serverPid();
    assert.ok(alive(pid), 'the server is running');
    s.proxy.stdin!.end();
    const { code } = await s.exited;
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!alive(pid), 'no orphaned server is left behind');
  } finally { s.cleanup(); }
});

test('a server that ignores being told to stop is killed after a short grace', async () => {
  const s = start('process.stdin.resume(); setInterval(() => {}, 1e6)');   // never exits on its own
  try {
    const pid = await s.serverPid();
    s.proxy.stdin!.end();
    const { code, ms } = await s.exited;
    assert.notEqual(code, 0, 'being killed is a failure, not a clean exit');
    assert.ok(ms >= 1500 && ms < 6000, `killed after the grace period, not at once or never (${ms}ms)`);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!alive(pid), 'the stubborn server is gone');
  } finally { s.cleanup(); }
});

test('when the server dies the proxy follows it, with the same exit code', async () => {
  const s = start('setTimeout(() => process.exit(3), 200)');
  try {
    const { code } = await s.exited;
    assert.equal(code, 3, "the server's own exit code is passed on");
  } finally { s.cleanup(); }
});
