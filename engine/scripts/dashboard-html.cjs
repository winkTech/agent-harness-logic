#!/usr/bin/env node
/**
 * engine/scripts/dashboard-html.cjs — 静态 HTML 仪表盘生成器 (P1)
 *
 * 读取所有数据源，生成自包含 HTML 仪表盘（Chart.js via CDN）。
 * 零外部 Node 依赖。
 *
 * 用法:
 *   node engine/scripts/dashboard-html.cjs generate [output-path]
 *   node engine/scripts/dashboard-html.cjs generate --stdout   # 输出到 stdout
 *   node engine/scripts/dashboard-html.cjs check               # 仅检查数据可用性
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');

// ── 数据加载 ──────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return null;
}

function loadJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function loadSqlite(table, dbPath) {
  try {
    const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
    const wright = openDb();
    if (!wright || !wright.db) return [];
    const rows = wright.db.prepare(`SELECT * FROM ${table} ORDER BY timestamp DESC LIMIT 100`).all();
    return rows || [];
  } catch { return []; }
}

function getDb() {
  try {
    const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
    const wright = openDb();
    return wright && wright.db ? wright.db : null;
  } catch { return null; }
}

function collectData() {
  const data = {};

  // 1. Quality metrics
  data.quality = loadJson(path.join(HOME, 'var', 'quality-metrics.json')) || [];

  // 2. FPR log
  data.fpr = loadJsonl(path.join(HOME, 'var', 'fp-rate-log.jsonl'));

  // 3. Delivery log (file fallback)
  data.delivery = loadJsonl(path.join(HOME, 'var', 'delivery-log.jsonl'));

  // 4. SQLite sources
  const db = getDb();
  if (db) {
    try { data.deliveryEvents = db.prepare('SELECT * FROM delivery_events ORDER BY timestamp DESC LIMIT 100').all(); } catch { data.deliveryEvents = []; }
    try { data.costLedger = db.prepare('SELECT * FROM cost_ledger ORDER BY created_at DESC LIMIT 100').all(); } catch { data.costLedger = []; }
    try { data.eventCounts = db.prepare("SELECT type, COUNT(*) as cnt FROM runtime_events GROUP BY type ORDER BY cnt DESC").all(); } catch { data.eventCounts = []; }
  } else {
    data.deliveryEvents = [];
    data.costLedger = [];
    data.eventCounts = [];
  }

  // 5. Coverage summary
  data.coverage = loadJson(path.join(HOME, 'var', 'coverage', 'coverage-summary.json'));

  return data;
}

// ── HTML 生成 ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateHtml(data) {
  const qualityJSON = escapeHtml(JSON.stringify(data.quality));
  const deliveryJSON = escapeHtml(JSON.stringify(data.deliveryEvents.length > 0 ? data.deliveryEvents : data.delivery));
  const fprJSON = escapeHtml(JSON.stringify(data.fpr));
  const costJSON = escapeHtml(JSON.stringify(data.costLedger));
  const eventJSON = escapeHtml(JSON.stringify(data.eventCounts || []));
  const coverageJSON = escapeHtml(JSON.stringify(data.coverage));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Harness Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
.dash{max-width:1400px;margin:0 auto}
h1{font-size:28px;margin-bottom:8px;color:#f1f5f9}
.sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}
.card h2{font-size:15px;margin-bottom:16px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
.card.full{grid-column:1/-1}
.cht{position:relative;height:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#64748b;font-weight:600;padding:8px 12px;text-align:left;border-bottom:2px solid #334155}
td{padding:8px 12px;border-bottom:1px solid #1e293b}
tr:hover td{background:#334155}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.badge-green{background:#166534;color:#86efac}
.badge-yellow{background:#854d0e;color:#fde68a}
.badge-red{background:#991b1b;color:#fca5a5}
.stat-row{display:flex;gap:16px;margin-bottom:16px}
.stat{flex:1;background:#0f172a;border-radius:8px;padding:16px;text-align:center}
.stat .num{font-size:32px;font-weight:700;color:#f1f5f9}
.stat .lbl{font-size:12px;color:#64748b;margin-top:4px}
.kpi{font-size:12px;color:#475569;margin-bottom:12px}
.kpi span{color:#e2e8f0}</style>
</head>
<body>
<div class="dash">
<h1>🔍 Harness Dashboard</h1>
<p class="sub">Generated: ${new Date().toISOString().slice(0,19).replace('T',' ')} | Session: ${escapeHtml(process.env.CLAUDE_SESSION_ID || 'N/A')}</p>

<div class="stat-row" id="kpiRow"></div>

<div class="grid">
  <div class="card"><h2>📈 Quality Metrics</h2><div class="cht"><canvas id="qualityChart"><\/canvas><\/div><\/div>
  <div class="card"><h2>📦 Delivery Rate</h2><div class="cht"><canvas id="deliveryChart"><\/canvas><\/div><\/div>
<\/div>

<div class="card full"><h2>🚪 Gate FPR</h2><div class="cht"><canvas id="fprChart"><\/canvas><\/div><\/div>

<div class="grid">
  <div class="card"><h2>💰 Cost Trends</h2><div class="cht"><canvas id="costChart"><\/canvas><\/div><\/div>
  <div class="card"><h2>📊 Event Distribution</h2><div class="cht"><canvas id="eventChart"><\/canvas><\/div><\/div>
<\/div>

<div class="card full"><h2>📋 Details</h2>
<div style="overflow-x:auto"><table id="detailTable"><thead><tr><th>Source</th><th>Status</th><th>Records</th><th>Note</th><\/tr><\/thead><tbody><\/tbody><\/table><\/div><\/div>
<\/div>

<script>
const qualityData = JSON.parse('${qualityJSON}');
const deliveryData = JSON.parse('${deliveryJSON}');
const fprData = JSON.parse('${fprJSON}');
const costData = JSON.parse('${costJSON}');
const eventData = JSON.parse('${eventJSON}');
const coverageData = JSON.parse('${coverageJSON}');

// KPI row
const kpiRow = document.getElementById('kpiRow');
function kpi(num, lbl) {
  return '<div class="stat"><div class="num">'+num+'</div><div class="lbl">'+lbl+'</div></div>';
}
let kpiHtml = kpi(qualityData.length || 0, 'Quality Records');
kpiHtml += kpi(deliveryData.length || 0, 'Delivery Events');
kpiHtml += kpi(fprData.length || 0, 'FPR Records');
if (coverageData && coverageData.percent !== undefined) {
  kpiHtml += kpi(coverageData.percent + '%', 'Code Coverage');
}
kpiRow.innerHTML = kpiHtml;

// Quality Chart
if (qualityData.length > 0) {
  const byMetric = {};
  qualityData.forEach(m => {
    if (!byMetric[m.metric]) byMetric[m.metric] = [];
    byMetric[m.metric].push({t: new Date(m.timestamp), v: m.value});
  });
  const datasets = Object.entries(byMetric).slice(0,4).map(([name, pts], i) => ({
    label: name,
    data: pts.sort((a,b) => a.t - b.t),
    borderColor: ['#60a5fa','#34d399','#f472b6','#fbbf24'][i],
    backgroundColor: ['rgba(96,165,250,.1)','rgba(52,211,153,.1)','rgba(244,114,182,.1)','rgba(251,191,36,.1)'][i],
    fill: true,
    tension: .3,
    pointRadius: 2,
  }));
  new Chart(document.getElementById('qualityChart'), {type:'line', data:{datasets}, options:{
    responsive:true, maintainAspectRatio:false,
    scales:{x:{type:'time',time:{unit:'day'},ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
            y:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}}},
    plugins:{legend:{labels:{color:'#94a3b8'}}}
  }});
}

// Delivery Chart
if (deliveryData.length > 0) {
  const byPhase = {};
  deliveryData.forEach(d => {
    const p = d.phase || 'unknown';
    if (!byPhase[p]) byPhase[p] = {pass:0, fail:0, partial:0};
    if (d.status === 'pass') byPhase[p].pass++;
    else if (d.status === 'fail') byPhase[p].fail++;
    else byPhase[p].partial++;
  });
  const labels = Object.keys(byPhase);
  new Chart(document.getElementById('deliveryChart'), {type:'bar', data:{
    labels,
    datasets:[
      {label:'Pass', data:labels.map(l => byPhase[l].pass), backgroundColor:'#34d399'},
      {label:'Fail', data:labels.map(l => byPhase[l].fail), backgroundColor:'#f87171'},
    ]}, options:{
    responsive:true, maintainAspectRatio:false, scales:{x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
    y:{ticks:{color:'#64748b'},grid:{color:'#1e293b'},stacked:true}},
    plugins:{legend:{labels:{color:'#94a3b8'}}}
  }});
}

// FPR Chart
if (fprData.length > 0) {
  const byGate = {};
  fprData.forEach(r => {
    if (!byGate[r.gate]) byGate[r.gate] = {total:0, correct:0};
    byGate[r.gate].total++;
    if (r.correct) byGate[r.gate].correct++;
  });
  const gates = Object.keys(byGate);
  new Chart(document.getElementById('fprChart'), {type:'bar', data:{
    labels: gates,
    datasets: [
      {label:'Correct', data:gates.map(g => byGate[g].correct), backgroundColor:'#34d399'},
      {label:'Incorrect', data:gates.map(g => byGate[g].total - byGate[g].correct), backgroundColor:'#f87171'},
    ]}, options:{
    responsive:true, maintainAspectRatio:false,
    scales:{x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
            y:{ticks:{color:'#64748b'},grid:{color:'#1e293b'},stacked:true}},
    plugins:{legend:{labels:{color:'#94a3b8'}}}
  }});
}

// Cost Chart
if (costData.length > 0) {
  const byDay = {};
  costData.forEach(c => {
    const d = (c.created_at || c.timestamp || '').slice(0,10);
    if (!d) return;
    if (!byDay[d]) byDay[d] = 0;
    byDay[d] += parseFloat(c.cost_credits || c.cost || 0);
  });
  const days = Object.keys(byDay).sort();
  new Chart(document.getElementById('costChart'), {type:'line', data:{
    labels: days,
    datasets: [{label:'Cost (credits)', data:days.map(d => byDay[d]), borderColor:'#fbbf24',
                backgroundColor:'rgba(251,191,36,.1)', fill:true, tension:.3}]
  }, options:{
    responsive:true, maintainAspectRatio:false,
    scales:{x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
            y:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}}},
    plugins:{legend:{labels:{color:'#94a3b8'}}}
  }});
}

// Event Chart
if (eventData.length > 0) {
  new Chart(document.getElementById('eventChart'), {type:'doughnut', data:{
    labels: eventData.map(e => e.type || e.TYPE),
    datasets: [{data: eventData.map(e => e.cnt || e.CNT || e.count), backgroundColor:['#60a5fa','#34d399','#f472b6','#fbbf24','#a78bfa','#fb923c','#38bdf8']}]
  }, options:{
    responsive:true, maintainAspectRatio:false,
    plugins:{legend:{position:'right',labels:{color:'#94a3b8'}}}
  }});
}

// Detail table
const tbody = document.querySelector('#detailTable tbody');
const rows = [
  ['Quality Metrics', qualityData.length > 0 ? '<span class="badge badge-green">OK</span>' : '<span class="badge badge-yellow">Empty</span>', qualityData.length, 'var/quality-metrics.json'],
  ['Delivery Events', deliveryData.length > 0 ? '<span class="badge badge-green">OK</span>' : '<span class="badge badge-yellow">Empty</span>', deliveryData.length, 'SQLite delivery_events / JSONL'],
  ['FPR Log', fprData.length > 0 ? '<span class="badge badge-green">OK</span>' : '<span class="badge badge-yellow">Empty</span>', fprData.length, 'var/fp-rate-log.jsonl'],
  ['Cost Ledger', costData.length > 0 ? '<span class="badge badge-green">OK</span>' : '<span class="badge badge-yellow">Empty</span>', costData.length, 'SQLite cost_ledger'],
  ['Code Coverage', coverageData ? '<span class="badge badge-green">'+coverageData.percent+'%</span>' : '<span class="badge badge-yellow">N/A</span>', coverageData ? coverageData.files+' files' : '-', 'var/coverage/coverage-summary.json'],
];
rows.forEach(r => {
  const tr = document.createElement('tr');
  r.forEach(c => { const td = document.createElement('td'); td.innerHTML = c; tr.appendChild(td); });
  tbody.appendChild(tr);
});
<\/script>
</body>
</html>`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2] || 'generate';

  if (cmd === 'check') {
    const data = collectData();
    let total = 0, available = 0;
    for (const [key, val] of Object.entries(data)) {
      const count = Array.isArray(val) ? val.length : (val ? 1 : 0);
      total++;
      if (count > 0) available++;
      console.log(`  ${key.padEnd(20)} ${count > 0 ? '✅' : '⬜'} ${Array.isArray(val) ? count + ' records' : 'present'}`);
    }
    console.log(`\n  数据源: ${available}/${total} 可用`);
    return;
  }

  if (cmd === 'generate') {
    const data = collectData();
    const html = generateHtml(data);

    const stdoutFlag = process.argv.includes('--stdout');
    if (stdoutFlag) {
      console.log(html);
      return;
    }

    const outputPath = process.argv[3] || path.join(HOME, 'var', 'dashboard.html');
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, html, 'utf8');
    console.log(`[dashboard] ✅ 仪表盘已生成: ${outputPath}`);
    console.log(`[dashboard]   大小: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

    // 尝试自动打开
    try {
      const { spawn } = require('node:child_process');
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', outputPath], { detached: true, stdio: 'ignore' });
        console.log(`[dashboard]   已在浏览器中打开`);
      }
    } catch {}
    return;
  }

  console.log(`
用法:
  node engine/scripts/dashboard-html.cjs generate [output-path]  # 生成 HTML 仪表盘
  node engine/scripts/dashboard-html.cjs generate --stdout       # 输出到 stdout
  node engine/scripts/dashboard-html.cjs check                   # 检查数据可用性
`);
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

main();
