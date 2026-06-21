import { open } from 'lmdb';
import fs from 'node:fs';

const SCHEMA_VERSION = '3';

// LMDB rejects zero-length keys, so the root can't be addressed by an empty
// path; every node's path is anchored under this fixed, non-empty prefix.
export const ROOT_PATH = ['$root'];

export const DEFAULT_WRITE_OPTS = { sampleSize: 200, indexFields: ['id'] };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An array "flattens" into its own table (one row per element) when every
// element is a plain object. That's the case that benefits most from a real
// index: point/equality lookups instead of a linear scan.
function isFlattenable(arr) {
  return arr.length > 0 && arr.every(isPlainObject);
}

function randomTableName() {
  return `flat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Opens (or returns the already-open handle for) a named sub-database under the cache's root env. */
function getTable(db, name, options) {
  let dbi = db.tables.get(name);
  if (!dbi) {
    dbi = db.root.openDB({ name, ...options });
    db.tables.set(name, dbi);
  }
  return dbi;
}

function indexTableName(table, field) {
  return `${table}__idx_${field}`;
}

// "id" is assumed unique (like a primary key), so its index skips dupSort
// entirely: a plain get() is a single direct B-tree lookup, while dupSort's
// getValues() has to open/seek/close a cursor even when there's only one
// match. Other configured index fields keep dupSort since they may
// legitimately have repeated values (e.g. indexing a non-unique "city").
function isUniqueField(field) {
  return field === 'id';
}

function getIndexTable(db, table, field) {
  const options = isUniqueField(field) ? { encoding: 'ordered-binary' } : { dupSort: true, encoding: 'ordered-binary' };
  return getTable(db, indexTableName(table, field), options);
}

/** Looks up the single idx for `value` on a field's index, regardless of whether it's dupSort. */
function lookupIndexValue(idxDbi, field, value) {
  if (isUniqueField(field)) return idxDbi.get(value);
  const [idx] = idxDbi.getValues(value);
  return idx;
}

/** Removes one index entry, regardless of whether the dbi is dupSort. */
function removeIndexEntry(idxDbi, field, key, idx) {
  if (isUniqueField(field)) idxDbi.removeSync(key);
  else idxDbi.removeSync(key, idx);
}

/** Tree nodes are addressed by path (array of keys from the root) rather than by id -
 * this lets a parent's own record just list its children's keys, with no need for a
 * parent_id index or an auto-increment id allocator. */
export function getNode(db, path) {
  return db.nodes.get(path);
}

function setNode(db, path, record) {
  db.nodes.putSync(path, record);
}

function removeNode(db, path) {
  db.nodes.removeSync(path);
}

export function getChild(db, parentPath, key) {
  return getNode(db, [...parentPath, key]);
}

/** All direct children of a node, derived from its own ordered key/length list. */
export function getChildren(db, parentPath, parentNode) {
  const node = parentNode ?? getNode(db, parentPath);
  if (!node) return [];
  if (node.kind === 'object') {
    return node.keys.map((key) => ({ key, path: [...parentPath, key] }));
  }
  if (node.kind === 'array') {
    const out = [];
    for (let i = 0; i < node.length; i += 1) out.push({ key: i, path: [...parentPath, i] });
    return out;
  }
  return [];
}

function createFlatTable(db, elements, opts) {
  const tableName = randomTableName();
  const mainDbi = getTable(db, tableName);
  const sample = elements[0] ?? {};
  const indexFields = opts.indexFields.filter((f) => f in sample);
  const indexDbis = indexFields.map((field) => getIndexTable(db, tableName, field));

  elements.forEach((el, idx) => {
    mainDbi.putSync(idx, el);
    indexFields.forEach((field, i) => {
      if (field in el) indexDbis[i].putSync(el[field], idx);
    });
  });

  return { table: tableName, length: elements.length, indexFields };
}

function dropTable(db, name) {
  const dbi = getTable(db, name);
  dbi.dropSync();
  db.tables.delete(name);
}

export function insertNode(db, path, value, opts) {
  if (Array.isArray(value)) {
    if (isFlattenable(value)) {
      const meta = createFlatTable(db, value, opts);
      setNode(db, path, { kind: 'flatarray', meta });
      return;
    }
    setNode(db, path, { kind: 'array', length: value.length });
    value.forEach((el, idx) => insertNode(db, [...path, idx], el, opts));
    return;
  }
  if (isPlainObject(value)) {
    setNode(db, path, { kind: 'object', keys: Object.keys(value) });
    for (const [k, v] of Object.entries(value)) insertNode(db, [...path, k], v, opts);
    return;
  }
  setNode(db, path, { kind: 'scalar', value: value === undefined ? null : value });
}

/** Recursively deletes a node and its descendants, dropping any flat tables it owns. */
export function deleteSubtree(db, path) {
  const node = getNode(db, path);
  if (!node) return;
  if (node.kind === 'flatarray') {
    dropTable(db, node.meta.table);
    for (const field of node.meta.indexFields) dropTable(db, indexTableName(node.meta.table, field));
  } else {
    for (const child of getChildren(db, path, node)) deleteSubtree(db, child.path);
  }
  removeNode(db, path);
}

/** Replaces whatever lives at (parentPath, key) with `value`, and keeps the parent's key list in sync. */
export function writeChild(db, parentPath, key, value) {
  deleteSubtree(db, [...parentPath, key]);
  insertNode(db, [...parentPath, key], value, DEFAULT_WRITE_OPTS);

  const parentNode = getNode(db, parentPath);
  if (parentNode?.kind === 'object' && !parentNode.keys.includes(key)) {
    setNode(db, parentPath, { ...parentNode, keys: [...parentNode.keys, key] });
  }
}

/** Deletes (parentPath, key) entirely, including removing it from the parent's key list. */
export function deleteChild(db, parentPath, key) {
  deleteSubtree(db, [...parentPath, key]);
  const parentNode = getNode(db, parentPath);
  if (parentNode?.kind === 'object') {
    setNode(db, parentPath, { ...parentNode, keys: parentNode.keys.filter((k) => k !== key) });
  }
}

/** Updates the given fields on the flat-table row matching `id`. Returns whether a row was found. */
export function updateFlatRow(db, meta, id, patch) {
  if (!meta.indexFields.includes('id')) return false;
  const idDbi = getIndexTable(db, meta.table, 'id');
  const idx = lookupIndexValue(idDbi, 'id', id);
  if (idx === undefined) return false;

  const mainDbi = getTable(db, meta.table);
  const existing = mainDbi.get(idx);
  if (!existing) return false;

  for (const field of meta.indexFields) {
    if (field in patch && patch[field] !== existing[field]) {
      const fieldDbi = getIndexTable(db, meta.table, field);
      removeIndexEntry(fieldDbi, field, existing[field], idx);
      fieldDbi.putSync(patch[field], idx);
    }
  }
  mainDbi.putSync(idx, { ...existing, ...patch });
  return true;
}

/** Deletes the flat-table row matching `id`. Returns whether a row was found. */
export function deleteFlatRow(db, meta, id) {
  if (!meta.indexFields.includes('id')) return false;
  const idDbi = getIndexTable(db, meta.table, 'id');
  const idx = lookupIndexValue(idDbi, 'id', id);
  if (idx === undefined) return false;

  const mainDbi = getTable(db, meta.table);
  const existing = mainDbi.get(idx);
  if (!existing) return false;

  mainDbi.removeSync(idx);
  for (const field of meta.indexFields) {
    if (field in existing) {
      const fieldDbi = getIndexTable(db, meta.table, field);
      removeIndexEntry(fieldDbi, field, existing[field], idx);
    }
  }
  return true;
}

/** Persists an updated flatarray meta blob (e.g. after a length change) back onto its node. */
export function persistFlatArrayMeta(db, path, meta) {
  setNode(db, path, { kind: 'flatarray', meta });
}

/** Iterates a flat table's rows in original array order. */
export function iterateFlatTable(db, meta) {
  const mainDbi = getTable(db, meta.table);
  return mainDbi.getRange({}).map(({ value }) => value);
}

export function getFlatRowAt(db, meta, idx) {
  return getTable(db, meta.table).get(idx);
}

export function whereFlatRows(db, meta, field, value) {
  if (!meta.indexFields.includes(field)) {
    return [...iterateFlatTable(db, meta)].filter((row) => row[field] === value);
  }
  const mainDbi = getTable(db, meta.table);
  const idxDbi = getIndexTable(db, meta.table, field);
  if (isUniqueField(field)) {
    const idx = idxDbi.get(value);
    const row = idx === undefined ? undefined : mainDbi.get(idx);
    return row ? [row] : [];
  }
  const idxs = [...idxDbi.getValues(value)];
  return idxs.map((idx) => mainDbi.get(idx)).filter(Boolean);
}

/** Single-row equality lookup, skipping the array allocation whereFlatRows pays for the multi-match case. */
export function findFlatRow(db, meta, field, value) {
  if (!meta.indexFields.includes(field)) {
    for (const row of iterateFlatTable(db, meta)) {
      if (row[field] === value) return row;
    }
    return undefined;
  }
  const idx = lookupIndexValue(getIndexTable(db, meta.table, field), field, value);
  return idx === undefined ? undefined : getTable(db, meta.table).get(idx);
}

function openEnv(dbPath, options = {}) {
  const root = open({ path: dbPath, ...options });
  const meta = root.openDB({ name: '__meta' });
  const nodes = root.openDB({ name: '__nodes' });
  return { root, meta, nodes, tables: new Map() };
}

/** Builds (or rebuilds) the LMDB cache for a JSON file. This is the "expensive" step. */
export function buildCache(jsonPath, dbPath, options = {}) {
  const opts = {
    sampleSize: options.sampleSize ?? 200,
    indexFields: options.indexFields ?? ['id'],
  };

  const stat = fs.statSync(jsonPath);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  fs.rmSync(dbPath, { force: true });
  const db = openEnv(dbPath);
  try {
    db.root.transactionSync(() => {
      insertNode(db, ROOT_PATH, data, opts);
      db.meta.putSync('version', SCHEMA_VERSION);
      db.meta.putSync('source_size', stat.size);
      db.meta.putSync('source_mtime_ms', stat.mtimeMs);
    });
  } finally {
    db.root.close();
  }
}

/** Checks an already-open cache env's meta against the source file, with no extra env open/close. */
function isEnvValid(db, stat) {
  if (db.meta.get('version') !== SCHEMA_VERSION) return false;
  if (db.meta.get('source_size') !== stat.size) return false;
  if (db.meta.get('source_mtime_ms') !== stat.mtimeMs) return false;
  return true;
}

export function openCache(dbPath) {
  return openEnv(dbPath);
}

export function closeCache(db) {
  db.root.close();
}

// Caches open envs across calls, keyed by dbPath + access mode, so a
// warm-cache open is a Map lookup + stat comparison instead of a fresh LMDB
// env open - the native open() call (~0.1ms even read-only) was the floor
// that per-call opening couldn't get under. Ownership of the env moves here:
// callers no longer close it themselves (see closeCache below), and an
// entry is only torn down when its source file changes underneath it.
const envCache = new Map();

function envCacheKey(dbPath, readOnly) {
  return `${dbPath} ${readOnly ? 'ro' : 'rw'}`;
}

function evictEnvCacheEntry(dbPath) {
  for (const mode of ['ro', 'rw']) {
    const key = `${dbPath} ${mode}`;
    const entry = envCache.get(key);
    if (entry) {
      entry.db.root.close();
      envCache.delete(key);
    }
  }
}

/**
 * Opens the cache env for `jsonPath`, rebuilding it first if missing or
 * stale, and keeps the env open afterward (see envCache above) so repeat
 * opens against an unchanged source file skip LMDB entirely.
 *
 * `options.readOnly` skips LMDB's write-lock setup on a cache miss, roughly
 * halving that one-time open cost - pass it when the caller only intends to
 * read (e.g. the benchmark's lookup path). Writers must omit it.
 */
export function openOrBuildCache(jsonPath, dbPath, options = {}) {
  const stat = fs.statSync(jsonPath);
  const envOpts = options.readOnly ? { readOnly: true } : {};
  const key = envCacheKey(dbPath, options.readOnly);

  if (!options.force) {
    const entry = envCache.get(key);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
      return { db: entry.db, cached: true, buildMs: 0 };
    }
  }

  // Stale or forced: drop whatever's cached for this dbPath (in any access
  // mode) before rebuilding/reopening, since the on-disk file is about to
  // change underneath any of those envs.
  evictEnvCacheEntry(dbPath);

  let db;
  let cached = false;
  if (!options.force && fs.existsSync(dbPath)) {
    try {
      db = openEnv(dbPath, envOpts);
      cached = isEnvValid(db, stat);
    } catch {
      db = undefined;
    }
    if (!cached) db?.root.close();
  }

  let buildMs = 0;
  if (!cached) {
    const t0 = performance.now();
    buildCache(jsonPath, dbPath, options);
    buildMs = performance.now() - t0;
    db = openEnv(dbPath, envOpts);
  }

  envCache.set(key, { db, size: stat.size, mtimeMs: stat.mtimeMs });
  return { db, cached, buildMs };
}

/** Runs fn() inside a single explicit transaction instead of one implicit transaction per statement. */
export function transaction(db, fn) {
  return db.root.transactionSync(fn);
}

export { isPlainObject, isFlattenable };
