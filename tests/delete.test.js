import test from 'node:test';
import assert from 'node:assert/strict';
import { openWithStats, close } from '../src/index.js';
import { tempJsonPath, sample } from './helpers.js';

test('delete removes a key from an object proxy', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  delete data.title;
  assert.equal('title' in data, false);
  assert.equal(data.title, undefined);
  close(db);
});

test('deleteById removes a flat-array row and shrinks length', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);

  const ok = data.users.deleteById(2);
  assert.equal(ok, true);
  assert.equal(data.users.length, 2);
  assert.equal(data.users.findById(2), undefined);
  assert.deepEqual([...data.users].map((u) => u.id), [1, 3]);

  close(db);
});

test('deleteById is a no-op for an unknown id', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);

  const ok = data.users.deleteById(999);
  assert.equal(ok, false);
  assert.equal(data.users.length, 3);

  close(db);
});

test('flat-array deletes survive close/reopen', () => {
  const file = tempJsonPath(sample);
  const first = openWithStats(file);
  first.data.users.deleteById(3);
  close(first.db);

  const second = openWithStats(file);
  assert.equal(second.data.users.length, 2);
  assert.equal(second.data.users.findById(3), undefined);
  close(second.db);
});
