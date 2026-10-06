import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { escapesConfinement, normalisePath } from '../src/core/derive.ts';

const ROOT = '/HOME/projects';

test('a backslash walk-out is an escape, as it is on a Windows-hosted server', () => {
  // These were judged inside the boundary: split only on "/", the whole tail was one
  // harmless-looking segment.
  for (const c of [
    '/HOME/projects/x\\..\\..\\.ssh/id_rsa',
    '/HOME/projects/a\\..\\..\\b',
    '/HOME/projects/..\\..\\etc',
    '/HOME/projects/a/b\\..\\..\\..\\c',
  ]) {
    assert.equal(escapesConfinement(c, ROOT), true, c);
  }
});

test('paths that stay inside still do, with either separator', () => {
  for (const c of ['/HOME/projects/a/b', '/HOME/projects/a\\b', '/HOME/projects\\a', '\\HOME\\projects\\a', '/HOME/projects/a\\..\\b', '~/projects/a']) {
    assert.equal(escapesConfinement(c, ROOT), false, c);
  }
});

test('normalisePath reads a backslash as a separator and keeps the result POSIX-shaped', () => {
  assert.equal(normalisePath('/HOME/projects/a\\b\\..\\c'), '/HOME/projects/a/c');
  assert.equal(normalisePath('\\HOME\\x'), '/HOME/x');
  assert.equal(normalisePath('..\\..\\etc'), '../../etc', 'a relative walk-out stays visible');
  assert.equal(normalisePath('/HOME/projects/../.ssh/id_rsa'), '/HOME/.ssh/id_rsa', 'the forward-slash behaviour is unchanged');
});

test('the check never says inside for a path that is really outside, for 40,000 generated paths', () => {
  // Deliberately heavy on backslashes and ".." (half the separators, a third of the
  // segments): a first version of this fuzz joined with a backslash so rarely that it
  // missed the bug above and gave false comfort.
  const segs = ['a', 'b', '..', '..', '..', '.', '', 'projects', 'projects-evil', '...', '..a', 'a..', '%2e%2e'];
  let seed = 20261006;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = () => segs[Math.floor(rnd() * segs.length)];
  // what the path means to a server that reads both "/" and "\\" as separators
  const reallyInside = (c: string) => {
    const r = path.posix.relative(ROOT, path.posix.resolve(c.replace(/\\/g, '/')));
    return r === '' || (r !== '..' && !r.startsWith('../') && !path.posix.isAbsolute(r));
  };
  const wrong: string[] = [];
  for (let i = 0; i < 40000; i++) {
    let c = rnd() < 0.8 ? '/HOME/projects' : '/HOME';
    const n = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < n; k++) c += (rnd() < 0.5 ? '/' : '\\\\') + pick();
    if (!escapesConfinement(c, ROOT) && !reallyInside(c)) wrong.push(c);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} paths judged inside that are outside`);
});
