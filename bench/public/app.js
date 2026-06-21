const runBtn = document.getElementById('run');
const runColdBtn = document.getElementById('runCold');
const statusEl = document.getElementById('status');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');

function barClass(name) {
  if (name === 'Plain JSON') return 'bar plain';
  if (name === 'SQLite') return 'bar sqlite';
  return 'bar';
}

// Renders one row. Column order and bar color are both driven by `name`, so a
// given backend always keeps the same color no matter where it lands in the
// (per-run) column order, and each row scales its own bars independently so a
// row of millisecond-scale numbers isn't flattened by a row of second-scale ones.
// `logScale` switches the bar width from linear to log(1+ms): build/open costs
// for SQLite and JSON Plus are routinely 100-1000x smaller than plain JSON's
// parse cost, and a linear scale reserves nearly the whole row as empty space
// for a "max" that the smaller two will never approach.
function row(label, valuesByName, order, { logScale = false } = {}) {
  const tr = document.createElement('tr');
  tr.className = 'bar-row';

  const labelTd = document.createElement('td');
  labelTd.textContent = label;

  const msValues = order.map((name) => valuesByName[name]);
  const minMs = Math.min(...msValues);
  const scaled = (ms) => (logScale ? Math.log1p(ms) : ms);
  const maxScaled = Math.max(...msValues.map(scaled), scaled(1));

  const cells = [labelTd];
  const bars = [];

  for (const name of order) {
    const ms = valuesByName[name];
    const td = document.createElement('td');
    td.textContent = ms.toFixed(2);
    if (ms === minMs) td.classList.add('winner');
    cells.push(td);

    const bar = document.createElement('div');
    bar.className = barClass(name);
    bar.style.width = `${(scaled(ms) / maxScaled) * 100}%`;
    if (name !== 'Plain JSON') bar.style.opacity = '0.7';
    if (bars.length > 0) bar.style.marginTop = '4px';
    bars.push(bar);
  }

  const barTd = document.createElement('td');
  barTd.append(...bars);
  cells.push(barTd);

  tr.append(...cells);
  return { tr };
}

function updateHeader(order) {
  const headerCells = document.querySelectorAll('#resultsHeader th');
  order.forEach((name, i) => {
    headerCells[i + 1].textContent = `${name} (ms)`;
  });
}

async function runBenchmark(cold) {
  const lookups = document.getElementById('lookups').value;
  runBtn.disabled = true;
  runColdBtn.disabled = true;
  statusEl.textContent = 'Running...';

  try {
    const res = await fetch(`/api/run?lookups=${lookups}&cold=${cold ? 1 : 0}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const {
      plain, jsonPlus, rawSqlite, count,
      plainWrite, jsonPlusWrite, rawSqliteWrite,
      plainDelete, jsonPlusDelete, rawSqliteDelete,
    } = data;
    const plainBuild = plain.parseMs;
    const rawSqliteBuild = rawSqlite.openMs;
    const jsonPlusBuild = jsonPlus.buildMs + jsonPlus.openMs;

    // A hidden composite score (build + lookups + write + delete) - never shown
    // in the table, used only to decide column order so the overall fastest
    // backend leads, without breaking each row's per-backend bar color.
    const secretTotal = {
      'Plain JSON': plainBuild + plain.lookupMs + plainWrite.total + plainDelete.total,
      SQLite: rawSqliteBuild + rawSqlite.lookupMs + rawSqliteWrite.total + rawSqliteDelete.total,
      'JSON Plus': jsonPlusBuild + jsonPlus.lookupMs + jsonPlusWrite.total + jsonPlusDelete.total,
    };
    const order = Object.keys(secretTotal).sort((a, b) => secretTotal[a] - secretTotal[b]);

    tbody.innerHTML = '';
    updateHeader(order);
    const buildRow = row(
      'Cache build/open',
      { 'Plain JSON': plainBuild, SQLite: rawSqliteBuild, 'JSON Plus': jsonPlusBuild },
      order,
      { logScale: true },
    );
    const lookupsRow = row(
      'Lookups',
      { 'Plain JSON': plain.lookupMs, SQLite: rawSqlite.lookupMs, 'JSON Plus': jsonPlus.lookupMs },
      order,
    );
    const writeRow = row(
      'Write',
      { 'Plain JSON': plainWrite.total, SQLite: rawSqliteWrite.total, 'JSON Plus': jsonPlusWrite.total },
      order,
    );
    const deleteRow = row(
      'Delete',
      { 'Plain JSON': plainDelete.total, SQLite: rawSqliteDelete.total, 'JSON Plus': jsonPlusDelete.total },
      order,
    );
    tbody.appendChild(buildRow.tr);
    tbody.appendChild(lookupsRow.tr);
    tbody.appendChild(writeRow.tr);
    tbody.appendChild(deleteRow.tr);
    table.style.display = '';

    const speedup = (plain.lookupMs / jsonPlus.lookupMs).toFixed(1);
    statusEl.textContent = `${count.toLocaleString()} records, ${lookups} lookups. JSON Plus cache ${
      jsonPlus.cached ? 'hit' : 'rebuilt (' + jsonPlus.buildMs.toFixed(1) + 'ms)'
    }. JSON Plus is ${speedup}x faster than plain JSON parsing.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    runColdBtn.disabled = false;
  }
}

runBtn.addEventListener('click', () => runBenchmark(false));
runColdBtn.addEventListener('click', () => runBenchmark(true));
