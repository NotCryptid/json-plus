const runBtn = document.getElementById('run');
const runColdBtn = document.getElementById('runCold');
const statusEl = document.getElementById('status');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');

function row(label, plainMs, rawSqliteMs, jsonPlusMs, maxMs) {
  const tr = document.createElement('tr');
  tr.className = 'bar-row';

  const labelTd = document.createElement('td');
  labelTd.textContent = label;

  const plainTd = document.createElement('td');
  plainTd.textContent = plainMs.toFixed(2);

  const rawSqliteTd = document.createElement('td');
  rawSqliteTd.textContent = rawSqliteMs.toFixed(2);
  if (rawSqliteMs < plainMs && rawSqliteMs < jsonPlusMs) rawSqliteTd.classList.add('winner');

  const jpTd = document.createElement('td');
  jpTd.textContent = jsonPlusMs.toFixed(2);
  if (jsonPlusMs < plainMs && jsonPlusMs < rawSqliteMs) jpTd.classList.add('winner');

  const barTd = document.createElement('td');
  const plainBar = document.createElement('div');
  plainBar.className = 'bar plain';
  plainBar.style.width = `${(plainMs / maxMs) * 100}%`;
  const rawBar = document.createElement('div');
  rawBar.className = 'bar';
  rawBar.style.width = `${(rawSqliteMs / maxMs) * 100}%`;
  rawBar.style.marginTop = '4px';
  rawBar.style.opacity = '0.7';
  const jpBar = document.createElement('div');
  jpBar.className = 'bar';
  jpBar.style.width = `${(jsonPlusMs / maxMs) * 100}%`;
  jpBar.style.marginTop = '4px';
  barTd.append(plainBar, rawBar, jpBar);

  tr.append(labelTd, plainTd, rawSqliteTd, jpTd, barTd);
  return tr;
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
    tbody.appendChild(row('Lookups (lookup only)', plain.lookupMs, rawSqlite.lookupMs, jsonPlus.lookupMs, maxMs));
    tbody.appendChild(row('Total (with cache/parse)', plain.total, jsonPlus.buildMs + jsonPlus.openMs + rawSqlite.lookupMs, jsonPlus.total, maxMs));
    table.style.display = '';

    const speedup = (plain.total / jsonPlus.total).toFixed(1);
    const proxyOverhead = (jsonPlus.lookupMs / rawSqlite.lookupMs).toFixed(2);
    statusEl.textContent = `${count.toLocaleString()} records, ${lookups} lookups. json-plus cache ${
      jsonPlus.cached ? 'hit' : 'rebuilt (' + jsonPlus.buildMs.toFixed(1) + 'ms)'
    }. json-plus is ${speedup}x faster overall. Proxy adds ${proxyOverhead}x lookup overhead vs raw SQL.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    runColdBtn.disabled = false;
  }
}

runBtn.addEventListener('click', () => runBenchmark(false));
runColdBtn.addEventListener('click', () => runBenchmark(true));
