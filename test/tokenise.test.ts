import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenise, normalisePath } from '../src/core/derive.ts';

test('tokenise splits snake, kebab, camel and dotted tool names alike', () => {
  const want = ['read', 'text', 'file'];
  for (const name of ['read_text_file', 'read-text-file', 'readTextFile', 'read.text.file', 'ReadTextFile']) {
    assert.deepEqual(tokenise(name), want, name);
  }
});

test('tokenise keeps digits with their word and drops empty pieces', () => {
  assert.deepEqual(tokenise('__list2_users--'), ['list2', 'users']);
  assert.deepEqual(tokenise(''), []);
});

test('normalisePath collapses dot segments and doubled slashes', () => {
  assert.equal(normalisePath('/a/b/../c//d/./e'), '/a/c/d/e');
});

test('normalisePath cannot climb above the root', () => {
  assert.equal(normalisePath('/../../etc/passwd'), '/etc/passwd');
});
