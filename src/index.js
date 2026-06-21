import { openOrBuildCache, transaction } from './cache.js';
import { wrapRoot, materialize, getRow } from './proxy.js';

function resolveCachePath(jsonPath, options) {
  return options.cachePath ?? `${jsonPath}.jsonp`;
}

// wrapRoot() is cheap on its own, but it does one real LMDB get for the root
// node - on a warm env-cache hit that get is the only remaining cost, so it's
// memoized per db here, keyed by db identity (a fresh db object only appears
// after openOrBuildCache rebuilds/reopens, which is exactly when it should be
// recomputed).
const rootCache = new WeakMap();

function getOrWrapRoot(db) {
  let data = rootCache.get(db);
  if (!data) {
    data = wrapRoot(db);
    rootCache.set(db, data);
  }
  return data;
}

/**
 * Opens a JSON file as an LMDB-backed store, rebuilding the cache only if
 * the source file changed (or doesn't have one yet). Returns timing info
 * alongside the data so callers can see the cache hit/miss cost.
 */
export function openWithStats(jsonPath, options = {}) {
  const dbPath = resolveCachePath(jsonPath, options);

  const t0 = performance.now();
  const { db, cached, buildMs } = openOrBuildCache(jsonPath, dbPath, options);
  const data = getOrWrapRoot(db);
  const openMs = performance.now() - t0 - buildMs;

  return { data, db, dbPath, cached, buildMs, openMs };
}

/** Convenience wrapper around openWithStats() that just returns the data. */
export function open(jsonPath, options = {}) {
  return openWithStats(jsonPath, options).data;
}

/**
 * No-op: envs opened via openWithStats()/open() are owned by cache.js's
 * internal env cache and kept open for reuse across calls, not by the
 * caller. This is kept as a stable API so existing call sites don't need to
 * change; the env is torn down automatically once the source file changes.
 */
export function close() {}

export { materialize, getRow, transaction };
