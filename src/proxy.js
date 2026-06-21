import { insertNode, deleteSubtree, DEFAULT_WRITE_OPTS } from './cache.js';

function getRow(db, id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

function getChild(db, parentId, key) {
  return db.prepare('SELECT * FROM nodes WHERE parent_id = ? AND key = ?').get(parentId, key);
}

function getChildren(db, parentId) {
  return db.prepare('SELECT * FROM nodes WHERE parent_id = ?').all(parentId);
}

function decodeScalar(row) {
  switch (row.type) {
    case 'string':
      return row.value;
    case 'number':
      return row.value;
    case 'boolean':
      return row.value !== 0;
    case 'null':
      return null;
    default:
      return undefined;
  }
}

function isContainer(type) {
  return type === 'object' || type === 'array' || type === 'flatarray';
}

function materialize(db, row) {
  switch (row.type) {
    case 'object': {
      const obj = {};
      for (const c of getChildren(db, row.id)) obj[c.key] = materialize(db, c);
      return obj;
    }
    case 'array': {
      const children = getChildren(db, row.id).sort((a, b) => Number(a.key) - Number(b.key));
      return children.map((c) => materialize(db, c));
    }
    case 'flatarray': {
      const meta = JSON.parse(row.value);
      return readFlatRows(db, meta).map((r) => decodeFlatRow(r, meta.columns));
    }
    default:
      return decodeScalar(row);
  }
}

function decodeFlatRow(row, columns) {
  const obj = {};
  for (const col of columns) {
    const raw = row[col.name];
    if (raw === null || raw === undefined) {
      obj[col.name] = null;
    } else if (col.json) {
      obj[col.name] = JSON.parse(raw);
    } else if (col.boolean) {
      obj[col.name] = Boolean(raw);
    } else {
      obj[col.name] = raw;
    }
  }
  return obj;
}

function readFlatRows(db, meta) {
  return db.prepare(`SELECT * FROM ${meta.table} ORDER BY _idx`).all();
}

function wrapValue(db, row) {
  if (row.type === 'object') return wrapObject(db, row.id);
  if (row.type === 'array') return wrapArrayContainer(db, row.id);
  if (row.type === 'flatarray') return wrapFlatArray(db, JSON.parse(row.value));
  return decodeScalar(row);
}

/** Replaces whatever lives at (parentId, key) with `value`, writing straight to sqlite. */
function writeChild(db, parentId, key, value) {
  const existing = getChild(db, parentId, key);
  if (existing) deleteSubtree(db, existing.id);
  insertNode(db, parentId, key, value, DEFAULT_WRITE_OPTS);
}

function wrapObject(db, nodeId) {
  const target = {};
  return new Proxy(target, {
    get(_t, prop, receiver) {
      if (prop === 'toJSON') return () => materialize(db, getRow(db, nodeId));
      if (typeof prop === 'symbol') return Reflect.get(_t, prop, receiver);
      const child = getChild(db, nodeId, prop);
      return child ? wrapValue(db, child) : undefined;
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return false;
      writeChild(db, nodeId, prop, value);
      return true;
    },
    has(_t, prop) {
      if (typeof prop === 'symbol') return false;
      return Boolean(getChild(db, nodeId, prop));
    },
    deleteProperty(_t, prop) {
      const child = getChild(db, nodeId, prop);
      if (child) deleteSubtree(db, child.id);
      return true;
    },
    ownKeys() {
      return getChildren(db, nodeId).map((c) => c.key);
    },
    getOwnPropertyDescriptor(_t, prop) {
      const child = getChild(db, nodeId, prop);
      if (!child) return undefined;
      return { value: wrapValue(db, child), enumerable: true, configurable: true, writable: true };
    },
  });
}

// Non-uniform arrays (mixed types, or arrays containing arrays) are rare in
// practice and don't benefit from a SQL table, so they're just materialized
// into a plain array of live-wrapped elements.
function wrapArrayContainer(db, nodeId) {
  const children = getChildren(db, nodeId).sort((a, b) => Number(a.key) - Number(b.key));
  return children.map((c) => wrapValue(db, c));
}

function wrapFlatArray(db, meta) {
  function getAt(idx) {
    const row = db.prepare(`SELECT * FROM ${meta.table} WHERE _idx = ?`).get(idx);
    return row ? decodeFlatRow(row, meta.columns) : undefined;
  }

  function* iterate() {
    for (const row of db.prepare(`SELECT * FROM ${meta.table} ORDER BY _idx`).iterate()) {
      yield decodeFlatRow(row, meta.columns);
    }
  }

  const api = {
    get length() {
      return meta.length;
    },
    /** Indexed lookup on a column. Uses a SQL index when one exists (e.g. "id"). */
    where(field, value) {
      const rows = db.prepare(`SELECT * FROM ${meta.table} WHERE "${field}" = ?`).all(value);
      return rows.map((r) => decodeFlatRow(r, meta.columns));
    },
    findById(id) {
      const row = db.prepare(`SELECT * FROM ${meta.table} WHERE "id" = ? LIMIT 1`).get(id);
      return row ? decodeFlatRow(row, meta.columns) : undefined;
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
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return getAt(Number(prop));
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < meta.length;
      return Reflect.has(target, prop);
    },
  });
}

export function wrapRoot(db) {
  const rootIdStr = db.prepare("SELECT value FROM __meta WHERE key = 'root_id'").get().value;
  const row = getRow(db, Number(rootIdStr));
  return wrapValue(db, row);
}

export { materialize, getRow };
