#!/usr/bin/env node
// Generates a large sample JSON dataset procedurally (seeded PRNG) instead
// of shipping a huge hand-written fixture.
//
// Usage: node scripts/generate-data.js [--count 200000] [--out data/sample.json] [--seed 42]

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { count: 200_000, out: 'data/sample.json', seed: 42 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
  }
  return args;
}

// mulberry32: small, fast, deterministic PRNG (no dependency needed).
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Alex', 'Jordan', 'Sam', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie', 'Drew', 'Avery'];
const LAST_NAMES = ['Stone', 'Reed', 'Hale', 'Frost', 'Vance', 'Pike', 'Marsh', 'Kane', 'Bell', 'Wren'];
const CITIES = ['Austin', 'Denver', 'Seattle', 'Boston', 'Phoenix', 'Atlanta', 'Portland', 'Raleigh'];

function makeRecord(rand, id) {
  const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
  return {
    id,
    name: `${first} ${last}`,
    email: `${first}.${last}${id}@example.com`.toLowerCase(),
    age: 18 + Math.floor(rand() * 60),
    city: CITIES[Math.floor(rand() * CITIES.length)],
    active: rand() > 0.3,
    score: Math.round(rand() * 10000) / 100,
    address: {
      street: `${1 + Math.floor(rand() * 9999)} ${last} St`,
      zip: String(10000 + Math.floor(rand() * 89999)),
    },
  };
}

function main() {
  const { count, out, seed } = parseArgs(process.argv.slice(2));
  const rand = mulberry32(seed);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stream = fs.createWriteStream(out);

  stream.write(`{"generatedAt":${JSON.stringify(new Date().toISOString())},"seed":${seed},"count":${count},"users":[`);
  for (let id = 1; id <= count; id += 1) {
    if (id > 1) stream.write(',');
    stream.write(JSON.stringify(makeRecord(rand, id)));
  }
  stream.write(']}');
  stream.end();

  stream.on('finish', () => {
    const { size } = fs.statSync(out);
    console.log(`Wrote ${count} records to ${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  });
}

main();
