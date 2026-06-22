# JSON Mach

Revolutionaly technology which makes JSON up to 313 times faster (in lookups).

May or may not be powered by lmdb

## Installation

Install using npm:

```bash
npm install json-mach
```

*(Note: Requires Node.js >= 22.5.0)*

---

## Example Use

```javascript
import { open } from 'json-mach';

// Opens and wraps the data structure
const data = open('data.json');

// Read values like normal JavaScript objects/arrays
console.log(data.title);         // "demo"
console.log(data.nested.y.z);    // 2
```

## Example Queries

Assume the underlying `data.json` contains:

```json
{
  "title": "demo",
  "nested": { "x": 1, "y": { "z": 2 } },
  "users": [
    { "id": 1, "name": "Alice", "age": 30, "vip": true },
    { "id": 2, "name": "Bob", "age": 25, "vip": false },
    { "id": 3, "name": "Carol", "age": 40, "vip": true }
  ]
}
```

### Object Properties & Nesting
Access nested keys directly. The proxy traverses the LMDB B-tree on demand:

```javascript
console.log(data.nested.y.z); // 2
```

### Index Lookups on Flat Arrays
For arrays of objects, `json-mach` enables index-optimized lookups:

- **Point lookups by ID**:
  ```javascript
  const bob = data.users.findById(2);
  // => { id: 2, name: 'Bob', age: 25, vip: false }
  ```
- **Equality filter**:
  ```javascript
  const vips = data.users.where('vip', true);
  // => [ { id: 1, name: 'Alice', ... }, { id: 3, name: 'Carol', ... } ]
  ```

### Array Iteration & Methods
You can iterate or run standard functional array methods on the proxy arrays:

```javascript
// Array length
console.log(data.users.length); // 3

// Index access
console.log(data.users[0].name); // "Alice"

// Spread & Map
const names = [...data.users].map(u => u.name); // ['Alice', 'Bob', 'Carol']

// Built-in Array Helper proxies
const youngerThan30 = data.users.filter(u => u.age < 30);
const carol = data.users.find(u => u.name === 'Carol');
```

---

## Writing & Modifying Data

Any changes made to the proxy are synchronized to the LMDB cache in real-time.

```javascript
// Add or update object keys
data.nested.x = 99;
data.newKey = 'added';

// Delete object keys
delete data.title;

// Update flat-array elements by their 'id'
data.users.updateById(2, { name: 'Bobby', age: 26 });

// Delete flat-array elements by their 'id' (updates array length)
data.users.deleteById(3); 
```

---

## Batch Transactions

When performing multiple updates or deletes in a loop, wrap them in a `transaction` to avoid the overhead of multiple disk flushes and compile-to-disk times.

```javascript
import { openWithStats, transaction } from 'json-mach';

const { data, db } = openWithStats('data.json');

transaction(db, () => {
  for (let id = 1; id <= 1000; id++) {
    data.users.updateById(id, { score: 100 });
  }
});
```

---

## Options

`open` and `openWithStats` accept an options object:

```javascript
const { data } = openWithStats('data.json', {
  // Path where the cache database is stored. Defaults to "${jsonPath}.jsonp"
  cachePath: 'path/to/custom.jsonp',

  // Specify which fields to build secondary indexes for on flat arrays.
  // Defaults to ['id']
  indexFields: ['id', 'vip'],

  // Opens the LMDB environment in read-only mode, bypassing the write-lock.
  // Set to true to maximize read performance.
  readOnly: false
});
```

---

## Materializing to Plain JSON

To convert the proxy back to a normal, un-proxied JavaScript object (e.g., for serialization), run `JSON.stringify` or call the `materialize` utility:

```javascript
import { openWithStats, materialize } from 'json-mach';

const { data, db } = openWithStats('data.json');

// Option A: JSON serialization
const plainObj = JSON.parse(JSON.stringify(data));

// Option B: Selective materialization
const materializedUser = materialize(db, ['users', 0]);
```
