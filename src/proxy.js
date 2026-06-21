import {
  ROOT_PATH,
  getNode,
  getChild,
  getChildren,
  writeChild,
  deleteChild,
  updateFlatRow,
  deleteFlatRow,
  persistFlatArrayMeta,
  iterateFlatTable,
  getFlatRowAt,
  whereFlatRows,
  findFlatRow,
} from './cache.js';

function materialize(db, path, node) {
  const record = node ?? getNode(db, path);
  if (!record) return undefined;
  switch (record.kind) {
    case 'object': {
      const obj = {};
      for (const child of getChildren(db, path, record)) obj[child.key] = materialize(db, child.path);
      return obj;
    }
    case 'array': {
      const out = [];
      for (const child of getChildren(db, path, record)) out.push(materialize(db, child.path));
      return out;
    }
    case 'flatarray':
      return [...iterateFlatTable(db, record.meta)];
    default:
      return record.value;
  }
}

function wrapValue(db, path, node) {
  if (!node) return undefined;
  if (node.kind === 'object') return wrapObject(db, path);
  if (node.kind === 'array') return wrapArrayContainer(db, path, node);
  if (node.kind === 'flatarray') return wrapFlatArray(db, path, node.meta);
  return node.value;
}

function wrapObject(db, path) {
  const target = {};
  return new Proxy(target, {
    get(_t, prop, receiver) {
      if (prop === 'toJSON') return () => materialize(db, path);
      if (typeof prop === 'symbol') return Reflect.get(_t, prop, receiver);
      const child = getChild(db, path, prop);
      return wrapValue(db, [...path, prop], child);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return false;
      writeChild(db, path, prop, value);
      return true;
    },
    has(_t, prop) {
      if (typeof prop === 'symbol') return false;
      return Boolean(getChild(db, path, prop));
    },
    deleteProperty(_t, prop) {
      if (typeof prop !== 'symbol') deleteChild(db, path, prop);
      return true;
    },
    ownKeys() {
      return getChildren(db, path).map((c) => c.key);
    },
    getOwnPropertyDescriptor(_t, prop) {
      const child = getChild(db, path, prop);
      if (!child) return undefined;
      return { value: wrapValue(db, [...path, prop], child), enumerable: true, configurable: true, writable: true };
    },
  });
}

// Non-uniform arrays (mixed types, or arrays containing arrays) are rare in
// practice and don't benefit from a flat table, so they're just materialized
// into a plain array of live-wrapped elements.
function wrapArrayContainer(db, path, node) {
  return getChildren(db, path, node).map((c) => wrapValue(db, c.path, getNode(db, c.path)));
}

function wrapFlatArray(db, path, meta) {
  function* iterate() {
    yield* iterateFlatTable(db, meta);
  }

  const api = {
    get length() {
      return meta.length;
    },
    /** Equality lookup on a field. Uses a secondary index when the field is configured as indexed (e.g. "id"). */
    where(field, value) {
      return whereFlatRows(db, meta, field, value);
    },
    findById(id) {
      return findFlatRow(db, meta, 'id', id);
    },
    /** Updates the given fields on the row matching `id`. Returns whether a row was found. */
    updateById(id, patch) {
      return updateFlatRow(db, meta, id, patch);
    },
    /** Deletes the row matching `id`. Returns whether a row was found. */
    deleteById(id) {
      const changed = deleteFlatRow(db, meta, id);
      if (changed) {
        meta.length -= 1;
        persistFlatArrayMeta(db, path, meta);
      }
      return changed;
    },
    find(predicate) {
      let i = 0;
      for (const item of iterate()) {
        if (predicate(item, i++)) return item;
      }
      return undefined;
    },
    filter(predicate) {
      const out = [];
      let i = 0;
      for (const item of iterate()) {
        if (predicate(item, i++)) out.push(item);
      }
      return out;
    },
    map(fn) {
      const out = [];
      let i = 0;
      for (const item of iterate()) out.push(fn(item, i++));
      return out;
    },
    forEach(fn) {
      let i = 0;
      for (const item of iterate()) fn(item, i++);
    },
    toArray() {
      return [...iterate()];
    },
    toJSON() {
      return [...iterate()];
    },
    [Symbol.iterator]() {
      return iterate();
    },
  };

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return getFlatRowAt(db, meta, Number(prop));
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < meta.length;
      return Reflect.has(target, prop);
    },
  });
}

export function wrapRoot(db) {
  return wrapValue(db, ROOT_PATH, getNode(db, ROOT_PATH));
}

function getRow(db, path) {
  return getNode(db, path);
}

export { materialize, getRow };
