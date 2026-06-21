import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithStats, close } from '../src/index.js';
import { tempJsonPath, sample } from './helpers.js';

test('reads scalars, nested objects, and arrays like plain JSON', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  assert.equal(data.title, 'demo');
  assert.equal(data.active, true);
  assert.equal(data.empty, null);
  assert.deepEqual(data.tags, ['a', 'b', 'c']);
  assert.equal(data.nested.y.z, 2);
  close(db);
});

test('flattened arrays support index access, length, and JSON-like iteration', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  assert.equal(data.users.length, 3);
  assert.deepEqual(data.users[1], { id: 2, name: 'Bob', age: 25, meta: { vip: false } });
  const names = [...data.users].map((u) => u.name);
  assert.deepEqual(names, ['Alice', 'Bob', 'Carol']);
  close(db);
});

test('findById and where use indexed/filtered SQL lookups', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  assert.deepEqual(data.users.findById(2), { id: 2, name: 'Bob', age: 25, meta: { vip: false } });
  assert.equal(data.users.findById(999), undefined);
  const vips = data.users.where('id', 1);
  assert.deepEqual(vips, [{ id: 1, name: 'Alice', age: 30, meta: { vip: true } }]);
  close(db);
});

test('JSON.stringify round-trips to the original structure', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), sample);
  close(db);
});

test('Object.keys and has work on object proxies', () => {
  const file = tempJsonPath(sample);
  const { data, db } = openWithStats(file);
  assert.deepEqual(Object.keys(data).sort(), Object.keys(sample).sort());
  assert.equal('title' in data, true);
  close(db);
});

test('cache is reused when the source file is unchanged, rebuilt when it changes', () => {
  const file = tempJsonPath(sample);
  const r1 = openWithStats(file);
  assert.equal(r1.cached, false);
  close(r1.db);

  const r2 = openWithStats(file);
  assert.equal(r2.cached, true);
  close(r2.db);

  fs.writeFileSync(file, JSON.stringify({ ...sample, title: 'changed' }));
  const r3 = openWithStats(file);
  assert.equal(r3.cached, false);
  assert.equal(r3.data.title, 'changed');
  close(r3.db);
});
