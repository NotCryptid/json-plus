import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openWithStats, close } from '../src/index.js';
import { openCache, closeCache, transaction } from '../src/cache.js';
import { wrapRoot } from '../src/proxy.js';
import { buildSqliteTable, isSqliteTableValid, SQLITE_TABLE } from './sqlite-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, '..', 'data', 'sample.json');
const DB_PATH = `${DATA_PATH}.jsonm`;
// A separate, plain SQLite table just for the "raw SQLite" comparison column -
// json-plus's own cache (DB_PATH) is LMDB now, so this is built independently.
const SQLITE_PATH = `${DATA_PATH}.sqlite`;
const PORT = Number(process.env.PORT) || 8080;

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

function randomIds(count, n, seed) {
  const rand = mulberry32(seed);
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(1 + Math.floor(rand() * count));
  return ids;
}

function ensureSqliteTable() {
  if (!isSqliteTableValid(DATA_PATH, SQLITE_PATH)) buildSqliteTable(DATA_PATH, SQLITE_PATH);
}

/** Plain-JSON path: full re-parse every run (no cache), then linear-scan lookups. */
function benchPlainJson(ids) {
  const t0 = performance.now();
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const doc = JSON.parse(raw);
  const parseMs = performance.now() - t0;

  const t1 = performance.now();
  const results = ids.map((id) => doc.users.find((u) => u.id === id));
  const lookupMs = performance.now() - t1;

  return { parseMs, lookupMs, total: parseMs + lookupMs, found: results.filter(Boolean).length };
}

/** json-plus path: cached LMDB open (or rebuild on first/cold run), then indexed lookups. */
function benchJsonPlus(ids, { cold }) {
  const { data, db, cached, buildMs, openMs } = openWithStats(DATA_PATH, { force: cold, readOnly: true });

  const users = data.users;
  const t0 = performance.now();
  const results = ids.map((id) => users.findById(id));
  const lookupMs = performance.now() - t0;

  close(db);
  return {
    cached,
    buildMs,
    openMs,
    lookupMs,
    total: buildMs + openMs + lookupMs,
    found: results.filter(Boolean).length,
  };
}

/** Raw SQLite path: open the standalone comparison table, execute raw SQL queries. */
function benchRawSqlite(ids) {
  ensureSqliteTable();
  const t0 = performance.now();
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const openMs = performance.now() - t0;
  try {
    const stmt = db.prepare(`SELECT * FROM ${SQLITE_TABLE} WHERE id = ? LIMIT 1`);
    const t1 = performance.now();
    const results = ids.map((id) => stmt.get(id));
    const lookupMs = performance.now() - t1;

    return { openMs, lookupMs, total: openMs + lookupMs, found: results.filter(Boolean).length };
  } finally {
    db.close();
  }
}

function scratchPath(suffix) {
  const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `json-plus-bench-${tag}${suffix}`);
}

function cleanupLmdbScratch(dbPath) {
  for (const suffix of ['', '-lock']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

function cleanupSqliteScratch(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

/** Plain-JSON path: parse, mutate matching records in memory, then rewrite the whole file. */
function benchPlainJsonWrite(ids) {
  const t0 = performance.now();
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const parseMs = performance.now() - t0;

  const byId = new Map(doc.users.map((u) => [u.id, u]));
  const t1 = performance.now();
  for (const id of ids) {
    const user = byId.get(id);
    if (user) user.score = 0;
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'json-plus-bench-plain-write.json'), JSON.stringify(doc));
  const writeMs = performance.now() - t1;

  return { parseMs, writeMs, total: parseMs + writeMs };
}

/** Plain-JSON path: parse, filter out matching records, then rewrite the whole file. */
function benchPlainJsonDelete(ids) {
  const t0 = performance.now();
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const parseMs = performance.now() - t0;

  const idSet = new Set(ids);
  const t1 = performance.now();
  doc.users = doc.users.filter((u) => !idSet.has(u.id));
  fs.writeFileSync(path.join(os.tmpdir(), 'json-plus-bench-plain-delete.json'), JSON.stringify(doc));
  const deleteMs = performance.now() - t1;

  return { parseMs, deleteMs, total: parseMs + deleteMs };
}

/** json-plus path: all updates batched in a single transaction against a scratch copy of the cache. */
function benchJsonPlusWrite(ids) {
  const dbPath = scratchPath('.jsonp');
  fs.copyFileSync(DB_PATH, dbPath);
  try {
    const db = openCache(dbPath);
    const users = wrapRoot(db).users;
    const t0 = performance.now();
    transaction(db, () => {
      for (const id of ids) users.updateById(id, { score: 0 });
    });
    const writeMs = performance.now() - t0;
    closeCache(db);
    return { writeMs, total: writeMs };
  } finally {
    cleanupLmdbScratch(dbPath);
  }
}

/** json-plus path: all deletes batched in a single transaction against a scratch copy of the cache. */
function benchJsonPlusDelete(ids) {
  const dbPath = scratchPath('.jsonp');
  fs.copyFileSync(DB_PATH, dbPath);
  try {
    const db = openCache(dbPath);
    const users = wrapRoot(db).users;
    const t0 = performance.now();
    transaction(db, () => {
      for (const id of ids) users.deleteById(id);
    });
    const deleteMs = performance.now() - t0;
    closeCache(db);
    return { deleteMs, total: deleteMs };
  } finally {
    cleanupLmdbScratch(dbPath);
  }
}

/** Checkpoints the live SQLite comparison table's WAL and copies it to a throwaway scratch db. */
function snapshotSqliteTable(destPath) {
  ensureSqliteTable();
  const live = new DatabaseSync(SQLITE_PATH);
  live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  live.close();
  fs.copyFileSync(SQLITE_PATH, destPath);
}

/** Raw SQLite path: all updates batched in a single transaction against a scratch copy of the table. */
function benchRawSqliteWrite(ids) {
  const dbPath = scratchPath('.sqlite');
  snapshotSqliteTable(dbPath);
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const stmt = db.prepare(`UPDATE ${SQLITE_TABLE} SET "score" = ? WHERE "id" = ?`);
      const t0 = performance.now();
      db.exec('BEGIN');
      for (const id of ids) stmt.run(0, id);
      db.exec('COMMIT');
      const writeMs = performance.now() - t0;
      return { writeMs, total: writeMs };
    } finally {
      db.close();
    }
  } finally {
    cleanupSqliteScratch(dbPath);
  }
}

/** Raw SQLite path: all deletes batched in a single transaction against a scratch copy of the table. */
function benchRawSqliteDelete(ids) {
  const dbPath = scratchPath('.sqlite');
  snapshotSqliteTable(dbPath);
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const stmt = db.prepare(`DELETE FROM ${SQLITE_TABLE} WHERE "id" = ?`);
      const t0 = performance.now();
      db.exec('BEGIN');
      for (const id of ids) stmt.run(id);
      db.exec('COMMIT');
      const deleteMs = performance.now() - t0;
      return { deleteMs, total: deleteMs };
    } finally {
      db.close();
    }
  } finally {
    cleanupSqliteScratch(dbPath);
  }
}

function handleApiRun(url, res) {
  try {
    handleApiRunInner(url, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, stack: err.stack }));
  }
}

function handleApiRunInner(url, res) {
  const params = url.searchParams;
  const lookups = Math.min(Math.max(Number(params.get('lookups')) || 2000, 1), 100_000);
  const cold = params.get('cold') === '1';
  const seed = Number(params.get('seed')) || 1;

  if (!fs.existsSync(DATA_PATH)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No dataset found. Run `npm run generate` first.' }));
    return;
  }

  const head = Buffer.alloc(200);
  const fd = fs.openSync(DATA_PATH, 'r');
  fs.readSync(fd, head, 0, 200, 0);
  fs.closeSync(fd);
  const count = Number(head.toString('utf8').match(/"count":(\d+)/)?.[1] ?? 0);
  const ids = randomIds(count, lookups, seed);

  const plain = benchPlainJson(ids);
  const jsonPlus = benchJsonPlus(ids, { cold });
  const rawSqlite = benchRawSqlite(ids);

  const plainWrite = benchPlainJsonWrite(ids);
  const jsonPlusWrite = benchJsonPlusWrite(ids);
  const rawSqliteWrite = benchRawSqliteWrite(ids);

  const plainDelete = benchPlainJsonDelete(ids);
  const jsonPlusDelete = benchJsonPlusDelete(ids);
  const rawSqliteDelete = benchRawSqliteDelete(ids);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    count,
    lookups,
    cold,
    plain,
    jsonPlus,
    rawSqlite,
    plainWrite,
    jsonPlusWrite,
    rawSqliteWrite,
    plainDelete,
    jsonPlusDelete,
    rawSqliteDelete,
  }));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(urlPath, res) {
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/run') {
    handleApiRun(url, res);
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`json-plus benchmark running at http://localhost:${PORT}`);
});
