import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openWithStats, close } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_PATH = path.join(__dirname, '..', 'data', 'sample.json');
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

/** json-plus path: cached sqlite open (or rebuild on first/cold run), then indexed lookups. */
function benchJsonPlus(ids, { cold }) {
  const { data, db, cached, buildMs, openMs } = openWithStats(DATA_PATH, { force: cold });

  const t0 = performance.now();
  const results = ids.map((id) => data.users.findById(id));
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

/** Raw SQLite path: open cache, execute raw SQL queries without proxy overhead. */
function benchRawSqlite(ids, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rootIdStr = db.prepare("SELECT value FROM __meta WHERE key = 'root_id'").get().value;
    const rootRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(rootIdStr));
    const usersRow = db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND key = ?').get(rootRow.id, 'users');
    const meta = JSON.parse(usersRow.value);

    const t0 = performance.now();
    const results = ids.map((id) =>
      db.prepare(`SELECT * FROM ${meta.table} WHERE id = ? LIMIT 1`).get(id),
    );
    const lookupMs = performance.now() - t0;

    return { lookupMs, found: results.filter(Boolean).length };
  } finally {
    db.close();
  }
}

function handleApiRun(url, res) {
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
  const dbPath = `${DATA_PATH}.jsonp`;
  const rawSqlite = benchRawSqlite(ids, dbPath);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ count, lookups, cold, plain, jsonPlus, rawSqlite }));
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
