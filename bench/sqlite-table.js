// json-mach's own cache is now LMDB-backed (see src/cache.js), but the
// benchmark still wants a "raw SQLite" comparison column. This is a small,
// self-contained SQLite table builder used only by bench/server.js - it has
// no relationship to json-mach's storage format anymore.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const TABLE = 'users';

function columnInfo(values) {
  let sawNumber = false;
  let sawBoolean = false;
  let sawObject = false;
  let sawString = false;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number') sawNumber = true;
    else if (typeof v === 'boolean') sawBoolean = true;
    else if (typeof v === 'string') sawString = true;
    else sawObject = true;
  }
  if (sawObject) return { type: 'TEXT', json: true, boolean: false };
  if (sawBoolean && !sawNumber && !sawString) return { type: 'INTEGER', json: false, boolean: true };
  if (sawNumber && !sawString) return { type: 'REAL', json: false, boolean: false };
  return { type: 'TEXT', json: false, boolean: false };
}

function inferColumns(elements, sampleSize) {
  const sample = elements.slice(0, sampleSize);
  const keys = new Set();
  for (const el of sample) for (const k of Object.keys(el)) keys.add(k);
  const columns = new Map();
  for (const key of keys) columns.set(key, columnInfo(sample.map((el) => el[key])));
  return columns;
}

function encodeColumnValue(value, info) {
  if (value === undefined || value === null) return null;
  if (info.json) return JSON.stringify(value);
  if (info.boolean) return value ? 1 : 0;
  return value;
}

/** Builds a single `users` table from the JSON's `users` array, indexed on `id`. */
export function buildSqliteTable(jsonPath, dbPath, { sampleSize = 200, indexFields = ['id'] } = {}) {
  const { users } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const columns = inferColumns(users, sampleSize);

  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const colDefs = [...columns.entries()].map(([name, info]) => `"${name}" ${info.type}`).join(', ');
    db.exec(`CREATE TABLE ${TABLE} (_idx INTEGER PRIMARY KEY, ${colDefs})`);
    for (const field of indexFields) {
      if (columns.has(field)) db.exec(`CREATE INDEX idx_${TABLE}_${field} ON ${TABLE}("${field}")`);
    }

    const colNames = [...columns.keys()];
    const placeholders = colNames.map(() => '?').join(', ');
    const stmt = db.prepare(
      `INSERT INTO ${TABLE} (_idx, ${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${placeholders})`,
    );
    db.exec('BEGIN');
    users.forEach((el, idx) => {
      const row = colNames.map((name) => encodeColumnValue(el[name], columns.get(name)));
      stmt.run(idx, ...row);
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

export function isSqliteTableValid(jsonPath, dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  const src = fs.statSync(jsonPath);
  const cache = fs.statSync(dbPath);
  return cache.mtimeMs >= src.mtimeMs;
}

export const SQLITE_TABLE = TABLE;
