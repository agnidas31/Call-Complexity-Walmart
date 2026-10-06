// dashboard.js — Call Complexity Scorecard Live Dashboard

const REFRESH_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Escape a value for safe insertion into HTML.
 * Prevents XSS when server-supplied strings are rendered via innerHTML.
 */
function _esc(val) {
  return String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const C = {
  blue: '#0053e2', darkblue: '#001e5a', spark: '#ffc220',
  green: '#2a8703', yellow: '#d97706', red: '#ea1100',
};

// 6 KPIs ordered highest → lowest weight (removed: hold_time, wait_time, channel_mix)
const KPI_CONFIG = [
  { key: 'case_category_score', label: 'Contact Reason',    weight: 3.5, color: '#0053e2',
    s1: 'Rank 41+ (low AHT)',  s2: 'Rank 21–40 (mid AHT)',  s3: 'Top 20 (highest AHT)' },
  { key: 'workflow_score',      label: 'Workflow Count',    weight: 2.0, color: '#ff5722',
    s1: '≤ 2 workflows',  s2: '3–10 workflows',  s3: '> 10 workflows' },
  { key: 'talk_pct_score',      label: 'Customer Talk %',   weight: 2.0, color: '#ff9800',
    s1: '< 20%',          s2: '21–45%',     s3: '> 45%' },
  { key: 'repeat_caller_score', label: 'Repeat Caller',     weight: 1.5, color: '#1a73e8',
    s1: 'First call',     s2: '2nd call',        s3: '3rd+ call' },
  { key: 'transfer_score',      label: 'Transfer Count',    weight: 0.5, color: '#4285f4',
    s1: 'No transfer',    s2: '1 transfer',      s3: '2+ transfers' },
  { key: 'gen_score',           label: 'Gen / Non-Gen',     weight: 0.5, color: '#34a853',
    s1: 'Genuine + non-Top20',  s2: 'Genuine+Top20 / Non-gen+non-Top20',  s3: 'Non-genuine + Top20' },
];
// composite auto-computed from config, range [10,30]
const MIN_COMPOSITE = KPI_CONFIG.reduce((s, k) => s + 1 * k.weight, 0); // 10.0
const MAX_COMPOSITE = KPI_CONFIG.reduce((s, k) => s + 3 * k.weight, 0); // 30.0
let _charts = {};
let _refreshTimer = null;
let _drillTier = '';        // '' | 'LOW' | 'MEDIUM' | 'HIGH'
let _drillOffset = 0;       // current pagination offset

// ── Chart helpers ────────────────────────────────────────────────────────────
function _destroy(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

// ── Filter helpers ──────────────────────────────────────────────────────────
function _getFilters() {
  const p = new URLSearchParams();
  [['fSublob','sublob'],['fDepartment','department'],['fChannel','channel'],
   ['fQueue','queue']].forEach(([id, key]) => {
    const v = document.getElementById(id)?.value || '';
    if (v) p.append(key, v);
  });
  // Handle multi-select month filter
  const myEl = document.getElementById('fMonthYear');
  if (myEl) {
    const selected = Array.from(myEl.selectedOptions)
      .map(opt => opt.value)
      .filter(v => v); // exclude empty value
    selected.forEach(v => p.append('month_year', v));
  }
  return p;
}

function _getSelectedMonths() {
  const myEl = document.getElementById('fMonthYear');
  if (!myEl) return [];
  return Array.from(myEl.selectedOptions)
    .map(opt => opt.value)
    .filter(v => v);
}

function _updateDateRange() {
  const selected = _getSelectedMonths();
  const rangeEl = document.getElementById('dateRange');
  if (!rangeEl) return;
  
  const prefix = 'Date range for current selection: ';
  
  if (selected.length === 0) {
    rangeEl.textContent = prefix + 'No date selected';
  } else if (selected.length === 1) {
    const [yr, mo] = selected[0].split('-');
    const label = new Date(+yr, +mo - 1, 1)
      .toLocaleString('en-US', { month: 'long', year: 'numeric' });
    rangeEl.textContent = prefix + label;
  } else {
    // Multiple months: show range
    const sorted = selected.sort();
    const [minYr, minMo] = sorted[0].split('-');
    const [maxYr, maxMo] = sorted[sorted.length - 1].split('-');
    const minLabel = new Date(+minYr, +minMo - 1, 1)
      .toLocaleString('en-US', { month: 'short', year: 'numeric' });
    const maxLabel = new Date(+maxYr, +maxMo - 1, 1)
      .toLocaleString('en-US', { month: 'short', year: 'numeric' });
    rangeEl.textContent = prefix + `${minLabel} - ${maxLabel}`;
  }
}

function resetFilters() {
  ['fSublob','fDepartment','fChannel','fQueue'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Reset month filter to select the last COMPLETED month (index 1 = Apr 2026)
  const myEl = document.getElementById('fMonthYear');
  if (myEl && myEl.options.length > 1) {
    const lastCompletedMonthIndex = 1;
    Array.from(myEl.options).forEach((opt, idx) => {
      opt.selected = (idx === lastCompletedMonthIndex);
    });
  }
  _drillOffset = 0;
  // Reload metadata so cascading dropdowns snap back to their full option
  // lists (constrained only by the newly-reset month selection).
  loadMetadata().then(() => {
    refreshAll(false);
    _triggerContactRefresh();
  });
}

function selectAllMonths() {
  const myEl = document.getElementById('fMonthYear');
  if (myEl) {
    Array.from(myEl.options).forEach(opt => {
      opt.selected = true;
    });
    // Don't auto-refresh - user needs to click Apply button
  }
}

async function applyMonthFilter() {
  // Reload metadata with selected months to update other filters
  await loadMetadata();
  _updateDateRange();
  _drillOffset = 0;
  refreshAll(false);
  _triggerContactRefresh();
}

// ── Drilldown tier filter ──────────────────────────────────────────────────────
function setDrillTier(tier, btn) {
  _drillTier = tier;
  _drillOffset = 0;  // reset to first page on tier change
  document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('tier-btn-active'));
  btn.classList.add('tier-btn-active');
  const s = document.getElementById('contactSearch');
  if (s) s.value = '';
  _triggerContactRefresh();
}

// Pagination: called by Prev/Next buttons in fragment.
function setContactPage(newOffset) {
  _drillOffset = Math.max(0, newOffset);
  _triggerContactRefresh();
}

// Build the contact request URL from all active filters
function _buildContactUrl() {
  const p = new URLSearchParams();
  [['fSublob','sublob'],['fDepartment','department'],['fChannel','channel'],
   ['fQueue','queue']].forEach(([id, key]) => {
    const v = document.getElementById(id)?.value || '';
    if (v) p.set(key, v);
  });
  // Handle multi-select month filter
  const myEl = document.getElementById('fMonthYear');
  if (myEl) {
    const selected = Array.from(myEl.selectedOptions)
      .map(opt => opt.value)
      .filter(v => v); // exclude empty value
    selected.forEach(v => p.append('month_year', v));
  }
  if (_drillTier) p.set('bucket', _drillTier);
  if (_drillOffset > 0) p.set('offset', _drillOffset);
  return `/hx/contacts?${p.toString()}`;
}

// Build the contacts panel directly from the embedded SAMPLE_CONTACTS array
// (see portable-data.js) instead of fetching a server-rendered fragment from
// /hx/contacts. Produces the exact same DOM structure the real fragment
// would, so selectContact() and the cache-hydration path below work unchanged.
async function _triggerContactRefresh() {
  const panel = document.getElementById('contactsPanel');
  if (!panel) return;
  try {
    const filters = {
      sublob: document.getElementById('fSublob')?.value || '',
      department: document.getElementById('fDepartment')?.value || '',
      channel: document.getElementById('fChannel')?.value || '',
      queue: document.getElementById('fQueue')?.value || '',
      month_year: _getSelectedMonths(),
      bucket: _drillTier || '',
    };
    const { html, contactsForCache } = buildContactsFragmentHTML(SAMPLE_CONTACTS, filters, _drillOffset);
    panel.innerHTML = html;
    window._contactCache = new Map(contactsForCache.map(c => [String(c.contact_id), c]));
  } catch (err) {
    console.error('Contact load error:', err);
    panel.innerHTML = '<div class="text-center py-12 text-red-500 text-sm px-4">Failed to load contacts.</div>';
  }
}

// Parse the embedded JSON blob and hydrate the in-memory contact cache
function _hydrateContactCache(panel) {
  const blob = panel.querySelector('#_contactCacheData');
  if (!blob) return;
  try {
    const contacts = JSON.parse(blob.textContent);
    window._contactCache = new Map(contacts.map(c => [String(c.contact_id), c]));
  } catch (e) {
    console.error('Contact cache parse error:', e);
  }
}

// Client-side search filter.
function filterContactList(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#contactsPanel .contact-item').forEach(el => {
    const id = (el.dataset.id || '').toLowerCase();
    el.style.display = (!q || id.includes(q)) ? '' : 'none';
  });
}

// ── Metadata / filter population ────────────────────────────────────────────
// The four dropdowns cascade off each other server-side: each option list is
// narrowed by every OTHER active filter. That means loadMetadata() must send
// the CURRENT selection of every dropdown on every call, and re-run whenever
// any of them changes.
function _currentFilterState() {
  const p = new URLSearchParams();
  [['fSublob','sublob'],['fDepartment','department'],['fChannel','channel'],
   ['fQueue','queue']].forEach(([id, key]) => {
    const v = document.getElementById(id)?.value || '';
    if (v) p.append(key, v);
  });
  _getSelectedMonths().forEach(m => p.append('month_year', m));
  return p;
}

async function loadMetadata() {
  // PORTABLE DEMO: reads from the embedded SAMPLE_CONTACTS array via
  // aggregateMetadata() (see portable-data.js) instead of fetching
  // /api/metadata from a live BigQuery-backed backend.
  const params = _currentFilterState();
  let meta;
  try {
    const filters = {
      sublob: params.get('sublob') || '',
      department: params.get('department') || '',
      channel: params.get('channel') || '',
      queue: params.get('queue') || '',
      month_year: params.getAll('month_year'),
    };
    meta = aggregateMetadata(SAMPLE_CONTACTS, filters);
  } catch (err) {
    console.error('loadMetadata failed:', err);
    const stamp = document.getElementById('lastUpdated');
    if (stamp) stamp.textContent = 'Warning: Filter options could not be refreshed - showing last-known list';
    return false;
  }

  const populate = (id, items, label) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const currentValue = sel.value; // Preserve selection if still valid
    sel.innerHTML = `<option value="">${label}</option>`;
    (items || []).forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === currentValue) o.selected = true;
      sel.appendChild(o);
    });
  };
  populate('fSublob',    meta.sublobs,     'All Sub-LOBs');
  populate('fDepartment',meta.departments, 'All Depts');
  populate('fChannel',   meta.channels,    'All Channels');
  populate('fQueue',     meta.queues,      'All Queues');
  
  // Month-Year: format 'YYYY-MM' → display as 'Mon YYYY', preserve or default to last completed month
  const myEl = document.getElementById('fMonthYear');
  if (myEl && meta.month_years && meta.month_years.length > 0) {
    // Preserve current selection
    const currentSelection = Array.from(myEl.selectedOptions).map(o => o.value);
    const hasSelection = currentSelection.length > 0;
    
    myEl.innerHTML = '';
    // Months are sorted newest-to-oldest, so index 1 is the last COMPLETED month
    // (index 0 would be current incomplete month like May 2026)
    const lastCompletedMonthIndex = 1;
    (meta.month_years || []).forEach((v, idx) => {
      const [yr, mo] = v.split('-');
      const label = new Date(+yr, +mo - 1, 1)
        .toLocaleString('en-US', { month: 'short', year: 'numeric' });
      const o = document.createElement('option');
      o.value = v; 
      o.textContent = label;
      // Preserve existing selection or default to last completed month
      if (hasSelection) {
        o.selected = currentSelection.includes(v);
      } else {
        o.selected = (idx === lastCompletedMonthIndex);
      }
      myEl.appendChild(o);
    });
  }
  
  // Update date range display
  _updateDateRange();
  return true;
}

// ── KPI rendering ────────────────────────────────────────────────────────────────
function renderKPIs(kpis) {
  const s = document.getElementById('kpiSection');
  if (!s) return;
  const fmt = n => (n || 0).toLocaleString();
  
  // Calculate percentages for complexity tiers
  const total = kpis.total_contacts || 1;
  const lowPct = ((kpis.low_count || 0) / total * 100).toFixed(1);
  const medPct = ((kpis.med_count || 0) / total * 100).toFixed(1);
  const highPct = ((kpis.high_count || 0) / total * 100).toFixed(1);
  
  // Get actual average scores by bucket from score_components
  const scoreComponents = window._lastScoreComponents || [];
  // Case-insensitive bucket matching (DB returns LOW/MEDIUM/HIGH or Low/Medium/High)
  const lowComp = scoreComponents.find(c => c.bucket && c.bucket.toUpperCase() === 'LOW');
  const medComp = scoreComponents.find(c => c.bucket && c.bucket.toUpperCase() === 'MEDIUM');
  const highComp = scoreComponents.find(c => c.bucket && c.bucket.toUpperCase() === 'HIGH');
  
  const avgLowScore = (lowComp?.avg_score !== null && lowComp?.avg_score !== undefined) ? lowComp.avg_score.toFixed(1) : '—';
  const avgMedScore = (medComp?.avg_score !== null && medComp?.avg_score !== undefined) ? medComp.avg_score.toFixed(1) : '—';
  const avgHighScore = (highComp?.avg_score !== null && highComp?.avg_score !== undefined) ? highComp.avg_score.toFixed(1) : '—';
  
  // Build with DOM APIs — textContent prevents server values from reaching the HTML parser.
  const cards = [
    ['Total Contacts',         fmt(kpis.total_contacts),                  'text-[#001e5a]',  'text-gray-500', null],
    ['Avg Low Complexity Score',     avgLowScore,                               'text-green-700',  'text-green-700', null],
    ['Avg Medium Complexity Score',  avgMedScore,                               'text-yellow-600', 'text-yellow-600', null],
    ['Avg High Complexity Score',    avgHighScore,                              'text-red-600',    'text-red-600', null],
    ['Low Complexity',         fmt(kpis.low_count),                        'text-green-700',  'text-green-700', lowPct + '%'],
    ['Medium Complexity',      fmt(kpis.med_count),                        'text-yellow-600', 'text-yellow-600', medPct + '%'],
    ['High Complexity',        fmt(kpis.high_count),                       'text-red-600',    'text-red-600', highPct + '%'],
    ['Avg Handle Time',        (kpis.avg_aht_mins || 0).toFixed(1) + 'm', 'text-[#001e5a]',  'text-gray-500', null],
  ].map(([label, val, valCls, lblCls, pct]) => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    const lDiv = document.createElement('div');
    lDiv.className = `text-xs ${lblCls} uppercase tracking-wider`;
    lDiv.textContent = label;
    const vDiv = document.createElement('div');
    vDiv.className = `text-2xl font-bold ${valCls} mt-1`;
    vDiv.textContent = val;
    card.append(lDiv, vDiv);
    
    // Add percentage for complexity tiers
    if (pct) {
      const pctDiv = document.createElement('div');
      pctDiv.className = `text-xs ${lblCls} mt-1 font-semibold opacity-75`;
      pctDiv.textContent = pct + ' of total';
      card.appendChild(pctDiv);
    }
    
    return card;
  });
  s.replaceChildren(...cards);
}

// ── Insights rendering ─────────────────────────────────────────────────────────
/**
 * Build one insight row using DOM APIs.
 * `segments` is an array of {text, bold} objects — server values are set via
 * textContent so they never reach the HTML parser regardless of content.
 */
function _insightRow(segments) {
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start gap-2';
  const bullet = document.createElement('span');
  bullet.className = 'mt-0.5 text-[#ffc220] font-bold';
  bullet.textContent = '•';
  const content = document.createElement('span');
  for (const seg of segments) {
    if (seg.bold) {
      const strong = document.createElement('strong');
      strong.textContent = String(seg.text ?? '');
      content.appendChild(strong);
    } else {
      content.appendChild(document.createTextNode(String(seg.text ?? '')));
    }
  }
  wrapper.append(bullet, content);
  return wrapper;
}

function renderInsights(data) {
  const el = document.getElementById('insightsContent');
  if (!el) return;
  const k = data.kpis || {};
  const total = k.total_contacts || 1;
  const highPct = ((k.high_count || 0) / total * 100).toFixed(2);
  const medPct  = ((k.med_count || 0)  / total * 100).toFixed(2);
  const lowPct  = (100 - parseFloat(medPct) - parseFloat(highPct)).toFixed(1);
  const topQ  = (data.by_queue   || [])[0];
  const topCh = (data.by_channel || [])[0];

  const rows = [
    _insightRow([
      {text: '📊 '}, {bold: true, text: total.toLocaleString()},
      {text: ' contacts analyzed. '}, {bold: true, text: lowPct + '%'},
      {text: ' are Low complexity — a healthy distribution indicating efficient routing.'},
    ]),
    _insightRow([
      {text: '⚠️ High complexity contacts: '}, {bold: true, text: highPct + '%'},
      {text: ' — priority cases requiring senior agent involvement.'},
    ]),
    _insightRow([
      {text: '📈 Medium complexity: '}, {bold: true, text: medPct + '%'},
      {text: ' of volume — monitor growth in this tier for workforce planning signals.'},
    ]),
    ...(topQ ? [_insightRow([
      {text: '🏆 Queue '}, {bold: true, text: topQ.queue_name},
      {text: ' leads with avg complexity '}, {bold: true, text: topQ.avg_score},
      {text: ' — flag for coaching and routing optimization.'},
    ])] : []),
    ...(topCh ? [_insightRow([
      {text: '📞 '}, {bold: true, text: topCh.channel},
      {text: ' channel has highest avg complexity ('}, {bold: true, text: topCh.avg_score},
      {text: ') — consider channel-specific agent skilling programs.'},
    ])] : []),
    _insightRow([
      {text: '⏱️ Avg handle time: '}, {bold: true, text: (k.avg_aht_mins || 0).toFixed(1) + ' min'},
      {text: ' — High-complexity calls drive AHT up; self-serve deflection can reclaim capacity.'},
    ]),
  ];
  el.replaceChildren(...rows);
}

// ── Chart renderers ──────────────────────────────────────────────────────────────
function renderPie(kpis) {
  _destroy('chartPie');
  const ctx = document.getElementById('chartPie');
  if (!ctx) return;
  const data = [
    { label: 'Low',    val: kpis.low_count  || 0, color: C.green },
    { label: 'Medium', val: kpis.med_count  || 0, color: C.yellow },
    { label: 'High',   val: kpis.high_count || 0, color: C.red },
  ].filter(d => d.val > 0);
  _charts['chartPie'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{ data: data.map(d => d.val), backgroundColor: data.map(d => d.color), borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.raw.toLocaleString()}` } }
      }
    }
  });
}

function renderHist(hist) {
  _destroy('chartHist');
  const ctx = document.getElementById('chartHist');
  if (!ctx || !hist.length) return;
  _charts['chartHist'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hist.map(x => `${x.bin_start}–${x.bin_start + 5}`),
      datasets: [{
        label: 'Contacts',
        data: hist.map(x => x.contacts),
        backgroundColor: hist.map(x => x.bin_start <= 25 ? C.green + 'cc' : x.bin_start <= 40 ? C.yellow + 'cc' : C.red + 'cc'),
        borderRadius: 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { font: { size: 10 } } },
        x: { ticks: { font: { size: 10 }, maxRotation: 45 } }
      }
    }
  });
}

function renderChannel(byChannel) {
  console.log('renderChannel called with:', byChannel);
  _destroy('chartChannel');
  const ctx = document.getElementById('chartChannel');
  if (!ctx) {
    console.log('renderChannel ABORT: no canvas');
    return;
  }
  
  const container = ctx.parentElement;
  
  if (!byChannel || !byChannel.length) {
    console.log('renderChannel: No data to display');
    // Show "No Data" message
    container.innerHTML = '<div style="height:280px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:14px; font-style:italic;">No data available for the selected filters</div>';
    return;
  }
  
  // Restore canvas if it was replaced by "No Data" message
  if (!container.querySelector('canvas')) {
    container.innerHTML = '<canvas id="chartChannel"></canvas>';
  }
  
  const sorted = [...byChannel].sort((a, b) => (b.med_contacts + b.high_contacts) - (a.med_contacts + a.high_contacts));
  console.log('sorted channel data:', sorted);
  console.log('med_contacts:', sorted.map(x => x.med_contacts));
  console.log('high_contacts:', sorted.map(x => x.high_contacts));
  _charts['chartChannel'] = new Chart(document.getElementById('chartChannel'), {
    type: 'bar',
    data: {
      labels: sorted.map(x => x.channel),
      datasets: [
        {
          label: 'Medium Complexity',
          data: sorted.map(x => x.med_contacts),
          backgroundColor: C.yellow + 'dd',
          borderColor: C.yellow,
          borderWidth: 1
        },
        {
          label: 'High Complexity',
          data: sorted.map(x => x.high_contacts),
          backgroundColor: C.red + 'dd',
          borderColor: C.red,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.dataset.label + ': ' + context.parsed.y.toLocaleString();
            }
          }
        }
      },
      scales: {
        y: { 
          beginAtZero: true, 
          stacked: true,
          ticks: { font: { size: 10 } },
          title: { display: true, text: 'Contact Volume', font: { size: 11, weight: 'bold' } }
        },
        x: { 
          stacked: true,
          ticks: { font: { size: 10 } } 
        }
      }
    }
  });
}

function renderComponents(components) {
  _destroy('chartComponents');
  const ctx = document.getElementById('chartComponents');
  if (!ctx || !components.length) return;
  const labels = ['Contact\nReason', 'Workflow\nCount', 'Talk %', 'Repeat\nCaller', 'Transfers', 'Gen/Non-Gen'];
  const keys   = ['avg_case_cat','avg_workflow','avg_talk','avg_repeat','avg_transfer','avg_gen'];
  const bColors = { Low: C.green, Medium: C.yellow, High: C.red };
  _charts['chartComponents'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: components.map(comp => ({
        label: comp.bucket,
        data: keys.map(k => comp[k] || 0),
        backgroundColor: (bColors[comp.bucket] || C.blue) + '88',
        borderColor: bColors[comp.bucket] || C.blue, borderWidth: 1,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
      scales: {
        y: { beginAtZero: true, max: 3.2, ticks: { font: { size: 10 } }, title: { display: true, text: 'Avg Bucket Score (1–3)' } },
        x: { ticks: { font: { size: 9 }, maxRotation: 0 } }
      }
    }
  });
}

function renderQueue(byQueue) {
  console.log('renderQueue called with:', byQueue);
  _destroy('chartQueue');
  const ctx = document.getElementById('chartQueue');
  if (!ctx) {
    console.log('renderQueue ABORT: no canvas');
    return;
  }
  
  const container = ctx.parentElement;
  
  if (!byQueue || !byQueue.length) {
    console.log('renderQueue: No data to display');
    container.innerHTML = '<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:14px; font-style:italic;">No data available for the selected filters</div>';
    return;
  }
  
  // Restore canvas if it was replaced by "No Data" message
  if (!container.querySelector('canvas')) {
    container.innerHTML = '<canvas id="chartQueue"></canvas>';
  }
  
  console.log('queue data:', byQueue);
  console.log('med_contacts:', byQueue.map(x => x.med_contacts));
  console.log('high_contacts:', byQueue.map(x => x.high_contacts));
  console.log('avg_med_high_score:', byQueue.map(x => x.avg_med_high_score));
  
  _charts['chartQueue'] = new Chart(document.getElementById('chartQueue'), {
    type: 'bar',
    data: {
      labels: byQueue.map(x => x.queue_name.length > 28 ? x.queue_name.slice(0, 26) + '…' : x.queue_name),
      datasets: [
        {
          label: 'Medium Complexity',
          data: byQueue.map(x => x.med_contacts),
          backgroundColor: C.yellow + 'dd',
          borderColor: C.yellow,
          borderWidth: 1,
          yAxisID: 'y',
          stack: 'volume'
        },
        {
          label: 'High Complexity',
          data: byQueue.map(x => x.high_contacts),
          backgroundColor: C.red + 'dd',
          borderColor: C.red,
          borderWidth: 1,
          yAxisID: 'y',
          stack: 'volume'
        },
        {
          type: 'line',
          label: 'Avg Score (Med+High)',
          data: byQueue.map(x => x.avg_med_high_score),
          borderColor: C.blue,
          backgroundColor: C.blue + '44',
          borderWidth: 3,
          pointRadius: 5,
          pointHoverRadius: 7,
          yAxisID: 'y1',
          fill: false
        }
      ]
    },
    options: {
      responsive: true, 
      maintainAspectRatio: false,
      plugins: { 
        legend: { position: 'top', labels: { font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.dataset.type === 'line') {
                return context.dataset.label + ': ' + (context.parsed.y || 0).toFixed(2);
              }
              return context.dataset.label + ': ' + context.parsed.y.toLocaleString();
            }
          }
        }
      },
      scales: {
        x: { 
          ticks: { 
            font: { size: 9 },
            maxRotation: 45,
            minRotation: 45
          }
        },
        y: { 
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          stacked: true,
          ticks: { font: { size: 10 } },
          title: { display: true, text: 'Contact Volume', font: { size: 11, weight: 'bold' }, color: '#374151' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          ticks: { 
            font: { size: 10 },
            callback: function(value) {
              return value.toFixed(1);
            }
          },
          title: { display: true, text: 'Avg Complexity Score (Med+High)', font: { size: 11, weight: 'bold' }, color: C.blue },
          grid: { display: false }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      }
    }
  });
}

function renderDeptChannel(byDeptChannel) {
  // Mirrors renderQueue, but bars are Top 10 Department / Channel combos.
  _destroy('chartDeptChannel');
  const ctx = document.getElementById('chartDeptChannel');
  if (!ctx) return;

  const container = ctx.parentElement;

  if (!byDeptChannel || !byDeptChannel.length) {
    container.innerHTML = '<div style="height:300px; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:14px; font-style:italic;">No data available for the selected filters</div>';
    return;
  }

  if (!container.querySelector('canvas')) {
    container.innerHTML = '<canvas id="chartDeptChannel"></canvas>';
  }

  _charts['chartDeptChannel'] = new Chart(document.getElementById('chartDeptChannel'), {
    type: 'bar',
    data: {
      labels: byDeptChannel.map(x => x.dept_channel.length > 28 ? x.dept_channel.slice(0, 26) + '\u2026' : x.dept_channel),
      datasets: [
        {
          label: 'Medium Complexity',
          data: byDeptChannel.map(x => x.med_contacts),
          backgroundColor: C.yellow + 'dd',
          borderColor: C.yellow,
          borderWidth: 1,
          yAxisID: 'y',
          stack: 'volume'
        },
        {
          label: 'High Complexity',
          data: byDeptChannel.map(x => x.high_contacts),
          backgroundColor: C.red + 'dd',
          borderColor: C.red,
          borderWidth: 1,
          yAxisID: 'y',
          stack: 'volume'
        },
        {
          type: 'line',
          label: 'Avg Score (Med+High)',
          data: byDeptChannel.map(x => x.avg_med_high_score),
          borderColor: C.blue,
          backgroundColor: C.blue + '44',
          borderWidth: 3,
          pointRadius: 5,
          pointHoverRadius: 7,
          yAxisID: 'y1',
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              if (context.dataset.type === 'line') {
                return context.dataset.label + ': ' + (context.parsed.y || 0).toFixed(2);
              }
              return context.dataset.label + ': ' + context.parsed.y.toLocaleString();
            },
            title: function(items) {
              // Show full unabbreviated label in tooltip
              const idx = items[0].dataIndex;
              return byDeptChannel[idx].dept_channel;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            font: { size: 9 },
            maxRotation: 45,
            minRotation: 45
          }
        },
        y: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          stacked: true,
          ticks: { font: { size: 10 } },
          title: { display: true, text: 'Contact Volume', font: { size: 11, weight: 'bold' }, color: '#374151' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          ticks: {
            font: { size: 10 },
            callback: function(value) { return value.toFixed(1); }
          },
          title: { display: true, text: 'Avg Complexity Score (Med+High)', font: { size: 11, weight: 'bold' }, color: C.blue },
          grid: { display: false }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      }
    }
  });
}

function calculateWalmartWeek(dateStr) {
  // Walmart fiscal year starts on Feb 1st
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  
  // Fiscal year starts Feb 1
  const fiscalYear = month >= 2 ? year + 1 : year;
  const fiscalStart = new Date(`${fiscalYear - 1}-02-01`);
  
  // Days since fiscal year start
  const daysSinceStart = Math.floor((date - fiscalStart) / (1000 * 60 * 60 * 24));
  const weekNum = Math.floor(daysSinceStart / 7) + 1;
  
  return `FY${fiscalYear.toString().slice(-2)}W${weekNum.toString().padStart(2, '0')}`;
}

function aggregateWeeklyData(daily) {
  // Group by Walmart week
  const weeks = {};
  
  daily.forEach(d => {
    const week = calculateWalmartWeek(d.dt);
    if (!weeks[week]) {
      weeks[week] = {
        week,
        low: 0,
        medium: 0,
        high: 0,
        total: 0,
        lowScoreSum: 0,
        lowScoreCount: 0,
        medScoreSum: 0,
        medScoreCount: 0,
        highScoreSum: 0,
        highScoreCount: 0
      };
    }
    
    // Use actual bucket counts from BigQuery
    weeks[week].low += d.low_contacts || 0;
    weeks[week].medium += d.med_contacts || 0;
    weeks[week].high += d.high_contacts || 0;
    weeks[week].total += d.contacts || 0;
    
    // Aggregate avg scores by bucket
    if (d.avg_low_score !== null && d.avg_low_score !== undefined) {
      weeks[week].lowScoreSum += d.avg_low_score * (d.low_contacts || 0);
      weeks[week].lowScoreCount += (d.low_contacts || 0);
    }
    if (d.avg_med_score !== null && d.avg_med_score !== undefined) {
      weeks[week].medScoreSum += d.avg_med_score * (d.med_contacts || 0);
      weeks[week].medScoreCount += (d.med_contacts || 0);
    }
    if (d.avg_high_score !== null && d.avg_high_score !== undefined) {
      weeks[week].highScoreSum += d.avg_high_score * (d.high_contacts || 0);
      weeks[week].highScoreCount += (d.high_contacts || 0);
    }
  });
  
  // Convert to sorted array with calculated averages
  return Object.values(weeks)
    .map(w => ({
      ...w,
      avgLowScore: w.lowScoreCount > 0 ? w.lowScoreSum / w.lowScoreCount : null,
      avgMedScore: w.medScoreCount > 0 ? w.medScoreSum / w.medScoreCount : null,
      avgHighScore: w.highScoreCount > 0 ? w.highScoreSum / w.highScoreCount : null
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

function renderWeekly(daily) {
  const container = document.getElementById('weeklyPivotTable');
  if (!container || !daily.length) return;
  
  const weeklyData = aggregateWeeklyData(daily);
  
  // Build table using DOM APIs for safety
  const table = document.createElement('table');
  table.className = 'w-full border-collapse';
  
  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.className = 'bg-[#0053e2] text-white text-xs uppercase tracking-wider';
  
  const th1 = document.createElement('th');
  th1.className = 'px-3 py-2 text-left border border-[#0046c0] sticky left-0 bg-[#0053e2] z-10';
  th1.textContent = 'Complexity';
  headerRow.appendChild(th1);
  
  // Add week columns
  weeklyData.forEach(w => {
    const th = document.createElement('th');
    th.className = 'px-3 py-2 text-center border border-[#0046c0] min-w-[140px]';
    th.textContent = w.week;
    headerRow.appendChild(th);
  });
  
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  // Body rows
  const tbody = document.createElement('tbody');
  
  // Helper to create a cell with volume, %, and avg score
  const makeCell = (volume, total, avgScore, bgColor, textColor) => {
    const td = document.createElement('td');
    td.className = 'px-3 py-2 border border-gray-200 text-center';
    td.style.backgroundColor = bgColor;
    
    const volDiv = document.createElement('div');
    volDiv.className = `font-bold text-sm ${textColor}`;
    volDiv.textContent = volume.toLocaleString();
    
    const pctDiv = document.createElement('div');
    pctDiv.className = `text-xs ${textColor} opacity-80`;
    const pct = total > 0 ? ((volume / total) * 100).toFixed(1) : '0.0';
    pctDiv.textContent = pct + '% of total';
    
    const scoreDiv = document.createElement('div');
    scoreDiv.className = `text-xs ${textColor} font-semibold mt-1`;
    const scoreText = avgScore !== null && avgScore !== undefined ? 'Avg: ' + avgScore.toFixed(1) : 'Avg: N/A';
    scoreDiv.textContent = scoreText;
    
    td.append(volDiv, pctDiv, scoreDiv);
    return td;
  };
  
  // Low Complexity Row
  const lowRow = document.createElement('tr');
  lowRow.className = 'hover:bg-green-50';
  const lowLabel = document.createElement('td');
  lowLabel.className = 'px-3 py-2 font-semibold text-green-700 border border-gray-200 sticky left-0 bg-green-50 z-10';
  const lowIcon = document.createElement('span');
  lowIcon.className = 'inline-block w-3 h-3 rounded-full bg-green-600 mr-2';
  lowLabel.appendChild(lowIcon);
  lowLabel.appendChild(document.createTextNode('Low (0–25)'));
  lowRow.appendChild(lowLabel);
  
  weeklyData.forEach(w => {
    lowRow.appendChild(makeCell(w.low, w.total, w.avgLowScore, '#dcfce7', 'text-green-800'));
  });
  tbody.appendChild(lowRow);
  
  // Medium Complexity Row
  const medRow = document.createElement('tr');
  medRow.className = 'hover:bg-yellow-50';
  const medLabel = document.createElement('td');
  medLabel.className = 'px-3 py-2 font-semibold text-yellow-700 border border-gray-200 sticky left-0 bg-yellow-50 z-10';
  const medIcon = document.createElement('span');
  medIcon.className = 'inline-block w-3 h-3 rounded-full bg-yellow-500 mr-2';
  medLabel.appendChild(medIcon);
  medLabel.appendChild(document.createTextNode('Medium (26–40)'));
  medRow.appendChild(medLabel);
  
  weeklyData.forEach(w => {
    medRow.appendChild(makeCell(w.medium, w.total, w.avgMedScore, '#fef9c3', 'text-yellow-800'));
  });
  tbody.appendChild(medRow);
  
  // High Complexity Row
  const highRow = document.createElement('tr');
  highRow.className = 'hover:bg-red-50';
  const highLabel = document.createElement('td');
  highLabel.className = 'px-3 py-2 font-semibold text-red-700 border border-gray-200 sticky left-0 bg-red-50 z-10';
  const highIcon = document.createElement('span');
  highIcon.className = 'inline-block w-3 h-3 rounded-full bg-red-600 mr-2';
  highLabel.appendChild(highIcon);
  highLabel.appendChild(document.createTextNode('High (41+)'));
  highRow.appendChild(highLabel);
  
  weeklyData.forEach(w => {
    highRow.appendChild(makeCell(w.high, w.total, w.avgHighScore, '#fee2e2', 'text-red-800'));
  });
  tbody.appendChild(highRow);
  
  // Total Row
  const totalRow = document.createElement('tr');
  totalRow.className = 'bg-gray-100 font-bold';
  const totalLabel = document.createElement('td');
  totalLabel.className = 'px-3 py-2 text-gray-700 border border-gray-300 sticky left-0 bg-gray-200 z-10';
  totalLabel.textContent = 'Total';
  totalRow.appendChild(totalLabel);
  
  weeklyData.forEach(w => {
    const td = document.createElement('td');
    td.className = 'px-3 py-2 border border-gray-300 text-center text-gray-700';
    td.textContent = w.total.toLocaleString();
    totalRow.appendChild(td);
  });
  tbody.appendChild(totalRow);
  
  table.appendChild(tbody);
  container.replaceChildren(table);
}

// ── Contact Drilldown ──────────────────────────────────────────────────────────
const _bucketStyles = {
  Low:    { bg: '#dcfce7', text: '#166534', border: '#2a8703' },
  Medium: { bg: '#fef9c3', text: '#854d0e', border: '#eab308' },
  High:   { bg: '#fee2e2', text: '#991b1b', border: '#ea1100' },
};

// Normalize bucket value to title case for _bucketStyles lookup
function _normalizeBucket(bucket) {
  if (!bucket) return 'Low';
  const upper = String(bucket).toUpperCase();
  if (upper === 'LOW') return 'Low';
  if (upper === 'MEDIUM') return 'Medium';
  if (upper === 'HIGH') return 'High';
  // Fallback: capitalize first letter
  return bucket.charAt(0).toUpperCase() + bucket.slice(1).toLowerCase();
}

// Calculate score and bucket from component scores when BQ values are missing/NULL
function _calculateScoreAndBucket(d) {
  // Weights (total = 10.0)
  const composite = (
    (Number(d.case_category_score) || 0) * 3.5 +
    (Number(d.workflow_score) || 0) * 2.0 +
    (Number(d.talk_pct_score) || 0) * 2.0 +
    (Number(d.repeat_caller_score) || 0) * 1.5 +
    (Number(d.transfer_score) || 0) * 0.5 +
    (Number(d.gen_score) || 0) * 0.5
  );
  
  // Normalize composite (10-30) to 0-100 scale
  // score = ((composite - 10.0) / 20.0) × 100
  const MIN_COMPOSITE = 10.0;
  const MAX_COMPOSITE = 30.0;
  const normalizedScore = ((composite - MIN_COMPOSITE) / (MAX_COMPOSITE - MIN_COMPOSITE)) * 100;
  
  // Determine bucket based on normalized score (0-100)
  // Low: 0-25, Medium: 26-40, High: 41+
  let bucket;
  if (normalizedScore <= 25) {
    bucket = 'Low';
  } else if (normalizedScore <= 40) {
    bucket = 'Medium';
  } else {
    bucket = 'High';
  }
  
  return { score: normalizedScore, bucket: bucket };
}

// In-memory cache: contact_id → full object. Hydrated after each fetch via _hydrateContactCache().
window._contactCache = new Map();

// Reads from Map — instant, zero BQ queries.
function selectContact(el) {
  const id = String(el.dataset.id);

  // Highlight row
  document.querySelectorAll('.contact-item').forEach(item => {
    item.classList.toggle('bg-blue-100', item.dataset.id === id);
    item.classList.toggle('font-semibold', item.dataset.id === id);
  });

  const d = window._contactCache.get(id);
  if (!d) {
    console.warn('Contact not in cache:', id);
    return;
  }

  // 1️⃣ Show panel FIRST (Chart.js needs a visible canvas to measure)
  document.getElementById('contactPlaceholder').classList.add('hidden');
  document.getElementById('contactDetail').classList.remove('hidden');

  // 2️⃣ Render info + score card + KPI table (synchronous)
  _renderContactInfo(d);
  _renderScoreCard(d);
  _renderKpiTable(d);

  // 3️⃣ Radar needs a paint tick so the canvas has real dimensions
  requestAnimationFrame(() => _renderRadar(d));

  document.getElementById('drilldownSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function _renderContactInfo(d) {
  const fmt = (v, suffix = '') => (v !== null && v !== undefined && v !== 0) ? `${v}${suffix}` : '—';
  const info = [
    ['Contact ID',   d.contact_id],
    ['Date',         d.dt],
    ['Channel',      d.channel || '—'],
    ['Department',   d.department || '—'],
    ['Sub-LOB',      d.sublob || '—'],
    ['Queue',        d.queue || '—'],
    ['Handle Time',  fmt(d.aht_mins, ' min')],
    ['Talk %',       d.talk_pct_pct ? d.talk_pct_pct.toFixed(1) + '%' : '—'],
    ['Repeat Calls', fmt(d.rcr_calls)],
    ['Transfers',    fmt(d.transfer_count)],
    ['Workflows',    fmt(d.total_workflows)],
    ['Type',         d.contact_type || '—'],
    ['Case Cat 1',   d.case_cat1 || '—'],
    ['Case Cat 2',   d.case_cat2 || '—'],
  ];

  // Build with DOM APIs — remote values assigned via textContent, never innerHTML.
  // This breaks the taint chain for CWE-79 (DOM XSS) without any external sanitiser.
  const container = document.getElementById('contactInfo');
  if (!container) return; // null guard — element may not exist on every page variant
  container.innerHTML = ''; // clear only — no remote data involved here
  info.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'flex justify-between gap-2';

    const labelEl = document.createElement('span');
    labelEl.className = 'text-gray-500 shrink-0 text-xs';
    labelEl.textContent = label + ':';

    const valueEl = document.createElement('span');
    valueEl.className = 'font-semibold text-right text-xs truncate';
    const safeVal = String(value ?? '—');
    valueEl.title = safeVal;       // textContent-equivalent for attribute
    valueEl.textContent = safeVal; // never parsed as HTML

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    container.appendChild(row);
  });
}

function _renderScoreCard(d) {
  // Fallback: if BQ has NULL/0 score or empty bucket, calculate from components
  let finalScore, bucket;
  if (!d.final_complexity_score || !d.final_complexity_bucket) {
    const calc = _calculateScoreAndBucket(d);
    finalScore = calc.score.toFixed(1);
    bucket = calc.bucket;
  } else {
    const rawBucket  = d.final_complexity_bucket || 'Low';
    bucket = _normalizeBucket(rawBucket);
    finalScore = (Number(d.final_complexity_score) || 0).toFixed(1);
  }
  
  const st         = _bucketStyles[bucket] || _bucketStyles.Low; // hardcoded CSS colours
  const weighted   = (Number(d.weighted_score) || 0).toFixed(2);

  // Build with DOM APIs — all remote values set via textContent, never innerHTML.
  const card = document.getElementById('contactScoreCard');
  if (!card) return; // null guard — element may not exist on every page variant
  card.innerHTML = ''; // clear only — no remote data

  const wrapper = document.createElement('div');
  wrapper.className = 'rounded-lg p-4 h-full flex flex-col justify-center items-center text-center';
  wrapper.style.cssText = `background:${st.bg}; border: 2px solid ${st.border}`;

  const lbl = document.createElement('div');
  lbl.className = 'text-xs uppercase tracking-wider font-semibold mb-1';
  lbl.style.color = st.text;
  lbl.textContent = 'Final Score';

  const scoreEl = document.createElement('div');
  scoreEl.className = 'text-5xl font-bold';
  scoreEl.style.color = st.text;
  scoreEl.textContent = finalScore; // numeric string, textContent — no HTML parsing

  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'mt-3';
  const badge = document.createElement('span');
  badge.className = 'inline-block px-3 py-1 rounded-full text-sm font-bold text-white';
  badge.style.background = st.border;
  badge.textContent = bucket + ' Complexity'; // textContent — safe
  badgeWrap.appendChild(badge);

  const compositeEl = document.createElement('div');
  compositeEl.className = 'text-xs mt-2';
  compositeEl.style.color = st.text;
  compositeEl.textContent = `Weighted composite: ${weighted}`; // numeric string

  wrapper.append(lbl, scoreEl, badgeWrap, compositeEl);
  card.appendChild(wrapper);
}

function _renderKpiTable(d) {
  const tbody = document.getElementById('kpiBreakdownBody');
  if (!tbody) return;

  // Build with DOM APIs — all remote values (score, bucket, finalScore) go through
  // textContent, never innerHTML. Breaks the CWE-79 taint chain on both Snyk findings.
  const mk = (tag, className, inlineStyle) => {
    const el = document.createElement(tag);
    if (className)   el.className = className;
    if (inlineStyle) el.style.cssText = inlineStyle;
    return el;
  };

  tbody.innerHTML = ''; // clear only — no remote data involved
  let composite = 0;

  KPI_CONFIG.forEach(k => {
    const score    = Number(d[k.key]) || 0; // explicit Number() coercion — can’t carry HTML
    const contrib  = score * k.weight;
    composite     += contrib;
    const pct      = (score / 3) * 100;
    const barColor = score === 1 ? '#2a8703' : score === 2 ? '#d97706' : '#ea1100';
    const scoreLabel = score === 1 ? k.s1 : score === 2 ? k.s2 : k.s3;

    const tr = mk('tr', 'border-b border-gray-50 hover:bg-gray-50');

    // Col 1: KPI label + sub-label (both from hardcoded KPI_CONFIG, not remote data)
    const td1 = mk('td', 'px-3 py-2 font-medium text-gray-800');
    td1.textContent = k.label;
    const sub = mk('div', 'text-[10px] text-gray-400 font-normal');
    sub.textContent = scoreLabel;
    td1.appendChild(sub);

    // Col 2: Score badge — score is Number, textContent is safe
    const td2    = mk('td', 'px-3 py-2 text-center');
    const badge  = mk('span',
      'inline-flex w-8 h-8 items-center justify-center rounded-full text-white text-xs font-bold',
      `background:${barColor}`);
    badge.textContent = String(score);
    td2.appendChild(badge);

    // Col 3: Weight (from KPI_CONFIG — hardcoded)
    const td3 = mk('td', 'px-3 py-2 text-center text-gray-500');
    td3.textContent = String(k.weight);

    // Col 4: Contribution (computed number)
    const td4 = mk('td', 'px-3 py-2 text-center font-semibold text-[#0053e2]');
    td4.textContent = contrib.toFixed(2);

    // Col 5: Progress bar (widths are computed numbers — safe in style.cssText)
    const td5  = mk('td', 'px-3 py-2 min-w-[100px]');
    const track = mk('div', 'w-full bg-gray-200 rounded-full h-3');
    const fill  = mk('div', 'h-3 rounded-full transition-all',
      `width:${pct}%;background:${barColor}`);
    track.appendChild(fill);
    td5.appendChild(track);

    tr.append(td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
  });

  const modelScore = ((composite - MIN_COMPOSITE) / (MAX_COMPOSITE - MIN_COMPOSITE)) * 100;
  
  // Fallback: if BQ has NULL/0 score or empty bucket, calculate from components
  let finalScore, bucket;
  if (!d.final_complexity_score || !d.final_complexity_bucket) {
    const calc = _calculateScoreAndBucket(d);
    finalScore = calc.score.toFixed(1);
    bucket = calc.bucket;
  } else {
    const rawBucket  = d.final_complexity_bucket || 'Low';
    bucket = _normalizeBucket(rawBucket);
    finalScore = (Number(d.final_complexity_score) || 0).toFixed(1);
  }
  
  const st = _bucketStyles[bucket] || _bucketStyles.Low; // hardcoded color strings

  // Summary row 1: Composite
  const trComp = mk('tr', 'bg-gray-50 border-t-2 border-gray-300');
  const tcLbl  = mk('td', 'px-3 py-2 font-semibold');
  tcLbl.colSpan   = 3;
  tcLbl.textContent = 'Composite (Σ bucket × weight)';
  const tcVal  = mk('td', 'px-3 py-2 text-center font-bold text-lg');
  tcVal.textContent = composite.toFixed(2);
  const tcRange = mk('td', 'px-3 py-2 text-xs text-gray-400');
  tcRange.textContent = `range: ${MIN_COMPOSITE}–${MAX_COMPOSITE}`;
  trComp.append(tcLbl, tcVal, tcRange);
  tbody.appendChild(trComp);

  // Summary row 2: Model Normalized Score
  const trModel = mk('tr', 'bg-blue-50');
  const tmLbl   = mk('td', 'px-3 py-2 font-semibold');
  tmLbl.colSpan   = 3;
  tmLbl.textContent = 'Model Normalized Score ((comp−10)/20)×100';
  const tmVal   = mk('td', 'px-3 py-2 text-center font-bold text-lg text-[#0053e2]');
  tmVal.textContent = modelScore.toFixed(1);
  trModel.append(tmLbl, tmVal, mk('td', ''));
  tbody.appendChild(trModel);

  // Summary row 3: Final Score from BQ — bucket via textContent, colours from hardcoded lookup
  const trFinal = mk('tr', 'font-bold', `background:${st.bg}`);
  const tfLbl   = mk('td', 'px-3 py-2');
  tfLbl.colSpan   = 3;
  tfLbl.textContent = 'Final Complexity Score (from BQ)';
  const tfVal   = mk('td', 'px-3 py-2 text-center text-lg', `color:${st.border}`);
  tfVal.textContent = finalScore;
  const tfBkt   = mk('td', 'px-3 py-2');
  const bucketBadge = mk('span',
    'inline-block px-2 py-0.5 rounded-full text-xs font-bold text-white',
    `background:${st.border}`);
  bucketBadge.textContent = bucket; // textContent — never parsed as HTML
  tfBkt.appendChild(bucketBadge);
  trFinal.append(tfLbl, tfVal, tfBkt);
  tbody.appendChild(trFinal);
}

function _renderRadar(d) {
  _destroy('chartRadar');
  const ctx = document.getElementById('chartRadar');
  if (!ctx) return;
  const scores = KPI_CONFIG.map(k => d[k.key] || 0);
  _charts['chartRadar'] = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: KPI_CONFIG.map(k => k.label),
      datasets: [{
        label: 'KPI Bucket Scores',
        data: scores,
        backgroundColor: 'rgba(0,83,226,0.15)',
        borderColor: '#0053e2', borderWidth: 2,
        pointBackgroundColor: scores.map(s => s === 1 ? '#2a8703' : s === 2 ? '#d97706' : '#ea1100'),
        pointRadius: 5, pointHoverRadius: 7,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        r: { min: 0, max: 3, ticks: { stepSize: 1, font: { size: 9 } }, pointLabels: { font: { size: 10 } } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// ── Recommendations ──────────────────────────────────────────────────────────
/**
 * Build one recommendation row using DOM APIs.
 * Mirrors _insightRow but with the blue arrow bullet style.
 * Server values (queue names, percentages) are always set via textContent.
 */
function _recRow(segments) {
  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-start gap-2';
  const arrow = document.createElement('span');
  arrow.className = 'text-[#0053e2] mt-0.5 font-bold';
  arrow.textContent = '▶';
  const content = document.createElement('span');
  for (const seg of segments) {
    if (seg.bold) {
      const strong = document.createElement('strong');
      strong.textContent = String(seg.text ?? '');
      content.appendChild(strong);
    } else {
      content.appendChild(document.createTextNode(String(seg.text ?? '')));
    }
  }
  wrapper.append(arrow, content);
  return wrapper;
}

function renderRecommendations(data) {
  const el = document.getElementById('recommendations');
  if (!el) return;
  const k = data.kpis || {};
  const total = k.total_contacts || 1;
  const highPct = ((k.high_count || 0) / total * 100).toFixed(2);
  // Queue names from server data — inserted via textContent inside _recRow, never innerHTML.
  const topQueueNames = (data.by_queue || []).slice(0, 3).map(q => String(q.queue_name || ''));
  const topQ = topQueueNames.join(', ');

  const rows = [
    _recRow([
      {bold: true, text: '🎯 Routing Optimization'},
      {text: ': Queues with avg complexity above 20 should be evaluated for advanced routing logic ensuring senior agents handle High-complexity contacts.'},
    ]),
    _recRow([
      {bold: true, text: '📋 Coaching Focus'},
      {text: ': High complexity contacts ('}, {text: highPct + '% of volume'},
      {text: ') are prime targets for agent coaching — focus on reducing repeat callers and transfer rates.'},
    ]),
    _recRow([
      {bold: true, text: '🤖 Self-Service Deflection'},
      {text: ': Low-complexity contacts are ideal for IVR/chatbot deflection, freeing agent capacity for complex, high-value interactions.'},
    ]),
    ...(topQ ? [_recRow([
      {bold: true, text: '🏭 Vendor Monitoring'},
      {text: ': Top-complexity queues ('}, {text: topQ},
      {text: ') warrant SLA audits and targeted training investment.'},
    ])] : []),
    _recRow([
      {bold: true, text: '📅 Workforce Planning'},
      {text: ': Use daily complexity trends to right-size staffing. Complexity spikes may indicate system outages or seasonal demand shifts.'},
    ]),
  ];
  el.replaceChildren(...rows);
}

// ── Refresh orchestration ───────────────────────────────────────────────────────
function _spinning(on) {
  const icon = document.getElementById('refreshIcon');
  const btn  = document.getElementById('btnRefresh');
  if (icon) icon.style.animation = on ? 'spin 0.8s linear infinite' : '';
  if (btn)  btn.disabled = on;
}

async function refreshAll(clearCache = false) {
  _spinning(true);
  try {
    // PORTABLE DEMO: aggregates the embedded SAMPLE_CONTACTS array via
    // aggregateSummary() (see portable-data.js) instead of fetching
    // /api/summary from a live BigQuery-backed backend.
    const params = _getFilters();
    const filters = {
      sublob: params.get('sublob') || '',
      department: params.get('department') || '',
      channel: params.get('channel') || '',
      queue: params.get('queue') || '',
      month_year: params.getAll('month_year'),
    };
    const data = aggregateSummary(SAMPLE_CONTACTS, filters);

    // Store score components for KPI card calculations
    window._lastScoreComponents = data.score_components || [];
    
    renderKPIs(data.kpis || {});
    renderInsights(data);
    // renderPie removed - no longer showing complexity distribution pie chart
    renderHist(data.histogram || []);
    renderChannel(data.by_channel || []);
    // renderComponents removed - component breakdown chart no longer needed
    renderQueue(data.by_queue || []);
    renderDeptChannel(data.by_dept_channel || []);
    renderWeekly(data.daily || []); // Changed from renderDaily to renderWeekly
    renderRecommendations(data);

    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('lastUpdated').textContent = `Last updated: ${now}`;
  } catch (err) {
    console.error('Refresh failed:', err);
    document.getElementById('lastUpdated').textContent = `⚠️ Refresh failed — retrying next cycle`;
  } finally {
    _spinning(false);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Spinner animation CSS
  const s = document.createElement('style');
  s.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(s);
  await loadMetadata();
  // Filter changes: reload metadata first so the OTHER dropdowns cascade to
  // reflect the new selection, then refresh charts + contacts. This is a
  // fire-and-forget async chain — UI interactivity remains snappy because
  // fetch is non-blocking.
  ['fSublob','fDepartment','fChannel','fQueue'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async () => {
      _drillOffset = 0;
      await loadMetadata();
      refreshAll(false);
      _triggerContactRefresh();
    });
  });
  
  // Month filter: no auto-refresh, user must click Apply button

  await refreshAll(false);
  _triggerContactRefresh();
  _refreshTimer = setInterval(() => refreshAll(false), REFRESH_MS);
});
