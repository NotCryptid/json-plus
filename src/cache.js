import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const SCHEMA_VERSION = '1';

const SCHEMA = `
  CREATE TABLE __meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    key TEXT,
    type TEXT NOT NULL,
    value
  );
  CREATE INDEX idx_nodes_parent_key ON nodes(parent_id, key);
`;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An array "flattens" into its own SQL table (with real columns + indexes)
// when every element is a plain object. That's the case that benefits most
// from a database: point/range lookups instead of a linear scan.
function isFlattenable(arr) {
  return arr.length > 0 && arr.every(isPlainObject);
}

// Decides the SQL column type plus how values round-trip through it:
// plain numbers/strings are stored natively, booleans as 0/1, and
// objects/arrays as JSON text that gets parsed back out on read.
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
  for (const key of keys) {
    columns.set(key, columnInfo(sample.map((el) => el[key])));
  }
  return columns;
}

function encodeColumnValue(value, info) {
  if (value === undefined || value === null) return null;
  if (info.json) return JSON.stringify(value);
  if (info.boolean) return value ? 1 : 0;
  return value;
}

function randomTableName() {
  return `flat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createFlatTable(db, columns, indexColumns) {
  const tableName = randomTableName();
  const colDefs = [...columns.entries()].map(([name, info]) => `"${name}" ${info.type}`);
  db.exec(`CREATE TABLE ${tableName} (_idx INTEGER PRIMARY KEY, ${colDefs.join(', ')})`);
  for (const col of indexColumns) {
    if (columns.has(col)) {
      db.exec(`CREATE INDEX idx_${tableName}_${col} ON ${tableName}("${col}")`);
    }
  }
  return tableName;
}

function insertFlatRows(db, tableName, elements, columns) {
  const colNames = [...columns.keys()];
  const placeholders = colNames.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${tableName} (_idx, ${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${placeholders})`,
  );
  elements.forEach((el, idx) => {
    const row = colNames.map((name) => encodeColumnValue(el[name], columns.get(name)));
    stmt.run(idx, ...row);
  });
}

export function insertNode(db, parentId, key, value, opts) {
  const insertStmt = db.prepare(
    'INSERT INTO nodes (parent_id, key, type, value) VALUES (?, ?, ?, ?)',
  );

  if (Array.isArray(value)) {
    if (isFlattenable(value)) {
      const columns = inferColumns(value, opts.sampleSize);
      const tableName = createFlatTable(db, columns, opts.indexFields);
      insertFlatRows(db, tableName, value, columns);
      const meta = JSON.stringify({
        table: tableName,
        length: value.length,
        columns: [...columns.entries()].map(([name, info]) => ({ name, ...info })),
      });
      const { lastInsertRowid } = insertStmt.run(parentId, key, 'flatarray', meta);
      return lastInsertRowid;
    }
    const { lastInsertRowid: id } = insertStmt.run(parentId, key, 'array', String(value.length));
    value.forEach((el, idx) => insertNode(db, id, String(idx), el, opts));
    return id;
  }

  if (isPlainObject(value)) {
    const { lastInsertRowid: id } = insertStmt.run(parentId, key, 'object', null);
    for (const [k, v] of Object.entries(value)) insertNode(db, id, k, v, opts);
    return id;
  }

  if (value === null || value === undefined) {
    return insertStmt.run(parentId, key, 'null', null).lastInsertRowid;
  }
  if (typeof value === 'boolean') {
    return insertStmt.run(parentId, key, 'boolean', value ? 1 : 0).lastInsertRowid;
  }
  if (typeof value === 'number') {
    return insertStmt.run(parentId, key, 'number', value).lastInsertRowid;
  }
  return insertStmt.run(parentId, key, 'string', String(value)).lastInsertRowid;
}

/** Builds (or rebuilds) the sqlite cache for a JSON file. This is the "expensive" step. */
export function buildCache(jsonPath, dbPath, options = {}) {
  const opts = {
    sampleSize: options.sampleSize ?? 200,
    indexFields: options.indexFields ?? ['id'],
  };

  const stat = fs.statSync(jsonPath);
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);

  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    db.exec('BEGIN');
    const rootId = insertNode(db, null, null, data, opts);
    db.prepare('INSERT INTO __meta (key, value) VALUES (?, ?)').run('root_id', String(rootId));
    db.prepare('INSERT INTO __meta (key, value) VALUES (?, ?)').run('source_size', String(stat.size));
    db.prepare('INSERT INTO __meta (key, value) VALUES (?, ?)').run('source_mtime_ms', String(stat.mtimeMs));
    db.prepare('INSERT INTO __meta (key, value) VALUES (?, ?)').run('version', SCHEMA_VERSION);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** Returns true if an existing cache db is still valid for the given source file. */
export function isCacheValid(jsonPath, dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  const stat = fs.statSync(jsonPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const get = (key) => db.prepare('SELECT value FROM __meta WHERE key = ?').get(key)?.value;
    if (get('version') !== SCHEMA_VERSION) return false;
    if (get('source_size') !== String(stat.size)) return false;
    if (get('source_mtime_ms') !== String(stat.mtimeMs)) return false;
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function openCache(dbPath) {
  return new DatabaseSync(dbPath);
}

export const DEFAULT_WRITE_OPTS = { sampleSize: 200, indexFields: ['id'] };

/** Recursively deletes a node and its descendants, dropping any flat table it owns. */
export function deleteSubtree(db, nodeId) {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!row) return;
  if (row.type === 'flatarray') {
    const meta = JSON.parse(row.value);
    db.exec(`DROP TABLE IF EXISTS ${meta.table}`);
  } else if (row.type === 'object' || row.type === 'array') {
    for (const child of db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(nodeId)) {
      deleteSubtree(db, child.id);
    }
  }
  db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
}

export { isPlainObject, isFlattenable };
