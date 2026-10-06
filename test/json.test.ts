import { test } from 'node:test';
import assert from 'node:assert/strict';

import { duplicateKeys, rawId } from '../src/mcp/json.ts';

test('a big integer id is read as written, where JSON.parse would round it', () => {
  const text = '{"jsonrpc":"2.0","id":1234567890123456789,"method":"tools/call"}';
  assert.equal(rawId(text), '1234567890123456789');
  assert.notEqual(String(JSON.parse(text).id), '1234567890123456789', 'JSON.parse really does change it');
});

test('every kind of id comes back byte for byte', () => {
  assert.equal(rawId('{"id":7}'), '7');
  assert.equal(rawId('{"id": 7 }'), '7');
  assert.equal(rawId('{"id":"abc"}'), '"abc"');
  assert.equal(rawId('{"id":"a\\"b"}'), '"a\\"b"', 'an escaped quote does not end the string');
  assert.equal(rawId('{"id":1.5e3}'), '1.5e3');
  assert.equal(rawId('{"id":null}'), 'null');
  assert.equal(rawId('{"jsonrpc":"2.0","method":"x","id":42}'), '42', 'wherever it sits in the object');
});

test('only the top-level id counts, never one inside params or a string value', () => {
  assert.equal(rawId('{"params":{"id":99},"id":1}'), '1');
  assert.equal(rawId('{"params":{"id":99}}'), undefined);
  assert.equal(rawId('{"note":"\\"id\\": 5","id":2}'), '2', 'a key-looking string value is not a key');
  assert.equal(rawId('{"items":[{"id":5}],"id":3}'), '3');
});

test('no id, or one that is not a valid id, is undefined', () => {
  assert.equal(rawId('{"method":"x"}'), undefined);
  assert.equal(rawId('{"id":{"a":1}}'), undefined);
  assert.equal(rawId('{"id":[1]}'), undefined);
});

test('duplicateKeys still lives here and behaves as before', () => {
  assert.deepEqual(duplicateKeys('{"a":1,"a":2}'), ['a']);
  assert.deepEqual(duplicateKeys('{"x":{"a":1},"y":{"a":2}}'), []);
});
