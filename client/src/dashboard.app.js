/* ============================================================================
 * Inventory Intelligence — dashboard logic (ported verbatim from the original
 * single-file HTML build). Behavior and UI are unchanged. The only edits vs the
 * original are: (a) the dataset `D` is loaded from MongoDB via the backend API
 * instead of an inline const, and (b) the Anthropic + Google Sheets network
 * calls are routed through the Express backend. Everything else is identical.
 * ========================================================================== */
/* eslint-disable */
const D = window.__DATA__;
const Chart = window.Chart;
const XLSX = window.XLSX;


// Persist the current in-memory dataset D (with all uploaded data applied) back
// into MongoDB's main `datasets` document, so the database is the single source
// of truth and uploads show up on every device — not just this browser.
// Debounced so a burst of uploads only writes once.
let _persistTimer = null;
function persistDatasetToMongo() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    try {
      fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(D),
      }).then(r => { if (!r.ok) console.warn('[persist] save failed HTTP', r.status); })
        .catch(e => console.warn('[persist] save error', e));
    } catch (e) { console.warn('[persist] save threw', e); }
  }, 400);
}

const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN');
const fmtCompact = (n) => (n == null || n === 0) ? null : Number(n).toLocaleString('en-IN');
const fmtDays = (n) => n == null ? '—' : (n >= 999 ? '∞' : Math.round(n));
const fmtMonthsSinceSale = (n) => n == null ? '—' : (n >= 13 ? '13+' : n);

// ===== Processing loader (shown while an uploaded file is parsed/cleaned and the dashboard rebuilt) =====
function showLoader(msg) {
  const el = document.getElementById('processingOverlay');
  if (!el) return;
  const m = document.getElementById('processingMsg');
  if (m) m.textContent = msg || 'Processing…';
  el.style.display = 'flex';
}
function hideLoader() {
  const el = document.getElementById('processingOverlay');
  if (el) el.style.display = 'none';
}
// Show the loader, let the browser paint it (double rAF) BEFORE starting the heavy synchronous
// parse/rebuild that would otherwise block the first paint, then run `work` (may return a promise).
function runWithLoader(msg, work) {
  showLoader(msg);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    Promise.resolve().then(work).catch(err => { console.error(err); }).finally(hideLoader);
  }));
}

const STATUS = D.statusCodes;
const MOVERS = D.moverCodes;
const PRIORITIES = D.priorityCodes;
const ABCS = D.abcCodes;
const VARIANTS = D.variants;

const statusClass = (s) => ({'Critical':'critical','Low Stock':'low','Healthy':'healthy','Adequate':'adequate','Overstocked':'overstocked','Dead Stock':'dead','Inactive':'inactive'}[s] || 'inactive');
const moverClass = (s) => s.startsWith('Non-Moving') ? 'critical' : s.startsWith('Slow') ? 'low' : s.startsWith('Sluggish') ? 'overstocked' : s === 'No Stock' ? 'dead' : 'healthy';
const priorityClass = (p) => p && p.startsWith('P1') ? 'critical' : p && p.startsWith('P2') ? 'low' : p && p.startsWith('P3') ? 'adequate' : 'inactive';

// Build a parent-name -> base for child code reconstruction
function parentCodeBase(name) {
  return (name || '').substring(0, 8).split('').filter(c => /[A-Z0-9]/i.test(c)).join('').toUpperCase() || 'PRT';
}

// Track manual reorder edits (parentId -> qty)
const reorderEdits = {};
// Master mapping override (parentId -> {parentCode, children:[{code, folder, variant}]})
let masterOverride = null;

// ===== Real-data mode =====
// When the user uploads a RAW Product Master, we stop overlaying the synthetic demo catalog and
// instead BUILD the whole dataset `D` from their uploads. This holds the cleaned inputs the
// rebuild pipeline consumes; sales/purchase are kept as full month-keyed maps so the 24-month
// window can shift to the latest data. Upsert semantics: re-uploading a month overwrites it.
let realDataMode = false;
const realData = {
  masterMap: null,     // parentId -> { parentCode, vendorName, categoryName, productType, parentLaunchDate, children:[{code,launchDate}] }
  salesByMonth: {},    // UPPER(parentCode) -> { 'yyyy-mm': qty }
  purchByMonth: {},    // UPPER(parentCode) -> { 'yyyy-mm': qty }
  stockByCode: {},     // UPPER(parentCode) -> { k, it, po }
};
// Merge a per-file month map into a running store, overwriting months present in the new file
// (same month → replace) and keeping the rest (new month → merge).
function mergeMonthMaps(target, incoming) {
  Object.keys(incoming || {}).forEach(code => {
    if (!target[code]) target[code] = {};
    Object.assign(target[code], incoming[code]);
  });
}
// Folder → zone mapping. Each folder is either: in N specific zones (1..6), OPEN to all, or UNCLASSIFIED (no entry).
//   folderZones['Coats']   = { zones: [1, 3], openToAll: false }
//   folderZones['Trims']   = { zones: [],     openToAll: true  }
//   No entry              → unclassified
let folderZones = {};

// Try to load saved overrides from localStorage
try {
  const savedMaster = localStorage.getItem('inventoryMasterOverride');
  if (savedMaster) {
    masterOverride = JSON.parse(savedMaster);
  }
  const savedEdits = localStorage.getItem('inventoryReorderEdits');
  if (savedEdits) {
    Object.assign(reorderEdits, JSON.parse(savedEdits));
  }
  const savedZones = localStorage.getItem('inventoryFolderZones');
  if (savedZones) {
    folderZones = JSON.parse(savedZones) || {};
  }
} catch (e) { console.warn('localStorage not available', e); }

function saveFolderZones() {
  try { localStorage.setItem('inventoryFolderZones', JSON.stringify(folderZones)); } catch (e) {}
}

// Parent launch dates — keyed by parent_code (uppercase, trimmed). Populated from the master CSV.
// Dummy dates auto-generated for parents not in the CSV so the dashboard always has something to show.
const parentLaunchDates = {};
try {
  const savedPL = localStorage.getItem('inventoryParentLaunchDates');
  if (savedPL) Object.assign(parentLaunchDates, JSON.parse(savedPL) || {});
} catch (e) {}
function saveParentLaunchDates() {
  try { localStorage.setItem('inventoryParentLaunchDates', JSON.stringify(parentLaunchDates)); } catch (e) {}
}
// Product Type per parent — keyed by parent_code (uppercase, trimmed). Populated from the raw
// Product Master. Kept as its own field (NOT the sub-category) so the UI can surface it separately.
const parentProductTypes = {};
try {
  const savedPT = localStorage.getItem('inventoryParentProductTypes');
  if (savedPT) Object.assign(parentProductTypes, JSON.parse(savedPT) || {});
} catch (e) {}
function saveParentProductTypes() {
  try { localStorage.setItem('inventoryParentProductTypes', JSON.stringify(parentProductTypes)); } catch (e) {}
}
function getParentProductType(p) {
  if (!p) return '';
  const key = (p.n || '').toUpperCase().trim();
  return parentProductTypes[key] || '';
}
// ProductId → parent Product Name (identity code) index. Built from the raw Product Master
// (every ProductId, parent or child, maps to its parent's Product Name). Lets the raw Purchase /
// Sales cleaners resolve a transaction's numeric PID to the parent code the dashboard matches on.
const productIdToParentCode = {};
try {
  const savedIdx = localStorage.getItem('inventoryProductIdParentIndex');
  if (savedIdx) Object.assign(productIdToParentCode, JSON.parse(savedIdx) || {});
} catch (e) {}
function saveProductIdIndex() {
  try { localStorage.setItem('inventoryProductIdParentIndex', JSON.stringify(productIdToParentCode)); } catch (e) {}
}
function getParentLaunchDate(p) {
  if (!p) return '';
  const key = (p.n || '').toUpperCase().trim();
  if (parentLaunchDates[key]) return parentLaunchDates[key];
  // Auto-fill dummy date so the UI always has something to show — derived from product code (deterministic)
  return dummyChildLaunchDate('PARENT_' + key);
}

// Get a folder's zone classification — returns { zones, openToAll, unclassified }
function getFolderZones(folderName) {
  if (!folderName) return { zones: [], openToAll: false, unclassified: true };
  const e = folderZones[folderName];
  if (!e) return { zones: [], openToAll: false, unclassified: true };
  if (e.openToAll) return { zones: [], openToAll: true, unclassified: false };
  const zs = (e.zones || []).filter(z => z >= 1 && z <= 6).sort((a, b) => a - b);
  return { zones: zs, openToAll: false, unclassified: zs.length === 0 };
}

// Render a small HTML pill for a folder's zone(s)
function zoneBadgeHtml(folderName) {
  const z = getFolderZones(folderName);
  if (z.openToAll)    return `<span class="zone-tag open" title="${folderName} is open to all zones">OPEN</span>`;
  if (z.unclassified) return `<span class="zone-tag unc" title="${folderName} is not yet classified into a zone">?</span>`;
  return `<span class="zone-tag zoned" title="${folderName} is in zone${z.zones.length > 1 ? 's' : ''} ${z.zones.join(', ')}">Z${z.zones.join(',')}</span>`;
}

// Parse a raw zone string like "1,3" / "all" / "open" / "1 3 5" / ""
// Returns { zones: number[], openToAll: bool, hasContent: bool }
function parseZoneString(raw) {
  const out = { zones: [], openToAll: false, hasContent: false };
  if (!raw) return out;
  const s = String(raw).trim().toLowerCase();
  if (!s) return out;
  out.hasContent = true;
  if (s === 'all' || s === 'open' || s === 'any') { out.openToAll = true; return out; }
  if (s === 'unclassified' || s === 'none' || s === '0' || s === '-') return out;
  s.split(/[\s,;\/|]+/).forEach(t => {
    const m = t.match(/(\d+)/);
    if (!m) return;
    const n = parseInt(m[1]);
    if (n >= 1 && n <= 6 && !out.zones.includes(n)) out.zones.push(n);
  });
  return out;
}

// Display-side date formatter — user prefers dd-mm-yy across the dashboard.
// Storage stays ISO (yyyy-mm-dd) for parser portability; only the rendered output uses dd-mm-yy.
function formatDate(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  if (!s) return '';
  // If the string is already short dd-mm-yy / dd/mm/yy, normalise the separator and return
  const shortMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (shortMatch) {
    const d = shortMatch[1].padStart(2, '0');
    const m = shortMatch[2].padStart(2, '0');
    const y = shortMatch[3].length === 4 ? shortMatch[3].slice(-2) : shortMatch[3].padStart(2, '0');
    return `${d}-${m}-${y}`;
  }
  // Try parsing
  let d = new Date(s);
  if (isNaN(d.getTime())) {
    const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else return s;  // give up, return as-is
  }
  if (isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

// How many months ago a date is, relative to the dashboard's anchor (report date).
// Returns null if the date is unparseable; 0 if the date is in the future or this month.
function monthsSinceLaunch(dateStr) {
  if (!dateStr) return null;
  // Try direct Date parse first; if it fails, try YYYY-MM-DD-ish manual parse
  let d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    const m = String(dateStr).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else return null;
  }
  if (isNaN(d.getTime())) return null;
  // Anchor "today" to the report date used elsewhere in the dashboard (May 13, 2026)
  const anchor = new Date(2026, 4, 13);
  let months = (anchor.getFullYear() - d.getFullYear()) * 12 + (anchor.getMonth() - d.getMonth());
  if (anchor.getDate() < d.getDate()) months -= 1;  // not yet a full month
  return Math.max(0, months);
}

// Build the HTML for the launch-date badge. Shows "{N}M · {dd-mm-yy}" with the months count and date.
function launchDateBadgeHtml(dateStr) {
  if (!dateStr) return '';
  const months = monthsSinceLaunch(dateStr);
  const ageLabel = (months == null)
    ? ''
    : (months === 0 ? 'new' : months >= 36 ? '36M+' : `${months}M`);
  const displayDate = formatDate(dateStr);
  const title = (months == null)
    ? `Child code launched / added on ${displayDate}`
    : `Child code launched / added on ${displayDate} — ${months === 0 ? 'this month' : months + ' month' + (months > 1 ? 's' : '') + ' ago'}`;
  return `<span class="launch-date" title="${title}">${ageLabel ? `<strong>${ageLabel}</strong> · ` : ''}${displayDate}</span>`;
}

// Deterministic dummy launch/added date for a child code.
// Spreads child codes across the last ~36 months ending today so the dashboard has visible variety.
// Same code → same date every reload. Once the user uploads a real child_launch_date column, that overrides.
function dummyChildLaunchDate(code) {
  if (!code) return '';
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 16777619); }
  h = h >>> 0;
  // Pick a month offset 0..35 (i.e. up to 3 years back). Use day 1..28 inside that month.
  const monthsBack = h % 36;
  const day = 1 + ((h >>> 7) % 28);
  // Anchor "today" to the data window so dates look consistent with the 24-month cells.
  // The dataset's most recent month is Apr-26 → take anchor = 2026-05-13 (report date).
  const anchor = new Date(2026, 4, 13);  // May = month index 4
  const d = new Date(anchor);
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  d.setDate(day);
  return d.toISOString().slice(0, 10);
}

function getProductChildren(p) {
  if (masterOverride && masterOverride[p.i]) {
    // Pass through but synthesize a launchDate if not present
    return masterOverride[p.i].children.map(ch => Object.assign({}, ch, {
      launchDate: ch.launchDate || dummyChildLaunchDate(ch.code),
    }));
  }
  // Reconstruct from compact form
  const base = parentCodeBase(p.n);
  return p.ch.map(([suffix, folderIdx, variantIdx]) => {
    const code = base + '-' + suffix;
    return {
      code: code,
      folder: D.folders[folderIdx == null ? p.fl : folderIdx],
      variant: VARIANTS[variantIdx],
      launchDate: dummyChildLaunchDate(code),
    };
  });
}

// Default reorder qty for a manually-added product = max(2 × avg monthly, 5)
function defaultManualQty(p) {
  return Math.max(Math.round(p.m * 2), 5);
}

function getReorderQty(p) {
  // User-driven workflow: every order quantity starts at 0 and must be typed in.
  // The system-suggested value (p.nr) is still visible as a hint in the UI
  // (rendered in the strikethrough "suggested" text), but it's NOT auto-applied.
  if (reorderEdits[p.i] != null) return reorderEdits[p.i];
  return 0;
}

// System-suggested qty (used purely for display as a reference — never auto-filled).
function getSuggestedQty(p) {
  if (typeof manualReorderIds !== 'undefined' && manualReorderIds.has(p.i) && !(p.r > 0)) {
    return defaultManualQty(p);
  }
  return p.nr || 0;
}

function getEditCount() {
  return Object.keys(reorderEdits).filter(k => reorderEdits[k] !== null).length;
}

function saveEdits() {
  try { localStorage.setItem('inventoryReorderEdits', JSON.stringify(reorderEdits)); } catch (e) {}
}

// ===== KPI cards + insights + charts =====
// Wrapped in renderHeaderAndCharts() so a rebuild from uploaded data can refresh them in place
// (they otherwise render only once at load and are NOT touched by rerender()).
const tooltipStyle = () => ({ backgroundColor: '#1c1c22', titleColor: '#fff', bodyColor: '#a8a8b3', borderColor: '#34343e', borderWidth: 1, padding: 12, displayColors: true, titleFont: { family: 'JetBrains Mono', size: 11 }, bodyFont: { family: 'Inter', size: 12 } });

// Chart.js instances kept so we can destroy + recreate on rebuild (a new Chart on a canvas
// already in use throws "Canvas is already in use").
const _dashCharts = {};
function safeChart(elemId, config) {
  try {
    if (typeof Chart === 'undefined') {
      const el = document.getElementById(elemId);
      if (el && el.parentElement) el.parentElement.innerHTML = '<div style="color:var(--text-3);font-family:var(--mono);font-size:11px;text-align:center;padding:60px 20px;">Chart library failed to load. Tables and totals are unaffected.</div>';
      return;
    }
    return new Chart(document.getElementById(elemId), config);
  } catch (err) {
    console.error('Chart failed for ' + elemId + ':', err);
  }
}

function renderHeaderAndCharts() {
  const k = D.kpi || {};
  const M = D.months || [];
  const salesWindowSub = M.length >= 12 ? `${M[M.length - 12]} — ${M[M.length - 1]}` : (M.length ? `${M[0]} — ${M[M.length - 1]}` : '');
  const kpiHtml = [
    { label: 'Parents · Children', value: fmt(k.totalProducts) + ' · ' + fmt(k.totalChildren), sub: k.totalFolders + ' folders · ' + k.totalCategories + ' categories', cls: '' },
    { label: 'Annual sales (units)', value: fmt(k.annualSales), sub: salesWindowSub, cls: 'good' },
    { label: 'On hand · Pipeline', value: fmt(k.totalStock), sub: '+' + fmt(k.inTransitTotal) + ' transit · +' + fmt(k.pendingTotal) + ' pending', cls: 'info' },
    { label: 'Class A SKUs', value: fmt(k.classACount), sub: '80% of revenue · ' + (k.totalProducts ? Math.round(k.classACount/k.totalProducts*100) : 0) + '% of SKUs', cls: 'info' },
    { label: 'Net reorder need', value: fmt(k.netReorderQty), sub: fmt(k.netReorderProducts) + ' SKUs · saved ' + fmt(k.reorderSavedByPipeline) + ' from pipeline', cls: 'warn' },
    { label: 'Critical stock', value: fmt(k.criticalCount), sub: 'less than 15 days cover · ' + fmt(k.criticalImprovedCount) + ' covered by pipeline', cls: 'danger' },
    { label: 'Bulk-order anomalies', value: fmt(k.bulkAnomalyCount), sub: 'unusual purchase spikes', cls: 'warn' },
    { label: 'Slow / Non-moving', value: fmt(k.slowMoverCount), sub: fmt(k.nonMovingUnits) + ' units stuck', cls: 'danger' },
  ];
  document.getElementById('kpis').innerHTML = kpiHtml.map((x, i) =>
    `<div class="kpi ${x.cls} reveal reveal-${(i % 3) + 1}">
      <div class="kpi-label">${x.label}</div>
      <div class="kpi-value">${x.value}</div>
      <div class="kpi-sub">${x.sub}</div>
    </div>`).join('');

  document.getElementById('aggInsightText').innerHTML =
    `Across all SKUs, total purchases of <strong>${fmt(D.aggP.reduce((a,b)=>a+b,0))}</strong> units against sales of <strong>${fmt(D.aggS.reduce((a,b)=>a+b,0))}</strong> units in 24 months. Class A drives <strong>${fmt(k.classASales)}</strong> units (<strong>${k.annualSales ? Math.round(k.classASales/k.annualSales*100) : 0}%</strong>) from just <strong>${fmt(k.classACount)}</strong> SKUs.`;

  document.getElementById('actionInsightText').innerHTML =
    `<strong>${fmt(k.criticalCount)}</strong> critical-stock SKUs detected — but <strong>${fmt(k.criticalImprovedCount)}</strong> of those have stock already in transit or pending at factory. Net reorder need after accounting for pipeline: <strong>${fmt(k.netReorderQty)}</strong> units across <strong>${fmt(k.netReorderProducts)}</strong> SKUs (saved <strong>${fmt(k.reorderSavedByPipeline)}</strong> units of double-ordering). <strong>${fmt(k.bulkAnomalyCount)}</strong> SKUs show bulk-purchase spikes worth reviewing.`;

  // Destroy existing chart instances before recreating (canvas-reuse guard)
  ['agg', 'status', 'abc', 'mover'].forEach(id => { const c = _dashCharts[id]; if (c) { try { c.destroy(); } catch (e) {} } _dashCharts[id] = null; });

  _dashCharts.agg = safeChart('aggChart', {
    data: {
      labels: D.months,
      datasets: [
        { type: 'bar', label: 'Purchases', data: D.aggP, backgroundColor: 'rgba(255, 92, 58, 0.55)', borderColor: 'rgba(255, 92, 58, 0.85)', borderWidth: 1, order: 2 },
        { type: 'line', label: 'Sales', data: D.aggS, borderColor: '#d4ff3a', backgroundColor: 'rgba(212,255,58,0.08)', borderWidth: 2.5, tension: 0.3, fill: true, pointRadius: 3, pointBackgroundColor: '#d4ff3a', pointBorderWidth: 0, order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#a8a8b3', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 } }, tooltip: tooltipStyle() },
      scales: {
        x: { grid: { color: '#1c1c22' }, ticks: { color: '#6b6b78', font: { family: 'JetBrains Mono', size: 10 } } },
        y: { grid: { color: '#1c1c22' }, ticks: { color: '#6b6b78', font: { family: 'JetBrains Mono', size: 10 }, callback: v => (v/1000).toFixed(0)+'k' }, beginAtZero: true }
      }
    }
  });

  const statusOrder = STATUS.filter(s => s !== 'Inactive');
  const statusColors = { 'Critical':'#ff4a5c','Low Stock':'#ffa83a','Healthy':'#3affb6','Adequate':'#5cabff','Overstocked':'#b88aff','Dead Stock':'#6b6b78','Inactive':'#34343e' };
  const statusCount = {};
  D.products.forEach(p => { const s = STATUS[p.st]; statusCount[s] = (statusCount[s] || 0) + 1; });
  _dashCharts.status = safeChart('statusChart', {
    type: 'doughnut',
    data: { labels: statusOrder, datasets: [{ data: statusOrder.map(s => statusCount[s] || 0), backgroundColor: statusOrder.map(s => statusColors[s]), borderWidth: 0, hoverOffset: 8 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: '#a8a8b3', font: { family: 'JetBrains Mono', size: 9 }, boxWidth: 10, padding: 10 } },
        tooltip: { ...tooltipStyle(), callbacks: { label: c => c.label + ': ' + fmt(c.raw) } } } }
  });

  _dashCharts.abc = safeChart('abcChart', {
    type: 'doughnut',
    data: { labels: ['Class A', 'Class B', 'Class C'], datasets: [{ data: [k.classACount, k.classBCount, k.classCCount], backgroundColor: ['#d4ff3a', 'rgba(212,255,58,0.45)', '#34343e'], borderWidth: 0, hoverOffset: 8 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: '#a8a8b3', font: { family: 'JetBrains Mono', size: 9 }, boxWidth: 10, padding: 10 } },
        tooltip: { ...tooltipStyle(), callbacks: { label: c => c.label + ': ' + fmt(c.raw) + ' SKUs' } } } }
  });

  const moverOrder = ['Active', 'Sluggish (3-6m)', 'Slow (6-12m)', 'Non-Moving (12m+)', 'No Stock'];
  const moverCount = {};
  D.products.forEach(p => { const m = MOVERS[p.mv]; moverCount[m] = (moverCount[m] || 0) + 1; });
  const moverColors = { 'Active':'#3affb6', 'Sluggish (3-6m)':'#ffa83a', 'Slow (6-12m)':'#ff5c3a', 'Non-Moving (12m+)':'#ff4a5c', 'No Stock':'#6b6b78' };
  _dashCharts.mover = safeChart('moverChart', {
    type: 'doughnut',
    data: { labels: moverOrder, datasets: [{ data: moverOrder.map(m => moverCount[m] || 0), backgroundColor: moverOrder.map(m => moverColors[m]), borderWidth: 0, hoverOffset: 8 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: '#a8a8b3', font: { family: 'JetBrains Mono', size: 9 }, boxWidth: 10, padding: 10 } },
        tooltip: { ...tooltipStyle(), callbacks: { label: c => c.label + ': ' + fmt(c.raw) + ' SKUs' } } } }
  });
}
renderHeaderAndCharts();

// ===== Filters setup =====
// Wrap the category + vendor datalists in a refresher so they update after Master sync.
function refreshFilterDatalists() {
  const catList = document.getElementById('catList');
  if (catList) {
    catList.innerHTML = '';
    (D.cats || []).forEach((c) => {
      if (!c) return;
      const opt = document.createElement('option');
      opt.value = c;
      catList.appendChild(opt);
    });
  }
  const vendorList = document.getElementById('vendorList');
  if (vendorList) {
    vendorList.innerHTML = '';
    (D.vendors || []).forEach((v) => {
      if (!v) return;
      const opt = document.createElement('option');
      opt.value = v.name ? `${v.code} — ${v.name}` : v.code;
      vendorList.appendChild(opt);
    });
  }
  const folderList = document.getElementById('folderList');
  if (folderList) {
    folderList.innerHTML = '';
    (D.folders || []).forEach((f) => {
      if (!f) return;
      const opt = document.createElement('option');
      opt.value = f;
      folderList.appendChild(opt);
    });
  }
}
refreshFilterDatalists();

// All-products datalist for manual-add search
const allProductsList = document.getElementById('allProductsList');
D.products.slice(0, 3000).forEach(p => {
  const opt = document.createElement('option');
  opt.value = p.n;
  allProductsList.appendChild(opt);
});

// ABC toggles
document.querySelectorAll('#abcToggles .ms-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = parseInt(btn.dataset.val);
    if (selFilters.abc.has(v)) selFilters.abc.delete(v); else selFilters.abc.add(v);
    btn.classList.toggle('active');
    document.getElementById('abcCount').textContent = selFilters.abc.size ? `(${selFilters.abc.size})` : '';
    currentPage = 0; reorderPage = 0;
    rerender();
  });
});

// Status toggles (built dynamically from STATUS codes)
const statusToggles = document.getElementById('statusToggles');
STATUS.forEach((s, i) => {
  const btn = document.createElement('button');
  btn.className = 'ms-toggle';
  btn.dataset.val = i;
  btn.textContent = s;
  btn.addEventListener('click', () => {
    if (selFilters.status.has(i)) selFilters.status.delete(i); else selFilters.status.add(i);
    btn.classList.toggle('active');
    _updateStatusCount();
    currentPage = 0; reorderPage = 0;
    rerender();
  });
  statusToggles.appendChild(btn);
});

// Virtual-status toggles: Discontinued + PNA — overlay filters on top of the regular STATUS set
function _updateStatusCount() {
  const n = selFilters.status.size + selFilters.virtualStatus.size;
  document.getElementById('statusCount').textContent = n ? `(${n})` : '';
}
[
  { key: 'disc', label: 'Discontinued', title: 'Show only SKUs marked as Discontinued' },
  { key: 'pna',  label: 'PNA',          title: 'Show only SKUs where Paper Not Available is set' },
].forEach(opt => {
  const btn = document.createElement('button');
  btn.className = 'ms-toggle';
  btn.dataset.val = opt.key;
  btn.textContent = opt.label;
  btn.title = opt.title;
  btn.addEventListener('click', () => {
    if (selFilters.virtualStatus.has(opt.key)) selFilters.virtualStatus.delete(opt.key);
    else selFilters.virtualStatus.add(opt.key);
    btn.classList.toggle('active');
    _updateStatusCount();
    currentPage = 0; reorderPage = 0;
    rerender();
  });
  statusToggles.appendChild(btn);
});

// Category multi-select (input + chips)
function addCatChip(catName) {
  const v = (catName || '').trim();
  if (!v) return false;
  // Case-insensitive: try exact match, then prefix match
  const target = v.toLowerCase();
  let idx = (D.cats || []).findIndex(c => (c || '').toLowerCase() === target);
  if (idx < 0) idx = (D.cats || []).findIndex(c => (c || '').toLowerCase().startsWith(target));
  if (idx < 0 || selFilters.cat.has(idx)) return false;
  selFilters.cat.add(idx);
  renderCatChips();
  document.getElementById('catCount').textContent = selFilters.cat.size ? `(${selFilters.cat.size})` : '';
  return true;
}
function renderCatChips() {
  const chips = [...selFilters.cat].map(idx => `
    <span class="ms-chip"><span class="lbl" title="${D.cats[idx]}">${D.cats[idx]}</span><button data-cat-idx="${idx}" type="button">×</button></span>
  `).join('');
  document.getElementById('catChips').innerHTML = chips;
  document.querySelectorAll('#catChips .ms-chip button').forEach(b => {
    b.addEventListener('click', () => {
      selFilters.cat.delete(parseInt(b.dataset.catIdx));
      renderCatChips();
      document.getElementById('catCount').textContent = selFilters.cat.size ? `(${selFilters.cat.size})` : '';
      currentPage = 0; reorderPage = 0;
      rerender();
    });
  });
}
// Category input is wired to the multi-input helper at the bottom of this section

// Vendor multi-select (input + chips)
function addVendorChip(typedVal) {
  const v = (typedVal || '').trim();
  if (!v) return false;
  const upper = v.toUpperCase();
  const lower = v.toLowerCase();
  // 1) Datalist value like "V1 — Vansh" → match by code prefix
  let idx = D.vendors.findIndex(x => upper.startsWith(x.code.toUpperCase() + ' ') || upper === x.code.toUpperCase());
  // 2) Bare vendor code typed in any case (e.g. "v1")
  if (idx < 0) idx = D.vendors.findIndex(x => upper === x.code.toUpperCase());
  // 3) Vendor name typed (exact or starts-with, case-insensitive)
  if (idx < 0) idx = D.vendors.findIndex(x => (x.name || '').toLowerCase() === lower);
  if (idx < 0) idx = D.vendors.findIndex(x => (x.name || '').toLowerCase().startsWith(lower));
  // 4) Loose contains-match as last resort
  if (idx < 0) idx = D.vendors.findIndex(x => lower.length >= 3 && (x.name || '').toLowerCase().includes(lower));
  if (idx < 0 || selFilters.vendor.has(idx)) return false;
  selFilters.vendor.add(idx);
  renderVendorChips();
  document.getElementById('vendorCount').textContent = selFilters.vendor.size ? `(${selFilters.vendor.size})` : '';
  return true;
}
function renderVendorChips() {
  const chips = [...selFilters.vendor].map(idx => {
    const v = D.vendors[idx];
    return `<span class="ms-chip"><span class="lbl" title="${v.name}">${v.code}</span><button data-vendor-idx="${idx}" type="button">×</button></span>`;
  }).join('');
  document.getElementById('vendorChips').innerHTML = chips;
  document.querySelectorAll('#vendorChips .ms-chip button').forEach(b => {
    b.addEventListener('click', () => {
      selFilters.vendor.delete(parseInt(b.dataset.vendorIdx));
      renderVendorChips();
      document.getElementById('vendorCount').textContent = selFilters.vendor.size ? `(${selFilters.vendor.size})` : '';
      currentPage = 0; reorderPage = 0;
      rerender();
    });
  });
}
// Helper: split a typed value on commas / semicolons and add each as a chip.
// Used by all multi-select filters so users can paste / type multiple values at once.
function _commitMultiInput(rawValue, addChipFn) {
  if (!rawValue) return false;
  const parts = String(rawValue).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  parts.forEach(p => { if (addChipFn(p)) added++; });
  return added > 0;
}

// Wire each multi-select input to (a) split on comma/semicolon, (b) accept Enter as commit
function _wireMultiInput(inputId, addChipFn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const commit = () => {
    if (_commitMultiInput(el.value, addChipFn)) {
      el.value = '';
      currentPage = 0; reorderPage = 0;
      rerender();
    }
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  // Catch paste — give the value a tick to settle then commit
  el.addEventListener('paste', () => { setTimeout(commit, 0); });
}

// ===== Folder multi-select =====
function addFolderChip(typedVal) {
  const v = (typedVal || '').trim();
  if (!v) return false;
  // Match by case-insensitive equality first, then by prefix
  const target = v.toLowerCase();
  let idx = D.folders.findIndex(f => (f || '').toLowerCase() === target);
  if (idx < 0) idx = D.folders.findIndex(f => (f || '').toLowerCase().startsWith(target));
  if (idx < 0) return false;
  if (selFilters.folder.has(idx)) return false;
  selFilters.folder.add(idx);
  renderFolderChips();
  document.getElementById('folderCount').textContent = selFilters.folder.size ? `(${selFilters.folder.size})` : '';
  return true;
}
function renderFolderChips() {
  const chips = [...selFilters.folder].map(idx => {
    const name = D.folders[idx] || '?';
    return `<span class="ms-chip"><span class="lbl" title="${name}">${name}</span><button data-folder-idx="${idx}" type="button">×</button></span>`;
  }).join('');
  document.getElementById('folderChips').innerHTML = chips;
  document.querySelectorAll('#folderChips .ms-chip button').forEach(b => {
    b.addEventListener('click', () => {
      selFilters.folder.delete(parseInt(b.dataset.folderIdx));
      renderFolderChips();
      document.getElementById('folderCount').textContent = selFilters.folder.size ? `(${selFilters.folder.size})` : '';
      currentPage = 0; reorderPage = 0;
      rerender();
    });
  });
}
// Folder input is wired to the multi-input helper just below — supports comma/Enter/paste

// ===== Search Product multi-select (free-text chips, no datalist) =====
// Each chip is a lowercase substring. A row matches if its name contains ANY of the chips.
function addSearchChip(typedVal) {
  const v = (typedVal || '').trim().toLowerCase();
  if (!v) return false;
  if (selFilters.search.has(v)) return false;
  selFilters.search.add(v);
  renderSearchChips();
  document.getElementById('searchCount').textContent = selFilters.search.size ? `(${selFilters.search.size})` : '';
  return true;
}
function renderSearchChips() {
  const escape = (s) => String(s).replace(/[<>&"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));
  const chips = [...selFilters.search].map(term => {
    const safe = escape(term);
    return `<span class="ms-chip"><span class="lbl" title="${safe}">${safe}</span><button data-search-term="${safe}" type="button">×</button></span>`;
  }).join('');
  const wrap = document.getElementById('searchChips');
  if (wrap) wrap.innerHTML = chips;
  document.querySelectorAll('#searchChips .ms-chip button').forEach(b => {
    b.addEventListener('click', () => {
      selFilters.search.delete(b.dataset.searchTerm);
      renderSearchChips();
      document.getElementById('searchCount').textContent = selFilters.search.size ? `(${selFilters.search.size})` : '';
      currentPage = 0; reorderPage = 0;
      rerender();
    });
  });
}

// Wire all four multi-select inputs through one helper that splits on commas, accepts Enter, and handles paste
_wireMultiInput('searchInput', addSearchChip);
_wireMultiInput('catFilter',   addCatChip);
_wireMultiInput('vendorFilter', addVendorChip);
_wireMultiInput('folderFilter', addFolderChip);

// Backwards-compat alias used by the vendor table click-through
window.filterByVendor = (code) => {
  const idx = D.vendors.findIndex(v => v.code === code);
  if (idx < 0 || selFilters.vendor.has(idx)) return;
  selFilters.vendor.add(idx);
  renderVendorChips();
  document.getElementById('vendorCount').textContent = selFilters.vendor.size ? `(${selFilters.vendor.size})` : '';
  currentPage = 0; reorderPage = 0;
  rerender();
  document.querySelector('#tab-monthly').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ===== State =====
let currentTab = 'monthly';
let currentPeriod = 24;
let currentView = 'sales';
let planningDays = 60;        // can be a number or 'abc'
let reorderScope = 'needed';  // needed | auto | manual | all
let demandMethod = 'auto';    // auto | mean6 | median6 | trimmed6 | median12
try {
  const savedMethod = localStorage.getItem('inventoryDemandMethod');
  if (savedMethod) demandMethod = savedMethod;
} catch (e) {}

// ===== Math helpers =====
function _mean(arr) { return arr.length ? arr.reduce((x,y) => x + (+y || 0), 0) / arr.length : 0; }
function _median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().map(v => +v || 0).sort((a,b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n-1) >> 1] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
}
function _stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  const sq = arr.reduce((acc, v) => acc + Math.pow((+v || 0) - m, 2), 0);
  return Math.sqrt(sq / (arr.length - 1));
}
function _trimmedMean(arr, dropTop = 1) {
  if (arr.length <= dropTop) return _mean(arr);
  const sorted = arr.slice().map(v => +v || 0).sort((a,b) => b - a);
  return _mean(sorted.slice(dropTop));
}

// ===== Demand classification =====
// Categorize each SKU based on its sales history shape so the Auto demand basis
// can route it to the right formula.
//   smooth       — low variability, regular orders            → Mean 6m
//   trending     — recent 3m noticeably different from 6m     → weighted recent (3m × 2 + 6m) / 3
//   intermittent — many zero-sales months, no big spikes      → Median 12m (smooths the zeros)
//   lumpy        — many zeros + ≥1 spike (project orders)     → Median of non-spike, non-zero months
//   erratic      — high CoV but no clear lumpiness            → Median 6m (conservative)
//   dead         — no sales in 6m                             → 0 (don't suggest reorder)
function classifyDemand(p) {
  const s = (p && Array.isArray(p.s)) ? p.s : [];
  if (!s.length) return { class: 'dead', reason: 'No sales history' };

  const recent12 = s.slice(-12);
  const recent6  = s.slice(-6);
  const recent3  = s.slice(-3);

  // Dead: zero sales for the last 6 months
  if (recent6.every(v => (+v || 0) === 0)) {
    return { class: 'dead', reason: 'No sales in last 6 months' };
  }

  const nonZero12 = recent12.filter(v => (+v || 0) > 0);
  const zeroFrac  = (recent12.length - nonZero12.length) / recent12.length;
  const median12NZ = nonZero12.length ? _median(nonZero12) : 0;
  const max12 = Math.max(...recent12.map(v => +v || 0));
  const cv = nonZero12.length >= 2 && _mean(nonZero12) > 0 ? _stdDev(nonZero12) / _mean(nonZero12) : 0;

  // Lumpy: many zero months + at least one spike (top value > 3× median of nonzero)
  if (zeroFrac >= 0.30 && median12NZ > 0 && max12 > median12NZ * 3) {
    return { class: 'lumpy', reason: 'Spiky project-style demand', median: median12NZ, max: max12, zeroFrac };
  }

  // Intermittent: many zero months but no major spikes
  if (zeroFrac >= 0.30) {
    return { class: 'intermittent', reason: 'Irregular small orders with frequent zero months', median: median12NZ, zeroFrac };
  }

  // Trending: recent-3 noticeably different from recent-12 average
  const mean12 = _mean(recent12);
  const mean3  = _mean(recent3);
  if (mean12 > 0) {
    const ratio = mean3 / mean12;
    if (ratio >= 1.30 || ratio <= 0.70) {
      return { class: 'trending', reason: ratio >= 1.3 ? 'Recent uptick — sales rising' : 'Recent decline — sales falling', ratio };
    }
  }

  // Erratic: high CoV but no obvious lumpiness
  if (cv > 0.60) {
    return { class: 'erratic', reason: 'High month-to-month variability', cv };
  }

  // Default: smooth, predictable demand
  return { class: 'smooth', reason: 'Regular, consistent demand', cv };
}

// ===== Sales-side anomaly detection =====
// Flags months where sales were unusually high (likely one-off project orders).
// Stored in p.sa as array of month indices (mirrors p.ba for purchases).
// A month is anomalous if sales > 2.5 × median of non-zero months, with enough data.
function detectSalesAnomalies(p) {
  const s = (p && Array.isArray(p.s)) ? p.s : [];
  if (s.length < 6) return [];
  const nonZero = s.filter(v => (+v || 0) > 0);
  if (nonZero.length < 4) return [];  // not enough data to flag
  const med = _median(nonZero);
  if (med <= 0) return [];
  const threshold = med * 2.5;
  const flags = [];
  s.forEach((v, i) => { if ((+v || 0) > threshold) flags.push(i); });
  // Don't flag a "spike" if the whole series is small — require at least 5 units
  if (med < 2 && Math.max(...s.map(v => +v || 0)) < 5) return [];
  return flags;
}

// Precompute classifications + sales anomalies for all products.
// Called once at init and again after a history-CSV upload.
function precomputeDemandMeta() {
  D.products.forEach(p => {
    p.sa = detectSalesAnomalies(p);
    p._dc = classifyDemand(p);
  });
}

// ===== AI brief builders =====
// buildSkuBrief(p) → markdown text suitable for pasting into Claude
// buildPortfolioBrief() → portfolio-level summary across the current Reorder Now list

function _aiPickPlanningDays(p) {
  if (planningDays === 'abc') {
    const cls = ABCS[p.b];
    return cls === 'A' ? 30 : cls === 'B' ? 60 : 90;
  }
  return planningDays;
}
function _aiMethodLabel(p) {
  if (demandMethod !== 'auto') return ({ mean6: 'Mean 6m', median6: 'Median 6m', trimmed6: 'Trimmed 6m', median12: 'Median 12m' })[demandMethod] || 'Mean 6m';
  const cls = (p._dc || classifyDemand(p)).class;
  return ({
    smooth: 'Auto → Mean 6m', trending: 'Auto → weighted recent (m3×2+m6)/3',
    intermittent: 'Auto → Median 12m', lumpy: 'Auto → Median of clean months',
    erratic: 'Auto → Median 6m', dead: 'Auto → 0 (dead)',
  })[cls] || 'Auto';
}

function _aiSuggestedQuestions(p) {
  const cls = (p._dc || classifyDemand(p)).class;
  const sa = (p.sa || []).length;
  const days = _aiPickPlanningDays(p);
  const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
  const m = computeDemand(p);
  const suggested = Math.round((m || 0) * days / 30);
  const need = Math.max(0, suggested - total);
  const inReorder = isInReorder(p);

  const Q = [];
  // Universal openers
  Q.push(`Walk me through this SKU's demand pattern over the last 12 months. What's the story this data tells?`);
  // Class-tailored
  if (cls === 'lumpy') Q.push(`This SKU is classified LUMPY. Are the spike months in the sales history clearly project orders, or could they be a recurring seasonal pattern I should plan for?`);
  if (cls === 'trending') Q.push(`The recent 3-month sales diverge significantly from the 12-month average. Is this likely sustained growth or a temporary uptick? What signals would tell me?`);
  if (cls === 'intermittent') Q.push(`This SKU has mostly zero-sales months. Should I keep it in the active reorder list at all, or is it a candidate for slow-mover review?`);
  if (cls === 'erratic') Q.push(`Demand for this SKU is highly variable month-to-month. What might be driving the variability — and what reorder strategy makes sense given that?`);
  if (cls === 'dead') Q.push(`This SKU has had no sales in the last 6 months. Should I check if it's actually obsolete, or could there be a data issue (e.g., master mapping mismatch)?`);
  if (cls === 'smooth') Q.push(`This SKU has steady consistent demand. Is there any reason to suspect the formula's suggestion is off, or should I trust it?`);
  // Anomalies
  if (sa > 0) Q.push(`The dashboard flagged ${sa} sales-spike month${sa > 1 ? 's' : ''} as anomalies (purple dots). Are these one-off project orders that should be excluded, or could they be the start of a new pattern?`);
  if ((p.ba || []).length > 0) Q.push(`There are ${p.ba.length} bulk-purchase anomaly month${p.ba.length > 1 ? 's' : ''} (red dots). Was the supplier doing batch fulfillment, or are these stockpile builds?`);
  // Math-driven
  if (need > 0) Q.push(`Order qty is suggested at ${fmt(need)}. Given the pipeline and demand pattern, is that the right number — or should I order more / less?`);
  else Q.push(`Order qty currently says 0 (covered) — but should I pre-order anyway given the demand pattern? At what point will I actually run short?`);
  // PNA / Discontinued
  if (isPNA(p)) Q.push(`This SKU is marked PNA (paper not available) with refill date ${getPNADate(p) ? formatDate(getPNADate(p)) : 'TBD'}. Should I be doing anything different until the refill arrives?`);
  // Strategic
  Q.push(`Anything in this data that surprises you, or that I might be missing as an inventory planner?`);

  return Q.slice(0, 7);  // cap to 7
}

function _aiHistoryTable(label, arr, anomalyIdxs) {
  if (!Array.isArray(arr) || arr.length === 0) return '_(no history)_\n';
  const anoms = new Set(anomalyIdxs || []);
  const months = D.months.slice(-arr.length);
  // Format as two markdown rows
  const head = '| Month | ' + months.map((m, i) => m + (anoms.has(i) ? '*' : '')).join(' | ') + ' |\n';
  const sep  = '|---|'   + months.map(() => '---').join('|') + '|\n';
  const data = '| ' + label + ' | ' + arr.map(v => String(v || 0)).join(' | ') + ' |\n';
  return head + sep + data;
}

function buildSkuBrief(p) {
  if (!p) return '';
  const v = D.vendors[p.v] || { name: '?', code: '?' };
  const parentFolder = D.folders[p.fl] || '?';
  const fz = getFolderZones(parentFolder);
  const zoneStr = fz.openToAll ? 'OPEN (all zones)' : fz.unclassified ? 'unclassified' : 'Zones ' + fz.zones.join(', ');
  const abc = ABCS[p.b] || '?';
  const pri = p.r > 0 ? PRIORITIES[p.pr] : '— (not auto-flagged)';
  const dc = (p._dc || classifyDemand(p));
  const days = _aiPickPlanningDays(p);
  const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
  const m6 = _mean((p.s || []).slice(-6));
  const m12 = _mean((p.s || []).slice(-12));
  const m3 = _mean((p.s || []).slice(-3));
  const a12 = (p.s || []).slice(-12).reduce((x, y) => x + (+y || 0), 0);
  const demand = computeDemand(p);
  const suggested = Math.round((demand || 0) * days / 30);
  const order = Math.max(0, suggested - total);
  const sa = p.sa || [];
  const ba = p.ba || [];

  let md = `# Analysis brief: ${p.n}\n\n`;
  md += `_Generated from the Inventory Intelligence dashboard. Paste into Claude and ask any of the questions at the bottom — or your own._\n\n`;

  const _pld = getParentLaunchDate(p);
  const _pldAge = monthsSinceLaunch(_pld);
  const _catName = (D.cats && p.c != null) ? (D.cats[p.c] || '') : '';
  const _subName = getProductSubCategory(p);
  md += `## Identity\n`;
  md += `- **Parent code**: ${p.n}\n`;
  md += `- **Parent ID**: ${p.i}\n`;
  md += `- **Parent created on**: ${_pld ? formatDate(_pld) : 'unknown'}${_pldAge != null ? ` (${_pldAge} month${_pldAge !== 1 ? 's' : ''} ago)` : ''}\n`;
  md += `- **Vendor**: ${v.name} (${v.code})\n`;
  md += `- **Category**: ${_catName || '—'}${_subName ? `  ·  Sub-category: ${_subName}` : ''}\n`;
  md += `- **Folder**: ${parentFolder}  ·  ${zoneStr}\n`;
  md += `- **ABC class**: ${abc}\n`;
  md += `- **Reorder priority**: ${pri}\n`;
  md += `- **Demand classification**: ${(dc.class || '').toUpperCase()} — _${dc.reason || ''}_\n`;
  md += `- **Status flags**: ${[
    isPNA(p) ? `PNA (refill ${getPNADate(p) ? formatDate(getPNADate(p)) : 'TBD'})` : null,
    isDiscontinued(p) ? 'Discontinued' : null,
    isInReorder(p) ? (isManualOnly(p) ? 'Manual reorder' : 'Auto-flagged for reorder') : 'Not in reorder list',
  ].filter(Boolean).join(' · ')}\n\n`;

  md += `## Current stock position\n`;
  md += `- **On hand**: ${fmt(p.k || 0)}\n`;
  md += `- **In transit**: ${fmt(p.it || 0)}\n`;
  md += `- **Pending @ factory**: ${fmt(p.po || 0)}\n`;
  md += `- **Total (sum)**: ${fmt(total)}\n`;
  md += `- **Days of cover (p.ad)**: ${p.ad >= 999 ? '∞ (no recent sales)' : (p.ad + ' days')}\n`;
  md += `- **Available (hand+transit, p.av)**: ${fmt(p.av || 0)}\n\n`;

  md += `## Demand metrics\n`;
  md += `- **Mean last 6m**: ${m6.toFixed(2)}/mo\n`;
  md += `- **Mean last 3m**: ${m3.toFixed(2)}/mo\n`;
  md += `- **Mean last 12m**: ${m12.toFixed(2)}/mo\n`;
  md += `- **Median last 6m**: ${_median((p.s || []).slice(-6)).toFixed(2)}/mo\n`;
  md += `- **Median last 12m**: ${_median((p.s || []).slice(-12)).toFixed(2)}/mo\n`;
  md += `- **Annual sales (last 12m sum)**: ${fmt(a12)}\n`;
  md += `- **Demand method in use**: ${_aiMethodLabel(p)} → demand = **${(demand || 0).toFixed(2)}/mo**\n\n`;

  md += `## Reorder math (with current settings)\n`;
  md += `- **Planning days**: ${days}${planningDays === 'abc' ? ' (By ABC mode)' : ''}\n`;
  md += `- **Suggested**: ${(demand || 0).toFixed(2)} × ${days}/30 = **${fmt(suggested)}**\n`;
  md += `- **Total stock**: ${fmt(total)}\n`;
  md += `- **Order qty**: max(0, ${fmt(suggested)} − ${fmt(total)}) = **${fmt(order)}**${order === 0 ? ' (Covered)' : ''}\n\n`;

  md += `## Detected anomalies\n`;
  if (sa.length === 0 && ba.length === 0) {
    md += `_None._\n\n`;
  } else {
    if (sa.length > 0) {
      md += `- **Sales spikes (purple dot)**: ${sa.length} month${sa.length > 1 ? 's' : ''}\n`;
      sa.forEach(idx => {
        md += `  - ${D.months[idx]}: ${fmt(p.s[idx] || 0)} units (> 2.5× median of non-zero months)\n`;
      });
    }
    if (ba.length > 0) {
      md += `- **Bulk purchase anomalies (red dot)**: ${ba.length} month${ba.length > 1 ? 's' : ''}\n`;
      ba.forEach(idx => {
        md += `  - ${D.months[idx]}: ${fmt(p.p[idx] || 0)} units purchased\n`;
      });
    }
    md += `\n`;
  }

  md += `## 24-month sales history\n`;
  md += _aiHistoryTable('Sales', p.s || [], sa);
  if (sa.length > 0) md += `_(* = sales-spike anomaly)_\n\n`;
  else md += `\n`;

  md += `## 24-month purchase history\n`;
  md += _aiHistoryTable('Purchases', p.p || [], ba);
  if (ba.length > 0) md += `_(* = bulk-purchase anomaly)_\n\n`;
  else md += `\n`;

  // Children
  const children = getProductChildren(p);
  if (children && children.length > 0) {
    md += `## Child SKUs (${children.length})\n`;
    children.slice(0, 12).forEach(ch => {
      const ageM = monthsSinceLaunch(ch.launchDate);
      const age = ageM == null ? '?' : (ageM === 0 ? 'new' : `${ageM}M`);
      md += `- ${ch.code} · folder ${ch.folder} · launched ${ch.launchDate ? formatDate(ch.launchDate) : '?'} (${age} ago)\n`;
    });
    if (children.length > 12) md += `- _… and ${children.length - 12} more children_\n`;
    md += `\n`;
  }

  md += `## Suggested questions to ask Claude\n`;
  _aiSuggestedQuestions(p).forEach((q, i) => {
    md += `${i + 1}. ${q}\n`;
  });
  md += `\n---\n_End of brief. Dashboard generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC._\n`;
  return md;
}

function buildPortfolioBrief(scopeFiltered, scopeLabel) {
  const products = scopeFiltered || [];
  const lines = [];
  lines.push(`# Inventory Portfolio Brief`);
  lines.push('');
  lines.push(`_Generated from the Inventory Intelligence dashboard. Use this brief to ask Claude portfolio-level questions._`);
  lines.push('');
  lines.push(`**Scope**: ${scopeLabel || 'current Reorder Now list'} — ${fmt(products.length)} SKUs`);
  lines.push(`**Planning days**: ${planningDays === 'abc' ? 'By ABC (A=30/B=60/C=90)' : planningDays + ' days'}  ·  **Demand basis**: ${({ auto: 'Auto', mean6: 'Mean 6m', median6: 'Median 6m', trimmed6: 'Trimmed 6m', median12: 'Median 12m' })[demandMethod] || demandMethod}`);
  lines.push('');

  // Aggregate stats
  const byClass = {};
  const byPriority = {};
  const byABC = {};
  let pnaCount = 0, discCount = 0, manualCount = 0, autoCount = 0;
  let totalNeed = 0, anomCount = 0;
  const vendorCounts = {};

  products.forEach(p => {
    const cls = (p._dc || classifyDemand(p)).class || 'smooth';
    byClass[cls] = (byClass[cls] || 0) + 1;
    const pri = p.r > 0 ? (PRIORITIES[p.pr] || '').split(' ')[0] : '—';
    byPriority[pri] = (byPriority[pri] || 0) + 1;
    const abc = ABCS[p.b] || '?';
    byABC[abc] = (byABC[abc] || 0) + 1;
    if (isPNA(p)) pnaCount++;
    if (isDiscontinued(p)) discCount++;
    if (isManualOnly(p)) manualCount++;
    if (p.r > 0) autoCount++;
    const v = D.vendors[p.v];
    if (v) vendorCounts[v.code] = (vendorCounts[v.code] || 0) + 1;
    if ((p.sa || []).length > 0) anomCount++;
    // Need calc
    const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
    const days = _aiPickPlanningDays(p);
    const sugg = Math.round((computeDemand(p) || 0) * days / 30);
    totalNeed += Math.max(0, sugg - total);
  });

  lines.push('## Aggregate stats');
  lines.push(`- **Auto-flagged**: ${autoCount}  ·  **Manual added**: ${manualCount}  ·  **PNA**: ${pnaCount}  ·  **Discontinued**: ${discCount}`);
  lines.push(`- **Demand classes**: ${Object.entries(byClass).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k.toUpperCase()} ${v}`).join('  ·  ')}`);
  lines.push(`- **Priority mix**: ${Object.entries(byPriority).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k} ${v}`).join('  ·  ')}`);
  lines.push(`- **ABC mix**: A ${byABC.A || 0}  ·  B ${byABC.B || 0}  ·  C ${byABC.C || 0}`);
  lines.push(`- **SKUs with sales-spike anomalies**: ${anomCount}`);
  lines.push(`- **Total reorder need (units)**: ${fmt(totalNeed)} across all rows`);
  lines.push('');

  // Top vendors
  const topVendors = Object.entries(vendorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  lines.push('## Top 10 vendors by reorder-list SKU count');
  topVendors.forEach(([code, n]) => {
    const vRec = D.vendors.find(x => x.code === code);
    lines.push(`- ${code} (${(vRec && vRec.name) || ''}): ${n} SKUs`);
  });
  lines.push('');

  // Per-SKU one-row summary (cap at 80 to keep brief manageable)
  lines.push(`## Per-SKU rundown (${Math.min(80, products.length)} of ${products.length} shown)`);
  lines.push('');
  lines.push('| Parent | Vendor | ABC | Pri | Class | Days | Total | Suggested | Order | Anom | Notes |');
  lines.push('|---|---|---|---|---|---:|---:|---:|---:|---:|---|');
  products.slice(0, 80).forEach(p => {
    const v = D.vendors[p.v] || { code: '?' };
    const cls = ((p._dc || classifyDemand(p)).class || 'smooth').toUpperCase();
    const pri = p.r > 0 ? (PRIORITIES[p.pr] || '').split(' ')[0] : '—';
    const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
    const days = _aiPickPlanningDays(p);
    const sugg = Math.round((computeDemand(p) || 0) * days / 30);
    const need = Math.max(0, sugg - total);
    const sa = (p.sa || []).length;
    const ba = (p.ba || []).length;
    const notes = [
      isPNA(p) ? 'PNA' : '',
      isDiscontinued(p) ? 'Disc' : '',
      isManualOnly(p) ? 'Manual' : '',
    ].filter(Boolean).join('/');
    const anomStr = (sa + ba > 0) ? `${sa}s/${ba}b` : '—';
    lines.push(`| ${p.n} | ${v.code} | ${ABCS[p.b] || '?'} | ${pri} | ${cls} | ${p.ad >= 999 ? '∞' : p.ad} | ${total} | ${sugg} | ${need} | ${anomStr} | ${notes} |`);
  });
  if (products.length > 80) lines.push(`\n_${products.length - 80} more SKUs not shown — narrow the scope with the SHOW filter to see them._\n`);
  lines.push('');

  lines.push('## Suggested portfolio-level questions');
  lines.push('1. Which 5–10 SKUs should I prioritise this week given the priority + ABC + classification mix?');
  lines.push('2. Are there any vendor concentration risks I should be aware of in this list?');
  lines.push('3. Looking at the demand-class distribution, what is the health of this portfolio?');
  lines.push('4. Which classifications appear to have data-quality issues (e.g., lots of DEAD or unexpected LUMPY)?');
  lines.push('5. Where is the biggest mismatch between what the formula suggests and what intuition would say?');
  lines.push('6. If I could only place orders for half the SKUs this week, which would you keep and which would you defer?');
  lines.push('7. Are there patterns across the SKUs flagged with sales-spike anomalies (same vendor, same folder, same launch period)?');

  lines.push('');
  lines.push('---');
  lines.push(`_End of brief. Dashboard generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC._`);
  return lines.join('\n');
}

// Copy a string to the clipboard with a visual confirmation toast
function _aiCopyToClipboard(text, btn) {
  const ok = (success) => {
    if (!btn) return;
    const origText = btn.innerHTML;
    const origBg = btn.style.background;
    btn.innerHTML = success ? '✓' : '!';
    btn.style.background = success ? 'rgba(58,255,182,0.25)' : 'rgba(255,74,92,0.25)';
    setTimeout(() => { btn.innerHTML = origText; btn.style.background = origBg; }, 1100);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => ok(true), () => ok(false));
  } else {
    // Fallback: temporary textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ok(true);
    } catch (e) { ok(false); }
  }
}

// ===== AI Chat (Anthropic API integration) =====
const AI_SETTINGS_KEY = 'inventoryAiSettings';
const AI_DEFAULT_SYSTEM = (document.getElementById('aiSystemPromptInput') && document.getElementById('aiSystemPromptInput').value) || '';
// Pricing per million tokens (USD) — used for cost estimate only, may drift over time
const AI_MODEL_PRICING = {
  'claude-sonnet-4-6':         { in: 3,  out: 15 },
  'claude-opus-4-6':           { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1,  out: 5  },
};
const aiState = {
  apiKey: '',
  model: 'claude-sonnet-4-6',
  systemPrompt: AI_DEFAULT_SYSTEM,
  tokensIn: 0,
  tokensOut: 0,
  // Current chat session
  currentSku: null,            // product object
  conversation: [],            // [{role, content}, ...]
};
try {
  const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}');
  if (saved.apiKey)       aiState.apiKey = saved.apiKey;
  if (saved.model)        aiState.model = saved.model;
  if (saved.systemPrompt) aiState.systemPrompt = saved.systemPrompt;
  if (saved.tokensIn)     aiState.tokensIn = saved.tokensIn;
  if (saved.tokensOut)    aiState.tokensOut = saved.tokensOut;
} catch (e) {}

function aiSaveSettings() {
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({
      apiKey: aiState.apiKey, model: aiState.model, systemPrompt: aiState.systemPrompt,
      tokensIn: aiState.tokensIn, tokensOut: aiState.tokensOut,
    }));
  } catch (e) {}
}

function aiHasKey() { return !!(aiState.apiKey && aiState.apiKey.startsWith('sk-')); }

function aiUpdateCostUI() {
  const inEl  = document.getElementById('aiTokensIn');
  const outEl = document.getElementById('aiTokensOut');
  const costEl = document.getElementById('aiCostEstimate');
  if (inEl)  inEl.textContent = fmt(aiState.tokensIn);
  if (outEl) outEl.textContent = fmt(aiState.tokensOut);
  if (costEl) {
    const px = AI_MODEL_PRICING[aiState.model] || AI_MODEL_PRICING['claude-sonnet-4-6'];
    const cost = (aiState.tokensIn * px.in + aiState.tokensOut * px.out) / 1e6;
    costEl.textContent = '$' + cost.toFixed(2);
  }
  const sessEl = document.getElementById('aiChatSessionCost');
  if (sessEl) {
    const px = AI_MODEL_PRICING[aiState.model] || AI_MODEL_PRICING['claude-sonnet-4-6'];
    const cost = (aiState.tokensIn * px.in + aiState.tokensOut * px.out) / 1e6;
    sessEl.textContent = `tokens: ${fmt(aiState.tokensIn)} in / ${fmt(aiState.tokensOut)} out · ~$${cost.toFixed(2)} (${aiState.model.split('-').slice(0,3).join(' ')})`;
  }
}

// Tiny markdown → HTML renderer (handles paragraphs, headings, lists, code, bold, italic, inline code)
function aiMd2Html(src) {
  if (!src) return '';
  let s = String(src).replace(/\r\n/g, '\n');
  // Escape HTML first
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  s = esc(s);
  // Code blocks ```
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Headings
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h3>$1</h3>');
  s = s.replace(/^# (.+)$/gm,   '<h3>$1</h3>');
  // Bold and italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Lists — turn consecutive lines that start with -, *, or N. into UL/OL blocks
  const lines = s.split('\n');
  const out = [];
  let inUl = false, inOl = false, paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) { out.push('<p>' + paraBuf.join(' ') + '</p>'); paraBuf = []; }
  };
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed.startsWith('<h3>') || trimmed.startsWith('<pre>') || trimmed.startsWith('<ul>') || trimmed.startsWith('<ol>')) {
      flushPara(); closeLists();
      out.push(ln);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
      out.push('<li>' + trimmed.replace(/^[-*]\s+/, '') + '</li>');
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushPara();
      if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
      out.push('<li>' + trimmed.replace(/^\d+\.\s+/, '') + '</li>');
      continue;
    }
    if (trimmed === '') {
      flushPara(); closeLists();
      continue;
    }
    closeLists();
    paraBuf.push(trimmed);
  }
  flushPara(); closeLists();
  return out.join('\n');
}

// Stream a response from Claude API. Calls onDelta(text) for each chunk and onDone(usage) when complete.
async function aiStreamChat(systemPrompt, messages, onDelta, onDone, onError) {
  if (!aiHasKey()) { onError(new Error('No API key set — open the gear icon to add one.')); return; }
  try {
    const res = await fetch('/api/ai/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: aiState.apiKey,
        model: aiState.model,
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: messages,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`API ${res.status}: ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try {
          const evt = JSON.parse(json);
          if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
            onDelta(evt.delta.text);
          } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
            usage.input_tokens = evt.message.usage.input_tokens || 0;
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage.output_tokens = evt.usage.output_tokens || usage.output_tokens;
          }
        } catch (e) { /* ignore parse errors */ }
      }
    }
    onDone(usage);
  } catch (err) {
    onError(err);
  }
}

// Settings panel open/close + save
function aiOpenSettings() {
  document.getElementById('aiApiKeyInput').value = aiState.apiKey;
  document.getElementById('aiModelSelect').value = aiState.model;
  document.getElementById('aiSystemPromptInput').value = aiState.systemPrompt;
  aiUpdateCostUI();
  document.getElementById('aiSettingsOverlay').classList.add('open');
}
function aiCloseSettings() {
  document.getElementById('aiSettingsOverlay').classList.remove('open');
}
document.getElementById('aiGearBtn').addEventListener('click', aiOpenSettings);
document.getElementById('aiSettingsClose').addEventListener('click', aiCloseSettings);
document.getElementById('aiSettingsOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'aiSettingsOverlay') aiCloseSettings();
});
document.getElementById('aiApiKeyShow').addEventListener('click', () => {
  const inp = document.getElementById('aiApiKeyInput');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});
document.getElementById('aiSettingsSave').addEventListener('click', () => {
  aiState.apiKey = document.getElementById('aiApiKeyInput').value.trim();
  aiState.model = document.getElementById('aiModelSelect').value;
  aiState.systemPrompt = document.getElementById('aiSystemPromptInput').value;
  aiSaveSettings();
  aiUpdateCostUI();
  aiCloseSettings();
});
document.getElementById('aiSettingsReset').addEventListener('click', () => {
  document.getElementById('aiSystemPromptInput').value = AI_DEFAULT_SYSTEM;
});

// Chat panel open/close + actions
function aiOpenChat(p) {
  aiState.currentSku = p;
  aiState.conversation = [];
  const brief = buildSkuBrief(p);
  document.getElementById('aiChatSkuName').textContent = p ? p.n : 'AI Analysis';
  document.getElementById('aiChatContextBody').textContent = brief;
  document.getElementById('aiChatMessages').innerHTML = `<div class="ai-chat-empty">Ask anything about <strong>${p ? p.n : 'this SKU'}</strong>. The full data brief is in the SKU context above. Try one of these to start:<br><br>
    <em>"Why did this spike in Jul-25? Is it a one-off?"</em><br>
    <em>"Should I order more given the recent trend?"</em><br>
    <em>"What's the story this data tells?"</em></div>`;
  document.getElementById('aiChatStatus').textContent = '';
  document.getElementById('aiChatInput').value = '';
  aiUpdateCostUI();
  document.getElementById('aiChatPanel').classList.add('open');
  // The conversation history starts with the brief as the first user turn — that way Claude has full context
  aiState.conversation.push({ role: 'user', content: brief });
  aiState.conversation.push({ role: 'assistant', content: 'I have the full brief. What would you like to know?' });
}
function aiCloseChat() {
  document.getElementById('aiChatPanel').classList.remove('open');
}
function aiOpenPortfolioChat() {
  aiState.currentSku = null;
  aiState.conversation = [];
  const filtered = getFilteredProducts();
  let sub;
  if (reorderScope === 'needed') {
    sub = filtered.filter(p => {
      if (isExcluded(p)) return false;
      if (isManualOnly(p)) return true;
      const days = _aiPickPlanningDays(p);
      const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
      const need = Math.max(0, Math.round((computeDemand(p) || 0) * days / 30) - total);
      return need > 0;
    });
  } else if (reorderScope === 'auto')   sub = filtered.filter(p => p.r > 0 && !isExcluded(p));
  else if (reorderScope === 'manual')   sub = filtered.filter(p => isManualOnly(p));
  else                                  sub = filtered.filter(p => isInReorder(p));
  const scopeLabel = ({ needed: 'Need order now', auto: 'Auto-flagged', manual: 'Manual added', all: 'All in reorder list' })[reorderScope] || reorderScope;
  const brief = buildPortfolioBrief(sub, scopeLabel);
  document.getElementById('aiChatSkuName').textContent = `Portfolio (${scopeLabel}, ${sub.length} SKUs)`;
  document.getElementById('aiChatContextBody').textContent = brief;
  document.getElementById('aiChatMessages').innerHTML = `<div class="ai-chat-empty">Ask portfolio-level questions across <strong>${sub.length} SKUs</strong>. Some ideas:<br><br>
    <em>"Which 10 should I prioritize this week?"</em><br>
    <em>"Any vendor concentration risks?"</em><br>
    <em>"Spot patterns in the sales-spike SKUs."</em></div>`;
  document.getElementById('aiChatStatus').textContent = '';
  document.getElementById('aiChatInput').value = '';
  aiUpdateCostUI();
  document.getElementById('aiChatPanel').classList.add('open');
  aiState.conversation.push({ role: 'user', content: brief });
  aiState.conversation.push({ role: 'assistant', content: 'I have the full portfolio brief. What would you like to know?' });
}
document.getElementById('aiChatClose').addEventListener('click', aiCloseChat);
document.getElementById('aiChatNew').addEventListener('click', () => {
  if (aiState.currentSku) aiOpenChat(aiState.currentSku);
  else aiOpenPortfolioChat();
});
document.getElementById('aiChatCopy').addEventListener('click', () => {
  _aiCopyToClipboard(document.getElementById('aiChatContextBody').textContent, document.getElementById('aiChatCopy'));
});
document.getElementById('aiChatContextToggle').addEventListener('click', () => {
  const ctx = document.getElementById('aiChatContext');
  ctx.classList.toggle('collapsed');
  const btn = document.getElementById('aiChatContextToggle');
  btn.textContent = ctx.classList.contains('collapsed') ? '▸ expand' : '▾ collapse';
});

function aiAppendMessage(role, contentHtmlOrText, isStreaming) {
  const msgs = document.getElementById('aiChatMessages');
  const empty = msgs.querySelector('.ai-chat-empty');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ' + role;
  wrap.innerHTML = `<div class="ai-msg-role">${role === 'user' ? 'You' : 'Claude'}</div><div class="ai-msg-body${isStreaming ? ' typing-cursor' : ''}">${role === 'assistant' ? contentHtmlOrText : contentHtmlOrText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return wrap.querySelector('.ai-msg-body');
}

async function aiSendMessage() {
  const inp = document.getElementById('aiChatInput');
  const text = inp.value.trim();
  if (!text) return;
  if (!aiHasKey()) {
    document.getElementById('aiChatStatus').innerHTML = '<span style="color:var(--red)">No API key set — open the ⚙ gear top-right.</span>';
    return;
  }
  inp.value = '';
  document.getElementById('aiChatSend').disabled = true;
  document.getElementById('aiChatStatus').textContent = 'Sending…';

  // Show user message
  aiAppendMessage('user', text, false);
  aiState.conversation.push({ role: 'user', content: text });

  // Prepare assistant message bubble (streaming)
  const bubble = aiAppendMessage('assistant', '', true);
  let acc = '';

  await aiStreamChat(
    aiState.systemPrompt,
    aiState.conversation,
    (chunk) => {
      acc += chunk;
      bubble.innerHTML = aiMd2Html(acc) + '<span class="typing-cursor"></span>';
      bubble.parentElement.parentElement.scrollTop = bubble.parentElement.parentElement.scrollHeight;
    },
    (usage) => {
      bubble.classList.remove('typing-cursor');
      bubble.innerHTML = aiMd2Html(acc);
      aiState.conversation.push({ role: 'assistant', content: acc });
      if (usage) {
        aiState.tokensIn  += (usage.input_tokens  || 0);
        aiState.tokensOut += (usage.output_tokens || 0);
        aiSaveSettings();
        aiUpdateCostUI();
      }
      document.getElementById('aiChatStatus').textContent = '';
      document.getElementById('aiChatSend').disabled = false;
    },
    (err) => {
      bubble.classList.remove('typing-cursor');
      bubble.innerHTML = `<em style="color:var(--red)">Error: ${(err && err.message) || err}</em>`;
      document.getElementById('aiChatStatus').innerHTML = '<span style="color:var(--red)">Request failed — check your API key, network, or model setting.</span>';
      document.getElementById('aiChatSend').disabled = false;
    }
  );
}

// Friendly error message for sync failures — turn "Failed to fetch" into actionable troubleshooting
function _gsyncErrorMessage(err) {
  const raw = (err && err.message) || String(err || '');
  if (!raw) return 'Unknown error.';
  if (/Failed to fetch|NetworkError|TypeError: Load failed|TypeError: Failed/i.test(raw)) {
    return `Sheet isn't publicly readable. Fix: open the sheet → <strong>Share</strong> → set to <strong>"Anyone with the link · Viewer"</strong>, then click Sync again. Or use File → Publish to web → CSV and paste THAT URL.`;
  }
  if (/\b403\b|forbidden/i.test(raw)) {
    return `Access denied (HTTP 403). Open the sheet → Share → set to <strong>"Anyone with the link · Viewer"</strong>.`;
  }
  if (/\b401\b|unauthor/i.test(raw)) {
    return `Authentication required (HTTP 401). The sheet is private. Share it as "Anyone with the link".`;
  }
  if (/\b404\b|not found/i.test(raw)) {
    return `Sheet not found (HTTP 404). Check the URL hasn't been mistyped and that the sheet still exists.`;
  }
  return 'Error: ' + raw;
}
document.getElementById('aiChatSend').addEventListener('click', aiSendMessage);
document.getElementById('aiChatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    aiSendMessage();
  }
});

// Unified invoker: opens chat panel if key set, otherwise copies brief to clipboard.
function aiInvoke(p, btn) {
  if (aiHasKey()) {
    aiOpenChat(p);
  } else {
    _aiCopyToClipboard(buildSkuBrief(p), btn);
  }
}

// ===== Demand estimator (used by reorder math) =====
function computeDemand(p) {
  const s = (p && Array.isArray(p.s)) ? p.s : [];
  if (!s.length) return p && p.m ? p.m : 0;
  const recent6  = s.slice(-6);
  const recent12 = s.slice(-12);
  const recent3  = s.slice(-3);

  switch (demandMethod) {
    case 'median6':  return _median(recent6);
    case 'median12': return _median(recent12);
    case 'trimmed6': return _trimmedMean(recent6, 1);
    case 'mean6':    return _mean(recent6);
    case 'auto':
    default: {
      const cls = (p && p._dc) ? p._dc : classifyDemand(p);
      const sa  = new Set(p && p.sa ? p.sa : []);
      switch (cls.class) {
        case 'dead':
          return 0;
        case 'lumpy': {
          // Exclude flagged anomaly months AND zeros, then take median
          const clean = recent12.map((v, i) => ({ v: +v || 0, idx: s.length - recent12.length + i }))
                                .filter(o => o.v > 0 && !sa.has(o.idx))
                                .map(o => o.v);
          return clean.length ? _median(clean) : _median(recent12.filter(v => +v > 0));
        }
        case 'intermittent':
          // Median of last 12m (includes zeros) — naturally low
          return _median(recent12);
        case 'trending': {
          // Weight recent 3m heavier than the rest
          const m3 = _mean(recent3);
          const m6 = _mean(recent6);
          return (m3 * 2 + m6) / 3;
        }
        case 'erratic':
          // Conservative: median of recent 6m
          return _median(recent6);
        case 'smooth':
        default:
          return _mean(recent6);
      }
    }
  }
}
let customStart = 0, customEnd = 23;
let pageSize = 50;
let currentPage = 0;

// ===== Filtering =====
// Multi-select filter state — Sets of selected values
const selFilters = {
  cat: new Set(),     // Set of cat indices
  vendor: new Set(),  // Set of vendor indices
  abc: new Set(),     // Set of ABC indices (0=A, 1=B, 2=C)
  status: new Set(),  // Set of status indices
  folder: new Set(),  // Set of folder indices (D.folders)
  search: new Set(),  // Set of lowercase search-term strings (multi-select chips)
  virtualStatus: new Set(),  // 'pna' and/or 'disc' — overlays on top of regular status filter
};

function getFilteredProducts() {
  // Search supports BOTH the typed-but-not-yet-committed input value (so typing feels live)
  // AND any committed multi-select chips (so multiple terms can be ANDed/ORed together).
  // Behavior: if ANY chip OR the live input matches, the row passes — i.e. it's an OR across terms.
  // This matches how users think about searches like "lam, mcs, gag" → "show me anything in these families".
  const liveQ = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const chipTerms = [...selFilters.search];
  const hasSearchFilter = chipTerms.length > 0 || liveQ.length > 0;
  return D.products.filter(p => {
    if (hasSearchFilter) {
      const name = (p.n || '').toLowerCase();
      let matched = false;
      if (liveQ && name.includes(liveQ)) matched = true;
      if (!matched) {
        for (const t of chipTerms) { if (t && name.includes(t)) { matched = true; break; } }
      }
      if (!matched) return false;
    }
    if (selFilters.cat.size && !selFilters.cat.has(p.c)) return false;
    if (selFilters.vendor.size && !selFilters.vendor.has(p.v)) return false;
    if (selFilters.abc.size && !selFilters.abc.has(p.b)) return false;
    if (selFilters.status.size && !selFilters.status.has(p.st)) return false;
    if (selFilters.folder.size && !selFilters.folder.has(p.fl)) return false;
    // Virtual-status overlays: PNA / Discontinued. Any active virtual filter must match.
    if (selFilters.virtualStatus.size) {
      const wantsPna = selFilters.virtualStatus.has('pna');
      const wantsDisc = selFilters.virtualStatus.has('disc');
      const matchesAny = (wantsPna && isPNA(p)) || (wantsDisc && isDiscontinued(p));
      if (!matchesAny) return false;
    }
    return true;
  });
}

// ===== Manual reorder additions =====
const manualReorderIds = new Set();
try {
  const saved = localStorage.getItem('inventoryManualReorder');
  if (saved) JSON.parse(saved).forEach(id => manualReorderIds.add(id));
} catch (e) {}

function saveManualReorder() {
  try { localStorage.setItem('inventoryManualReorder', JSON.stringify([...manualReorderIds])); } catch (e) {}
}

// ===== Excluded (dismissed) reorder rows =====
// User can × any row in Reorder Now — auto-flagged rows go here so they stop showing
const reorderExcludedIds = new Set();
try {
  const savedX = localStorage.getItem('inventoryReorderExcluded');
  if (savedX) JSON.parse(savedX).forEach(id => reorderExcludedIds.add(id));
} catch (e) {}

function saveReorderExcluded() {
  try { localStorage.setItem('inventoryReorderExcluded', JSON.stringify([...reorderExcludedIds])); } catch (e) {}
}

function isExcluded(p) { return reorderExcludedIds.has(p.i); }

// ===== Discontinued products =====
const discontinuedIds = new Set();
try {
  const savedD = localStorage.getItem('inventoryDiscontinued');
  if (savedD) JSON.parse(savedD).forEach(id => discontinuedIds.add(id));
} catch (e) {}

function saveDiscontinued() {
  try { localStorage.setItem('inventoryDiscontinued', JSON.stringify([...discontinuedIds])); } catch (e) {}
}

function isDiscontinued(p) { return discontinuedIds.has(p.i); }

// ===== PNA (Paper Not Available) status =====
// Per-product flag set via the Stock master sheet. Carries an expected refill date.
//   pnaData[pid] = { date: 'YYYY-MM-DD' or any free-text date the user typed in the sheet }
const pnaData = {};
try {
  const savedPna = localStorage.getItem('inventoryPna');
  if (savedPna) Object.assign(pnaData, JSON.parse(savedPna) || {});
} catch (e) {}
function savePnaData() {
  try { localStorage.setItem('inventoryPna', JSON.stringify(pnaData)); } catch (e) {}
}
function isPNA(p) { return !!pnaData[p.i]; }
function getPNADate(p) { return (pnaData[p.i] || {}).date || ''; }

function toggleDiscontinued(pid) {
  if (discontinuedIds.has(pid)) {
    discontinuedIds.delete(pid);
  } else {
    discontinuedIds.add(pid);
    // When marking discontinued, also drop from manual reorder list if present
    manualReorderIds.delete(pid);
  }
  saveDiscontinued();
  saveManualReorder();
}

function isInReorder(p) {
  if (reorderExcludedIds.has(p.i)) return false;
  if (discontinuedIds.has(p.i)) return false;
  return p.r > 0 || manualReorderIds.has(p.i);
}
function isManualOnly(p) {
  if (reorderExcludedIds.has(p.i)) return false;
  if (discontinuedIds.has(p.i)) return false;
  return p.r === 0 && manualReorderIds.has(p.i);
}

// ===== Monthly grid =====
function getRange() {
  if (currentPeriod === 'custom') {
    const s = Math.min(customStart, customEnd);
    const e = Math.max(customStart, customEnd);
    return [s, e + 1];
  }
  return [24 - currentPeriod, 24];
}

const startSel = document.getElementById('customStart');
const endSel = document.getElementById('customEnd');
D.months.forEach((m, i) => {
  const o1 = document.createElement('option'); o1.value = i; o1.textContent = m; startSel.appendChild(o1);
  const o2 = document.createElement('option'); o2.value = i; o2.textContent = m; endSel.appendChild(o2);
});
endSel.value = '23';

document.querySelectorAll('#periodGroup .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#periodGroup .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const p = btn.dataset.period;
    document.getElementById('customRange').classList.toggle('show', p === 'custom');
    currentPeriod = p === 'custom' ? 'custom' : parseInt(p);
    currentPage = 0;
    reorderPage = 0;
    rerender();
  });
});
startSel.addEventListener('change', () => { customStart = parseInt(startSel.value); rerender(); });
endSel.addEventListener('change', () => { customEnd = parseInt(endSel.value); rerender(); });

document.querySelectorAll('#viewGroup .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#viewGroup .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    rerender();
  });
});

// Planning-days info — single-line summary per option + [more] toggle (mirrors the Demand Basis / Scope explainers)
let _planningInfoExpanded = false;
function renderPlanningInfo() {
  const el = document.getElementById('planningInfo');
  if (!el) return;
  const d = planningDays;

  const summary = {
    30:  'Tight 30-day cover — order frequently, hold minimal stock. Best for fast-moving A-class items, short lead times, or low storage cost.',
    45:  'Short 45-day cover — small buffer for steady, fast-moving SKUs without tying up too much capital.',
    60:  'Default 60-day cover — standard target for most catalogs. A sensible mid-point between stockout risk and inventory carrying cost.',
    75:  'Comfortable 75-day cover — extra buffer for slower SKUs or where supplier reliability is uneven.',
    90:  'Long 90-day cover — appropriate for slow-moving (C-class) items, long lead times, or seasonal stockpile builds.',
    120: 'Very long 120-day cover — for items with very long lead times (overseas imports, custom orders) or large seasonal swings.',
    abc: 'Class-aware planning — A items target 30 days, B items 60, C items 90. Matches standard inventory practice: fast movers reviewed often, slow movers held longer.',
  };

  const details = {
    30:  `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 30 / 30 = monthly demand</span>
      <p>You hold approximately one month of cover at all times. Order again as soon as stock falls below the next month's expected demand.</p>
      <p><strong>Best for:</strong> A-class fast movers · items with short lead times (≤ 7 days) · low-cost-to-hold items · stable suppliers</p>
      <p><strong>Trade-offs:</strong> minimum capital tied up in inventory, but you must re-order more frequently and have less buffer for unexpected demand spikes or supplier delays.</p>
    `,
    45:  `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 45 / 30 = monthly demand × 1.5</span>
      <p>You hold about a month and a half of cover. A modest buffer beyond pure month-to-month replenishment.</p>
      <p><strong>Best for:</strong> A/B-class items with reliable supply · items with 1-2 week lead times</p>
      <p><strong>Trade-offs:</strong> slightly more capital tied up than 30-day, but a meaningful safety buffer against demand variability.</p>
    `,
    60:  `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 60 / 30 = monthly demand × 2</span>
      <p>Two months of cover. The dashboard's default and a common choice across most industries.</p>
      <p><strong>Best for:</strong> the majority of SKUs · 2-4 week lead times · normal supplier reliability</p>
      <p><strong>Trade-offs:</strong> balanced — moderate inventory cost, comfortable safety buffer, manageable re-order cadence.</p>
    `,
    75:  `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 75 / 30 = monthly demand × 2.5</span>
      <p>Two and a half months of cover. Extra buffer beyond the standard 60-day window.</p>
      <p><strong>Best for:</strong> items with variable lead times · suppliers with occasional delays · slower B-class items</p>
      <p><strong>Trade-offs:</strong> more capital tied up but resilient against most supply hiccups.</p>
    `,
    90:  `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 90 / 30 = monthly demand × 3</span>
      <p>Three months of cover. Appropriate when inventory holding cost is low relative to stockout cost.</p>
      <p><strong>Best for:</strong> C-class slow movers · seasonal items (build stock before peak) · items with 4-8 week lead times · import-heavy SKUs</p>
      <p><strong>Trade-offs:</strong> significant capital in inventory, but stockout risk is low and you re-order infrequently.</p>
    `,
    120: `
      <strong>Formula:</strong> <span class="formula">Suggested = monthly demand × 120 / 30 = monthly demand × 4</span>
      <p>Four months of cover. The longest standard window — used when you can't react quickly to supply or demand changes.</p>
      <p><strong>Best for:</strong> overseas imports with 2-3 month lead times · seasonal stockpile builds · items with batch-production constraints · suppliers with rigid order cycles</p>
      <p><strong>Trade-offs:</strong> maximum capital tied up; risk of obsolescence on slow-moving items; minimum re-order frequency.</p>
    `,
    abc: `
      <strong>Class-aware formula:</strong>
      <ul style="margin: 6px 0 0 18px; line-height: 1.5;">
        <li><strong>A items</strong> → <span class="formula">monthly demand × 30 / 30 = 1 month cover</span> — fast movers reviewed monthly</li>
        <li><strong>B items</strong> → <span class="formula">monthly demand × 60 / 30 = 2 months cover</span> — mid-tier standard</li>
        <li><strong>C items</strong> → <span class="formula">monthly demand × 90 / 30 = 3 months cover</span> — slow movers held longer</li>
      </ul>
      <p style="margin-top: 8px;"><strong>Why this matters:</strong> A-class items make up ~20% of SKUs but drive ~80% of revenue. Stockouts on them cost a lot, so you want tight cover and frequent reviews. C-class items contribute much less, so it's cheaper to hold more stock and review less often.</p>
      <p><strong>Use this when:</strong> your catalog has a clear ABC split (it does — see the A/B/C pills in the Identity column) and you want the planning window to track each SKU's commercial importance automatically rather than applying one number to everything.</p>
      <p style="color: var(--text-3); font-size: 10px;">If a SKU has no ABC class assigned, it falls back to C (90 days) by default.</p>
    `,
  };

  const key = (d === 'abc') ? 'abc' : d;
  el.innerHTML = `
    ${summary[key] || summary[60]}
    <a href="#" class="demand-info-toggle" id="planningInfoToggle">${_planningInfoExpanded ? '× less' : '+ more'}</a>
    ${_planningInfoExpanded ? `<div class="demand-info-details">${details[key] || details[60]}</div>` : ''}
  `;
  const toggle = document.getElementById('planningInfoToggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      _planningInfoExpanded = !_planningInfoExpanded;
      renderPlanningInfo();
    });
  }
}

// Planning-days toggle (Reorder Now tab)
document.querySelectorAll('#planningGroup .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#planningGroup .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const d = btn.dataset.days;
    planningDays = d === 'abc' ? 'abc' : parseInt(d);
    reorderPage = 0;
    renderPlanningInfo();
    rerender();
  });
});
renderPlanningInfo();  // initial render

// Reorder scope toggle (Reorder Now tab)
// Scope info — single-line summary per filter + [more] toggle (mirrors the Demand Basis explainer)
let _scopeInfoExpanded = false;
function renderScopeInfo() {
  const el = document.getElementById('scopeInfo');
  if (!el) return;
  const s = reorderScope || 'needed';

  const summary = {
    needed: 'Items that need an order TODAY — Order column > 0 (Total falls short of Suggested for the planning window), plus your manual additions. The action list — what to put on a PO this week.',
    auto:   'Every SKU the system flagged as a reorder candidate, even those currently covered by stock. The watch list — useful when widening the planning window to see what tips into action.',
    manual: 'Just the SKUs you pushed onto the list yourself via the + button or the search-add bar. No auto-flagged items appear here.',
    all:    'Auto-flagged ∪ Manual added (excluding × dismissals and discontinued items). The full reorder universe regardless of whether each item currently needs ordering.',
  };

  const details = {
    needed: `
      <strong>How an item enters this list:</strong>
      <ul style="margin: 6px 0 0 18px; line-height: 1.5;">
        <li><strong>Either</strong> the calculated Order column is > 0 — i.e. <span class="formula">Suggested − (hand + transit + pending) > 0</span> for the selected planning days</li>
        <li><strong>Or</strong> you manually added the SKU via the + button (Monthly P/S Detail) or the search-add bar (top of Reorder Now)</li>
      </ul>
      <p><strong>Excluded:</strong> items you dismissed via × · discontinued items · PNA items where you've not yet pre-planned them</p>
      <p style="margin-top: 8px;"><strong>Use this scope when:</strong> you're sitting down to draft today's purchase order. Everything in this list either needs ordering or you've explicitly told the dashboard to keep it on the list.</p>
      <p><strong>The count next to the button</strong> is your real action backlog — it goes up if a planning window widens, lead times worsen, or sales accelerate; it goes down as you place orders and stock arrives.</p>
    `,
    auto: `
      <strong>What "auto-flagged" means:</strong> the underlying data carries a flag (<span class="formula">p.r > 0</span> in the dataset) marking each SKU as a reorder candidate. The flag is set based on:
      <ul style="margin: 6px 0 0 18px; line-height: 1.5;">
        <li>Days of cover below an internal threshold</li>
        <li>ABC class (A-class SKUs get flagged earlier)</li>
        <li>Stockout risk score baked into the dataset</li>
        <li>Whether pipeline (transit/pending) already closes the gap</li>
      </ul>
      <p style="margin-top: 8px;"><strong>Important:</strong> auto-flagged items can still show <span class="formula">Order 0</span> (green "Covered") if their total stock currently exceeds the suggested target for the planning window — they're flagged but not urgent <em>right now</em>.</p>
      <p><strong>Use this scope when:</strong> you want to scan the watch list, including items that aren't pressing today but might tip into action if planning days widen or sales pick up.</p>
      <p style="color: var(--text-3); font-size: 10px;">The gap between <strong>Need order now</strong> and <strong>Auto-flagged</strong> tells you something useful: how many flagged items are currently well-stocked.</p>
    `,
    manual: `
      <strong>What manual additions are:</strong> SKUs you explicitly told the dashboard to track for ordering — items the system did <em>not</em> auto-flag, but you want to keep on the radar.
      <p><strong>How to add an item manually:</strong></p>
      <ul style="margin: 6px 0 0 18px; line-height: 1.5;">
        <li>Click the <strong>+ button</strong> on any row in Monthly P/S Detail</li>
        <li>Use the <strong>search-add bar</strong> at the top of Reorder Now (type the product name or code)</li>
      </ul>
      <p style="margin-top: 8px;"><strong>Default Order quantity for manual items:</strong> <span class="formula">max(planning_need, defaultManualQty)</span> — at least 1, so the row always has a number you can edit.</p>
      <p><strong>How to remove:</strong> click the × button on the row, or the × on the chip in the search-add bar.</p>
      <p><strong>Use this scope when:</strong> you want to review just the items you've taken responsibility for yourself, independent of the system's automatic flags.</p>
      <p style="color: var(--text-3); font-size: 10px;">Manual additions persist across reloads (saved to localStorage). They survive a "Reset edits" only if you choose to reset everything.</p>
    `,
    all: `
      <strong>What "All" contains:</strong> <span class="formula">isInReorder(p) === true</span> — i.e. the union of:
      <ul style="margin: 6px 0 0 18px; line-height: 1.5;">
        <li>Auto-flagged items (the system's reorder candidates)</li>
        <li>Manual additions (your overrides)</li>
      </ul>
      <p style="margin-top: 8px;"><strong>What's excluded:</strong> items you dismissed via × (auto-excluded set), and items marked discontinued.</p>
      <p><strong>Use this scope when:</strong> you want the complete picture — the entire reorder universe in one view. Useful for portfolio-level reviews (e.g. "how many SKUs are on my reorder radar in total this month?") or when comparing the watch list against the manual additions.</p>
      <p><strong>Sort order:</strong> manuals first, then by priority (P1 → P2 → P3), then by need quantity descending.</p>
    `,
  };

  el.innerHTML = `
    ${summary[s] || summary.needed}
    <a href="#" class="demand-info-toggle" id="scopeInfoToggle">${_scopeInfoExpanded ? '× less' : '+ more'}</a>
    ${_scopeInfoExpanded ? `<div class="demand-info-details">${details[s] || details.needed}</div>` : ''}
  `;
  const toggle = document.getElementById('scopeInfoToggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      _scopeInfoExpanded = !_scopeInfoExpanded;
      renderScopeInfo();
    });
  }
}

document.querySelectorAll('#reorderScopeGroup .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#reorderScopeGroup .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    reorderScope = btn.dataset.scope;
    reorderPage = 0;
    renderScopeInfo();
    rerender();
  });
});
renderScopeInfo();  // initial render

// Demand basis info — single-line summary per method + [more] toggle for full details
let _demandInfoExpanded = false;
function renderDemandInfo() {
  const el = document.getElementById('demandInfo');
  if (!el) return;
  const m = demandMethod || 'auto';

  const summary = {
    auto:     'Each SKU is routed to the best formula based on its detected demand shape (badge on every row). Bulk sales-spike months are detected and excluded from Lumpy SKUs.',
    mean6:    'Simple arithmetic average of the last 6 months sales. Every value counts equally, so one spike pulls the number up.',
    median6:  'Middle value of the last 6 months when sorted. Half higher, half lower — completely ignores one-off spikes.',
    trimmed6: 'Drops the single highest month, then averages the remaining 5. Less aggressive than Median; protects against one outlier.',
    median12: 'Middle value of the last 12 months when sorted. Slower-moving, smoothes seasonality.',
  };

  const details = {
    auto: `
      <strong>How Auto routes each SKU:</strong> the dashboard inspects each SKU's 24-month sales history, measures variability (CoV), zero-month fraction, and trend, then classifies the SKU into one of six buckets. Each bucket uses the formula best suited to it.
      <div class="auto-header"><span>BADGE</span><span>DETECTED WHEN…</span><span>FORMULA USED</span></div>
      <div class="auto-row"><span><span class="demand-class smooth">SMOOTH</span></span><span class="col-when">Low variability (CoV &lt; 0.6), few zero months, no clear trend</span><span class="col-formula">Mean of last 6 months</span></div>
      <div class="auto-row"><span><span class="demand-class trending">TRENDING</span></span><span class="col-when">Mean of last 3 months diverges ≥ 30% from mean of last 12</span><span class="col-formula">(mean₃ × 2 + mean₆) / 3</span></div>
      <div class="auto-row"><span><span class="demand-class intermittent">INTERMITTENT</span></span><span class="col-when">≥ 30% zero-sales months, no large spikes</span><span class="col-formula">Median of last 12 months</span></div>
      <div class="auto-row"><span><span class="demand-class lumpy">LUMPY</span></span><span class="col-when">≥ 30% zero months + at least one spike (&gt; 3× median) — project orders</span><span class="col-formula">Median of clean months (spikes + zeros excluded)</span></div>
      <div class="auto-row"><span><span class="demand-class erratic">ERRATIC</span></span><span class="col-when">High month-to-month CoV (&gt; 0.6) but no clear lumpiness</span><span class="col-formula">Median of last 6 months</span></div>
      <div class="auto-row"><span><span class="demand-class dead">DEAD</span></span><span class="col-when">Zero sales in last 6 consecutive months</span><span class="col-formula">0 — no reorder suggested</span></div>
      <p style="margin-top: 10px; color: var(--text-3); font-size: 10px;">Sales spikes (likely one-off project orders) are detected separately: any month where sales &gt; 2.5× median of non-zero months is flagged with a <strong style="color: var(--purple);">purple dot</strong> in Monthly P/S. Lumpy SKUs exclude these flagged months from their demand calc.</p>
    `,
    mean6: `
      <strong>Formula:</strong> <span class="formula">sum(last 6 months sales) ÷ 6</span>
      <p><strong>Best for:</strong> Products with steady, predictable demand and no occasional bulk/project orders.</p>
      <p><strong>Avoid when:</strong> The SKU has occasional huge orders (e.g. project sales). Those spikes inflate the average and the dashboard over-suggests stock.</p>
      <p><strong>Example:</strong> Last 6 months sales = 10, 12, 11, 9, 10, 500 (one project order). Mean = <span class="formula">552 ÷ 6 = 92</span>/month — suggests ~138 units for 45-day cover, but ongoing real demand is only ~10/month.</p>
    `,
    median6: `
      <strong>Formula:</strong> <span class="formula">middle value of the last 6 months when sorted</span> (average of the two middle values if there's an even count)
      <p><strong>Best for:</strong> Products with occasional spikes that shouldn't drive ongoing reorder (project sales, one-time bulk customers).</p>
      <p><strong>Pros:</strong> Completely robust to outliers — a single 500-unit spike can't move the median.</p>
      <p><strong>Cons:</strong> Slower to react to genuine demand changes (e.g. real growth gets understated).</p>
      <p><strong>Example:</strong> Sales = 10, 12, 11, 9, 10, 500. Sorted: 9, 10, 10, 11, 12, 500. Median = <span class="formula">(10 + 11) ÷ 2 = 10.5</span> — ignores the project order.</p>
    `,
    trimmed6: `
      <strong>Formula:</strong> <span class="formula">drop the single highest month, then average the remaining 5</span>
      <p><strong>Best for:</strong> Middle ground — you trust most of the data but want protection against one bad data point (one project order, one return spike).</p>
      <p><strong>Pros:</strong> Uses more data than Median; still robust to a single outlier.</p>
      <p><strong>Cons:</strong> Vulnerable to two or more spikes (only drops one).</p>
      <p><strong>Example:</strong> Sales = 10, 12, 11, 9, 10, 500. Drop 500 → average of (10, 12, 11, 9, 10) = <span class="formula">52 ÷ 5 = 10.4</span>.</p>
    `,
    median12: `
      <strong>Formula:</strong> <span class="formula">middle value of the last 12 months when sorted</span>
      <p><strong>Best for:</strong> Stable products where you want to smooth seasonality and use more historical context.</p>
      <p><strong>Pros:</strong> Less sensitive to recent fluctuations; very robust to outliers.</p>
      <p><strong>Cons:</strong> Slow to react to genuine trend changes — recent growth is dampened by the 12-month window.</p>
      <p><strong>Example:</strong> Use this when you want stability and the SKU's demand has been roughly the same shape for the past year.</p>
    `,
  };

  el.innerHTML = `
    ${summary[m] || summary.auto}
    <a href="#" class="demand-info-toggle" id="demandInfoToggle">${_demandInfoExpanded ? '× less' : '+ more'}</a>
    ${_demandInfoExpanded ? `<div class="demand-info-details">${details[m] || details.auto}</div>` : ''}
  `;
  const toggle = document.getElementById('demandInfoToggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      _demandInfoExpanded = !_demandInfoExpanded;
      renderDemandInfo();
    });
  }
}

// Demand basis toggle — controls how monthly demand is estimated from sales history
(function setupDemandBasis() {
  const grp = document.getElementById('demandBasisGroup');
  if (!grp) return;
  // Restore active state from persisted preference
  grp.querySelectorAll('.btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === demandMethod);
  });
  grp.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', () => {
      grp.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      demandMethod = btn.dataset.method;
      try { localStorage.setItem('inventoryDemandMethod', demandMethod); } catch (e) {}
      reorderPage = 0;
      renderDemandInfo();   // refresh info text for the new method
      rerender();
    });
  });
  renderDemandInfo();  // initial render
})();

function stockClass(p) {
  if (STATUS[p.st] === 'Critical' || p.k === 0 && p.a > 0) return 'crit';
  if (STATUS[p.st] === 'Low Stock') return 'low';
  if (STATUS[p.st] === 'Overstocked') return 'high';
  return '';
}

function renderMonthlyGrid(products) {
  const [s, e] = getRange();
  const labels = D.months.slice(s, e);
  const reverseLabels = labels.slice().reverse();
  const reverseIdx = [];
  for (let i = labels.length - 1; i >= 0; i--) reverseIdx.push(s + i);
  const currentMonthIdx = 23;

  let head = '<tr>';
  head += '<th class="fixed-l l0">Product</th>';
  head += '<th class="fixed-l l2 num">Stock</th>';
  head += '<th class="fixed-l l3">Status</th>';
  reverseLabels.forEach((l, i) => {
    const isCurrent = reverseIdx[i] === currentMonthIdx;
    head += `<th class="month-h num ${isCurrent ? 'current' : ''}">${l.toUpperCase()}</th>`;
  });
  if (currentView === 'sales' || currentView === 'purchases') head += '<th class="num totals">Total</th>';
  else head += '<th class="num totals">Σ Buy</th><th class="num totals">Σ Sell</th>';
  head += '</tr>';
  document.getElementById('mgridHead').innerHTML = head;

  const start = currentPage * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const rows = pageProducts.map(p => {
    const purch = p.p.length ? p.p : new Array(24).fill(0);
    const sales = p.s.length ? p.s : new Array(24).fill(0);
    const purchSlice = purch.slice(s, e);
    const salesSlice = sales.slice(s, e);
    const totP = purchSlice.reduce((a,b)=>a+b,0);
    const totS = salesSlice.reduce((a,b)=>a+b,0);

    const vendor = D.vendors[p.v];
    const status = STATUS[p.st];
    const abcLetter = ABCS[p.b];
    const childCount = p.ch.length;

    const inReorder = isInReorder(p);
    const manualOnly = isManualOnly(p);
    const disc = isDiscontinued(p);
    const rowClass = [
      inReorder ? (manualOnly ? 'in-reorder manual-row' : 'in-reorder') : '',
      disc ? 'discontinued' : ''
    ].filter(Boolean).join(' ');
    let reorderMarker = '';
    if (inReorder && !disc) {
      reorderMarker = manualOnly
        ? `<span class="in-reorder-marker manual" title="Added manually to reorder list">In reorder · manual</span>`
        : `<span class="in-reorder-marker" title="Auto-flagged for reorder">In reorder</span>`;
    }
    const discMarker = disc ? `<span class="disc-pill" title="Marked as discontinued — excluded from Reorder Now">Discontinued</span>` : '';
    const reorderBtn = disc
      ? '' // hide reorder toggle on discontinued items
      : (manualOnly
        ? `<button class="add-to-reorder added" data-pid="${p.i}" data-action="remove-manual" title="Remove from manual reorder list" aria-label="Remove from reorder">−</button>`
        : (p.r > 0
            ? ''
            : `<button class="add-to-reorder" data-pid="${p.i}" data-action="add-manual" title="Add to Reorder Now" aria-label="Add to reorder">+</button>`));
    const discBtn = `<button class="disc-btn ${disc ? 'on' : ''}" data-pid="${p.i}" type="button" title="${disc ? 'Unmark as discontinued (restore)' : 'Mark as discontinued — excludes from Reorder Now'}" aria-label="Toggle discontinued">${disc ? '↺' : '⊘'}</button>`;
    const aiBtn = `<button class="ai-btn ai-row-btn" data-pid="${p.i}" type="button" title="Copy a detailed AI analysis brief for this SKU (paste into Claude to ask why it spiked, whether to order, etc.)">AI</button>`;

    let row = `<tr data-pid="${p.i}" class="${rowClass}">`;
    // Build the meta line (vendor + cat + subcat + folder) shown BELOW the product name
    const _catName  = (D.cats && p.c != null) ? (D.cats[p.c] || '') : '';
    const _subName  = getProductSubCategory(p);
    const _folderName = D.folders[p.fl] || '';
    const _metaParts = [`<span class="m-vendor">${vendor.code}</span>`];
    if (_catName) _metaParts.push(`<span class="m-cat">${_catName}</span>`);
    if (_subName) _metaParts.push(`<span class="m-arrow">›</span><span class="m-sub">${_subName}</span>`);
    if (_folderName) _metaParts.push(`<span class="m-folder">${_folderName}</span>`);
    const _productMetaLine = `<div class="product-meta-line">${_metaParts.join('<span class="m-sep">·</span>')}</div>`;

    // Demand-classification badge — only shown when the Demand Basis is on Auto.
    // Other methods (Mean / Median / Trimmed) don't route by classification, so the badge would be misleading.
    let _mpsDcBadge = '';
    if (demandMethod === 'auto') {
      const _mpsDc = (p._dc || classifyDemand(p));
      const _mpsSaCount = (p.sa || []).length;
      const _dcShortMap = { smooth: 'SM', trending: 'TR', intermittent: 'IT', lumpy: 'LM', erratic: 'ER', dead: 'DD' };
      const _mpsShort = _dcShortMap[_mpsDc.class] || (_mpsDc.class || '').toUpperCase().slice(0, 2);
      const _mpsFull = (_mpsDc.class || '').toUpperCase();
      _mpsDcBadge = _mpsDc.class
        ? `<span class="demand-class ${_mpsDc.class}" title="${_mpsFull} — ${_mpsDc.reason || ''}${_mpsSaCount > 0 ? ` · ${_mpsSaCount} sales-spike month${_mpsSaCount > 1 ? 's' : ''} detected (purple dots in Monthly P/S)` : ''}">${_mpsShort}</span>`
        : '';
    }

    row += `<td class="product fixed-l l0" title="${p.n} · ${vendor.name}">
      <div class="product-line-1">${p.n} <span class="pill abc-${abcLetter}" style="margin-left:6px;">${abcLetter}</span>${_mpsDcBadge}${childCount > 0 ? `<button class="child-toggle" data-pid="${p.i}">▸ ${childCount}</button>` : ''}${discMarker}${reorderMarker}${reorderBtn}</div>
      ${_productMetaLine}
    </td>`;
    // Vendor column removed — vendor info lives in the meta line under the product name (col l0)
    // Pipeline-aware stock cell: on-hand prominent, transit + pending micro
    const pipelineParts = [];
    if (p.it > 0) pipelineParts.push(`<span class="pipe-t" title="In transit (dispatched from factory)">+${fmt(p.it)}T</span>`);
    if (p.po > 0) pipelineParts.push(`<span class="pipe-p" title="Pending at factory (planned, not yet manufactured)">+${fmt(p.po)}P</span>`);
    const pipelineStr = pipelineParts.length ? `<div class="pipe-line">${pipelineParts.join(' ')}</div>` : '';
    // Stock cell — on-hand prominent, pipeline below, then S/B pills (avg sales / avg buys per month over the selected period)
    const _stockMonths = Math.max(1, reverseLabels.length);
    const _stockAvgS = totS / _stockMonths;
    const _stockAvgP = totP / _stockMonths;
    const _stockSpPills = `<div class="sp-pills">
      <span class="sp-pill s" title="Avg monthly sales over the last ${_stockMonths} months: ${fmt(totS)} ÷ ${_stockMonths} = ${_stockAvgS.toFixed(1)}/mo">S ${_stockAvgS.toFixed(1)}</span>
      <span class="sp-pill b" title="Avg monthly purchases over the last ${_stockMonths} months: ${fmt(totP)} ÷ ${_stockMonths} = ${_stockAvgP.toFixed(1)}/mo">B ${_stockAvgP.toFixed(1)}</span>
    </div>`;
    row += `<td class="num fixed-l l2"><div class="stock-stack"><span class="stock-cell ${stockClass(p)}">${fmt(p.k)}</span>${pipelineStr}${_stockSpPills}</div></td>`;
    const _pnaDate = getPNADate(p);
    const _pnaDisp = _pnaDate ? formatDate(_pnaDate) : '';
    const pnaPill = isPNA(p)
      ? `<span class="pill pna" title="Paper Not Available — refill expected ${_pnaDisp || 'date TBD'}">PNA${_pnaDisp ? ' · ' + _pnaDisp : ''}</span> `
      : '';
    const discPillStatus = disc
      ? `<span class="pill disc-status" title="Marked as discontinued — excluded from Reorder Now">DISC</span> `
      : '';
    row += `<td class="fixed-l l3">${pnaPill}${discPillStatus}<span class="pill ${statusClass(status)}">${status}</span></td>`;

    for (let i = 0; i < reverseIdx.length; i++) {
      const origIdx = reverseIdx[i];
      const localIdx = origIdx - s;
      const pVal = purchSlice[localIdx];
      const sVal = salesSlice[localIdx];
      const isCurrent = origIdx === currentMonthIdx;
      const isBulk = p.ba.includes(origIdx);
      const isSalesAnom = (p.sa || []).includes(origIdx);
      const showBulkDot  = isBulk      && (currentView !== 'sales');
      const showSalesDot = isSalesAnom && (currentView !== 'purchases');
      const cls = `month-c ${isCurrent ? 'current' : ''} ${showBulkDot ? 'bulk-anom' : ''} ${showSalesDot ? 'sales-anom' : ''}`;
      let cell = '';
      if (currentView === 'sales') {
        cell = sVal === 0 ? '<span class="empty">—</span>' : fmtCompact(sVal);
        row += `<td class="${cls} ${sVal === 0 ? 'empty' : ''}">${cell}</td>`;
      } else if (currentView === 'purchases') {
        cell = pVal === 0 ? '<span class="empty">—</span>' : `<span style="color:var(--accent-2)">${fmtCompact(pVal)}</span>`;
        row += `<td class="${cls} ${pVal === 0 ? 'empty' : ''}">${cell}</td>`;
      } else {
        cell = `<div class="ps-pair">
          <span class="${pVal === 0 ? 'empty' : 'p'}">${pVal === 0 ? '—' : fmtCompact(pVal)}</span>
          <span class="${sVal === 0 ? 'empty' : 's'}">${sVal === 0 ? '—' : fmtCompact(sVal)}</span>
        </div>`;
        row += `<td class="${cls}">${cell}</td>`;
      }
    }

    if (currentView === 'sales') row += `<td class="num totals" style="color:var(--green)">${fmt(totS)}</td>`;
    else if (currentView === 'purchases') row += `<td class="num totals" style="color:var(--accent-2)">${fmt(totP)}</td>`;
    else row += `<td class="num totals" style="color:var(--accent-2)">${fmt(totP)}</td><td class="num totals" style="color:var(--green)">${fmt(totS)}</td>`;

    row += '</tr>';
    return row;
  }).join('');

  document.getElementById('mgridBody').innerHTML = rows;

  document.querySelectorAll('.child-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChildren(parseInt(btn.dataset.pid), btn);
    });
  });

  // Wire the per-row +/− reorder buttons (Monthly P/S → Reorder Now)
  document.querySelectorAll('#mgridBody .add-to-reorder').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      const action = btn.dataset.action;
      if (action === 'add-manual') {
        manualReorderIds.add(pid);
        const p = D.products.find(x => x.i === pid);
        if (p && reorderEdits[pid] == null) reorderEdits[pid] = Math.max(1, p.f || 1);
        saveEdits();
        // Brief tactile feedback animation
        btn.classList.add('flash-added');
        setTimeout(() => btn.classList.remove('flash-added'), 400);
      } else if (action === 'remove-manual') {
        manualReorderIds.delete(pid);
      }
      saveManualReorder();
      rerender();
    });
  });

  // Wire the discontinued ⊘ / ↺ toggle buttons
  document.querySelectorAll('#mgridBody .disc-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      toggleDiscontinued(pid);
      rerender();
    });
  });

  // Wire the AI brief buttons — opens chat panel if API key is set, falls back to clipboard copy
  document.querySelectorAll('#mgridBody .ai-row-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      const p = D.products.find(x => x.i === pid);
      if (!p) return;
      aiInvoke(p, btn);
    });
  });

  const totalPages = Math.ceil(products.length / pageSize);
  document.getElementById('pagInfo').innerHTML = products.length === 0
    ? 'No matching products'
    : `Showing <strong>${start+1}—${Math.min(start+pageSize, products.length)}</strong> of <strong>${fmt(products.length)}</strong> products${totalPages > 1 ? ' · page ' + (currentPage+1) + '/' + totalPages : ''}`;
  document.getElementById('pagPrev').disabled = currentPage === 0;
  document.getElementById('pagNext').disabled = currentPage >= totalPages - 1;
}

function toggleChildren(pid, btn) {
  const parentRow = btn.closest('tr');
  const existing = parentRow.nextElementSibling;
  if (existing && existing.classList.contains('child-row') && existing.dataset.parent === String(pid)) {
    // Collapse: remove all children rows for this pid
    let n = existing;
    while (n && n.classList.contains('child-row') && n.dataset.parent === String(pid)) {
      const next = n.nextElementSibling;
      n.remove();
      n = next;
    }
    btn.classList.remove('open');
    btn.innerHTML = btn.innerHTML.replace('▾', '▸');
    return;
  }
  // Expand
  const product = D.products.find(p => p.i === pid);
  if (!product) return;
  const children = getProductChildren(product);
  const colspan = parentRow.children.length;
  const fragments = children.map(ch => {
    const childFolder = ch.folder;
    const variantTag = ch.variant;
    // Build the per-child meta line (launch-date + cat · sub-cat) to show below the child code
    const _cCat = (D.cats && product && product.c != null) ? (D.cats[product.c] || '') : '';
    const _cSub = product ? getProductSubCategory(product) : '';
    const _cParts = [];
    if (ch.launchDate) _cParts.push(launchDateBadgeHtml(ch.launchDate));
    const _cCatLine = [_cCat, _cSub].filter(Boolean).join(' · ');
    if (_cCatLine) _cParts.push(`<span class="vc-cat">${_cCatLine}</span>`);
    const _childMetaLine = _cParts.length
      ? `<div class="product-meta-line">${_cParts.join('<span class="m-sep">·</span>')}</div>`
      : '';

    return `<tr class="child-row" data-parent="${pid}">
      <td class="product fixed-l l0">
        <div class="product-line-1">↳ <strong style="color:var(--accent)">${ch.code}</strong> <span class="child-folder-inline">${ch.folder || childFolder || ''}</span>${zoneBadgeHtml(ch.folder || childFolder)}</div>
        ${_childMetaLine}
      </td>
      <td class="fixed-l l2 num"><span class="child-variant">child SKU</span></td>
      <td class="fixed-l l3"><span class="child-variant">—</span></td>
      <td colspan="${colspan - 3}" class="child-variant" style="text-align:left; padding-left:24px;">child code · folder shown above</td>
    </tr>`;
  }).join('');
  parentRow.insertAdjacentHTML('afterend', fragments);
  btn.classList.add('open');
  btn.innerHTML = btn.innerHTML.replace('▸', '▾');
}

document.getElementById('pagPrev').addEventListener('click', () => { if (currentPage > 0) { currentPage--; rerender(); } });
document.getElementById('pagNext').addEventListener('click', () => { currentPage++; rerender(); });

// ===== Reorder tab (with editable Final Order) =====
// ===== Reorder Now tab — redesigned with clear visual zones =====
let reorderPage = 0;

function ageBandLabel(months) {
  if (months === 0) return { lbl: 'No Activity', cls: 'no-act' };
  if (months <= 3) return { lbl: 'New ' + months + 'm', cls: 'new' };
  if (months <= 6) return { lbl: 'Young ' + months + 'm', cls: 'young' };
  if (months <= 12) return { lbl: months + 'm', cls: 'established' };
  if (months < 24) return { lbl: months + 'm', cls: 'mature' };
  return { lbl: '24m+', cls: 'veteran' };
}

function reorderReason(p) {
  // Generate a short, plain-language reason for why this needs reorder
  const reasons = [];
  if (p.ad < 15) reasons.push('cover ≤15 days');
  else if (p.ad < 30) reasons.push('cover ≤30 days');
  if (ABCS[p.b] === 'A') reasons.push('Class A');
  if (p.k === 0 && p.av === 0) reasons.push('out of stock');
  if (p.it === 0 && p.po === 0 && p.r > 0) reasons.push('no pipeline');
  if (p.x > 70) reasons.push('high risk');
  if (p.pa > 0 && p.pa <= 6) reasons.push('young product');
  if (reasons.length === 0) reasons.push('low cover');
  return reasons.slice(0, 3).join(' · ');
}

function renderReorderMonthly(products) {
  // Compute recommended stock per product (per current planning policy + demand basis)
  function targetForP(p) {
    let days = planningDays;
    if (planningDays === 'abc') {
      const cls = ABCS[p.b];
      days = cls === 'A' ? 30 : cls === 'B' ? 60 : 90;
    }
    const monthlyDemand = computeDemand(p);                  // honours the selected demand basis
    const target = Math.round(monthlyDemand * days / 30);
    const total = (p.k || 0) + (p.it || 0) + (p.po || 0);    // hand + transit + pending
    const need = Math.max(0, target - total);                // to_be_ordered = suggested − total
    return { days, target, need, monthlyDemand };
  }

  // Apply scope filter (excluded items are filtered out — user dismissed them via ×)
  let scopeFiltered;
  if (reorderScope === 'needed') {
    // Show only items where calculated need > 0 OR manually added
    scopeFiltered = products.filter(p => {
      if (isExcluded(p)) return false;
      if (isManualOnly(p)) return true;
      const { need } = targetForP(p);
      return need > 0;
    });
  } else if (reorderScope === 'auto') {
    scopeFiltered = products.filter(p => p.r > 0 && !isExcluded(p));
  } else if (reorderScope === 'manual') {
    scopeFiltered = products.filter(p => isManualOnly(p));
  } else {
    scopeFiltered = products.filter(p => isInReorder(p));
  }

  // Sort: P1/P2/P3 priority, then by need descending, then by sales
  const sub = scopeFiltered.slice().sort((a, b) => {
    const aMan = isManualOnly(a) ? 0 : 1;
    const bMan = isManualOnly(b) ? 0 : 1;
    if (aMan !== bMan) return aMan - bMan;
    const ap = a.r > 0 ? PRIORITIES[a.pr] : 'Z';
    const bp = b.r > 0 ? PRIORITIES[b.pr] : 'Z';
    if (ap !== bp) return ap.localeCompare(bp);
    return (targetForP(b).need || 0) - (targetForP(a).need || 0);
  });
  document.getElementById('reorderCount').textContent = sub.length;

  // Update the scope-button counts
  const allInReorder = products.filter(p => isInReorder(p)).length;
  const autoOnly = products.filter(p => p.r > 0).length;
  const manualOnlyCount = products.filter(p => isManualOnly(p)).length;
  const neededCount = products.filter(p => isManualOnly(p) || targetForP(p).need > 0).length;
  document.getElementById('scopeNeededCount').textContent = '· ' + neededCount;
  document.getElementById('scopeAutoCount').textContent = '· ' + autoOnly;
  document.getElementById('scopeManualCount').textContent = '· ' + manualOnlyCount;
  document.getElementById('scopeAllCount').textContent = '· ' + allInReorder;

  // Default 6M for compact layout — but respect global currentPeriod if set
  const [s, e] = getRange();
  const labels = D.months.slice(s, e);
  const reverseLabels = labels.slice().reverse();
  const reverseIdx = [];
  for (let i = labels.length - 1; i >= 0; i--) reverseIdx.push(s + i);
  const currentMonthIdx = 23;

  // ===== Pipeline column totals — aggregated across the visible (sub) rows =====
  // Shows the buyer how much total stock is already on hand / in pipeline / suggested for the
  // current filter, without having to scroll through every row and add up mentally.
  let _tHand = 0, _tTransit = 0, _tPending = 0, _tSuggest = 0, _tNeed = 0;
  sub.forEach(p => {
    _tHand    += (p.k  || 0);
    _tTransit += (p.it || 0);
    _tPending += (p.po || 0);
    const t = targetForP(p);
    _tSuggest += (t.target || 0);
    _tNeed    += (t.need   || 0);
  });
  const _tTotal = _tHand + _tTransit + _tPending;

  // Header — 4 sticky cols (compact): Identity / Days / Pipeline+Target / Order Qty
  let head = '<tr>';
  head += '<th class="fixed-l l0">Product</th>';
  head += '<th class="fixed-l l1 num">Days</th>';
  // Pipeline header — always show both rows (Hand+Transit+Pending=Total AND Suggested·To Order).
  head += `<th class="fixed-l l2 num pipe-head"><div class="pipe-head-stack expanded">
    <div class="pipe-head-grid pipe-summary">
      <div class="ph-col"><div class="ph-lbl">Hand</div><div class="ph-val">${fmt(_tHand)}</div></div>
      <div class="ph-sep">+</div>
      <div class="ph-col"><div class="ph-lbl">Transit</div><div class="ph-val blue">${fmt(_tTransit)}</div></div>
      <div class="ph-sep">+</div>
      <div class="ph-col"><div class="ph-lbl">Pending</div><div class="ph-val orange">${fmt(_tPending)}</div></div>
      <div class="ph-sep">=</div>
      <div class="ph-col"><div class="ph-lbl">Total</div><div class="ph-val strong">${fmt(_tTotal)}</div></div>
    </div>
    <div class="pipe-head-divider"></div>
    <div class="pipe-head-grid pipe-detail">
      <div class="ph-col"><div class="ph-lbl">Suggested</div><div class="ph-val">${fmt(_tSuggest)}</div></div>
      <div class="ph-sep">·</div>
      <div class="ph-col"><div class="ph-lbl">To Order</div><div class="ph-val orange strong">${fmt(_tNeed)}</div></div>
    </div>
  </div></th>`;
  head += '<th class="fixed-l l3 num"><div class="oq-head">Order Qty<div class="oq-btn-row"><button class="oq-fill-btn" id="useSuggestedQtyBtnInline" type="button" title="Fill every visible Order Qty input with the system-suggested value">Suggested</button><button class="oq-clear-btn" id="clearQtyBtnInline" type="button" title="Clear every visible Order Qty input back to 0">⌫ Clear</button></div></div></th>';
  reverseLabels.forEach((l, i) => {
    const isCurrent = reverseIdx[i] === currentMonthIdx;
    head += `<th class="month-h num ${isCurrent ? 'current' : ''}">${l.toUpperCase()}</th>`;
  });
  if (currentView === 'sales' || currentView === 'purchases') head += '<th class="num totals">Total</th>';
  else head += '<th class="num totals">Σ Buy</th><th class="num totals">Σ Sell</th>';
  head += '</tr>';
  document.getElementById('rmgridHead').innerHTML = head;
  // Wire the inline "⇩ Use Suggested" + "⌫ Clear" buttons that live inside the Order Qty header.
  // Both are re-created on every grid render, so listeners must be re-attached each time.
  const _oqBtn = document.getElementById('useSuggestedQtyBtnInline');
  if (_oqBtn) {
    _oqBtn.addEventListener('click', () => {
      const suggestSpans = document.querySelectorAll('#rmgridBody .suggest-quick');
      if (suggestSpans.length === 0) return;
      let filled = 0;
      suggestSpans.forEach(el => {
        const pid = parseInt(el.dataset.pid);
        const sv  = parseInt(el.dataset.suggest);
        if (!Number.isFinite(pid) || !Number.isFinite(sv) || sv <= 0) return;
        reorderEdits[pid] = sv;
        const inp = document.querySelector(`#rmgridBody .deci-input[data-pid="${pid}"]`);
        if (inp) { inp.value = sv; inp.classList.add('edited'); }
        filled++;
      });
      saveEdits();
      document.getElementById('editCount').textContent = getEditCount();
      updateReorderFloatingTotal();
      const orig = _oqBtn.textContent;
      _oqBtn.textContent = `✓ Filled ${filled}`;
      _oqBtn.disabled = true;
      setTimeout(() => { _oqBtn.textContent = orig; _oqBtn.disabled = false; }, 1500);
    });
  }
  const _clrBtn = document.getElementById('clearQtyBtnInline');
  if (_clrBtn) {
    _clrBtn.addEventListener('click', () => {
      const inputs = document.querySelectorAll('#rmgridBody .deci-input');
      if (inputs.length === 0) return;
      let cleared = 0;
      inputs.forEach(inp => {
        const pid = parseInt(inp.dataset.pid);
        if (!Number.isFinite(pid)) return;
        // Only count it as "cleared" if there was something to clear.
        if (reorderEdits[pid] != null) cleared++;
        delete reorderEdits[pid];
        inp.value = 0;
        inp.classList.remove('edited');
      });
      saveEdits();
      document.getElementById('editCount').textContent = getEditCount();
      updateReorderFloatingTotal();
      const orig = _clrBtn.textContent;
      _clrBtn.textContent = cleared > 0 ? `✓ Cleared ${cleared}` : '✓ Already empty';
      _clrBtn.disabled = true;
      setTimeout(() => { _clrBtn.textContent = orig; _clrBtn.disabled = false; }, 1500);
    });
  }

  const start = reorderPage * pageSize;
  const pageProducts = sub.slice(start, start + pageSize);

  const rows = pageProducts.map(p => {
    const purch = p.p.length ? p.p : new Array(24).fill(0);
    const sales = p.s.length ? p.s : new Array(24).fill(0);
    const purchSlice = purch.slice(s, e);
    const salesSlice = sales.slice(s, e);
    const totP = purchSlice.reduce((a,b)=>a+b,0);
    const totS = salesSlice.reduce((a,b)=>a+b,0);

    const vendor = D.vendors[p.v];
    const folder = D.folders[p.fl];
    const priority = p.r > 0 ? PRIORITIES[p.pr] : '—';
    const priorityCode = priority.split(' ')[0];
    const abcLetter = ABCS[p.b];
    const childCount = p.ch.length;
    const age = ageBandLabel(p.pa);
    const manualOnly = isManualOnly(p);
    const { days, target, need, monthlyDemand } = targetForP(p);

    // System-suggested qty (shown as a reference hint only — never auto-filled)
    const suggestedQty = manualOnly ? Math.max(need, defaultManualQty(p)) : need;
    // Order qty ALWAYS starts at 0 — the user must type in every order quantity manually.
    // Once they type a value, reorderEdits[p.i] holds it (across page navigation).
    const finalQty = reorderEdits[p.i] != null ? reorderEdits[p.i] : 0;
    const isEdited = reorderEdits[p.i] != null && reorderEdits[p.i] > 0;
    // defaultQty is kept around for the input's data-original attribute and tooltip text;
    // it equals the system suggestion (so users can compare what they typed vs. what the
    // system computed), not the auto-applied value.
    const defaultQty = suggestedQty;

    // Days cover badge
    const daysClass = p.ad < 15 ? 'crit' : p.ad < 30 ? 'low' : p.ad < 9999 ? 'ok' : 'inf';
    const daysDisplay = p.ad >= 999 ? '∞' : p.ad;

    let row = `<tr data-pid="${p.i}" data-priority="${priorityCode}" ${manualOnly ? 'data-manual="1"' : ''}>`;

    // Demand-class badge — only shown when Demand Basis is on Auto.
    // Other forced methods (Mean / Median / Trimmed) don't route by classification, so the badge would be misleading.
    const _dc = (p._dc || classifyDemand(p));
    const _saCount = (p.sa || []).length;
    const _dcBadge = (demandMethod === 'auto' && _dc.class)
      ? `<span class="demand-class ${_dc.class}" title="${_dc.reason || _dc.class}${_saCount > 0 ? ` · ${_saCount} sales-spike month${_saCount > 1 ? 's' : ''} detected (purple dots in Monthly P/S)` : ''}">${_dc.class}</span>`
      : '';
    // Product status pill (Adequate/Critical/Low Stock/Healthy/etc.) — same logic as Monthly P/S
    const _ronStatus = STATUS[p.st] || '';
    const _ronStatusPill = _ronStatus
      ? `<span class="pill ${statusClass(_ronStatus)}" style="font-size:8px;padding:1px 5px;" title="Stock status: ${_ronStatus}">${_ronStatus}</span>`
      : '';
    // PNA badge: shown when paper is unavailable, with the expected refill date
    const _pnaDate2 = getPNADate(p);
    const _pnaDisp2 = _pnaDate2 ? formatDate(_pnaDate2) : '';
    const _pnaBadge = isPNA(p)
      ? `<span class="pill pna" style="font-size:8px;padding:1px 5px;" title="Paper Not Available — refill expected ${_pnaDisp2 || 'date TBD'}">PNA${_pnaDisp2 ? ' · ' + _pnaDisp2 : ''}</span>`
      : '';
    // Discontinued badge: rarely visible here (disc items are filtered out by default), but shown if they appear
    const _ronDiscBadge = isDiscontinued(p)
      ? `<span class="pill disc-status" style="font-size:8px;padding:1px 5px;" title="Marked as discontinued">DISC</span>`
      : '';

    // ZONE 1 — IDENTITY (compact)
    row += `<td class="fixed-l l0">
      <div class="ro-identity">
        <div class="name-line">
          <span class="name" title="${p.n}">${p.n}</span>
          <span class="pill abc-${abcLetter}">${abcLetter}</span>
          ${manualOnly
            ? `<span class="in-reorder-marker manual" title="Added manually">M</span>`
            : (p.r > 0 ? `<span class="pill ${priorityClass(priority)}" style="font-size:8px;padding:1px 5px;">${priorityCode}</span>` : '')}
          ${_pnaBadge}
          ${_ronDiscBadge}
          ${_ronStatusPill}
          ${_dcBadge}
          <button class="remove-manual" data-pid="${p.i}" data-mode="${manualOnly ? 'manual' : 'auto'}" type="button" title="Remove from Reorder Now (you can restore with Reset edits)" aria-label="Remove from reorder list">×</button>
          <button class="ai-btn ai-rrow-btn" data-pid="${p.i}" type="button" title="Copy a detailed AI analysis brief for this SKU (paste into Claude to ask why it spiked, whether to order, etc.)">AI</button>
          ${childCount > 0 ? `<button class="child-toggle" data-pid="${p.i}">▸ ${childCount}</button>` : ''}
        </div>
        <div class="meta-line">
          <span class="vendor">${vendor.code}</span>
          ${(D.cats && p.c != null && D.cats[p.c]) ? `<span class="meta-sep">·</span><span class="category" title="Category">${D.cats[p.c]}</span>` : ''}
          ${getProductSubCategory(p) ? `<span class="meta-sep">›</span><span class="sub-category" title="Sub-category">${getProductSubCategory(p)}</span>` : ''}
          ${(() => {
            // Show folder only if it's different from the category — otherwise it's redundant noise
            const _catName = (D.cats && p.c != null) ? (D.cats[p.c] || '') : '';
            if (!folder || folder === _catName) return '';
            return `<span class="meta-sep">·</span><span class="folder" title="Folder">${folder}</span>`;
          })()}
          ${(() => {
            // Parent launch date — the user-authoritative "how old is this product" — replaces the
            // activity-age badge so we don't show two different month figures
            const pd = getParentLaunchDate(p);
            if (!pd) return '';
            const ageM = monthsSinceLaunch(pd);
            const ageLbl = ageM == null ? '' : (ageM === 0 ? 'new' : ageM >= 36 ? '36M+' : ageM + 'M');
            const pdDisplay = formatDate(pd);
            return `<span class="meta-sep">·</span><span class="launch-date" title="Parent code created on ${pdDisplay}${ageM != null ? ` — ${ageM} month${ageM !== 1 ? 's' : ''} ago` : ''}"><strong>${ageLbl}</strong> · ${pdDisplay}</span>`;
          })()}
        </div>
      </div>
    </td>`;

    // ZONE 2 — Days cover (compact)
    row += `<td class="fixed-l l1 num">
      <div class="days-compact">
        <span class="days-num ${daysClass}">${daysDisplay}</span>
        <span class="days-suffix">days</span>
      </div>
    </td>`;

    // ZONE 3 — Pipeline composite + target
    // total = hand + transit + pending (pending now counts toward stock per user request)
    const totalPipe = (p.k || 0) + (p.it || 0) + (p.po || 0);
    // Get the actual monthly demand used (for tooltip transparency)
    const _demand = (typeof monthlyDemand !== 'undefined' ? monthlyDemand : computeDemand(p));
    const _basisLabels = { auto: 'Auto', mean6: 'Mean 6m', median6: 'Median 6m', trimmed6: 'Trimmed 6m', median12: 'Median 12m' };
    const _autoRouteByClass = { smooth: 'Mean 6m', lumpy: 'Median of clean months', intermittent: 'Median 12m', trending: 'Weighted recent', erratic: 'Median 6m', dead: 'No order (dead)' };
    const _demandLabel = demandMethod === 'auto'
      ? `Auto → ${_autoRouteByClass[_dc.class] || 'Mean 6m'} (class: ${_dc.class || 'smooth'})`
      : (_basisLabels[demandMethod] || 'Mean 6m');
    const pHand    = totalPipe > 0 ? (p.k  / totalPipe * 100) : 0;
    const pTransit = totalPipe > 0 ? (p.it / totalPipe * 100) : 0;
    const pPending = totalPipe > 0 ? (p.po / totalPipe * 100) : 0;
    const targetPct = (target > 0 && totalPipe > 0) ? Math.min(100, (target / totalPipe) * 100) : 0;
    const segs = [];
    if (totalPipe === 0) {
      segs.push(`<div class="seg empty">—</div>`);
    } else {
      if (p.k  > 0) segs.push(`<div class="seg h" style="flex:${pHand}"    title="On hand: ${fmt(p.k)}">${pHand    >= 18 ? fmt(p.k)  : ''}</div>`);
      if (p.it > 0) segs.push(`<div class="seg t" style="flex:${pTransit}" title="In transit: ${fmt(p.it)}">${pTransit >= 18 ? fmt(p.it) : ''}</div>`);
      if (p.po > 0) segs.push(`<div class="seg p" style="flex:${pPending}" title="Pending @ factory: ${fmt(p.po)}">${pPending >= 18 ? fmt(p.po) : ''}</div>`);
    }
    const targetMarker = (target > 0 && totalPipe > 0)
      ? `<div class="target-marker" style="left:${targetPct}%" title="Suggested stock for ${days}d: ${fmt(target)}"></div>`
      : '';
    const orderNum = need > 0 ? fmt(need) : '0';
    const orderCls = need > 0 ? 'order-need' : 'order-ok';
    const orderHover = need > 0
      ? `Order ${fmt(need)} = Suggested ${fmt(target)} − Total ${fmt(totalPipe)}`
      : `Covered — Total ${fmt(totalPipe)} ≥ Suggested ${fmt(target)}`;
    // Period averages — buys & sales averaged over the months currently in view (6M / 12M / 24M / custom)
    const _monthsInPeriod = Math.max(1, reverseIdx.length);
    const _avgS = totS / _monthsInPeriod;
    const _avgP = totP / _monthsInPeriod;
    const _periodLbl = (currentPeriod === 'custom') ? `${_monthsInPeriod}m` : `${currentPeriod}m`;
    row += `<td class="fixed-l l2">
      <div class="ro-pipeline-compact">
        <div class="pipe-numbers-line">
          <span class="h-num" title="On hand: ${fmt(p.k)}">${fmt(p.k)}</span><span class="meta-sep">+</span><span class="t-num" title="In transit: ${fmt(p.it)}">${fmt(p.it)}</span><span class="meta-sep">+</span><span class="p-num" title="Pending @ factory: ${fmt(p.po)}">${fmt(p.po)}</span><span class="meta-sep">=</span><span class="total-num" title="Total stock (hand + transit + pending): ${fmt(totalPipe)}">${fmt(totalPipe)}</span>
        </div>
        <div class="pipe-numbers-line second">
          <span class="suggest-num" title="Suggested stock for ${days}d&#10;Method: ${_demandLabel}&#10;Monthly demand: ${(_demand || 0).toFixed(1)}&#10;Math: ${(_demand || 0).toFixed(1) } × ${days}/30 = ${fmt(target)}${_saCount > 0 ? `&#10;${_saCount} sales-spike month${_saCount > 1 ? 's' : ''} excluded from demand calc` : ''}">Suggest ${fmt(target)}</span>
          <span class="order-tag ${orderCls}" title="${orderHover}">Order ${orderNum}</span>
        </div>
        <div class="ro-pipeline-bar small">${segs.join('')}${targetMarker}</div>
      </div>
    </td>`;

    // ZONE 4 — Order Qty (compact, prominent) + period averages stacked underneath
    row += `<td class="fixed-l l3 num">
      <div class="ro-decision-compact">
        <input type="number" class="deci-input compact ${isEdited ? 'edited' : ''}" data-pid="${p.i}" data-original="${defaultQty}" value="${finalQty}" min="0" placeholder="0" title="Type your order qty. System suggests ${fmt(suggestedQty)} for a ${days}-day plan.">
        <div class="deci-hint-compact" title="System suggestion (for reference only — not auto-applied). Click the number to use it.">sugg <span class="suggest-quick" data-pid="${p.i}" data-suggest="${suggestedQty}" style="cursor:pointer; text-decoration:underline dotted; color:var(--text-3);">${fmt(suggestedQty)}</span></div>
        <div class="avg-stack">
          <span class="avg-mini s" title="Avg monthly Sales over the last ${_monthsInPeriod} months (${_periodLbl}): ${fmt(totS)} ÷ ${_monthsInPeriod} = ${_avgS.toFixed(1)}/mo">S ${_avgS.toFixed(1)}</span>
          <span class="avg-mini b" title="Avg monthly Purchases over the last ${_monthsInPeriod} months (${_periodLbl}): ${fmt(totP)} ÷ ${_monthsInPeriod} = ${_avgP.toFixed(1)}/mo">B ${_avgP.toFixed(1)}</span>
        </div>
      </div>
    </td>`;

    // Monthly cells
    for (let i = 0; i < reverseIdx.length; i++) {
      const origIdx = reverseIdx[i];
      const localIdx = origIdx - s;
      const pVal = purchSlice[localIdx];
      const sVal = salesSlice[localIdx];
      const isCurrent = origIdx === currentMonthIdx;
      const isAnomaly      = (currentView !== 'sales')     && p.ba.includes(origIdx);
      const isSalesAnomaly = (currentView !== 'purchases') && (p.sa || []).includes(origIdx);
      const cls = `month-c ${isCurrent ? 'current' : ''} ${isAnomaly ? 'bulk-anom' : ''} ${isSalesAnomaly ? 'sales-anom' : ''}`;
      if (currentView === 'sales') {
        row += sVal === 0
          ? `<td class="${cls} empty"><span class="empty">—</span></td>`
          : `<td class="${cls}">${fmtCompact(sVal)}</td>`;
      } else if (currentView === 'purchases') {
        row += pVal === 0
          ? `<td class="${cls} empty"><span class="empty">—</span></td>`
          : `<td class="${cls}"><span style="color:var(--accent-2)">${fmtCompact(pVal)}</span></td>`;
      } else {
        const cell = `<div class="ps-pair">
          <span class="${pVal === 0 ? 'empty' : 'p'}">${pVal === 0 ? '—' : fmtCompact(pVal)}</span>
          <span class="${sVal === 0 ? 'empty' : 's'}">${sVal === 0 ? '—' : fmtCompact(sVal)}</span>
        </div>`;
        row += `<td class="${cls}">${cell}</td>`;
      }
    }

    if (currentView === 'sales') row += `<td class="num totals" style="color:var(--green)">${fmt(totS)}</td>`;
    else if (currentView === 'purchases') row += `<td class="num totals" style="color:var(--accent-2)">${fmt(totP)}</td>`;
    else row += `<td class="num totals" style="color:var(--accent-2)">${fmt(totP)}</td><td class="num totals" style="color:var(--green)">${fmt(totS)}</td>`;

    row += '</tr>';
    return row;
  }).join('');
  document.getElementById('rmgridBody').innerHTML = rows;

  const totalPages = Math.ceil(sub.length / pageSize);
  document.getElementById('rPagInfo').innerHTML = sub.length === 0
    ? 'No SKUs need reorder under current filters'
    : `Showing <strong>${start+1}—${Math.min(start+pageSize, sub.length)}</strong> of <strong>${fmt(sub.length)}</strong> SKUs needing reorder${totalPages > 1 ? ' · page ' + (reorderPage+1) + '/' + totalPages : ''}`;
  document.getElementById('rPagPrev').disabled = reorderPage === 0;
  document.getElementById('rPagNext').disabled = reorderPage >= totalPages - 1;

  // Wire reorder inputs
  // Workflow: every input STARTS at 0. The user types the actual order qty manually.
  // Empty or 0 means "no order yet" — we clear the reorderEdits entry so it stays at default 0.
  // Any positive number is stored in reorderEdits and counts as an "edited" (user-entered) value.
  document.querySelectorAll('#rmgridBody .deci-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const pid = parseInt(inp.dataset.pid);
      const raw = inp.value;
      const v = (raw === '' || isNaN(parseInt(raw))) ? 0 : parseInt(raw);
      if (v <= 0) {
        delete reorderEdits[pid];
        inp.classList.remove('edited');
      } else {
        reorderEdits[pid] = v;
        inp.classList.add('edited');
      }
      saveEdits();
      document.getElementById('editCount').textContent = getEditCount();
      updateReorderFloatingTotal();
    });
  });
  // Wire the "sugg N" quick-fill link — clicking it loads the system suggestion into the input
  document.querySelectorAll('#rmgridBody .suggest-quick').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pid = parseInt(el.dataset.pid);
      const sv = parseInt(el.dataset.suggest);
      if (!Number.isFinite(sv) || sv <= 0) return;
      const inp = document.querySelector(`#rmgridBody .deci-input[data-pid="${pid}"]`);
      if (!inp) return;
      inp.value = sv;
      reorderEdits[pid] = sv;
      inp.classList.add('edited');
      saveEdits();
      document.getElementById('editCount').textContent = getEditCount();
      updateReorderFloatingTotal();
    });
  });
  document.getElementById('editCount').textContent = getEditCount();

  // Wire child toggles
  document.querySelectorAll('#rmgridBody .child-toggle').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      toggleChildrenInReorder(btn, pid);
    });
  });

  // Wire remove (×) buttons — works on both manual and auto-flagged rows
  document.querySelectorAll('#rmgridBody .remove-manual').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      const mode = btn.dataset.mode;
      if (mode === 'manual') {
        manualReorderIds.delete(pid);
        saveManualReorder();
      } else {
        // Auto-flagged row — exclude it so it stops appearing in Reorder Now.
        // Restore via the "Reset edits" button.
        reorderExcludedIds.add(pid);
        saveReorderExcluded();
      }
      rerender();
    });
  });

  // Wire the AI brief buttons (per-row) — opens chat panel if API key is set, falls back to clipboard
  document.querySelectorAll('#rmgridBody .ai-rrow-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pid = parseInt(btn.dataset.pid);
      const p = D.products.find(x => x.i === pid);
      if (!p) return;
      aiInvoke(p, btn);
    });
  });
}

function toggleChildrenInReorder(btn, pid) {
  const parentRow = btn.closest('tr');
  if (btn.classList.contains('open')) {
    let next = parentRow.nextElementSibling;
    while (next && next.classList.contains('child-row')) {
      const toRm = next; next = next.nextElementSibling;
      toRm.remove();
    }
    btn.classList.remove('open');
    btn.innerHTML = btn.innerHTML.replace('▾', '▸');
    return;
  }
  const p = D.products.find(x => x.i === pid);
  if (!p) return;
  const children = getProductChildren(p);
  const colspan = parentRow.children.length;
  const fragments = children.map(ch => {
    const childFolder = ch.folder || '—';
    const variantTag = ch.variant || '';
    const isExternalFolder = childFolder !== D.folders[p.fl];
    return `<tr class="child-row" data-parent="${pid}">
      <td class="fixed-l l0" style="padding-left:36px">↳ <strong style="color:var(--accent); font-family:var(--mono); font-size:12px">${ch.code}</strong> <span class="child-folder-inline">${ch.folder || childFolder || ''}</span>${zoneBadgeHtml(ch.folder || childFolder)}</td>
      <td class="fixed-l l1">
        <div class="vc-stack">
          ${launchDateBadgeHtml(ch.launchDate) || '<span class="child-variant">—</span>'}
          ${(() => {
            const _c = (D.cats && p && p.c != null) ? (D.cats[p.c] || '') : '';
            const _s = p ? getProductSubCategory(p) : '';
            const line = [_c, _s].filter(Boolean).join(' · ');
            return line ? `<span class="vc-cat" title="Category · Sub-category">${line}</span>` : '';
          })()}
        </div>
      </td>
      <td class="fixed-l l2"><span class="child-variant">child SKU</span></td>
      <td class="fixed-l l3"><span class="child-variant">—</span></td>
      <td colspan="${colspan - 4}" class="child-variant" style="text-align:left; padding-left:24px;">child of ${p.n}</td>
    </tr>`;
  }).join('');
  parentRow.insertAdjacentHTML('afterend', fragments);
  btn.classList.add('open');
  btn.innerHTML = btn.innerHTML.replace('▸', '▾');
}

document.getElementById('rPagPrev').addEventListener('click', () => { if (reorderPage > 0) { reorderPage--; renderReorderMonthly(getFilteredProducts()); } });
document.getElementById('rPagNext').addEventListener('click', () => { reorderPage++; renderReorderMonthly(getFilteredProducts()); });

document.getElementById('aiPortfolioBtn').addEventListener('click', () => {
  // Opens chat panel with portfolio brief if API key set; falls back to clipboard copy otherwise.
  if (aiHasKey()) {
    aiOpenPortfolioChat();
    return;
  }
  // Fallback: build the brief and copy it
  const filtered = getFilteredProducts();
  let sub;
  if (reorderScope === 'needed') {
    sub = filtered.filter(p => {
      if (isExcluded(p)) return false;
      if (isManualOnly(p)) return true;
      const days = _aiPickPlanningDays(p);
      const total = (p.k || 0) + (p.it || 0) + (p.po || 0);
      const need = Math.max(0, Math.round((computeDemand(p) || 0) * days / 30) - total);
      return need > 0;
    });
  } else if (reorderScope === 'auto')   sub = filtered.filter(p => p.r > 0 && !isExcluded(p));
  else if (reorderScope === 'manual')   sub = filtered.filter(p => isManualOnly(p));
  else                                  sub = filtered.filter(p => isInReorder(p));
  const scopeLabel = ({ needed: 'Need order now', auto: 'Auto-flagged', manual: 'Manual added', all: 'All in reorder list' })[reorderScope] || reorderScope;
  _aiCopyToClipboard(buildPortfolioBrief(sub, scopeLabel), document.getElementById('aiPortfolioBtn'));
});

document.getElementById('resetEdits').addEventListener('click', () => {
  const hasEdits = Object.keys(reorderEdits).length > 0;
  const hasExcluded = reorderExcludedIds.size > 0;
  if (!hasEdits && !hasExcluded) return;
  const msg = hasExcluded && hasEdits
    ? 'Reset all manual reorder edits AND restore dismissed (×) auto rows?'
    : (hasExcluded ? 'Restore dismissed (×) auto rows?' : 'Reset all manual reorder edits?');
  if (!confirm(msg)) return;
  for (const k of Object.keys(reorderEdits)) delete reorderEdits[k];
  reorderExcludedIds.clear();
  saveEdits();
  saveReorderExcluded();
  rerender();
});

// ===== Bulk anomaly tab =====
function renderBulk(products) {
  const sub = products.filter(p => p.ba && p.ba.length > 0).sort((a,b) => {
    const totA = (a.p.length ? a.p : []).reduce((x,y)=>x+y,0);
    const totB = (b.p.length ? b.p : []).reduce((x,y)=>x+y,0);
    return totB - totA;
  });
  document.getElementById('bulkCount').textContent = sub.length;
  document.getElementById('bulkBody').innerHTML = sub.slice(0, 200).map(p => {
    const vendor = D.vendors[p.v];
    const folder = D.folders[p.fl];
    const totP = (p.p.length ? p.p : []).reduce((a,b)=>a+b,0);
    const totS = (p.s.length ? p.s : []).reduce((a,b)=>a+b,0);
    const months = p.ba.map(idx => {
      const qty = (p.p && p.p[idx] != null) ? p.p[idx] : 0;
      return `${D.months[idx]} <span style="color:var(--text-3); font-weight:400;">(${fmt(qty)})</span>`;
    }).join(', ');
    const pattern = p.ba.length >= 3 ? 'Highly bulk-irregular' : p.ba.length === 2 ? 'Two bulk events' : 'Single bulk spike';
    return `<tr>
      <td title="${vendor.name}"><strong>${vendor.code}</strong></td>
      <td class="product" title="${p.n}">${p.n}</td>
      <td class="cat" title="${folder}">${folder}</td>
      <td><span class="pill abc-${ABCS[p.b]}">${ABCS[p.b]}</span></td>
      <td class="num">${fmt(p.k)}</td>
      <td class="num" style="color:var(--red); font-family:var(--mono); font-size:11px;">${months}</td>
      <td class="num" style="color:var(--accent-2)">${fmt(totP)}</td>
      <td class="num" style="color:var(--green)">${fmt(totS)}</td>
      <td><span class="pill ${p.ba.length >= 3 ? 'critical' : 'low'}">${pattern}</span></td>
    </tr>`;
  }).join('');
}

function renderSlow(products) {
  const sub = products.filter(p => ['Sluggish (3-6m)', 'Slow (6-12m)', 'Non-Moving (12m+)'].includes(MOVERS[p.mv]))
    .sort((a, b) => {
      const order = { 'Non-Moving (12m+)': 0, 'Slow (6-12m)': 1, 'Sluggish (3-6m)': 2 };
      const oa = order[MOVERS[a.mv]] || 9, ob = order[MOVERS[b.mv]] || 9;
      if (oa !== ob) return oa - ob;
      return b.k - a.k;
    });
  document.getElementById('slowCount').textContent = sub.length;
  document.getElementById('slowBody').innerHTML = sub.slice(0, 200).map(p => {
    const vendor = D.vendors[p.v];
    const folder = D.folders[p.fl];
    const mover = MOVERS[p.mv];
    return `<tr>
      <td><span class="pill ${moverClass(mover)}">${mover}</span></td>
      <td title="${vendor.name}"><strong>${vendor.code}</strong></td>
      <td class="product" title="${p.n}">${p.n}</td>
      <td class="cat" title="${folder}">${folder}</td>
      <td><span class="pill abc-${ABCS[p.b]}">${ABCS[p.b]}</span></td>
      <td class="num" style="color:var(--red)">${fmt(p.k)}</td>
      <td class="num">${fmtMonthsSinceSale(p.ms)}</td>
      <td class="num">${fmt(p.a)}</td>
      <td class="num">${p.t === 99 ? '∞' : p.t.toFixed(2)}</td>
      <td><span class="pill dead">${p.ms >= 12 ? 'Liquidate' : 'Discount / Push'}</span></td>
    </tr>`;
  }).join('');
}

function renderOver(products) {
  const sub = products.filter(p => STATUS[p.st] === 'Overstocked').sort((a, b) => b.k - a.k);
  document.getElementById('overCount').textContent = sub.length;
  document.getElementById('overBody').innerHTML = sub.slice(0, 200).map(p => {
    const vendor = D.vendors[p.v];
    const folder = D.folders[p.fl];
    return `<tr>
      <td title="${vendor.name}"><strong>${vendor.code}</strong></td>
      <td class="product" title="${p.n}">${p.n}</td>
      <td class="cat" title="${folder}">${folder}</td>
      <td><span class="pill abc-${ABCS[p.b]}">${ABCS[p.b]}</span></td>
      <td class="num" style="color:var(--purple)">${fmt(p.k)}</td>
      <td class="num">${fmt(p.m)}</td>
      <td class="num">${fmtDays(p.d)}</td>
      <td class="num">${fmt(p.a)}</td>
      <td class="num">${p.t === 99 ? '∞' : p.t.toFixed(2)}</td>
    </tr>`;
  }).join('');
}

// ===== Vendor table =====
function renderVendors() {
  const stats = D.vendors.map(v => {
    const sub = D.products.filter(p => D.vendors[p.v].code === v.code);
    return {
      ...v,
      annualSales: sub.reduce((a, p) => a + p.a, 0),
      stock: sub.reduce((a, p) => a + p.k, 0),
      reorderQty: sub.reduce((a, p) => a + p.r, 0),
      reorderSkus: sub.filter(p => p.r > 0).length,
      slowSkus: sub.filter(p => ['Slow (6-12m)', 'Non-Moving (12m+)'].includes(MOVERS[p.mv])).length,
    };
  }).sort((a, b) => b.annualSales - a.annualSales);

  document.getElementById('vendorBody').innerHTML = stats.map(v => `
    <tr style="cursor:pointer" onclick="filterByVendor('${v.code}')">
      <td><strong>${v.code}</strong></td>
      <td class="product" title="${v.name}">${v.name}</td>
      <td class="cat">${v.city}</td>
      <td class="num">${fmt(v.skus)}</td>
      <td class="num" style="color:var(--green)">${fmt(v.annualSales)}</td>
      <td class="num">${fmt(v.stock)}</td>
      <td class="num" style="color:${v.reorderQty > 0 ? 'var(--orange)' : 'var(--text-3)'}">${fmt(v.reorderQty)}</td>
      <td class="num" style="color:${v.reorderSkus > 0 ? 'var(--orange)' : 'var(--text-3)'}">${fmt(v.reorderSkus)}</td>
      <td class="num" style="color:${v.slowSkus > 0 ? 'var(--red)' : 'var(--text-3)'}">${fmt(v.slowSkus)}</td>
    </tr>
  `).join('');
}

// ===== Folder browser =====
const folderSelect = document.getElementById('folderSelect');
D.folderSummary.forEach(f => {
  const opt = document.createElement('option');
  opt.value = f.Folder;
  opt.textContent = `${f.Folder} (${f.parents} parents · ${fmt(f.sales)} units sold)`;
  folderSelect.appendChild(opt);
});

function renderFolderView() {
  const folder = folderSelect.value;
  const filterText = document.getElementById('folderProductFilter').value.toLowerCase().trim();
  const dlBtn = document.getElementById('dlFolder');
  if (!folder) {
    document.getElementById('folderSummary').style.display = 'none';
    document.getElementById('folderTableWrap').style.display = 'none';
    document.getElementById('folderEmpty').style.display = 'block';
    dlBtn.disabled = true;
    dlBtn.style.opacity = '0.4';
    return;
  }
  const folderIdx = D.folders.indexOf(folder);
  let parents = D.products.filter(p => p.fl === folderIdx);
  if (filterText) parents = parents.filter(p => p.n.toLowerCase().includes(filterText));

  const totalChildren = parents.reduce((s, p) => s + p.ch.length, 0);
  const totalStock = parents.reduce((s, p) => s + p.k, 0);
  const totalSales = parents.reduce((s, p) => s + p.a, 0);

  // Folder age = max product age in folder; new-product count from summary
  const folderInfo = D.folderSummary.find(f => f.Folder === folder) || {};
  const folderAge = folderInfo.folder_age || 0;
  const folderAvgAge = folderInfo.folder_avg_age || 0;
  const newCount = folderInfo.new_count || 0;
  const youngCount = folderInfo.young_count || 0;
  const ageBadge = ageBandLabel(folderAge);
  const ageDisplay = folderAge >= 24 ? '24m+' : folderAge + 'm';

  document.getElementById('folderSummary').innerHTML = `
    <div class="folder-card"><div class="folder-card-label">Parents · Children</div><div class="folder-card-value">${fmt(parents.length)} · ${fmt(totalChildren)}</div></div>
    <div class="folder-card"><div class="folder-card-label">Stock on hand</div><div class="folder-card-value">${fmt(totalStock)}</div></div>
    <div class="folder-card"><div class="folder-card-label">Annual sales</div><div class="folder-card-value">${fmt(totalSales)}</div></div>
    <div class="folder-card">
      <div class="folder-card-label">Folder age · Avg</div>
      <div class="folder-card-value">${ageDisplay} · ${folderAvgAge}m</div>
      ${newCount > 0 || youngCount > 0 ? `<div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">${newCount > 0 ? `<span class="age-badge new">${newCount} new</span>` : ''}${youngCount > 0 ? `<span class="age-badge young">${youngCount} young</span>` : ''}</div>` : ''}
    </div>
  `;
  document.getElementById('folderSummary').style.display = '';

  const rows = parents.sort((a,b) => b.a - a.a).map(p => {
    const vendor = D.vendors[p.v];
    const status = STATUS[p.st];
    const childList = getProductChildren(p);
    const childPills = childList.slice(0, 4).map(ch => {
      const otherFolder = ch.folder !== folder;
      return `<span style="display:inline-block; padding:2px 6px; margin:1px; font-family:var(--mono); font-size:10px; border:1px solid ${otherFolder ? 'var(--purple)' : 'var(--line-2)'}; color:${otherFolder ? 'var(--purple)' : 'var(--text-2)'}; border-radius:2px;">${ch.code}${otherFolder ? ' →' + ch.folder.substring(0,12) : ''}</span>`;
    }).join('');
    const more = childList.length > 4 ? `<span style="color:var(--text-3); font-family:var(--mono); font-size:10px; margin-left:4px">+${childList.length - 4}</span>` : '';
    return `<tr>
      <td><span class="pill abc-${ABCS[p.b]}">${ABCS[p.b]}</span></td>
      <td class="product" title="${p.n}"><strong>${p.n}</strong><br>${childPills}${more}</td>
      <td title="${vendor.name}"><strong>${vendor.code}</strong></td>
      <td><span class="pill abc-${ABCS[p.b]}">${ABCS[p.b]}</span></td>
      <td class="num"><span class="age-badge ${ageBandLabel(p.pa).cls}">${ageBandLabel(p.pa).lbl}</span></td>
      <td class="num"><span class="stock-cell ${stockClass(p)}">${fmt(p.k)}</span></td>
      <td class="num" style="color:var(--green)">${fmt(p.a)}</td>
      <td class="num">${p.ch.length}</td>
      <td><span class="pill ${statusClass(status)}">${status}</span></td>
    </tr>`;
  }).join('');
  document.getElementById('folderBody').innerHTML = rows;
  document.getElementById('folderTableWrap').style.display = '';
  document.getElementById('folderEmpty').style.display = 'none';
  dlBtn.disabled = false;
  dlBtn.style.opacity = '1';
}

folderSelect.addEventListener('change', renderFolderView);
document.getElementById('folderProductFilter').addEventListener('input', renderFolderView);

// ===== Tabs =====
document.querySelectorAll('.tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    document.getElementById('tab-' + currentTab).classList.add('active');
    document.getElementById('monthlyControls').style.display = (currentTab === 'monthly' || currentTab === 'reorder') ? '' : 'none';
    // Show floating Reorder-total panel only when Reorder Now tab is active
    updateReorderFloatingTotal();
    // First entry to Reorder Now: snap period to 6M for compact view
    if (currentTab === 'reorder' && currentPeriod === 24) {
      currentPeriod = 6;
      document.querySelectorAll('#periodGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.period === '6'));
      reorderPage = 0;
      rerender();
    }
  });
});

// ===== Floating panel drag-and-persist =====
// User can drag the floating Reorder-total panel anywhere; position saves to localStorage
// and re-applies on next load. Default position (CSS) is right:16px, top:50%.
const RFT_POS_KEY = 'inventoryRftPos';
function _rftApplySavedPos() {
  const panel = document.getElementById('reorderFloatingTotal');
  if (!panel) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RFT_POS_KEY) || 'null'); } catch (e) {}
  if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
  // Clamp to current viewport
  const maxL = Math.max(0, window.innerWidth  - panel.offsetWidth  - 4);
  const maxT = Math.max(0, window.innerHeight - panel.offsetHeight - 4);
  panel.style.left  = Math.min(Math.max(0, saved.left), maxL) + 'px';
  panel.style.top   = Math.min(Math.max(0, saved.top),  maxT) + 'px';
  panel.style.right = 'auto';
}
(function setupReorderFloatingDrag() {
  const panel = document.getElementById('reorderFloatingTotal');
  if (!panel) return;
  const handle = panel.querySelector('.rft-drag');
  if (!handle) return;

  let dragging = false, startX = 0, startY = 0, origL = 0, origT = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;  // left click only
    dragging = true;
    panel.classList.add('dragging');
    const rect = panel.getBoundingClientRect();
    origL = rect.left;
    origT = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    panel.style.left  = origL + 'px';
    panel.style.top   = origT + 'px';
    panel.style.right = 'auto';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxL = Math.max(0, window.innerWidth  - panel.offsetWidth  - 4);
    const maxT = Math.max(0, window.innerHeight - panel.offsetHeight - 4);
    panel.style.left = Math.min(Math.max(0, origL + dx), maxL) + 'px';
    panel.style.top  = Math.min(Math.max(0, origT + dy), maxT) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(RFT_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (e) {}
  });

  // Double-click the drag bar to reset to default (right-middle)
  handle.addEventListener('dblclick', () => {
    panel.style.left  = '';
    panel.style.top   = '50%';
    panel.style.right = '16px';
    try { localStorage.removeItem(RFT_POS_KEY); } catch (e) {}
  });

  // Clamp position back into the viewport after window resize
  window.addEventListener('resize', _rftApplySavedPos);
})();

// Floating Reorder-Now total — recomputes Σ entered qty + vendor count across the FILTERED set
// (not just the current page), so the buyer sees the true plan total even while paginating.
// Track whether section 4 (the tabs panel) is currently visible in the viewport.
// The floating total only shows when (currentTab === 'reorder') AND section 4 is on screen.
let _section4InView = false;
(function watchSection4Visibility() {
  const target = document.getElementById('section4Panel');
  if (!target || typeof IntersectionObserver === 'undefined') {
    // Fallback for very old browsers: always treat as in view
    _section4InView = true;
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      _section4InView = entry.isIntersecting;
    }
    if (typeof updateReorderFloatingTotal === 'function') updateReorderFloatingTotal();
  }, { threshold: 0.01 });   // any tiny sliver counts as visible
  io.observe(target);
})();

function updateReorderFloatingTotal() {
  const el = document.getElementById('reorderFloatingTotal');
  if (!el) return;
  // Show only when the Reorder tab is selected AND section 4 is currently in the viewport.
  // Scrolling away (to KPIs above, charts below, etc.) hides the panel automatically.
  if (currentTab !== 'reorder' || !_section4InView) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  // First time the panel becomes visible, restore the user's saved position (offsetWidth
  // isn't measurable while display:none, so this has to happen post-show).
  if (!el.dataset.posApplied) {
    _rftApplySavedPos();
    el.dataset.posApplied = '1';
  }
  // Only count quantities the user actually entered (reorderEdits map). Default 0 doesn't count.
  // Restrict to currently-filtered products so the total reflects what's in view.
  const filteredIds = new Set(getFilteredProducts().map(p => p.i));
  let totalQty = 0;
  let rowCount = 0;
  const vendorSet = new Set();
  Object.keys(reorderEdits).forEach(pidKey => {
    const pid = parseInt(pidKey);
    if (!filteredIds.has(pid)) return;
    const qty = reorderEdits[pid];
    if (!Number.isFinite(qty) || qty <= 0) return;
    totalQty += qty;
    rowCount++;
    const p = D.products.find(pp => pp.i === pid);
    if (p && p.v != null) vendorSet.add(p.v);
  });
  document.getElementById('rftQty').textContent = fmt(totalQty);
  document.getElementById('rftRows').textContent = fmt(rowCount);
  document.getElementById('rftVendors').textContent = fmt(vendorSet.size);
}

function rerender() {
  const filtered = getFilteredProducts();
  document.getElementById('monthlyCount').textContent = filtered.length;
  renderMonthlyGrid(filtered);
  renderReorderMonthly(filtered);
  renderBulk(filtered);
  renderSlow(filtered);
  renderOver(filtered);
  renderManualChips();
  updateReorderFloatingTotal();  // refresh floating total any time the grid re-renders
}

// ===== Manual reorder add UI =====
function renderManualChips() {
  const chips = [...manualReorderIds].map(id => {
    const p = D.products.find(x => x.i === id);
    if (!p) return '';
    return `<span class="manual-chip"><span class="lbl" title="${p.n}">${p.n}</span><button data-mid="${id}" type="button" title="Remove from manual reorder list">×</button></span>`;
  }).join('');
  const target = document.getElementById('manualChips');
  if (target) target.innerHTML = chips;
  document.querySelectorAll('#manualChips .manual-chip button').forEach(b => {
    b.addEventListener('click', () => {
      manualReorderIds.delete(parseInt(b.dataset.mid));
      saveManualReorder();
      reorderPage = 0;
      rerender();
    });
  });
}

function manualAddByName(name) {
  const status = document.getElementById('manualAddStatus');
  const trim = (name || '').trim();
  if (!trim) {
    status.className = 'manual-status err';
    status.textContent = 'Please type a product name first.';
    return;
  }
  // Try exact match first, then case-insensitive contains
  let p = D.products.find(x => x.n === trim);
  if (!p) {
    const lower = trim.toLowerCase();
    const matches = D.products.filter(x => x.n.toLowerCase().includes(lower));
    if (matches.length === 1) {
      p = matches[0];
    } else if (matches.length > 1) {
      status.className = 'manual-status err';
      status.textContent = `${matches.length} products match "${trim}". Refine to be more specific.`;
      return;
    }
  }
  if (!p) {
    status.className = 'manual-status err';
    status.textContent = `No product found matching "${trim}".`;
    return;
  }
  if (p.r > 0) {
    status.className = 'manual-status err';
    status.textContent = `"${p.n}" is already on the auto-reorder list.`;
    return;
  }
  if (manualReorderIds.has(p.i)) {
    status.className = 'manual-status err';
    status.textContent = `"${p.n}" is already in your manual list.`;
    return;
  }
  manualReorderIds.add(p.i);
  // Default the override to a reasonable starting qty: predicted next month, or 1
  if (reorderEdits[p.i] == null) {
    reorderEdits[p.i] = Math.max(1, p.f || 1);
    saveEdits();
  }
  saveManualReorder();
  document.getElementById('manualAddSearch').value = '';
  status.className = 'manual-status ok';
  status.textContent = `Added "${p.n}" to manual reorder list (default qty ${fmt(reorderEdits[p.i])}).`;
  reorderPage = 0;
  rerender();
}

document.getElementById('manualAddBtn').addEventListener('click', () => {
  manualAddByName(document.getElementById('manualAddSearch').value);
});
document.getElementById('manualAddSearch').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') manualAddByName(ev.target.value);
});

// Search input always re-renders; the multi-select chips/toggles already wire their own re-renders.
document.getElementById('searchInput').addEventListener('input', () => {
  currentPage = 0; reorderPage = 0; rerender();
});

// ===== CSV downloads =====
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Download an array-of-rows as a real .xlsx workbook (falls back to CSV if SheetJS
// isn't loaded). Used by the "↓ Template" buttons so you get an Excel file you can
// open, fill in, and upload straight back into the matching section.
function downloadXlsx(filename, sheetName, rows) {
  const useXlsx = (typeof XLSX !== 'undefined' && XLSX && XLSX.utils && XLSX.writeFile);
  if (!useXlsx) {
    downloadCsv(filename.replace(/\.xlsx$/i, '.csv'), rows);
    return;
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Auto-size each column to its widest cell so headers stay readable in Excel.
  const widths = [];
  rows.forEach(r => r.forEach((cell, i) => {
    const len = String(cell == null ? '' : cell).length;
    if (!widths[i] || widths[i] < len) widths[i] = len;
  }));
  ws['!cols'] = widths.map(w => ({ wch: Math.min(Math.max((w || 0) + 2, 10), 40) }));
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Sheet1').slice(0, 31));
  XLSX.writeFile(wb, filename);
}

document.getElementById('dlReorder').addEventListener('click', () => {
  const filtered = getFilteredProducts().filter(p => p.r > 0).sort((a, b) => {
    if (PRIORITIES[a.pr] !== PRIORITIES[b.pr]) return PRIORITIES[a.pr].localeCompare(PRIORITIES[b.pr]);
    return getReorderQty(b) - getReorderQty(a);
  });
  const headers = ['Priority', 'Vendor Code', 'Vendor Name', 'Vendor City', 'Folder', 'Parent ID', 'Parent Code', 'Category', 'ABC',
                   'On Hand', 'In Transit', 'Pending @ Factory', 'Total Available',
                   'Avg Monthly Sales', 'Predicted Next Month', 'Days of Stock', 'Adj Days (Pipeline)',
                   'Suggested Reorder', 'Net Reorder Need', 'FINAL Reorder Qty (with edits)', 'Was Edited?',
                   'Stockout Risk', 'Status', 'Pipeline Status', 'Child Codes'];
  // Sheet 1: full detailed export (unchanged)
  const sheet1Rows = [headers].concat(filtered.map(p => {
    const v = D.vendors[p.v];
    const folder = D.folders[p.fl];
    const finalQty = getReorderQty(p);
    const edited = reorderEdits[p.i] != null && reorderEdits[p.i] !== p.nr;
    const childCodes = getProductChildren(p).map(c => c.code).join(' | ');
    return [PRIORITIES[p.pr], v.code, v.name, v.city, folder, p.i, p.n, D.cats[p.c] || '', ABCS[p.b],
            p.k, p.it, p.po, p.av,
            p.m, p.f, p.d >= 999 ? 'No sales' : p.d, p.ad >= 999 ? 'No sales' : p.ad,
            p.r, p.nr, finalQty, edited ? 'YES' : '',
            p.x, STATUS[p.st], STATUS[p.ps], childCodes];
  }));

  // ===== Vendor Summary — split by vendor into separate sheets =====
  // Each vendor gets its own sheet so the buyer can hand a clean order to that vendor
  // without exposing other vendors' SKUs. Also includes an "All Vendors" index sheet
  // up front so it's clear at a glance which vendors have outstanding orders.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const dateStamp = `${pad2(now.getDate())}-${pad2(now.getMonth()+1)}-${String(now.getFullYear()).slice(-2)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  // Group rows by vendor
  const byVendor = {};  // vendor key → { vendor: {...}, rows: [[code, qty], ...] }
  filtered.forEach(p => {
    const v = D.vendors[p.v];
    const qty = getReorderQty(p);
    if (!v || !qty) return;
    const key = v.code || v.name;
    if (!byVendor[key]) byVendor[key] = { vendor: v, rows: [] };
    byVendor[key].rows.push([p.n, qty]);
  });

  // Sanitise vendor name → Excel-safe sheet title (≤31 chars, no \ / ? * [ ])
  const sanitizeSheetName = (name) => {
    let s = String(name || 'Vendor').replace(/[\\\/\?\*\[\]:]/g, '-').trim();
    if (s.length > 28) s = s.slice(0, 28).trim();
    return s || 'Vendor';
  };
  const usedNames = new Set();
  const uniqueSheetName = (base) => {
    let nm = base, i = 2;
    while (usedNames.has(nm)) { nm = `${base.slice(0, 26)} (${i})`; i++; }
    usedNames.add(nm);
    return nm;
  };

  const vendorEntries = Object.values(byVendor).sort((a, b) =>
    (a.vendor.name || a.vendor.code || '').localeCompare(b.vendor.name || b.vendor.code || ''));

  // "All Vendors" index sheet (one row per vendor → total qty + line count)
  const indexRows = [
    ['Generated:', dateStamp],
    ['Total vendors:', vendorEntries.length],
    [],
    ['Vendor Code', 'Vendor Name', 'Line Items', 'Total Qty']
  ];
  vendorEntries.forEach(v => {
    const totalQty = v.rows.reduce((s, r) => s + (r[1] || 0), 0);
    indexRows.push([v.vendor.code || '', v.vendor.name || '', v.rows.length, totalQty]);
  });

  const stamp = new Date().toISOString().slice(0,10);
  const useXlsx = (typeof XLSX !== 'undefined' && XLSX && XLSX.utils && XLSX.writeFile);
  if (useXlsx) {
    const wb = XLSX.utils.book_new();

    // Sheet 1: full detail (unchanged)
    const ws1 = XLSX.utils.aoa_to_sheet(sheet1Rows);
    XLSX.utils.book_append_sheet(wb, ws1, 'Reorder Plan');

    // Sheet 2: All-vendors index
    const wsIdx = XLSX.utils.aoa_to_sheet(indexRows);
    wsIdx['!cols'] = [{ wch: 14 }, { wch: 30 }, { wch: 12 }, { wch: 12 }];
    usedNames.add('Reorder Plan');
    usedNames.add('All Vendors');
    XLSX.utils.book_append_sheet(wb, wsIdx, 'All Vendors');

    // One sheet per vendor
    vendorEntries.forEach(v => {
      const totalQty = v.rows.reduce((s, r) => s + (r[1] || 0), 0);
      const aoa = [
        [`Vendor: ${v.vendor.name || v.vendor.code}`, ''],
        ['Vendor Code:', v.vendor.code || ''],
        ['Generated:', dateStamp],
        ['Total qty:', totalQty],
        ['Line items:', v.rows.length],
        [],
        ['Parent Code', 'Quantity']
      ];
      v.rows.forEach(r => aoa.push(r));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 30 }, { wch: 12 }];
      const baseName = sanitizeSheetName(v.vendor.name || v.vendor.code);
      XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(baseName));
    });

    XLSX.writeFile(wb, `Reorder_Plan_${stamp}.xlsx`);
  } else {
    // Fallback if SheetJS is unavailable: one CSV for plan + one CSV per vendor
    downloadCsv(`Reorder_Plan_${stamp}.csv`, sheet1Rows);
    downloadCsv(`Reorder_All_Vendors_${stamp}.csv`, indexRows);
    vendorEntries.forEach(v => {
      const safe = (v.vendor.name || v.vendor.code || 'Vendor').replace(/[^\w]+/g, '_');
      const rows = [['Parent Code', 'Quantity']].concat(v.rows);
      downloadCsv(`Reorder_${safe}_${stamp}.csv`, rows);
    });
  }
});

document.getElementById('dlSlow').addEventListener('click', () => {
  const filtered = getFilteredProducts().filter(p => ['Sluggish (3-6m)', 'Slow (6-12m)', 'Non-Moving (12m+)'].includes(MOVERS[p.mv]))
    .sort((a, b) => {
      const order = { 'Non-Moving (12m+)': 0, 'Slow (6-12m)': 1, 'Sluggish (3-6m)': 2 };
      return (order[MOVERS[a.mv]] || 9) - (order[MOVERS[b.mv]] || 9);
    });
  const headers = ['Mover Status', 'Vendor Code', 'Vendor Name', 'Folder', 'Parent ID', 'Parent Code', 'Category', 'ABC',
                   'Stock Trapped', 'Months Since Last Sale', 'Annual Sales', 'Inventory Turnover', 'Suggested Action', 'Child Codes'];
  const rows = [headers].concat(filtered.map(p => {
    const v = D.vendors[p.v];
    const action = p.ms >= 12 ? 'Liquidate / Write off' : p.ms >= 6 ? 'Heavy discount + push' : 'Promote / Bundle';
    const childCodes = getProductChildren(p).map(c => c.code).join(' | ');
    return [MOVERS[p.mv], v.code, v.name, D.folders[p.fl], p.i, p.n, D.cats[p.c] || '', ABCS[p.b],
            p.k, p.ms >= 13 ? '13+' : p.ms, p.a, p.t === 99 ? '∞' : p.t.toFixed(2), action, childCodes];
  }));
  downloadCsv(`Slow_NonMoving_${new Date().toISOString().slice(0,10)}.csv`, rows);
});

document.getElementById('dlOver').addEventListener('click', () => {
  const filtered = getFilteredProducts().filter(p => STATUS[p.st] === 'Overstocked').sort((a, b) => b.k - a.k);
  const headers = ['Vendor Code', 'Vendor Name', 'Folder', 'Parent ID', 'Parent Code', 'Category', 'ABC',
                   'Stock', 'Avg Monthly Sales', 'Days of Stock', 'Annual Sales', 'Turnover', 'Action', 'Child Codes'];
  const rows = [headers].concat(filtered.map(p => {
    const v = D.vendors[p.v];
    const childCodes = getProductChildren(p).map(c => c.code).join(' | ');
    return [v.code, v.name, D.folders[p.fl], p.i, p.n, D.cats[p.c] || '', ABCS[p.b],
            p.k, p.m, p.d >= 999 ? '∞' : p.d, p.a, p.t === 99 ? '∞' : p.t.toFixed(2), 'Pause reorders / Reduce', childCodes];
  }));
  downloadCsv(`Overstocked_${new Date().toISOString().slice(0,10)}.csv`, rows);
});

document.getElementById('dlMonthly').addEventListener('click', () => {
  const filtered = getFilteredProducts();
  const [s, e] = getRange();
  const labels = D.months.slice(s, e);
  const headers = ['Vendor Code', 'Folder', 'Parent ID', 'Parent Code', 'Category', 'ABC', 'Stock', 'Type'].concat(labels).concat(['Total']);
  const rows = [headers];
  filtered.forEach(p => {
    const v = D.vendors[p.v];
    const purch = (p.p.length ? p.p : new Array(24).fill(0)).slice(s, e);
    const sales = (p.s.length ? p.s : new Array(24).fill(0)).slice(s, e);
    const meta = [v.code, D.folders[p.fl], p.i, p.n, D.cats[p.c] || '', ABCS[p.b], p.k];
    if (currentView === 'sales' || currentView === 'both') {
      rows.push(meta.concat(['Sales']).concat(sales).concat([sales.reduce((a,b)=>a+b,0)]));
    }
    if (currentView === 'purchases' || currentView === 'both') {
      rows.push(meta.concat(['Purchases']).concat(purch).concat([purch.reduce((a,b)=>a+b,0)]));
    }
  });
  downloadCsv(`Monthly_${currentView}_${new Date().toISOString().slice(0,10)}.csv`, rows);
});

document.getElementById('dlMaster').addEventListener('click', () => {
  const headers = ['parent_id', 'parent_code', 'parent_launch_date', 'vendor_name', 'vendor_code', 'category', 'sub_category', 'parent_folder', 'child_code', 'child_launch_date', 'child_folder', 'abc', 'zone'];
  const rows = [headers];
  const zoneStrFor = (folderName) => {
    const z = getFolderZones(folderName);
    if (z.openToAll) return 'all';
    if (z.unclassified) return '';
    return z.zones.join(',');
  };
  D.products.forEach(p => {
    const v = D.vendors[p.v] || { name: '', code: '' };
    const parentFolder = D.folders[p.fl];
    const pld = getParentLaunchDate(p);
    const cat = (D.cats && p.c != null) ? (D.cats[p.c] || '') : '';
    const sub = getProductSubCategory(p);
    const children = getProductChildren(p);
    children.forEach(ch => {
      rows.push([p.i, p.n, pld, v.name, v.code, cat, sub, parentFolder, ch.code, ch.launchDate || '', ch.folder, ABCS[p.b], zoneStrFor(ch.folder)]);
    });
  });
  downloadCsv(`Master_ParentChild_${new Date().toISOString().slice(0,10)}.csv`, rows);
});

document.getElementById('dlFolder').addEventListener('click', () => {
  const folder = folderSelect.value;
  if (!folder) return;
  const folderIdx = D.folders.indexOf(folder);
  const parents = D.products.filter(p => p.fl === folderIdx);
  const headers = ['Folder', 'Parent ID', 'Parent Code', 'Vendor', 'ABC', 'Stock', 'Annual Sales', 'Status', 'Child Code', 'Child Folder'];
  const rows = [headers];
  parents.forEach(p => {
    const v = D.vendors[p.v];
    const children = getProductChildren(p);
    children.forEach(ch => {
      rows.push([folder, p.i, p.n, v.code, ABCS[p.b], p.k, p.a, STATUS[p.st], ch.code, ch.folder]);
    });
  });
  downloadCsv(`Folder_${folder.replace(/[^A-Za-z0-9]/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`, rows);
});

// ===== Unified file reader: accepts CSV/TSV/TXT or Excel (.xlsx/.xls), returns CSV-style text =====
function readFileAsCSVText(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file selected')); return; }
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    const reader = new FileReader();
    if (isExcel) {
      if (typeof XLSX === 'undefined') {
        reject(new Error('Excel parser is still loading — please retry, or save the file as CSV'));
        return;
      }
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('Workbook has no sheets');
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const csvText = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          resolve(csvText);
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Error reading Excel file'));
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => resolve(e.target.result || '');
      reader.onerror = () => reject(new Error('Error reading CSV file'));
      reader.readAsText(file);
    }
  });
}

// ===== Template downloads (sample CSVs for each upload section) =====
// Pull one real product so the sample row is recognizable; fall back to placeholders.
function sampleProductForTemplate() {
  return D.products.find(p => p.n && p.n !== '0' && p.v != null) || null;
}

document.getElementById('masterTemplateBtn').addEventListener('click', () => {
  const sample = sampleProductForTemplate();
  const v = sample && D.vendors[sample.v];
  const folder = sample && D.folders[sample.fl];
  const sampleCat = (sample && D.cats && sample.c != null) ? (D.cats[sample.c] || 'Winter Wear') : 'Winter Wear';
  const sampleSub = (sample && getProductSubCategory(sample)) || 'Heavy Coats';
  const headers = ['parent_id', 'parent_code', 'parent_launch_date', 'vendor_name', 'vendor_code', 'category', 'sub_category', 'parent_folder', 'child_code', 'child_launch_date', 'child_folder', 'abc', 'zone'];
  const rows = [headers];
  if (sample) {
    rows.push([sample.i, sample.n, '2024-03-10', (v && v.name) || 'Acme Imports', (v && v.code) || 'ACME', sampleCat, sampleSub, folder || 'Coats', 'AJ-A94', '2024-08-15', folder || 'Coats', ABCS[sample.b], '1,3']);
    rows.push([sample.i, sample.n, '2024-03-10', (v && v.name) || 'Acme Imports', (v && v.code) || 'ACME', sampleCat, sampleSub, folder || 'Coats', 'AJ-B20', '2025-02-01', folder || 'Coats', ABCS[sample.b], '1,3']);
    rows.push(['', '', '', '', '', 'Notions', 'Buttons', '', '', '2023-01-20', 'Trims', 'B', 'all']);
    rows.push(['', '', '', '', '', 'New Imports', 'Sample SKUs', '', '', '2026-03-22', 'New Imports', 'C', '']);
  } else {
    rows.push([1, 'SAMPLE-001', '2024-03-10', 'Acme Imports', 'ACME', 'Winter Wear', 'Heavy Coats', 'Coats', 'AJ-A94', '2024-08-15', 'Coats', 'A', '1,3']);
    rows.push([1, 'SAMPLE-001', '2024-03-10', 'Acme Imports', 'ACME', 'Winter Wear', 'Heavy Coats', 'Coats', 'AJ-B20', '2025-02-01', 'Coats', 'A', '1,3']);
    rows.push([2, 'SAMPLE-TRIM', '2022-11-15', 'Acme Imports', 'ACME', 'Notions', 'Buttons', 'Trims', 'TRM-T01', '2023-01-20', 'Trims', 'B', 'all']);
    rows.push([3, 'SAMPLE-NEW', '2026-03-01', 'Acme Imports', 'ACME', 'New Imports', 'Sample SKUs', 'New Imports', 'NI-N01', '2026-03-22', 'New Imports', 'C', '']);
  }
  downloadXlsx('Template_Master_ParentChild.xlsx', 'Master Mapping', rows);
});

document.getElementById('stockTemplateBtn').addEventListener('click', () => {
  const sample = sampleProductForTemplate();
  const headers = ['parent_code', 'on_hand', 'in_transit', 'pending', 'discontinued', 'pna', 'refill_date'];
  const rows = [headers];
  if (sample) {
    rows.push([sample.n, sample.k || 100, sample.it || 20, sample.po || 50, 'N', 'N', '']);
    rows.push(['EXAMPLE-PNA', 0, 0, 0, 'N', 'Y', '2026-07-15']);
  } else {
    rows.push(['SAMPLE-001', 100, 20, 50, 'N', 'N', '']);
    rows.push(['SAMPLE-002', 8, 0, 0, 'N', 'N', '']);
    rows.push(['EXAMPLE-PNA', 0, 0, 0, 'N', 'Y', '2026-07-15']);
    rows.push(['OLD-SKU-X', 0, 0, 0, 'Y', 'N', '']);
  }
  downloadXlsx('Template_Stock_Data.xlsx', 'Stock Data', rows);
});

document.getElementById('salesTemplateBtn').addEventListener('click', () => {
  const sample = sampleProductForTemplate();
  const code = sample ? sample.n : 'SAMPLE-001';
  const headers = ['parent_code', 'month', 'sales'];
  const rows = [headers];
  // Include all 24 months so the user sees the expected month-format and full window
  D.months.forEach((label, idx) => {
    const s = sample && Array.isArray(sample.s) ? (sample.s[idx] || 0) : '';
    rows.push([code, label, s]);
  });
  downloadXlsx('Template_Sales_History.xlsx', 'Sales', rows);
});

document.getElementById('purchTemplateBtn').addEventListener('click', () => {
  const sample = sampleProductForTemplate();
  const code = sample ? sample.n : 'SAMPLE-001';
  const headers = ['parent_code', 'month', 'purchases'];
  const rows = [headers];
  D.months.forEach((label, idx) => {
    const p = sample && Array.isArray(sample.p) ? (sample.p[idx] || 0) : '';
    rows.push([code, label, p]);
  });
  downloadXlsx('Template_Purchase_History.xlsx', 'Purchases', rows);
});

// ===== Master upload =====
function parseMasterCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const idIdx = headers.indexOf('parent_id');
  const codeIdx = headers.findIndex(h => h === 'parent_code' || h === 'parent_name');
  const childIdx = headers.indexOf('child_code');
  const folderIdx = headers.findIndex(h => h === 'folder' || h === 'child_folder');
  const variantIdx = headers.indexOf('variant');
  const vendorIdx = headers.findIndex(h => h === 'vendor_name' || h === 'vendor' || h === 'vendor_code' || h === 'vendorname');
  const zoneIdx = headers.findIndex(h => h === 'zone' || h === 'zones' || h === 'folder_zone');
  const launchIdx       = headers.findIndex(h => h === 'child_launch_date' || h === 'launch_date' || h === 'added_date' || h === 'launched_on' || h === 'date_added');
  const parentLaunchIdx = headers.findIndex(h => h === 'parent_launch_date' || h === 'parent_created_date' || h === 'parent_added_date' || h === 'parent_date');
  const categoryIdx     = headers.findIndex(h => h === 'category' || h === 'category_name' || h === 'cat' || h === 'product_category');
  const subCategoryIdx  = headers.findIndex(h => h === 'sub_category' || h === 'subcategory' || h === 'sub_cat' || h === 'subcat' || h === 'product_sub_category');
  if (idIdx === -1 || childIdx === -1) return { error: 'Missing required columns: parent_id and/or child_code' };
  const map = {};
  const zonesByFolder = {};  // accumulate union of zones per folder across all rows
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length <= idIdx) continue;
    const pid = parseInt(parts[idIdx]);
    if (isNaN(pid)) continue;
    if (!map[pid]) map[pid] = { parentCode: codeIdx >= 0 ? parts[codeIdx] : '', vendorName: '', parentLaunchDate: '', categoryName: '', subCategoryName: '', children: [] };
    // Pick up vendor on first non-blank occurrence for the parent
    if (vendorIdx >= 0 && !map[pid].vendorName && parts[vendorIdx]) {
      map[pid].vendorName = parts[vendorIdx].trim();
    }
    // Pick up parent launch date on first non-blank occurrence
    if (parentLaunchIdx >= 0 && !map[pid].parentLaunchDate && parts[parentLaunchIdx]) {
      map[pid].parentLaunchDate = parts[parentLaunchIdx].trim();
    }
    // Pick up category on first non-blank occurrence
    if (categoryIdx >= 0 && !map[pid].categoryName && parts[categoryIdx]) {
      map[pid].categoryName = parts[categoryIdx].trim();
    }
    // Pick up sub-category on first non-blank occurrence
    if (subCategoryIdx >= 0 && !map[pid].subCategoryName && parts[subCategoryIdx]) {
      map[pid].subCategoryName = parts[subCategoryIdx].trim();
    }
    const folder = folderIdx >= 0 ? (parts[folderIdx] || '') : '';
    map[pid].children.push({
      code: parts[childIdx] || '',
      folder: folder,
      variant: variantIdx >= 0 ? (parts[variantIdx] || 'Standard') : 'Standard',
      launchDate: launchIdx >= 0 ? (parts[launchIdx] || '').trim() : '',
    });
    // Aggregate zones for this folder
    if (zoneIdx >= 0 && folder) {
      const z = parseZoneString(parts[zoneIdx]);
      if (z.hasContent) {
        if (!zonesByFolder[folder]) zonesByFolder[folder] = { zones: [], openToAll: false };
        if (z.openToAll) zonesByFolder[folder].openToAll = true;
        z.zones.forEach(n => { if (!zonesByFolder[folder].zones.includes(n)) zonesByFolder[folder].zones.push(n); });
      }
    }
  }
  return { ok: true, map, zonesByFolder };
}

// Snapshot of original product → vendor index so we can restore on reset
const _originalVendorIdx = {};
function snapshotOriginalVendors() {
  if (Object.keys(_originalVendorIdx).length) return;
  D.products.forEach(p => { _originalVendorIdx[p.i] = p.v; });
}
// Vendors added by the user via uploads. Reused across uploads (no duplicates).
// LOCKED vendor list — only the 6 dealers below are ever created in D.vendors.
// If a Master Sheet upload references a vendor name outside this list, we fuzzy-match it
// to one of the 6 (by case-insensitive contains / startsWith / code prefix). If nothing
// matches, we return -1 so the product KEEPS its existing (hash-assigned) vendor.
function ensureVendorEntry(name) {
  if (!name) return -1;
  const clean = name.trim();
  if (!clean) return -1;
  const target = clean.toLowerCase();
  const upper  = clean.toUpperCase();
  // 1) Exact name match (case-insensitive)
  let idx = D.vendors.findIndex(v => (v.name || '').toLowerCase() === target);
  // 2) Exact code match
  if (idx === -1) idx = D.vendors.findIndex(v => (v.code || '').toUpperCase() === upper);
  // 3) Vendor name starts with input (or vice versa) — handles "Vansh Industries" → "Vansh"
  if (idx === -1) idx = D.vendors.findIndex(v => {
    const vn = (v.name || '').toLowerCase();
    return vn && (vn.startsWith(target) || target.startsWith(vn));
  });
  // 4) Input contains the vendor name (or vendor name contains input) — handles "M/s Shiv Shakti Traders" → "Shiv Shakti"
  if (idx === -1) idx = D.vendors.findIndex(v => {
    const vn = (v.name || '').toLowerCase();
    return vn && vn.length >= 3 && (target.includes(vn) || vn.includes(target));
  });
  // 5) Code prefix match — input "VNSH123" → vendor "VNSH"
  if (idx === -1) idx = D.vendors.findIndex(v => (v.code && upper.startsWith(v.code.toUpperCase())));
  // No fuzzy hit → reject. We deliberately DO NOT add new vendor entries here.
  return idx; // -1 if no match
}
function applyVendorOverrides(map) {
  snapshotOriginalVendors();
  // First, revert everything to original so a re-upload behaves predictably
  D.products.forEach(p => { p.v = _originalVendorIdx[p.i] != null ? _originalVendorIdx[p.i] : p.v; });
  if (!map) return;
  Object.keys(map).forEach(pidKey => {
    const pid = parseInt(pidKey);
    const entry = map[pid];
    if (!entry || !entry.vendorName) return;
    const idx = ensureVendorEntry(entry.vendorName);
    if (idx === -1) return;
    const product = D.products.find(p => p.i === pid);
    if (product) product.v = idx;
  });
}

// Categories work the same way as vendors — keep an original snapshot so we can revert,
// add new entries to D.cats on the fly when the CSV introduces a new category name.
const _originalCatIdx = {};
function snapshotOriginalCats() {
  if (Object.keys(_originalCatIdx).length) return;
  D.products.forEach(p => { _originalCatIdx[p.i] = p.c; });
}
function ensureCategoryEntry(name) {
  if (!name) return -1;
  const clean = name.trim();
  if (!clean) return -1;
  if (!Array.isArray(D.cats)) D.cats = [];
  const target = clean.toLowerCase();
  let idx = D.cats.findIndex(c => (c || '').toLowerCase() === target);
  if (idx === -1) {
    D.cats.push(clean);
    idx = D.cats.length - 1;
  }
  return idx;
}
function applyCategoryOverrides(map) {
  snapshotOriginalCats();
  D.products.forEach(p => { p.c = _originalCatIdx[p.i] != null ? _originalCatIdx[p.i] : p.c; });
  if (!map) return;
  Object.keys(map).forEach(pidKey => {
    const pid = parseInt(pidKey);
    const entry = map[pid];
    if (!entry || !entry.categoryName) return;
    const idx = ensureCategoryEntry(entry.categoryName);
    if (idx === -1) return;
    const product = D.products.find(p => p.i === pid);
    if (product) product.c = idx;
  });
}

// Sub-categories — every product can be in exactly one. Lookup table is D.subCats (created on demand),
// product field is p.sc (index). Mirrors the category implementation.
if (!Array.isArray(D.subCats)) D.subCats = [];
const _originalSubCatIdx = {};
function snapshotOriginalSubCats() {
  if (Object.keys(_originalSubCatIdx).length) return;
  D.products.forEach(p => { _originalSubCatIdx[p.i] = (p.sc != null) ? p.sc : -1; });
}
function ensureSubCategoryEntry(name) {
  if (!name) return -1;
  const clean = name.trim();
  if (!clean) return -1;
  const target = clean.toLowerCase();
  let idx = D.subCats.findIndex(c => (c || '').toLowerCase() === target);
  if (idx === -1) {
    D.subCats.push(clean);
    idx = D.subCats.length - 1;
  }
  return idx;
}
function applySubCategoryOverrides(map) {
  snapshotOriginalSubCats();
  D.products.forEach(p => {
    const o = _originalSubCatIdx[p.i];
    p.sc = (o != null && o !== -1) ? o : (p.sc != null ? p.sc : undefined);
  });
  if (!map) return;
  Object.keys(map).forEach(pidKey => {
    const pid = parseInt(pidKey);
    const entry = map[pid];
    if (!entry || !entry.subCategoryName) return;
    const idx = ensureSubCategoryEntry(entry.subCategoryName);
    if (idx === -1) return;
    const product = D.products.find(p => p.i === pid);
    if (product) product.sc = idx;
  });
}
function getProductSubCategory(p) {
  if (!p || p.sc == null) return '';
  return D.subCats[p.sc] || '';
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else { cur += ch; }
  }
  result.push(cur);
  return result.map(s => s.trim());
}

function applyMasterOverride(map, sourceLabel, zonesByFolder) {
  masterOverride = map;
  // In real-data mode the whole catalog is rebuilt from the uploads, so the demo-catalog
  // overlays (which mutate the synthetic D.products by id) are skipped — they'd be discarded.
  if (!realDataMode) {
    applyVendorOverrides(map);
    applyCategoryOverrides(map);
    applySubCategoryOverrides(map);
  }
  // Pull parent launch dates out of the master map into our keyed cache so all UI can read them
  let parentDateCount = 0;
  let parentTypeCount = 0;
  Object.keys(map).forEach(pidKey => {
    const entry = map[pidKey];
    if (!entry) return;
    const parentKey = (entry.parentCode || '').toUpperCase().trim();
    if (parentKey && entry.parentLaunchDate) {
      parentLaunchDates[parentKey] = entry.parentLaunchDate;
      parentDateCount++;
    }
    // Product Type (raw Product Master only) — kept as its own field
    if (parentKey && entry.productType) {
      parentProductTypes[parentKey] = entry.productType;
      parentTypeCount++;
    }
  });
  if (parentDateCount > 0) saveParentLaunchDates();
  if (parentTypeCount > 0) saveParentProductTypes();
  // Apply zone mappings if provided
  let zoneFoldersUpdated = 0;
  if (zonesByFolder && typeof zonesByFolder === 'object') {
    Object.keys(zonesByFolder).forEach(folder => {
      const v = zonesByFolder[folder];
      folderZones[folder] = { zones: v.zones || [], openToAll: !!v.openToAll };
      zoneFoldersUpdated++;
    });
    if (zoneFoldersUpdated > 0) saveFolderZones();
  }
  const parentCount = Object.keys(map).length;
  const childCount = Object.values(map).reduce((s, p) => s + p.children.length, 0);
  const vendorCount = Object.values(map).filter(p => p.vendorName).length;
  const vendorNote = vendorCount > 0 ? ` · <strong style="color:var(--accent)">${fmt(vendorCount)}</strong> vendor overrides applied` : '';
  const zoneNote = zoneFoldersUpdated > 0 ? ` · <strong style="color:var(--accent)">${fmt(zoneFoldersUpdated)}</strong> folder zone assignment${zoneFoldersUpdated > 1 ? 's' : ''}` : '';
  document.getElementById('uploadStatus').innerHTML = `<strong>Custom mapping loaded</strong> from ${sourceLabel} — <strong style="color:var(--accent)">${fmt(parentCount)}</strong> parents, <strong style="color:var(--accent)">${fmt(childCount)}</strong> child codes${vendorNote}${zoneNote}`;
  document.getElementById('uploadStatus').classList.add('loaded');
  document.getElementById('masterReset').style.display = '';
  // Only persist the (bulky) master map in demo mode. In real-data mode the cleaned catalog is
  // stored whole via PUT /api/data and the map is reconstructed from it on reload — so we keep
  // MongoDB holding ONLY cleaned data (no redundant raw-ish blob) → faster retrieval.
  if (!realDataMode) { try { localStorage.setItem('inventoryMasterOverride', JSON.stringify(map)); } catch (e) {} }
  // In real-data mode the caller runs rebuildDashboardFromUploads() which refreshes every view;
  // skip the demo-catalog re-renders here to avoid rendering the stale synthetic catalog.
  if (!realDataMode) {
    renderFolderView();
    // Vendors/categories may have changed → refresh vendor + category datalists AND the vendor analytics panel
    if (typeof refreshFilterDatalists === 'function') refreshFilterDatalists();
    if (typeof renderVendors === 'function') renderVendors();
    if (typeof renderZoneBrowser === 'function') renderZoneBrowser();
    rerender();
  }
}

// ===== Raw "Product Master" export → cleaned parent/child map =====
// The ERP exports a wide (130+ column) raw file. We auto-detect it, keep only the fields that
// matter, resolve the parent↔child relationship, and produce the SAME map shape parseMasterCSV
// returns so the rest of the pipeline (applyMasterOverride) is unchanged.

// Reads a master file into BOTH a CSV-text form (for the clean-schema parser) and an array of
// row objects (for the raw transformer). Row objects avoid the fragility of flattening 130
// quoted columns to CSV. Used by both the Master and Purchase raw-upload paths.
function readUploadFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file selected')); return; }
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    const reader = new FileReader();
    if (isExcel) {
      if (typeof XLSX === 'undefined') {
        reject(new Error('Excel parser is still loading — please retry, or save the file as CSV'));
        return;
      }
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('Workbook has no sheets');
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const objects = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          // A huge worksheet (its XML > the browser's ~512 MB max string length) makes SheetJS
          // silently yield 0 rows and no '!ref'. Detect that and give an actionable message
          // instead of a confusing downstream "no header row" error.
          if (!objects.length && !sheet['!ref']) {
            const mb = (e.target.result.byteLength || 0) / 1048576;
            reject(new Error(mb > 40
              ? `This Excel file is too large for in-browser parsing (${mb.toFixed(0)} MB — its internal sheet data exceeds the browser's ~512 MB limit). Re-save it as CSV and upload that, or export just these columns: Date, Product, Product Code, Qty, Company Name, PID.`
              : 'No rows found in the first sheet of this Excel file.'));
            return;
          }
          const csvText = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          resolve({ objects, csvText });
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Error reading Excel file'));
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        const text = e.target.result || '';
        resolve({ objects: csvTextToObjects(text), csvText: text });
      };
      reader.onerror = () => reject(new Error('Error reading CSV file'));
      reader.readAsText(file);
    }
  });
}
function csvTextToObjects(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = parts[idx] != null ? parts[idx] : ''; });
    out.push(obj);
  }
  return out;
}
// Raw Product Master is identified by its ERP header names.
function isRawProductMaster(objects) {
  if (!objects || !objects.length) return false;
  const keys = Object.keys(objects[0]).map(k => String(k).trim().toLowerCase());
  return keys.includes('productid') && keys.includes('parent product') && keys.includes('product name');
}
// Transform raw rows → { map, stats }. Identity/code = Product Name (per user's decision).
function transformProductMasterRaw(objects) {
  const empty = { map: {}, stats: { parents: 0, children: 0, standalone: 0 } };
  if (!objects || !objects.length) return empty;
  const sampleKeys = Object.keys(objects[0]);
  const findKey = (target) => sampleKeys.find(k => String(k).trim().toLowerCase() === target) || null;
  const kId     = findKey('productid');
  const kName   = findKey('product name');
  const kParent = findKey('parent product');
  const kSupp   = findKey('suppliername');
  const kDate   = findKey('creationdate');
  const kCat    = findKey('category');
  const kType   = findKey('product type');
  const kStock  = findKey('stock');   // parent-level on-hand (used as initial stock in real-data mode)
  if (!kId || !kName || !kParent) return empty;

  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };

  // Index every row by ProductId so we can look up a child's parent row (and detect orphans).
  const byId = {};
  objects.forEach(r => { const id = num(r[kId]); if (id != null) byId[id] = r; });

  const map = {};
  const idIndex = {};   // every ProductId (parent or child) → its parent's Product Name (identity code)
  let children = 0, standalone = 0;
  function ensureParent(pid) {
    if (map[pid]) return map[pid];
    const prow = byId[pid];
    map[pid] = {
      parentCode: prow ? str(prow[kName]) : '',
      vendorName: prow ? str(prow[kSupp]) : '',
      parentLaunchDate: prow ? str(prow[kDate]) : '',
      categoryName: prow ? str(prow[kCat]) : '',
      productType: prow ? str(prow[kType]) : '',
      stock: (prow && kStock) ? (parseInt(prow[kStock], 10) || 0) : 0,
      children: [],
    };
    return map[pid];
  }

  objects.forEach(r => {
    const id = num(r[kId]);
    if (id == null) return;
    const ppRaw = num(r[kParent]);
    // Effective parent: a valid, non-zero Parent Product that exists in the file → that parent;
    // otherwise (blank / 0 / orphan) the product is STANDALONE — its own parent. (Nothing dropped.)
    const hasParent = (ppRaw != null && ppRaw !== 0 && byId[ppRaw]);
    const pid = hasParent ? ppRaw : id;
    if (!hasParent) standalone++;
    const parent = ensureParent(pid);
    parent.children.push({
      code: str(r[kName]),
      folder: '',
      variant: 'Standard',
      launchDate: str(r[kDate]),
    });
    // Map this row's own ProductId → its parent's Product Name (used by Purchase/Sales/Stock cleaners).
    if (parent.parentCode) idIndex[id] = parent.parentCode;
    children++;
  });

  return { map, idIndex, stats: { parents: Object.keys(map).length, children, standalone } };
}
// Build a downloadable cleaned file in the dashboard's clean schema (+ product_type).
function downloadCleanedMaster(map) {
  const headers = ['parent_id', 'parent_code', 'parent_launch_date', 'vendor_name', 'category', 'product_type', 'child_code', 'child_launch_date'];
  const rows = [headers];
  Object.keys(map).forEach(pid => {
    const e = map[pid];
    e.children.forEach(ch => {
      rows.push([pid, e.parentCode, e.parentLaunchDate, e.vendorName, e.categoryName, e.productType, ch.code, ch.launchDate]);
    });
  });
  downloadXlsx('Cleaned_Product_Master.xlsx', 'Cleaned Master', rows);
}
// Render the cleaned-data preview (summary + scrollable sample of the first 200 parents).
function renderMasterPreview(stats, map) {
  const el = document.getElementById('masterPreview');
  if (!el) return;
  const escHtml = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pids = Object.keys(map);
  const sample = pids.slice(0, 200);
  let body = '';
  sample.forEach(pid => {
    const e = map[pid];
    body += `<tr>` +
      `<td>${pid}</td>` +
      `<td>${escHtml(e.parentCode) || '<span style="color:var(--text-3)">—</span>'}</td>` +
      `<td>${escHtml(e.categoryName) || '<span style="color:var(--text-3)">—</span>'}</td>` +
      `<td>${escHtml(e.productType) || '<span style="color:var(--text-3)">—</span>'}</td>` +
      `<td>${escHtml(e.vendorName) || '<span style="color:var(--text-3)">—</span>'}</td>` +
      `<td>${escHtml(e.parentLaunchDate) || '<span style="color:var(--text-3)">—</span>'}</td>` +
      `<td class="num">${fmt(e.children.length)}</td>` +
      `</tr>`;
  });
  const droppedNote = (stats.standalone)
    ? ` · <span style="color:var(--text-3)">incl. ${fmt(stats.standalone)} standalone (no parent)</span>`
    : '';
  el.innerHTML =
    `<div class="master-preview-summary" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">` +
      `<span><strong style="color:var(--accent)">Cleaned</strong> — <strong>${fmt(stats.parents)}</strong> parents · <strong>${fmt(stats.children)}</strong> child codes${droppedNote}</span>` +
      `<button class="upload-btn" id="masterPreviewDownload" title="Download the full cleaned data as Excel">↓ Download full cleaned file</button>` +
    `</div>` +
    `<div style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin-bottom:6px;">Preview of first ${fmt(sample.length)} of ${fmt(stats.parents)} parents (Product Name is the identity code)</div>` +
    `<div class="table-wrap" style="max-height:360px;"><table class="master-preview-table">` +
      `<thead><tr><th>Parent ID</th><th>Product Name</th><th>Category</th><th>Product Type</th><th>Supplier</th><th>Launch Date</th><th class="num">#Children</th></tr></thead>` +
      `<tbody>${body}</tbody></table></div>`;
  el.style.display = '';
  const dlBtn = document.getElementById('masterPreviewDownload');
  if (dlBtn) dlBtn.addEventListener('click', () => downloadCleanedMaster(map));
}

document.getElementById('uploadBtnTrigger').addEventListener('click', () => {
  document.getElementById('masterUpload').click();
});

document.getElementById('masterUpload').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  runWithLoader('Cleaning &amp; building from ' + file.name + '…', () =>
  readUploadFile(file).then(({ objects, csvText }) => {
    // Raw ERP Product Master export → clean it, preview it, then feed the existing engine.
    if (isRawProductMaster(objects)) {
      const { map, idIndex, stats } = transformProductMasterRaw(objects);
      if (!stats.parents) {
        alert('No valid parent products found after cleaning. Every row had a blank/0 or unmatched Parent Product.');
        return;
      }
      // Persist the ProductId → parent-code index so the Purchase/Sales cleaners can resolve PIDs.
      Object.keys(productIdToParentCode).forEach(k => delete productIdToParentCode[k]);
      Object.assign(productIdToParentCode, idIndex);
      saveProductIdIndex();
      renderMasterPreview(stats, map);
      // Enter real-data mode and BUILD the live dashboard from this master (+ any sales/purchase/
      // stock already uploaded). applyMasterOverride still records parentLaunchDates/productTypes.
      realDataMode = true;
      realData.masterMap = map;
      applyMasterOverride(map, file.name, {});
      rebuildDashboardFromUploads();
      document.getElementById('uploadStatus').innerHTML =
        `<strong>Dashboard built from your data</strong> — <strong style="color:var(--accent)">${fmt(stats.parents)}</strong> products · <strong style="color:var(--accent)">${fmt(stats.children)}</strong> child codes. Upload Sales / Purchases / Stock to fill it in.`;
      document.getElementById('uploadStatus').classList.add('loaded');
      document.getElementById('masterReset').style.display = '';
      return;
    }
    // Clean-schema path (unchanged) — hide any stale raw preview first.
    const pv = document.getElementById('masterPreview');
    if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
    const result = parseMasterCSV(csvText);
    if (!result || result.error) {
      alert('Could not parse file: ' + (result ? result.error : 'unknown error') + '\n\nExpected columns: parent_id, parent_code, child_code, folder, variant (optional: vendor_name, zone)\n\nOr upload your raw Product Master export (ProductId, Product Name, Parent Product, …) to have it cleaned automatically.');
      return;
    }
    applyMasterOverride(result.map, file.name, result.zonesByFolder);
    persistDatasetToMongo();
  }).catch(err => alert('Error: ' + (err.message || err)))
  );
  e.target.value = '';
});

document.getElementById('masterReset').addEventListener('click', () => {
  if (!confirm('Clear custom master mapping and revert to synthetic?')) return;
  masterOverride = null;
  applyVendorOverrides(null);       // revert vendor changes
  applyCategoryOverrides(null);     // revert category changes
  applySubCategoryOverrides(null);  // revert sub-category changes
  try { localStorage.removeItem('inventoryMasterOverride'); } catch (e) {}
  const pv = document.getElementById('masterPreview');
  if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
  document.getElementById('uploadStatus').textContent = 'Using synthetic mapping — upload your real master CSV to swap in';
  document.getElementById('uploadStatus').classList.remove('loaded');
  document.getElementById('masterReset').style.display = 'none';
  renderFolderView();
  if (typeof renderVendors === 'function') renderVendors();
  rerender();
});

// Restore upload UI state if a DEMO-mode mapping was saved (real-data mode rebuilds from D instead).
if (masterOverride && !(D && D.__real)) {
  // Re-apply vendor + category + sub-category overrides from saved mapping
  applyVendorOverrides(masterOverride);
  applyCategoryOverrides(masterOverride);
  applySubCategoryOverrides(masterOverride);
  const parentCount = Object.keys(masterOverride).length;
  const childCount = Object.values(masterOverride).reduce((s, p) => s + p.children.length, 0);
  const vendorCount = Object.values(masterOverride).filter(p => p.vendorName).length;
  const vendorNote = vendorCount > 0 ? ` · <strong style="color:var(--accent)">${fmt(vendorCount)}</strong> vendor overrides applied` : '';
  document.getElementById('uploadStatus').innerHTML = `<strong>Custom mapping loaded</strong> from previous session — <strong style="color:var(--accent)">${fmt(parentCount)}</strong> parents, <strong style="color:var(--accent)">${fmt(childCount)}</strong> child codes${vendorNote}`;
  document.getElementById('uploadStatus').classList.add('loaded');
  document.getElementById('masterReset').style.display = '';
}

// ===== Stock data upload (parent_code → on_hand / in_transit / pending) =====
// Apply uploaded values to matching products, recalc av/ad, persist to localStorage.
const STOCK_OVERRIDE_KEY = 'inventoryStockOverride';
let stockOverride = null;   // { byCode: { 'PARENT_CODE': {k?, it?, po?} }, count: N, uploadedAt: '...' }
const _originalStockSnapshot = {}; // pid → {k, it, po, av, ad}

function snapshotOriginalStock() {
  if (Object.keys(_originalStockSnapshot).length) return;
  D.products.forEach(p => {
    _originalStockSnapshot[p.i] = { k: p.k, it: p.it, po: p.po, av: p.av, ad: p.ad };
  });
}

function recomputeDerivedStock(p) {
  // av = on-hand + in-transit (canonical "available")
  p.av = (p.k || 0) + (p.it || 0);
  // ad = days of cover at recent sales rate. p.m is avg monthly sales.
  if (!p.m || p.m <= 0) {
    p.ad = 999; // no sales → infinite cover
  } else {
    p.ad = Math.max(0, Math.min(999, Math.round(p.av * 30 / p.m)));
  }
}

function applyStockOverride(override) {
  snapshotOriginalStock();
  let matched = 0, unmatched = 0, discToggled = 0, pnaToggled = 0;
  D.products.forEach(p => {
    const orig = _originalStockSnapshot[p.i];
    if (override && override.byCode) {
      // Match against product name OR a synthesized code (uppercase, no spaces)
      const codeA = (p.n || '').toUpperCase().trim();
      const codeB = codeA.replace(/\s+/g, '');
      const row = override.byCode[codeA] || override.byCode[codeB];
      if (row) {
        if (row.k  != null) p.k  = row.k;
        if (row.it != null) p.it = row.it;
        if (row.po != null) p.po = row.po;
        if (row.disc === true) {
          if (!discontinuedIds.has(p.i)) { discontinuedIds.add(p.i); discToggled++; manualReorderIds.delete(p.i); }
        } else if (row.disc === false) {
          if (discontinuedIds.has(p.i)) { discontinuedIds.delete(p.i); discToggled++; }
        }
        // PNA + refill date
        if (row.pna === true) {
          const date = row.refillDate || '';
          if (!pnaData[p.i] || pnaData[p.i].date !== date) {
            pnaData[p.i] = { date };
            pnaToggled++;
          }
        } else if (row.pna === false) {
          if (pnaData[p.i]) { delete pnaData[p.i]; pnaToggled++; }
        } else if (row.refillDate && pnaData[p.i]) {
          // pna column absent but a refill date was provided — update date if already PNA
          if (pnaData[p.i].date !== row.refillDate) { pnaData[p.i].date = row.refillDate; pnaToggled++; }
        }
        recomputeDerivedStock(p);
        matched++;
        return;
      }
    }
    // Revert to original for non-matched products
    p.k = orig.k; p.it = orig.it; p.po = orig.po; p.av = orig.av; p.ad = orig.ad;
    if (override) unmatched++;
  });
  if (discToggled > 0) { saveDiscontinued(); saveManualReorder(); }
  if (pnaToggled > 0)  { savePnaData(); }
  return { matched, unmatched, discToggled, pnaToggled };
}

function setStockStatus(msg, kind) {
  const el = document.getElementById('stockUploadStatus');
  if (!el) return;
  el.innerHTML = msg;
  el.classList.toggle('loaded', kind === 'ok');
  el.style.color = kind === 'err' ? 'var(--red)' : '';
}

function saveStockOverride() {
  try { localStorage.setItem(STOCK_OVERRIDE_KEY, JSON.stringify(stockOverride)); } catch (e) {}
}

function clearStockOverride() {
  stockOverride = null;
  try { localStorage.removeItem(STOCK_OVERRIDE_KEY); } catch (e) {}
  applyStockOverride(null);
  setStockStatus('No stock override loaded — current values come from the embedded dataset', 'idle');
  document.getElementById('stockReset').style.display = 'none';
  document.getElementById('stockUploadDetail').textContent = '';
  rerender();
}

function parseStockCSV(text) {
  // Simple CSV/TSV parser — splits on \n, then on , or \t
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length);
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const splitRow = (l) => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
  const headers = splitRow(lines[0]).map(h => h.toLowerCase());

  const codeAliases     = ['parent_code', 'parentcode', 'code', 'parent', 'sku', 'parent_sku'];
  const onhandAliases   = ['on_hand', 'onhand', 'k', 'stock', 'qty', 'quantity', 'hand'];
  const transitAliases  = ['in_transit', 'intransit', 'transit', 'it'];
  const pendingAliases  = ['pending', 'po', 'pending_factory', 'pendingfactory'];
  const discAliases     = ['discontinued', 'disc', 'is_discontinued', 'status'];
  const pnaAliases      = ['pna', 'paper_not_available', 'paper_status', 'paper_avail', 'paper_available'];
  const refillAliases   = ['refill_date', 'refill_by', 'pna_date', 'paper_refill_date', 'available_from', 'paper_available_from', 'expected_date'];

  const findIdx = (aliases) => headers.findIndex(h => aliases.includes(h));
  const iCode    = findIdx(codeAliases);
  const iOnhand  = findIdx(onhandAliases);
  const iTransit = findIdx(transitAliases);
  const iPending = findIdx(pendingAliases);
  const iDisc    = findIdx(discAliases);
  const iPna     = findIdx(pnaAliases);
  const iRefill  = findIdx(refillAliases);

  if (iCode === -1) throw new Error('Required column "parent_code" not found (also accepted: code, parent, sku, parent_sku)');
  if (iOnhand === -1 && iTransit === -1 && iPending === -1 && iDisc === -1 && iPna === -1) {
    throw new Error('At least one of on_hand / in_transit / pending / discontinued / pna must be present');
  }
  const truthy = (s) => {
    if (s == null) return null;
    const v = String(s).trim().toLowerCase();
    if (v === '') return null;
    if (['y','yes','true','1','t','disc','discontinued'].includes(v)) return true;
    if (['n','no','false','0','f','active'].includes(v)) return false;
    return null;
  };

  const byCode = {};
  let rows = 0, skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const cols = splitRow(lines[li]);
    const code = (cols[iCode] || '').toUpperCase().trim();
    if (!code) { skipped++; continue; }
    const entry = {};
    const num = (s) => {
      if (s == null) return null;
      const v = parseFloat(String(s).replace(/[,_\s]/g, ''));
      return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
    };
    if (iOnhand  !== -1) { const v = num(cols[iOnhand]);  if (v != null) entry.k  = v; }
    if (iTransit !== -1) { const v = num(cols[iTransit]); if (v != null) entry.it = v; }
    if (iPending !== -1) { const v = num(cols[iPending]); if (v != null) entry.po = v; }
    if (iDisc    !== -1) { const v = truthy(cols[iDisc]); if (v != null) entry.disc = v; }
    if (iPna     !== -1) { const v = truthy(cols[iPna]);  if (v != null) entry.pna = v; }
    if (iRefill  !== -1) { const v = (cols[iRefill] || '').trim(); if (v) entry.refillDate = v; }
    if (Object.keys(entry).length === 0) { skipped++; continue; }
    byCode[code] = entry;
    rows++;
  }
  return { byCode, count: rows, skipped };
}

// ===== Raw "Stock Master" export → cleaned per-parent on-hand =====
// Many rows per product (per godown/rack). Only ProductID, Name, Stock matter. A parent and its
// children are the SAME physical product, so we resolve each row's ProductID → parent code and
// SUM the stock per parent group (folding all children + all godown rows into one on-hand).
function isRawStock(objects) {
  if (!objects || !objects.length) return false;
  const keys = Object.keys(objects[0]).map(k => String(k).trim().toLowerCase());
  return keys.includes('productid') && keys.includes('stock') && keys.includes('name');
}
function transformStockRaw(objects) {
  const empty = { stockByCode: {}, stats: { parents: 0, totalStock: 0, rows: 0, droppedUnresolved: 0 }, aggregates: {}, sampleTx: [] };
  if (!objects || !objects.length) return empty;
  const sk = Object.keys(objects[0]);
  const findKey = (t) => sk.find(k => String(k).trim().toLowerCase() === t) || null;
  const kPid = findKey('productid'), kName = findKey('name'), kStock = findKey('stock');
  if (!kPid || !kStock) return empty;
  const str = (v) => (v == null ? '' : String(v).trim());
  const numInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };

  const stockByCode = {};   // UPPER(parentCode) → { k }
  const aggregates = {};    // UPPER(parentCode) → { parentCode, k, rows }
  const sampleTx = [];
  let totalStock = 0, rows = 0, droppedUnresolved = 0;

  objects.forEach(r => {
    const pid = numInt(r[kPid]);
    const parentCode = (pid != null) ? productIdToParentCode[pid] : null;
    if (!parentCode) { droppedUnresolved++; return; }
    const qty = numInt(r[kStock]) || 0;
    const codeKey = parentCode.toUpperCase().trim();
    if (!stockByCode[codeKey]) stockByCode[codeKey] = { k: 0 };
    stockByCode[codeKey].k += qty;
    let a = aggregates[codeKey];
    if (!a) a = aggregates[codeKey] = { parentCode, k: 0, rows: 0 };
    a.k += qty; a.rows++;
    if (sampleTx.length < 200) sampleTx.push({ parent: parentCode, name: str(r[kName]), qty, pid });
    totalStock += qty; rows++;
  });

  return { stockByCode, stats: { parents: Object.keys(stockByCode).length, totalStock, rows, droppedUnresolved }, aggregates, sampleTx };
}
function downloadCleanedStock(stockByCode) {
  const rows = [['parent_code', 'on_hand']];
  Object.keys(stockByCode).forEach(code => rows.push([code, stockByCode[code].k]));
  downloadXlsx('Cleaned_Stock.xlsx', 'Cleaned Stock', rows);
}
function renderStockPreview(stats, aggregates, sampleTx, stockByCode) {
  const el = document.getElementById('stockPreview');
  if (!el) return;
  const escHtml = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dash = '<span style="color:var(--text-3)">—</span>';
  const aggKeys = Object.keys(aggregates).slice(0, 200);
  let aggBody = '';
  aggKeys.forEach(k => { const a = aggregates[k]; aggBody += `<tr><td>${escHtml(a.parentCode)}</td><td class="num">${fmt(a.k)}</td><td class="num">${fmt(a.rows)}</td></tr>`; });
  let txBody = '';
  sampleTx.forEach(t => { txBody += `<tr><td>${escHtml(t.parent)}</td><td>${escHtml(t.name) || dash}</td><td class="num">${fmt(t.qty)}</td><td class="num">${t.pid}</td></tr>`; });
  const totalParents = Object.keys(aggregates).length;
  el.innerHTML =
    `<div class="master-preview-summary" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">` +
      `<span><strong style="color:var(--accent)">Cleaned stock</strong> — <strong>${fmt(stats.parents)}</strong> parents · <strong>${fmt(stats.totalStock)}</strong> on-hand (summed parent+children)` +
      `<span style="color:var(--text-3)"> · ${fmt(stats.rows)} rows · dropped ${fmt(stats.droppedUnresolved)} unresolved</span></span>` +
      `<button class="upload-btn" id="stockPreviewDownload" title="Download the cleaned parent_code, on_hand file">↓ Download full cleaned file</button>` +
    `</div>` +
    `<div style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin-bottom:6px;">Per-parent on-hand (first ${fmt(aggKeys.length)} of ${fmt(totalParents)} parents) — stock summed across the parent and all its child codes</div>` +
    `<div class="table-wrap" style="max-height:280px;"><table class="master-preview-table">` +
      `<thead><tr><th>Parent</th><th class="num">On-hand</th><th class="num">#Stock rows</th></tr></thead><tbody>${aggBody}</tbody></table></div>` +
    `<div style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin:10px 0 6px;">Sample rows (first ${fmt(sampleTx.length)} — each mapped to its parent)</div>` +
    `<div class="table-wrap" style="max-height:280px;"><table class="master-preview-table">` +
      `<thead><tr><th>Parent</th><th>Name</th><th class="num">Stock</th><th class="num">ProductID</th></tr></thead><tbody>${txBody}</tbody></table></div>`;
  el.style.display = '';
  const dl = document.getElementById('stockPreviewDownload');
  if (dl) dl.addEventListener('click', () => downloadCleanedStock(stockByCode));
}

function handleStockFile(file) {
  if (!file) return;
  // Raw Stock Master (.xlsx with ProductID/Name/Stock) needs object rows; the clean template is CSV.
  runWithLoader('Cleaning stock — ' + file.name + '…', () =>
  readUploadFile(file).then(({ objects, csvText }) => {
    if (isRawStock(objects)) {
      if (!Object.keys(productIdToParentCode).length) {
        setStockStatus('<span style="color:var(--red)">Upload &amp; clean the Product Master first (needed to map ProductID → parent)</span>', 'err');
        return;
      }
      const { stockByCode, stats, aggregates, sampleTx } = transformStockRaw(objects);
      if (!stats.parents) { setStockStatus('<span style="color:var(--red)">No stock rows resolved to a parent</span>', 'err'); return; }
      // Upsert into realData (set on-hand k; keep any it/po) and rebuild the live dashboard.
      Object.keys(stockByCode).forEach(code => {
        realData.stockByCode[code] = Object.assign({}, realData.stockByCode[code], { k: stockByCode[code].k });
      });
      renderStockPreview(stats, aggregates, sampleTx, stockByCode);
      if (realDataMode) {
        rebuildDashboardFromUploads();
        setStockStatus(`<strong>Stock cleaned &amp; dashboard rebuilt</strong> from <strong style="color:var(--accent)">${file.name}</strong> — <strong>${fmt(stats.parents)}</strong> parents · <strong>${fmt(stats.totalStock)}</strong> on-hand`, 'ok');
      } else {
        setStockStatus(`<strong>Stock cleaned</strong> — upload &amp; build the Master first to see it on the dashboard`, 'ok');
      }
      document.getElementById('stockUploadDetail').innerHTML = stats.droppedUnresolved > 0 ? `${fmt(stats.droppedUnresolved)} row(s) with unresolved ProductID` : '';
      document.getElementById('stockReset').style.display = '';
      return;
    }
    const pv = document.getElementById('stockPreview');
    if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
    const text = csvText;
    const parsed = parseStockCSV(text);
    stockOverride = { byCode: parsed.byCode, count: parsed.count, uploadedAt: new Date().toISOString(), fileName: file.name };
    // Real-data mode: fold stock into realData (upsert by parent code) and rebuild the dashboard.
    if (realDataMode) {
      Object.keys(parsed.byCode).forEach(code => {
        const src = parsed.byCode[code];
        realData.stockByCode[code] = Object.assign({}, realData.stockByCode[code], {
          k: src.k, it: src.it, po: src.po,
        });
      });
      rebuildDashboardFromUploads();
      setStockStatus(`<strong>Stock loaded &amp; dashboard rebuilt</strong> from <strong style="color:var(--accent)">${file.name}</strong> — <strong>${fmt(parsed.count)}</strong> rows`, 'ok');
      document.getElementById('stockUploadDetail').innerHTML = parsed.skipped > 0 ? `${fmt(parsed.skipped)} row(s) skipped (blank or no values)` : '';
      document.getElementById('stockReset').style.display = '';
      return;
    }
    const { matched, unmatched, discToggled } = applyStockOverride(stockOverride);
    saveStockOverride();
    setStockStatus(`<strong>Stock data loaded</strong> from <strong style="color:var(--accent)">${file.name}</strong> — <strong>${fmt(parsed.count)}</strong> rows parsed, <strong style="color:var(--green)">${fmt(matched)}</strong> matched to products`, 'ok');
    const notes = [`${fmt(unmatched)} products kept their original stock (no matching parent_code in file)`];
    if (discToggled > 0) notes.push(`<strong style="color:var(--text-2)">${fmt(discToggled)}</strong> discontinued flag(s) toggled`);
    if (parsed.skipped > 0) notes.push(`${fmt(parsed.skipped)} row(s) skipped (blank or no values)`);
    document.getElementById('stockUploadDetail').innerHTML = notes.join(' · ');
    document.getElementById('stockReset').style.display = '';
    rerender();
    persistDatasetToMongo();
  }).catch(err => {
    setStockStatus('Error: ' + (err.message || 'failed to parse file'), 'err');
    document.getElementById('stockUploadDetail').textContent = '';
  })
  );
}

// Wire up upload + reset
document.getElementById('stockUploadBtnTrigger').addEventListener('click', () => {
  document.getElementById('stockUpload').click();
});
document.getElementById('stockUpload').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) handleStockFile(f);
  e.target.value = '';
});
document.getElementById('stockReset').addEventListener('click', () => {
  if (!confirm('Clear uploaded stock data and revert to embedded values?')) return;
  clearStockOverride();
});

// Drag-and-drop on the stock upload zone
(function setupStockDrag() {
  const z = document.getElementById('stockUploadZone');
  if (!z) return;
  ['dragenter','dragover'].forEach(ev => z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.remove('dragover'); }));
  z.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleStockFile(f);
  });
})();

// Restore previous stock override from localStorage
try {
  const savedStock = localStorage.getItem(STOCK_OVERRIDE_KEY);
  if (savedStock) {
    stockOverride = JSON.parse(savedStock);
    const { matched, unmatched } = applyStockOverride(stockOverride);
    setStockStatus(`<strong>Stock data loaded</strong> from previous session (<strong style="color:var(--accent)">${stockOverride.fileName || 'CSV'}</strong>) — <strong>${fmt(stockOverride.count)}</strong> rows, <strong style="color:var(--green)">${fmt(matched)}</strong> matched`, 'ok');
    document.getElementById('stockUploadDetail').textContent = `${fmt(unmatched)} products kept their original stock (no match in CSV)`;
    document.getElementById('stockReset').style.display = '';
  }
} catch (e) {}

// ===== Sales & Purchase history upload (parent_code + month → p.s / p.p) =====
const HIST_OVERRIDE_KEY = 'inventoryHistoryOverride';
let historyOverride = null;   // { byCode: { 'PARENT_CODE': { s: [24], p: [24] } } }
const _originalHistorySnapshot = {}; // pid → { s, p, a, m, ad }

function snapshotOriginalHistory() {
  if (Object.keys(_originalHistorySnapshot).length) return;
  D.products.forEach(p => {
    _originalHistorySnapshot[p.i] = {
      s: (p.s || []).slice(),
      p: (p.p || []).slice(),
      a: p.a, m: p.m, ad: p.ad
    };
  });
}

// Build a fast lookup: normalized month string → index in D.months (0..23)
function buildMonthIndex() {
  const map = {};
  const MONTH_NAMES = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };
  D.months.forEach((label, idx) => {
    // D.months entries look like "May-24"
    const [mon, yr] = label.split('-');
    const monKey = (mon || '').slice(0, 3).toLowerCase();
    const yr2 = (yr || '').slice(-2);
    const yr4 = '20' + yr2;
    const mIdx = MONTH_NAMES[monKey];
    if (mIdx == null) return;
    const mm = String(mIdx + 1).padStart(2, '0');
    const mm1 = String(mIdx + 1); // no padding
    // All the formats we accept, normalized to lowercase
    [
      label.toLowerCase(),                              // may-24
      `${monKey}-${yr2}`,                               // may-24
      `${monKey} ${yr4}`,                               // may 2025
      `${monKey}-${yr4}`,                               // may-2025
      `${mon.toLowerCase()} ${yr4}`,                    // may 2025 (full mon name match)
      `${yr4}-${mm}`,                                   // 2025-04
      `${yr4}/${mm}`,                                   // 2025/04
      `${yr4}-${mm1}`,                                  // 2025-4
      `${mm}/${yr4}`,                                   // 04/2025
      `${mm1}/${yr4}`,                                  // 4/2025
      `${mm}/${yr2}`,                                   // 04/25
      `${mm1}/${yr2}`,                                  // 4/25
      `${mm}-${yr4}`,                                   // 04-2025
      `${mm}-${yr2}`,                                   // 04-25
      // Full month names
      `${Object.keys(MONTH_NAMES).find(k => MONTH_NAMES[k] === mIdx && k.length > 3) || ''}-${yr2}`,
      `${Object.keys(MONTH_NAMES).find(k => MONTH_NAMES[k] === mIdx && k.length > 3) || ''} ${yr4}`,
    ].forEach(key => { if (key && !map[key]) map[key] = idx; });
  });
  return map;
}
const _monthIdxMap = buildMonthIndex();
function lookupMonthIdx(raw) {
  if (!raw) return -1;
  const k = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (_monthIdxMap[k] != null) return _monthIdxMap[k];
  // Strip stray characters and retry
  const k2 = k.replace(/[\.,]/g, '');
  if (_monthIdxMap[k2] != null) return _monthIdxMap[k2];
  // Try matching with space → hyphen
  const k3 = k.replace(/\s+/g, '-');
  if (_monthIdxMap[k3] != null) return _monthIdxMap[k3];
  return -1;
}

function recomputeSalesDerived(p) {
  const s = p.s || [];
  // Annual sales = sum of most-recent 12 months
  p.a = s.slice(-12).reduce((x, y) => x + (+y || 0), 0);
  // Avg monthly sales = mean of most-recent 6 months
  const recent6 = s.slice(-6);
  const sum6 = recent6.reduce((x, y) => x + (+y || 0), 0);
  p.m = recent6.length ? sum6 / recent6.length : 0;
  // Days of cover (uses current p.av if set, else p.k + p.it)
  const avail = (typeof p.av === 'number') ? p.av : ((p.k || 0) + (p.it || 0));
  p.ad = (!p.m || p.m <= 0) ? 999 : Math.max(0, Math.min(999, Math.round(avail * 30 / p.m)));
}

function applyHistoryOverride(override) {
  snapshotOriginalHistory();
  let matched = 0, unmatched = 0;
  D.products.forEach(p => {
    const orig = _originalHistorySnapshot[p.i];
    if (override && override.byCode) {
      const codeA = (p.n || '').toUpperCase().trim();
      const codeB = codeA.replace(/\s+/g, '');
      const row = override.byCode[codeA] || override.byCode[codeB];
      if (row) {
        // Build fresh 24-length arrays seeded from the original snapshot
        const newS = orig.s.length === 24 ? orig.s.slice() : new Array(24).fill(0);
        const newP = orig.p.length === 24 ? orig.p.slice() : new Array(24).fill(0);
        (row.s || []).forEach((v, i) => { if (v != null) newS[i] = v; });
        (row.p || []).forEach((v, i) => { if (v != null) newP[i] = v; });
        p.s = newS; p.p = newP;
        recomputeSalesDerived(p);
        matched++;
        return;
      }
    }
    // Revert to original
    p.s = orig.s.slice();
    p.p = orig.p.slice();
    p.a = orig.a; p.m = orig.m; p.ad = orig.ad;
    if (override) unmatched++;
  });
  // Sales array has changed → re-classify and re-detect anomalies for everyone
  precomputeDemandMeta();
  return { matched, unmatched };
}

function setHistStatus(msg, kind) {
  const el = document.getElementById('histUploadStatus');
  if (!el) return;
  el.innerHTML = msg;
  el.classList.toggle('loaded', kind === 'ok');
  el.style.color = kind === 'err' ? 'var(--red)' : '';
}

function saveHistoryOverride() {
  try { localStorage.setItem(HIST_OVERRIDE_KEY, JSON.stringify(historyOverride)); } catch (e) {}
}

// Supports BOTH layouts:
//   LONG:   parent_code, month, sales|purchases    (one row per parent × month)
//   WIDE:   parent_code (or "product"), Apr 2024, May 2024, Jun 2024, ...  (one row per parent, months as columns)
// The valueType hint ("sales" or "purchases") is only used for wide layout — tells the parser
// which array (p.s or p.p) to fill from the value cells.
function parseHistoryCSV(text, valueType) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().length);
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const splitRow = (l) => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
  const headers = splitRow(lines[0]).map(h => h.toLowerCase());

  const codeAliases  = ['parent_code', 'parentcode', 'code', 'parent', 'sku', 'parent_sku', 'product', 'product_code', 'product_name', 'item', 'item_code'];
  const monthAliases = ['month', 'mon', 'period', 'date', 'yyyy-mm', 'year_month'];
  const salesAliases = ['sales', 'qty_sold', 'sold', 'sales_qty', 's'];
  const purchAliases = ['purchases', 'qty_bought', 'bought', 'purchase', 'purchase_qty', 'p'];

  const findIdx = (aliases) => headers.findIndex(h => aliases.includes(h));
  const iCode  = findIdx(codeAliases);
  const iMonth = findIdx(monthAliases);
  const iSales = findIdx(salesAliases);
  const iPurch = findIdx(purchAliases);

  if (iCode  === -1) throw new Error('Required column "parent_code" (or "product") not found');

  const num = (s) => {
    if (s == null) return null;
    const v = parseFloat(String(s).replace(/[,_\s]/g, ''));
    return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  };

  const byCode = {};
  let rows = 0, skippedMonth = 0, skippedBlank = 0;

  // ===== WIDE format detection =====
  // Long format has a "month" column. Wide format does not but has 2+ headers that look like months.
  const wideMonthCols = [];
  if (iMonth === -1) {
    headers.forEach((h, i) => {
      if (!h || i === iCode) return;
      // Skip obvious non-month columns
      if (/^(grand\s*total|total|sum|avg|average|notes?|comment)/i.test(h)) return;
      // Try to parse this header as a month → idx. Accept variations like "April 2024", "13-May-26", etc.
      // Strip a leading day number: "13-May-26" → "May-26"
      const cleaned = h.replace(/^\d+[\s\-\/]+/, '').trim();
      const midx = lookupMonthIdx(cleaned) !== -1 ? lookupMonthIdx(cleaned) : lookupMonthIdx(h);
      if (midx !== -1) wideMonthCols.push({ headerIdx: i, monthIdx: midx, label: h });
    });
  }
  const isWide = (iMonth === -1) && wideMonthCols.length >= 2;

  if (isWide) {
    // Determine which array to fill — sales or purchases
    // Priority: explicit hint > inferred from a "type" column > infer from any sales/purch header > default sales
    let fillKey = (valueType === 'purchases' || valueType === 'purch') ? 'p' : 'sales';
    if (valueType === 'sales' || valueType === 'qty_sold') fillKey = 's';
    else if (valueType === 'purchases' || valueType === 'purch' || valueType === 'qty_bought') fillKey = 'p';
    else if (iSales !== -1 && iPurch === -1) fillKey = 's';
    else if (iPurch !== -1 && iSales === -1) fillKey = 'p';
    else fillKey = 's';  // default to sales if ambiguous

    for (let li = 1; li < lines.length; li++) {
      const cols = splitRow(lines[li]);
      const code = (cols[iCode] || '').toUpperCase().trim();
      if (!code) { skippedBlank++; continue; }
      if (!byCode[code]) byCode[code] = { s: new Array(24).fill(null), p: new Array(24).fill(null) };
      let rowAdded = false;
      wideMonthCols.forEach(mc => {
        const v = num(cols[mc.headerIdx]);
        if (v == null) return;
        byCode[code][fillKey][mc.monthIdx] = v;
        rowAdded = true;
      });
      if (rowAdded) rows++;
    }
    skippedMonth = 0;  // wide layout doesn't have per-row month skip semantics
    return { byCode, count: rows, skippedMonth, skippedBlank, parentCount: Object.keys(byCode).length, layout: 'wide' };
  }

  // ===== LONG format =====
  if (iMonth === -1) throw new Error('Required column "month" not found (and no wide-format month columns detected)');
  if (iSales === -1 && iPurch === -1) throw new Error('At least one of "sales" or "purchases" must be present');
  for (let li = 1; li < lines.length; li++) {
    const cols = splitRow(lines[li]);
    const code = (cols[iCode] || '').toUpperCase().trim();
    if (!code) { skippedBlank++; continue; }
    const monRaw = (cols[iMonth] || '').trim();
    const mIdx = lookupMonthIdx(monRaw);
    if (mIdx === -1) { skippedMonth++; continue; }
    if (!byCode[code]) byCode[code] = { s: new Array(24).fill(null), p: new Array(24).fill(null) };
    if (iSales !== -1) { const v = num(cols[iSales]); if (v != null) byCode[code].s[mIdx] = v; }
    if (iPurch !== -1) { const v = num(cols[iPurch]); if (v != null) byCode[code].p[mIdx] = v; }
    rows++;
  }
  return { byCode, count: rows, skippedMonth, skippedBlank, parentCount: Object.keys(byCode).length, layout: 'long' };
}

function clearHistoryOverride() {
  historyOverride = null;
  try { localStorage.removeItem(HIST_OVERRIDE_KEY); } catch (e) {}
  applyHistoryOverride(null);
  setHistStatus('No history override loaded — using embedded 24-month data', 'idle');
  document.getElementById('histReset').style.display = 'none';
  document.getElementById('histUploadDetail').textContent = '';
  const sEl = document.getElementById('salesUploadStatus');
  if (sEl) sEl.innerHTML = '<strong>Sales</strong> — no file loaded';
  const pEl = document.getElementById('purchUploadStatus');
  if (pEl) pEl.innerHTML = '<strong>Purchases</strong> — no file loaded';
  ['salesPreview', 'purchasePreview'].forEach(id => {
    const pv = document.getElementById(id);
    if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
  });
  rerender();
}

function handleHistFile(file) {
  if (!file) return;
  readFileAsCSVText(file).then(text => {
    const parsed = parseHistoryCSV(text);
    historyOverride = {
      byCode: parsed.byCode,
      count: parsed.count,
      parentCount: parsed.parentCount,
      uploadedAt: new Date().toISOString(),
      fileName: file.name
    };
    const { matched, unmatched } = applyHistoryOverride(historyOverride);
    saveHistoryOverride();
    setHistStatus(`<strong>History loaded</strong> from <strong style="color:var(--accent)">${file.name}</strong> — <strong>${fmt(parsed.count)}</strong> rows · <strong>${fmt(parsed.parentCount)}</strong> parents · <strong style="color:var(--green)">${fmt(matched)}</strong> matched to products`, 'ok');
    const skipNotes = [];
    if (parsed.skippedMonth > 0) skipNotes.push(`${fmt(parsed.skippedMonth)} row(s) had unrecognized month`);
    if (parsed.skippedBlank > 0) skipNotes.push(`${fmt(parsed.skippedBlank)} row(s) had blank parent_code`);
    if (unmatched > 0) skipNotes.push(`${fmt(unmatched)} products kept their original data (no match in file)`);
    document.getElementById('histUploadDetail').innerHTML = skipNotes.join(' · ') || 'All rows applied cleanly';
    document.getElementById('histReset').style.display = '';
    rerender();
  }).catch(err => {
    setHistStatus('Error: ' + (err.message || 'failed to parse file'), 'err');
    document.getElementById('histUploadDetail').textContent = '';
  });
}

// ===== Raw "Sales" / "Purchase" export → cleaned per-parent monthly quantities =====
// Both ERP exports share the same shape (Date, Product, Product Code, Qty, Company Name, PID),
// so one set of helpers serves both — only the target array ('s' sales / 'p' purchases) differs.
// Detected by column names (the clean template has none of these).
function isRawHistory(objects) {
  if (!objects || !objects.length) return false;
  const keys = Object.keys(objects[0]).map(k => String(k).trim().toLowerCase());
  return keys.includes('pid') && keys.includes('qty') && keys.includes('product');
}
// Parse the ERP date "dd-mm-yyyy | hh:mm AM/PM" → "yyyy-mm" (or '' if unparseable).
function historyMonthKey(raw) {
  if (!raw) return '';
  const datePart = String(raw).split('|')[0].trim();            // "30-03-2025"
  const m = datePart.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (!m) return '';
  let yy = m[3];
  if (yy.length === 2) yy = '20' + yy;
  return `${yy}-${String(m[2]).padStart(2, '0')}`;              // "2025-03"
}
// Transform raw sales/purchase rows → { byCode, monthByCode, stats, aggregates, sampleTx }.
// Resolves each line's PID (=ProductId) → parent code via productIdToParentCode, then SUMS Qty
// per parent × month. `byCode` is the 24-slot array aligned to the CURRENT D.months window (used
// by the preview + clean-CSV feed). `monthByCode` is the FULL month-keyed map (every 'yyyy-mm',
// no window filter) that the real-data rebuild uses to shift the window to the latest data.
function transformHistoryRaw(objects, key) {
  const empty = { byCode: {}, monthByCode: {}, stats: { resolvedRows: 0, parents: 0, totalQty: 0, droppedUnresolved: 0, droppedOutOfWindow: 0 }, aggregates: {}, sampleTx: [] };
  if (!objects || !objects.length) return empty;
  const sk = Object.keys(objects[0]);
  const findKey = (t) => sk.find(k => String(k).trim().toLowerCase() === t) || null;
  const kDate = findKey('date'), kProduct = findKey('product');
  const kQty = findKey('qty'), kCompany = findKey('company name'), kPid = findKey('pid');
  if (!kPid || !kQty) return empty;
  const str = (v) => (v == null ? '' : String(v).trim());
  const numInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };

  const byCode = {};
  const monthByCode = {};  // UPPER(parentCode) → { 'yyyy-mm': summedQty }  (all months)
  const aggregates = {};   // UPPER(parentCode) → { parentCode, totalQty, txCount, months:Set, parties:Set }
  const sampleTx = [];
  let resolvedRows = 0, totalQty = 0, droppedUnresolved = 0, droppedOutOfWindow = 0;

  objects.forEach(r => {
    const pid = numInt(r[kPid]);
    const parentCode = (pid != null) ? productIdToParentCode[pid] : null;
    if (!parentCode) { droppedUnresolved++; return; }
    const ym = historyMonthKey(r[kDate]);
    if (!ym) { droppedOutOfWindow++; return; }   // unparseable date
    const qty = numInt(r[kQty]) || 0;
    const codeKey = parentCode.toUpperCase().trim();
    // Full month-keyed map (retains ALL months for the window-shifting rebuild)
    if (!monthByCode[codeKey]) monthByCode[codeKey] = {};
    monthByCode[codeKey][ym] = (monthByCode[codeKey][ym] || 0) + qty;
    // 24-slot fixed-window aggregate (for preview + clean-CSV feed)
    const mIdx = lookupMonthIdx(ym);
    if (mIdx === -1) { droppedOutOfWindow++; return; }
    if (!byCode[codeKey]) byCode[codeKey] = { s: new Array(24).fill(null), p: new Array(24).fill(null) };
    byCode[codeKey][key][mIdx] = (byCode[codeKey][key][mIdx] || 0) + qty;
    let a = aggregates[codeKey];
    if (!a) a = aggregates[codeKey] = { parentCode, totalQty: 0, txCount: 0, months: new Set(), parties: new Set() };
    a.totalQty += qty; a.txCount++; a.months.add(mIdx);
    const party = str(r[kCompany]); if (party) a.parties.add(party);
    if (sampleTx.length < 200) {
      sampleTx.push({ date: str(r[kDate]).split('|')[0].trim(), parent: parentCode, product: str(r[kProduct]), qty, party, pid });
    }
    resolvedRows++; totalQty += qty;
  });

  return {
    byCode, monthByCode,
    stats: { resolvedRows, parents: Object.keys(byCode).length, totalQty, droppedUnresolved, droppedOutOfWindow },
    aggregates, sampleTx,
  };
}
function downloadCleanedHistory(byCode, key, valueLabel) {
  const cap = valueLabel === 'sales' ? 'Sales' : 'Purchases';
  const headers = ['parent_code', 'month', valueLabel];
  const rows = [headers];
  Object.keys(byCode).forEach(code => {
    const arr = byCode[code][key];
    for (let i = 0; i < 24; i++) if (arr[i] != null) rows.push([code, D.months[i], arr[i]]);
  });
  downloadXlsx(`Cleaned_${cap}.xlsx`, `Cleaned ${cap}`, rows);
}
// opts = { key:'s'|'p', valueType:'sales'|'purchases', containerId, entity:'Customer'|'Vendor' }
function renderHistoryPreview(stats, aggregates, sampleTx, byCode, opts) {
  const el = document.getElementById(opts.containerId);
  if (!el) return;
  const escHtml = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dash = '<span style="color:var(--text-3)">—</span>';
  const label = opts.valueType === 'sales' ? 'sales' : 'purchases';
  const countHdr = opts.valueType === 'sales' ? '#Sales' : '#Purchases';
  const dlId = opts.containerId + 'Download';
  const aggKeys = Object.keys(aggregates).slice(0, 200);
  let aggBody = '';
  aggKeys.forEach(k => {
    const a = aggregates[k];
    aggBody += `<tr><td>${escHtml(a.parentCode)}</td><td class="num">${fmt(a.totalQty)}</td><td class="num">${fmt(a.txCount)}</td><td class="num">${fmt(a.months.size)}</td><td>${escHtml([...a.parties].slice(0, 2).join(', ')) || dash}</td></tr>`;
  });
  let txBody = '';
  sampleTx.forEach(t => {
    txBody += `<tr><td>${escHtml(t.date)}</td><td>${escHtml(t.parent)}</td><td>${escHtml(t.product) || dash}</td><td class="num">${fmt(t.qty)}</td><td>${escHtml(t.party) || dash}</td><td class="num">${t.pid}</td></tr>`;
  });
  const totalParents = Object.keys(aggregates).length;
  el.innerHTML =
    `<div class="master-preview-summary" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">` +
      `<span><strong style="color:var(--accent)">Cleaned ${label}</strong> — <strong>${fmt(stats.parents)}</strong> parents · <strong>${fmt(stats.resolvedRows)}</strong> in-window lines · <strong>${fmt(stats.totalQty)}</strong> total qty` +
      `<span style="color:var(--text-3)"> · dropped ${fmt(stats.droppedOutOfWindow)} out-of-window, ${fmt(stats.droppedUnresolved)} unresolved PID</span></span>` +
      `<button class="upload-btn" id="${dlId}" title="Download the cleaned parent_code, month, ${label} file">↓ Download full cleaned file</button>` +
    `</div>` +
    `<div style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin-bottom:6px;">Per-parent aggregate (first ${fmt(aggKeys.length)} of ${fmt(totalParents)} parents) — qty summed across all ${label} lines</div>` +
    `<div class="table-wrap" style="max-height:280px;"><table class="master-preview-table">` +
      `<thead><tr><th>Parent</th><th class="num">Total Qty</th><th class="num">${countHdr}</th><th class="num">#Months</th><th>${opts.entity}(s)</th></tr></thead><tbody>${aggBody}</tbody></table></div>` +
    `<div style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin:10px 0 6px;">Transaction sample (first ${fmt(sampleTx.length)} cleaned lines — each mapped to its parent)</div>` +
    `<div class="table-wrap" style="max-height:280px;"><table class="master-preview-table">` +
      `<thead><tr><th>Date</th><th>Parent</th><th>Product</th><th class="num">Qty</th><th>${opts.entity}</th><th class="num">PID</th></tr></thead><tbody>${txBody}</tbody></table></div>`;
  el.style.display = '';
  const dl = document.getElementById(dlId);
  if (dl) dl.addEventListener('click', () => downloadCleanedHistory(byCode, opts.key, label));
}

// Merge a { code: {s,p} } map into the shared historyOverride, filling only the `key` array
// (`s` for sales, `p` for purchases) so sales and purchases never clobber each other.
function mergeHistoryByCode(srcByCode, key, fileName, count) {
  if (!historyOverride || !historyOverride.byCode) {
    historyOverride = { byCode: {}, count: 0, parentCount: 0, fileName: '' };
  }
  Object.keys(srcByCode).forEach(code => {
    if (!historyOverride.byCode[code]) {
      historyOverride.byCode[code] = { s: new Array(24).fill(null), p: new Array(24).fill(null) };
    }
    const src = srcByCode[code][key];
    for (let i = 0; i < 24; i++) if (src[i] != null) historyOverride.byCode[code][key][i] = src[i];
  });
  historyOverride.count = (historyOverride.count || 0) + (count || 0);
  historyOverride.parentCount = Object.keys(historyOverride.byCode).length;
  historyOverride.uploadedAt = new Date().toISOString();
  historyOverride.fileName = fileName;
}

// ============================================================================
// Build the LIVE dashboard from the user's raw uploads (real-data mode).
// Constructs the whole dataset `D` (products + lookups + kpi/agg/folderSummary +
// a window shifted to the latest data) and refreshes every view in place.
// ============================================================================
const _MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// "2026-07" → 24 month labels ("Aug-24" … "Jul-26") ending at that month.
function build24Window(endYm) {
  let [y, m] = String(endYm).split('-').map(n => parseInt(n, 10));
  const labels = [];
  for (let i = 23; i >= 0; i--) {
    let mm = m - i, yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    labels.push(`${_MONTH_ABBR[mm - 1]}-${String(yy).slice(-2)}`);
  }
  return labels;
}
// window labels → { 'yyyy-mm': slotIndex }
function windowIndexMap(labels) {
  const map = {};
  labels.forEach((lbl, i) => {
    const [mon, yy] = lbl.split('-');
    const mm = _MONTH_ABBR.indexOf(mon) + 1;
    if (mm > 0) map[`20${yy}-${String(mm).padStart(2, '0')}`] = i;
  });
  return map;
}
// Newest 'yyyy-mm' present across sales+purchase; fallback keeps a valid window.
function computeDataWindowEnd() {
  let maxYm = '';
  const scan = (store) => Object.keys(store).forEach(c => Object.keys(store[c]).forEach(ym => { if (ym > maxYm) maxYm = ym; }));
  scan(realData.salesByMonth); scan(realData.purchByMonth);
  return maxYm || '2026-04';
}
// ---- Classification helpers (standard inventory heuristics matching D's label sets) ----
function monthsSinceLastSale(s) {
  for (let i = s.length - 1, k = 0; i >= 0; i--, k++) if ((+s[i] || 0) > 0) return k;
  return 13; // never sold within the window
}
function productAgeMonths(launchStr, anchorYm) {
  if (!launchStr) return 24;
  const m = String(launchStr).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (!m) return 24;
  let ly = m[3]; if (ly.length === 2) ly = '20' + ly;
  const lym = parseInt(ly, 10) * 12 + parseInt(m[2], 10);
  const [ay, am] = anchorYm.split('-').map(n => parseInt(n, 10));
  return Math.max(0, Math.min(24, ay * 12 + am - lym));
}
function turnoverRatio(p) {
  const stock = p.av || 0;
  if (stock <= 0) return 99;                    // ∞ sentinel (must be a number)
  return Math.min(99, Math.round((p.a || 0) / stock * 100) / 100);
}
function statusIndexFor(p) {
  const S = (name) => { const i = D.statusCodes.indexOf(name); return i >= 0 ? i : 0; };
  const hasStock = (p.av || 0) > 0;
  const hasSales = (p.a || 0) > 0 || (p.m || 0) > 0;
  if (!hasStock && !hasSales) return S('Inactive');
  if (!hasStock) return S('Critical');          // demand but nothing on hand
  if (!hasSales) return S('Dead Stock');         // stock but no sales
  const ad = p.ad;
  if (ad < 15) return S('Critical');
  if (ad < 30) return S('Low Stock');
  if (ad <= 90) return S('Healthy');
  if (ad <= 180) return S('Adequate');
  return S('Overstocked');
}
function moverIndexFor(p) {
  const Mv = (name) => { const i = D.moverCodes.indexOf(name); return i >= 0 ? i : 0; };
  if ((p.av || 0) <= 0 && (p.a || 0) <= 0) return Mv('No Stock');
  const ms = p.ms;
  if (ms >= 12) return Mv('Non-Moving (12m+)');
  if (ms >= 6) return Mv('Slow (6-12m)');
  if (ms >= 3) return Mv('Sluggish (3-6m)');
  return Mv('Active');
}
// Pareto ABC on annual sales units: cumulative ≤80% → A, ≤95% → B, else C.
function assignABC(products) {
  const sorted = products.slice().sort((a, b) => (b.a || 0) - (a.a || 0));
  const total = sorted.reduce((x, p) => x + (p.a || 0), 0);
  let cum = 0;
  sorted.forEach(p => {
    if (total <= 0 || (p.a || 0) <= 0) { p.b = 2; return; }
    cum += (p.a || 0);
    const share = cum / total;
    p.b = share <= 0.80 ? 0 : share <= 0.95 ? 1 : 2;
  });
}
// Rebuild D.aggP / D.aggS / D.kpi / D.folderSummary from the freshly built products.
function rebuildAggregates() {
  const products = D.products;
  const aggP = new Array(24).fill(0), aggS = new Array(24).fill(0);
  products.forEach(p => { for (let i = 0; i < 24; i++) { aggP[i] += (+p.p[i] || 0); aggS[i] += (+p.s[i] || 0); } });
  D.aggP = aggP; D.aggS = aggS;

  const critIdx = D.statusCodes.indexOf('Critical');
  let totalChildren = 0, totalStock = 0, inTransit = 0, pending = 0, annualSales = 0;
  let classACount = 0, classBCount = 0, classCCount = 0, classASales = 0, criticalCount = 0, slowCount = 0, nonMovingUnits = 0, bulkAnomalyCount = 0;
  products.forEach(p => {
    totalChildren += (p.ch ? p.ch.length : 0);
    totalStock += (+p.k || 0); inTransit += (+p.it || 0); pending += (+p.po || 0);
    annualSales += (+p.a || 0);
    if (p.b === 0) { classACount++; classASales += (+p.a || 0); } else if (p.b === 1) classBCount++; else classCCount++;
    if (p.st === critIdx) criticalCount++;
    const mv = D.moverCodes[p.mv] || '';
    if (mv.startsWith('Slow') || mv.startsWith('Non-Moving')) { slowCount++; nonMovingUnits += (+p.k || 0); }
    bulkAnomalyCount += (p.ba ? p.ba.length : 0);
  });
  D.kpi = {
    totalProducts: products.length, totalChildren,
    totalFolders: D.folders.length, totalCategories: D.cats.length,
    annualSales, totalStock, inTransitTotal: inTransit, pendingTotal: pending,
    classACount, classBCount, classCCount, classASales,
    netReorderQty: 0, netReorderProducts: 0, reorderSavedByPipeline: 0,
    criticalCount, criticalImprovedCount: 0,
    bulkAnomalyCount, slowMoverCount: slowCount, nonMovingUnits,
  };

  const byFolder = {};
  products.forEach(p => {
    const f = D.folders[p.fl] || '(uncategorized)';
    if (!byFolder[f]) byFolder[f] = { Folder: f, parents: 0, children: 0, sales: 0, stock: 0, folder_age: 0, _ageSum: 0, folder_avg_age: 0, new_count: 0, young_count: 0 };
    const g = byFolder[f];
    g.parents++; g.children += (p.ch ? p.ch.length : 0); g.sales += (+p.a || 0); g.stock += (+p.k || 0);
    g.folder_age = Math.max(g.folder_age, p.pa || 0); g._ageSum += (p.pa || 0);
    if ((p.pa || 0) <= 3) g.new_count++;
    if ((p.pa || 0) <= 6) g.young_count++;
  });
  D.folderSummary = Object.values(byFolder).map(g => { g.folder_avg_age = g.parents ? Math.round(g._ageSum / g.parents) : 0; delete g._ageSum; return g; });
}
// The orchestrator — called after each raw upload once a real Master is present.
function rebuildDashboardFromUploads() {
  if (!realData.masterMap) return;
  const map = realData.masterMap;

  // 1) Window from the latest data
  const endYm = computeDataWindowEnd();
  const months = build24Window(endYm);
  const ymIdx = windowIndexMap(months);
  D.months = months;

  // 2) Lookups: vendors = Suppliers, cats = folders = Categories, subCats empty
  const vendors = [], vendorIdx = {}, cats = [], catIdx = {};
  const ensureVendor = (name) => {
    const clean = (name || '').trim();
    const keyU = clean.toUpperCase() || '__NONE__';
    if (vendorIdx[keyU] == null) {
      vendorIdx[keyU] = vendors.length;
      vendors.push(clean ? { code: 'V' + String(vendors.length + 1).padStart(3, '0'), name: clean, city: '', skus: 0 }
                         : { code: '—', name: '(no supplier)', city: '', skus: 0 });
    }
    return vendorIdx[keyU];
  };
  const ensureCat = (name) => {
    const clean = (name || '').trim() || '(uncategorized)';
    const keyU = clean.toUpperCase();
    if (catIdx[keyU] == null) { catIdx[keyU] = cats.length; cats.push(clean); }
    return catIdx[keyU];
  };

  // 3) Products — one per parent
  const products = [];
  const okPriority = Math.max(0, D.priorityCodes.indexOf('OK'));
  Object.keys(map).forEach(pidKey => {
    const e = map[pidKey];
    const code = (e.parentCode || '').trim();
    if (!code) return;
    const codeU = code.toUpperCase();
    const v = ensureVendor(e.vendorName);
    const c = ensureCat(e.categoryName);
    const s = new Array(24).fill(0), pr = new Array(24).fill(0);
    const sm = realData.salesByMonth[codeU]; if (sm) Object.keys(sm).forEach(ym => { const i = ymIdx[ym]; if (i != null) s[i] += sm[ym]; });
    const pm = realData.purchByMonth[codeU]; if (pm) Object.keys(pm).forEach(ym => { const i = ymIdx[ym]; if (i != null) pr[i] += pm[ym]; });
    const st = realData.stockByCode[codeU] || {};
    // Uploaded stock file wins; otherwise fall back to the Master's parent-level Stock column.
    const k = (st.k != null ? +st.k : (+e.stock || 0)), it = +st.it || 0, po = +st.po || 0;
    const ch = (e.children || []).map(ci => [String(ci.code || ''), null, 0]);
    vendors[v].skus += 1;
    products.push({
      i: parseInt(pidKey, 10), n: code, v, c, fl: c, sc: undefined,
      s, p: pr, ch, ba: [],
      k, it, po, av: k + it, tp: k + it + po,
      a: 0, m: 0, ad: 999, d: 999, f: 0, nr: 0, r: 0, x: 0, t: 99,
      b: 2, st: 0, mv: 0, ms: 13, pr: okPriority, ps: 0, pa: 24, fa: 24,
    });
  });

  D.cats = cats; D.folders = cats; D.vendors = vendors; D.subCats = [];
  D.products = products;

  // 4) Derived + classification
  products.forEach(p => {
    recomputeDerivedStock(p);   // av, ad
    recomputeSalesDerived(p);   // a, m, ad
    p.ms = monthsSinceLastSale(p.s);
    p.pa = productAgeMonths(parentLaunchDates[(p.n || '').toUpperCase().trim()], endYm);
    p.fa = p.pa;
    p.t = turnoverRatio(p);
    p.st = statusIndexFor(p);
    p.mv = moverIndexFor(p);
    p.d = p.ad; p.f = Math.round(p.m || 0); p.ps = p.st;
  });
  assignABC(products);

  // 5) Aggregates
  rebuildAggregates();

  // 6) Refresh every view in place
  realDataMode = true;
  D.__real = true;   // persisted flag → on reload we skip the demo dummy-vendor step & rehydrate
  const _hw = document.getElementById('histWindowLabel');
  if (_hw) _hw.textContent = `${D.months[0]} → ${D.months[D.months.length - 1]}`;
  if (typeof precomputeDemandMeta === 'function') precomputeDemandMeta();
  renderHeaderAndCharts();
  if (typeof refreshFilterDatalists === 'function') refreshFilterDatalists();
  if (typeof renderVendors === 'function') renderVendors();
  if (typeof renderZoneBrowser === 'function') renderZoneBrowser();
  if (typeof renderFolderView === 'function') renderFolderView();
  rerender();
  persistDatasetToMongo();
}

// On reload, the persisted `D` already holds the real catalog but the in-memory `realData` store
// is empty — reconstruct it from `D` so further incremental uploads can rebuild correctly.
function rehydrateRealDataFromD() {
  const months = D.months || [];
  const ymOf = (i) => { const [mon, yy] = String(months[i] || '').split('-'); const mm = _MONTH_ABBR.indexOf(mon) + 1; return mm > 0 ? `20${yy}-${String(mm).padStart(2, '0')}` : null; };
  const map = {}, salesByMonth = {}, purchByMonth = {}, stockByCode = {};
  (D.products || []).forEach(p => {
    const codeU = (p.n || '').toUpperCase().trim();
    map[p.i] = {
      parentCode: p.n,
      vendorName: (D.vendors[p.v] || {}).name || '',
      categoryName: D.cats[p.c] || '',
      productType: parentProductTypes[codeU] || '',
      parentLaunchDate: parentLaunchDates[codeU] || '',
      stock: p.k || 0,
      children: (p.ch || []).map(c => ({ code: c[0], launchDate: '' })),
    };
    stockByCode[codeU] = { k: p.k || 0, it: p.it || 0, po: p.po || 0 };
    for (let i = 0; i < 24; i++) {
      const ym = ymOf(i); if (!ym) continue;
      if (p.s[i]) (salesByMonth[codeU] || (salesByMonth[codeU] = {}))[ym] = p.s[i];
      if (p.p[i]) (purchByMonth[codeU] || (purchByMonth[codeU] = {}))[ym] = p.p[i];
    }
  });
  realData.masterMap = map;
  realData.salesByMonth = salesByMonth;
  realData.purchByMonth = purchByMonth;
  realData.stockByCode = stockByCode;
  // Also set the global masterOverride so getProductChildren() shows real child codes (this map
  // is what we chose NOT to persist separately — it's rebuilt here from the cleaned catalog).
  masterOverride = map;
}

// Upload a SALES-only or PURCHASES-only file. Each merges into the shared
// historyOverride: a sales upload fills the `s` array, a purchases upload fills
// the `p` array, and neither clobbers the other — so you can upload them
// separately (or re-upload just one) and they combine into one 24-month history.
function handleHistFileTyped(file, valueType) {
  if (!file) return;
  const isPurch = valueType === 'purchases';
  const label = isPurch ? 'Purchases' : 'Sales';
  const key = isPurch ? 'p' : 's';
  const subStatusId = isPurch ? 'purchUploadStatus' : 'salesUploadStatus';
  const subStatus = document.getElementById(subStatusId);
  runWithLoader('Cleaning ' + label + ' — ' + file.name + '…', () =>
  readUploadFile(file).then(({ objects, csvText }) => {
    // ===== Raw ERP Sales/Purchase export → clean + preview + feed (both boxes) =====
    if (isRawHistory(objects)) {
      if (!Object.keys(productIdToParentCode).length) {
        if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--red)">Upload &amp; clean the Product Master first (needed to map PID → parent)</span>`;
        return;
      }
      const { byCode, monthByCode, stats, aggregates, sampleTx } = transformHistoryRaw(objects, key);
      if (!stats.parents && !Object.keys(monthByCode).length) {
        if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--red)">No ${label.toLowerCase()} lines resolved to a parent</span>`;
        return;
      }
      renderHistoryPreview(stats, aggregates, sampleTx, byCode, {
        key, valueType, containerId: isPurch ? 'purchasePreview' : 'salesPreview', entity: isPurch ? 'Vendor' : 'Customer',
      });
      if (realDataMode) {
        // Keep the full month map (upsert: re-uploaded months replace, new months merge) and
        // rebuild the live dashboard so the window shifts to the latest data.
        mergeMonthMaps(isPurch ? realData.purchByMonth : realData.salesByMonth, monthByCode);
        rebuildDashboardFromUploads();
        const lines = Object.values(monthByCode).reduce((s, m) => s + Object.keys(m).length, 0);
        if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--green)">${fmt(stats.resolvedRows)}</span> lines · ${fmt(Object.keys(monthByCode).length)} parents · <span style="color:var(--accent)">${file.name}</span>`;
        setHistStatus(`<strong>${label} loaded &amp; dashboard rebuilt</strong> — window now ${D.months[0]} → ${D.months[D.months.length - 1]}`, 'ok');
        document.getElementById('histUploadDetail').innerHTML = `${fmt(stats.droppedUnresolved)} line(s) with unresolved PID`;
        document.getElementById('histReset').style.display = '';
        return;
      }
      // Demo-overlay mode (no real Master built yet): feed the existing 24-month engine.
      mergeHistoryByCode(byCode, key, file.name, stats.resolvedRows);
      const { matched, unmatched } = applyHistoryOverride(historyOverride);
      saveHistoryOverride();
      if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--green)">${fmt(stats.resolvedRows)}</span> lines · ${fmt(stats.parents)} parents · <span style="color:var(--accent)">${file.name}</span>`;
      setHistStatus(`<strong>${label} cleaned &amp; loaded</strong> — <strong>${fmt(stats.parents)}</strong> parents · <strong style="color:var(--green)">${fmt(matched)}</strong> matched to products`, 'ok');
      const notes = [`${fmt(stats.droppedOutOfWindow)} line(s) out of the 24-month window`, `${fmt(stats.droppedUnresolved)} line(s) with unresolved PID`];
      if (unmatched > 0) notes.push(`${fmt(unmatched)} products kept their original data (no match)`);
      document.getElementById('histUploadDetail').innerHTML = notes.join(' · ');
      document.getElementById('histReset').style.display = '';
      rerender();
      persistDatasetToMongo();
      return;
    }
    // ===== Clean-schema path (parent_code, month, sales|purchases) — unchanged =====
    { const pv = document.getElementById(isPurch ? 'purchasePreview' : 'salesPreview'); if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; } }
    const parsed = parseHistoryCSV(csvText, valueType);
    mergeHistoryByCode(parsed.byCode, key, file.name, parsed.count);
    const { matched, unmatched } = applyHistoryOverride(historyOverride);
    saveHistoryOverride();
    if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--green)">${fmt(parsed.count)}</span> rows · ${fmt(parsed.parentCount)} parents · <span style="color:var(--accent)">${file.name}</span>`;
    setHistStatus(`<strong>${label} loaded</strong> — <strong>${fmt(parsed.parentCount)}</strong> parents in this file · <strong style="color:var(--green)">${fmt(matched)}</strong> total matched to products`, 'ok');
    const skipNotes = [];
    if (parsed.skippedMonth > 0) skipNotes.push(`${fmt(parsed.skippedMonth)} row(s) had unrecognized month`);
    if (parsed.skippedBlank > 0) skipNotes.push(`${fmt(parsed.skippedBlank)} row(s) had blank parent_code`);
    if (unmatched > 0) skipNotes.push(`${fmt(unmatched)} products kept their original data (no match)`);
    document.getElementById('histUploadDetail').innerHTML = skipNotes.join(' · ') || `${label} rows applied cleanly`;
    document.getElementById('histReset').style.display = '';
    rerender();
    persistDatasetToMongo();
  }).catch(err => {
    if (subStatus) subStatus.innerHTML = `<strong>${label}</strong> — <span style="color:var(--red)">Error: ${err.message || 'failed to parse'}</span>`;
  })
  );
}

// Wire up
document.getElementById('histWindowLabel').textContent = `${D.months[0]} → ${D.months[D.months.length - 1]}`;
[{ kind: 'sales', type: 'sales' }, { kind: 'purch', type: 'purchases' }].forEach(({ kind, type }) => {
  const input = document.getElementById(kind + 'Upload');
  const trigger = document.getElementById(kind + 'UploadBtnTrigger');
  const zone = document.getElementById(kind + 'UploadZone');
  if (trigger && input) trigger.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleHistFileTyped(f, type);
    e.target.value = '';
  });
  if (zone) {
    ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleHistFileTyped(f, type);
    });
  }
});
document.getElementById('histReset').addEventListener('click', () => {
  if (!confirm('Clear uploaded history (both sales and purchases) and revert to embedded 24-month values?')) return;
  clearHistoryOverride();
});

// ===== Clear all data — wipe the catalog + all overrides to a blank dashboard =====
(function setupClearAllData() {
  const btn = document.getElementById('clearAllDataBtn');
  if (!btn) return;
  const status = document.getElementById('clearAllDataStatus');
  btn.addEventListener('click', async () => {
    if (!confirm('This permanently deletes the demo catalog AND all your uploaded data (master, stock, sales, purchases), leaving a completely blank dashboard. Continue?')) return;
    if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
    if (status) status.textContent = 'Clearing…';
    try {
      const res = await fetch('/api/data/reset', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // Remove local override keys too (native removeItem also mirrors the delete
      // to the server). UI prefs (theme, demand method) and AI settings are kept.
      ['inventoryMasterOverride', 'inventoryStockOverride', 'inventoryHistoryOverride',
       'inventoryReorderEdits', 'inventoryManualReorder', 'inventoryFolderZones',
       'inventoryParentLaunchDates', 'inventoryDiscontinued', 'inventoryPna',
       'inventoryReorderExcluded', 'inventoryActiveZoneBucket'
      ].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
      if (status) status.textContent = 'Cleared. Reloading…';
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      if (status) status.textContent = 'Error: ' + (err.message || 'failed to clear');
    }
  });
})();
// Restore previous history override from localStorage
try {
  const savedHist = localStorage.getItem(HIST_OVERRIDE_KEY);
  if (savedHist) {
    historyOverride = JSON.parse(savedHist);
    const { matched, unmatched } = applyHistoryOverride(historyOverride);
    setHistStatus(`<strong>History loaded</strong> from previous session (<strong style="color:var(--accent)">${historyOverride.fileName || 'CSV'}</strong>) — <strong>${fmt(historyOverride.count)}</strong> rows · <strong style="color:var(--green)">${fmt(matched)}</strong> matched`, 'ok');
    document.getElementById('histUploadDetail').textContent = `${fmt(unmatched)} products kept their original data (no match in CSV)`;
    document.getElementById('histReset').style.display = '';
  }
} catch (e) {}

// ===== Theme toggle (dark / light) =====
(function setupTheme() {
  const KEY = 'invDashTheme';
  let saved = 'dark';
  try { saved = localStorage.getItem(KEY) || 'dark'; } catch (e) { /* localStorage may be blocked */ }
  if (saved !== 'dark' && saved !== 'light') saved = 'dark';

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('#themeToggle span').forEach(s => {
      s.classList.toggle('active', s.dataset.themeVal === theme);
    });
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
  }

  apply(saved);

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      apply(current === 'dark' ? 'light' : 'dark');
    });
  }
})();

// ===== Precompute demand classifications + sales anomalies =====
// Called once at init and re-run after any history-CSV upload (since p.s changes).
precomputeDemandMeta();

// ===== Dummy zone assignment (for demo until a real Master CSV with zones is uploaded) =====
// Deterministic — same folder always lands in the same bucket — so the visual is stable.
// Distribution targets: ~12% unclassified, ~10% open, rest spread across Zones 1–6, with
// ~30% of zoned folders in 2 zones and ~10% in 3 zones (overlap is intentional so the
// "Also in" view actually has content to show).
// ===== Dummy vendor rename =====
// Replaces the embedded vendor list with the user-provided 6-name set so the dashboard
// displays a clean, recognisable vendor list. Real vendors will come via the Master
// Mapping Google Sheet's vendor_name column when uploaded.
function assignDummyVendorNames() {
  // Locked vendor list — exactly these 16 dealers, in this order, with these 4-letter codes.
  // Master Sheet uploads can only MAP to one of these (via fuzzy match) — they can never add new entries.
  const NEW_VENDORS = [
    { name: 'Vansh Laminate LLP',                     code: 'VNSH' },
    { name: 'Ajmer Industries LLP',                   code: 'AJMR' },
    { name: 'SWOT Marketing LLP',                     code: 'SWOT' },
    { name: 'Monal Laminate Pvt. Ltd.',               code: 'MNL'  },
    { name: 'Smart Step Decorative LLP',              code: 'SMRT' },
    { name: 'Fasten Laminate',                        code: 'FSTN' },
    { name: 'Shree Adhyashakti P. S. Photo Frame',    code: 'ADHY' },
    { name: 'Grow More',                              code: 'GRWM' },
    { name: 'Jagdhatri Papers',                       code: 'JGDH' },
    { name: 'Multiply Inc.',                          code: 'MULT' },
    { name: 'Shiv Shakti Laminates',                  code: 'SHSH' },
    { name: 'Panara Laminate Pvt. Ltd.',              code: 'PNRA' },
    { name: 'Vonee Panels Industries',                code: 'VONE' },
    { name: 'Royal Display',                          code: 'RYDP' },
    { name: 'Divya Sai Lam Pvt. Ltd.',                code: 'DVSL' },
    { name: 'Shree Shivam Decor',                     code: 'SSDC' },
  ];
  D.vendors = NEW_VENDORS.slice();

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < (s || '').length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  D.products.forEach(p => {
    const code = String(p.n || '');
    const h = hash('vendor:' + code);
    p.v = h % NEW_VENDORS.length;
  });

  // Reset the "original" snapshot so any future reset reverts to THIS locked-6 state,
  // not the embedded vendors (which no longer exist in D.vendors).
  if (typeof _originalVendorIdx === 'object' && _originalVendorIdx) {
    Object.keys(_originalVendorIdx).forEach(k => delete _originalVendorIdx[k]);
    D.products.forEach(p => { _originalVendorIdx[p.i] = p.v; });
  }

  console.info(`Dummy vendor rename: ${NEW_VENDORS.length} vendors applied (${NEW_VENDORS.map(v => v.name).join(', ')}).`);
}
// Vendor list is LOCKED to the 16 demo dealers — but ONLY in demo mode. When the persisted `D`
// was built from the user's real uploads (D.__real), keep the real vendors and instead rehydrate
// the in-memory realData store so further uploads rebuild correctly.
if (D && D.__real) {
  realDataMode = true;
  rehydrateRealDataFromD();
} else {
  assignDummyVendorNames();
}
// Re-populate the category / vendor / folder autocomplete datalists now that D.vendors has been
// replaced. (refreshFilterDatalists runs once during initial setup BEFORE this, so without this
// extra call the vendor dropdown would still show stale embedded vendor names like "VND011 — …".)
if (typeof refreshFilterDatalists === 'function') refreshFilterDatalists();

// ===== Dummy folder rename =====
// Parent and child folder names are kept SEPARATE — parents use one 4-name set, children another.
// Combined in D.folders so the existing folderIdx lookup keeps working (parents → 0..3, children → 4..7).
// Master Mapping Google Sheet upload still overrides these per parent / per child.
function assignDummyFolderNames() {
  const PARENT_FOLDERS = ['50 Shades', 'Native 36', 'ESS', 'Interlam'];
  const CHILD_FOLDERS  = ['Stone', 'Grey Wood', 'Hint', 'Aura'];
  D.folders = PARENT_FOLDERS.concat(CHILD_FOLDERS);

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < (s || '').length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  D.products.forEach(p => {
    const code = String(p.n || '');
    const h = hash(code);
    p.fl = h % PARENT_FOLDERS.length;                                  // 0..3 → parent folder
    if (Array.isArray(p.ch)) {
      p.ch.forEach((tup) => {
        // tup = [suffix, folderIdx, variantIdx]
        // Force every child to get an explicit folder from the child set (override inheritance)
        if (!Array.isArray(tup)) return;
        const ch = hash(code + '/' + (tup[0] || ''));
        tup[1] = PARENT_FOLDERS.length + (ch % CHILD_FOLDERS.length);  // 4..7 → child folder
      });
    }
  });

  // Clear stale folder→zone assignments (they were keyed by old folder names) so the dummy
  // zone pass below repopulates fresh entries for all 8 folder names.
  for (const k of Object.keys(folderZones)) delete folderZones[k];
  try { localStorage.removeItem('inventoryFolderZones'); } catch (e) {}
  console.info('Dummy folder rename: parents → 50 Shades / Native 36 / ESS / Interlam · children → Stone / Grey Wood / Hint / Aura.');
}
// Run before zones (which depend on folder names) and before category/sub-cat (which don't depend on folders but still after).
// Skip if the user has uploaded a real Master Sheet — their folder names take precedence.
if (!masterOverride) {
  assignDummyFolderNames();
}

function assignDummyZones() {
  if (folderZones && Object.keys(folderZones).length > 0) return false; // already populated
  if (!Array.isArray(D.folders) || D.folders.length === 0) return false;
  // Deterministic hash so the same folder name → same bucket
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  D.folders.forEach((name) => {
    if (!name) return;
    const h = hash(name);
    const r1 = h % 100;            // bucket roll: unc / open / zoned
    const r2 = (h >>> 7) % 100;    // overlap roll: 1 / 2 / 3 zones
    const r3 = (h >>> 13) % 6;     // primary zone (0..5)
    const r4 = (h >>> 19) % 6;     // secondary zone
    const r5 = (h >>> 23) % 6;     // tertiary zone
    if (r1 < 12) {
      // ~12%: unclassified — don't write an entry
      return;
    }
    if (r1 < 22) {
      // ~10%: open to all
      folderZones[name] = { zones: [], openToAll: true };
      return;
    }
    // Remaining ~78%: zoned. Decide how many zones it lives in.
    const zoneCount = r2 < 60 ? 1 : (r2 < 90 ? 2 : 3);  // 60% single / 30% double / 10% triple
    const zoneSet = new Set();
    zoneSet.add(r3 + 1);
    if (zoneCount >= 2) zoneSet.add((r4 + 1));
    if (zoneCount >= 3) zoneSet.add((r5 + 1));
    folderZones[name] = { zones: [...zoneSet].sort((a, b) => a - b), openToAll: false };
  });
  saveFolderZones();
  return true;
}
const dummyAssigned = assignDummyZones();
if (dummyAssigned) console.info('Dummy zones assigned to', Object.keys(folderZones).length, 'folders. Upload a Master CSV with a zone column to override.');

// ===== Dummy PNA assignment =====
// Pick a handful of products and flag them as Paper Not Available with various expected refill dates,
// so the dashboard can demonstrate the PNA status pill + filter without needing a real Stock upload.
function assignDummyPNA() {
  if (Object.keys(pnaData).length > 0) return false; // already populated
  if (!Array.isArray(D.products) || D.products.length === 0) return false;
  // Deterministic hash so the same SKU is always picked
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < (s || '').length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  // Pick roughly the first 8 products that hash to a specific bucket — gives a stable sample
  let assigned = 0;
  const targetCount = 8;
  const refillMonths = [1, 2, 3, 4, 5, 6, 2, 4];  // months ahead from anchor
  const anchor = new Date(2026, 4, 13);            // anchor = May 13, 2026 (dashboard report date)
  for (let i = 0; i < D.products.length && assigned < targetCount; i++) {
    const p = D.products[i];
    if (!p.n || p.n === '0') continue;
    const h = hash(p.n);
    if (h % 80 !== 0) continue;  // sparse picking — about 1 in 80 products
    // Compute a refill date 1..6 months out from anchor
    const monthsAhead = refillMonths[assigned % refillMonths.length];
    const d = new Date(anchor);
    d.setMonth(d.getMonth() + monthsAhead);
    d.setDate(1 + (h % 28));  // day 1..28
    pnaData[p.i] = { date: d.toISOString().slice(0, 10) };
    assigned++;
  }
  if (assigned > 0) {
    savePnaData();
    console.info(`Dummy PNA flags applied to ${assigned} products. Upload a Stock CSV with pna+refill_date columns to override.`);
    return true;
  }
  return false;
}
assignDummyPNA();

// ===== Dummy category + sub-category assignment (user's actual taxonomy) =====
// Replaces the embedded categories with the user's 8-category taxonomy so the dashboard
// reflects real product naming. Each product gets a deterministic (cat, sub_cat) pair
// hashed from its parent code, so the same SKU always lands in the same bucket.
// Upload via Master Sheet (`category` + `sub_category` columns) to override per-SKU.
function assignDummyCategoriesAndSubCategories() {
  // 8 categories + their sub-categories — every product is in exactly one of each
  const taxonomy = [
    { cat: 'Laminate',       subs: ['1mm', '.92'] },
    { cat: 'Polymer Sheets', subs: ['Acrylics', 'MCS', 'GAG', 'Thermolam'] },
    { cat: 'Louvers',        subs: ['Bamboo', 'Charcoal'] },
    { cat: 'Rolls',          subs: ['Natural Cane', 'Woven Vinyl'] },
    { cat: 'Liner',          subs: ['Standard'] },
    { cat: 'Folders',        subs: ['All Folders'] },
    { cat: 'Display',        subs: ['Panels', 'Other MS Display'] },
    { cat: 'Other',          subs: ['Others'] },
  ];

  // Replace D.cats and D.subCats with the taxonomy entries.
  // Keep arrays around but rebuild them so indexes line up cleanly.
  D.cats    = taxonomy.map(t => t.cat);
  D.subCats = [];
  // Build sub-category index: first all subs in order, indexed sequentially
  // and remember per-category which sub-indexes belong to which category.
  const subIdxByCat = {};
  taxonomy.forEach((t, catIdx) => {
    subIdxByCat[catIdx] = [];
    t.subs.forEach(s => {
      D.subCats.push(s);
      subIdxByCat[catIdx].push(D.subCats.length - 1);
    });
  });

  // Deterministic hash → category + sub-category per product code
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  D.products.forEach(p => {
    const code = String(p.n || '');
    if (!code) return;
    const h = hash(code);
    const catIdx = h % taxonomy.length;
    const subPool = subIdxByCat[catIdx];
    const subIdx = subPool[(h >>> 8) % subPool.length];
    p.c = catIdx;
    p.sc = subIdx;
  });
  console.info(`Dummy taxonomy applied: ${D.cats.length} categories, ${D.subCats.length} sub-categories across ${D.products.length} products.`);
}
// Run AFTER masterOverride is already applied (so user uploads still take precedence).
// If the master has set p.c/p.sc explicitly, we don't want to clobber it.
if (!masterOverride) {
  assignDummyCategoriesAndSubCategories();
}
// Final datalist refresh after ALL dummy assignment passes (vendor / folder / category / sub-cat)
// so the autocomplete suggestions match what the dashboard is actually using.
if (typeof refreshFilterDatalists === 'function') refreshFilterDatalists();

// ===== Google Sheets Sync =====
// Pre-created in user's Drive; user must publish-to-web to get a public CSV URL the
// dashboard can fetch (cross-origin to a static HTML file requires public CSV).
const GSYNC_URL_KEY = 'inventoryGsheetUrls';
const gsyncTargets = [
  { key: 'master', label: 'Master Mapping',   sheetId: '14hrdKKF4Jjq0txTXmQbJUJI0Oex2QOtBM1p80HQuaOw', tint: 'rgba(212,255,58,0.12)',  border: 'rgba(212,255,58,0.40)' },
  { key: 'stock',  label: 'Stock Levels',     sheetId: '1aCk1qusvja0myPw70k42VOs2MqaX6danylfuwMixf_w', tint: 'rgba(92,171,255,0.12)',  border: 'rgba(92,171,255,0.40)' },
  { key: 'sales',  label: 'Sales History',    sheetId: '1n7Y6IzBWZg0yxwquDGUDzO9FZskw9RONoP6Bp7WbVDI', tint: 'rgba(58,255,182,0.12)',  border: 'rgba(58,255,182,0.40)' },
  { key: 'purch',  label: 'Purchase History', sheetId: '1uKfGiwat-sUVm9F5VchF8bQLqYaKCNTBCLsZu5Onbh8', tint: 'rgba(255,92,58,0.12)',   border: 'rgba(255,92,58,0.40)' },
];
let gsyncUrls = {};
try { gsyncUrls = JSON.parse(localStorage.getItem(GSYNC_URL_KEY) || '{}') || {}; } catch (e) {}
// Pre-populate / refresh URLs to point at the canonical /export?format=csv endpoint for each sheetId.
// Bump GSYNC_URL_VERSION any time gsyncTargets sheetId values change so old localStorage entries are replaced.
const GSYNC_URL_VERSION = 'v2-2026-05-16';
const _savedVer = (() => { try { return localStorage.getItem('inventoryGsheetUrlsVer') || ''; } catch (e) { return ''; } })();
gsyncTargets.forEach(t => {
  const canonical = `https://docs.google.com/spreadsheets/d/${t.sheetId}/export?format=csv`;
  if (_savedVer !== GSYNC_URL_VERSION || !gsyncUrls[t.key] || !gsyncUrls[t.key].trim()) {
    gsyncUrls[t.key] = canonical;
  }
});
try {
  localStorage.setItem(GSYNC_URL_KEY, JSON.stringify(gsyncUrls));
  localStorage.setItem('inventoryGsheetUrlsVer', GSYNC_URL_VERSION);
} catch (e) {}

function gsyncRender() {
  const wrap = document.getElementById('gsyncList');
  if (!wrap) return;
  wrap.innerHTML = gsyncTargets.map(t => {
    const openUrl = `https://docs.google.com/spreadsheets/d/${t.sheetId}/edit`;
    const u = gsyncUrls[t.key] || '';
    return `<div style="background: var(--bg-2); border: 1px solid var(--line); border-left: 3px solid ${t.border.replace('0.40', '0.9')}; padding: 10px 14px; border-radius: 3px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <strong style="font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; color: var(--text);">${t.label.toUpperCase()}</strong>
        <a href="${openUrl}" target="_blank" rel="noopener" style="font-family: var(--mono); font-size: 10px; color: var(--accent); text-decoration: none; border: 1px solid rgba(212,255,58,0.4); padding: 3px 8px; border-radius: 2px; background: rgba(212,255,58,0.05);">↗ Open Google Sheet</a>
      </div>
      <input type="text" data-gsync-key="${t.key}" value="${u.replace(/"/g, '&quot;')}" placeholder="Paste a published-CSV URL or an /export?format=xlsx URL"
        style="width: 100%; background: var(--bg); border: 1px solid var(--line); padding: 7px 10px; color: var(--text); font-family: var(--mono); font-size: 11px; outline: none; box-sizing: border-box;">
      <div data-gsync-status="${t.key}" style="font-family: var(--mono); font-size: 10px; color: var(--text-3); margin-top: 5px; min-height: 12px;"></div>
    </div>`;
  }).join('');
}
gsyncRender();

// Wire inputs to keep gsyncUrls in memory as the user types
function gsyncWireInputs() {
  document.querySelectorAll('#gsyncList input[data-gsync-key]').forEach(inp => {
    inp.addEventListener('input', () => {
      gsyncUrls[inp.dataset.gsyncKey] = inp.value.trim();
    });
  });
}
gsyncWireInputs();

document.getElementById('gsyncSaveUrls').addEventListener('click', () => {
  try {
    localStorage.setItem(GSYNC_URL_KEY, JSON.stringify(gsyncUrls));
    document.getElementById('gsyncStatus').innerHTML = '<span style="color: var(--green)">URLs saved to local storage.</span>';
  } catch (e) {
    document.getElementById('gsyncStatus').innerHTML = '<span style="color: var(--red)">Could not save (localStorage unavailable).</span>';
  }
});

document.getElementById('gsyncResetUrls').addEventListener('click', () => {
  if (!confirm('Clear all saved Google Sheets URLs?')) return;
  gsyncUrls = {};
  try { localStorage.removeItem(GSYNC_URL_KEY); } catch (e) {}
  gsyncRender();
  gsyncWireInputs();
  document.getElementById('gsyncStatus').innerHTML = 'URLs cleared.';
});

// Convert various Google Sheets URL formats to a CSV-fetchable URL
function normalizeGsheetUrl(url) {
  if (!url) return null;
  const u = url.trim();
  if (!u) return null;
  // Already a published-CSV or export-xlsx URL — pass through unchanged
  if (/\/spreadsheets\/d\/e\/[^/]+\/pub.*csv/i.test(u)) return u;
  if (/output=csv/i.test(u) && /docs\.google\.com\/spreadsheets/.test(u)) return u;
  if (/format=xlsx/i.test(u) && /docs\.google\.com\/spreadsheets/.test(u)) return u;
  if (/\/export\?.*format=(csv|xlsx)/i.test(u)) return u;
  // /spreadsheets/d/{id}/edit?gid=N#gid=N → /export?format=csv&gid=N
  // Preserving the gid is critical — without it Google returns the default (first) tab,
  // which may be empty or have a different schema → 404 / wrong data.
  const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    let exportUrl = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
    const gidMatch = u.match(/[?&#]gid=(\d+)/);
    if (gidMatch) exportUrl += `&gid=${gidMatch[1]}`;
    return exportUrl;
  }
  return u; // last-ditch: pass through and let fetch fail clearly
}

async function gsyncFetchOne(key) {
  const target = gsyncTargets.find(t => t.key === key);
  const rawUrl = (gsyncUrls[key] || '').trim();
  const statusEl = document.querySelector(`[data-gsync-status="${key}"]`);
  if (!rawUrl) {
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--text-3);">No URL set — skipped</span>';
    return { key, skipped: true };
  }
  const fetchUrl = normalizeGsheetUrl(rawUrl);
  if (statusEl) statusEl.innerHTML = '<span style="color: var(--blue);">Fetching…</span>';
  try {
    const res = await fetch('/api/sheets/proxy?url=' + encodeURIComponent(fetchUrl), { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Always fetch as binary so we can detect xlsx vs CSV by the file signature
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength < 4) throw new Error('Empty response');
    const u8 = new Uint8Array(buf);
    let text;
    const looksXlsx = /format=xlsx/i.test(fetchUrl) || /\.xlsx(?:[?#]|$)/i.test(fetchUrl) || (u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04);
    if (looksXlsx) {
      if (typeof XLSX === 'undefined') throw new Error('Excel parser not loaded — retry, or use CSV publish URL');
      const wb = XLSX.read(u8, { type: 'array' });
      if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('Workbook has no sheets');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      text = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    } else {
      text = new TextDecoder('utf-8').decode(u8);
    }
    if (!text || text.length < 4) throw new Error('Empty parsed content');
    // Route to the right parser/applier based on key
    if (key === 'master') {
      const result = parseMasterCSV(text);
      if (!result || result.error) throw new Error(result ? result.error : 'parse failed');
      applyMasterOverride(result.map, target.label + ' (Google Sheets)', result.zonesByFolder);
    } else if (key === 'stock') {
      const parsed = parseStockCSV(text);
      stockOverride = { byCode: parsed.byCode, count: parsed.count, uploadedAt: new Date().toISOString(), fileName: target.label + ' (Google Sheets)' };
      applyStockOverride(stockOverride);
      saveStockOverride();
      setStockStatus(`<strong>Stock synced</strong> from Google Sheets — <strong>${fmt(parsed.count)}</strong> rows`, 'ok');
      document.getElementById('stockReset').style.display = '';
      rerender();
    } else if (key === 'sales' || key === 'purch') {
      // For separate sales/purchase tabs, hint to the parser which value column to fill.
      // This is essential for wide-format sheets (months as columns) since the headers themselves
      // don't say "sales" vs "purchases" — the hint comes from the sync target.
      const valueType = key === 'sales' ? 'sales' : 'purchases';
      const parsed = parseHistoryCSV(text, valueType);
      // Merge into existing historyOverride so two sheets together = full history
      if (!historyOverride) historyOverride = { byCode: {}, count: 0, parentCount: 0, fileName: 'Google Sheets sync' };
      Object.keys(parsed.byCode).forEach(code => {
        if (!historyOverride.byCode[code]) historyOverride.byCode[code] = { s: new Array(24).fill(null), p: new Array(24).fill(null) };
        const src = parsed.byCode[code];
        for (let i = 0; i < 24; i++) {
          if (src.s[i] != null) historyOverride.byCode[code].s[i] = src.s[i];
          if (src.p[i] != null) historyOverride.byCode[code].p[i] = src.p[i];
        }
      });
      historyOverride.count = (historyOverride.count || 0) + parsed.count;
      historyOverride.parentCount = Object.keys(historyOverride.byCode).length;
      historyOverride.uploadedAt = new Date().toISOString();
      historyOverride.fileName = 'Google Sheets sync (sales + purchases)';
      applyHistoryOverride(historyOverride);
      saveHistoryOverride();
      setHistStatus(`<strong>History synced</strong> from Google Sheets — <strong>${fmt(historyOverride.count)}</strong> total rows across ${fmt(historyOverride.parentCount)} parents`, 'ok');
      document.getElementById('histReset').style.display = '';
      rerender();
    }
    if (statusEl) statusEl.innerHTML = '<span style="color: var(--green);">✓ Synced</span>';
    return { key, ok: true };
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--red);">${_gsyncErrorMessage(err)}</span>`;
    return { key, error: err };
  }
}

// Auto-sync toggle — when checked, the dashboard runs Sync All every time the page loads
const GSYNC_AUTO_KEY = 'inventoryGsyncAutoSync';
let gsyncAutoSync = false;
try { gsyncAutoSync = localStorage.getItem(GSYNC_AUTO_KEY) === '1'; } catch (e) {}
{
  const tog = document.getElementById('gsyncAutoToggle');
  if (tog) {
    tog.checked = gsyncAutoSync;
    tog.addEventListener('change', () => {
      gsyncAutoSync = tog.checked;
      try { localStorage.setItem(GSYNC_AUTO_KEY, gsyncAutoSync ? '1' : '0'); } catch (e) {}
    });
  }
}

async function gsyncRunAll() {
  const status = document.getElementById('gsyncStatus');
  if (status) status.innerHTML = '<span style="color: var(--blue);">Syncing all sheets…</span>';
  try { localStorage.setItem(GSYNC_URL_KEY, JSON.stringify(gsyncUrls)); } catch (e) {}
  const order = ['master', 'stock', 'sales', 'purch'];
  let ok = 0, errored = 0, skipped = 0;
  for (const key of order) {
    const r = await gsyncFetchOne(key);
    if (r.ok) ok++;
    else if (r.error) errored++;
    else if (r.skipped) skipped++;
  }
  const parts = [];
  if (ok > 0) parts.push(`<span style="color: var(--green);">${ok} synced</span>`);
  if (errored > 0) parts.push(`<span style="color: var(--red);">${errored} failed</span>`);
  if (skipped > 0) parts.push(`<span style="color: var(--text-3);">${skipped} skipped (no URL)</span>`);
  if (status) status.innerHTML = parts.join(' · ') || 'Nothing to sync.';
  return { ok, errored, skipped };
}

// Auto-run on load if the toggle is on and there are URLs saved
if (gsyncAutoSync && Object.values(gsyncUrls).some(u => u && u.trim())) {
  setTimeout(() => { gsyncRunAll(); }, 800);
}

document.getElementById('gsyncAllBtn').addEventListener('click', async () => {
  const status = document.getElementById('gsyncStatus');
  status.innerHTML = '<span style="color: var(--blue);">Syncing all sheets…</span>';
  // Save URLs before fetching, just in case
  try { localStorage.setItem(GSYNC_URL_KEY, JSON.stringify(gsyncUrls)); } catch (e) {}
  // Sequential — order matters: master first (sets zones/vendors), then stock, then sales/purchases
  const order = ['master', 'stock', 'sales', 'purch'];
  let ok = 0, errored = 0, skipped = 0;
  for (const key of order) {
    const r = await gsyncFetchOne(key);
    if (r.ok) ok++;
    else if (r.error) errored++;
    else if (r.skipped) skipped++;
  }
  const parts = [];
  if (ok > 0) parts.push(`<span style="color: var(--green);">${ok} synced</span>`);
  if (errored > 0) parts.push(`<span style="color: var(--red);">${errored} failed</span>`);
  if (skipped > 0) parts.push(`<span style="color: var(--text-3);">${skipped} skipped (no URL)</span>`);
  status.innerHTML = parts.join(' · ') || 'Nothing to sync.';
});

// ===== Zone Browser =====
// Builds per-folder stats from D.products (sku count, parent count) and groups
// by zone bucket. 8 buckets total: Zone 1..6, Open, Unclassified.
let activeZoneBucket = 'z1';
try {
  const saved = localStorage.getItem('inventoryActiveZoneBucket');
  if (saved) activeZoneBucket = saved;
} catch (e) {}

function _allFolderStats() {
  // Returns Map<folderName, { sku: count of child SKUs in folder, parents: count of parents whose default folder = folder }>
  // Child SKUs are aggregated by walking products and their children. Parent count uses p.fl (parent's folder index).
  const stats = {};
  D.products.forEach(p => {
    const parentFolder = D.folders[p.fl];
    if (parentFolder) {
      if (!stats[parentFolder]) stats[parentFolder] = { sku: 0, parents: 0 };
      stats[parentFolder].parents++;
    }
    const children = (typeof getProductChildren === 'function') ? getProductChildren(p) : (p.ch || []).map(arr => ({ code: arr[0], folder: arr[1], variant: arr[2] }));
    children.forEach(ch => {
      const f = ch.folder || parentFolder;
      if (!f) return;
      if (!stats[f]) stats[f] = { sku: 0, parents: 0 };
      stats[f].sku++;
    });
  });
  return stats;
}

function _bucketFoldersFor(bucketKey, allFolders) {
  // Returns list of folder names that belong to this bucket
  if (bucketKey === 'open') {
    return allFolders.filter(f => getFolderZones(f).openToAll);
  }
  if (bucketKey === 'unc') {
    return allFolders.filter(f => getFolderZones(f).unclassified);
  }
  const n = parseInt(bucketKey.slice(1));  // 'z1' → 1
  return allFolders.filter(f => {
    const z = getFolderZones(f);
    if (z.unclassified) return false;
    if (z.openToAll) return true;  // Open folders appear in every zone tab too
    return z.zones.includes(n);
  });
}

function renderZoneBrowser() {
  const tabsEl = document.getElementById('zoneTabs');
  const contentEl = document.getElementById('zoneContent');
  const statusEl = document.getElementById('zoneStatusLine');
  if (!tabsEl || !contentEl) return;

  const stats = _allFolderStats();
  const allFolders = Object.keys(stats).sort();
  const buckets = [
    { key: 'z1', label: 'Zone 1' }, { key: 'z2', label: 'Zone 2' }, { key: 'z3', label: 'Zone 3' },
    { key: 'z4', label: 'Zone 4' }, { key: 'z5', label: 'Zone 5' }, { key: 'z6', label: 'Zone 6' },
    { key: 'open', label: 'Open', extraClass: 'zone-open' },
    { key: 'unc',  label: 'Unclassified', extraClass: 'zone-unc' },
  ];

  // Render tabs with counts
  tabsEl.innerHTML = buckets.map(b => {
    const folders = _bucketFoldersFor(b.key, allFolders);
    const active = b.key === activeZoneBucket ? 'active' : '';
    const cls = `zone-tab ${b.extraClass || ''} ${active}`.trim();
    return `<button type="button" class="${cls}" data-zone-bucket="${b.key}">
      <span class="zt-label">${b.label}</span>
      <span class="zt-count">${fmt(folders.length)}</span>
    </button>`;
  }).join('');
  tabsEl.querySelectorAll('button[data-zone-bucket]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeZoneBucket = btn.dataset.zoneBucket;
      try { localStorage.setItem('inventoryActiveZoneBucket', activeZoneBucket); } catch (e) {}
      renderZoneBrowser();
    });
  });

  // Render the active bucket's folder list
  const activeBucket = buckets.find(b => b.key === activeZoneBucket) || buckets[0];
  const folders = _bucketFoldersFor(activeBucket.key, allFolders);
  const totalSkus = folders.reduce((acc, f) => acc + (stats[f] ? stats[f].sku : 0), 0);
  const totalParents = folders.reduce((acc, f) => acc + (stats[f] ? stats[f].parents : 0), 0);

  let intro = '';
  if (activeBucket.key === 'open') {
    intro = `<strong>${fmt(folders.length)}</strong> open folder${folders.length !== 1 ? 's' : ''} (in every zone) · <strong>${fmt(totalSkus)}</strong> child SKUs · <strong>${fmt(totalParents)}</strong> parents`;
  } else if (activeBucket.key === 'unc') {
    intro = `<strong>${fmt(folders.length)}</strong> unclassified folder${folders.length !== 1 ? 's' : ''} · <strong>${fmt(totalSkus)}</strong> child SKUs · <strong>${fmt(totalParents)}</strong> parents — assign zones in the Master CSV (Section 07)`;
  } else {
    const openCount = folders.filter(f => getFolderZones(f).openToAll).length;
    intro = `<strong>${fmt(folders.length)}</strong> folders in ${activeBucket.label} (including ${fmt(openCount)} open) · <strong>${fmt(totalSkus)}</strong> child SKUs · <strong>${fmt(totalParents)}</strong> parents`;
  }
  statusEl.innerHTML = intro;

  if (folders.length === 0) {
    contentEl.innerHTML = `<div class="zone-empty">No folders in this bucket yet. Upload a Master CSV with a <strong>zone</strong> column in Section 07 to populate it.</div>`;
    return;
  }

  // Sort folders by sku count desc, then name
  folders.sort((a, b) => {
    const sa = (stats[a] && stats[a].sku) || 0;
    const sb = (stats[b] && stats[b].sku) || 0;
    if (sb !== sa) return sb - sa;
    return a.localeCompare(b);
  });

  contentEl.innerHTML = `<div class="zone-grid">` + folders.map(f => {
    const z = getFolderZones(f);
    const st = stats[f] || { sku: 0, parents: 0 };
    let otherLine = '';
    if (z.openToAll) {
      otherLine = `<strong>Also in:</strong> all 6 zones (open)`;
    } else if (z.unclassified) {
      otherLine = `<strong>No zone assigned yet</strong>`;
    } else {
      // List other zones (those not matching the active zone, if a numbered zone is active)
      if (activeBucket.key.startsWith('z')) {
        const n = parseInt(activeBucket.key.slice(1));
        const others = z.zones.filter(x => x !== n);
        if (others.length === 0) {
          otherLine = `<strong>Only in Zone ${n}</strong>`;
        } else {
          otherLine = `<strong>Also in:</strong> ${others.map(x => `Z${x}`).join(', ')}`;
        }
      } else {
        otherLine = `<strong>In zone${z.zones.length > 1 ? 's' : ''}:</strong> ${z.zones.map(x => `Z${x}`).join(', ')}`;
      }
    }
    const cardClass = z.openToAll ? 'open' : (z.unclassified ? 'unc' : '');
    return `<div class="zone-folder-card ${cardClass}">
      <div class="zfc-name">${f}${zoneBadgeHtml(f)}</div>
      <div class="zfc-counts"><strong>${fmt(st.sku)}</strong> child SKUs · <strong>${fmt(st.parents)}</strong> parents</div>
      <div class="zfc-other">${otherLine}</div>
    </div>`;
  }).join('') + `</div>`;
}

// Initial render of the zone browser and re-render whenever master mapping changes
renderZoneBrowser();

// ===== Initial render =====
renderVendors();
rerender();
