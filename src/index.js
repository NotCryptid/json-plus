import { buildCache, isCacheValid, openCache } from './cache.js';
import { wrapRoot, materialize, getRow } from './proxy.js';

function resolveCachePath(jsonPath, options) {
  return options.cachePath ?? `${jsonPath}.jsonp`;
}

/**
 * Opens a JSON file as a sqlite-backed store, rebuilding the cache only if
 * the source file changed (or doesn't have one yet). Returns timing info
 * alongside the data so callers can see the cache hit/miss cost.
 */
export function openWithStats(jsonPath, options = {}) {
  const dbPath = resolveCachePath(jsonPath, options);
  const force = options.force ?? false;
  const cached = !force && isCacheValid(jsonPath, dbPath);

  let buildMs = 0;
  if (!cached) {
    const t0 = performance.now();
    buildCache(jsonPath, dbPath, options);
    buildMs = performance.now() - t0;
  }

  const t1 = performance.now();
  const db = openCache(dbPath);
  const data = wrapRoot(db);
  const openMs = performance.now() - t1;

  return { data, db, dbPath, cached, buildMs, openMs };
}

/** Convenience wrapper around openWithStats() that just returns the data. */
export function open(jsonPath, options = {}) {
  return openWithStats(jsonPath, options).data;
}

export function close(db) {
  db.close();
}

export { materialize, getRow };
