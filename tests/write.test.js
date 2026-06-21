import test from 'node:test';
import assert from 'node:assert/strict';
import { openWithStats, close } from '../src/index.js';
import { tempJsonPath, sample } from './helpers.js';

test('writes persist through the proxy and survive close/reopen', () => {
  const file = tempJsonPath(sample);
  const first = openWithStats(file);
  first.data.nested.x = 99;
  first.data.newKey = 'added';
  close(first.db);

  const second = openWithStats(file);
  assert.equal(second.data.nested.x, 99);
  assert.equal(second.data.newKey, 'added');
  close(second.db);
});

test('updateById patches a flat-array row in place', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);

  const ok = data.users.updateById(2, { name: 'Bobby', age: 26 });
  assert.equal(ok, true);
  assert.deepEqual(data.users.findById(2), { id: 2, name: 'Bobby', age: 26, meta: { vip: false } });
  assert.equal(data.users.length, 3);

  close(db);
});

test('updateById is a no-op for an unknown id', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);

  const ok = data.users.updateById(999, { name: 'Nobody' });
  assert.equal(ok, false);
  assert.equal(data.users.findById(999), undefined);

  close(db);
});

test('flat-array updates survive close/reopen', () => {
  const file = tempJsonPath(sample);
  const first = openWithStats(file);
  first.data.users.updateById(1, { name: 'Alicia' });
  close(first.db);

  const second = openWithStats(file);
  assert.deepEqual(second.data.users.findById(1), { id: 1, name: 'Alicia', age: 30, meta: { vip: true } });
  close(second.db);
});
