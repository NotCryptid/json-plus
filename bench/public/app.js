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

function row(label, plainMs, rawSqliteMs, jsonPlusMs, maxMs) {
  const tr = document.createElement('tr');
  tr.className = 'bar-row';

  const labelTd = document.createElement('td');
  labelTd.textContent = label;

  const results = [
    { name: 'Plain JSON', ms: plainMs, isPlain: true },
    { name: 'SQLite', ms: rawSqliteMs, isPlain: false },
    { name: 'JSON Plus', ms: jsonPlusMs, isPlain: false }
  ];
  results.sort((a, b) => a.ms - b.ms);

  const cells = [labelTd];
  const bars = [];

  for (const result of results) {
    const td = document.createElement('td');
    td.textContent = result.ms.toFixed(2);
    if (result.ms === Math.min(plainMs, rawSqliteMs, jsonPlusMs)) {
      td.classList.add('winner');
    }
    cells.push(td);

    const bar = document.createElement('div');
    bar.className = barClass(result.name);
    bar.style.width = `${(result.ms / maxMs) * 100}%`;
    if (!result.isPlain) bar.style.opacity = '0.7';
    if (bars.length > 0) bar.style.marginTop = '4px';
    bars.push(bar);
  }

  const barTd = document.createElement('td');
  barTd.append(...bars);
  cells.push(barTd);

  tr.append(...cells);
  return { tr, order: results.map((r) => r.name) };
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

    const { plain, jsonPlus, rawSqlite, count } = data;
    const maxMs = Math.max(plain.total, jsonPlus.total, rawSqlite.lookupMs, 1);

    tbody.innerHTML = '';
    const lookupsRow = row('Lookups (lookup only)', plain.lookupMs, rawSqlite.lookupMs, jsonPlus.lookupMs, maxMs);
    const totalRow = row('Total (with cache/parse)', plain.total, jsonPlus.buildMs + jsonPlus.openMs + rawSqlite.lookupMs, jsonPlus.total, maxMs);
    updateHeader(lookupsRow.order);
    tbody.appendChild(lookupsRow.tr);
    tbody.appendChild(totalRow.tr);
    table.style.display = '';

    const speedup = (plain.total / jsonPlus.total).toFixed(1);
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
