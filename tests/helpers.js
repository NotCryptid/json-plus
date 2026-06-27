import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempJsonPath(data) {
  const file = path.join(os.tmpdir(), `json-mach-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

export const sample = {
  title: 'demo',
  active: true,
  empty: null,
  tags: ['a', 'b', 'c'],
  nested: { x: 1, y: { z: 2 } },
  users: [
    { id: 1, name: 'Alice', age: 30, meta: { vip: true } },
    { id: 2, name: 'Bob', age: 25, meta: { vip: false } },
    { id: 3, name: 'Carol', age: 40, meta: { vip: true } },
  ],
};
