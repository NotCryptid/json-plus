const runBtn = document.getElementById('run');
const runColdBtn = document.getElementById('runCold');
const statusEl = document.getElementById('status');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');

function row(label, plainMs, jsonPlusMs, maxMs) {
  const tr = document.createElement('tr');
  tr.className = 'bar-row';

  const labelTd = document.createElement('td');
  labelTd.textContent = label;

  const plainTd = document.createElement('td');
  plainTd.textContent = plainMs.toFixed(2);

  const jpTd = document.createElement('td');
  jpTd.textContent = jsonPlusMs.toFixed(2);
  if (jsonPlusMs < plainMs) jpTd.classList.add('winner');

  const barTd = document.createElement('td');
  const plainBar = document.createElement('div');
  plainBar.className = 'bar plain';
  plainBar.style.width = `${(plainMs / maxMs) * 100}%`;
  const jpBar = document.createElement('div');
  jpBar.className = 'bar';
  jpBar.style.width = `${(jsonPlusMs / maxMs) * 100}%`;
  jpBar.style.marginTop = '4px';
  barTd.append(plainBar, jpBar);

  tr.append(labelTd, plainTd, jpTd, barTd);
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

    const { plain, jsonPlus, count } = data;
    const maxMs = Math.max(plain.total, jsonPlus.total, 1);

    tbody.innerHTML = '';
    tbody.appendChild(row('Parse / open', plain.parseMs, jsonPlus.buildMs + jsonPlus.openMs, maxMs));
    tbody.appendChild(row('Lookups', plain.lookupMs, jsonPlus.lookupMs, maxMs));
    tbody.appendChild(row('Total', plain.total, jsonPlus.total, maxMs));
    table.style.display = '';

    const speedup = (plain.total / jsonPlus.total).toFixed(1);
    statusEl.textContent = `${count.toLocaleString()} records, ${lookups} lookups. json-plus cache ${
      jsonPlus.cached ? 'hit' : 'rebuilt (' + jsonPlus.buildMs.toFixed(1) + 'ms)'
    }. json-plus is ${speedup}x ${jsonPlus.total < plain.total ? 'faster' : 'slower'} overall.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    runColdBtn.disabled = false;
  }
}

runBtn.addEventListener('click', () => runBenchmark(false));
runColdBtn.addEventListener('click', () => runBenchmark(true));
