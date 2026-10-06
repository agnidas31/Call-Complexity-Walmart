// portable-data.js
// Client-side replacements for the three network calls the live dashboard
// makes (/api/metadata, /api/summary, /hx/contacts). Everything here computes
// the exact same response shape the real FastAPI + BigQuery backend would,
// but from the embedded SAMPLE_CONTACTS array instead of a live table.
// dashboard.js's render functions are completely unmodified -- they don't
// know or care that the data came from here instead of a fetch().

const PAGE_SIZE = 50;

function _esc2(val) {
  return String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- filtering --------------------------------------------------------
function _matchesFilters(c, filters) {
  if (filters.sublob && c.sublob !== filters.sublob) return false;
  if (filters.department && c.department !== filters.department) return false;
  if (filters.channel && c.channel !== filters.channel) return false;
  if (filters.queue && c.queue !== filters.queue) return false;
  if (filters.bucket && c.bucket !== filters.bucket) return false;
  if (filters.month_year && filters.month_year.length) {
    const my = c.dt.slice(0, 7);
    if (!filters.month_year.includes(my)) return false;
  }
  return true;
}

function filterContacts(contacts, filters) {
  return contacts.filter(c => _matchesFilters(c, filters || {}));
}

// ---- /api/metadata equivalent ------------------------------------------
// Cascading: each dropdown's options are computed by filtering on every
// OTHER active filter (not itself), matching the real app's behavior.
function aggregateMetadata(contacts, filters) {
  const f = filters || {};
  const uniq = (key, omit) => {
    const sub = { ...f };
    delete sub[omit];
    const seen = new Set();
    contacts.forEach(c => { if (_matchesFilters(c, sub)) seen.add(c[key]); });
    return Array.from(seen).sort();
  };
  const monthYears = Array.from(new Set(contacts.map(c => c.dt.slice(0, 7))))
    .sort((a, b) => b.localeCompare(a)); // newest first
  return {
    sublobs: uniq('sublob', 'sublob'),
    departments: uniq('department', 'department'),
    channels: uniq('channel', 'channel'),
    queues: uniq('queue', 'queue'),
    buckets: ['LOW', 'MEDIUM', 'HIGH'],
    month_years: monthYears,
  };
}

// ---- /api/summary equivalent --------------------------------------------
function _avg(arr, pick) {
  const vals = arr.map(pick).filter(v => v !== null && v !== undefined);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function aggregateSummary(contacts, filters) {
  const rows = filterContacts(contacts, filters);
  const total = rows.length;
  const low = rows.filter(c => c.bucket === 'LOW');
  const med = rows.filter(c => c.bucket === 'MEDIUM');
  const high = rows.filter(c => c.bucket === 'HIGH');

  const kpis = {
    total_contacts: total,
    avg_score: Number(_avg(rows, c => c.score).toFixed(2)),
    low_count: low.length,
    med_count: med.length,
    high_count: high.length,
    avg_aht_mins: Number(_avg(rows, c => c.aht_mins).toFixed(2)),
  };

  // by_channel / by_queue / by_dept_channel are scoped to month_year only
  // (mirrors the real query's "stable landscape view" behavior).
  const monthOnlyFilters = { month_year: filters.month_year };
  const monthRows = filterContacts(contacts, monthOnlyFilters);

  const groupBy = (rows, keyFn) => {
    const groups = new Map();
    rows.forEach(c => {
      const k = keyFn(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    });
    return groups;
  };

  const by_channel = Array.from(groupBy(monthRows, c => c.channel).entries())
    .map(([channel, items]) => ({
      channel,
      contacts: items.length,
      avg_score: Number(_avg(items, c => c.score).toFixed(2)),
      med_contacts: items.filter(c => c.bucket === 'MEDIUM').length,
      high_contacts: items.filter(c => c.bucket === 'HIGH').length,
    }))
    .sort((a, b) => (b.med_contacts + b.high_contacts) - (a.med_contacts + a.high_contacts));

  const topN = (rows, keyFn, nameKey) => {
    const groups = groupBy(rows, keyFn);
    return Array.from(groups.entries())
      .map(([name, items]) => {
        const medHigh = items.filter(c => c.bucket === 'MEDIUM' || c.bucket === 'HIGH');
        return {
          [nameKey]: name,
          contacts: items.length,
          avg_score: Number(_avg(items, c => c.score).toFixed(2)),
          med_contacts: items.filter(c => c.bucket === 'MEDIUM').length,
          high_contacts: items.filter(c => c.bucket === 'HIGH').length,
          avg_med_high_score: Number(_avg(medHigh, c => c.score).toFixed(2)),
          _medHighTotal: medHigh.length,
        };
      })
      .sort((a, b) => b._medHighTotal - a._medHighTotal)
      .slice(0, 10);
  };

  const by_queue = topN(monthRows, c => c.queue, 'queue_name');
  const by_dept_channel = topN(monthRows, c => `${c.department} / ${c.channel}`, 'dept_channel');

  const dailyGroups = groupBy(rows, c => c.dt);
  const daily = Array.from(dailyGroups.entries())
    .map(([dt, items]) => {
      const l = items.filter(c => c.bucket === 'LOW');
      const m = items.filter(c => c.bucket === 'MEDIUM');
      const h = items.filter(c => c.bucket === 'HIGH');
      return {
        dt,
        contacts: items.length,
        avg_score: Number(_avg(items, c => c.score).toFixed(2)),
        low_contacts: l.length,
        med_contacts: m.length,
        high_contacts: h.length,
        avg_low_score: l.length ? Number(_avg(l, c => c.score).toFixed(2)) : null,
        avg_med_score: m.length ? Number(_avg(m, c => c.score).toFixed(2)) : null,
        avg_high_score: h.length ? Number(_avg(h, c => c.score).toFixed(2)) : null,
      };
    })
    .sort((a, b) => a.dt.localeCompare(b.dt));

  const score_components = ['LOW', 'MEDIUM', 'HIGH'].map(bucket => {
    const items = rows.filter(c => c.bucket === bucket);
    return {
      bucket,
      avg_score: Number(_avg(items, c => c.score).toFixed(2)),
      avg_case_cat: Number(_avg(items, c => c.case_category_score).toFixed(3)),
      avg_repeat: Number(_avg(items, c => c.repeat_caller_score).toFixed(3)),
      avg_transfer: Number(_avg(items, c => c.transfer_score).toFixed(3)),
      avg_gen: Number(_avg(items, c => c.gen_score).toFixed(3)),
      avg_talk: Number(_avg(items, c => c.talk_pct_score).toFixed(3)),
      avg_workflow: Number(_avg(items, c => c.workflow_score).toFixed(3)),
    };
  });

  const histMap = new Map();
  rows.forEach(c => {
    const bin = Math.floor(c.score / 5) * 5;
    histMap.set(bin, (histMap.get(bin) || 0) + 1);
  });
  const histogram = Array.from(histMap.entries())
    .map(([bin_start, contacts]) => ({ bin_start, contacts }))
    .sort((a, b) => a.bin_start - b.bin_start);

  // strip internal-only helper field before returning
  by_queue.forEach(q => delete q._medHighTotal);
  by_dept_channel.forEach(q => delete q._medHighTotal);

  return { kpis, by_channel, by_queue, by_dept_channel, daily, score_components, histogram };
}

// ---- /hx/contacts equivalent ---------------------------------------------
// Builds the exact same DOM structure _contacts_fragment.html would render,
// so selectContact()/_hydrateContactCache() in dashboard.js work unchanged.
function buildContactsFragmentHTML(contacts, filters, offset) {
  const rows = filterContacts(contacts, filters)
    .slice().sort((a, b) => b.dt.localeCompare(a.dt) || b.contact_id.localeCompare(a.contact_id));
  const total = rows.length;
  const page = rows.slice(offset, offset + PAGE_SIZE);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  const pillFor = bucket => {
    if (bucket === 'LOW') return ['bg-green-100 text-green-800', 'Low'];
    if (bucket === 'MEDIUM') return ['bg-yellow-100 text-yellow-800', 'Medium'];
    return ['bg-red-100 text-red-800', 'High'];
  };

  let html = '';
  if (page.length) {
    html += page.map(c => {
      const [pill, label] = pillFor(c.bucket);
      return `
<div class="contact-item px-3 py-2 cursor-pointer hover:bg-blue-50 border-b border-gray-100 flex items-center justify-between"
     data-id="${_esc2(c.contact_id)}" onclick="selectContact(this)" title="${_esc2(c.contact_id)}">
  <div class="flex-1 min-w-0">
    <div class="font-mono text-xs text-gray-700 truncate">${_esc2(c.contact_id.slice(0, 22))}&hellip;</div>
    <div class="text-[10px] text-gray-400 mt-0.5">${_esc2(c.dt)} &bull; ${_esc2(c.channel)}</div>
  </div>
  <div class="flex flex-col items-end gap-0.5 ml-2 shrink-0">
    <span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${pill}">${label}</span>
    <span class="text-xs font-bold text-[#0053e2]">${c.score.toFixed(1)}</span>
  </div>
</div>`;
    }).join('');
  } else {
    html += `
<div class="text-center py-10 text-gray-400">
  <p class="text-xs">No contacts found.</p>
</div>`;
  }

  const start = offset + 1;
  const end = offset + page.length;
  const totalLabel = page.length ? `${start}\u2013${end} of ${total.toLocaleString()}` : 'No contacts found';

  html += `
<div class="px-3 py-2 border-t border-gray-100 bg-white sticky bottom-0 flex items-center justify-between gap-2">
  <button onclick="setContactPage(${offset - PAGE_SIZE})"
    class="px-2 py-1 text-[10px] rounded font-semibold border ${hasPrev ? 'border-[#0053e2] text-[#0053e2] hover:bg-blue-50' : 'border-gray-200 text-gray-300 cursor-not-allowed'}"
    ${hasPrev ? '' : 'disabled'}>&larr; Prev</button>
  <span class="text-[10px] text-gray-400 text-center leading-tight">${totalLabel}</span>
  <button onclick="setContactPage(${offset + PAGE_SIZE})"
    class="px-2 py-1 text-[10px] rounded font-semibold border ${hasNext ? 'border-[#0053e2] text-[#0053e2] hover:bg-blue-50' : 'border-gray-200 text-gray-300 cursor-not-allowed'}"
    ${hasNext ? '' : 'disabled'}>Next &rarr;</button>
</div>`;

  return { html, contactsForCache: page };
}
