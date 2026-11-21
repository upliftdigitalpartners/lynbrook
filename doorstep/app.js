/* Doorstep — rent, bills & repairs for small landlords (forked from Evergreen House) */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const CATEGORIES = ['Mortgage', 'Electric', 'Gas', 'Water', 'Internet & phone', 'Insurance', 'Property tax', 'Trash', 'Contractor', 'Streaming', 'Subscriptions', 'Credit card', 'Car', 'Health & fitness', 'Shopping', 'Other'];
  const UPKEEP_CATS = ['Heating & cooling', 'Plumbing', 'Electrical', 'Safety', 'Exterior', 'Appliances', 'Yard', 'Cleaning', 'Pest control', 'Other'];
  const DOC_CATS = ['Lease', 'Insurance', 'Deed & mortgage', 'Tax', 'Warranty & manual', 'Permit', 'Receipt', 'Other'];
  const TRADES = ['Plumber', 'Electrician', 'Heating & cooling', 'Roofer', 'Handyman', 'Painter', 'Landscaper', 'Snow removal', 'Pest control', 'Appliance repair', 'Locksmith', 'Cleaner', 'Other'];
  const APPLIANCE_LIFE = { 'Boiler': 20, 'Furnace': 18, 'Water heater': 10, 'Central AC': 15, 'Refrigerator': 13, 'Range / oven': 15, 'Dishwasher': 10, 'Washer': 11, 'Dryer': 13, 'Microwave': 9, 'Sump pump': 10, 'Roof': 25, 'Other': null };
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const METHODS = ['Online', 'Autopay', 'Bank transfer', 'Zelle', 'Check', 'Card', 'Cash', 'Other'];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // ---------- state ----------
  const S = {
    view: 'loading', // loading | auth | recovery | join | app
    authErr: '', joinErr: '',
    user: null, household: null, member: null, units: [], bills: [], payments: {},
    rentals: [], rentPays: {}, tasks: [], logs: [], imports: [], appliances: [], contractors: [], documents: [], docQuery: '', leases: [], inspections: [], requests: [], inspDraft: null,
    tab: 'summary', month: monthKey(new Date()), unit: 'all', filter: 'all', upkeepView: 'upcoming',
    editing: null, sheet: null, sheetErr: '', deleteArm: false,
    online: navigator.onLine, pending: 0, pushState: 'unknown', installEvt: null, busy: false
  };
  // A reload (pull-to-refresh, an update) keeps you where you were. A fresh open, or 10+ minutes later, starts on Home.
  (function restoreNav() {
    try {
      const n = JSON.parse(sessionStorage.getItem('ds-nav') || 'null');
      if (!n || Date.now() - n.t > 10 * 60 * 1000) return;
      ['tab', 'month', 'upkeepView', 'billsView', 'unit'].forEach((k) => { if (n[k]) S[k] = n[k]; });
      if (S.unit === 'shared') S.unit = 'all';
      S.restoreScroll = n.y || 0;
    } catch (_) {}
  })();
  function saveNav() { try { sessionStorage.setItem('ds-nav', JSON.stringify({ tab: S.tab, month: S.month, upkeepView: S.upkeepView, billsView: S.billsView, unit: S.unit, y: window.scrollY, t: Date.now() })); } catch (_) {} }
  window.addEventListener('pagehide', saveNav);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNav(); });

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01'; }
  function parseMonth(k) { const [y, m] = k.split('-').map(Number); return { y, m }; }
  function addMonths(k, n) { const { y, m } = parseMonth(k); return monthKey(new Date(y, m - 1 + n, 1)); }
  function daysIn(y, m) { return new Date(y, m, 0).getDate(); }
  function monthLabel(k, short) { const { y, m } = parseMonth(k); return new Date(y, m - 1, 1).toLocaleDateString('en-US', short ? { month: 'short' } : { month: 'long', year: 'numeric' }); }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromIso(s) { if (!s) return null; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
  function addMonthsIso(iso, n) {
    const d = fromIso(iso); const y = d.getFullYear(), m = d.getMonth() + n;
    const last = new Date(y, m + 1, 0).getDate();
    return isoDate(new Date(y, m, Math.min(d.getDate(), last)));
  }
  function dayDiff(d) { return Math.round((d - today()) / 86400000); }
  function dueOn(day, period) {
    if (!day) return null;
    const { y, m } = parseMonth(period);
    return new Date(y, m - 1, Math.min(day, daysIn(y, m)));
  }
  function fmtDay(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function fmtDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money0(n) { return '$' + Math.round(Number(n || 0)).toLocaleString('en-US'); }
  function num(v) { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/[$,]/g, '')); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })); }
  function unitName(id) { const u = S.units.find((x) => x.id === id); return u ? u.name : 'Whole house'; }
  // Anything other than the whole house is its own place: floors, or another property like Cedarcroft
  function isFloor(name) { return !!name && !/^whole house$/i.test(name.trim()); }
  function wholeId() { return (S.units.find((u) => /^whole house$/i.test((u.name || '').trim())) || S.units.find((u) => !isFloor(u.name)) || {}).id || null; }
  function personalUnit() { return S.units.find((u) => /^personal$/i.test((u.name || '').trim())) || null; }
  function isPersonal(unitId) { const u = personalUnit(); return !!u && u.id === unitId; }
  function billTitle(b) { return b.label ? b.name + ' · ' + b.label : b.name; }
  function payKey(id, period) { return id + '|' + period; }
  function getPay(b, period) { return S.payments[payKey(b.id, period)] || null; }
  function amountFor(b, pay) {
    if (pay && pay.amount != null) return Number(pay.amount);
    if (b.amount_type === 'fixed' && b.default_amount != null) return Number(b.default_amount);
    return null;
  }
  function getRentPay(r, period) { return S.rentPays[payKey(r.id, period)] || null; }
  function rentDue(r, rp) { if (rp && rp.amount_due != null) return Number(rp.amount_due); return r.rent_amount != null ? Number(r.rent_amount) : null; }
  function rentalTitle(r) { return r.tenant_name || unitName(r.unit_id) + ' tenant'; }
  function isNetErr(e) { return !navigator.onLine || /fetch|network|load failed|timeout/i.test((e && (e.message || e.toString())) || ''); }

  // Plain-language error text with one next step
  let audioCtx = null;
  function soundOn() { try { return localStorage.getItem('ds-sound') === '1'; } catch (_) { return false; } }
  function feedback(force) {
    if (navigator.vibrate) navigator.vibrate(12);
    if (!soundOn() && !force) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      [[880, 0], [1320, 0.07]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.09, t0 + d + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.12);
        o.connect(g); g.connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.14);
      });
    } catch (_) {}
  }
  function friendlyErr(e, what) {
    const m = String((e && e.message) || e || '');
    if (!navigator.onLine) return 'You’re offline. Try again when you’re connected.';
    if (/busy|free plan|429/i.test(m)) return 'The AI is busy right now. Try again in a minute.';
    if (/jwt|token|session|sign.?in|401/i.test(m)) return 'Your sign-in expired. Close and reopen the app.';
    if (/fetch|network|load failed|timeout|abort/i.test(m)) return 'Couldn’t reach the server. Check your connection and try again.';
    if (/too large|20 MB|JPEG|PNG/i.test(m)) return m;
    return (what ? 'Couldn’t ' + what + '. ' : 'Something went wrong. ') + 'Try again.';
  }
  let toastTimer;
  let toastUndo = null;
  function toast(msg, undo) {
    const t = document.getElementById('toast');
    toastUndo = typeof undo === 'function' ? undo : null;
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (toastUndo ? '<button type="button" class="toast-undo" data-act="toast-undo">Undo</button>' : '');
    t.classList.toggle('has-undo', !!toastUndo); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('show'); toastUndo = null; }, toastUndo ? 5000 : 2600);
  }
  function runUndo() { const f = toastUndo; toastUndo = null; clearTimeout(toastTimer); document.getElementById('toast').classList.remove('show'); if (f) { f(); render(); } }

  const sv = (d, w) => `<svg width="${w || 22}" height="${w || 22}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    left: sv('<path d="M15 6l-6 6 6 6"/>'),
    right: sv('<path d="M9 6l6 6-6 6"/>'),
    close: sv('<path d="M6 6l12 12M18 6L6 18"/>'),
    camera: sv('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 20),
    plus: sv('<path d="M12 5v14M5 12h14"/>', 24),
    copy: sv('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 14),
    ext: sv('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', 16),
    bills: sv('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    rent: sv('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>'),
    upkeep: sv('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
    personal: sv('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    summary: sv('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/><path d="M16 6V3.5h2.5V8"/>'),
    settings: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')
  };

  // ---------- local cache + offline outbox ----------
  const cacheKey = () => 'ds-cache-' + (S.user ? S.user.id : 'anon');
  const OUTBOX = 'ds-outbox';
  const CACHED = ['notices', 'houses', 'household', 'member', 'units', 'bills', 'payments', 'rentals', 'rentPays', 'tasks', 'logs', 'imports', 'appliances', 'contractors', 'documents', 'leases', 'inspections', 'requests'];
  function saveCache() {
    try { const o = {}; CACHED.forEach((k) => { o[k] = S[k]; }); localStorage.setItem(cacheKey(), JSON.stringify(o)); } catch (_) {}
  }
  function readCache() { try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (_) { return null; } }
  function readOutbox() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch (_) { return []; } }
  function writeOutbox(ob) { try { localStorage.setItem(OUTBOX, JSON.stringify(ob)); } catch (_) {} S.pending = ob.length; }

  function queue(op) { op.qid = uuid(); const ob = readOutbox(); ob.push(op); writeOutbox(ob); saveCache(); flush(); }
  let flushing = false, flushAgain = false;
  async function flush() {
    if (!S.user) return;
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    try {
      for (;;) {
        // Always re-read: new changes may have been queued while the last one was saving.
        const ob = readOutbox();
        if (!ob.length) break;
        const op = ob[0];
        let res;
        try {
          if (op.kind === 'upsert') res = await sb.from(op.table).upsert(op.row, { onConflict: op.onConflict || 'id' });
          else if (op.kind === 'update') res = await sb.from(op.table).update(op.row).match(op.match);
          else if (op.kind === 'delete') res = await sb.from(op.table).delete().eq('id', op.id);
        } catch (e) { res = { error: e }; }
        if (res && res.error) {
          if (isNetErr(res.error)) break;
          console.error(res.error);
          toast('Couldn’t save a change: ' + res.error.message);
        }
        const fresh = readOutbox();
        const i = op.qid ? fresh.findIndex((x) => x.qid === op.qid) : 0;
        if (i >= 0) fresh.splice(i, 1);
        writeOutbox(fresh);
      }
    } finally {
      flushing = false;
      if (flushAgain && navigator.onLine) { flushAgain = false; flush(); }
      renderSoon();
    }
  }

  // ---------- data ----------
  async function loadAll() {
    const cached = readCache();
    if (cached && cached.household) { Object.assign(S, cached); S.rentals = S.rentals || []; S.rentPays = S.rentPays || {}; S.tasks = S.tasks || []; S.logs = S.logs || []; S.appliances = S.appliances || []; S.contractors = S.contractors || []; S.documents = S.documents || []; S.imports = S.imports || []; S.leases = S.leases || []; S.inspections = S.inspections || []; S.requests = S.requests || []; S.view = 'app'; render(); }
    await flush();
    if (readOutbox().length) return; // still offline; keep local copy
    try {
      const mem = await sb.from('household_members').select('*, households(*)').eq('user_id', S.user.id).order('created_at');
      if (mem.error) throw mem.error;
      if (!mem.data.length) { S.view = 'join'; render(); return; }
      S.houses = mem.data.map((x) => ({ id: x.household_id, name: x.households ? x.households.name : 'Property', address: x.households ? x.households.address : null }));
      let pick = null; try { pick = localStorage.getItem('ds-house'); } catch (_) {}
      const m = mem.data.find((x) => x.household_id === pick) || mem.data[0];
      const hid = m.household_id;
      const since = addMonths(monthKey(new Date()), -12);
      const res = await Promise.all([
        sb.from('units').select('*').eq('household_id', hid).order('sort'),
        sb.from('bills').select('*').eq('household_id', hid).order('created_at'),
        sb.from('payments').select('*').eq('household_id', hid).gte('period', since),
        sb.from('rentals').select('*').eq('household_id', hid).order('created_at'),
        sb.from('rent_payments').select('*').eq('household_id', hid).gte('period', since),
        sb.from('maintenance_tasks').select('*').eq('household_id', hid).order('created_at'),
        sb.from('maintenance_log').select('*').eq('household_id', hid).order('done_on', { ascending: false }).limit(500),
        sb.from('email_imports').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(40),
        sb.from('appliances').select('*').eq('household_id', hid).order('created_at'),
        sb.from('contractors').select('*').eq('household_id', hid).order('name'),
        sb.from('documents').select('*').eq('household_id', hid).order('created_at', { ascending: false }),
        sb.from('lease_history').select('*').eq('household_id', hid).order('lease_end', { ascending: false }),
        sb.from('inspections').select('*').eq('household_id', hid).order('done_on', { ascending: false }),
        sb.from('repair_requests').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(100),
        sb.from('rent_notices').select('*').eq('household_id', hid).eq('status', 'pending').order('created_at', { ascending: false })
      ]);
      res.forEach((r) => { if (r.error) throw r.error; });
      const [u, b, p, r, rp, t, l, im, ap, co, dc, lh, ins, rq, nt] = res.map((x) => x.data);
      S.notices = nt || [];
      S.household = m.households; delete m.households; S.member = m;
      S.units = u; S.bills = b; S.rentals = r; S.tasks = t; S.logs = l; S.imports = im; S.appliances = ap; S.contractors = co; S.documents = dc; S.leases = lh; S.inspections = ins; S.requests = rq;
      S.payments = {}; p.forEach((x) => { S.payments[payKey(x.bill_id, x.period)] = x; });
      S.rentPays = {}; rp.forEach((x) => { S.rentPays[payKey(x.rental_id, x.period)] = x; });
      saveCache();
      S.view = 'app';
      render();
      checkPush();
    } catch (e) {
      if (!cached) { S.view = 'app'; render(); }
      toast(isNetErr(e) ? 'Offline — showing your saved copy' : 'Couldn’t load your house. Pull down to try again.');
    }
  }

  function upsertLocal(list, row) { const i = list.findIndex((x) => x.id === row.id); if (i >= 0) list[i] = row; else list.push(row); }
  function savePayment(b, period, fields) {
    if ('amount' in fields && !('source' in fields)) fields = Object.assign({ source: 'manual' }, fields);
    const existing = getPay(b, period);
    const d = dueOn(b.due_day, period);
    const row = Object.assign({
      id: uuid(), household_id: S.household.id, bill_id: b.id, period: period,
      amount: null, due_date: null, paid_at: null, method: null, confirmation: null, note: null, receipt_path: null
    }, existing || {}, fields, { updated_at: new Date().toISOString() });
    row.due_date = d ? isoDate(d) : null;
    S.payments[payKey(b.id, period)] = row;
    queue({ kind: 'upsert', table: 'payments', row: row, onConflict: 'bill_id,period' });
  }
  function saveBill(b) { upsertLocal(S.bills, b); queue({ kind: 'upsert', table: 'bills', row: b }); }
  function deleteBill(id) {
    S.bills = S.bills.filter((x) => x.id !== id);
    Object.keys(S.payments).forEach((k) => { if (k.startsWith(id + '|')) delete S.payments[k]; });
    queue({ kind: 'delete', table: 'bills', id: id });
  }
  function saveRental(r) { upsertLocal(S.rentals, r); queue({ kind: 'upsert', table: 'rentals', row: r }); }
  function deleteRental(id) {
    S.rentals = S.rentals.filter((x) => x.id !== id);
    Object.keys(S.rentPays).forEach((k) => { if (k.startsWith(id + '|')) delete S.rentPays[k]; });
    queue({ kind: 'delete', table: 'rentals', id: id });
  }
  function saveRentPay(r, period, fields) {
    const existing = getRentPay(r, period);
    const row = Object.assign({
      id: uuid(), household_id: S.household.id, rental_id: r.id, period: period,
      amount_due: r.rent_amount, amount_received: null, received_at: null, method: null, note: null
    }, existing || {}, fields, { updated_at: new Date().toISOString() });
    S.rentPays[payKey(r.id, period)] = row;
    queue({ kind: 'upsert', table: 'rent_payments', row: row, onConflict: 'rental_id,period' });
  }
  const TABLES = { appliances: 'appliances', contractors: 'contractors', documents: 'documents', leases: 'lease_history', inspections: 'inspections', requests: 'repair_requests' };
  function saveRow(list, row) { upsertLocal(S[list], row); queue({ kind: 'upsert', table: TABLES[list], row }); }
  function deleteRow(list, id) { S[list] = S[list].filter((x) => x.id !== id); queue({ kind: 'delete', table: TABLES[list], id }); }
  function saveTask(t) { upsertLocal(S.tasks, t); queue({ kind: 'upsert', table: 'maintenance_tasks', row: t }); }
  function deleteTask(id) { S.tasks = S.tasks.filter((x) => x.id !== id); queue({ kind: 'delete', table: 'maintenance_tasks', id: id }); }
  function saveLog(l) { upsertLocal(S.logs, l); S.logs.sort((a, b) => (b.done_on || '').localeCompare(a.done_on || '')); queue({ kind: 'upsert', table: 'maintenance_log', row: l }); }
  function deleteLog(id) { S.logs = S.logs.filter((x) => x.id !== id); queue({ kind: 'delete', table: 'maintenance_log', id: id }); }

  // ---------- derived ----------
  function dueInMonth(b, period) { return !b.due_months || !b.due_months.length || b.due_months.includes(parseMonth(period).m); }
  function monthsLabel(b) { return b.due_months && b.due_months.length ? b.due_months.slice().sort((x, y) => x - y).map((m) => MONTH_NAMES[m - 1]).join(' & ') : ''; }
  function statusFor(b, pay, period) {
    const amt = amountFor(b, pay);
    const due = dueOn(b.due_day, period);
    if (b.escrow) return { k: 'auto', label: 'Paid from escrow' + (due ? ' · ' + fmtDay(due) : '') };
    if (pay && pay.paid_at) return { k: 'paid', label: 'Paid ' + fmtDay(new Date(pay.paid_at)) };
    if (!due || amt == null) return { k: 'setup', label: 'Needs details' };
    const diff = dayDiff(due);
    if (b.autopay) return { k: 'auto', label: (diff < 0 ? 'Autopay · was due ' : 'Autopay · ') + fmtDay(due) };
    if (diff < 0) return { k: 'late', label: 'Overdue · ' + (diff === -1 ? 'since yesterday' : -diff + ' days late') + ' (' + fmtDay(due) + ')' };
    if (diff === 0) return { k: 'late', label: 'Due today' };
    if (diff === 1) return { k: 'soon', label: 'Due tomorrow' };
    if (diff <= 6) return { k: diff <= 5 ? 'soon' : 'up', label: 'Due ' + due.toLocaleDateString('en-US', { weekday: 'long' }) + ' · in ' + diff + ' days' };
    return { k: 'up', label: 'Due ' + due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) };
  }
  function unitMatch(unitId) {
    if (isPersonal(unitId)) return false;
    if (S.unit === 'all') return true;
    const n = unitName(unitId);
    if (S.unit === 'shared') return !isFloor(n);
    return unitId === S.unit;
  }
  function billMonth(period, all) {
    const bills = S.bills.filter((b) => b.active !== false && dueInMonth(b, period)).filter((b) => all || unitMatch(b.unit_id));
    let total = 0, paid = 0, overdue = 0, overdueAmt = 0, setup = 0;
    const rows = bills.map((b) => {
      const pay = getPay(b, period);
      const st = statusFor(b, pay, period);
      const amt = amountFor(b, pay);
      if (!b.escrow) total += amt || 0;
      if (pay && pay.paid_at && !b.escrow) paid += amt || 0;
      if (st.label.startsWith('Overdue')) { overdue++; overdueAmt += amt || 0; }
      if (st.k === 'setup') setup++;
      return { b, pay, st, amt, due: dueOn(b.due_day, period) };
    });
    rows.sort((a, c) => (a.due ? a.due.getTime() : 9e15) - (c.due ? c.due.getTime() : 9e15));
    return { rows, total, paid, overdue, overdueAmt, setup };
  }
  // Higher than usual: 30%+ and $20+ above this bill's average over the previous 6 months
  function spikeLabel(b, amt) {
    if (amt == null || b.amount_type === 'fixed' || b.category === 'Mortgage') return '';
    const vals = [];
    for (let i = 1; i <= 6; i++) { const p = getPay(b, addMonths(S.month, -i)); if (p && p.amount != null && Number(p.amount) > 0) vals.push(Number(p.amount)); }
    if (vals.length < 2) return '';
    const avg = vals.reduce((t, n) => t + n, 0) / vals.length;
    return amt > avg * 1.3 && amt - avg >= 20 ? '↑ ' + Math.round((amt / avg - 1) * 100) + '% vs usual ' + money0(avg) : '';
  }
  // Same bill, same month last year
  function lastYear(b, period) { const p = getPay(b, addMonths(period, -12)); return p && p.amount != null ? Number(p.amount) : null; }
  function yoyLabel(b, amt, period) {
    const k = period || S.month; const ly = lastYear(b, k);
    if (amt == null || ly == null || !ly || b.category === 'Mortgage' || b.amount_type === 'fixed') return '';
    const d = Math.round((amt / ly - 1) * 100);
    return (d === 0 ? 'Same as' : (d > 0 ? '↑ ' + d + '% vs ' : '↓ ' + Math.abs(d) + '% vs ')) + monthLabel(addMonths(k, -12), true) + ' ' + addMonths(k, -12).slice(0, 4) + ' (' + money0(ly) + ')';
  }
  // Heating degree days for the usage month (the month before the bill), this year vs last year, from Open-Meteo
  S.hdd = {};
  function hddKey(period) { return addMonths(period, -1); }
  async function loadHdd(period) {
    const h = S.household; if (!h || h.lat == null) return;
    const months = [hddKey(period), addMonths(hddKey(period), -12)];
    for (const m of months) {
      if (S.hdd[m] !== undefined) continue;
      S.hdd[m] = null;
      const { y, m: mm } = parseMonth(m);
      const end = new Date(y, mm, 0); const last = end > today() ? new Date(today().getTime() - 5 * 86400000) : end;
      if (last < new Date(y, mm - 1, 1)) continue;
      try {
        const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${h.lat}&longitude=${h.lon}&start_date=${m}&end_date=${isoDate(last)}&daily=temperature_2m_mean&temperature_unit=fahrenheit&timezone=America%2FNew_York`);
        const j = await r.json();
        const t = (j.daily && j.daily.temperature_2m_mean) || [];
        S.hdd[m] = { hdd: t.reduce((a, v) => a + (v == null ? 0 : Math.max(0, 65 - v)), 0), days: t.length };
      } catch (_) { /* offline: skip */ }
    }
    renderSoon();
  }
  function yoyBlock(b, amt) {
    if (b.category === 'Mortgage' || b.amount_type === 'fixed') return '';
    const ly = lastYear(b, S.month);
    const heat = b.category === 'Gas' || b.category === 'Electric';
    if (heat) loadHdd(S.month);
    const a = S.hdd[hddKey(S.month)], c = S.hdd[addMonths(hddKey(S.month), -12)];
    let weather = '';
    if (heat && a && c && a.days && c.days && c.hdd > 0) {
      const ha = a.hdd * (30 / a.days), hc = c.hdd * (30 / c.days);
      const wd = Math.round((ha / hc - 1) * 100);
      weather = `<p class="small">${monthLabel(hddKey(S.month), true)} was <strong>${Math.abs(wd)}% ${wd >= 0 ? 'colder' : 'milder'}</strong> than last year (heating degree days ${Math.round(ha)} vs ${Math.round(hc)}).`;
      if (ly && amt != null) {
        const adj = (amt / ly) / (ha / hc);
        const ad = Math.round((adj - 1) * 100);
        weather += ` Adjusted for weather, this bill is <strong>${ad === 0 ? 'about the same' : Math.abs(ad) + '% ' + (ad > 0 ? 'higher' : 'lower')}</strong>${ad > 15 ? ', worth a look' : ''}.`;
      }
      weather += '</p>';
    }
    if (!ly && !weather) return heat ? '<p class="small muted">Year-over-year comparison appears once there’s a bill from the same month last year.</p>' : '';
    return `<div class="stack" style="gap:4px;padding-top:8px;border-top:1px solid var(--line-2)"><span class="lab small">Compared with last year</span>
      ${ly ? `<p class="small">${monthLabel(addMonths(S.month, -12))}: <strong class="num">${money(ly)}</strong>${amt != null ? ' · now ' + money(amt) + ' (' + yoyLabel(b, amt).split(' (')[0] + ')' : ''}</p>` : ''}${weather}</div>`;
  }
  function shrinkImage(file, max) {
    return new Promise((resolve) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function matchScanned(x) {
    const acct = (x.account_number || '').replace(/\D/g, '');
    const live = S.bills.filter((b) => b.active !== false);
    if (acct.length >= 4) {
      const hit = live.filter((b) => { const n = (b.account_number || '').replace(/\D/g, ''); return n && (n === acct || n.endsWith(acct.slice(-6)) || acct.endsWith(n.slice(-6))); });
      if (hit.length === 1) return hit[0];
    }
    const prov = (x.provider || '').toLowerCase().split(/\s+/)[0];
    if (prov && prov.length > 2) { const hit = live.filter((b) => b.name.toLowerCase().includes(prov)); if (hit.length === 1) return hit[0]; }
    return null;
  }
  async function assist(body) {
    if (!navigator.onLine) throw new Error('You’re offline. Try again when you’re connected.');
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) throw new Error('Your sign-in expired. Close and reopen the app.');
    const r = await fetch(CFG.SUPABASE_URL + '/functions/v1/assist', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: CFG.SUPABASE_ANON_KEY }, body: JSON.stringify(Object.assign({ today: isoDate(today()) }, body)) })
      .catch((e) => { throw new Error(friendlyErr(e)); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = j.error || '';
      throw new Error(j.limit ? j.error : r.status === 429 || j.busy ? 'The AI is busy right now. Try again in a minute.' : r.status === 401 ? 'Your sign-in expired. Close and reopen the app.' : (!m || /Groq|unavailable right now|Unknown mode/.test(m)) ? 'The AI couldn’t answer just now. Try again.' : m);
    }
    return j;
  }

  // ===== #1 Quick add =====
  function quickContext() {
    return {
      bills: S.bills.filter((b) => b.active !== false).map((b) => ({ id: b.id, name: billTitle(b), unit: unitName(b.unit_id), category: b.category, due_day: b.due_day })),
      rentals: S.rentals.filter((r) => r.active !== false).map((r) => ({ id: r.id, tenant: r.tenant_name || null, unit: unitName(r.unit_id), rent: r.rent_amount })),
      tasks: S.tasks.filter((t) => t.active !== false).map((t) => ({ id: t.id, title: t.title, unit: unitName(t.unit_id) })),
      units: S.units.map((u) => ({ id: u.id, name: u.name })), contractors: S.contractors.map((c) => c.name)
    };
  }
  function describeAction(a) {
    const b = a.bill_id && S.bills.find((x) => x.id === a.bill_id), r = a.rental_id && S.rentals.find((x) => x.id === a.rental_id), t = a.task_id && S.tasks.find((x) => x.id === a.task_id);
    const d = (x) => x ? fmtDay(fromIso(x)) : 'today';
    if (a.type === 'bill_paid' && b) return { ok: true, text: `Mark <strong>${esc(billTitle(b))}</strong> (${esc(unitName(b.unit_id))}) paid${a.amount != null ? ' · ' + money(a.amount) : ''} · ${d(a.date)}` };
    if (a.type === 'bill_amount' && b) return { ok: true, text: `Set <strong>${esc(billTitle(b))}</strong> (${esc(unitName(b.unit_id))}) to ${money(a.amount)}${a.due_date ? ' · due ' + d(a.due_date) : ''}` };
    if (a.type === 'rent_received' && r) return { ok: true, text: `Rent from <strong>${esc(rentalTitle(r))}</strong>${a.amount != null ? ' · ' + money(a.amount) : ' · full amount'} · ${d(a.date)}${a.method ? ' · ' + esc(a.method) : ''}` };
    if (a.type === 'task_done' && t) return { ok: true, text: `Done: <strong>${esc(t.title)}</strong> · ${d(a.date)}${a.cost != null ? ' · ' + money(a.cost) : ''}${a.vendor ? ' · ' + esc(a.vendor) : ''}` };
    if (a.type === 'repair' && a.title) return { ok: true, text: `Log repair: <strong>${esc(a.title)}</strong> · ${d(a.date)}${a.cost != null ? ' · ' + money(a.cost) : ''}${a.vendor ? ' · ' + esc(a.vendor) : ''}` };
    return { ok: false, text: 'Couldn’t match one item' };
  }
  function applyAction(a) {
    const iso = a.date || isoDate(today());
    const at = (x) => new Date((x || iso) + 'T12:00:00').toISOString();
    if (a.type === 'bill_paid') { const b = S.bills.find((x) => x.id === a.bill_id); if (!b) return; const k = monthKey(fromIso(iso)); const pay = getPay(b, k); savePayment(b, k, { paid_at: at(), amount: a.amount != null ? a.amount : amountFor(b, pay) }); }
    else if (a.type === 'bill_amount') { const b = S.bills.find((x) => x.id === a.bill_id); if (!b) return; const k = a.due_date ? monthKey(fromIso(a.due_date)) : S.month; savePayment(b, k, { amount: a.amount }); if (a.due_date && !b.due_day) saveBill(Object.assign({}, b, { due_day: +a.due_date.slice(8, 10) })); }
    else if (a.type === 'rent_received') {
      const r = S.rentals.find((x) => x.id === a.rental_id); if (!r) return; const k = monthKey(fromIso(iso)); const rp = getRentPay(r, k); const due = rentDue(r, rp);
      const add = a.amount != null ? a.amount : Math.max(0, (due || 0) - Number((rp && rp.amount_received) || 0));
      saveRentPay(r, k, { amount_due: due, amount_received: Math.round((Number((rp && rp.amount_received) || 0) + add) * 100) / 100, received_at: at(), method: a.method || (rp && rp.method) || null });
    } else if (a.type === 'task_done') {
      const t = S.tasks.find((x) => x.id === a.task_id); if (!t) return;
      saveLog({ id: uuid(), household_id: S.household.id, task_id: t.id, unit_id: t.unit_id, title: t.title, done_on: iso, cost: a.cost != null ? a.cost : null, vendor: a.vendor || null, notes: null, receipt_path: null, created_at: new Date().toISOString() });
      const nt = Object.assign({}, t, { last_done: iso, vendor: a.vendor || t.vendor });
      if (t.interval_months) nt.next_due = addMonthsIso(iso, t.interval_months); else { nt.next_due = null; nt.active = false; }
      saveTask(nt);
    } else if (a.type === 'repair') {
      saveLog({ id: uuid(), household_id: S.household.id, task_id: null, unit_id: a.unit_id && S.units.some((u) => u.id === a.unit_id) ? a.unit_id : wholeId(), title: String(a.title).slice(0, 120), done_on: iso, cost: a.cost != null ? a.cost : null, vendor: a.vendor || null, notes: null, receipt_path: null, created_at: new Date().toISOString() });
    }
  }
  function quickCard() {
    const q = S.quick || {};
    const acts = (q.actions || []).map(describeAction);
    const okCount = acts.filter((x) => x.ok).length;
    const mic = ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) ? `<button type="button" class="iconbtn micbtn${S.listening ? ' on' : ''}" data-act="mic" aria-label="${S.listening ? 'Stop listening' : 'Speak instead of typing'}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>` : '';
    return `<section class="quick" aria-label="Quick add">
      <form class="row" data-form="quick" style="gap:6px">
        <label for="qa-text" class="sr">Quick add</label>
        <input class="input" id="qa-text" name="text" placeholder="e.g. paid electric $96" value="${esc(q.text || '')}" autocomplete="off" enterkeyhint="go" style="flex:1;min-width:0">
        ${mic}<label class="iconbtn cambtn" aria-label="Scan a paper bill" title="Scan a paper bill"><input type="file" accept="image/*" capture="environment" class="sr" data-change="scan-bill">${ICON.camera}</label>
        <button class="btn primary-soft" type="submit" ${q.busy ? 'disabled' : ''}>${q.busy ? '…' : 'Add'}</button>
      </form>
      ${q.error ? `<p class="err">${esc(q.error)}</p>` : ''}
      ${q.actions ? `<div class="quick-confirm">
        ${acts.length ? `<ul class="quick-list">${acts.map((x) => `<li class="${x.ok ? '' : 'bad'}">${x.text}</li>`).join('')}</ul>` : ''}
        ${q.note ? `<p class="small muted">${esc(q.note)}</p>` : ''}
        <div class="btns">${okCount ? `<button class="btn primary-soft" data-act="quick-apply" style="flex:1">Save ${okCount === 1 ? 'it' : 'all ' + okCount}</button>` : ''}<button class="btn" data-act="quick-cancel" style="flex:1">${okCount ? 'Cancel' : 'OK'}</button></div>
      </div>` : ''}
    </section>`;
  }

  // ===== #2 Ask your house =====
  function askContext() {
    const out = { today: isoDate(today()), places: S.units.map((u) => ({ name: u.name, home_not_rental: !!u.exclude_from_tax })), bills: [], rent: [], upkeep_log: [], upkeep_tasks: [], appliances: [], mortgage: null };
    S.bills.filter((b) => b.active !== false).forEach((b) => {
      const months = {};
      Object.values(S.payments).filter((p) => p.bill_id === b.id).sort((x, y) => x.period.localeCompare(y.period)).forEach((p) => { months[p.period.slice(0, 7)] = { amount: amountFor(b, p), paid: p.paid_at ? p.paid_at.slice(0, 10) : null }; });
      out.bills.push({ name: billTitle(b), place: unitName(b.unit_id), category: b.category, due_day: b.due_day, fixed: b.amount_type === 'fixed', escrow: !!b.escrow, autopay: !!b.autopay, months });
    });
    S.rentals.forEach((r) => {
      const months = {};
      Object.values(S.rentPays).filter((p) => p.rental_id === r.id).sort((x, y) => x.period.localeCompare(y.period)).forEach((p) => { months[p.period.slice(0, 7)] = { due: p.amount_due, received: p.amount_received, on: p.received_at ? p.received_at.slice(0, 10) : null, method: p.method }; });
      out.rent.push({ tenant: r.tenant_name, place: unitName(r.unit_id), rent: r.rent_amount, due_day: r.due_day, grace_days: r.grace_days, lease_start: r.lease_start, lease_end: r.lease_end, deposit: r.deposit, active: r.active !== false, months });
    });
    S.logs.slice(0, 200).forEach((l) => out.upkeep_log.push({ title: l.title, date: l.done_on, cost: l.cost, vendor: l.vendor, place: unitName(l.unit_id) }));
    S.tasks.filter((t) => t.active !== false).forEach((t) => out.upkeep_tasks.push({ title: t.title, every_months: t.interval_months, last_done: t.last_done, next_due: t.next_due }));
    S.appliances.forEach((a) => out.appliances.push({ name: a.name, kind: a.kind, brand: a.brand, installed: a.installed_on, warranty_until: a.warranty_until, place: unitName(a.unit_id) }));
    const m = S.bills.find((b) => b.category === 'Mortgage' && b.active !== false);
    if (m) out.mortgage = { name: m.name, balance: m.loan_balance, rate_pct: m.loan_rate, home_value: m.home_value, monthly: m.default_amount };
    return out;
  }
  const ASK_SUGGEST = ['How much did gas cost last winter?', 'Which tenant paid late most often?', 'What did I spend on repairs this year?', 'When was the boiler last serviced?', 'What’s coming due in the next 2 weeks?'];
  // ===== #3 Snap a receipt =====
  async function scanReceipt(file) {
    if (!file) return;
    toast('Reading the receipt…');
    const image = await shrinkImage(file, 1600);
    if (!image) return toast('Couldn’t open that photo.');
    let x;
    try { x = await assist({ mode: 'receipt', image, type: 'image/jpeg' }); } catch (e) { return toast(e.message); }
    if (x.total == null && !x.vendor) return toast('Couldn’t read that receipt. Try a flatter, brighter photo.');
    S.receiptDraft = { file, title: x.summary || (x.vendor ? 'Purchase at ' + x.vendor : 'Repair'), done_on: x.date || isoDate(today()), cost: x.total, vendor: x.vendor, confidence: x.confidence };
    S.tab = 'upkeep'; S.upkeepView = 'history'; openSheet('new-log');
    toast('Check the details and save.');
  }

  // ===== #14 Payoff planner =====
  function amort(B, rPct, P) {
    const r = rPct / 1200;
    if (!(B > 0) || !(P > 0)) return null;
    if (r === 0) return { n: Math.ceil(B / P), interest: 0 };
    if (P <= B * r) return { n: Infinity, interest: Infinity };
    const n = -Math.log(1 - (r * B) / P) / Math.log(1 + r);
    const months = Math.ceil(n);
    return { n: months, interest: Math.max(0, months * P - B) };
  }
  function payment(B, rPct, n) { const r = rPct / 1200; return r === 0 ? B / n : (B * r) / (1 - Math.pow(1 + r, -n)); }
  function plusMonths(n) { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
  function yrsMo(n) { const y = Math.floor(n / 12), m = n % 12; return (y ? y + ' yr' + (y > 1 ? 's' : '') : '') + (y && m ? ' ' : '') + (m ? m + ' mo' : (y ? '' : '0 mo')); }
  function payoffSheet() {
    const m = S.bills.find((b) => b.category === 'Mortgage' && b.active !== false) || {};
    const latest = Object.values(S.payments).filter((p) => p.bill_id === m.id && (p.principal != null || p.balance_after != null)).sort((x, y) => y.period.localeCompare(x.period))[0];
    const P0 = S.payoff || {};
    const B = P0.B != null ? P0.B : (latest && latest.balance_after != null ? Number(latest.balance_after) : (m.loan_balance != null ? Number(m.loan_balance) : null));
    const R = P0.R != null ? P0.R : (m.loan_rate != null ? Number(m.loan_rate) : null);
    const PI = P0.PI != null ? P0.PI : (latest && latest.principal != null && latest.interest != null ? Number(latest.principal) + Number(latest.interest) : null);
    const E = P0.E || 0, L = P0.L || 0, NR = P0.NR != null ? P0.NR : null, CC = P0.CC != null ? P0.CC : null, NT = P0.NT || 30;
    const base = B && R != null && PI ? amort(B, R, PI) : null;
    const plan = base ? amort(Math.max(0, B - L), R, PI + E) : null;
    let results = '<p class="notice info">Enter the loan balance, rate and the principal + interest part of your monthly payment (from your mortgage statement, not counting escrow).</p>';
    if (base && base.n === Infinity) results = '<p class="notice">That payment doesn’t cover the interest. Check the numbers.</p>';
    else if (base && plan) {
      const saved = base.interest - plan.interest, sooner = base.n - plan.n;
      results = `<div class="grid2">
        <div class="stat"><span class="small muted">Paid off now</span><span class="v display">${plusMonths(base.n)}</span><span class="small muted">${yrsMo(base.n)} · interest ${money0(base.interest)}</span></div>
        <div class="stat"><span class="small muted">With your extra</span><span class="v display">${plusMonths(plan.n)}</span><span class="small muted">${yrsMo(plan.n)} · interest ${money0(plan.interest)}</span></div>
      </div>
      ${E || L ? `<p class="ok">You’d save <strong>${money0(saved)}</strong> in interest and finish <strong>${yrsMo(sooner)}</strong> sooner.</p>` : '<p class="small muted">Add an extra monthly amount or a lump sum to see the savings.</p>'}`;
    }
    let refi = '';
    if (B && PI && NR != null && NR > 0) {
      const newP = payment(B, NR, NT * 12);
      const diff = PI - newP;
      const nb = base && base.n !== Infinity ? base : null;
      const newInterest = newP * NT * 12 - B + (CC || 0);
      refi = `<div class="grid2">
        <div class="stat"><span class="small muted">New P&amp;I</span><span class="v display num">${money(newP)}</span><span class="small muted">${diff >= 0 ? money(diff) + ' less' : money(-diff) + ' more'} a month</span></div>
        <div class="stat"><span class="small muted">Break-even</span><span class="v display">${diff > 0 && CC ? Math.ceil(CC / diff) + ' mo' : diff > 0 ? 'Right away' : 'Never'}</span><span class="small muted">${diff > 0 && CC ? 'to recover ' + money0(CC) + ' costs' : ''}</span></div>
      </div>
      ${nb ? `<p class="small">Total interest + costs: <strong>${money0(newInterest)}</strong> over ${NT} years vs <strong>${money0(nb.interest)}</strong> left on your current loan.${newInterest > nb.interest ? ' Lower payment, but more interest overall.' : ''}</p>` : ''}`;
    }
    const nInp = (id, k, v, ph, extra) => `<input class="input num" id="${id}" inputmode="decimal" placeholder="${ph}" value="${v == null ? '' : v}" data-change="payoff" data-k="${k}" ${extra || ''}>`;
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">Payoff planner</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <section class="card"><h2>Your loan today</h2>
        <div class="grid2">${f('po-b', 'Balance ($)', nInp('po-b', 'B', B, '0'))}${f('po-r', 'Rate (%)', nInp('po-r', 'R', R, '6.25'))}</div>
        ${f('po-pi', 'Monthly principal + interest ($)', nInp('po-pi', 'PI', PI != null ? Math.round(PI * 100) / 100 : null, 'not escrow'))}
      </section>
      <section class="card"><h2>Pay it off faster</h2>
        <div class="grid2">${f('po-e', 'Extra each month ($)', nInp('po-e', 'E', E || null, '200'))}${f('po-l', 'One-time lump sum ($)', nInp('po-l', 'L', L || null, '5000'))}</div>
        ${results}
      </section>
      <section class="card"><h2>Refinance check</h2>
        <div class="grid2">${f('po-nr', 'New rate (%)', nInp('po-nr', 'NR', NR, '5.5'))}${f('po-cc', 'Closing costs ($)', nInp('po-cc', 'CC', CC, '6000'))}</div>
        <div class="field"><span class="lab">New term</span><div class="seg">${[30, 20, 15].map((t) => `<button type="button" data-act="payoff-term" data-t="${t}" aria-pressed="${NT === t}">${t} years</button>`).join('')}</div></div>
        ${refi || '<p class="small muted">Enter a new rate to compare.</p>'}
      </section>
      <p class="small muted">Estimates only. Ask your lender about prepayment rules and apply extra payments to principal.</p>
    </div></div>`;
  }

  async function scanBill(file) {
    if (!file) return;
    if (!navigator.onLine) return toast('Connect to the internet to scan.');
    toast('Reading the bill…');
    const image = await shrinkImage(file, 1600);
    if (!image) return toast('Couldn’t open that photo.');
    const { data } = await sb.auth.getSession();
    let x;
    try {
      const r = await fetch(CFG.SUPABASE_URL + '/functions/v1/scan-bill', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: CFG.SUPABASE_ANON_KEY }, body: JSON.stringify({ image, type: 'image/jpeg' }) });
      x = await r.json();
      if (!r.ok) return toast(x.error || 'Couldn’t read the bill.');
    } catch (e) { return toast(friendlyErr(e, 'read the bill')); }
    if (x.amount_due == null && !x.due_date && !x.account_number) return toast('Couldn’t read that bill. Try a flatter, brighter photo.');
    const b = matchScanned(x);
    S.scan = Object.assign({ file }, x, { billId: b ? b.id : null });
    if (x.due_date) S.month = monthKey(fromIso(x.due_date));
    S.tab = 'bills';
    if (b) openSheet('bill', b.id); else openSheet('new-bill');
    toast(b ? 'Matched ' + billTitle(b) + '. Check and save.' : 'New bill. Check the details and save.');
  }
  function spark(b) {
    if (b.amount_type === 'fixed' || b.category === 'Mortgage') return '';
    const v = []; for (let i = 5; i >= 0; i--) { const p = getPay(b, addMonths(S.month, -i)); v.push(p && p.amount != null ? Number(p.amount) : null); }
    const pts = v.map((n, i) => [i, n]).filter((x) => x[1] != null);
    if (pts.length < 3) return '';
    const vals = pts.map((x) => x[1]); const max = Math.max(...vals), min = Math.min(...vals);
    const xy = pts.map(([i, n]) => [4 + i * 16, 30 - ((n - min) / ((max - min) || 1)) * 24]);
    const last = vals[vals.length - 1], avg = vals.slice(0, -1).reduce((t, n) => t + n, 0) / (vals.length - 1);
    const hot = last > avg * 1.3 && last - avg >= 20;
    const L = xy[xy.length - 1];
    return `<svg class="spark${hot ? ' hot' : ''}" width="88" height="34" viewBox="0 0 88 34" role="img" aria-label="${esc(billTitle(b))}, last ${pts.length} months: ${vals.map((n) => '$' + Math.round(n)).join(', ')}">
      <polyline points="${xy.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ')}"/><circle cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="3"/></svg>`;
  }
  // On-time streaks, counted back from the most recent finished month
  function rentOnTime(r, k) {
    const rp = getRentPay(r, k); const due = rentDue(r, rp);
    if (due == null || !rp || !rp.received_at || Number(rp.amount_received || 0) < due) return false;
    const d = dueOn(r.due_day, k); const limit = new Date(d.getTime() + ((r.grace_days || 0) + 1) * 86400000);
    return new Date(rp.received_at) < limit;
  }
  function rentStreak(r) {
    let n = 0, k = monthKey(new Date());
    if (!rentOnTime(r, k)) k = addMonths(k, -1);
    for (let i = 0; i < 24; i++, k = addMonths(k, -1)) { if (r.lease_start && k < r.lease_start.slice(0, 7) + '-01') break; if (rentOnTime(r, k)) n++; else break; }
    return n;
  }
  function billsOnTime(k) {
    const rows = billMonth(k, true).rows.filter((x) => !x.b.escrow && x.due && x.amt);
    if (!rows.length) return null;
    return rows.every((x) => x.pay && x.pay.paid_at && new Date(x.pay.paid_at) < new Date(x.due.getTime() + 86400000));
  }
  function billsStreak() {
    let n = 0, k = addMonths(monthKey(new Date()), -1);
    if (billsOnTime(monthKey(new Date())) === true) { n = 1; }
    for (let i = 0; i < 24; i++, k = addMonths(k, -1)) { const t = billsOnTime(k); if (t === true) n++; else break; }
    return n;
  }
  function streakDots(n) { return `<span class="sdots" aria-hidden="true">${Array.from({ length: 6 }, (_, i) => `<i class="${i >= 6 - Math.min(n, 6) ? 'on' : ''}" style="animation-delay:${i * 0.06}s"></i>`).join('')}</span>`; }
  // ===== #7 Explain a bill =====
  S.explain = {};
  function explainContext(b, amt) {
    const months = {};
    for (let i = 13; i >= 1; i--) { const k = addMonths(S.month, -i); const p = getPay(b, k); if (p && p.amount != null) months[k.slice(0, 7)] = Number(p.amount); }
    const a = S.hdd[hddKey(S.month)], c = S.hdd[addMonths(hddKey(S.month), -12)];
    return {
      bill: { name: b.name, category: b.category, place: unitName(b.unit_id), autopay: !!b.autopay },
      this_month: { period: S.month.slice(0, 7), amount: amt },
      same_month_last_year: lastYear(b, S.month), months,
      hdd_usage_month: a && c && a.days && c.days ? { month: hddKey(S.month).slice(0, 7), this_year: Math.round(a.hdd * 30 / a.days), last_year: Math.round(c.hdd * 30 / c.days) } : null,
      notes: (getPay(b, S.month) || {}).note || null
    };
  }
  function explainBlock(b, amt) {
    if (b.amount_type === 'fixed' || b.category === 'Mortgage' || amt == null) return '';
    const key = b.id + '|' + S.month; const x = S.explain[key];
    if (!x) return `<button type="button" class="btn askmini" data-act="explain" data-id="${b.id}"><span class="askicon" aria-hidden="true">✦</span> ${spikeLabel(b, amt) ? 'Why is this higher?' : 'Explain this bill'}</button>`;
    if (x.busy) return '<div class="explain"><div class="msg assistant typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>';
    if (x.error) return `<p class="err">${esc(x.error)}</p>`;
    return `<div class="explain" aria-live="polite"><strong>${esc(x.headline || '')}</strong>
      ${(x.reasons || []).length ? `<span class="lab small">Likely why</span><ul>${x.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${(x.checks || []).length ? `<span class="lab small">Worth checking</span><ul>${x.checks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <span class="small muted">AI estimate from your history and the weather. It can be wrong.</span></div>`;
  }
  async function explainBill(id) {
    const b = S.bills.find((x) => x.id === id); if (!b) return;
    const pay = getPay(b, S.month); const amt = amountFor(b, pay);
    if (b.category === 'Gas' || b.category === 'Electric') { await loadHdd(S.month); }
    const key = b.id + '|' + S.month;
    S.explain[key] = { busy: true }; renderSoon();
    try { S.explain[key] = await assist({ mode: 'explain', context: explainContext(b, amt) }); }
    catch (e) { S.explain[key] = { error: e.message }; }
    renderSoon();
  }

  // ===== #9 Monthly recap =====
  function recapKey(k) { return 'ds-recap-' + (S.household ? S.household.id : '') + '-' + k; }
  function readRecap(k) { try { return JSON.parse(localStorage.getItem(recapKey(k)) || 'null'); } catch (_) { return null; } }
  function recapContext(k) {
    const rm = rentMonth(k), md = billMonth(k, true);
    const avg = (b) => { const v = []; for (let i = 1; i <= 6; i++) { const p = getPay(b, addMonths(k, -i)); if (p && p.amount != null) v.push(Number(p.amount)); } return v.length ? Math.round(v.reduce((t, n) => t + n, 0) / v.length) : null; };
    const rows = md.rows.filter((x) => !x.b.escrow);
    const rental = rows.filter((x) => !isHome(x.b.unit_id)), home = rows.filter((x) => isHome(x.b.unit_id));
    const bill = (x) => ({ name: billTitle(x.b) + ' · ' + unitName(x.b.unit_id), amount: x.amt, usual: x.b.amount_type === 'fixed' ? null : avg(x.b), last_year: lastYear(x.b, k), paid: !!(x.pay && x.pay.paid_at), due: x.due ? isoDate(x.due) : null });
    const next = addMonths(k, 1);
    const upkeep = S.logs.filter((l) => (l.done_on || '').slice(0, 7) === k.slice(0, 7)).map((l) => ({ title: l.title, cost: l.cost, vendor: l.vendor, place: unitName(l.unit_id) }));
    const coming = S.tasks.filter((t) => t.active !== false && t.next_due && t.next_due.slice(0, 7) === next.slice(0, 7)).map((t) => t.title + ' ' + fmtDay(fromIso(t.next_due)));
    S.rentals.filter((r) => r.active !== false && r.lease_end && r.lease_end.slice(0, 7) <= addMonths(k, 3).slice(0, 7) && r.lease_end >= k).forEach((r) => coming.push(rentalTitle(r) + ' lease ends ' + fmtDate(fromIso(r.lease_end))));
    const rentIn = rm.received, rentalOut = rental.reduce((t, x) => t + ((x.pay && x.pay.paid_at) ? (x.amt || 0) : 0), 0) + upkeepSplit(k, false);
    return {
      month: monthLabel(k),
      rent: rm.rows.map((x) => ({ tenant: rentalTitle(x.r), place: unitName(x.r.unit_id), due: x.due, received: x.got, status: x.st.label })),
      bills: rental.map(bill), home_bills: home.map(bill), upkeep, coming_next_month: coming,
      totals: { rent_in: Math.round(rentIn), rental_out: Math.round(rentalOut), net: Math.round(rentIn - rentalOut) }
    };
  }
  function recapCard() {
    const k = S.month; const r = S.recapBusy === k ? { busy: true } : readRecap(k);
    const label = monthLabel(k).split(' ')[0];
    if (!r) return `<section class="card recap" aria-label="${esc(label)} recap"><div class="row between"><h2>${esc(label)} recap</h2><span class="askicon" aria-hidden="true">✦</span></div>
      <p class="small muted">A short plain-English summary of rent, bills, upkeep and what’s next.</p>
      <button class="btn primary-soft" data-act="recap">Write my ${esc(label)} recap</button></section>`;
    if (r.busy) return `<section class="card recap" aria-label="${esc(label)} recap"><h2>${esc(label)} recap</h2><div class="msg assistant typing" aria-label="Writing"><span></span><span></span><span></span></div></section>`;
    if (r.error) return `<section class="card recap"><h2>${esc(label)} recap</h2><p class="err">${esc(r.error)}</p><button class="btn" data-act="recap">Try again</button></section>`;
    return `<section class="card recap" aria-label="${esc(label)} recap">
      <div class="row between"><h2>${esc(r.title || label + ' recap')}</h2><span class="askicon" aria-hidden="true">✦</span></div>
      <ul class="recap-list">${(r.bullets || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.net ? `<p class="recap-net">${esc(r.net)}</p>` : ''}
      <div class="row between"><span class="small muted">Written ${r.at ? fmtDay(new Date(r.at)) : ''} · AI summary, check the numbers above</span><button class="linkbtn" data-act="recap">Refresh</button></div>
    </section>`;
  }
  async function makeRecap() {
    const k = S.month; S.recapBusy = k; render();
    let out;
    try { const j = await assist({ mode: 'recap', context: recapContext(k) }); out = { title: j.title, bullets: j.bullets, net: j.net, at: new Date().toISOString() }; try { localStorage.setItem(recapKey(k), JSON.stringify(out)); } catch (_) {} }
    catch (e) { out = { error: e.message }; try { localStorage.removeItem(recapKey(k)); } catch (_) {} toast(e.message); }
    S.recapBusy = null; render();
  }
  function rentStatus(r, rp, period) {
    const due = rentDue(r, rp);
    const got = rp && rp.amount_received != null ? Number(rp.amount_received) : 0;
    const d = dueOn(r.due_day, period);
    if (due == null) return { k: 'setup', label: 'Needs rent amount' };
    if (got >= due && due > 0) return { k: 'paid', label: 'Received' + (rp.received_at ? ' ' + fmtDay(new Date(rp.received_at)) : '') };
    const diff = dayDiff(d);
    const lateAfter = -(r.grace_days || 0);
    if (got > 0) return { k: diff < lateAfter ? 'late' : 'soon', label: 'Partial · ' + money(got) + ' of ' + money(due) };
    if (diff < lateAfter) return { k: 'late', label: 'Late · was due ' + fmtDay(d) };
    if (diff < 0) return { k: 'soon', label: 'In grace period · due ' + fmtDay(d) };
    if (diff === 0) return { k: 'soon', label: 'Due today' };
    return { k: 'up', label: 'Due ' + fmtDay(d) };
  }
  function rentMonth(period) {
    let expected = 0, received = 0, late = 0;
    const rows = S.rentals.filter((r) => r.active !== false).map((r) => {
      const rp = getRentPay(r, period);
      const due = rentDue(r, rp);
      const got = rp && rp.amount_received != null ? Number(rp.amount_received) : 0;
      const st = rentStatus(r, rp, period);
      expected += due || 0; received += got;
      if (st.k === 'late') late++;
      return { r, rp, due, got, st };
    });
    rows.sort((a, b) => unitName(a.r.unit_id).localeCompare(unitName(b.r.unit_id)));
    return { rows, expected, received, late };
  }
  function taskStatus(t) {
    if (!t.next_due) return { k: 'setup', label: 'Not scheduled', diff: 9e6 };
    const d = fromIso(t.next_due); const diff = dayDiff(d);
    if (diff < 0) return { k: 'late', label: 'Overdue · ' + fmtDay(d), diff };
    if (diff === 0) return { k: 'late', label: 'Due today', diff };
    if (diff <= 30) return { k: 'soon', label: 'Due in ' + diff + (diff === 1 ? ' day' : ' days'), diff };
    return { k: 'up', label: 'Due ' + fmtDate(d), diff };
  }
  function everyLabel(t) {
    const n = t.interval_months;
    if (!n) return 'One-time';
    if (n === 12) return 'Every year';
    if (n % 12 === 0) return 'Every ' + n / 12 + ' years';
    return n === 1 ? 'Every month' : 'Every ' + n + ' months';
  }
  function upkeepSpend(period) { return S.logs.filter((l) => l.done_on && l.done_on.slice(0, 7) === period.slice(0, 7)).reduce((t, l) => t + (Number(l.cost) || 0), 0); }

  // ---------- render ----------
  let raf;
  function renderSoon() { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // One-shot effects that must not replay on every re-render
  const FX = { stamp: null, stampUntil: 0, sheetEnter: false, ringFrom: {}, tideFrom: {}, rollFrom: {}, lastTab: null };
  function confetti() {
    if (reduceMotion()) return;
    const layer = document.getElementById('fx'); if (!layer) return;
    const colors = ['#2F4BA8', '#A9BCF5', '#F2C46B', '#2B4C9B', '#E46A4B', '#16201C'];
    for (let i = 0; i < 44; i++) {
      const c = document.createElement('span'); c.className = 'conf';
      c.style.left = Math.random() * 100 + '%'; c.style.background = colors[i % colors.length];
      c.style.animationDelay = (Math.random() * 0.35) + 's';
      c.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px'); c.style.setProperty('--r', (Math.random() * 900 - 450) + 'deg');
      layer.appendChild(c); setTimeout(() => c.remove(), 2600);
    }
  }
  function afterRender() {
    // Count-up + ring fill for the hero ring
    document.querySelectorAll('[data-ring]').forEach((el) => {
      const key = el.dataset.ring, to = Number(el.dataset.to), total = Number(el.dataset.total) || 1;
      const from = FX.ringFrom[key] != null ? FX.ringFrom[key] : to;
      FX.ringFrom[key] = to;
      const arc = el.querySelector('.ring-arc'), num = el.querySelector('.ring-num');
      if (!arc || !num) return;
      const C = Number(arc.dataset.c);
      const off = (v) => (C * (Math.max(0, Math.min(total, v)) / total)).toFixed(1); // v = amount still to pay; empty ring at 0% paid
      if (from === to || reduceMotion()) { arc.style.strokeDashoffset = off(to); return; }
      arc.style.transition = 'none'; arc.style.strokeDashoffset = off(from);
      requestAnimationFrame(() => { arc.style.transition = ''; arc.style.strokeDashoffset = off(to); });
      const t0 = performance.now(), dur = 900;
      const tick = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); num.textContent = money(from + (to - from) * e); if (k < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    // Tide: water rises to the new level (from empty the first time this month is shown)
    document.querySelectorAll('[data-tide]').forEach((el) => {
      const key = el.dataset.tide, to = Number(el.dataset.pct);
      const from = FX.tideFrom[key] != null ? FX.tideFrom[key] : 0;
      FX.tideFrom[key] = to;
      if (from === to || reduceMotion()) return;
      el.classList.add('still'); el.style.setProperty('--lvl', tideLvl(from) + '%');
      void el.offsetWidth; el.classList.remove('still'); el.style.setProperty('--lvl', tideLvl(to) + '%');
    });
    // Rolling digits: each digit spins from its old value (or 0) to the new one, left to right
    document.querySelectorAll('[data-roll]').forEach((el) => {
      const key = el.dataset.roll, to = Number(el.dataset.v);
      const from = FX.rollFrom[key] != null ? FX.rollFrom[key] : 0;
      FX.rollFrom[key] = to;
      if (from === to || reduceMotion()) return;
      const txt = money(to);
      el.innerHTML = rollHtml(txt, money(from));
      el.classList.add('still'); void el.offsetWidth; el.classList.remove('still');
      const digits = [...txt].filter((ch) => /\d/.test(ch));
      el.querySelectorAll('.rd-col').forEach((c, i) => { c.style.transitionDelay = (i * 60) + 'ms'; c.style.setProperty('--d', digits[i]); });
    });
    // Stack: list cards deal in when you switch tabs
    if (S.tab !== FX.lastTab) {
      FX.lastTab = S.tab;
      if (!reduceMotion()) document.querySelectorAll('#app .bills > li').forEach((li, i) => {
        if (i > 7) return;
        li.style.animationDelay = (i * 55) + 'ms'; li.classList.add('deal');
        li.addEventListener('animationend', () => { li.classList.remove('deal'); li.style.animationDelay = ''; }, { once: true });
      });
    }
    // Sheet: spring in once when opened
    const sh = document.querySelector('.sheet');
    if (sh && FX.sheetEnter && !reduceMotion()) {
      sh.classList.add('enter'); document.querySelector('.sheet-bg').classList.add('enter');
      // drop the class once it has played, so dragging can move the sheet
      sh.addEventListener('animationend', () => sh.classList.remove('enter'), { once: true });
    }
    FX.sheetEnter = false;
    const hc = document.querySelector('.herocar');
    if (hc && S.heroSlide) { hc.style.scrollBehavior = 'auto'; hc.scrollLeft = hc.clientWidth * S.heroSlide; hc.style.scrollBehavior = ''; }
  }
  let rendering = false;
  function render() {
    // A field losing focus while the screen is being replaced can fire 'change' and ask for another render mid-render
    if (rendering) { renderSoon(); return; }
    rendering = true;
    try { renderNow(); } finally { rendering = false; }
  }
  function renderNow() {
    document.documentElement.classList.toggle('simple', simple());
    const app = document.getElementById('app');
    const y = window.scrollY;
    const ae = document.activeElement;
    const keep = ae && ae.id && app.contains(ae) ? { id: ae.id, v: ae.value, a: ae.selectionStart, b: ae.selectionEnd } : null;
    const sheetEl = app.querySelector('.sheet'); const sheetScroll = sheetEl ? sheetEl.scrollTop : null;
    if (S.view === 'loading') app.innerHTML = skeletonView();
    else if (S.view === 'auth') app.innerHTML = authView();
    else if (S.view === 'recovery') app.innerHTML = recoveryView();
    else if (S.view === 'join') app.innerHTML = joinView();
    else app.innerHTML = appView();
    if (S.view === 'app') { if (S.restoreScroll != null && document.documentElement.scrollHeight > S.restoreScroll) { window.scrollTo(0, S.restoreScroll); S.restoreScroll = null; } else window.scrollTo(0, y); updateBadge(); afterRender(); saveNav(); }
    const ns = app.querySelector('.sheet'); if (ns && sheetScroll != null) ns.scrollTop = sheetScroll;
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) {
        if (typeof keep.v === 'string' && n.type !== 'file' && n.type !== 'checkbox' && n.tagName !== 'SELECT') n.value = keep.v;
        n.focus({ preventScroll: true });
        try { if (keep.a != null) n.setSelectionRange(keep.a, keep.b); } catch (_) {}
      }
    }
  }

  const ILLO = {
    done: '<ellipse cx="75" cy="102" rx="52" ry="6" class="i-shadow"/><path d="M75 10 L128 48 L22 48 Z" class="i-roof"/><rect x="32" y="48" width="86" height="50" rx="3" class="i-wall"/><rect x="66" y="66" width="18" height="32" rx="2" class="i-roof"/><rect x="42" y="60" width="16" height="14" rx="2" class="i-win"/><rect x="92" y="60" width="16" height="14" rx="2" class="i-win"/><circle cx="122" cy="26" r="13" class="i-badge"/><path d="M116 26 l4 4 l8 -8" class="i-tick"/>',
    empty: '<ellipse cx="75" cy="102" rx="46" ry="6" class="i-shadow"/><rect x="33" y="22" width="84" height="66" rx="10" class="i-dash"/><path d="M75 42 v26 M62 55 h26" class="i-plus"/>',
    tools: '<ellipse cx="75" cy="102" rx="46" ry="6" class="i-shadow"/><path d="M52 30 a14 14 0 0 0 18 18 l30 30 a6 6 0 0 0 9 -9 l-30 -30 a14 14 0 0 0 -18 -18 l9 9 -3 9 -9 3 z" class="i-roof"/><circle cx="104" cy="35" r="10" class="i-win"/>',
    people: '<ellipse cx="75" cy="102" rx="50" ry="6" class="i-shadow"/><circle cx="58" cy="40" r="14" class="i-win"/><path d="M34 90 a24 24 0 0 1 48 0 z" class="i-roof"/><circle cx="96" cy="46" r="11" class="i-wall i-stroke"/><path d="M78 90 a18 18 0 0 1 36 0 z" class="i-wall i-stroke"/>',
    docs: '<ellipse cx="75" cy="102" rx="46" ry="6" class="i-shadow"/><rect x="44" y="20" width="56" height="72" rx="6" class="i-wall i-stroke"/><rect x="54" y="12" width="56" height="72" rx="6" class="i-paper"/><path d="M64 32 h36 M64 44 h36 M64 56 h24" class="i-lines"/>',
    calm: '<ellipse cx="75" cy="102" rx="50" ry="6" class="i-shadow"/><circle cx="75" cy="50" r="30" class="i-win"/><path d="M60 52 q15 14 30 0" class="i-tick"/><circle cx="64" cy="44" r="3" class="i-dot"/><circle cx="86" cy="44" r="3" class="i-dot"/>'
  };
  function emptyState(kind, title, text, action) {
    return `<div class="empty"><svg class="float" width="150" height="110" viewBox="0 0 150 110" aria-hidden="true">${ILLO[kind] || ILLO.empty}</svg>
      <strong>${title}</strong>${text ? `<span>${text}</span>` : ''}${action || ''}</div>`;
  }
  function skeletonView() {
    const card = '<div class="bill" aria-hidden="true"><div class="bill-top"><div class="sk" style="width:48px;height:48px;border-radius:14px"></div><div class="stack" style="flex:1;gap:8px"><div class="sk" style="height:14px;width:65%"></div><div class="sk" style="height:12px;width:40%"></div></div></div></div>';
    return `<div class="shell" aria-busy="true" aria-label="Loading"><header class="topbar"><div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:28px;width:55%;margin-top:6px"></div></header>
      <main class="main"><div class="sk" style="height:150px;border-radius:20px"></div>${card}${card}${card}</main></div>`;
  }
  function isDemo() { return !!(S.user && CFG.DEMO_EMAIL && S.user.email === CFG.DEMO_EMAIL); }
  function authView() {
    const up = S.authMode === 'signup';
    const feat = [
      ['🔑', 'Rent, unit by unit', 'See who paid and who’s late. Zelle alerts and tenants’ “I’ve paid” notes mark rent for you.'],
      ['🧾', 'Bills on time', 'Every utility, mortgage and tax bill with reminders, a calendar and a year of history.'],
      ['🔧', 'Repairs from tenants', 'Tenants report problems with photos. You schedule, reply and keep the history.'],
      ['📊', 'Taxes made easy', 'Income and expenses sorted Schedule E style, ready for your accountant.'],
      ['✦', 'Ask in plain words', '“What did heat cost last winter?” or “paid electric $96”. The helper does the rest.'],
      ['👤', 'Personal on the side', 'Netflix, phone, gym… tracked separately from the rental.']
    ];
    return `<div class="lp">
      <header class="lp-nav"><span class="lp-brand"><img src="icons/icon-192.png" alt="" width="34" height="34"> Doorstep</span><button type="button" class="btn sm" data-act="auth-mode" data-v="signin" data-jump="1">Sign in</button></header>
      <section class="lp-hero">
        <div class="lp-copy">
          <span class="lp-eyebrow">Free for small landlords</span>
          <h1 class="display">Rent, bills and repairs. Right at your doorstep.</h1>
          <p class="lp-lead">One simple app for landlords with a few units: track rent, never miss a bill, and let tenants report repairs. No bank login needed.</p>
          <div class="lp-cta"><button type="button" class="btn primary" data-act="demo-login" ${S.busy ? 'disabled' : ''}>👀 Try the demo</button><button type="button" class="btn" data-act="auth-mode" data-v="signup" data-jump="1">Create free account</button></div>
          <p class="small muted">The demo is a sample duplex with two tenants and a year of history. It resets every night.</p>
        </div>
        <div class="lp-art" aria-hidden="true">
          <div class="lp-card c1"><span class="small muted">Rent · November</span><strong class="display">$3,100</strong><span class="pill paid" style="margin:0">All in ✓</span></div>
          <div class="lp-card c2"><span class="small muted">Next bill</span><strong>Valley Electric</strong><span class="small">Due Friday · $93.27</span></div>
          <div class="lp-card c3"><span class="small muted">Repair · Upstairs</span><strong>Kitchen faucet</strong><span class="pill up" style="margin:0">Scheduled Thu</span></div>
        </div>
      </section>
      <section class="lp-sec"><h2 class="display">Everything a small landlord tracks</h2>
        <div class="lp-grid">${feat.map(([i, t, d]) => `<div class="lp-feat"><span class="lp-ic">${i}</span><strong>${t}</strong><span class="small muted">${d}</span></div>`).join('')}</div></section>
      <section class="lp-sec"><h2 class="display">Up and running in minutes</h2>
        <ol class="lp-steps"><li><strong>Create your account</strong><span class="small muted">Email and password. Free.</span></li><li><strong>Add your property</strong><span class="small muted">Units, tenants and the bills you pay.</span></li><li><strong>Share tenant links</strong><span class="small muted">Each tenant gets a private page. No app or account for them.</span></li></ol></section>
      <section class="lp-sec lp-tenant"><h2 class="display">Tenants love it too</h2>
        <p>Their private link shows what’s due and how to pay, lets them say “I’ve paid”, and report repairs with a photo. Nothing to install.</p></section>
      <section class="lp-sec"><h2 class="display">Questions</h2>
        <details class="lp-q"><summary>Is it really free?</summary><p class="small">Yes. No ads, no credit card.</p></details>
        <details class="lp-q"><summary>Who can see my data?</summary><p class="small">Only people you invite to your property. Tenants see only their own rent and requests. You can download or delete everything any time.</p></details>
        <details class="lp-q"><summary>Do I have to connect my bank?</summary><p class="small">No. You can record payments yourself, or forward bill and Zelle emails from Gmail.</p></details>
        <details class="lp-q"><summary>Can my partner or co-owner use it?</summary><p class="small">Yes. They create their own account and join with your house code.</p></details></section>
      <section class="lp-sec" id="contact"><div class="card" style="max-width:520px;margin:0 auto">
        <h2 class="display" style="margin:0">Contact us</h2>
        <p class="small muted" style="margin:-4px 0 0">Questions before you sign up? Send a note.</p>
        <form class="stack" data-form="feedback">
          <div class="field"><label for="fb-msg">Message</label><textarea class="input" id="fb-msg" name="message" maxlength="4000" required placeholder="A question, an idea or a problem"></textarea></div>
          <div class="field"><label for="fb-email">Your email <span class="muted">(so we can reply)</span></label><input class="input" id="fb-email" name="email" type="email" maxlength="200" value="${esc(S.user && !isDemo() ? S.user.email : '')}" autocomplete="email"></div>
          ${S.fbMsg ? `<p class="ok" role="status">${esc(S.fbMsg)}</p>` : ''}${S.fbErr ? `<p class="err" role="alert">${esc(S.fbErr)}</p>` : ''}
          <button class="btn primary-soft" type="submit">Send</button>
        </form>
      </div></section>
      <section class="lp-sec" id="signin"><div class="card ds-auth" style="margin:0 auto">
        <h2 class="display" style="margin:0">${up ? 'Create your free account' : 'Sign in'}</h2>
        <form class="stack" data-form="auth" novalidate>
          <div class="seg theme-seg" role="group" aria-label="Sign in or create an account">${[['signin', 'Sign in'], ['signup', 'Create account']].map(([v, l]) => `<button type="button" data-act="auth-mode" data-v="${v}" aria-pressed="${(S.authMode || 'signin') === v}">${l}</button>`).join('')}</div>
          <div class="field"><label for="a-email">Email</label><input class="input" id="a-email" name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
          <div class="field"><label for="a-pass">Password ${up ? '<span class="muted">(8+ characters)</span>' : ''}</label><input class="input" id="a-pass" name="password" type="password" minlength="8" autocomplete="${up ? 'new-password' : 'current-password'}" autocapitalize="off" spellcheck="false" required></div>
          ${S.authErr ? `<p class="err" role="alert">${esc(S.authErr)}</p>` : ''}
          <button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>${up ? 'Create my account' : 'Sign in'}</button>
          ${!up ? '<button type="button" class="linkbtn" data-act="forgot" style="align-self:center">Forgot password?</button>' : ''}
          ${S.authMsg ? `<p class="ok" role="status">${esc(S.authMsg)}</p>` : ''}
          ${up ? '<p class="small muted" style="margin:0">By creating an account you agree to the <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy policy</a>.</p>' : ''}
        </form>
        <button type="button" class="btn block" data-act="demo-login" ${S.busy ? 'disabled' : ''}>👀 Or try the demo</button>
      </div></section>
      <footer class="lp-foot"><span>© ${new Date().getFullYear()} Doorstep</span><span><a href="#contact">Contact</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></span></footer>
    </div>`;
  }
  function recoveryView() {
    return `<div class="auth"><form class="card" data-form="recovery">
      <h1 class="display" style="margin:0;font-size:24px">Set a new password</h1>
      <div class="field"><label for="r-pass">New password</label><input class="input" id="r-pass" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      ${S.authErr ? `<p class="err" role="alert">${esc(S.authErr)}</p>` : ''}
      <button class="btn primary block" type="submit">Save password</button>
    </form></div>`;
  }
  function housesSheet() {
    const list = S.houses && S.houses.length ? S.houses : (S.household ? [{ id: S.household.id, name: S.household.name, address: S.household.address }] : []);
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">Your properties</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <ul class="cz-list">${list.map((h) => `<li><button type="button" class="houserow" data-act="house-switch" data-id="${h.id}" aria-pressed="${S.household && h.id === S.household.id}"><span class="stack" style="gap:1px;text-align:left;flex:1;min-width:0"><strong>${esc(h.name)}</strong><span class="small muted">${esc(h.address || '')}</span></span>${S.household && h.id === S.household.id ? '<span class="pill paid" style="margin:0">Open</span>' : '<span aria-hidden="true" class="muted">›</span>'}</button></li>`).join('')}</ul>
      ${isDemo() ? '<p class="small muted">The demo has one property. Create your own account to add yours.</p>' : list.length >= 5 ? '<p class="small muted">You have the maximum of 5 properties.</p>' : `<section class="card"><h2>Add another property</h2>
        <form class="stack" data-form="add-house">
          <div class="field"><label for="ah-name">Property name</label><input class="input" id="ah-name" name="name" required maxlength="80" placeholder="e.g. Oak Avenue Triplex"></div>
          <div class="field"><label for="ah-addr">Address <span class="muted">(optional)</span></label><input class="input" id="ah-addr" name="address" maxlength="160"></div>
          <div class="field"><label for="ah-units">Units <span class="muted">(comma-separated)</span></label><input class="input" id="ah-units" name="units" value="Unit 1, Unit 2" maxlength="200"></div>
          ${S.sheetErr ? `<p class="err" role="alert">${esc(S.sheetErr)}</p>` : ''}
          <button class="btn primary block" type="submit">Add property</button>
        </form></section>`}
    </div></div>`;
  }
  function joinView() {
    return `<div class="auth"><div class="card ds-auth">
      <img class="logo" src="icons/icon-192.png" alt="">
      <div><h1 class="display" style="margin:0;font-size:26px">Set up your property</h1>
      <p class="muted" style="margin:4px 0 0">Takes a minute. You can change everything later.</p></div>
      <form class="stack" data-form="create-house">
        <div class="field"><label for="c-name">Property name</label><input class="input" id="c-name" name="name" placeholder="e.g. Maple Street Duplex" required maxlength="80"></div>
        <div class="field"><label for="c-addr">Address <span class="muted">(optional, for weather alerts)</span></label><input class="input" id="c-addr" name="address" placeholder="Street, city, state" maxlength="160"></div>
        <div class="field"><label for="c-units">Units you rent out <span class="muted">(comma-separated)</span></label><input class="input" id="c-units" name="units" value="Downstairs, Upstairs" maxlength="200"></div>
        ${S.joinErr ? `<p class="err" role="alert">${esc(S.joinErr)}</p>` : ''}
        <button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>Create my property</button>
      </form>
      <div class="or" aria-hidden="true"><span>or</span></div>
      <form class="stack" data-form="join">
        <div class="field"><label for="j-code">Joining someone’s property? Enter their house code</label><input class="input code" id="j-code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
        <button class="btn block" type="submit" ${S.busy ? 'disabled' : ''}>Join</button>
      </form>
      <button type="button" class="linkbtn" data-act="signout">Sign out (${esc(S.user ? S.user.email : '')})</button>
    </div></div>`;
  }

  function appView() {
    if (S.tour === undefined) S.tour = tourSeen() || !S.household ? null : 0;
    if (S.tab === 'personal' && !visibleTabs().some((t) => t[0] === 'personal')) { S.tab = 'bills'; S.unit = 'personal'; }
    if (!['summary', 'settings'].includes(S.tab) && !visibleTabs().some((t) => t[0] === S.tab)) S.tab = 'summary';
    const titles = { bills: tabName('bills', 'Bills'), rent: tabName('rent', 'Rent'), upkeep: tabName('upkeep', 'House'), summary: tabName('summary', 'Home'), personal: tabName('personal', 'Personal'), settings: 'Settings' };
    const houseAdd = { upcoming: ['new-task', 'Add upkeep task'], history: ['new-log', 'Log a repair'], appliances: ['new-appliance', 'Add appliance'], pros: ['new-contractor', 'Add contractor'], docs: ['new-doc', 'Add document'] };
    const adds = { bills: ['new-bill', 'Add bill'], rent: ['new-rental', 'Add tenant'], upkeep: houseAdd[S.upkeepView], personal: ['personal-add', 'Add expense'] };
    const addr = S.household && S.household.address ? S.household.address.split(',')[0] : (S.household ? S.household.name : '');
    const offline = !S.online || S.pending
      ? `<span class="status-dot">${!S.online ? 'Offline' : 'Syncing'}${S.pending ? ' · ' + S.pending + ' unsaved' : ''}</span>` : '';
    const body = { bills: billsTab, rent: rentTab, upkeep: upkeepTab, summary: summaryTab, personal: personalTab, settings: settingsTab }[S.tab]();
    const vt = visibleTabs(); const tabs = vt
      .map(([id, l]) => `<button class="tab" data-act="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${ICON[id]}<span>${l}</span></button>`).join('');
    const add = adds[S.tab];
    return `<div class="shell">
      <header class="topbar">
        <div class="topbar-row"><button type="button" class="eyebrow housebtn" data-act="houses-open" aria-label="Switch or add a property. Now: ${esc(S.household ? S.household.name : '')}">${esc(addr)} <span aria-hidden="true">▾</span></button>${offline}</div>
        <div class="topbar-row"><h1 class="display">${esc(titles[S.tab])}</h1><span class="topbar-actions"><button class="iconbtn gearbtn" data-act="tab" data-tab="settings" aria-label="Settings" title="Settings" ${S.tab === 'settings' ? 'aria-current="page"' : ''}>${ICON.settings}</button>${add && !simple() ? `<button class="addbtn" data-act="${add[0]}" aria-label="${add[1]}">${ICON.plus}<span>Add</span></button>` : ''}</span></div>
      </header>
      ${isDemo() ? '<div class="demobar" role="note"><span>👀 You’re exploring the demo. It resets nightly.</span><button type="button" class="btn sm" data-act="demo-signup">Make my own</button></div>' : ''}
      ${S.updateReady ? '<div class="updbar" role="status"><span>A new version is ready.</span><button type="button" class="btn sm" data-act="app-reload">Refresh</button></div>' : ''}
      <main class="main">${body}</main>
      <nav class="tabbar" aria-label="App sections"><div class="tabbar-inner" style="grid-template-columns:repeat(${vt.length}, minmax(0, 1fr))">${tabs}</div></nav>
      ${S.sheet ? sheetView() : ''}
      ${S.tab !== 'settings' && !S.sheet ? (simple() ? '<button class="fab" data-act="add-menu" aria-label="Add a bill, payment, tenant or repair, or ask a question"><span aria-hidden="true">＋</span> Add</button>' : '<button class="fab" data-act="ask-open" aria-label="Ask or add: type, speak or scan a bill"><span aria-hidden="true">✦</span> Ask or add</button>') : ''}
      ${S.story ? storyView() : ''}
      ${S.tour != null ? tourView() : ''}
    </div>`;
  }

  function monthNav() {
    const isCur = S.month === monthKey(new Date());
    return `<div class="row between">
      <div class="monthnav" data-swipe-month="1">
        <button class="iconbtn" data-act="month" data-delta="-1" aria-label="Previous month" title="Previous month">${ICON.left}</button>
        <strong style="font-size:16px;min-width:140px;text-align:center">${monthLabel(S.month)}</strong>
        <button class="iconbtn" data-act="month" data-delta="1" aria-label="Next month" title="Next month">${ICON.right}</button>
      </div>
      ${isCur ? '' : '<button class="btn" data-act="month-today">This month</button>'}
    </div>`;
  }
  // Water-fill circle: the level rises with % paid (animated in afterRender)
  function tideBall(key, pct, size, inner) {
    const p = Math.max(0, Math.min(100, pct));
    return `<div class="tide${size ? ' ' + size : ''}" data-tide="${esc(key)}" data-pct="${p}" style="--lvl:${tideLvl(p)}%">
      <div class="tide-lvl" aria-hidden="true"><i class="tide-w a"></i><i class="tide-w b"></i></div>
      <div class="tide-c">${inner}</div></div>`;
  }
  function tideLvl(p) { return p >= 100 ? -8 : 100 - p; } // full: lift past the brim so no edge gaps show
  // Amount whose digits roll into place like a counter (animated in afterRender)
  function rollNum(key, v) {
    return `<span class="big display num"><span class="sr">${money(v)}</span><span class="roll" data-roll="${esc(key)}" data-v="${Number(v) || 0}" aria-hidden="true">${rollHtml(money(v), money(v))}</span></span>`;
  }
  function rollHtml(txt, from) {
    const f = from && from.length === txt.length ? from : null;
    return [...txt].map((ch, i) => /\d/.test(ch)
      ? `<span class="rd"><span class="rd-col" style="--d:${f && /\d/.test(f[i]) ? f[i] : 0}">${'0123456789'.split('').map((n) => `<span>${n}</span>`).join('')}</span></span>`
      : `<span>${ch}</span>`).join('');
  }
  function ringHero(key, label, left, total, pct, footL, footR, late) {
    const R = 78, C = 2 * Math.PI * R;
    const off = (C * (total > 0 ? Math.max(0, left) / total : 0)).toFixed(1);
    return `<section class="hero ringhero" aria-label="${esc(label)}">
      <div class="ringwrap" data-ring="${esc(key)}" data-to="${left}" data-total="${total || 1}">
        <svg width="190" height="190" viewBox="0 0 190 190" role="img" aria-label="${pct}% paid">
          <circle cx="95" cy="95" r="${R}" class="ring-track"></circle>
          <circle cx="95" cy="95" r="${R}" class="ring-arc" data-c="${C.toFixed(1)}" transform="rotate(-90 95 95)" style="stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${off}"></circle>
        </svg>
        <div class="ring-center"><span class="label">${esc(label)}</span><span class="big display num ring-num">${money(left)}</span><span class="ring-pct">${pct}% paid</span></div>
      </div>
      <div class="foot"><span>${footL}</span><span class="${late ? 'late' : ''}">${footR}</span></div>
      ${key.startsWith('bills-') ? (() => { const n = billsStreak(); return n >= 2 ? `<div class="foot streak-dark">${streakDots(n)}<span>All bills on time ${n} months in a row</span></div>` : ''; })() : ''}
    </section>`;
  }
  // ----- #22 month timeline -----
  function timeline(md) {
    const { y, m } = parseMonth(S.month); const days = daysIn(y, m);
    const isCur = S.month === monthKey(new Date());
    const td = today().getDate();
    const pos = (d) => ((d - 1) / Math.max(1, days - 1) * 100).toFixed(2);
    const col = { paid: 'var(--accent)', late: '#E46A4B', soon: '#2B4C9B', up: '#8FA3C9', auto: '#8FA3C9', setup: '#B9C1BB' };
    const ev = md.rows.filter((r) => r.due).map((r) => ({ d: r.due.getDate(), c: col[r.st.k] || '#B9C1BB', label: billTitle(r.b) + ' · ' + r.st.label, act: `data-act="jump" data-id="${r.b.id}"` }));
    S.rentals.filter((r) => r.active !== false && r.rent_amount != null && !isHome(r.unit_id)).forEach((r) => {
      const st = rentStatus(r, getRentPay(r, S.month), S.month);
      ev.push({ d: Math.min(r.due_day, days), c: st.k === 'paid' ? '#F2C46B' : st.k === 'late' ? '#E46A4B' : '#F2C46B', rent: true, label: 'Rent · ' + rentalTitle(r) + ' · ' + st.label, act: 'data-act="go" data-tab="rent"' });
    });
    const byDay = {}; ev.forEach((e) => { (byDay[e.d] = byDay[e.d] || []).push(e); });
    const dots = Object.keys(byDay).map((d) => byDay[d].map((e, i) => `<button type="button" class="tdot${e.rent ? ' rent' : ''}" ${e.act} aria-label="${esc(e.label)}, ${monthLabel(S.month, true)} ${d}" title="${esc(e.label)}" style="left:${pos(+d)}%;top:${22 - i * 14}px;background:${e.c}"></button>`).join('')).join('');
    return `<section class="tline" aria-label="Due dates this month">
      <div class="tl-track"><div class="tl-done" style="width:${isCur ? pos(td) : (S.month < monthKey(new Date()) ? 100 : 0)}%"></div>${isCur ? `<span class="tl-today" style="left:${pos(td)}%" aria-hidden="true"></span>` : ''}${dots}</div>
      <div class="tl-axis"><span>${monthLabel(S.month, true)} 1</span>${isCur ? `<span>Today · ${td}</span>` : ''}<span>${monthLabel(S.month, true)} ${days}</span></div>
    </section>`;
  }
  function hero(label, big, pct, left, right, rightLate) {
    return `<section class="hero" aria-label="${esc(label)}">
      <div class="row between" style="align-items:flex-end">
        <div class="stack" style="gap:2px"><span class="label">${esc(label)}</span><span class="big display num">${big}</span></div>
        <span class="pct display">${pct}%</span>
      </div>
      <div class="track" role="progressbar" aria-label="${esc(label)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
      <div class="foot"><span>${left}</span><span class="${rightLate ? 'late' : ''}">${right}</span></div>
    </section>`;
  }

  // ----- Bills tab -----
  S.fold = (() => { try { return JSON.parse(localStorage.getItem('ds-fold') || '{}'); } catch (_) { return {}; } })();
  function isOpen(key, dflt) { return S.fold[key] != null ? S.fold[key] : !!dflt; }
  function fold(key, title, inner, dflt, extraHead) {
    return `<details class="card fold" data-fold="${key}" ${isOpen(key, dflt) ? 'open' : ''}>
      <summary><h2>${title}</h2>${extraHead || ''}<span class="chev" aria-hidden="true"></span></summary>
      <div class="fold-body">${inner}</div></details>`;
  }
  // Turn plain <section class="card" aria-label="X"><h2>..</h2>...</section> blocks into folds
  function foldSections(html, map) {
    Object.keys(map).forEach((label) => {
      const re = new RegExp('<section class="card" aria-label="' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>\\s*<h2>([\\s\\S]*?)</h2>');
      const m = html.match(re); if (!m) return;
      const start = m.index, bodyStart = start + m[0].length;
      const end = html.indexOf('</section>', bodyStart); if (end < 0) return;
      const key = 's-' + label.toLowerCase().replace(/[^a-z]+/g, '-');
      html = html.slice(0, start) + fold(key, m[1], html.slice(bodyStart, end), map[label]) + html.slice(end + '</section>'.length);
    });
    return html;
  }

  // ----- Bills tab -----
  function billsHero(md, pct) {
    const left = md.total - md.paid;
    const key = 'bills-' + S.month + '-' + S.unit;
    return `<section class="hero billhero" aria-label="Still to pay">
      <div class="billhero-row">
        ${tideBall(key, pct, 'sm', `<span class="tide-pct">${pct}%</span><span class="tiny">paid</span>`)}
        <div class="stack" style="gap:2px;min-width:0">
          <span class="label">Still to pay</span>
          ${rollNum(key, left)}
          <span class="small" style="color:var(--hero-muted)">${money(md.paid)} of ${money(md.total)} paid</span>
          ${md.overdue ? `<span class="small late">${md.overdue} overdue · ${money(md.overdueAmt)}</span>` : ''}
        </div>
      </div>
      ${md.setup ? `<div class="foot hint">+ ${md.setup} ${md.setup === 1 ? 'bill' : 'bills'} with no amount yet</div>` : ''}
      ${(() => { const n = billsStreak(); return n >= 2 ? `<div class="foot streak-dark">${streakDots(n)}<span>All bills on time ${n} months in a row</span></div>` : ''; })()}
    </section>`;
  }
  function paidRow(r) {
    const b = r.b; const justPaid = FX.stamp === b.id && Date.now() < FX.stampUntil;
    return `<li class="prow swipe" id="bill-${b.id}" data-swipe-left="bill" data-id="${b.id}" data-paid="true">
      <button class="check sm" data-act="toggle" data-id="${b.id}" aria-pressed="true" aria-label="Mark unpaid: ${esc(billTitle(b))}, ${esc(unitName(b.unit_id))}">${ICON.check}</button>
      <button class="prow-main" data-act="bill" data-id="${b.id}" aria-label="Details for ${esc(billTitle(b))}">
        <span class="prow-name">${esc(billTitle(b))} <span class="muted">· ${esc(unitName(b.unit_id))}</span></span>
        <span class="small muted">${esc(r.st.label)}</span>
      </button>
      <span class="prow-amt num">${money(r.amt)}</span>
      ${justPaid ? '<span class="paidstamp mini slam" aria-hidden="true">PAID</span>' : ''}
    </li>`;
  }
  function billsTab() {
    const md = billMonth(S.month);
    const pct = md.total > 0 ? Math.round((md.paid / md.total) * 100) : 0;
    const floors = S.units.filter((u) => isFloor(u.name) && !isPersonal(u.id));
    const unitChips = [['all', 'Everything']].concat(floors.map((u) => [u.id, u.name])).concat(personalUnit() && !visibleTabs().some((t) => t[0] === 'personal') ? [['personal', 'Personal']] : [])
      .map(([id, l]) => `<button class="chip" data-act="unit" data-unit="${esc(id)}" aria-pressed="${S.unit === id}">${esc(l)}</button>`).join('');
    if (S.unit === 'personal') return `<div class="chips" role="group" aria-label="Show place">${unitChips}</div>` + personalTab();
    const isPaid = (r) => !!(r.pay && r.pay.paid_at);
    const CF = { Gas: ['Gas'], Electric: ['Electric'], util: ['Gas', 'Electric', 'Water'] };
    const rows = S.catFilter && CF[S.catFilter] ? md.rows.filter((r) => CF[S.catFilter].includes(r.b.category)) : md.rows;
    const cfLabel = { Gas: 'Gas bills', Electric: 'Electricity bills', util: 'Gas, electric and water' }[S.catFilter];
    const rank = { late: 0, soon: 1, setup: 2 };
    const attention = rows.filter((r) => !isPaid(r) && ['late', 'soon', 'setup'].includes(r.st.k))
      .sort((a, c) => rank[a.st.k] - rank[c.st.k] || (a.due ? a.due.getTime() : 9e15) - (c.due ? c.due.getTime() : 9e15));
    const later = rows.filter((r) => !isPaid(r) && !['late', 'soon', 'setup'].includes(r.st.k));
    const hintSeen = (() => { try { return !!localStorage.getItem('ds-hint-swipe'); } catch (_) { return true; } })();
    const firstOpen = attention.concat(later).find((r) => r.amt != null && r.due);
    S.nudgeId = !hintSeen && firstOpen ? firstOpen.b.id : null;
    const hint = S.nudgeId ? `<div class="swipehint" role="note"><span class="sh-hand" aria-hidden="true">👉</span><span><strong>Tip:</strong> swipe a bill <strong>right</strong> to mark it paid, or <strong>left</strong> for details. The big ✓ box works too.</span><button type="button" class="linkbtn" data-act="hint-ok">Got it</button></div>` : '';
    const paid = rows.filter(isPaid);
    const paidSum = paid.reduce((t, r) => t + (r.amt || 0), 0);
    const list = (rows) => `<ul class="bills">${rows.map(billCard).join('')}</ul>`;
    const body = !md.rows.length
      ? emptyState('empty', 'No bills here yet', 'Add one, or scan a paper bill.', '<button class="btn primary-soft" data-act="new-bill">Add a bill</button>')
      : hint + (attention.length ? `<h2 class="section-h">Needs attention <span class="count">${attention.length}</span></h2>${list(attention)}` : '')
        + (later.length ? `<h2 class="section-h">Coming up <span class="count">${later.length}</span></h2>${list(later)}` : '')
        + (cfLabel && !rows.length ? emptyState('empty', 'No ' + cfLabel.toLowerCase() + ' this month', '') : '') + (rows.length && !attention.length && !later.length ? emptyState('done', 'All caught up', 'Every ' + monthLabel(S.month).split(' ')[0] + ' bill is paid. Enjoy the quiet.') : '')
        + (paid.length ? `<details class="paidfold" data-fold="b-paid" ${isOpen('b-paid', false) ? 'open' : ''}><summary><span>Paid <span class="count">${paid.length}</span></span><span class="num muted">${money(paidSum)}</span><span class="chev" aria-hidden="true"></span></summary><ul class="prows">${paid.map(paidRow).join('')}</ul></details>` : '');
    if (S.billsView === 'cal') return `${topBanners()}${monthNav()}
      ${heroCarousel(utilTotals(md), billsHero(md, pct))}
      ${billsViewSwitch()}
      ${calendarView()}`;
    return `${topBanners()}${monthNav()}
      ${heroCarousel(utilTotals(md), billsHero(md, pct))}
      ${billsViewSwitch()}
      ${simple() ? '' : timeline(md)}
      <div class="chips" role="group" aria-label="Show place">${unitChips}</div>
      ${cfLabel ? `<div class="cf-bar" id="bill-list"><span>Showing <strong>${esc(cfLabel)}</strong> · ${money(rows.reduce((t, r) => t + (r.amt || 0), 0))}</span><button type="button" class="linkbtn" data-act="cat-filter" data-v="">Show all</button></div>` : '<span id="bill-list"></span>'}
      ${body}`;
  }


  function qstat(k, label) { return `<span class="qstat ${k}"><i aria-hidden="true"></i>${esc(label)}</span>`; }
  const LESS = (id) => `<button type="button" class="iconbtn qless" data-act="expand" data-id="${id}" aria-label="Show less">▴</button>`;
  function billCard(r) {
    if (!simple()) return billCardFull(r);
    if (S.open === r.b.id) return billCardFull(r).replace('<div class="bill-top">', LESS(r.b.id) + '<div class="bill-top">');
    const b = r.b, paid = !!(r.pay && r.pay.paid_at); const justPaid = paid && FX.stamp === b.id && Date.now() < FX.stampUntil;
    const spike = spikeLabel(b, r.amt);
    return `<li class="bill qrow swipe ${paid ? 'paid' : ''}${S.nudgeId === b.id && !paid ? ' nudge' : ''}" id="bill-${b.id}" data-swipe-right="toggle" data-swipe-left="bill" data-id="${b.id}" data-paid="${paid}">
      <button class="check labeled" data-act="toggle" data-id="${b.id}" aria-pressed="${paid}" aria-label="${paid ? 'Mark unpaid' : 'Mark paid'}: ${esc(billTitle(b))}, ${esc(unitName(b.unit_id))}">${ICON.check}<span class="ilab" aria-hidden="true">${paid ? 'Paid' : 'Pay'}</span></button>
      <button type="button" class="qmain" data-act="expand" data-id="${b.id}" aria-expanded="false" aria-label="${esc(billTitle(b))}, ${esc(r.st.label)}. Show details"><span class="qname">${esc(billTitle(b))} <span class="qplace">${esc(unitName(b.unit_id))}</span></span>${qstat(r.st.k, r.st.label)}${spike ? `<span class="qflag">${esc(spike)}</span>` : ''}</button>
      <span class="qamt num">${r.amt != null ? money(r.amt) : '—'}</span>
      ${justPaid ? '<span class="paidstamp mini slam" aria-hidden="true">PAID</span>' : ''}
    </li>`;
  }
  function billCardFull(r) {
    const b = r.b, paid = !!(r.pay && r.pay.paid_at);
    const complete = r.amt != null && r.due;
    const editing = S.editing === b.id || !complete;
    const unit = unitName(b.unit_id);
    const justPaid = paid && FX.stamp === b.id && Date.now() < FX.stampUntil;
    return `<li class="bill swipe ${paid ? 'paid' : ''}${S.nudgeId === b.id && !paid ? ' nudge' : ''}" id="bill-${b.id}" data-swipe-right="toggle" data-swipe-left="bill" data-id="${b.id}" data-paid="${paid}">${paid ? `<span class="paidstamp${justPaid ? ' slam' : ''}" aria-hidden="true">PAID</span>` : ''}
      <div class="bill-top">
        <button class="check labeled" data-act="toggle" data-id="${b.id}" aria-pressed="${paid}" aria-label="${paid ? 'Mark unpaid' : 'Mark paid'}: ${esc(billTitle(b))}, ${esc(unit)}">${ICON.check}<span class="ilab" aria-hidden="true">${paid ? 'Paid' : 'Pay'}</span></button>
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(billTitle(b))}</span><span class="tag">${esc(unit)}</span></div>
          ${b.account_number ? `<button class="acct" data-act="copy" data-text="${esc(b.account_number)}" aria-label="Copy account number ${esc(b.account_number)}">${esc(b.category)} · #<span class="num">${esc(b.account_number)}</span> ${ICON.copy}</button>` : `<span class="small muted">${esc(b.category)}</span>`}
          <span class="pill ${r.st.k}">${esc(r.st.label)}</span>
          ${spikeLabel(b, r.amt) ? `<span class="row" style="gap:6px;flex-wrap:wrap"><span class="pill late" style="margin:0">${spikeLabel(b, r.amt)}</span><button class="linkbtn small" data-act="explain" data-id="${b.id}" style="min-height:32px;padding:0">Why?</button></span>` : ''}
          ${yoyLabel(b, r.amt) ? `<span class="small muted">${yoyLabel(b, r.amt)}</span>` : ''}
        </div>
      </div>
      ${editing ? `<div class="qedit">
          <div class="field qe-day"><label for="d-${b.id}">Due day</label><input class="input num" id="d-${b.id}" type="number" inputmode="numeric" min="1" max="31" placeholder="—" value="${b.due_day || ''}" data-change="due" data-id="${b.id}"></div>
          <div class="field qe-amt"><label for="a-${b.id}">Amount ($)</label><input class="input num" id="a-${b.id}" type="text" inputmode="decimal" placeholder="0.00" value="${r.amt != null ? r.amt.toFixed(2) : ''}" data-change="amount" data-id="${b.id}"></div>
          ${complete ? `<button class="btn qe-btn" data-act="done">Done</button>` : `<button class="btn qe-btn" data-act="bill" data-id="${b.id}" aria-label="More details for ${esc(billTitle(b))}">More</button>`}
        </div>` : `<div class="bill-sum">
          ${spark(b)}<div class="stack" style="gap:0"><span class="amt display num">${money(r.amt)}</span><span class="small muted">${r.due ? 'Due ' + fmtDay(r.due) : ''}${monthsLabel(b) ? ' · ' + monthsLabel(b) + ' only' : ''}${b.autopay ? ' · Autopay' : ''}${r.pay && r.pay.source === 'email' ? ' · from email' : ''}</span></div>
          <div class="btns">
            ${b.pay_url && !paid ? `<a class="btn" href="${esc(b.pay_url)}" target="_blank" rel="noopener">Pay ${ICON.ext}</a>` : ''}
            <button class="btn" data-act="edit" data-id="${b.id}" aria-label="Edit ${esc(billTitle(b))}">Edit</button>
            <button class="btn" data-act="bill" data-id="${b.id}" aria-label="Details for ${esc(billTitle(b))}">More</button>
          </div>
        </div>`}
    </li>`;
  }

  // ===== v2.7 · Calendar (C), Talk to your house (E), Weekly story (G), Money flow (H), Bill detail (Polished 2) =====
  const CALC = { paid: 'var(--accent)', late: 'var(--late-fg)', soon: 'var(--soon-fg)', up: '#7F96C4', auto: '#7F96C4', setup: '#B9C1BB', rent: '#C9A15A', task: '#8A6FB0' };
  S.billsView = (() => { try { return localStorage.getItem('ds-bview') || 'list'; } catch (_) { return 'list'; } })();
  function calEvents(period) {
    const { y, m } = parseMonth(period); const days = daysIn(y, m); const ev = {};
    const add = (d, e) => { (ev[d] = ev[d] || []).push(e); };
    billMonth(period, true).rows.forEach((r) => {
      if (!r.due) return;
      add(r.due.getDate(), { kind: 'bill', id: r.b.id, k: r.pay && r.pay.paid_at ? 'paid' : r.st.k, name: billTitle(r.b), sub: unitName(r.b.unit_id) + ' · ' + r.st.label, amt: r.amt });
    });
    rentMonth(period).rows.forEach((x) => {
      if (isHome(x.r.unit_id) || x.due == null) return;
      add(Math.min(x.r.due_day || 1, days), { kind: 'rent', id: x.r.id, k: x.st.k === 'paid' ? 'paid' : x.st.k === 'late' ? 'late' : 'rent', name: 'Rent · ' + rentalTitle(x.r), sub: unitName(x.r.unit_id) + ' · ' + x.st.label, amt: x.due });
    });
    S.tasks.filter((t) => t.active !== false && t.next_due && t.next_due.slice(0, 7) === period.slice(0, 7)).forEach((t) => {
      const st = taskStatus(t);
      add(+t.next_due.slice(8, 10), { kind: 'task', id: t.id, k: st.k === 'late' ? 'late' : 'task', name: t.title, sub: 'Upkeep · ' + st.label, amt: null });
    });
    return ev;
  }
  function calendarView() {
    const k = S.month; const { y, m } = parseMonth(k); const days = daysIn(y, m);
    const first = new Date(y, m - 1, 1).getDay();
    const ev = calEvents(k);
    const isCur = k === monthKey(new Date()); const td = today().getDate();
    const sel = S.calDay && S.calDay.k === k ? S.calDay.d : (isCur ? td : (Object.keys(ev).map(Number).sort((a, b) => a - b)[0] || 1));
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<span class="cal-cell blank" aria-hidden="true"></span>');
    for (let d = 1; d <= days; d++) {
      const list = ev[d] || [];
      const dots = list.slice(0, 3).map((e) => `<i style="background:${CALC[e.k] || CALC.up}"></i>`).join('');
      const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + (list.length ? ', ' + list.length + (list.length === 1 ? ' item' : ' items') : '');
      cells.push(`<button type="button" class="cal-cell${d === sel ? ' sel' : ''}${isCur && d === td ? ' today' : ''}" data-act="cal-day" data-d="${d}" aria-pressed="${d === sel}" aria-label="${esc(label)}" style="animation-delay:${(d * 0.012).toFixed(3)}s"><span>${d}</span><span class="cal-dots">${dots}</span></button>`);
    }
    const items = ev[sel] || [];
    const dow = new Date(y, m - 1, sel).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const row = (e) => `<li><button type="button" class="cal-item" data-act="cal-open" data-kind="${e.kind}" data-id="${e.id}"><i style="background:${CALC[e.k] || CALC.up}"></i><span class="stack" style="gap:1px;min-width:0;flex:1"><strong>${esc(e.name)}</strong><span class="small muted">${esc(e.sub)}</span></span>${e.amt != null ? `<span class="num">${money(e.amt)}</span>` : ''}<span aria-hidden="true" class="muted">›</span></button></li>`;
    const leg = [['paid', 'Paid'], ['up', 'Due'], ['late', 'Late'], ['rent', 'Rent'], ['task', 'Upkeep'], ['setup', 'No amount']].map(([c, l]) => `<span><i style="background:${CALC[c]}"></i>${l}</span>`).join('');
    return `<section class="card cal" aria-label="Calendar for ${esc(monthLabel(k))}">
      <div class="cal-head" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-legend small">${leg}</div>
    </section>
    <section class="card cal-dayc" aria-live="polite">
      <h2>${esc(dow)}${isCur && sel === td ? ' · today' : ''}</h2>
      ${items.length ? `<ul class="cal-list">${items.map(row).join('')}</ul>` : '<p class="small muted" style="margin:0">Nothing due this day.</p>'}
    </section>`;
  }
  // Utility totals for the month: gas, electricity, and gas + electricity + water. Follows the place chips.
  function utilTotals(md) {
    const t = { Gas: 0, Electric: 0, Water: 0 }, missing = { Gas: 0, Electric: 0, Water: 0 }, n = { Gas: 0, Electric: 0, Water: 0 };
    md.rows.forEach((r) => { const c = r.b.category; if (!(c in t)) return; n[c]++; if (r.amt == null) missing[c]++; else t[c] += r.amt; });
    if (!n.Gas && !n.Electric && !n.Water) return '';
    const sub = (c) => !n[c] ? 'No bills' : missing[c] ? missing[c] + ' not in yet' : n[c] + (n[c] === 1 ? ' bill' : ' bills');
    const miss = missing.Gas + missing.Electric + missing.Water;
    const fv = { gas: 'Gas', elec: 'Electric', all: 'util' };
    const tile = (cls, icon, label, v, note) => `<button type="button" class="ut ${cls}${S.catFilter === fv[cls] ? ' on' : ''}" data-act="cat-filter" data-v="${fv[cls]}" aria-pressed="${S.catFilter === fv[cls]}" aria-label="${label} ${money(v)}. Show these bills"><span class="ut-top"><span class="ut-icon" aria-hidden="true">${icon}</span>${label}<span class="ut-go" aria-hidden="true">›</span></span><strong class="display num">${money(v)}</strong><span class="ut-sub">${note}</span></button>`;
    return `<section class="utils" aria-label="${esc(monthLabel(S.month))} utility totals">
      ${tile('gas', '🔥', 'Total gas', t.Gas, sub('Gas'))}
      ${tile('elec', '⚡', 'Total electricity', t.Electric, sub('Electric'))}
      ${tile('all', '🧾', 'Total bills', t.Gas + t.Electric + t.Water, 'Gas + electric + water' + (t.Water ? ' (' + money0(t.Water) + ')' : '') + (miss ? ' · ' + miss + ' not in yet' : ''))}
    </section>`;
  }
  const TOUR = [
    { icon: '🧾', title: 'Bills come to you', body: 'Emailed bills show up here by themselves. When you pay one, swipe it right or tap its ✓ box.' },
    { icon: '🏠', title: 'Rent, floor by floor', body: 'Tap “✓ Got” when rent arrives, or let Zelle alerts mark it for you. “Text” sends a polite reminder.' },
    { icon: '✦', title: 'Ask or add, any time', body: 'The green button answers questions, records “paid electric $96”, and scans paper bills.' }
  ];
  function tourSeen() { try { return !!localStorage.getItem('ds-tour'); } catch (_) { return true; } }
  function endTour() { try { localStorage.setItem('ds-tour', '1'); } catch (_) {} S.tour = null; render(); }
  function tourView() {
    const i = S.tour, c = TOUR[i];
    const addr = S.household && S.household.address ? S.household.address.split(',')[0] : 'your house';
    return `<div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <svg class="tour-house${i ? ' still' : ''}" viewBox="0 0 390 300" aria-hidden="true">
        <circle class="t-sun" cx="300" cy="80" r="34"/><rect class="t-ground" x="20" y="262" width="350" height="6" rx="3"/>
        <g class="t-wall"><rect x="105" y="150" width="180" height="112"/><rect x="105" y="205" width="180" height="3" class="t-line"/></g>
        <rect class="t-chim" x="238" y="74" width="22" height="48"/><path class="t-roof" d="M85 152 195 74 305 152z"/>
        <rect class="t-door" x="182" y="218" width="26" height="44" rx="3"/>
        <rect class="t-win w1" x="125" y="166" width="32" height="28" rx="3"/><rect class="t-win w2" x="233" y="166" width="32" height="28" rx="3"/>
        <rect class="t-win w3" x="125" y="220" width="32" height="28" rx="3"/><rect class="t-win w4" x="233" y="220" width="32" height="28" rx="3"/>
        <path class="t-tree a" d="M48 262c0-34 12-56 19-66 7 10 19 32 19 66z"/><path class="t-tree b" d="M318 262c0-26 9-44 15-52 6 8 15 26 15 52z"/>
      </svg>
      <div class="tour-head${i ? ' still' : ''}"><span class="eyebrow">Welcome home</span><h2 id="tour-title" class="display">${esc(addr)}</h2><p>Bills, rent and upkeep, all in one calm place.</p></div>
      <div class="tour-card" data-k="${i}"><span class="tour-icon" aria-hidden="true">${c.icon}</span><span class="stack" style="gap:3px"><strong>${esc(c.title)}</strong><span class="small">${esc(c.body)}</span></span></div>
      <div class="tour-dots" aria-hidden="true">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="tour-btns"><button type="button" class="btn" data-act="tour-skip">Skip</button><button type="button" class="btn primary" data-act="tour-next">${i < TOUR.length - 1 ? 'Next' : 'Open my house'}</button></div>
    </div>`;
  }
  function heroCarousel(a, b) {
    if (!a) return b;
    const i = S.heroSlide || 0;
    return `<div class="herocar-wrap"><div class="herocar" data-herocar="1" aria-label="Month overview, swipe for more">
        <div class="hc-slide">${b}</div><div class="hc-slide">${a}</div></div>
      <div class="hc-dots" role="group" aria-label="Choose card">${['Still to pay', 'Utility totals'].map((l, k) => `<button type="button" data-act="hero-slide" data-i="${k}" aria-label="${l}" aria-pressed="${k === i}"></button>`).join('')}</div></div>`;
  }
  function billsViewSwitch() {
    return `<div class="seg viewseg" role="group" aria-label="Bills view">${[['list', 'List'], ['cal', 'Calendar']].map(([v, l]) => `<button type="button" data-act="bills-view" data-v="${v}" aria-pressed="${S.billsView === v}">${l}</button>`).join('')}</div>`;
  }

  // ----- E · Talk to your house -----
  function askGreeting() {
    const k = monthKey(new Date());
    const md = billMonth(k, true); const rm = rentMonth(k);
    const open = md.rows.filter((r) => !(r.pay && r.pay.paid_at));
    const late = open.filter((r) => r.st.k === 'late');
    const soon = open.filter((r) => r.st.k === 'soon');
    const lateRent = rm.rows.filter((x) => x.st.k === 'late' && !isHome(x.r.unit_id));
    const h = new Date().getHours(); const hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const bits = late.map((r) => billTitle(r.b) + ' is overdue').concat(lateRent.map((x) => rentalTitle(x.r) + '’s rent is late'));
    if (!bits.length && soon.length) bits.push(soon.length + (soon.length === 1 ? ' bill is' : ' bills are') + ' due in the next few days');
    return hi + '! ' + (bits.length ? (bits.length === 1 ? 'One thing: ' : bits.length + ' things: ') + bits.slice(0, 3).join(', ') + '.' : 'Nothing needs you right now.') + ' Ask me anything, or tell me what you paid.';
  }
  const HOUSE_AVATAR = '<svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="14" fill="var(--accent)"/><path d="M10 22 22 12 34 22v11H10z" fill="var(--bg)"/><rect x="29" y="11" width="4" height="7" fill="var(--stamp)"/><rect x="19" y="25" width="6" height="8" fill="var(--accent)"/></svg>';
  function looksLikeAction(q) {
    const t = q.trim();
    if (/\?\s*$/.test(t) || /^(what|how|when|why|which|who|where|did|do|does|is|was|are|can|could|should|will|show|list|tell|explain|compare)\b/i.test(t)) return false;
    return /\b(paid|pay|received|got|deposited|done|did|fixed|replaced|serviced|cleaned|installed|repaired|came in|bill (is|was)|zelle)\b/i.test(t);
  }
  function askSheet() {
    const log = S.askLog || [];
    const used = new Set(log.filter((m) => m.role === 'user').map((m) => m.content));
    const chips = ASK_SUGGEST.filter((q) => !used.has(q)).slice(0, 4);
    const addr = S.household && S.household.address ? S.household.address.split(',')[0] : 'Your house';
    const msg = (m, i) => {
      if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
      let card = '';
      if (m.actions && m.actions.length) {
        const acts = m.actions.map(describeAction); const ok = acts.filter((x) => x.ok).length;
        card = `<div class="actcard${m.applied ? ' done' : ''}"><ul class="quick-list">${acts.map((x) => `<li class="${x.ok ? '' : 'bad'}">${x.text}</li>`).join('')}</ul>
          ${m.applied ? `<span class="small actdone">${m.applied === 'no' ? 'Not saved' : 'Saved ✓'}</span>` : `<div class="btns">${ok ? `<button type="button" class="btn primary-soft" data-act="ask-apply" data-i="${i}" style="flex:1">Save ${ok === 1 ? 'it' : 'all ' + ok}</button>` : ''}<button type="button" class="btn" data-act="ask-skip" data-i="${i}" style="flex:1">${ok ? 'Cancel' : 'OK'}</button></div>`}</div>`;
      }
      return `<div class="msg assistant${m.retry ? ' errmsg' : ''}">${fmtAnswer(m.content)}${m.retry && i === log.length - 1 && !S.askBusy ? `<button type="button" class="linkbtn retry" data-act="ask-retry" data-i="${i}">↻ Try again</button>` : ''}</div>${card}`;
    };
    const mic = ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) ? `<button type="button" class="iconbtn micbtn${S.listening ? ' on' : ''}" data-act="mic" data-target="ask-q" aria-label="${S.listening ? 'Stop listening' : 'Speak instead of typing'}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span class="ilab" aria-hidden="true">${S.listening ? 'Stop' : 'Speak'}</span></button>` : '';
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet talk" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head talk-head"><span class="row" style="gap:12px;min-width:0">${HOUSE_AVATAR}<span class="stack" style="gap:0;min-width:0"><h2 id="sheet-title" class="display">${esc(addr)}</h2><span class="small talk-sub"><i class="live" aria-hidden="true"></i>Knows your bills, rent and upkeep</span></span></span><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <div class="chat" aria-live="polite">
        <div class="msg assistant">${esc(askGreeting())}</div>
        ${log.map(msg).join('')}
        ${S.askBusy ? '<div class="msg assistant typing" aria-label="Thinking"><span></span><span></span><span></span></div>' : ''}
      </div>
      ${chips.length && !S.askBusy ? `<div class="talk-chips">${chips.map((q) => `<button type="button" class="chip" data-act="ask-suggest" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
      <form class="row talk-form" data-form="ask">
        <label for="ask-q" class="sr">Ask or tell your house</label>
        <input class="input" id="ask-q" name="q" placeholder="Paid electric $96 · or ask anything" autocomplete="off" enterkeyhint="send" style="flex:1;min-width:0">
        ${mic}<label class="iconbtn cambtn" aria-label="Scan a paper bill" title="Scan a paper bill"><input type="file" accept="image/*" capture="environment" class="sr" data-change="scan-bill">${ICON.camera}<span class="ilab" aria-hidden="true">Scan</span></label><button class="btn primary-soft" type="submit" ${S.askBusy ? 'disabled' : ''}>Send</button>
      </form>
      <p class="small muted">AI can make mistakes. You approve every change. Account numbers, phones and emails aren’t sent.</p>
    </div></div>`;
  }
  // Answers are plain text, but tidy up any markdown the model slips in (bold, bullets, tables)
  function fmtAnswer(t) {
    return String(t || '').split('\n').filter((l) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l))
      .map((l) => /^\s*\|/.test(l) ? l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ') : l.replace(/^\s*[-*]\s+/, '• ').replace(/^#+\s*/, ''))
      .map((l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')).join('<br>');
  }
  function scrollChat() { const c = document.querySelector('.sheet'); if (c) c.scrollTop = c.scrollHeight; }
  async function askQuestion(q) {
    S.askLog = (S.askLog || []).concat({ role: 'user', content: q }); S.askBusy = true; render(); scrollChat();
    try {
      if (looksLikeAction(q)) {
        const j = await assist({ mode: 'parse', text: q, context: quickContext() });
        const acts = j.actions || [];
        S.askLog = S.askLog.concat(acts.length ? { role: 'assistant', content: 'Here’s what I’ll save. Check it, then tap Save.', actions: acts } : { role: 'assistant', content: j.note || 'I couldn’t match that to a bill, tenant or task. Try naming the floor, like “paid PSEG 2nd floor $96”.' });
      } else {
        const history = S.askLog.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
        const j = await assist({ mode: 'ask', question: q, history, context: askContext() });
        S.askLog = S.askLog.concat({ role: 'assistant', content: j.answer || 'No answer.' });
      }
    } catch (e) { S.askLog = S.askLog.concat({ role: 'assistant', content: e.message || friendlyErr(e), retry: q }); }
    S.askBusy = false; render(); scrollChat();
  }

  // ----- G · Weekly story -----
  function weekStart() { const d = today(); return isoDate(new Date(d.getTime() - ((d.getDay() + 6) % 7) * 86400000)); }
  function storySeen() { try { return localStorage.getItem('ds-story') === weekStart(); } catch (_) { return false; } }
  function storySlides() {
    const now = today(); const wk = new Date(now.getTime() - 7 * 86400000);
    const cur = monthKey(new Date());
    const md = billMonth(cur, true);
    const paidWeek = Object.values(S.payments).filter((p) => p.paid_at && new Date(p.paid_at) >= wk)
      .map((p) => ({ p, b: S.bills.find((x) => x.id === p.bill_id) })).filter((x) => x.b && !x.b.escrow);
    const sum = paidWeek.reduce((t, x) => t + (amountFor(x.b, x.p) || 0), 0);
    const late = md.rows.filter((r) => !(r.pay && r.pay.paid_at) && r.st.k === 'late');
    const slides = [];
    slides.push(paidWeek.length
      ? { tone: 'green', kicker: 'This week', big: paidWeek.length + (paidWeek.length === 1 ? ' bill' : ' bills') + ' paid · ' + money0(sum), body: (late.length ? late.length + ' still overdue: ' + late.map((r) => billTitle(r.b)).join(', ') + '.' : 'Nothing overdue. No late fees.') + ' Paid: ' + paidWeek.slice(0, 4).map((x) => billTitle(x.b)).join(', ') + (paidWeek.length > 4 ? ' and more' : '') + '.', cta: ['See bills', 'go-bills'] }
      : { tone: 'green', kicker: 'This week', big: late.length ? late.length + ' bill' + (late.length === 1 ? ' is' : 's are') + ' overdue' : 'A quiet week', body: late.length ? late.map((r) => billTitle(r.b) + (r.amt != null ? ' (' + money0(r.amt) + ')' : '')).join(', ') + '. Pay to keep your streak.' : 'No bills were paid or due in the last 7 days.', cta: ['See bills', 'go-bills'] });
    const rm = rentMonth(cur); const rr = rm.rows.filter((x) => !isHome(x.r.unit_id) && x.due != null);
    if (rr.length) {
      const got = rr.reduce((t, x) => t + x.got, 0), due = rr.reduce((t, x) => t + (x.due || 0), 0);
      const lateR = rr.filter((x) => x.st.k === 'late');
      slides.push({ tone: 'gold', kicker: monthLabel(cur).split(' ')[0] + ' rent', big: money0(got) + ' in' + (due > got ? ' · ' + money0(due - got) + ' to go' : ''), body: rr.map((x) => rentalTitle(x.r) + ': ' + x.st.label.toLowerCase()).join('\n'), list: true, meter: due ? Math.min(1, got / due) : 0, cta: lateR.length ? ['Open Rent', 'go-rent'] : null });
    }
    let best = null;
    md.rows.forEach((r) => { if (r.amt == null || r.b.amount_type === 'fixed' || r.b.category === 'Mortgage') return; const ly = lastYear(r.b, cur); if (!ly) return; const d = r.amt - ly; if (!best || Math.abs(d) > Math.abs(best.d)) best = { r, ly, d }; });
    if (best) {
      const pct = Math.round((best.d / best.ly) * 100);
      const a = S.hdd[hddKey(cur)], c = S.hdd[addMonths(hddKey(cur), -12)];
      const wx = a && c && a.days && c.days ? (a.hdd / a.days > (c.hdd / c.days) * 1.05 ? ' It was colder than last year.' : a.hdd / a.days < (c.hdd / c.days) * 0.95 ? ' It was milder than last year.' : '') : '';
      const ly = addMonths(cur, -12);
      slides.push({ tone: 'blue', kicker: 'Biggest change', big: billTitle(best.r.b) + (pct === 0 ? ' same as last year' : (pct > 0 ? ' up ' : ' down ') + Math.abs(pct) + '%'), body: money0(best.r.amt) + ' this month vs ' + money0(best.ly) + ' a year ago.' + wx, bars: [[monthLabel(ly, true) + ' ’' + ly.slice(2, 4), best.ly], [monthLabel(cur, true) + ' ’' + cur.slice(2, 4), best.r.amt]], cta: ['Why?', 'explain:' + best.r.b.id] });
    }
    const soon = [];
    md.rows.forEach((r) => { if ((r.pay && r.pay.paid_at) || !r.due) return; const d = dayDiff(r.due); if (d >= 0 && d <= 14) soon.push({ d, t: billTitle(r.b) + (r.amt != null ? ' · ' + money0(r.amt) : '') + ' · ' + fmtDay(r.due) }); });
    S.tasks.filter((t) => t.active !== false && t.next_due).forEach((t) => { const d = dayDiff(fromIso(t.next_due)); if (d >= -60 && d <= 14) soon.push({ d, t: t.title + ' · ' + (d < 0 ? 'overdue' : fmtDay(fromIso(t.next_due))) }); });
    soon.sort((p, q) => p.d - q.d);
    slides.push({ tone: 'rust', kicker: 'Coming up', big: soon.length ? soon.length + (soon.length === 1 ? ' thing' : ' things') + ' in the next 2 weeks' : 'Nothing due soon', body: soon.length ? soon.slice(0, 5).map((x) => x.t).join('\n') : 'Enjoy the quiet.', list: !!soon.length, cta: soon.length ? ['Open calendar', 'go-cal'] : null });
    const n = billsStreak();
    slides.push({ tone: 'dark', kicker: 'Your streak', big: n >= 1 ? '🔥 ' + n + (n === 1 ? ' month' : ' months') + ' on time' : 'Start a streak', body: n >= 1 ? 'Every bill paid by its due date' + (n > 1 ? ', ' + n + ' months running.' : '.') + ' Keep it going.' : 'Pay every bill by its due date this month to start one.', cta: ['Done', 'close'] });
    return slides;
  }
  function storyView() {
    const sl = S.story.slides; const i = S.story.i; const s = sl[i];
    const ws = fromIso(weekStart());
    const bars = sl.map((x, k) => `<span class="sbar"><i class="${k < i ? 'done' : k === i ? 'on' : ''}"></i></span>`).join('');
    const max = s.bars ? Math.max(...s.bars.map((b) => b[1]), 1) : 1;
    const chart = s.bars ? `<div class="s-chart r3">${s.bars.map((b, k) => `<div class="s-col"><span class="s-val">${money0(b[1])}</span><i style="height:${Math.round((b[1] / max) * 130)}px;animation-delay:${0.5 + k * 0.15}s;opacity:${k ? 1 : 0.5}"></i><span>${esc(b[0])}</span></div>`).join('')}</div>` : '';
    const meter = s.meter != null ? `<div class="s-meter r3"><i style="width:${Math.round(s.meter * 100)}%"></i></div>` : '';
    const body = s.list ? `<ul class="s-list r3">${s.body.split('\n').map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : `<p class="s-body r3">${esc(s.body)}</p>`;
    return `<div class="story tone-${s.tone}" role="dialog" aria-modal="true" aria-label="Your week">
      <div class="story-bars" aria-hidden="true">${bars}</div>
      <div class="story-top"><span>Your week · ${fmtDay(ws)}–${fmtDay(new Date(ws.getTime() + 6 * 86400000))}</span><button type="button" class="iconbtn story-x" data-act="story-close" aria-label="Close">${ICON.close}</button></div>
      <div class="story-main" data-slide="${i}">
        <span class="s-kicker r1">${esc(s.kicker)}</span>
        <h2 class="display s-big r2">${esc(s.big)}</h2>
        ${meter}${body}${chart}
      </div>
      <button type="button" class="story-tap prev" data-act="story-prev" aria-label="Previous slide"></button>
      <button type="button" class="story-tap next" data-act="story-next" aria-label="Next slide"></button>
      <div class="story-foot"><span class="small">${i + 1} of ${sl.length}</span>${s.cta ? `<button type="button" class="btn story-cta" data-act="story-cta" data-go="${esc(s.cta[1])}">${esc(s.cta[0])}</button>` : `<button type="button" class="btn story-cta" data-act="story-next">Next</button>`}</div>
    </div>`;
  }
  function storyBar() {
    if (S.month !== monthKey(new Date())) return '';
    const seen = storySeen();
    return `<button type="button" class="storybar" data-act="story-open"><span class="sring${seen ? ' seen' : ''}">${HOUSE_AVATAR}</span><span class="stack" style="gap:1px;text-align:left;flex:1"><strong>Your week</strong><span class="small muted">${seen ? 'Watch again' : 'New · a quick look back'}</span></span><span aria-hidden="true" class="muted">›</span></button>`;
  }
  function openStory() { S.story = { i: 0, slides: storySlides() }; try { localStorage.setItem('ds-story', weekStart()); } catch (_) {} render(); }
  function storyGo(n) { if (!S.story) return; if (n < 0) n = 0; if (n >= S.story.slides.length) { S.story = null; } else S.story.i = n; render(); }

  // ----- H · Where the rent goes -----
  function flowCat(c) { if (c === 'Mortgage') return 'Mortgage'; if (c === 'Property tax' || c === 'Insurance') return 'Taxes & insurance'; if (c === 'Gas') return 'Heat & gas'; return c || 'Other'; }
  const FLOW_COL = ['#2A3566', '#2B4C9B', '#C2552B', '#4C86A8', '#8A6FB0', '#7A847F'];
  function flowData(k) {
    const isPast = k < monthKey(new Date());
    const rm = rentMonth(k);
    const rentIn = rm.rows.filter((x) => !isHome(x.r.unit_id)).reduce((t, x) => t + (isPast ? x.got : Math.max(x.got, x.due || 0)), 0);
    const g = new Map();
    billMonth(k, true).rows.filter((r) => !r.b.escrow && !isHome(r.b.unit_id) && r.amt).forEach((r) => { const c = flowCat(r.b.category); g.set(c, (g.get(c) || 0) + r.amt); });
    const up = upkeepSplit(k, false); if (up) g.set('Upkeep', (g.get('Upkeep') || 0) + up);
    let outs = Array.from(g, ([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
    if (outs.length > 5) { const rest = outs.slice(4); outs = outs.slice(0, 4).concat({ name: 'Other', v: rest.reduce((t, x) => t + x.v, 0) }); }
    outs.forEach((o, i) => { o.c = FLOW_COL[i % FLOW_COL.length]; });
    const out = outs.reduce((t, x) => t + x.v, 0);
    const keep = rentIn - out;
    if (keep > 0.5) outs.push({ name: 'You keep', v: keep, c: 'var(--accent)', keep: true });
    return { rentIn, outs, out, keep, pocket: keep < -0.5 ? -keep : 0, est: !isPast };
  }
  function flowCard() {
    const k = S.month; const d = flowData(k);
    if (!d.rentIn && !d.out) return '';
    const total = d.rentIn + d.pocket;
    const W = 340, H = 240, gap = 5, n = d.outs.length;
    const usable = H - gap * (n - 1);
    const sel = S.flowSel && d.outs.find((o) => o.name === S.flowSel) ? S.flowSel : (d.outs.find((o) => o.keep) || d.outs[0] || {}).name;
    let ly = 0, ry = 0; const ribs = [];
    d.outs.forEach((o, i) => {
      const lh = (o.v / total) * H, rh = Math.max(6, (o.v / total) * usable);
      const l0 = ly, l1 = ly + lh, r0 = ry, r1 = ry + rh;
      const p = `M14 ${l0.toFixed(1)} C170 ${l0.toFixed(1)} 170 ${r0.toFixed(1)} ${W - 14} ${r0.toFixed(1)} L${W - 14} ${r1.toFixed(1)} C170 ${r1.toFixed(1)} 170 ${l1.toFixed(1)} 14 ${l1.toFixed(1)} Z`;
      const mid = `M14 ${((l0 + l1) / 2).toFixed(1)} C170 ${((l0 + l1) / 2).toFixed(1)} 170 ${((r0 + r1) / 2).toFixed(1)} ${W - 14} ${((r0 + r1) / 2).toFixed(1)}`;
      ribs.push(`<defs><linearGradient id="fg${i}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#C9A15A"/><stop offset=".55" stop-color="${o.c}"/></linearGradient></defs><g class="rib${o.name === sel ? ' on' : ''}" data-act="flow-sel" data-k="${esc(o.name)}" style="animation-delay:${(i * 0.08).toFixed(2)}s"><path d="${p}" fill="url(#fg${i})"/>${lh > 3 ? `<path class="ribflow" d="${mid}"/>` : ''}</g><rect x="${W - 12}" y="${r0.toFixed(1)}" width="12" height="${rh.toFixed(1)}" rx="3" fill="${o.c}"/>`);
      ly = l1; ry = r1 + gap;
    });
    const rentH = (d.rentIn / total) * H;
    const left = `<rect x="0" y="0" width="12" height="${rentH.toFixed(1)}" rx="3" fill="#C9A15A"/>${d.pocket ? `<rect x="0" y="${rentH.toFixed(1)}" width="12" height="${(H - rentH).toFixed(1)}" rx="3" fill="var(--late-fg)"/>` : ''}`;
    const fmt = (v) => S.flowPct ? Math.round((v / (d.rentIn || total)) * 100) + '%' : money0(v);
    const s = d.outs.find((o) => o.name === sel);
    const per100 = s && d.rentIn ? Math.round((s.v / d.rentIn) * 100) : null;
    const detail = s ? (s.keep ? `You keep <strong>$${per100}</strong> of every $100 of rent.` : per100 != null && per100 > 100 ? `<strong>${esc(s.name)}</strong> alone is more than the rent: ${money0(s.v)} vs ${money0(d.rentIn)}.` : per100 != null ? `<strong>${esc(s.name)}</strong> takes <strong>$${per100}</strong> of every $100 of rent.` : `<strong>${esc(s.name)}</strong> · ${money0(s.v)}`) : '';
    return `<section class="card flow" aria-label="Where the rent goes">
      <div class="row between"><h2>Where the rent goes · ${monthLabel(k, true)}</h2><div class="seg mini" role="group" aria-label="Show as">${[[0, '$'], [1, '%']].map(([v, l]) => `<button type="button" data-act="flow-mode" data-v="${v}" aria-pressed="${!!S.flowPct === !!v}">${l}</button>`).join('')}</div></div>
      <div class="flow-ends small"><span><i style="background:#C9A15A"></i>Rent ${d.est ? 'due' : 'in'} · <strong class="num">${money0(d.rentIn)}</strong></span>${d.pocket ? `<span class="late"><i style="background:var(--late-fg)"></i>From your pocket · <strong class="num">${money0(d.pocket)}</strong></span>` : ''}</div>
      <svg class="flowsvg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Rent of ${money0(d.rentIn)} split into ${d.outs.map((o) => o.name + ' ' + money0(o.v)).join(', ')}">${left}${ribs.join('')}</svg>
      <p class="flow-detail" aria-live="polite">${detail}</p>
      <ul class="flow-legend">${d.outs.map((o) => `<li><button type="button" data-act="flow-sel" data-k="${esc(o.name)}" aria-pressed="${o.name === sel}"><i style="background:${o.c}"></i><span>${esc(o.name)}</span><strong class="num">${fmt(o.v)}</strong></button></li>`).join('')}</ul>
      ${d.est ? '<p class="small muted" style="margin:0">Uses this month’s bills and the rent that’s due.</p>' : ''}
    </section>`;
  }

  // ----- Polished 2 · Bill detail header -----
  const CAT_ICON = { Electric: '⚡', Gas: '🔥', Water: '💧', Mortgage: '🏠', Insurance: '🛡', 'Property tax': '🏛', Trash: '🗑', 'Internet & phone': '📶', Contractor: '🔧' };
  function billDetailTop(b, pay) {
    const k = S.month; const amt = amountFor(b, pay);
    const paid = !!(pay && pay.paid_at);
    const months = []; for (let i = 11; i >= 0; i--) { const mk = addMonths(k, -i); const p = getPay(b, mk); months.push({ k: mk, v: p ? amountFor(b, p) : null }); }
    const vals = months.map((x) => x.v).filter((v) => v != null && v > 0);
    const max = Math.max(1, ...vals);
    const avg = vals.length ? vals.reduce((t, n) => t + n, 0) / vals.length : null;
    const selI = S.bdSel && S.bdSel.id === b.id && S.bdSel.k === k ? S.bdSel.i : 11;
    const sm = months[selI];
    const ly = lastYear(b, k);
    const delta = amt != null && ly ? amt - ly : null;
    const st = statusFor(b, pay, k);
    const due = dueOn(b.due_day, k);
    const pts = months.map((x, i) => x.v != null && x.v > 0 ? [((i + 0.5) / 12) * 100, 100 - (x.v / max) * 100] : null).filter(Boolean);
    const trend = pts.length >= 3 ? `<svg class="bd-trend" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}"/></svg>` : '';
    const bars = months.map((x, i) => `<button type="button" class="bd-bar${i === selI ? ' sel' : ''}${i === 11 ? ' cur' : ''}" data-act="bd-bar" data-id="${b.id}" data-i="${i}" aria-pressed="${i === selI}" aria-label="${monthLabel(x.k)}: ${x.v != null ? money(x.v) : 'no amount'}"><i style="height:${x.v ? Math.max(4, Math.round((x.v / max) * 100)) : 2}%;animation-delay:${(i * 0.04).toFixed(2)}s"></i><span>${monthLabel(x.k, true).slice(0, 1)}</span></button>`).join('');
    const justPaid = paid && FX.stamp === b.id && Date.now() < FX.stampUntil;
    const slide = b.escrow ? '' : `<button type="button" class="slidepay${paid ? ' on' : ''}${justPaid ? ' slid' : ''}" data-act="toggle" data-id="${b.id}" aria-pressed="${paid}" aria-label="${paid ? 'Paid. Tap to mark unpaid' : 'Mark ' + esc(billTitle(b)) + ' paid'}"><span class="sp-knob" aria-hidden="true">${paid ? '✓' : '→'}</span><span class="sp-label">${paid ? 'Paid ' + fmtDay(new Date(pay.paid_at)) + ' · tap to undo' : 'Slide to mark paid'}</span>${justPaid ? '<span class="paidstamp slam" aria-hidden="true">PAID</span>' : ''}</button>`;
    const curK = monthKey(new Date());
    const backBar = k !== curK ? `<div class="bd-back"><span>Showing <strong>${monthLabel(k)}</strong></span><button type="button" class="linkbtn" data-act="bd-month" data-k="${curK}">Back to ${monthLabel(curK).split(' ')[0]}</button></div>` : '';
    return backBar + `<section class="bd-hero">
        <div class="row" style="gap:12px"><span class="bd-icon" aria-hidden="true">${CAT_ICON[b.category] || '🧾'}</span><span class="stack" style="gap:0;min-width:0"><strong class="display bd-name">${esc(b.name)}</strong><span class="small bd-sub">${esc((b.label ? b.label + ' · ' : '') + unitName(b.unit_id))} · ${esc(st.label)}</span></span></div>
        <div class="row" style="gap:10px;align-items:baseline;flex-wrap:wrap"><span class="display num bd-amt">${amt != null ? money(amt) : '—'}</span>${delta != null && Math.abs(delta) >= 1 ? `<span class="bd-chip">${delta > 0 ? '▲' : '▼'} ${money0(Math.abs(delta))} vs ${monthLabel(addMonths(k, -12), true)} ’${addMonths(k, -12).slice(2, 4)}</span>` : ''}</div>
        ${due && !paid ? `<span class="small bd-sub">Due ${due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>` : ''}
      </section>
      ${vals.length >= 2 ? `<section class="card bd-chart" aria-label="Last 12 months">
        <div class="row between"><h2>Last 12 months</h2><span class="small muted">Tap a bar</span></div>
        <div class="bd-plot">${trend}<div class="bd-bars">${bars}</div></div>
        ${selI !== 11 ? `<button type="button" class="btn block bd-edit" data-act="bd-month" data-k="${sm.k}">Edit ${monthLabel(sm.k)} ›</button>` : ''}
        <div class="grid2"><div class="stat"><span class="small muted">${monthLabel(sm.k)}</span><span class="v display num">${sm.v != null ? money(sm.v) : '—'}</span></div><div class="stat"><span class="small muted">12-month average</span><span class="v display num">${avg != null ? money(avg) : '—'}</span></div></div>
      </section>` : ''}
      ${slide}`;
  }

  // ----- Rent tab -----
  function rentTab() {
    const md = rentMonth(S.month);
    const pct = md.expected > 0 ? Math.min(100, Math.round((md.received / md.expected) * 100)) : 0;
    const soon = S.rentals.filter((r) => r.active !== false && !r.move_out_on && r.lease_end && dayDiff(fromIso(r.lease_end)) <= 90 && dayDiff(fromIso(r.lease_end)) >= -30);
    const depDue = S.rentals.filter((r) => r.move_out_on && !r.deposit_returned_on);
    const needs = md.rows.filter((x) => x.st.k === 'setup').length;
    return `${monthNav()}
      ${houseHero(md, pct)}
      ${needs ? `<p class="notice">Add each tenant’s rent amount so the app can track it. Tap <strong>Details</strong> on the card.</p>` : ''}
      ${soon.map((r) => { const d = dayDiff(fromIso(r.lease_end)); return `<p class="notice info">${esc(rentalTitle(r))}’s lease ${d < 0 ? 'ended' : 'ends'} ${fmtDate(fromIso(r.lease_end))}${d >= 0 ? ' (' + d + ' days)' : ''}. <button class="linkbtn" data-act="renew" data-id="${r.id}" style="min-height:0;padding:0">Renew</button> or <button class="linkbtn" data-act="moveout" data-id="${r.id}" style="min-height:0;padding:0">plan move-out</button></p>`; }).join('')}
      ${depDue.map((r) => { const by = new Date(fromIso(r.move_out_on).getTime() + 14 * 86400000); const d = dayDiff(by); return `<p class="notice${d <= 3 ? '' : ' info'}">Return ${esc(rentalTitle(r))}’s deposit${r.deposit ? ' (' + money(r.deposit) + ')' : ''} with an itemized list by <strong>${fmtDate(by)}</strong>${d >= 0 ? ' (' + d + ' days)' : ' (overdue)'}. <button class="linkbtn" data-act="moveout" data-id="${r.id}" style="min-height:0;padding:0">Record it</button></p>`; }).join('')}
      ${noticesCard()}
      ${unmatchedCard()}
      ${vacantCards()}
      ${rentList(md)}
      ${mortgageCard()}`;
  }
  const TURNOVER = ['Repairs from move-out inspection', 'Paint touch-ups', 'Deep clean', 'Change locks', 'Test smoke & CO detectors', 'Take listing photos', 'List the unit', 'Schedule showings', 'Screen applicants', 'Sign lease & collect deposit'];
  function vacantUnits() { return S.units.filter((u) => isFloor(u.name) && !u.exclude_from_tax && !isPersonal(u.id) && !S.rentals.some((r) => r.active !== false && r.unit_id === u.id)); }
  function vacantCards() {
    return vacantUnits().map((u) => {
      const prev = S.rentals.filter((r) => r.unit_id === u.id).sort((a, b) => (b.move_out_on || '').localeCompare(a.move_out_on || ''))[0];
      const since = u.vacant_since || (prev && prev.move_out_on) || null;
      const days = since ? Math.max(0, -dayDiff(fromIso(since))) : null;
      const rent = prev && prev.rent_amount ? Number(prev.rent_amount) : null;
      const lost = days != null && rent ? (rent * days) / 30 : null;
      const list = (u.turnover && u.turnover.length ? u.turnover : TURNOVER.map((item) => ({ item, done: false })));
      const done = list.filter((x) => x.done).length;
      return `<section class="card" aria-label="${esc(u.name)} is vacant">
        <div class="row between"><h2>${esc(u.name)} · vacant</h2><span class="pill setup" style="margin:0">${days != null ? days + (days === 1 ? ' day' : ' days') : 'Vacant'}</span></div>
        ${lost != null ? `<p class="small">About <strong>${money0(lost)}</strong> in rent missed so far (at ${money0(rent)}/month).</p>` : ''}
        <div class="row" style="gap:8px;align-items:flex-end"><div class="field" style="flex:1"><label for="vs-${u.id}">Vacant since</label><input class="input" id="vs-${u.id}" type="date" value="${esc(since || '')}" data-change="vacant-since" data-id="${u.id}"></div></div>
        <div class="stack" style="gap:2px"><span class="lab small">Turnover checklist · ${done} of ${list.length}</span>
          <div class="meter"><div style="width:${Math.round((done / list.length) * 100)}%"></div></div>
          ${list.map((x, i) => `<label class="checkrow"><input type="checkbox" data-change="turnover" data-id="${u.id}" data-i="${i}" ${x.done ? 'checked' : ''}> ${esc(x.item)}</label>`).join('')}
        </div>
        <button class="btn primary-soft" data-act="new-rental-unit" data-unit="${u.id}">Add the new tenant</button>
      </section>`;
    }).join('');
  }
  function saveUnit(u) { const i = S.units.findIndex((x) => x.id === u.id); S.units[i] = u; queue({ kind: 'update', table: 'units', row: { turnover: u.turnover || null, vacant_since: u.vacant_since || null }, match: { id: u.id } }); }
  function houseHero(md, pct) {
    const floors = S.units.filter((u) => isFloor(u.name) && !u.exclude_from_tax).sort((a, b) => b.sort - a.sort);
    const homes = S.units.filter((u) => u.exclude_from_tax);
    const look = { paid: ['#A9BCF5', 'Paid', true], soon: ['#F2C46B', '', true], late: ['#E46A4B', 'Late', true], up: ['#3A4843', 'Due', false], setup: ['#3A4843', 'No rent set', false], auto: ['#3A4843', 'Due', false] };
    const wins = floors.map((u) => {
      const row = md.rows.find((x) => x.r.unit_id === u.id);
      let label = 'Vacant', txt = '#C9D1CC';
      if (row) { const L = look[row.st.k] || look.up; label = L[1] || (row.st.label.startsWith('Partial') ? 'Partial' : row.st.label.split(' ·')[0]); txt = L[2] ? L[0] : '#C9D1CC'; }
      return { chip: `<button type="button" class="hchip" data-act="${row ? 'rental' : 'new-rental-unit'}" ${row ? `data-id="${row.r.id}"` : `data-unit="${u.id}"`}><span>${esc(u.name)}</span><strong style="color:${txt}">${esc(label)}</strong></button>` };
    });
    const key = 'rent-' + S.month;
    return `<section class="hero househero" aria-label="Rent collected">
      ${tideBall(key, pct, '', `<span class="label">Rent collected</span>${rollNum(key, md.received)}<span class="tide-pct">${pct}% in</span>`)}
      <div class="hchips">${wins.map((w) => w.chip).join('')}</div>
      <div class="foot"><span>of ${money(md.expected)} expected</span><span class="${md.late ? 'late' : ''}">${md.late ? md.late + ' late' : 'None late'}</span></div>
      ${homes.length ? `<div class="homechip"><svg width="28" height="24" viewBox="0 0 56 48" aria-hidden="true"><path d="M28 4 L52 22 L4 22 Z" style="fill:#A9BCF5"></path><rect x="10" y="22" width="36" height="24" rx="2" style="fill:#34403B;stroke:#A9BCF5;stroke-width:3"></rect></svg><span>${esc(homes.map((u) => u.name).join(', '))} · your home, kept separate</span></div>` : ''}
    </section>`;
  }
  function lastRentMethod(r) {
    const prev = Object.values(S.rentPays).filter((p) => p.rental_id === r.id && p.method && Number(p.amount_received) > 0).sort((a, b) => b.period.localeCompare(a.period))[0];
    return prev ? prev.method : 'Zelle';
  }
  function payStrip(r) {
    const cur = monthKey(new Date()); const cells = []; let recs = 0, onTime = 0, counted = 0;
    for (let i = 11; i >= 0; i--) {
      const k = addMonths(cur, -i); const rp = getRentPay(r, k); const due = rentDue(r, rp);
      const before = r.lease_start && k < r.lease_start.slice(0, 7) + '-01';
      const got = rp ? Number(rp.amount_received || 0) : 0;
      let st = 'none', label = 'no record';
      if (before) { st = 'before'; label = 'before the lease'; }
      else if (rp && got > 0) { recs++; counted++; if (due != null && got < due) { st = 'partial'; label = 'partly paid'; } else if (rentOnTime(r, k)) { st = 'ok'; label = 'on time'; onTime++; } else { st = 'late'; label = 'paid late'; } }
      else if (k === cur && due != null) { const d = dueOn(r.due_day, k); const lateNow = d && dayDiff(d) < -(r.grace_days || 0); st = lateNow ? 'miss' : 'wait'; label = lateNow ? 'late, not paid' : 'not due yet'; if (lateNow) counted++; }
      cells.push(`<i class="ps ${st}" title="${monthLabel(k, true)}: ${label}"></i>`);
    }
    if (recs < 2) return '';
    return `<div class="paystrip" role="img" aria-label="Last 12 months: ${onTime} of ${counted} on time"><div class="ps-row">${cells.join('')}</div><span class="small muted">${onTime} of ${counted} on time · last 12 months</span></div>`;
  }
  function rentList(md) {
    if (!md.rows.length) return emptyState('people', 'No tenants yet', 'Add each floor’s tenant to track rent.', '<button class="btn primary-soft" data-act="new-rental">Add a tenant</button>');
    if (!simple()) return `<ul class="bills">${md.rows.map(rentCard).join('')}</ul>`;
    const open = md.rows.filter((x) => x.st.k !== 'paid'), done = md.rows.filter((x) => x.st.k === 'paid');
    return (open.length ? `<ul class="bills">${open.map(rentCard).join('')}</ul>` : emptyState('done', 'All rent is in', 'Every tenant has paid for ' + monthLabel(S.month).split(' ')[0] + '.'))
      + (done.length ? `<details class="paidfold" data-fold="r-paid" ${isOpen('r-paid', false) ? 'open' : ''}><summary><span>Paid <span class="count">${done.length}</span></span><span class="num muted">${money(done.reduce((t, x) => t + x.got, 0))}</span><span class="chev" aria-hidden="true"></span></summary><ul class="bills">${done.map(rentCard).join('')}</ul></details>` : '');
  }
  function rentCard(x) {
    if (!simple()) return rentCardFull(x);
    if (S.open === x.r.id) return rentCardFull(x).replace('<div class="bill-top">', LESS(x.r.id) + '<div class="bill-top">');
    const r = x.r, done = x.st.k === 'paid'; const justPaid = done && FX.stamp === r.id && Date.now() < FX.stampUntil;
    return `<li class="bill qrow swipe ${done ? 'paid' : ''}" id="rent-${r.id}" ${x.due != null ? 'data-swipe-right="rent-toggle"' : ''} data-swipe-left="rental" data-id="${r.id}" data-paid="${done}">
      <button class="check labeled" data-act="rent-toggle" data-id="${r.id}" aria-pressed="${done}" aria-label="${done ? 'Mark not received' : 'Mark received'}: rent from ${esc(rentalTitle(r))}" ${x.due == null ? 'disabled' : ''}>${ICON.check}<span class="ilab" aria-hidden="true">${done ? 'Got' : 'Got?'}</span></button>
      <button type="button" class="qmain" data-act="expand" data-id="${r.id}" aria-expanded="false" aria-label="${esc(rentalTitle(r))}, ${esc(x.st.label)}. Show details"><span class="qname">${esc(r.tenant_name || 'Tenant')} <span class="qplace">${esc(unitName(r.unit_id))}</span></span>${qstat(x.st.k, x.st.label)}</button>
      <span class="qamt num">${x.due != null ? money(done ? x.got : Math.max(0, x.due - x.got)) : '—'}</span>
      ${justPaid ? '<span class="paidstamp mini slam" aria-hidden="true">PAID</span>' : ''}
    </li>`;
  }
  function rentCardFull(x) {
    const r = x.r, done = x.st.k === 'paid';
    const unit = unitName(r.unit_id);
    const d = dueOn(r.due_day, S.month);
    const first = r.tenant_name ? r.tenant_name.split(' ')[0] : '';
    const zelle = S.household && S.household.pay_zelle;
    const late = x.st.k === 'late' || (x.got > 0 && !done);
    const msg = encodeURIComponent('Hi' + (first ? ' ' + first : '') + ', ' + (late ? 'a friendly reminder that ' : 'just a heads-up that ') + monthLabel(S.month).split(' ')[0] + ' rent' + (x.got > 0 ? ' (' + money(x.due - x.got) + ' left)' : ' of ' + money(x.due - x.got)) + (d ? (late ? ' was due ' : ' is due ') + fmtDay(d) : '') + '.' + (zelle ? ' You can Zelle it to ' + zelle + '.' : '') + ' Thank you!');
    const smsHref = 'sms:' + (r.phone ? r.phone.replace(/[^\d+]/g, '') : '') + (isIOS ? '&' : '?') + 'body=' + msg;
    const justPaid = done && FX.stamp === r.id && Date.now() < FX.stampUntil;
    return `<li class="bill swipe ${done ? 'paid' : ''}" id="rent-${r.id}" ${x.due != null ? 'data-swipe-right="rent-toggle"' : ''} data-swipe-left="rental" data-id="${r.id}" data-paid="${done}">${done ? `<span class="paidstamp${justPaid ? ' slam' : ''}" aria-hidden="true">PAID</span>` : ''}
      <div class="bill-top">
        <button class="check" data-act="rent-toggle" data-id="${r.id}" aria-pressed="${done}" aria-label="${done ? 'Mark not received' : 'Mark received'}: rent from ${esc(rentalTitle(r))}" ${x.due == null ? 'disabled' : ''}>${ICON.check}</button>
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(r.tenant_name || 'Tenant')}</span><span class="tag">${esc(unit)}</span></div>
          <span class="small muted">${x.due != null ? 'Rent ' + money(x.due) + ' · due the ' + ordinal(r.due_day) : 'Rent amount not set'}${r.late_fee ? ' · late fee ' + money(r.late_fee) : ''}</span>
          <span class="pill ${x.st.k}">${esc(x.st.label)}</span>
          ${(() => { const n = rentStreak(r); return n >= 2 ? `<span class="streak">${streakDots(n)} On time ${n} months in a row</span>` : ''; })()}
          ${payStrip(r)}
          ${x.rp && x.rp.source === 'email' ? '<span class="small muted">Recorded from Zelle email</span>' : ''}
        </div>
      </div>
      ${!done && x.due != null ? (S.partial === r.id ? `<form class="row partialrow" data-form="partial" data-id="${r.id}" style="gap:6px">
          <label class="sr" for="pt-${r.id}">Amount received</label><input class="input num" id="pt-${r.id}" name="amt" inputmode="decimal" placeholder="Amount received" style="flex:1;min-width:0" autocomplete="off">
          <button class="btn primary-soft" type="submit">Save</button><button class="btn" type="button" data-act="partial-cancel">Cancel</button></form>`
        : `<div class="btns gotrow"><button class="btn gotbtn" data-act="rent-toggle" data-id="${r.id}" style="flex:2">✓ Got ${money(x.due - x.got)}<span class="small"> · ${esc(lastRentMethod(r))}</span></button><button class="btn" data-act="partial" data-id="${r.id}" style="flex:1">Partial</button></div>`) : ''}
      <div class="btns">
        ${!done && x.due != null ? `<a class="btn${late ? ' textbtn' : ''}" href="${esc(smsHref)}" aria-label="Text ${esc(first || 'tenant')} a rent reminder">💬 Text ${esc(first || 'reminder')}</a>` : ''}
        ${r.phone ? `<a class="btn" href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        ${x.got > 0 ? `<button class="btn" data-act="receipt" data-id="${r.id}">Receipt</button>` : ''}
        <button class="btn" data-act="rental" data-id="${r.id}" style="flex:1">Details</button>
      </div>
    </li>`;
  }
  function noticesCard() {
    const list = (S.notices || []).filter((n) => n.status === 'pending');
    if (!list.length) return '';
    return `<section class="card notices" aria-label="Tenants say they paid">
      <h2>Tenants say they paid <span class="count">${list.length}</span></h2>
      ${list.map((n) => { const r = S.rentals.find((x) => x.id === n.rental_id); return `<div class="notice-row">
        <div class="stack" style="gap:2px;min-width:0"><strong>${esc(r ? rentalTitle(r) : 'Tenant')} · ${money(n.amount)}</strong>
        <span class="small muted">${esc(n.method || '')}${n.method ? ' · ' : ''}${fmtDay(new Date(n.created_at))} · ${esc(monthLabel(n.period.slice(0, 7) + '-01', true))} rent${n.note ? ' · “' + esc(n.note) + '”' : ''}</span></div>
        <div class="btns" style="flex:none"><button type="button" class="btn primary-soft" data-act="notice-ok" data-id="${n.id}">Confirm</button><button type="button" class="btn" data-act="notice-no" data-id="${n.id}">Not yet</button></div>
      </div>`; }).join('')}
      <p class="small muted" style="margin:0">Confirm once you see the money in your account. It’s then marked received for that month.</p>
    </section>`;
  }
  function unmatchedCard() {
    const list = S.imports.filter((x) => x.kind === 'zelle' && x.status === 'unmatched' && x.amount != null);
    if (!list.length) return '';
    const opts = S.rentals.filter((r) => r.active !== false).map((r) => `<option value="${r.id}">${esc(rentalTitle(r))} · ${esc(unitName(r.unit_id))}</option>`).join('');
    return `<section class="card" aria-label="Payments to check">
      <h2>Payments to check</h2>
      <p class="small muted">These Zelle payments didn’t match a tenant. Pick who sent it. Add their Zelle name under the tenant’s Details so it matches next time.</p>
      ${list.map((x) => `<div class="stack" style="gap:6px;padding-top:10px;border-top:1px solid var(--line-2)">
        <div class="row between"><strong>${money(x.amount)} from ${esc(x.payer || 'unknown')}</strong><span class="small muted">${x.received_at ? fmtDay(new Date(x.received_at)) : ''}</span></div>
        <div class="row wrap" style="gap:8px">
          <label class="sr" for="as-${esc(x.message_id)}">Tenant for this payment</label>
          <select class="input" id="as-${esc(x.message_id)}" style="flex:1;min-width:160px">${opts}</select>
          <button class="btn" data-act="assign-zelle" data-mid="${esc(x.message_id)}">Assign</button>
          <button class="btn" data-act="dismiss-zelle" data-mid="${esc(x.message_id)}">Not rent</button>
        </div></div>`).join('')}
    </section>`;
  }
  function mortgageCard() {
    const mort = S.bills.filter((b) => b.active !== false && b.category === 'Mortgage');
    if (!mort.length) return '';
    return `<section class="card" aria-label="Mortgage">
      <h2>Mortgage</h2>
      ${mort.map((b) => { const p = getPay(b, S.month); const st = statusFor(b, p, S.month); const a = amountFor(b, p);
        return `<div class="row between wrap"><div class="stack" style="gap:2px"><strong>${esc(billTitle(b))}</strong><span class="pill ${st.k}" style="margin-top:0">${esc(st.label)}</span></div>
          <div class="row"><span class="display num" style="font-size:20px;font-weight:650">${a != null ? money(a) : '—'}</span><button class="btn" data-act="bill" data-id="${b.id}">Details</button></div></div>`; }).join('')}
      ${mort.map(mortgageStats).join('')}
      <p class="small muted">Tip: add each statement’s principal and interest under Details.</p>
    </section>`;
  }
  function mortgageStats(b) {
    const yr = S.month.slice(0, 4);
    const pays = Object.values(S.payments).filter((p) => p.bill_id === b.id && p.period.startsWith(yr));
    const sum = (k) => pays.reduce((t, p) => t + (Number(p[k]) || 0), 0);
    const latest = Object.values(S.payments).filter((p) => p.bill_id === b.id && p.balance_after != null).sort((x, y) => y.period.localeCompare(x.period))[0];
    const bal = latest ? Number(latest.balance_after) : (b.loan_balance != null ? Number(b.loan_balance) : null);
    const eq = b.home_value != null && bal != null ? Number(b.home_value) - bal : null;
    if (bal == null && !sum('interest') && !sum('principal')) return `<p class="small muted">Add the loan balance and rate under Details to see equity.</p>`;
    return `<div class="grid2">
      <div class="stat"><span class="small muted">Loan balance</span><span class="v display num">${bal != null ? money0(bal) : '—'}</span>${b.loan_rate ? `<span class="small muted">${Number(b.loan_rate)}% rate</span>` : ''}</div>
      <div class="stat"><span class="small muted">Estimated equity</span><span class="v display num">${eq != null ? money0(eq) : '—'}</span>${eq != null && b.home_value ? `<span class="small muted">${Math.round((eq / Number(b.home_value)) * 100)}% of ${money0(b.home_value)}</span>` : '<span class="small muted">Add home value</span>'}</div>
      <div class="stat"><span class="small muted">Interest paid ${yr}</span><span class="v display num">${money0(sum('interest'))}</span></div>
      <div class="stat"><span class="small muted">Principal paid ${yr}</span><span class="v display num">${money0(sum('principal'))}</span></div>
    </div>`;
  }

  // ----- Upkeep tab -----
  function upkeepTab() {
    const tasks = S.tasks.filter((t) => t.active !== false).map((t) => ({ t, st: taskStatus(t) }));
    tasks.sort((a, b) => a.st.diff - b.st.diff || a.t.title.localeCompare(b.t.title));
    const overdue = tasks.filter((x) => x.st.k === 'late').length;
    const soon = tasks.filter((x) => x.st.k === 'soon').length;
    const unsched = tasks.filter((x) => x.st.k === 'setup').length;
    const yr = String(new Date().getFullYear());
    const spent = S.logs.filter((l) => (l.done_on || '').startsWith(yr)).reduce((t, l) => t + (Number(l.cost) || 0), 0);
    const seg = [['upcoming', 'To do'], ['history', 'History'], ['appliances', 'Appliances'], ['pros', 'Pros'], ['docs', 'Docs']]
      .map(([id, l]) => `<button class="chip" data-act="upkeep-view" data-v="${id}" aria-pressed="${S.upkeepView === id}">${l}</button>`).join('');
    const nav = `<div class="chips" role="group" aria-label="House section">${seg}</div>`;
    if (S.upkeepView === 'appliances') return nav + appliancesView();
    if (S.upkeepView === 'pros') return nav + prosView();
    if (S.upkeepView === 'docs') return nav + docsView();
    let body;
    if (S.upkeepView === 'history') {
      body = `<label class="btn block scanbtn"><input type="file" accept="image/*" capture="environment" class="sr" data-change="scan-receipt"> ${ICON.camera} Snap a receipt</label>` + (S.logs.length ? `<ul class="bills">${S.logs.map(logCard).join('')}</ul>` : emptyState('tools', 'Nothing logged yet', 'Tap Done on a task, or log a repair, to build your house history.', '<button class="btn primary-soft" data-act="new-log">Log a repair</button>'));
    } else {
      const sched = tasks.filter((x) => x.st.k !== 'setup');
      const un = tasks.filter((x) => x.st.k === 'setup');
      const next = sched.filter((x) => x.st.diff <= 30), later = sched.filter((x) => x.st.diff > 30);
      body = requestsSection() +
        (next.length ? `<h2 class="section-h">Do next <span class="count">${next.length}</span></h2><ul class="bills">${next.map(taskCard).join('')}</ul>` : (sched.length ? emptyState('calm', 'Nothing due for a month', 'The house is in good shape.') : '')) +
        (later.length ? `<details class="paidfold" data-fold="u-later" ${isOpen('u-later', false) ? 'open' : ''}><summary><span>Later <span class="count">${later.length}</span></span><span class="small muted">next: ${esc(later[0].t.title)}</span><span class="chev" aria-hidden="true"></span></summary><ul class="bills" style="padding-top:10px">${later.map(taskCard).join('')}</ul></details>` : '') +
        (simple() ? '' : yearWheel()) +
        (un.length ? `<h2 class="section-h">Not scheduled yet</h2><p class="small muted" style="margin:-8px 0 0">Tap <strong>Done</strong> and enter when it was last done; the app works out the next date.</p><ul class="bills">${un.map(taskCard).join('')}</ul>` : '') +
        (!tasks.length ? emptyState('tools', 'No upkeep tasks', 'Add the jobs that keep the house healthy.', '<button class="btn primary-soft" data-act="new-task">Add a task</button>') : '');
    }
    return `${nav}${weatherBanner()}<section class="hero" aria-label="Upkeep overview">
        <div class="row between" style="align-items:flex-end">
          <div class="stack" style="gap:2px"><span class="label">Needs attention</span><span class="big display">${overdue + soon} ${overdue + soon === 1 ? 'task' : 'tasks'}</span></div>
        </div>
        <div class="foot"><span class="${overdue ? 'late' : ''}">${overdue} overdue · ${soon} due in 30 days${unsched ? ' · ' + unsched + ' not scheduled' : ''}</span></div>
        <div class="foot"><span>Spent on upkeep in ${yr}</span><span class="num">${money(spent)}</span></div>
      </section>
      ${simple() ? '' : '<div class="btns"><button class="btn" data-act="new-log" style="flex:1">Log a repair</button><button class="btn" data-act="new-task" style="flex:1">Add a task</button></div>'}
      ${body}`;
  }

  // ----- Appliances / Pros / Docs -----
  function applianceStatus(a) {
    const out = [];
    if (a.warranty_until) {
      const d = dayDiff(fromIso(a.warranty_until));
      out.push(d < 0 ? { k: 'up', label: 'Warranty ended ' + fmtDate(fromIso(a.warranty_until)) } : { k: d <= 60 ? 'soon' : 'paid', label: 'Warranty until ' + fmtDate(fromIso(a.warranty_until)) });
    }
    if (a.installed_on && a.life_years) {
      const age = (today() - fromIso(a.installed_on)) / (365.25 * 86400000);
      if (age >= a.life_years) out.push({ k: 'late', label: 'Past typical life (' + a.life_years + ' yrs) · plan to replace' });
      else if (age >= a.life_years * 0.8) out.push({ k: 'soon', label: 'Near end of life · budget to replace' });
    }
    return out;
  }
  function ageLabel(a) {
    if (!a.installed_on) return '';
    const y = (today() - fromIso(a.installed_on)) / (365.25 * 86400000);
    return y < 1 ? 'Installed ' + fmtDate(fromIso(a.installed_on)) : Math.floor(y) + (Math.floor(y) === 1 ? ' year' : ' years') + ' old';
  }
  function appliancesView() {
    const list = S.appliances.slice().sort((a, b) => unitName(a.unit_id).localeCompare(unitName(b.unit_id)) || a.name.localeCompare(b.name));
    if (!list.length) return emptyState('tools', 'No appliances yet', 'Add the boiler, water heater, fridges and washers to track age and warranties.', '<button class="btn primary-soft" data-act="new-appliance">Add an appliance</button>');
    return `<ul class="bills">${list.map((a) => `<li class="bill">
      <div class="bill-info">
        <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(a.name)}</span><span class="tag">${esc(unitName(a.unit_id))}</span></div>
        <span class="small muted">${esc([a.brand, a.model].filter(Boolean).join(' ') || a.kind)}${ageLabel(a) ? ' · ' + ageLabel(a) : ''}</span>
        ${a.serial ? `<button class="acct" data-act="copy" data-text="${esc(a.serial)}" aria-label="Copy serial number ${esc(a.serial)}">Serial <span class="num">${esc(a.serial)}</span> ${ICON.copy}</button>` : ''}
        ${applianceStatus(a).map((x) => `<span class="pill ${x.k}">${esc(x.label)}</span>`).join('')}
      </div>
      <div class="btns"><button class="btn" data-act="appliance" data-id="${a.id}" style="flex:1" aria-label="Edit ${esc(a.name)}">Edit</button></div>
    </li>`).join('')}</ul>`;
  }
  function jobsFor(c) {
    const n = c.name.toLowerCase();
    return S.logs.filter((l) => l.vendor && (l.vendor.toLowerCase().includes(n) || n.includes(l.vendor.toLowerCase())));
  }
  function prosView() {
    const list = S.contractors.slice().sort((a, b) => (a.trade || '').localeCompare(b.trade || '') || a.name.localeCompare(b.name));
    if (!list.length) return emptyState('people', 'No contractors yet', 'Keep your plumber, electrician and boiler service one tap away.', '<button class="btn primary-soft" data-act="new-contractor">Add a contractor</button>');
    return `<ul class="bills">${list.map((c) => {
      const jobs = jobsFor(c); const spent = jobs.reduce((t, l) => t + (Number(l.cost) || 0), 0);
      const tel = (c.phone || '').replace(/[^\d+]/g, '');
      return `<li class="bill">
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(c.name)}</span>${c.trade ? `<span class="tag">${esc(c.trade)}</span>` : ''}</div>
          <span class="small muted">${jobs.length ? jobs.length + (jobs.length === 1 ? ' job' : ' jobs') + ' · ' + money(spent) + ' · last ' + fmtDate(fromIso(jobs[0].done_on)) : 'No jobs logged yet'}</span>
          ${c.notes ? `<span class="small muted">${esc(c.notes)}</span>` : ''}
        </div>
        <div class="btns">
          ${tel ? `<a class="btn" href="tel:${esc(tel)}">Call</a><a class="btn" href="sms:${esc(tel)}">Text</a>` : ''}
          ${c.email ? `<a class="btn" href="mailto:${esc(c.email)}">Email</a>` : ''}
          <button class="btn" data-act="contractor" data-id="${c.id}" style="flex:1" aria-label="Edit ${esc(c.name)}">Edit</button>
        </div>
      </li>`; }).join('')}</ul>`;
  }
  function docsView() {
    const q = S.docQuery.trim().toLowerCase();
    const list = S.documents.filter((d) => !q || [d.title, d.category, d.notes, unitName(d.unit_id)].join(' ').toLowerCase().includes(q));
    const groups = DOC_CATS.map((c) => [c, list.filter((d) => (DOC_CATS.includes(d.category) ? d.category : 'Other') === c)]).filter((g) => g[1].length);
    const expiring = S.documents.filter((d) => d.expires_on && dayDiff(fromIso(d.expires_on)) <= 30);
    return `${expiring.map((d) => { const x = dayDiff(fromIso(d.expires_on)); return `<p class="notice${x < 0 ? '' : ' info'}">${esc(d.title)} ${x < 0 ? 'expired' : 'expires'} ${fmtDate(fromIso(d.expires_on))}.</p>`; }).join('')}
      <div class="field"><label for="doc-q" class="sr">Search documents</label><input class="input" id="doc-q" type="search" placeholder="Search documents" value="${esc(S.docQuery)}" data-input="docq" autocomplete="off"></div>
      ${!S.documents.length ? emptyState('docs', 'No documents yet', 'Keep the lease, insurance, deed and warranties in one safe place.', '<button class="btn primary-soft" data-act="new-doc">Add a document</button>') : ''}
      ${S.documents.length && !list.length ? '<p class="muted" style="text-align:center;padding:16px 0">Nothing matches.</p>' : ''}
      ${groups.map(([c, docs]) => `<h2 class="section-h">${esc(c)}</h2><ul class="bills">${docs.map((d) => `<li class="bill">
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(d.title)}</span><span class="tag">${esc(unitName(d.unit_id))}</span></div>
          <span class="small muted">Added ${fmtDate(new Date(d.created_at))}${d.expires_on ? ' · expires ' + fmtDate(fromIso(d.expires_on)) : ''}</span>
          ${d.notes ? `<span class="small muted">${esc(d.notes)}</span>` : ''}
        </div>
        <div class="btns">${d.file_path ? `<button class="btn primary-soft" data-act="doc-open" data-id="${d.id}" style="flex:1">Open</button>` : ''}<button class="btn" data-act="doc" data-id="${d.id}" style="flex:1" aria-label="Edit ${esc(d.title)}">Edit</button></div>
      </li>`).join('')}</ul>`).join('')}`;
  }
  async function openFile(path) {
    const w = window.open('', '_blank');
    const r = await sb.storage.from('receipts').createSignedUrl(path, 600);
    if (r.error) { if (w) w.close(); return toast(r.error.message); }
    if (w) w.location = r.data.signedUrl; else window.location.href = r.data.signedUrl;
  }
  async function uploadTo(folder, file) {
    if (!navigator.onLine) { toast('Connect to the internet to upload.'); return null; }
    if (file.size > 20 * 1024 * 1024) { toast('That file is over 20 MB.'); return null; }
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = S.household.id + '/' + folder + '/' + Date.now() + '-' + uuid().slice(0, 8) + '.' + ext;
    toast('Uploading…');
    const r = await sb.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (r.error) { toast(friendlyErr(r.error, 'upload that file')); return null; }
    return path;
  }
  const WHEEL_COL = { 'Heating & cooling': '#2B4C9B', 'Safety': '#A3400B', 'Exterior': '#2F4BA8', 'Yard': '#2F4BA8', 'Plumbing': '#8A6A12', 'Appliances': '#8A6A12', 'Electrical': '#6B3FA0', 'Cleaning': '#4D5853', 'Pest control': '#4D5853', 'Other': '#4D5853' };
  function yearWheel() {
    const tasks = S.tasks.filter((t) => t.active !== false && t.next_due);
    if (!tasks.length) return '';
    const start = monthKey(new Date());
    const C = 150, R1 = 140, R0 = 86;
    const ang = (i) => (i / 12) * 2 * Math.PI - Math.PI / 2;
    const pt = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
    const season = (m) => (m === 12 || m <= 2) ? 'w-winter' : m <= 5 ? 'w-spring' : m <= 8 ? 'w-summer' : 'w-fall';
    const arcs = []; const labels = [];
    for (let i = 0; i < 12; i++) {
      const k = addMonths(start, i), m = parseMonth(k).m;
      const a0 = ang(i) + 0.012, a1 = ang(i + 1) - 0.012;
      const [x0, y0] = pt(R1, a0), [x1, y1] = pt(R1, a1), [x2, y2] = pt(R0, a1), [x3, y3] = pt(R0, a0);
      arcs.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R1} ${R1} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} A${R0} ${R0} 0 0 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" class="${season(m)}${i === 0 ? ' w-now' : ''}"/>`);
      const [lx, ly] = pt(R1 - 12, ang(i + 0.5));
      labels.push(`<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" class="w-label${i === 0 ? ' now' : ''}">${MONTH_NAMES[m - 1][0]}</text>`);
    }
    // every occurrence in the next 12 months
    const occ = [];
    tasks.forEach((t) => {
      let d = t.next_due;
      for (let n = 0; n < 12 && d; n++) {
        const k = d.slice(0, 7) + '-01';
        const i = (parseMonth(k).y - parseMonth(start).y) * 12 + parseMonth(k).m - parseMonth(start).m;
        if (i > 11) break;
        if (i >= 0) occ.push({ t, i, day: +d.slice(8, 10), date: d });
        if (!t.interval_months) break;
        d = addMonthsIso(d, t.interval_months);
      }
    });
    const perMonth = {};
    const dots = occ.map((o) => {
      const slot = perMonth[o.i] = (perMonth[o.i] || 0) + 1;
      const frac = o.i + Math.min(0.9, Math.max(0.1, (o.day - 1) / 30));
      const r = R0 + 14 + ((slot - 1) % 3) * 13;
      const [x, y] = pt(r, ang(frac));
      const late = o.i === 0 && dayDiff(fromIso(o.date)) < 0;
      return `<button type="button" class="wdot${late ? ' late' : ''}" data-act="task" data-id="${o.t.id}" aria-label="${esc(o.t.title)}, ${fmtDate(fromIso(o.date))}" title="${esc(o.t.title)} · ${fmtDay(fromIso(o.date))}" style="left:${(x / 3).toFixed(2)}%;top:${(y / 3).toFixed(2)}%;background:${WHEEL_COL[o.t.category] || '#4D5853'}"></button>`;
    });
    const soon = occ.filter((o) => o.i === 0).length;
    return `<section class="card wheelcard" aria-label="Upkeep year at a glance">
      <h2>Year at a glance</h2>
      <div class="wheel">
        <svg class="wheel-svg" viewBox="0 0 300 300" aria-hidden="true">${arcs.join('')}<circle cx="150" cy="150" r="${R0 - 2}" class="w-hub"/>${labels.join('')}</svg>
        ${dots.join('')}
        <div class="wheel-center"><span class="small muted">${monthLabel(start).split(' ')[0]}</span><strong>${soon} ${soon === 1 ? 'task' : 'tasks'}</strong><span class="small muted">${occ.length} in the next 12 months</span></div>
      </div>
      <div class="wlegend small"><span><i style="background:#2B4C9B"></i>Heating</span><span><i style="background:#A3400B"></i>Safety</span><span><i style="background:#2F4BA8"></i>Outside</span><span><i style="background:#8A6A12"></i>Plumbing &amp; appliances</span></div>
    </section>`;
  }
  function taskCard(x) {
    if (!simple()) return taskCardFull(x);
    if (S.open === x.t.id) return taskCardFull(x).replace('<div class="bill-top">', LESS(x.t.id) + '<div class="bill-top">');
    const t = x.t;
    return `<li class="bill qrow" id="task-${t.id}">
      <button class="check labeled" data-act="task-done" data-id="${t.id}" aria-label="Mark done: ${esc(t.title)}">${ICON.check}<span class="ilab" aria-hidden="true">Done</span></button>
      <button type="button" class="qmain" data-act="expand" data-id="${t.id}" aria-expanded="false" aria-label="${esc(t.title)}, ${esc(x.st.label)}. Show details"><span class="qname">${esc(t.title)} <span class="qplace">${esc(unitName(t.unit_id))}</span></span>${qstat(x.st.k, x.st.label)}</button>
    </li>`;
  }
  function taskCardFull(x) {
    const t = x.t;
    return `<li class="bill">
      <div class="bill-top">
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(t.title)}</span><span class="tag">${esc(unitName(t.unit_id))}</span></div>
          <span class="small muted">${esc(t.category)} · ${everyLabel(t)}${t.last_done ? ' · last done ' + fmtDate(fromIso(t.last_done)) : ''}</span>
          <span class="pill ${x.st.k}">${esc(x.st.label)}</span>
        </div>
      </div>
      <div class="btns">
        <button class="btn primary-soft" data-act="task-done" data-id="${t.id}" style="flex:2">✓ Done</button>
        ${t.next_due ? `<button class="btn" data-act="snooze" data-id="${t.id}" style="flex:1" aria-label="Snooze ${esc(t.title)} one week">Snooze 1 wk</button>` : ''}
        <button class="btn" data-act="task" data-id="${t.id}" style="flex:1" aria-label="Edit ${esc(t.title)}">Edit</button>
      </div>
    </li>`;
  }
  function logCard(l) {
    return `<li><button class="bill logrow" data-act="log" data-id="${l.id}" aria-label="Edit ${esc(l.title)}, ${l.done_on ? fmtDate(fromIso(l.done_on)) : ''}">
      <div class="row between" style="width:100%;gap:12px">
        <div class="bill-info" style="text-align:left">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(l.title)}</span><span class="tag">${esc(unitName(l.unit_id))}</span></div>
          <span class="small muted">${l.done_on ? fmtDate(fromIso(l.done_on)) : ''}${l.vendor ? ' · ' + esc(l.vendor) : ''}</span>
          ${l.notes ? `<span class="small muted">${esc(l.notes)}</span>` : ''}
        </div>
        <span class="display num" style="font-size:18px;font-weight:650">${l.cost != null ? money(l.cost) : ''}</span>
      </div>
    </button></li>`;
  }

  // ----- Summary -----
  // Places marked as home (not part of the rental), e.g. Cedarcroft
  function isHome(unitId) { const u = S.units.find((x) => x.id === unitId); return !!(u && u.exclude_from_tax); }
  function homeNames() { return S.units.filter((u) => u.exclude_from_tax).map((u) => u.name); }
  function billSplit(period) {
    const rows = billMonth(period, true).rows;
    const pick = (home) => rows.filter((r) => !r.b.escrow && isHome(r.b.unit_id) === home);
    const sum = (list, paidOnly) => list.reduce((t, r) => t + ((!paidOnly || (r.pay && r.pay.paid_at)) ? (r.amt || 0) : 0), 0);
    const rent = pick(false), home = pick(true);
    return { rentalPaid: sum(rent, true), homePaid: sum(home, true), homeTotal: sum(home, false), homeRows: home };
  }
  function upkeepSplit(period, home) { return S.logs.filter((l) => l.done_on && l.done_on.slice(0, 7) === period.slice(0, 7) && isHome(l.unit_id) === home).reduce((t, l) => t + (Number(l.cost) || 0), 0); }
  function expectedBill(b, k, cur) {
    if (b.active === false || b.escrow || !dueInMonth(b, k)) return { amt: 0, est: false };
    const pay = getPay(b, k);
    if (k === cur && pay && pay.paid_at) return { amt: 0, est: false };
    let a = amountFor(b, pay);
    if (a != null) return { amt: a, est: false };
    const prev = []; for (let i = 1; i <= 12 && prev.length < 3; i++) { const p = getPay(b, addMonths(k, -i)); if (p && p.amount != null && Number(p.amount) > 0) prev.push(Number(p.amount)); }
    if (b.default_amount != null) return { amt: Number(b.default_amount), est: true };
    return prev.length ? { amt: prev.reduce((t, n) => t + n, 0) / prev.length, est: true } : { amt: 0, est: true };
  }
  function forecastCard() {
    const cur = monthKey(new Date());
    const months = [cur, addMonths(cur, 1), addMonths(cur, 2)];
    const rows = months.map((k) => {
      let rent = 0;
      S.rentals.filter((r) => r.active !== false && !isHome(r.unit_id) && r.rent_amount != null).forEach((r) => {
        const rp = getRentPay(r, k); const due = rentDue(r, rp) || 0; const got = rp && rp.amount_received != null ? Number(rp.amount_received) : 0;
        rent += k === cur ? Math.max(0, due - got) : due;
      });
      let rental = 0, home = 0, est = false; const big = [];
      S.bills.forEach((b) => { const e = expectedBill(b, k, cur); if (!e.amt) return; if (e.est) est = true; if (isHome(b.unit_id)) home += e.amt; else { rental += e.amt; if (e.amt >= 500) big.push(billTitle(b)); } });
      return { k, rent, rental, home, net: rent - rental - home, est, big };
    });
    const tight = rows.filter((r) => r.net < 0);
    return `<section class="card" aria-label="Cash-flow forecast">
      <h2>Next 3 months</h2>
      <p class="small muted">Money still expected in and out. Unknown amounts use the usual or recent average (marked ≈).</p>
      <table class="tbl"><thead><tr><th scope="col"></th>${rows.map((r) => `<th scope="col">${monthLabel(r.k, true)}${r.k === cur ? ' (left)' : ''}</th>`).join('')}</tr></thead><tbody>
        <tr><th scope="row">Rent in</th>${rows.map((r) => `<td class="num">${money0(r.rent)}</td>`).join('')}</tr>
        <tr><th scope="row">Rental bills</th>${rows.map((r) => `<td class="num">${r.est ? '≈' : ''}${money0(r.rental)}</td>`).join('')}</tr>
        <tr><th scope="row">Home bills</th>${rows.map((r) => `<td class="num">${money0(r.home)}</td>`).join('')}</tr>
        <tr><th scope="row"><strong>Net</strong></th>${rows.map((r) => `<td class="num" style="color:${r.net < 0 ? 'var(--late-fg)' : 'var(--paid-fg)'}"><strong>${r.net < 0 ? '−' : ''}${money0(Math.abs(r.net))}</strong></td>`).join('')}</tr>
      </tbody></table>
      ${tight.map((r) => `<p class="notice">Tight month: <strong>${monthLabel(r.k)}</strong> looks ${money0(Math.abs(r.net))} short${r.big.length ? ' (' + esc(r.big.join(', ')) + ')' : ''}. Set money aside now.</p>`).join('')}
    </section>`;
  }
  function homeCard() {
    const names = homeNames();
    if (!names.length) return '';
    const sp = billSplit(S.month);
    const hu = upkeepSplit(S.month, true);
    const unpaid = sp.homeRows.filter((r) => !(r.pay && r.pay.paid_at));
    const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(S.month, -i));
    const hist = months.map((k) => ({ k, t: billSplit(k).homePaid + upkeepSplit(k, true) }));
    const max = Math.max(1, ...hist.map((h) => h.t));
    return `<section class="card" aria-label="Home: ${esc(names.join(', '))}">
      <div class="row between"><h2>Home · ${esc(names.join(', '))}</h2><span class="tag">Not rental</span></div>
      <div class="grid2">
        <div class="stat"><span class="small muted">Paid in ${monthLabel(S.month, true)}</span><span class="v display num">${money(sp.homePaid + hu)}</span></div>
        <div class="stat"><span class="small muted">Still to pay</span><span class="v display num">${money(Math.max(0, sp.homeTotal - sp.homePaid))}</span><span class="small muted">${unpaid.length} ${unpaid.length === 1 ? 'bill' : 'bills'}${unpaid.some((r) => r.st.k === 'setup') ? ' · some need amounts' : ''}</span></div>
      </div>
      ${sp.homeRows.map((r) => `<div class="row between small"><span>${esc(billTitle(r.b))}</span><span class="row" style="gap:8px"><strong class="num">${r.amt != null ? money(r.amt) : '—'}</strong><span class="pill ${r.st.k}" style="margin:0">${esc(r.st.label)}</span></span></div>`).join('')}
      ${hist.some((h) => h.t) ? `<div class="hist">${hist.map((h) => `<div class="col ${h.k === S.month ? 'cur' : ''}"><span class="num">${h.t ? '$' + Math.round(h.t) : ''}</span><div class="b" style="height:${Math.round((h.t / max) * 100)}%"></div><span>${monthLabel(h.k, true)}</span></div>`).join('')}</div>` : ''}
      <p class="small muted">Your home’s bills are kept out of the rental totals above and out of the tax report.</p>
    </section>`;
  }
  function summaryTab() { return foldSections(applyHomeLayout(summaryTabRaw()), { 'Money in and out, last 6 months': true, 'Bills by place': false, 'Cash-flow forecast': false }); }
  function summaryHeadline(k) {
    const isCur = k === monthKey(new Date()), isPast = k < monthKey(new Date());
    const rm = rentMonth(k);
    const net = rm.received - billSplit(k).rentalPaid - upkeepSplit(k, false);
    const owe = rm.rows.filter((x) => !isHome(x.r.unit_id) && x.due != null && x.got < x.due && (x.st.k === 'late' || isPast));
    const md = billMonth(k, true);
    const over = md.rows.filter((r) => !(r.pay && r.pay.paid_at) && r.st.label.startsWith('Overdue'));
    const left = md.rows.filter((r) => !(r.pay && r.pay.paid_at) && !r.b.escrow && r.amt);
    const mon = monthLabel(k).split(' ')[0];
    const lead = !rm.received && !billSplit(k).rentalPaid && !upkeepSplit(k, false) ? 'nothing recorded yet.' : net >= 0 ? `you ${isPast ? 'kept' : 'are up'} <strong class="ok-num">${money0(net)}</strong>${isCur ? ' so far' : ''}.` : `you ${isPast ? 'were' : 'are'} <strong class="late-num">${money0(-net)}</strong> short${isCur ? ' so far' : ''}.`;
    const bits = owe.map((x) => `${esc(rentalTitle(x.r))} still owes <strong>${money0(x.due - x.got)}</strong>.`);
    if (over.length) bits.push(`${over.length} ${over.length === 1 ? 'bill is' : 'bills are'} overdue (${money0(over.reduce((t, r) => t + (r.amt || 0), 0))}).`);
    else if (left.length && !isPast) bits.push(`${left.length} ${left.length === 1 ? 'bill' : 'bills'} left to pay (${money0(left.reduce((t, r) => t + (r.amt || 0), 0))}).`);
    if (!bits.length) bits.push(isPast || !left.length ? 'Everything’s paid and all rent is in.' : 'Nothing is late.');
    return `<section class="headline" aria-label="${esc(mon)} in a sentence"><p class="display">${esc(mon)}: ${lead} ${bits.join(' ')}</p></section>`;
  }
  // Income (rent) vs expenses (rental bills by category + upkeep) for the month. Cedarcroft is left out, as everywhere in totals.
  function incomeCard(k) {
    const rm = rentMonth(k);
    const inc = rm.rows.filter((x) => !isHome(x.r.unit_id) && x.due != null);
    const got = inc.reduce((t, x) => t + x.got, 0), expect = inc.reduce((t, x) => t + (x.due || 0), 0);
    const rows = billMonth(k, true).rows.filter((r) => !r.b.escrow && !isHome(r.b.unit_id) && r.amt != null);
    const g = new Map();
    rows.forEach((r) => { const c = r.b.category || 'Other'; const o = g.get(c) || { name: c, total: 0, paid: 0 }; o.total += r.amt; if (r.pay && r.pay.paid_at) o.paid += r.amt; g.set(c, o); });
    const up = upkeepSplit(k, false); if (up) g.set('Upkeep & repairs', { name: 'Upkeep & repairs', total: up, paid: up });
    const exp = Array.from(g.values()).sort((a, b) => b.total - a.total);
    const out = exp.reduce((t, x) => t + x.total, 0), outPaid = exp.reduce((t, x) => t + x.paid, 0);
    if (!inc.length && !exp.length) return '';
    const netNow = got - outPaid, netAll = expect - out;
    const sign = (v) => (v < 0 ? '−' : '+') + money0(Math.abs(v));
    const incRow = (x) => `<li><span class="ie-name">Rent · ${esc(x.r.tenant_name ? x.r.tenant_name + ' (' + unitName(x.r.unit_id) + ')' : unitName(x.r.unit_id))}</span>${x.got > 0 ? `<span class="ie-amt num ok-num">+${money0(x.got)}</span>` : `<span class="ie-amt num muted">${money0(x.due)}</span>`}<span class="ie-sub small ${x.got >= x.due ? 'muted' : 'late'}">${x.got >= x.due ? 'received' : x.got > 0 ? 'of ' + money0(x.due) + ' · partial' : 'not in yet'}</span></li>`;
    const expRow = (x) => `<li><span class="ie-name">${esc(x.name)}</span><span class="ie-amt num">−${money0(x.total)}</span><span class="ie-sub small ${x.paid >= x.total ? 'muted' : 'late'}">${x.paid >= x.total ? 'paid' : x.paid > 0 ? money0(x.total - x.paid) + ' left to pay' : 'not paid yet'}</span></li>`;
    return `<section class="card iecard" aria-label="Income and expenses for ${esc(monthLabel(k))}">
      <div class="row between"><h2>Income &amp; expenses · ${monthLabel(k, true)}</h2>${homeNames().length ? `<span class="small muted">without ${esc(homeNames().join(', '))}</span>` : ''}</div>
      <div class="ie-group inc"><div class="ie-head"><span class="ie-tag">Income</span><span class="num ok-num">${money0(got)}<span class="muted small"> of ${money0(expect)}</span></span></div>
        ${inc.length ? `<ul class="ie-list">${inc.map(incRow).join('')}</ul>` : '<p class="small muted" style="margin:0">Add your tenants on the Rent tab to track rent here.</p>'}</div>
      <div class="ie-group exp"><div class="ie-head"><span class="ie-tag">Expenses</span><span class="num">${money0(out)}${outPaid < out ? `<span class="muted small"> · ${money0(outPaid)} paid</span>` : ''}</span></div>
        ${exp.length ? `<ul class="ie-list">${exp.map(expRow).join('')}</ul>` : '<p class="small muted" style="margin:0">No bills this month.</p>'}</div>
      <div class="ie-net"><div><span class="small muted">Net so far</span><strong class="display num ${netNow < 0 ? 'late-num' : 'ok-num'}">${sign(netNow)}</strong></div><div><span class="small muted">When all rent is in and bills are paid</span><strong class="display num ${netAll < 0 ? 'late-num' : 'ok-num'}">${sign(netAll)}</strong></div></div>
    </section>`;
  }
  // ===== Personal expenses tab =====
  const PERSONAL_PRESETS = [
    ['Netflix', 'Streaming', '🎬'], ['Spotify', 'Streaming', '🎵'], ['Hulu', 'Streaming', '📺'], ['Disney+', 'Streaming', '🏰'], ['YouTube Premium', 'Streaming', '▶️'], ['HBO Max', 'Streaming', '📺'],
    ['Amazon Prime', 'Subscriptions', '📦'], ['iCloud', 'Subscriptions', '☁️'], ['Phone', 'Internet & phone', '📱'], ['Gym', 'Health & fitness', '💪'],
    ['Car insurance', 'Insurance', '🚗'], ['Car payment', 'Car', '🚙'], ['Credit card', 'Credit card', '💳']
  ];
  const PCAT_ICON = { Streaming: '🎬', Subscriptions: '🔁', 'Internet & phone': '📱', 'Health & fitness': '💪', Insurance: '🛡', Car: '🚙', 'Credit card': '💳', Shopping: '🛍', Electric: '⚡', Gas: '🔥', Water: '💧', Other: '🧾' };
  function personalTab() {
    const pu = personalUnit();
    if (!pu) return `${monthNav()}<p class="notice">Setting up your Personal list… Pull down to refresh in a moment.</p>`;
    const md = billMonth(S.month, true);
    const rows = md.rows.filter((r) => r.b.unit_id === pu.id);
    const isPaid = (r) => !!(r.pay && r.pay.paid_at);
    const total = rows.reduce((t, r) => t + (r.amt || 0), 0), paidSum = rows.filter(isPaid).reduce((t, r) => t + (r.amt || 0), 0);
    const yearly = rows.reduce((t, r) => t + (r.amt || 0) * (r.b.due_months && r.b.due_months.length ? r.b.due_months.length / 12 : 1), 0) * 12;
    const g = new Map(); rows.forEach((r) => { const c = r.b.category || 'Other'; g.set(c, (g.get(c) || 0) + (r.amt || 0)); });
    const cats = Array.from(g, ([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
    const max = Math.max(1, ...cats.map((c) => c.v));
    const have = new Set(S.bills.filter((b) => b.active !== false && b.unit_id === pu.id).map((b) => b.name.toLowerCase()));
    const presets = PERSONAL_PRESETS.filter(([n]) => !have.has(n.toLowerCase()));
    const open = rows.filter((r) => !isPaid(r)), done = rows.filter(isPaid);
    const homes = S.units.filter((u) => u.exclude_from_tax && u.id !== pu.id);
    const homeRows = md.rows.filter((r) => homes.some((u) => u.id === r.b.unit_id));
    const homeTotal = homeRows.reduce((t, r) => t + (r.amt || 0), 0);
    const hero = `<section class="hero phero" aria-label="Personal spending">
        <div class="row between" style="align-items:flex-end"><div class="stack" style="gap:2px"><span class="label">Personal · ${monthLabel(S.month, true)}</span><span class="big display num">${money(total)}</span></div><span class="pct display">${total ? Math.round((paidSum / total) * 100) : 0}%</span></div>
        <div class="track" role="progressbar" aria-label="Paid so far" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${total ? Math.round((paidSum / total) * 100) : 0}"><div style="width:${total ? Math.round((paidSum / total) * 100) : 0}%"></div></div>
        <div class="foot"><span>${money(paidSum)} paid · ${money(total - paidSum)} left</span><span>~${money0(yearly)} a year</span></div>
      </section>`;
    const catCard = cats.length ? `<section class="card" aria-label="Personal by category"><h2>By category</h2>${cats.map((c) => `<div class="stack" style="gap:6px"><div class="row between small"><span>${PCAT_ICON[c.name] || '🧾'} ${esc(c.name)}</span><strong class="num">${money(c.v)}</strong></div><div class="meter"><div style="width:${Math.max(3, Math.round((c.v / max) * 100))}%"></div></div></div>`).join('')}</section>` : '';
    const chipList = `<div class="pchips">${presets.map(([n, c, i]) => `<button type="button" class="chip pchip" data-act="personal-add" data-name="${esc(n)}" data-cat="${esc(c)}">${i} ${esc(n)}</button>`).join('')}<button type="button" class="chip pchip" data-act="personal-add" data-name="" data-cat="Other">＋ Something else</button></div>`;
    const chips = !rows.length ? `<section class="card" aria-label="Quick add"><h2>Quick add</h2><p class="small muted" style="margin:-6px 0 0">Tap one, type the amount, save.</p>${chipList}</section>`
      : fold('p-add', 'Add more', '<p class="small muted" style="margin:0">Tap one, type the amount, save.</p>' + chipList, false);
    const list = (rs) => `<ul class="bills">${rs.map(billCard).join('')}</ul>`;
    const body = !rows.length
      ? emptyState('empty', 'No personal expenses yet', 'Add Netflix, your phone, the gym, car insurance… They stay separate from the house.', '')
      : (open.length ? `<h2 class="section-h">To pay <span class="count">${open.length}</span></h2>${list(open)}` : emptyState('done', 'All paid', 'Every personal expense for ' + monthLabel(S.month).split(' ')[0] + ' is paid.'))
        + (done.length ? `<details class="paidfold" data-fold="p-paid" ${isOpen('p-paid', false) ? 'open' : ''}><summary><span>Paid <span class="count">${done.length}</span></span><span class="num muted">${money(paidSum)}</span><span class="chev" aria-hidden="true"></span></summary><ul class="prows">${done.map(paidRow).join('')}</ul></details>` : '');
    const homeNote = homeRows.length ? `<p class="small muted" style="margin:0">${esc(homes.map((u) => u.name).join(', '))} bills (${money(homeTotal)} this month) are on the Bills tab.</p>` : '';
    return `${monthNav()}${hero}${rows.length ? body + chips : chips + body}${catCard}${homeNote}
      <p class="small muted" style="margin:0">Personal expenses aren’t counted in the rental totals or the tax report.</p>`;
  }
  // ===== Customize (saved on this device) =====
  const TAB_DEFS = [['bills', 'Bills'], ['rent', 'Rent'], ['upkeep', 'House'], ['personal', 'Personal']];
  const HOME_DEFS = [['headline', 'Month in one sentence'], ['needs', 'What needs you'], ['income', 'Income & expenses'], ['week', 'Your week'], ['recap', 'AI recap'], ['stats', 'Rental numbers'], ['flow', 'Where the rent goes'], ['inout', '6-month chart'], ['ask', 'Ask about your house'], ['forecast', 'Next 3 months'], ['home', 'Your own home'], ['breakdown', 'Breakdown'], ['tax', 'Tax report']];
  function getCustom() { let c = {}; try { c = JSON.parse(localStorage.getItem('ds-custom') || '{}') || {}; } catch (_) {} c.tabs = c.tabs || {}; c.home = c.home || {}; c.names = c.names || {}; return c; }
  function setCustom(c) { try { localStorage.setItem('ds-custom', JSON.stringify(c)); } catch (_) {} }
  function ordered(defs, cfg) { const ids = defs.map((d) => d[0]); const ord = (cfg.order || []).filter((x) => ids.includes(x)); ids.forEach((x) => { if (!ord.includes(x)) ord.push(x); }); return ord.map((id) => defs.find((d) => d[0] === id)); }
  function visibleTabs() { const c = getCustom(); const hid = c.tabs.hidden || (simple() ? ['personal'] : []); return [['summary', c.names.summary || 'Home']].concat(ordered(TAB_DEFS, c.tabs).filter((d) => !hid.includes(d[0])).map(([id, l]) => [id, c.names[id] || l])); }
  function tabName(id, dflt) { return getCustom().names[id] || dflt; }
  function applyHomeLayout(html) {
    const parts = html.split(/<!--b:(\w+)-->/); const top = parts[0]; const blocks = {};
    for (let i = 1; i < parts.length; i += 2) blocks[parts[i]] = parts[i + 1];
    const c = getCustom(); const hid = c.home.hidden || [];
    const keys = ordered(HOME_DEFS, c.home).map((d) => d[0]).filter((k) => blocks[k] != null && !hid.includes(k) && blocks[k].trim());
    if (!simple()) return top + keys.map((k) => blocks[k]).join('');
    const MAIN = ['headline', 'needs', 'income'];
    const main = keys.filter((k) => MAIN.includes(k)), rest = keys.filter((k) => !MAIN.includes(k));
    return top + main.map((k) => blocks[k]).join('') + (rest.length ? `<details class="moreins" data-fold="home-more" ${isOpen('home-more', false) ? 'open' : ''}><summary><span>More insights</span><span class="small muted">charts, recap, forecast, taxes</span><span class="chev" aria-hidden="true"></span></summary><div class="fold-body">${rest.map((k) => blocks[k]).join('')}</div></details>` : '');
  }
  function addMenuSheet() {
    const ctx = { appliances: ['🧰', 'An appliance', 'new-appliance'], pros: ['👷', 'A contractor', 'new-contractor'], docs: ['📄', 'A document', 'new-doc'] }[S.tab === 'upkeep' ? S.upkeepView : ''];
    const opts = [['🧾', 'A bill', 'new-bill', 'Electric, gas, mortgage, taxes…'], ['👤', 'A personal expense', 'personal-add', 'Netflix, phone, gym…'], ['🔑', 'A tenant', 'new-rental', 'Name, unit and rent'],
      ['🔧', 'A repair I paid for', 'new-log', 'What, when and how much'], ['📅', 'An upkeep task', 'new-task', 'Something to do every few months']].concat(ctx ? [[ctx[0], ctx[1], ctx[2], '']] : []);
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">Add</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <button type="button" class="addopt main" data-act="ask-open"><span class="aicon" aria-hidden="true">✦</span><span class="stack" style="gap:1px"><strong>Type or say it</strong><span class="small muted">“paid PSEG $96”, “Ana paid rent”, or ask a question</span></span></button>
      <label class="addopt"><input type="file" accept="image/*" capture="environment" class="sr" data-change="scan-bill"><span class="aicon" aria-hidden="true">📷</span><span class="stack" style="gap:1px"><strong>Scan a paper bill</strong><span class="small muted">Take a photo; the amount and due date fill in</span></span></label>
      <div class="addgrid">${opts.map(([i, t, a, d]) => `<button type="button" class="addopt" data-act="${a}"${a === 'personal-add' ? ' data-name="" data-cat="Other"' : ''}><span class="aicon" aria-hidden="true">${i}</span><span class="stack" style="gap:1px"><strong>${t}</strong>${d ? `<span class="small muted">${d}</span>` : ''}</span></button>`).join('')}</div>
    </div></div>`;
  }
  function needsItems() {
    const cur = monthKey(new Date()); const items = [];
    billMonth(cur, true).rows.forEach((r) => {
      if ((r.pay && r.pay.paid_at) || r.b.escrow || r.b.autopay || !r.due) return;
      const d = dayDiff(r.due); if (d > 3) return;
      items.push({ rank: d < 0 ? 0 : 1, d, icon: '🧾', title: billTitle(r.b), sub: unitName(r.b.unit_id) + ' · ' + r.st.label, amt: r.amt, act: 'toggle', id: r.b.id, btn: 'Paid' });
    });
    rentMonth(cur).rows.forEach((x) => { if (isHome(x.r.unit_id) || x.st.k !== 'late') return; items.push({ rank: 0, d: -1, icon: '🔑', title: rentalTitle(x.r) + '’s rent', sub: x.st.label, amt: Math.max(0, (x.due || 0) - x.got), act: 'rent-toggle', id: x.r.id, btn: 'Got it' }); });
    S.tasks.filter((t) => t.active !== false && t.next_due).forEach((t) => { const d = dayDiff(fromIso(t.next_due)); if (d > 3) return; items.push({ rank: d < 0 ? 0 : 1, d, icon: '🔧', title: t.title, sub: taskStatus(t).label, act: 'task-done', id: t.id, btn: 'Done' }); });
    (S.requests || []).filter((q) => q.status === 'new').forEach((q) => items.push({ rank: 0, d: -2, icon: '🛠', title: 'Repair request: ' + q.title, sub: 'From your tenant', act: 'go', tab: 'upkeep', btn: 'Open' }));
    (S.notices || []).filter((n) => n.status === 'pending').forEach((n) => { const r = S.rentals.find((x) => x.id === n.rental_id); items.push({ rank: -1, d: -3, icon: '💬', title: (r ? rentalTitle(r) : 'A tenant') + ' says they paid', sub: (n.method || '') + ' · confirm when it arrives', amt: Number(n.amount), act: 'notice-ok', id: n.id, btn: 'Confirm' }); });
    (S.imports || []).filter((x) => x.kind === 'zelle' && x.status === 'unmatched' && x.amount != null).forEach((x) => items.push({ rank: 1, d: 0, icon: '💸', title: 'Match a Zelle payment', sub: money(x.amount) + ' · who sent it?', act: 'go', tab: 'rent', btn: 'Review' }));
    return items.sort((a, b) => a.rank - b.rank || a.d - b.d);
  }
  function needsCard() {
    if (S.month !== monthKey(new Date())) return '';
    const all = needsItems(); const list = S.needsAll ? all : all.slice(0, 3);
    if (!all.length) {
      const soon = [];
      billMonth(S.month, true).rows.forEach((r) => { if ((r.pay && r.pay.paid_at) || !r.due || r.b.escrow) return; const d = dayDiff(r.due); if (d > 3 && d <= 10) soon.push({ d, t: billTitle(r.b) + (r.amt != null ? ' · ' + money0(r.amt) : ''), w: fmtDay(r.due) }); });
      S.tasks.filter((t) => t.active !== false && t.next_due).forEach((t) => { const d = dayDiff(fromIso(t.next_due)); if (d > 3 && d <= 10) soon.push({ d, t: t.title, w: fmtDay(fromIso(t.next_due)) }); });
      soon.sort((a, b) => a.d - b.d);
      return `<section class="card needs calm" aria-label="What needs you"><div class="allgood"><span class="okdot" aria-hidden="true">✓</span><span class="stack" style="gap:1px"><strong>All caught up</strong><span class="small muted">Nothing needs you right now.</span></span></div>
        ${soon.length ? `<ul class="soonlist">${soon.slice(0, 3).map((x) => `<li><span>${esc(x.t)}</span><span>${esc(x.w)}</span></li>`).join('')}</ul>` : ''}</section>`;
    }
    return `<section class="card needs" aria-label="What needs you"><h2>What needs you <span class="count">${all.length}</span></h2>
      <ul class="needlist">${list.map((i) => `<li><span class="nicon" aria-hidden="true">${i.icon}</span><span class="stack" style="gap:1px;min-width:0;flex:1"><strong>${esc(i.title)}</strong><span class="small muted">${esc(i.sub)}</span></span>${i.amt != null ? `<span class="num nm">${money0(i.amt)}</span>` : ''}<button type="button" class="btn sm primary-soft" data-act="${i.act}"${i.id ? ` data-id="${i.id}"` : ''}${i.tab ? ` data-tab="${i.tab}"` : ''}>${i.btn}</button></li>`).join('')}</ul>
      ${all.length > 3 ? `<button type="button" class="linkbtn" data-act="needs-all" style="align-self:flex-start;padding:0">${S.needsAll ? 'Show less' : 'See all ' + all.length}</button>` : ''}</section>`;
  }
  function moveIn(list, id, dir) { const i = list.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= list.length) return list; const a = list.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; }
  function customizeCard() {
    const c = getCustom(); const th = c.tabs.hidden || (simple() ? ['personal'] : []), hh = c.home.hidden || [];
    const tabs = ordered(TAB_DEFS, c.tabs);
    const home = ordered(HOME_DEFS, c.home);
    const arrows = (kind, id, i, n) => `<span class="cz-arrows"><button type="button" class="iconbtn sm" data-act="cz-move" data-kind="${kind}" data-id="${id}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="iconbtn sm" data-act="cz-move" data-kind="${kind}" data-id="${id}" data-dir="1" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>↓</button></span>`;
    const removed = S.bills.filter((b) => b.active === false).sort((a, b) => a.name.localeCompare(b.name));
    return `<section class="card" aria-label="Customize">
      <h2>Customize</h2>
      <p class="small muted" style="margin:-6px 0 0">Show, hide, rename and reorder. Saved on this phone.</p>
      <p class="lab small" style="margin:4px 0 0">Tabs</p>
      <ul class="cz-list">
        <li><span class="cz-name"><input class="input cz-input" value="${esc(c.names.summary || 'Home')}" data-change="cz-name" data-id="summary" aria-label="Name for the Home tab" maxlength="14"></span><span class="small muted">always first</span></li>
        ${tabs.map(([id, l], i) => `<li class="${th.includes(id) ? 'off' : ''}"><label class="cz-switch"><input type="checkbox" data-change="cz-show" data-kind="tabs" data-id="${id}" ${th.includes(id) ? '' : 'checked'} aria-label="Show ${esc(l)} tab"></label><span class="cz-name"><input class="input cz-input" value="${esc(c.names[id] || l)}" data-change="cz-name" data-id="${id}" aria-label="Name for the ${esc(l)} tab" maxlength="14"></span>${arrows('tabs', id, i, tabs.length)}</li>`).join('')}
      </ul>
      <p class="lab small" style="margin:6px 0 0">Home page cards</p>
      <ul class="cz-list">
        ${home.map(([id, l], i) => `<li class="${hh.includes(id) ? 'off' : ''}"><label class="cz-switch"><input type="checkbox" data-change="cz-show" data-kind="home" data-id="${id}" ${hh.includes(id) ? '' : 'checked'} aria-label="Show ${esc(l)}"></label><span class="cz-name">${esc(l)}</span>${arrows('home', id, i, home.length)}</li>`).join('')}
      </ul>
      <div class="btns"><button type="button" class="btn" data-act="cz-reset" style="flex:1">Reset to default</button></div>
      <p class="lab small" style="margin:6px 0 0">Removed bills and subscriptions</p>
      ${removed.length ? `<ul class="cz-list">${removed.map((b) => `<li><span class="cz-name">${esc(billTitle(b))} <span class="small muted">· ${esc(unitName(b.unit_id))}</span></span><button type="button" class="btn sm" data-act="bill-restore" data-id="${b.id}">Restore</button><button type="button" class="btn sm danger" data-act="bill-forget" data-id="${b.id}">${S.forgetArm === b.id ? 'Sure?' : 'Delete'}</button></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">Nothing removed. Use “Remove from my list” on any bill to hide it here without losing its history.</p>'}
    </section>`;
  }
  function summaryTabRaw() {
    const sp = billSplit(S.month);
    const md = { paid: sp.rentalPaid };
    const rm = rentMonth(S.month);
    const up = upkeepSplit(S.month, false);
    const net = rm.received - md.paid - up;
    const homes = homeNames();
    const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(S.month, -i));
    const rows = months.map((k) => {
      const inc = rentMonth(k).received;
      const out = billSplit(k).rentalPaid + upkeepSplit(k, false);
      return { k, inc, out, net: inc - out };
    });
    const max = Math.max(1, ...rows.map((r) => Math.max(r.inc, r.out)));
    const all = S.bills.filter((b) => b.active !== false && !b.escrow && dueInMonth(b, S.month) && !isPersonal(b.unit_id));
    const group = (keyFn) => {
      const m = new Map();
      all.forEach((b) => {
        const k = keyFn(b); const amt = amountFor(b, getPay(b, S.month)) || 0;
        const g = m.get(k) || { name: k, total: 0, n: 0 }; g.total += amt; g.n++; m.set(k, g);
      });
      return Array.from(m.values()).sort((a, b) => b.total - a.total);
    };
    const byFloor = group((b) => { const n = unitName(b.unit_id); return isFloor(n) ? n : 'Shared / house'; });
    const fMax = Math.max(1, ...byFloor.map((g) => g.total));
    const byCat = group((b) => b.category);
    const propName = (S.household && (S.household.address || '').split(',')[0]) || 'Rental';
    const ch = (r) => `<div class="legend small"><span><i class="sw in"></i>Rent in</span><span><i class="sw out"></i>Bills + upkeep out</span></div>
        <div class="hist2">${rows.map((r) => `<div class="col ${r.k === S.month ? 'cur' : ''}">
          <div class="pair"><div class="b in" style="height:${Math.round((r.inc / max) * 100)}%" title="In ${money0(r.inc)}"></div><div class="b out" style="height:${Math.round((r.out / max) * 100)}%" title="Out ${money0(r.out)}"></div></div>
          <span>${monthLabel(r.k, true)}</span></div>`).join('')}</div>`;
    return `${monthNav()}
      <!--b:headline-->${summaryHeadline(S.month)}
      <!--b:needs-->${needsCard()}
      <!--b:income-->${incomeCard(S.month)}
      <!--b:week-->${storyBar()}
      <!--b:recap-->${recapCard()}
      <!--b:stats--><h2 class="section-h" style="margin:0">${esc(propName)} · rental${homes.length ? ' <span class="small muted" style="font-weight:500">(without ' + esc(homes.join(', ')) + ')</span>' : ''}</h2>
      <div class="grid2">
        <div class="stat"><span class="small muted">Rent collected</span><span class="v display num">${money(rm.received)}</span></div>
        <div class="stat"><span class="small muted">Bills paid</span><span class="v display num">${money(md.paid)}</span></div>
        <div class="stat"><span class="small muted">Upkeep spent</span><span class="v display num">${money(up)}</span></div>
        <div class="stat"><span class="small muted">Net for ${monthLabel(S.month, true)}</span><span class="v display num" style="color:${net < 0 ? 'var(--late-fg)' : 'var(--paid-fg)'}">${net < 0 ? '−' : ''}${money(Math.abs(net))}</span></div>
      </div>
      <!--b:flow-->${flowCard()}
      <!--b:inout--><section class="card" aria-label="Money in and out, last 6 months">
        <h2>In vs. out · 6 months</h2>
        <div class="legend small"><span><i class="sw in"></i>Rent in</span><span><i class="sw out"></i>Bills + upkeep out</span></div>
        <div class="hist2">${rows.map((r) => `<div class="col ${r.k === S.month ? 'cur' : ''}">
          <div class="pair"><div class="b in" style="height:${Math.round((r.inc / max) * 100)}%" title="In ${money0(r.inc)}"></div><div class="b out" style="height:${Math.round((r.out / max) * 100)}%" title="Out ${money0(r.out)}"></div></div>
          <span>${monthLabel(r.k, true)}</span></div>`).join('')}</div>
        <details class="inner" data-fold="inout-table" ${isOpen('inout-table', false) ? 'open' : ''}><summary>See the numbers</summary><table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Net</th></tr></thead><tbody>
          ${rows.slice().reverse().map((r) => `<tr><th scope="row">${monthLabel(r.k, true)}</th><td class="num">${money0(r.inc)}</td><td class="num">${money0(r.out)}</td><td class="num" style="color:${r.net < 0 ? 'var(--late-fg)' : 'inherit'}">${r.net < 0 ? '−' : ''}${money0(Math.abs(r.net))}</td></tr>`).join('')}
        </tbody></table></details>
      </section>
      <!--b:ask--><button class="askcard" data-act="ask-open"><span class="askicon" aria-hidden="true">✦</span><span class="stack" style="gap:2px;text-align:left"><strong>Ask about your house</strong><span class="small muted">“What did I spend on repairs this year?”</span></span><span aria-hidden="true">›</span></button>
      <!--b:forecast-->${forecastCard()}
      <!--b:home-->${homeCard()}
      <!--b:breakdown--><section class="card" aria-label="Bills by place">
        <h2>Breakdown · ${monthLabel(S.month, true)}</h2><p class="lab small" style="margin:0">By place</p>
        ${byFloor.map((g) => `<div class="stack" style="gap:6px"><div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n} ${g.n === 1 ? 'bill' : 'bills'}</span></span><strong class="num">${money(g.total)}</strong></div><div class="meter"><div style="width:${Math.max(2, Math.round((g.total / fMax) * 100))}%"></div></div></div>`).join('')}
        <p class="lab small" style="margin:6px 0 0">By category</p>
        ${(() => { const rr = rentMonth(S.month).rows.filter((x) => !isHome(x.r.unit_id) && x.due != null); return rr.length ? `<div class="row between small"><span>Rent <span class="tag inc-tag">Income</span> <span class="muted">· ${rr.length}</span></span><strong class="num ok-num">+${money(rr.reduce((t, x) => t + (x.due || 0), 0))}</strong></div>` : ''; })()}
        ${byCat.map((g) => `<div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n}</span></span><strong class="num">${money(g.total)}</strong></div>`).join('')}
      </section>
      <!--b:tax-->${fold('tax', 'Tax report · ' + (S.taxYear || Number(S.month.slice(0, 4))), taxCard(), false)}`;
  }

  // ----- Tax report (Schedule E style) -----
  const SCHED_E = [['3', 'Rents received'], ['7', 'Cleaning and maintenance'], ['9', 'Insurance'], ['12', 'Mortgage interest paid to banks'], ['14', 'Repairs'], ['16', 'Taxes'], ['17', 'Utilities'], ['19', 'Other']];
  function lineForBill(cat) {
    if (cat === 'Property tax') return '16';
    if (cat === 'Insurance') return '9';
    if (['Electric', 'Gas', 'Water', 'Trash', 'Internet & phone'].includes(cat)) return '17';
    if (cat === 'Contractor') return '14';
    return '19';
  }
  function taxYear(year) {
    const yr = String(year);
    const excluded = new Set(S.units.filter((u) => u.exclude_from_tax).map((u) => u.id));
    const pct = (S.household && S.household.rental_pct != null ? S.household.rental_pct : 100) / 100;
    const rows = []; // {line, item, place, date, amount}
    Object.values(S.rentPays).forEach((p) => {
      if (!p.period.startsWith(yr) || !(Number(p.amount_received) > 0)) return;
      const r = S.rentals.find((x) => x.id === p.rental_id); if (!r || excluded.has(r.unit_id)) return;
      rows.push({ line: '3', item: 'Rent · ' + rentalTitle(r), place: unitName(r.unit_id), date: p.received_at ? isoDate(new Date(p.received_at)) : p.period, amount: Number(p.amount_received), full: true });
    });
    let interestMissing = false;
    Object.values(S.payments).forEach((p) => {
      if (!p.period.startsWith(yr) || !p.paid_at) return;
      const b = S.bills.find((x) => x.id === p.bill_id); if (!b || b.escrow || excluded.has(b.unit_id)) return;
      if (b.category === 'Mortgage') {
        if (p.interest != null) rows.push({ line: '12', item: billTitle(b) + ' interest', place: unitName(b.unit_id), date: isoDate(new Date(p.paid_at)), amount: Number(p.interest) });
        else interestMissing = true;
        return;
      }
      const amt = amountFor(b, p); if (!amt) return;
      rows.push({ line: lineForBill(b.category), item: billTitle(b), place: unitName(b.unit_id), date: isoDate(new Date(p.paid_at)), amount: amt });
    });
    S.logs.forEach((l) => {
      if (!(l.done_on || '').startsWith(yr) || !(Number(l.cost) > 0) || excluded.has(l.unit_id)) return;
      const t = S.tasks.find((x) => x.id === l.task_id);
      rows.push({ line: t && t.category === 'Cleaning' ? '7' : '14', item: l.title + (l.vendor ? ' · ' + l.vendor : ''), place: unitName(l.unit_id), date: l.done_on, amount: Number(l.cost) });
    });
    rows.forEach((r) => { r.deductible = r.line === '3' ? r.amount : Math.round(r.amount * pct * 100) / 100; });
    const totals = {}; SCHED_E.forEach(([k]) => { totals[k] = 0; });
    rows.forEach((r) => { totals[r.line] += r.deductible; });
    const expenses = Object.keys(totals).filter((k) => k !== '3').reduce((t, k) => t + totals[k], 0);
    return { yr, rows: rows.sort((a, b) => a.line.localeCompare(b.line, undefined, { numeric: true }) || a.date.localeCompare(b.date)), totals, expenses, net: totals['3'] - expenses, pct: Math.round(pct * 100), interestMissing, excluded: S.units.filter((u) => u.exclude_from_tax).map((u) => u.name) };
  }
  function taxCard() {
    const y = S.taxYear || Number(S.month.slice(0, 4));
    const t = taxYear(y);
    return `<section class="card" aria-label="Tax report">
      <div class="row between"><h2>Tax report · ${y}</h2>
        <div class="monthnav"><button class="iconbtn" data-act="tax-year" data-delta="-1" aria-label="Previous year">${ICON.left}</button><button class="iconbtn" data-act="tax-year" data-delta="1" aria-label="Next year">${ICON.right}</button></div></div>
      <p class="small muted">Rental income and expenses grouped like IRS Schedule E${t.excluded.length ? ', leaving out ' + esc(t.excluded.join(', ')) : ''}. Expenses are counted at ${t.pct}% rental use.</p>
      <table class="tbl"><tbody>
        ${SCHED_E.map(([k, l]) => `<tr><th scope="row">Line ${k} · ${l}</th><td class="num">${money(t.totals[k])}</td></tr>`).join('')}
        <tr><th scope="row"><strong>Total expenses</strong></th><td class="num"><strong>${money(t.expenses)}</strong></td></tr>
        <tr><th scope="row"><strong>Net before depreciation</strong></th><td class="num"><strong>${t.net < 0 ? '−' : ''}${money(Math.abs(t.net))}</strong></td></tr>
      </tbody></table>
      ${t.interestMissing ? '<p class="notice info">Mortgage interest isn’t entered for some months. Use the interest on your lender’s Form 1098, or add it per payment under the mortgage’s Details.</p>' : ''}
      <form class="row" data-form="rental-pct" style="gap:8px;align-items:flex-end">
        <div class="field" style="flex:1"><label for="tx-pct">Rental use (%)</label><input class="input" id="tx-pct" name="pct" type="number" inputmode="numeric" min="0" max="100" value="${t.pct}"></div>
        <button class="btn" type="submit">Save</button>
      </form>
      <div class="btns"><button class="btn primary-soft" data-act="tax-pdf" style="flex:1">Download PDF</button><button class="btn" data-act="tax-csv" style="flex:1">Download CSV</button></div>
      <p class="small muted">Not tax advice. Doesn’t include depreciation, escrowed taxes or insurance (see Form 1098), or mileage. Share it with your accountant.</p>
    </section>`;
  }
  async function taxPDF() {
    const t = taxYear(S.taxYear || Number(S.month.slice(0, 4)));
    try { await loadScript('vendor/jspdf.umd.min.js'); } catch (_) { return toast('Couldn’t load the PDF maker.'); }
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    const L = 56; let y = 64;
    const line = (txt, size, bold, x, align) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size || 10); doc.text(String(txt), x || L, y, align ? { align } : undefined); };
    const next = (h) => { y += h || 16; if (y > 740) { doc.addPage(); y = 64; } };
    line('Rental income & expenses · ' + t.yr, 18, true); next(20);
    line((S.household.address || S.household.name) + ' · rental use ' + t.pct + '%' + (t.excluded.length ? ' · excludes ' + t.excluded.join(', ') : ''), 10); next(28);
    SCHED_E.forEach(([k, l]) => { line('Line ' + k + ' · ' + l, 11); line(money(t.totals[k]), 11, false, 556, 'right'); next(); });
    next(4); line('Total expenses', 11, true); line(money(t.expenses), 11, true, 556, 'right'); next();
    line('Net before depreciation', 11, true); line((t.net < 0 ? '-' : '') + money(Math.abs(t.net)), 11, true, 556, 'right'); next(30);
    line('Detail', 13, true); next(18);
    t.rows.forEach((r) => { line(r.date, 9); line('L' + r.line, 9, false, L + 70); line(r.item.slice(0, 48), 9, false, L + 100); line(r.place, 9, false, L + 360); line(money(r.deductible), 9, false, 556, 'right'); next(13); });
    next(16); doc.setTextColor(110);
    line('Not tax advice. Excludes depreciation, escrowed taxes/insurance and mileage. Prepared with Doorstep.', 8);
    const blob = doc.output('blob'); const name = 'rental-tax-report-' + t.yr + '.pdf';
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Rental tax report ' + t.yr }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    download(name, blob, 'application/pdf');
  }
  function taxCSV() {
    const t = taxYear(S.taxYear || Number(S.month.slice(0, 4)));
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const names = Object.fromEntries(SCHED_E);
    const out = [['Date', 'Schedule E line', 'Line name', 'Item', 'Place', 'Amount', 'Counted (' + t.pct + '% rental use)']].concat(
      t.rows.map((r) => [r.date, r.line, names[r.line], r.item, r.place, r.amount.toFixed(2), r.deductible.toFixed(2)]));
    download('rental-tax-detail-' + t.yr + '.csv', out.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
  }

  // ----- Settings -----
  function settingsTab() {
    return foldSections(settingsTabRaw(), { 'Email bill import': false, 'Install': !isStandalone(), 'Calendar and export': false, 'House': false, 'Family password': false });
  }
  function settingsTabRaw() {
    const m = S.member || {};
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === m.remind_hour ? 'selected' : ''}>${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}</option>`).join('');
    const days = [0, 1, 2, 3, 4, 5, 7].map((d) => `<option value="${d}" ${d === m.remind_days ? 'selected' : ''}>${d === 0 ? 'Only on the due day' : d + (d === 1 ? ' day' : ' days') + ' before'}</option>`).join('');
    let push;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      push = isIOS && !isStandalone()
        ? '<p class="notice info">To get reminders on iPhone, first add this app to your Home Screen (see below), then open it from there and come back here.</p>'
        : '<p class="notice">This browser can’t show notifications. Use the calendar option below instead.</p>';
    } else if (S.pushState === 'on') {
      push = '<p class="ok">Reminders are on for this device.</p><div class="btns"><button class="btn" data-act="push-test">Send a test</button><button class="btn" data-act="push-off">Turn off</button></div>';
    } else if (Notification.permission === 'denied') {
      push = '<p class="notice">Notifications are blocked for this app. Allow them in your phone’s settings, then come back.</p>';
    } else {
      push = '<button class="btn primary block" data-act="push-on">Turn on reminders</button>';
    }
    const install = isStandalone() ? '<p class="ok">Installed on this device.</p>' : isIOS
      ? '<ol class="steps"><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li><li>Open Doorstep from your Home Screen.</li></ol>'
      : S.installEvt ? '<button class="btn primary block" data-act="install">Install app</button>'
      : '<p class="small muted">In Chrome, open the ⋮ menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>';
    const th = getTheme();
    return `
      ${isDemo() ? '' : guideCard()}
      ${customizeCard()}
      ${isDemo() ? '' : importCard()}
      <section class="card" aria-label="Appearance">
        <h2>Appearance</h2>
        <p class="lab small" style="margin:0">Layout</p>
        <div class="seg theme-seg" role="group" aria-label="Layout">${[['simple', 'Simple'], ['detailed', 'Detailed']].map(([v, l]) => `<button data-act="density" data-v="${v}" aria-pressed="${getDensity() === v}">${l}</button>`).join('')}</div>
        <p class="small muted">Simple shows only what needs you, with details a tap away. Detailed shows everything at once.</p>
        <p class="lab small" style="margin:6px 0 0">Light or dark</p>
        <div class="seg theme-seg" role="group" aria-label="Light or dark">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-act="theme" data-v="${v}" aria-pressed="${th === v}">${l}</button>`).join('')}</div>
        <p class="small muted">Automatic follows your phone’s light or dark setting. This choice is saved on this device only.</p>
        <p class="lab small" style="margin:6px 0 0">Text size</p>
        <div class="seg theme-seg" role="group" aria-label="Text size">${[['1', 'Normal', 15], ['1.12', 'Large', 17], ['1.25', 'Larger', 19]].map(([v, l, px]) => `<button data-act="textsize" data-v="${v}" aria-pressed="${getTextSize() === v}" style="font-size:${px}px">${l}</button>`).join('')}</div>
        <p class="small muted">Makes everything in the app bigger on this device.</p>
        <label class="checkrow"><input type="checkbox" data-change="sound" ${soundOn() ? 'checked' : ''}> Play a soft “tick” when I mark something paid or done</label>
        <button type="button" class="linkbtn" data-act="tour-again" style="align-self:flex-start;padding:0">Show the welcome tour again</button>
      </section>
      <section class="card" aria-label="Reminders">
        <h2>Reminders</h2>
        ${push}
        <form class="grid2" data-form="remind">
          <div class="field"><label for="s-days">Remind me</label><select class="input" id="s-days" name="remind_days" data-change="remind">${days}</select></div>
          <div class="field"><label for="s-hour">At</label><select class="input" id="s-hour" name="remind_hour" data-change="remind">${hours}</select></div>
        </form>
        <p class="small muted">Bills: before the due date, on the day, and the day after if unpaid (autopay bills are skipped). Rent: on the due day and when the grace period ends. Upkeep: before and on the due date.</p>
      </section>
      <section class="card" aria-label="Install">
        <h2>Install on your phone</h2>
        ${install}
      </section>
      <section class="card" aria-label="Calendar and export">
        <h2>Calendar &amp; export</h2>
        <p class="small muted">Add bill and rent due dates and scheduled upkeep to your phone’s calendar, with alerts.</p>
        <button class="btn block" data-act="ics">Add to calendar</button>
        <button class="btn block" data-act="csv">Download history (CSV)</button>
      </section>
      <section class="card" aria-label="House">
        <h2>House</h2>
        <form class="stack" data-form="house">
          <div class="field"><label for="h-name">Name</label><input class="input" id="h-name" name="name" value="${esc(S.household && S.household.name)}"></div>
          <div class="field"><label for="h-addr">Address</label><input class="input" id="h-addr" name="address" value="${esc(S.household && S.household.address)}"></div>
          <div class="field"><label for="h-zelle">Zelle for rent <span class="muted">(shown on tenants’ pages)</span></label><input class="input" id="h-zelle" name="pay_zelle" value="${esc(S.household && S.household.pay_zelle)}" placeholder="Email or phone your tenants send Zelle to" autocomplete="off"></div>
          <div class="field"><label for="h-paynote">Payment note for tenants</label><input class="input" id="h-paynote" name="pay_note" value="${esc(S.household && S.household.pay_note)}" placeholder="e.g. Put your floor and month in the memo"></div>
          <button class="btn" type="submit">Save house details</button>
        </form>
      </section>
      <section class="card" aria-label="Account">
        <h2>Account</h2>
        <p class="small muted" style="margin:0">Signed in as <strong>${esc(S.user ? S.user.email : '')}</strong></p>
        ${isDemo() ? '<p class="notice info">This is the shared demo. Anyone can try it and it resets every night. <button type="button" class="linkbtn" data-act="demo-signup" style="padding:0;min-height:0">Create your own free account</button></p>' : `<form class="stack" data-form="password">
          <input type="text" name="username" value="${esc(S.user ? S.user.email : '')}" autocomplete="username" class="sr" tabindex="-1" aria-hidden="true" readonly>
          <div class="field"><label for="pw1">New password</label><input class="input" id="pw1" name="p1" type="password" minlength="8" autocomplete="new-password" autocapitalize="off"></div>
          <div class="field"><label for="pw2">Type it again</label><input class="input" id="pw2" name="p2" type="password" minlength="8" autocomplete="new-password" autocapitalize="off"></div>
          <button class="btn" type="submit">Change password</button>
        </form>`}
        ${S.household && S.household.claim_code ? `<p class="lab small" style="margin:6px 0 0">Invite a co-owner or family member</p><p class="small" style="margin:0">They create a free account, then enter this house code: <button type="button" class="acct" data-act="copy" data-text="${esc(S.household.claim_code)}"><strong class="num">${esc(S.household.claim_code)}</strong> ${ICON.copy}</button></p>` : ''}
      </section>
      <section class="card" aria-label="Send feedback">
        <h2>Send feedback</h2>
        <p class="small muted" style="margin:-6px 0 0">Questions, ideas or problems go straight to the Doorstep team.</p>
        <form class="stack" data-form="feedback">
          <div class="field"><label for="fb-msg">Message</label><textarea class="input" id="fb-msg" name="message" maxlength="4000" required placeholder="A question, an idea or a problem"></textarea></div>
          <div class="field"><label for="fb-email">Your email <span class="muted">(so we can reply)</span></label><input class="input" id="fb-email" name="email" type="email" maxlength="200" value="${esc(S.user && !isDemo() ? S.user.email : '')}" autocomplete="email"></div>
          ${S.fbMsg ? `<p class="ok" role="status">${esc(S.fbMsg)}</p>` : ''}${S.fbErr ? `<p class="err" role="alert">${esc(S.fbErr)}</p>` : ''}
          <button class="btn primary-soft" type="submit">Send</button>
        </form>
      </section>
      <section class="card" aria-label="Your data">
        <h2>Your data</h2>
        <p class="small muted" style="margin:0">Download everything for ${esc(S.household ? S.household.name : 'this property')} as a file you can keep or move elsewhere.</p>
        <button type="button" class="btn block" data-act="export-data">Download my data</button>
        ${isDemo() ? '' : `<button type="button" class="btn block danger" data-act="delete-account">${S.delArm ? 'Tap again to delete your account for good' : 'Delete my account'}</button>
        <p class="small muted" style="margin:0">Deleting removes your login, and any property no one else shares with you, with its bills, rent, photos and files. It can’t be undone.</p>`}
        <p class="small" style="margin:0"><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>
      </section>
      <section class="card" aria-label="This device">
        <h2>This device</h2>
        <button class="btn block" data-act="refresh">Refresh data</button>
        <button class="btn block danger" data-act="signout">Sign out</button>
      </section>
      <p class="small muted" style="text-align:center">Doorstep · v2.0</p>`;
  }

  function importCard() {
    const last = S.imports[0];
    const label = { applied: 'Added', kept_manual: 'Kept yours', already_paid: 'Already paid', unmatched: 'Needs a look', ignored: 'Skipped' };
    const nameOf = (x) => { if (x.kind === 'zelle') { const r = S.rentals.find((y) => y.id === x.rental_id); return 'Zelle' + (r ? ' · ' + rentalTitle(r) : ''); } const b = S.bills.find((y) => y.id === x.bill_id); return b ? billTitle(b) : (x.provider || 'Email'); };
    const cls = { applied: 'paid', kept_manual: 'up', already_paid: 'up', unmatched: 'setup', ignored: 'up' };
    const rows = S.imports.filter((x) => x.status !== 'ignored').slice(0, 8);
    return `<section class="card" aria-label="Email bill import">
      <h2>Import bills &amp; Zelle rent from Gmail</h2>
      ${last ? `<p class="ok">Working · last email ${fmtDay(new Date(last.created_at))}</p>` : '<p class="small muted">Not set up yet. Takes about 2 minutes, in the Gmail account that gets your bills.</p>'}
      <ol class="steps small">
        <li>On a computer, signed in to <strong>that</strong> Gmail, open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com → New project</a>.</li>
        <li>Delete what’s there, then paste the setup script: <button class="btn" data-act="copy-script" style="height:36px;margin-top:6px">Copy setup script</button></li>
        <li>Click <strong>Save</strong> (the disk icon), choose <strong>setup</strong> in the function menu, click <strong>Run</strong>, and allow access.</li>
      </ol>
      <p class="small muted">It checks for new bill emails every 4 hours. It never changes amounts you typed or bills already marked paid. Only you can see the script. It only sends emails that look like bills, statements or Zelle payments. In the Chase app, turn on email alerts for Zelle payments received.</p>
      ${rows.length ? `<div class="stack" style="gap:8px">${rows.map((x) => `<div class="row between small" style="align-items:flex-start;gap:8px"><div class="stack" style="gap:0;min-width:0"><span>${esc(nameOf(x))}</span><span class="muted">${esc(x.detail || x.subject || '')}</span></div><span class="pill ${cls[x.status] || 'up'}" style="margin:0;flex:none">${label[x.status] || esc(x.status)}</span></div>`).join('')}</div>` : ''}
      <button class="btn" data-act="rotate-import">Make a new key (stops the old script)</button>
    </section>`;
  }
  function importScript() {
    const url = CFG.SUPABASE_URL + '/functions/v1/import-bill';
    return `// Doorstep — Gmail bill import
// Sends new utility, mortgage and Zelle emails to your Doorstep app.
// Run "setup" once. After that it runs by itself every 4 hours.

const ENDPOINT = '${url}';
const KEY = '${S.household.import_token}';
const QUERY = '(subject:(bill OR statement OR "amount due" OR "payment due" OR "is due" OR "payment received" OR "autopay" OR "e-bill") OR zelle OR "sent you money") newer_than:7d';

function importBills() {
  const threads = GmailApp.search(QUERY, 0, 40);
  const messages = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      messages.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toISOString(), text: m.getPlainBody().slice(0, 60000) });
    });
  });
  for (let i = 0; i < messages.length; i += 20) {
    const res = UrlFetchApp.fetch(ENDPOINT, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-import-token': KEY },
      payload: JSON.stringify({ messages: messages.slice(i, i + 20) })
    });
    if (res.getResponseCode() !== 200) throw new Error('Import failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
  console.log('Checked ' + messages.length + ' emails');
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importBills') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('importBills').timeBased().everyHours(4).create();
  importBills();
  console.log('All set. Bills will import every 4 hours.');
}
`;
  }

  // ---------- setup guide ----------
  function localFlag(k, v) { try { if (v === undefined) return localStorage.getItem('ds-' + k) === '1'; localStorage.setItem('ds-' + k, v ? '1' : '0'); } catch (_) { return false; } }
  function setupSteps() {
    const rentals = S.rentals.filter((r) => r.active !== false);
    const mort = S.bills.find((b) => b.active !== false && b.category === 'Mortgage');
    const tasks = S.tasks.filter((t) => t.active !== false);
    const anyImport = S.imports.length > 0;
    const anyZelle = S.imports.some((x) => x.kind === 'zelle');
    const scriptUrl = 'https://script.google.com/home/projects/create';
    return [
      { id: 'install', title: 'Add the app to your Home Screen', done: isStandalone(),
        body: isIOS
          ? '<ol class="steps"><li>Open this site in <strong>Safari</strong>.</li><li>Tap <strong>Share</strong> (the square with an arrow).</li><li>Tap <strong>Add to Home Screen</strong> → <strong>Add</strong>.</li><li>From now on, open Doorstep from its icon. Reminders only work from the icon.</li></ol>'
          : '<ol class="steps"><li>In Chrome, open the <strong>⋮</strong> menu.</li><li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li></ol>' + (S.installEvt ? '<button class="btn primary block" data-act="install">Install now</button>' : '') },
      { id: 'push', title: 'Turn on reminders', done: S.pushState === 'on',
        body: '<ol class="steps"><li>Open the app from its Home Screen icon.</li><li>Below, under <strong>Reminders</strong>, tap <strong>Turn on reminders</strong> and allow notifications.</li><li>Tap <strong>Send a test</strong>. A notification should pop up.</li><li>Choose how many days ahead and what time.</li></ol><p class="small muted">Do this on each family member’s phone.</p>' },
      { id: 'bills', title: 'Add your bills', done: S.bills.filter((x) => x.active !== false && x.due_day).length >= 2,
        body: '<ol class="steps"><li>Go to the <strong>Bills</strong> tab and tap <strong>+ Add</strong>.</li><li>Add each utility, the mortgage, insurance and taxes, with the day each one is due.</li><li>Tip: tap the camera in <strong>Ask or add</strong> to scan a paper bill.</li></ol>' },
      { id: 'payinfo', title: 'Tell tenants how to pay', done: !!(S.household && (S.household.pay_zelle || S.household.pay_note)),
        body: '<ol class="steps"><li>Scroll down to <strong>House details</strong>.</li><li>Add your Zelle email or phone and a short note (for example “put your unit in the memo”).</li><li>Tenants see it on their private page.</li></ol>' },
      { id: 'tenants', title: 'Add your tenants and rent', done: rentals.length > 0 && rentals.every((r) => r.tenant_name && r.rent_amount != null),
        body: '<ol class="steps"><li>Go to the <strong>Rent</strong> tab.</li><li>Tap <strong>Details</strong> on each unit.</li><li>Enter the tenant’s name, phone, monthly rent, due day, grace days and late fee.</li><li>If someone pays from another person’s Zelle (a spouse, a parent), add that name under <strong>Also pays as</strong>.</li><li>Optional: lease start/end and security deposit. You’ll get a heads-up 60 days before a lease ends.</li></ol><button class="btn block" data-act="go" data-tab="rent">Open Rent</button>' },
      { id: 'mortgage', title: 'Set your mortgage payment', done: !!(mort && mort.default_amount != null && mort.due_day),
        body: '<ol class="steps"><li>Go to <strong>Rent</strong> → <strong>Mortgage</strong> → <strong>Details</strong> (or find your mortgage on the Bills tab).</li><li>Enter the monthly payment under <strong>Usual amount</strong> and the <strong>Due day</strong>.</li><li>Tick <strong>Same amount every month</strong>. Tick <strong>autopay</strong> if Rocket pulls it automatically.</li><li>Add your loan number under <strong>Account #</strong>.</li></ol>' + (mort ? `<button class="btn block" data-act="bill" data-id="${mort.id}">Open mortgage details</button>` : '') },
      { id: 'zelle', title: 'Turn on Zelle email alerts at your bank', done: anyZelle || localFlag('zelle-alerts'), manual: !anyZelle,
        body: '<ol class="steps"><li>Open your bank’s app (Chase, Bank of America, Wells Fargo…).</li><li>Find <strong>Alerts</strong> in settings.</li><li>Turn on <strong>email</strong> alerts for <strong>Zelle money received</strong>.</li><li>With the Gmail import below, rent then marks itself received.</li></ol>' },
      { id: 'gmail', title: 'Install the Gmail import', done: anyImport,
        body: `<p class="small muted">This fills in utility and mortgage bills and records Zelle rent by itself. Do this on a computer, signed in to the Gmail that gets those emails.</p>
          <ol class="steps"><li>Tap <button class="btn" data-act="copy-script" style="height:36px">Copy setup script</button></li>
          <li>Open <a href="${scriptUrl}" target="_blank" rel="noopener">script.google.com → New project</a>.</li>
          <li>Select everything in the editor, delete it, and paste.</li>
          <li>Click <strong>Save</strong> (the disk icon).</li>
          <li>In the function menu at the top, choose <strong>setup</strong>, then click <strong>Run</strong>.</li>
          <li>Google asks for permission: choose your account → <strong>Advanced</strong> → <strong>Go to project (unsafe)</strong> → <strong>Allow</strong>. “Unsafe” only means Google hasn’t reviewed your own private script.</li>
          <li>Done. It checks every 4 hours. Results show under <strong>Import bills &amp; Zelle rent</strong> below.</li></ol>
          <p class="small muted">Already installed an older copy? Copy it again and replace the old one: new versions add mortgage and Zelle.</p>` },
      { id: 'upkeep', title: 'Schedule your upkeep', done: tasks.length > 0 && tasks.every((t) => t.next_due),
        body: '<ol class="steps"><li>Go to the <strong>Upkeep</strong> tab.</li><li>For each task under <strong>Not scheduled yet</strong>, tap <strong>Done</strong> and enter roughly when it was last done. The app works out the next date.</li><li>Delete tasks that don’t apply (Edit → Delete) and add your own with <strong>+</strong>.</li></ol><button class="btn block" data-act="go" data-tab="upkeep">Open Upkeep</button>' }
    ];
  }
  function guideCard() {
    const steps = setupSteps();
    const n = steps.filter((x) => x.done).length;
    const all = n === steps.length;
    return `<section class="card" aria-label="Setup guide" id="guide">
      <div class="row between"><h2>Setup guide</h2><span class="small muted">${n} of ${steps.length} done</span></div>
      <div class="meter" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${n}"><div style="width:${Math.round((n / steps.length) * 100)}%"></div></div>
      ${all ? '<p class="ok">All set. Everything runs on its own now.</p>' : ''}
      <div class="guide">
        ${steps.map((x, i) => `<details class="gstep ${x.done ? 'done' : ''}" ${!x.done && steps.findIndex((y) => !y.done) === i ? 'open' : ''}>
          <summary><span class="gnum" aria-hidden="true">${x.done ? ICON.check : i + 1}</span><span class="gtitle">${esc(x.title)}</span><span class="sr">${x.done ? '(done)' : '(to do)'}</span></summary>
          <div class="gbody">${x.body}
            ${x.manual ? `<label class="checkrow"><input type="checkbox" data-change="guide-flag" data-flag="${x.id === 'password' ? 'pw-changed' : 'zelle-alerts'}" ${x.done ? 'checked' : ''}> I’ve done this</label>` : ''}
          </div>
        </details>`).join('')}
      </div>
    </section>`;
  }
  function weatherBanner() {
    const notes = (S.household && Array.isArray(S.household.weather)) ? S.household.weather : [];
    const live = notes.filter((n) => !n.until || new Date(n.until) > new Date());
    return live.map((n) => {
      const kind = n.kind === 'freeze' || /snow|winter|ice|blizzard|freez|cold/i.test(n.title) ? 'snow' : /flood|rain|tropical|hurricane|coastal/i.test(n.title) ? 'rain' : /heat/i.test(n.title) ? 'heat' : 'wind';
      const parts = kind === 'snow' ? Array.from({ length: 22 }, (_, i) => `<span class="flake" style="left:${(i * 41) % 100}%;animation-duration:${3 + (i % 5) * 0.6}s;animation-delay:${((i * 0.23) % 3).toFixed(2)}s;--dx:${((i * 29) % 40) - 20}px;width:${3 + (i % 4)}px;height:${3 + (i % 4)}px"></span>`).join('')
        : kind === 'rain' ? Array.from({ length: 34 }, (_, i) => `<span class="drop" style="left:${(i * 41) % 100}%;animation-duration:${0.7 + (i % 4) * 0.15}s;animation-delay:${((i * 0.23) % 3).toFixed(2)}s"></span>`).join('') : '';
      const icon = kind === 'snow' ? '<path d="M12 2v20M4 6l16 12M20 6L4 18"/><path d="M9 3l3 3 3-3M9 21l3-3 3 3"/>'
        : kind === 'rain' ? '<path d="M7 15a4 4 0 1 1 .8-7.9A6 6 0 0 1 19 9a3.5 3.5 0 0 1-1 6.9H7z"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>'
        : kind === 'heat' ? '<circle cx="12" cy="12" r="4.5"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
        : '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/>';
      return `<section class="wx wx-${kind}" role="note" aria-label="Weather: ${esc(n.title)}"><div class="wx-fx" aria-hidden="true">${parts}</div>
        <div class="wx-row"><svg class="${kind === 'heat' ? 'sun' : ''}" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
        <div class="stack" style="gap:3px"><strong>${esc(n.title)}</strong><span>${esc(n.detail)}</span></div></div></section>`;
    }).join('');
  }
  // Number shown on the app icon: overdue bills, late rent, upkeep due/overdue, new repair requests
  function attentionCount() {
    const cur = monthKey(new Date());
    const bills = billMonth(cur, true).rows.filter((r) => r.st.k === 'late').length;
    const rent = rentMonth(cur).late;
    const upkeep = S.tasks.filter((t) => t.active !== false && t.next_due && dayDiff(fromIso(t.next_due)) <= 0).length;
    const reqs = S.requests.filter((q) => q.status === 'new').length;
    return bills + rent + upkeep + reqs;
  }
  let lastBadge = -1;
  function updateBadge() {
    if (!('setAppBadge' in navigator) || S.view !== 'app' || !S.household) return;
    const n = attentionCount();
    if (n === lastBadge) return;
    lastBadge = n;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  function bx(k, v) { try { if (v === undefined) return localStorage.getItem('ds-bx-' + k); localStorage.setItem('ds-bx-' + k, v); } catch (_) { return null; } }
  function topBanners() {
    const storyOk = [0, 1].includes(new Date().getDay()) || (!storySeen() && new Date().getDay() === 2);
    if (!simple()) return weatherBanner() + setupBanner() + (storyOk ? storyBar() : '');
    const opts = [];
    const w = weatherBanner();
    if (w) { const sig = ((S.household && S.household.weather) || []).map((n) => n.title + '|' + (n.until || '')).join('~').slice(0, 300); if (bx('weather') !== sig) opts.push(['weather', w, sig]); }
    const sb = setupBanner(); if (sb && !(Number(bx('setup')) > Date.now())) opts.push(['setup', sb, String(Date.now() + 14 * 86400000)]);
    if (storyOk && !storySeen() && bx('story') !== weekStart()) { const st = storyBar(); if (st) opts.push(['story', st, weekStart()]); }
    if (!opts.length) return '';
    const [k, html, val] = opts[0];
    return `<div class="bannerwrap">${html}<button type="button" class="bandx" data-act="banner-x" data-k="${k}" data-v="${esc(val)}" aria-label="Hide this">×</button></div>`;
  }
  function setupBanner() {
    if (isDemo()) return '';
    const steps = setupSteps();
    const n = steps.filter((x) => x.done).length;
    if (n === steps.length) return '';
    return `<button class="notice info banner" data-act="go" data-tab="settings" data-anchor="guide">Finish setting up · ${n} of ${steps.length} done <span aria-hidden="true">›</span></button>`;
  }

  // ---------- sheets ----------
  function unitOptions(sel) { return S.units.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join(''); }
  function opts(list, sel) { return list.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join(''); }
  function methodOpts(sel) { return '<option value="">—</option>' + opts(METHODS, sel); }
  function f(id, label, input) { return `<div class="field"><label for="${id}">${label}</label>${input}</div>`; }
  function inp(id, name, value, extra) { return `<input class="input" id="${id}" name="${name}" value="${esc(value == null ? '' : value)}" ${extra || ''}>`; }
  function moneyInp(id, name, v) { return inp(id, name, v != null ? Number(v).toFixed(2) : '', 'inputmode="decimal" placeholder="0.00"'); }
  function sheetShell(title, form, inner, del, extra) {
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">${esc(title)}</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <form class="stack" data-form="${form}" novalidate>
        ${inner}
        ${S.sheetErr ? `<p class="err" role="alert">${esc(S.sheetErr)}</p>` : ''}
        <button class="btn primary block" type="submit">Save</button>
        ${extra || ''}
        ${del ? `<button type="button" class="btn block danger" data-act="sheet-delete">${S.deleteArm ? 'Tap again to delete' : esc(del)}</button>` : ''}
      </form>
    </div></div>`;
  }

  function sheetView() {
    const sh = S.sheet;
    if (sh.type === 'bill' || sh.type === 'new-bill') return billSheet(sh);
    if (sh.type === 'rental' || sh.type === 'new-rental') return rentalSheet(sh);
    if (sh.type === 'task' || sh.type === 'new-task') return taskSheet(sh);
    if (sh.type === 'task-done') return doneSheet(sh);
    if (sh.type === 'log' || sh.type === 'new-log') return logSheet(sh);
    if (sh.type === 'appliance' || sh.type === 'new-appliance') return applianceSheet(sh);
    if (sh.type === 'contractor' || sh.type === 'new-contractor') return contractorSheet(sh);
    if (sh.type === 'doc' || sh.type === 'new-doc') return docSheet(sh);
    if (sh.type === 'renew') return renewSheet(sh);
    if (sh.type === 'moveout') return moveoutSheet(sh);
    if (sh.type === 'inspections') return inspectionsSheet(sh);
    if (sh.type === 'inspection') return inspectionSheet();
    if (sh.type === 'request') return requestSheet(sh);
    if (sh.type === 'ask') return askSheet();
    if (sh.type === 'payoff') return payoffSheet();
    if (sh.type === 'addmenu') return addMenuSheet();
    if (sh.type === 'houses') return housesSheet();
    return '';
  }
  function portalUrl(r) { return CFG.APP_URL + 'tenant.html?t=' + r.portal_token; }
  function renewSheet(sh) {
    const r = S.rentals.find((x) => x.id === sh.id); if (!r) return '';
    const start = r.lease_end ? addMonthsIso(r.lease_end, 0) : isoDate(today());
    const s0 = r.lease_end ? isoDate(new Date(fromIso(r.lease_end).getTime() + 86400000)) : start;
    return sheetShell('Renew lease · ' + rentalTitle(r), 'renew', `<section class="card">
      <div class="grid2">${f('rn-start', 'New lease start', inp('rn-start', 'start', s0, 'type="date" required'))}${f('rn-end', 'New lease end', inp('rn-end', 'end', addMonthsIso(s0, 12), 'type="date" required'))}</div>
      ${f('rn-rent', 'New monthly rent ($)', moneyInp('rn-rent', 'rent', r.rent_amount))}
      ${r.rent_amount ? `<p class="small muted">Current rent ${money(r.rent_amount)}. NY generally requires written notice of a rent increase of 5% or more: 30 days for tenants of under 1 year, 60 days for 1–2 years, 90 days for over 2 years.</p>` : ''}
      ${f('rn-notes', 'Notes', inp('rn-notes', 'notes', '', 'placeholder="e.g. signed renewal saved in Docs"'))}
      <p class="small muted">The current lease is saved to the lease history.</p>
    </section>`, null);
  }
  function moveoutSheet(sh) {
    const r = S.rentals.find((x) => x.id === sh.id); if (!r) return '';
    const by = r.move_out_on ? new Date(fromIso(r.move_out_on).getTime() + 14 * 86400000) : null;
    const insp = S.inspections.filter((i) => i.rental_id === r.id);
    return sheetShell('Move-out · ' + rentalTitle(r), 'moveout', `<section class="card">
      ${f('mo-date', 'Move-out date', inp('mo-date', 'move_out_on', r.move_out_on || r.lease_end, 'type="date" required'))}
      ${by ? `<p class="notice info">Return the deposit, or an itemized list of deductions, by <strong>${fmtDate(by)}</strong>: NY requires it within 14 days of move-out.</p>` : ''}
      <ol class="steps small">
        <li>Do a move-out inspection with photos ${insp.some((i) => i.kind === 'Move-out') ? '✓' : `· <button type="button" class="linkbtn" data-act="inspect-new" data-id="${r.id}" data-kind="Move-out" style="min-height:0;padding:0">start one</button>`}</li>
        <li>Compare with the move-in inspection${insp.some((i) => i.kind === 'Move-in') ? ' ✓' : ' (none on file)'}.</li>
        <li>Itemize any deductions (damage beyond normal wear, unpaid rent).</li>
        <li>Return the rest of the deposit${r.deposit ? ' (' + money(r.deposit) + ' held)' : ''}.</li>
      </ol>
    </section>
    <section class="card"><h2>Deposit returned</h2>
      <div class="grid2">${f('mo-amt', 'Amount returned ($)', moneyInp('mo-amt', 'deposit_returned_amount', r.deposit_returned_amount))}${f('mo-on', 'Returned on', inp('mo-on', 'deposit_returned_on', r.deposit_returned_on, 'type="date"'))}</div>
      ${f('mo-ded', 'Deductions (itemized)', `<textarea class="input" id="mo-ded" name="deposit_deductions" placeholder="e.g. Broken blinds, bedroom 1: $80">${esc(r.deposit_deductions)}</textarea>`)}
      <label class="checkrow"><input type="checkbox" name="archive" ${r.active === false ? 'checked' : ''}> Tenant has moved out: hide from the Rent tab (history is kept)</label>
    </section>`, null);
  }
  const ROOMS = ['Entry & hallway', 'Living room', 'Kitchen', 'Bathroom', 'Bedroom 1', 'Bedroom 2', 'Appliances', 'Windows & doors', 'Floors & walls', 'Smoke & CO detectors'];
  const CONDITIONS = ['Good', 'Fair', 'Poor', 'Damaged'];
  function inspectionsSheet(sh) {
    const r = S.rentals.find((x) => x.id === sh.id); if (!r) return '';
    const list = S.inspections.filter((i) => i.rental_id === r.id);
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">Inspections · ${esc(rentalTitle(r))}</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <div class="btns"><button class="btn" data-act="inspect-new" data-id="${r.id}" data-kind="Move-in" style="flex:1">New move-in</button><button class="btn" data-act="inspect-new" data-id="${r.id}" data-kind="Move-out" style="flex:1">New move-out</button><button class="btn" data-act="inspect-new" data-id="${r.id}" data-kind="Routine" style="flex:1">Routine</button></div>
      ${list.length ? `<ul class="bills">${list.map((i) => { const ph = (i.items || []).reduce((t, x) => t + ((x.photos || []).length), 0); const bad = (i.items || []).filter((x) => x.condition === 'Poor' || x.condition === 'Damaged').length;
        return `<li><button class="bill logrow" data-act="inspect-open" data-id="${i.id}"><div class="bill-info"><span class="bill-name">${esc(i.kind)} · ${fmtDate(fromIso(i.done_on))}</span><span class="small muted">${(i.items || []).length} areas · ${ph} ${ph === 1 ? 'photo' : 'photos'}${bad ? ' · ' + bad + ' need attention' : ''}</span></div></button></li>`; }).join('')}</ul>` : '<p class="muted small">No inspections yet. Do one at move-in and again at move-out, with photos, to settle deposit questions.</p>'}
    </div></div>`;
  }
  function inspectionSheet() {
    const d = S.inspDraft; if (!d) return '';
    const r = S.rentals.find((x) => x.id === d.rental_id);
    return sheetShell(d.kind + ' inspection' + (r ? ' · ' + rentalTitle(r) : ''), 'inspection', `<section class="card">
      <div class="grid2">${f('in-kind', 'Type', `<select class="input" id="in-kind" data-change="insp-meta" data-k="kind">${opts(['Move-in', 'Move-out', 'Routine'], d.kind)}</select>`)}${f('in-date', 'Date', `<input class="input" id="in-date" type="date" value="${esc(d.done_on)}" data-change="insp-meta" data-k="done_on">`)}</div>
    </section>
    ${d.items.map((it, i) => `<section class="card">
      <div class="row between"><h2>${esc(it.room)}</h2><button type="button" class="iconbtn" data-act="insp-del" data-i="${i}" aria-label="Remove ${esc(it.room)}">${ICON.close}</button></div>
      <div class="seg" role="group" aria-label="Condition of ${esc(it.room)}">${CONDITIONS.map((c) => `<button type="button" data-act="insp-cond" data-i="${i}" data-c="${c}" aria-pressed="${it.condition === c}">${c}</button>`).join('')}</div>
      <label class="sr" for="in-note-${i}">Notes for ${esc(it.room)}</label><input class="input" id="in-note-${i}" value="${esc(it.note || '')}" placeholder="Notes (scratches, stains, what’s broken…)" data-change="insp-note" data-i="${i}">
      <div class="row wrap" style="gap:8px">
        ${(it.photos || []).map((ph, j) => `<button type="button" class="btn" data-act="file-open" data-path="${esc(ph)}">Photo ${j + 1}</button>`).join('')}
        <label class="btn"><input type="file" accept="image/*" class="sr" data-change="insp-photo" data-i="${i}"> + Photo</label>
      </div>
    </section>`).join('')}
    <section class="card"><div class="row" style="gap:8px"><label class="sr" for="in-room">Add an area</label><input class="input" id="in-room" placeholder="Add an area, e.g. Basement" style="flex:1"><button type="button" class="btn" data-act="insp-add">Add</button></div>
      ${f('in-notes', 'Overall notes', `<textarea class="input" id="in-notes" data-change="insp-meta" data-k="notes">${esc(d.notes || '')}</textarea>`)}</section>`, d.id && S.inspections.some((x) => x.id === d.id) ? 'Delete inspection' : null);
  }
  function requestSheet(sh) {
    const q = S.requests.find((x) => x.id === sh.id); if (!q) return '';
    const r = S.rentals.find((x) => x.id === q.rental_id);
    return sheetShell(q.title, 'request', `<section class="card">
      <span class="small muted">${esc(r ? rentalTitle(r) : 'Tenant')} · ${esc(unitName(q.unit_id))} · sent ${fmtDate(new Date(q.created_at))}${q.urgency === 'urgent' ? ' · <strong>URGENT</strong>' : ''}</span>
      ${q.details ? `<p>${esc(q.details)}</p>` : ''}
      ${q.photo_path ? `<button type="button" class="btn" data-act="file-open" data-path="${esc(q.photo_path)}">View photo</button>` : ''}
      ${r && r.phone ? `<div class="btns"><a class="btn" href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">Call tenant</a><a class="btn" href="sms:${esc(r.phone.replace(/[^\d+]/g, ''))}">Text tenant</a></div>` : ''}
    </section>
    <section class="card">
      ${f('rq-status', 'Status', `<select class="input" id="rq-status" name="status">${[['new', 'New'], ['scheduled', 'Scheduled'], ['done', 'Fixed'], ['closed', 'Closed']].map(([v, l]) => `<option value="${v}" ${q.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${f('rq-reply', 'Note for the tenant <span class="muted">(shows on their page)</span>', inp('rq-reply', 'reply', q.reply, 'placeholder="e.g. Plumber coming Tuesday 10am"'))}
      <label class="checkrow"><input type="checkbox" name="log"> Add to upkeep history when fixed (for costs and taxes)</label>
    </section>`, 'Delete request');
  }
  function requestsSection() {
    const open = S.requests.filter((q) => q.status === 'new' || q.status === 'scheduled');
    if (!open.length) return '';
    return `<h2 class="section-h">Requests from tenants</h2><ul class="bills">${open.map((q) => { const r = S.rentals.find((x) => x.id === q.rental_id);
      return `<li class="bill"><div class="bill-info">
        <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(q.title)}</span><span class="tag">${esc(unitName(q.unit_id))}</span></div>
        <span class="small muted">${esc(r ? rentalTitle(r) : 'Tenant')} · ${fmtDay(new Date(q.created_at))}${q.photo_path ? ' · photo' : ''}</span>
        <span class="pill ${q.urgency === 'urgent' ? 'late' : q.status === 'scheduled' ? 'up' : 'soon'}">${q.urgency === 'urgent' ? 'Urgent' : ''}${q.urgency === 'urgent' && q.status === 'scheduled' ? ' · ' : ''}${q.status === 'scheduled' ? 'Scheduled' : q.urgency === 'urgent' ? '' : 'New'}</span>
      </div><div class="btns"><button class="btn" data-act="request" data-id="${q.id}" style="flex:1">Open</button></div></li>`; }).join('')}</ul>`;
  }

  // ----- Rent receipts (PDF) -----
  function loadScript(src) { return new Promise((res, rej) => { if (window.jspdf) return res(); const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
  async function makeReceipt(r, period) {
    const rp = getRentPay(r, period);
    if (!rp || !(Number(rp.amount_received) > 0)) return toast('No payment recorded for this month.');
    try { await loadScript('vendor/jspdf.umd.min.js'); } catch (_) { return toast('Couldn’t load the receipt maker.'); }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const due = rentDue(r, rp) || 0, got = Number(rp.amount_received);
    const no = 'R-' + period.slice(0, 7).replace('-', '') + '-' + (r.portal_token || r.id).slice(0, 4).toUpperCase();
    const L = 64; let y = 80;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.text('Rent receipt', L, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(90);
    doc.text('Receipt # ' + no, 548, y - 6, { align: 'right' }); doc.text('Issued ' + fmtDate(today()), 548, y + 10, { align: 'right' });
    y += 40; doc.setTextColor(20);
    const row = (k, v) => { doc.setFont('helvetica', 'normal'); doc.setTextColor(90); doc.text(k, L, y); doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.text(String(v), L + 160, y); y += 24; };
    row('Received from', r.tenant_name || 'Tenant');
    row('Property', (S.household.address || S.household.name) + ' · ' + unitName(r.unit_id));
    row('For', 'Rent for ' + monthLabel(period));
    row('Amount received', money(got));
    row('Date received', rp.received_at ? fmtDate(new Date(rp.received_at)) : '—');
    row('Paid by', rp.method || '—');
    row('Rent for the month', money(due));
    row('Balance remaining', money(Math.max(0, due - got)));
    y += 16; doc.setDrawColor(200); doc.line(L, y, 548, y); y += 28;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(90); doc.setFontSize(10);
    doc.text('Received by: ' + (S.household.name || 'Landlord') + ', landlord', L, y);
    const blob = doc.output('blob');
    const name = 'rent-receipt-' + (r.tenant_name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + period.slice(0, 7) + '.pdf';
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Rent receipt ' + monthLabel(period) }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Receipt downloaded');
  }

  function vendorList() { return `<datalist id="pros-list">${S.contractors.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>`; }
  function applianceSheet(sh) {
    const isNew = sh.type === 'new-appliance';
    const a = isNew ? { kind: 'Boiler', unit_id: wholeId() } : S.appliances.find((x) => x.id === sh.id);
    if (!a) return '';
    return sheetShell(isNew ? 'Add appliance' : a.name, 'appliance', `<section class="card">
      <div class="grid2">${f('ap-kind', 'Type', `<select class="input" id="ap-kind" name="kind">${opts(Object.keys(APPLIANCE_LIFE), a.kind)}</select>`)}${f('ap-unit', 'Where', `<select class="input" id="ap-unit" name="unit_id">${unitOptions(a.unit_id)}</select>`)}</div>
      ${f('ap-name', 'Name', inp('ap-name', 'name', a.name, 'placeholder="e.g. Basement boiler"'))}
      <div class="grid2">${f('ap-brand', 'Brand', inp('ap-brand', 'brand', a.brand))}${f('ap-model', 'Model #', inp('ap-model', 'model', a.model, 'autocapitalize="characters"'))}</div>
      ${f('ap-serial', 'Serial #', inp('ap-serial', 'serial', a.serial, 'autocapitalize="characters"'))}
      <div class="grid2">${f('ap-inst', 'Installed', inp('ap-inst', 'installed_on', a.installed_on, 'type="date"'))}${f('ap-war', 'Warranty until', inp('ap-war', 'warranty_until', a.warranty_until, 'type="date"'))}</div>
      ${f('ap-life', 'Expected life (years)', inp('ap-life', 'life_years', a.life_years, 'type="number" inputmode="numeric" min="1" max="100" placeholder="Filled in from the type"'))}
      ${f('ap-notes', 'Notes', `<textarea class="input" id="ap-notes" name="notes" placeholder="Filter size, last service, parts…">${esc(a.notes)}</textarea>`)}
      <p class="small muted">Tip: the model and serial are on a sticker on the side, back or inside the door.</p>
    </section>`, isNew ? null : 'Delete appliance');
  }
  function contractorSheet(sh) {
    const isNew = sh.type === 'new-contractor';
    const c = isNew ? { trade: 'Plumber' } : S.contractors.find((x) => x.id === sh.id);
    if (!c) return '';
    const jobs = isNew ? [] : jobsFor(c);
    return sheetShell(isNew ? 'Add contractor' : c.name, 'contractor', `<section class="card">
      ${f('co-name', 'Name / company', inp('co-name', 'name', c.name, 'required autocomplete="off"'))}
      ${f('co-trade', 'Trade', `<select class="input" id="co-trade" name="trade">${opts(TRADES, c.trade)}</select>`)}
      <div class="grid2">${f('co-phone', 'Phone', inp('co-phone', 'phone', c.phone, 'type="tel" inputmode="tel" autocomplete="off"'))}${f('co-email', 'Email', inp('co-email', 'email', c.email, 'type="email" inputmode="email" autocomplete="off"'))}</div>
      ${f('co-notes', 'Notes', `<textarea class="input" id="co-notes" name="notes" placeholder="License #, rates, who to ask for…">${esc(c.notes)}</textarea>`)}
    </section>
    ${jobs.length ? `<section class="card"><h2>Jobs</h2>${jobs.map((l) => `<div class="row between small"><span>${fmtDate(fromIso(l.done_on))} · ${esc(l.title)}</span><strong class="num">${l.cost != null ? money(l.cost) : ''}</strong></div>`).join('')}</section>` : ''}`,
    isNew ? null : 'Delete contractor');
  }
  function docSheet(sh) {
    const isNew = sh.type === 'new-doc';
    const d = isNew ? { category: 'Lease', unit_id: wholeId() } : S.documents.find((x) => x.id === sh.id);
    if (!d) return '';
    return sheetShell(isNew ? 'Add document' : d.title, 'doc', `<section class="card">
      ${f('dc-title', 'Title', inp('dc-title', 'title', d.title, 'required placeholder="e.g. 2nd floor lease 2026–27"'))}
      <div class="grid2">${f('dc-cat', 'Type', `<select class="input" id="dc-cat" name="category">${opts(DOC_CATS, d.category)}</select>`)}${f('dc-unit', 'For', `<select class="input" id="dc-unit" name="unit_id">${unitOptions(d.unit_id)}</select>`)}</div>
      ${f('dc-exp', 'Expires / renews <span class="muted">(optional)</span>', inp('dc-exp', 'expires_on', d.expires_on, 'type="date"'))}
      <div class="field"><label for="dc-file">${d.file_path ? 'Replace file' : 'Photo or PDF'}</label><input class="input" id="dc-file" name="file" type="file" accept="image/*,application/pdf" style="padding:10px"></div>
      ${f('dc-notes', 'Notes', `<textarea class="input" id="dc-notes" name="notes">${esc(d.notes)}</textarea>`)}
      <p class="small muted">Files are private to your household. You’ll get a heads-up 30 days before an expiry date.</p>
    </section>`, isNew ? null : 'Delete document');
  }

  function billSheet(sh) {
    const isNew = sh.type === 'new-bill';
    const b = isNew ? Object.assign({ unit_id: wholeId(), category: 'Other', amount_type: 'variable' }, sh.preset || {}) : S.bills.find((x) => x.id === sh.id);
    if (!b) return '';
    const pay = isNew ? {} : (getPay(b, S.month) || {});
    const sc = S.scan && (isNew ? !S.scan.billId : S.scan.billId === b.id) ? S.scan : null;
    if (sc && isNew) Object.assign(b, { name: sc.provider || '', category: CATEGORIES.includes(sc.category) ? sc.category : 'Other', account_number: sc.account_number || null, due_day: sc.due_date ? +sc.due_date.slice(8, 10) : null, default_amount: null });
    const amt = sc && sc.amount_due != null ? sc.amount_due : (isNew ? null : amountFor(b, pay));
    const paidDate = pay.paid_at ? isoDate(new Date(pay.paid_at)) : '';
    const isMort = b.category === 'Mortgage';
    const scanNote = sc ? `<p class="notice info">Read from your photo${sc.confidence && sc.confidence !== 'high' ? ' (' + esc(sc.confidence) + ' confidence)' : ''}: ${sc.amount_due != null ? money(sc.amount_due) : 'amount unclear'}${sc.due_date ? ', due ' + fmtDate(fromIso(sc.due_date)) : ''}${sc.service_period ? ', for ' + esc(sc.service_period) : ''}. Please check before saving. The photo will be attached.</p>` : '';
    const mortMonth = isNew || !isMort ? '' : `
        <p class="lab small" style="margin:4px 0 0">From your monthly statement <span class="muted">(optional, for taxes and equity)</span></p>
        <div class="grid2">${f('p-prin', 'Principal ($)', moneyInp('p-prin', 'p_principal', pay.principal))}${f('p-int', 'Interest ($)', moneyInp('p-int', 'p_interest', pay.interest))}</div>
        <div class="grid2">${f('p-esc', 'Escrow ($)', moneyInp('p-esc', 'p_escrow', pay.escrow_part))}${f('p-bal', 'Balance after ($)', moneyInp('p-bal', 'p_balance', pay.balance_after))}</div>`;
    const loan = !isMort ? '' : `<section class="card"><h2>Loan</h2>
        <div class="grid2">${f('b-lbal', 'Loan balance ($)', moneyInp('b-lbal', 'loan_balance', b.loan_balance))}${f('b-rate', 'Interest rate (%)', inp('b-rate', 'loan_rate', b.loan_rate, 'inputmode="decimal" placeholder="e.g. 6.25"'))}</div>
        ${f('b-hval', 'Estimated home value ($)', moneyInp('b-hval', 'home_value', b.home_value))}
        <p class="small muted">The latest “Balance after” you enter replaces the loan balance. Home value is your own estimate, for equity.</p>
        <button type="button" class="btn primary-soft" data-act="payoff-open">Open payoff planner</button>
      </section>`;
    const month = isNew ? (sc ? scanNote + `<section class="card"><h2>${monthLabel(S.month)}</h2>${f('p-amt', 'Amount ($)', moneyInp('p-amt', 'p_amount', amt))}</section>` : '') : scanNote + `<section class="card" id="bill-month">
        <h2>${monthLabel(S.month)}</h2>
        <div class="grid2">${f('p-amt', 'Amount ($)', moneyInp('p-amt', 'p_amount', amt))}${f('p-date', 'Paid on', inp('p-date', 'p_paid', paidDate, 'type="date"'))}</div>
        <div class="grid2">${f('p-method', 'Paid with', `<select class="input" id="p-method" name="p_method">${methodOpts(pay.method)}</select>`)}${f('p-conf', 'Confirmation #', inp('p-conf', 'p_confirmation', pay.confirmation))}</div>
        ${f('p-note', 'Note', inp('p-note', 'p_note', pay.note))}${mortMonth}${isNew ? '' : yoyBlock(b, amt)}${isNew ? '' : explainBlock(b, amt)}
        <div class="field"><span class="lab">Bill photo or receipt</span>
          ${pay.receipt_path ? `<div class="btns"><button type="button" class="btn" data-act="receipt-view">View</button><button type="button" class="btn danger" data-act="receipt-remove">Remove</button></div><div id="receipt-slot"></div>` :
            `<label class="btn" style="width:100%"><input type="file" accept="image/*,application/pdf" class="sr" data-change="receipt"> Add photo or PDF</label>`}
        </div>
      </section>`;
    const details = `<section class="card">
        <h2>${isNew ? 'New bill' : 'Bill settings'}</h2>
        ${f('b-name', 'Provider / name', inp('b-name', 'name', b.name, 'required placeholder="e.g. Optimum internet"'))}
        <div class="grid2">${f('b-label', 'Label', inp('b-label', 'label', b.label, 'placeholder="Optional"'))}${f('b-acct', 'Account #', inp('b-acct', 'account_number', b.account_number, 'inputmode="numeric"'))}</div>
        <div class="grid2">${f('b-cat', 'Category', `<input class="input" id="b-cat" name="category" list="cat-list" value="${esc(b.category || 'Other')}" autocomplete="off"><datalist id="cat-list">${Array.from(new Set(CATEGORIES.concat(S.bills.map((x) => x.category).filter(Boolean)))).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`)}${f('b-unit', 'Where', `<select class="input" id="b-unit" name="unit_id">${unitOptions(b.unit_id)}</select>`)}</div>
        <div class="grid2">${f('b-day', 'Due day', inp('b-day', 'due_day', b.due_day, 'type="number" inputmode="numeric" min="1" max="31"'))}${f('b-def', 'Usual amount ($)', moneyInp('b-def', 'default_amount', b.default_amount))}</div>
        <label class="checkrow"><input type="checkbox" name="fixed" ${b.amount_type === 'fixed' ? 'checked' : ''}> Same amount every month</label>
        <label class="checkrow"><input type="checkbox" name="autopay" ${b.autopay ? 'checked' : ''}> Paid automatically (autopay)</label>
        <label class="checkrow"><input type="checkbox" name="escrow" ${b.escrow ? 'checked' : ''}> Paid from mortgage escrow (track only, not counted as money out)</label>
        <fieldset class="field monthpick"><legend class="lab">Due only in these months <span class="muted">(leave empty for every month)</span></legend>
          <div class="mgrid">${MONTH_NAMES.map((m, i) => `<label class="mchip"><input type="checkbox" name="due_m" value="${i + 1}" ${(b.due_months || []).includes(i + 1) ? 'checked' : ''}><span>${m}</span></label>`).join('')}</div>
        </fieldset>
        ${f('b-url', 'Payment website', inp('b-url', 'pay_url', b.pay_url, 'type="url" inputmode="url" placeholder="https://"'))}
        ${f('b-notes', 'Notes', `<textarea class="input" id="b-notes" name="notes">${esc(b.notes)}</textarea>`)}
      </section>`;
    const settings = isNew ? details : `<details class="card fold editfold" data-fold="bill-edit" ${isOpen('bill-edit', false) ? 'open' : ''}><summary><h2>Edit bill</h2><span class="small muted">name, account #, due day, autopay…</span><span class="chev" aria-hidden="true"></span></summary><div class="fold-body">${details.replace(/^<section class="card">\s*<h2>Bill settings<\/h2>/, '').replace(/<\/section>$/, '')}</div></details>`;
    return sheetShell(isNew ? 'Add bill' : billTitle(b), 'bill', (isNew ? '' : billDetailTop(b, pay)) + month + (isNew ? '' : loan) + settings + (isNew ? loan : ''), isNew ? null : 'Delete bill and its history', isNew ? '' : '<button type="button" class="btn block" data-act="bill-archive">Remove from my list <span class="small muted">· keeps its history</span></button>');
  }

  function rentalSheet(sh) {
    const isNew = sh.type === 'new-rental';
    const r = isNew ? { due_day: 1, grace_days: 5, unit_id: sh.unit || (vacantUnits()[0] || S.units.find((u) => isFloor(u.name)) || {}).id } : S.rentals.find((x) => x.id === sh.id);
    if (!r) return '';
    const rp = isNew ? {} : (getRentPay(r, S.month) || {});
    const due = isNew ? null : rentDue(r, rp);
    const recvDate = rp.received_at ? isoDate(new Date(rp.received_at)) : '';
    const month = isNew ? '' : `<section class="card">
        <h2>${monthLabel(S.month)} rent</h2>
        <div class="grid2">${f('rp-due', 'Amount due ($)', moneyInp('rp-due', 'rp_due', due))}${f('rp-got', 'Received ($)', moneyInp('rp-got', 'rp_got', rp.amount_received))}</div>
        <div class="grid2">${f('rp-date', 'Received on', inp('rp-date', 'rp_date', recvDate, 'type="date"'))}${f('rp-method', 'Paid with', `<select class="input" id="rp-method" name="rp_method">${methodOpts(rp.method)}</select>`)}</div>
        ${f('rp-note', 'Note', inp('rp-note', 'rp_note', rp.note, 'placeholder="e.g. paid $500 now, rest on the 15th"'))}
        <p class="small muted">For a partial payment, enter what you’ve received so far.</p>
      </section>`;
    const details = `<section class="card">
        <h2>${isNew ? 'New tenant' : 'Tenant & lease'}</h2>
        <div class="grid2">${f('r-name', 'Tenant name', inp('r-name', 'tenant_name', r.tenant_name, 'autocomplete="off"'))}${f('r-unit', 'Unit', `<select class="input" id="r-unit" name="unit_id">${unitOptions(r.unit_id)}</select>`)}</div>
        <div class="grid2">${f('r-phone', 'Phone', inp('r-phone', 'phone', r.phone, 'type="tel" inputmode="tel" autocomplete="off"'))}${f('r-email', 'Email', inp('r-email', 'email', r.email, 'type="email" inputmode="email" autocomplete="off"'))}</div>
        <div class="grid2">${f('r-rent', 'Monthly rent ($)', moneyInp('r-rent', 'rent_amount', r.rent_amount))}${f('r-day', 'Due day', inp('r-day', 'due_day', r.due_day, 'type="number" inputmode="numeric" min="1" max="31"'))}</div>
        <div class="grid2">${f('r-grace', 'Grace days', inp('r-grace', 'grace_days', r.grace_days, 'type="number" inputmode="numeric" min="0" max="31"'))}${f('r-fee', 'Late fee ($)', moneyInp('r-fee', 'late_fee', r.late_fee))}</div>
        <div class="grid2">${f('r-start', 'Lease start', inp('r-start', 'lease_start', r.lease_start, 'type="date"'))}${f('r-end', 'Lease end', inp('r-end', 'lease_end', r.lease_end, 'type="date"'))}</div>
        ${f('r-payer', 'Also pays as <span class="muted">(other names on Zelle, comma-separated)</span>', inp('r-payer', 'payer_names', r.payer_names, 'autocomplete="off" placeholder="e.g. spouse’s name"'))}
        ${f('r-notes', 'Notes', `<textarea class="input" id="r-notes" name="notes">${esc(r.notes)}</textarea>`)}
      </section>
      <section class="card">
        <h2>Security deposit</h2>
        <div class="grid2">${f('r-dep', 'Amount ($)', moneyInp('r-dep', 'deposit', r.deposit))}${f('r-deprec', 'Received on', inp('r-deprec', 'deposit_received_on', r.deposit_received_on, 'type="date"'))}</div>
        ${f('r-dephold', 'Held at', inp('r-dephold', 'deposit_held_at', r.deposit_held_at, 'placeholder="Bank and account (NY requires a NY bank)"'))}
        ${r.move_out_on ? `<p class="small">Moved out ${fmtDate(fromIso(r.move_out_on))}. ${r.deposit_returned_on ? 'Deposit returned ' + fmtDate(fromIso(r.deposit_returned_on)) + (r.deposit_returned_amount != null ? ' · ' + money(r.deposit_returned_amount) : '') : 'Return due by ' + fmtDate(new Date(fromIso(r.move_out_on).getTime() + 14 * 86400000)) + '.'}</p>` : ''}
      </section>`;
    const tools = isNew ? '' : `<section class="card">
        <h2>Tenant page</h2>
        <p class="small muted">A private link where ${esc(r.tenant_name ? r.tenant_name.split(' ')[0] : 'your tenant')} can see their rent balance and send repair requests with photos. No app or password needed.</p>
        <div class="btns">
          <button type="button" class="btn" data-act="portal-copy" data-id="${r.id}" style="flex:1">Copy link</button>
          ${r.phone ? `<a class="btn" style="flex:1" href="sms:${esc(r.phone.replace(/[^\d+]/g, ''))}${isIOS ? '&' : '?'}body=${encodeURIComponent('Hi' + (r.tenant_name ? ' ' + r.tenant_name.split(' ')[0] : '') + ', here’s your private page to see your rent and send repair requests: ' + portalUrl(r))}">Text link</a>` : ''}
          <button type="button" class="btn" data-act="portal-new" data-id="${r.id}">New link</button>
        </div>
      </section>
      <section class="card">
        <h2>Lease</h2>
        <div class="btns"><button type="button" class="btn" data-act="renew" data-id="${r.id}" style="flex:1">Renew lease</button><button type="button" class="btn" data-act="moveout" data-id="${r.id}" style="flex:1">Move-out</button><button type="button" class="btn" data-act="inspections" data-id="${r.id}" style="flex:1">Inspections</button></div>
        ${S.leases.filter((l) => l.rental_id === r.id).map((l) => `<div class="row between small"><span>${l.lease_start ? fmtDate(fromIso(l.lease_start)) : '?'} – ${l.lease_end ? fmtDate(fromIso(l.lease_end)) : '?'}${l.tenant_name ? ' · ' + esc(l.tenant_name) : ''}</span><strong class="num">${l.rent_amount != null ? money(l.rent_amount) : ''}</strong></div>`).join('') || '<p class="small muted">Past leases appear here when you renew.</p>'}
      </section>`;
    return sheetShell(isNew ? 'Add tenant' : rentalTitle(r), 'rental', month + details + tools, isNew ? null : 'Remove tenant and rent history');
  }

  function taskSheet(sh) {
    const isNew = sh.type === 'new-task';
    const t = isNew ? { unit_id: wholeId(), category: 'Other', interval_months: 12 } : S.tasks.find((x) => x.id === sh.id);
    if (!t) return '';
    const intervals = [[0, 'One-time job'], [1, 'Every month'], [2, 'Every 2 months'], [3, 'Every 3 months'], [6, 'Every 6 months'], [12, 'Every year'], [24, 'Every 2 years'], [36, 'Every 3 years'], [60, 'Every 5 years']];
    if (t.interval_months && !intervals.some((i) => i[0] === t.interval_months)) intervals.push([t.interval_months, 'Every ' + t.interval_months + ' months']);
    const history = isNew ? '' : S.logs.filter((l) => l.task_id === t.id);
    return sheetShell(isNew ? 'Add upkeep task' : t.title, 'task', `<section class="card">
        ${f('t-title', 'Task', inp('t-title', 'title', t.title, 'required placeholder="e.g. Service the boiler"'))}
        <div class="grid2">${f('t-cat', 'Category', `<select class="input" id="t-cat" name="category">${opts(UPKEEP_CATS, t.category)}</select>`)}${f('t-unit', 'Where', `<select class="input" id="t-unit" name="unit_id">${unitOptions(t.unit_id)}</select>`)}</div>
        <div class="grid2">${f('t-int', 'How often', `<select class="input" id="t-int" name="interval_months">${intervals.map(([v, l]) => `<option value="${v}" ${(t.interval_months || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}${f('t-next', 'Next due', inp('t-next', 'next_due', t.next_due, 'type="date"'))}</div>
        ${f('t-vendor', 'Usual contractor', inp('t-vendor', 'vendor', t.vendor, 'placeholder="Name & phone"'))}
        ${f('t-notes', 'Notes', `<textarea class="input" id="t-notes" name="notes">${esc(t.notes)}</textarea>`)}
      </section>
      ${history && history.length ? `<section class="card"><h2>History</h2>${history.map((l) => `<div class="row between small"><span>${fmtDate(fromIso(l.done_on))}${l.vendor ? ' · ' + esc(l.vendor) : ''}</span><strong class="num">${l.cost != null ? money(l.cost) : ''}</strong></div>`).join('')}</section>` : ''}`,
      isNew ? null : 'Delete task');
  }

  function doneSheet(sh) {
    const t = S.tasks.find((x) => x.id === sh.id);
    if (!t) return '';
    return sheetShell('Done: ' + t.title, 'task-done', `<section class="card">
        ${f('dn-date', 'When', inp('dn-date', 'done_on', isoDate(today()), 'type="date" required'))}
        ${(() => { const dr = S.doneReceipt && S.doneReceipt.id === t.id ? S.doneReceipt : null; return `<label class="btn block scanbtn"><input type="file" accept="image/*" capture="environment" class="sr" data-change="done-receipt" data-id="${t.id}"> ${ICON.camera} ${dr ? 'Retake receipt' : 'Snap the receipt (fills cost and who)'}</label>
        <p class="small rc-status" id="dn-rc-status" aria-live="polite">${dr ? esc(dr.msg || '') : ''}</p>`; })()}
        <div class="grid2">${f('dn-cost', 'Cost ($)', moneyInp('dn-cost', 'cost', S.doneReceipt && S.doneReceipt.id === t.id ? S.doneReceipt.cost : null))}${f('dn-vendor', 'Who did it', inp('dn-vendor', 'vendor', (S.doneReceipt && S.doneReceipt.id === t.id && S.doneReceipt.vendor) || t.vendor, 'placeholder="Me / contractor" list="pros-list"'))}</div>${vendorList()}
        ${f('dn-notes', 'Notes', `<textarea class="input" id="dn-notes" name="notes" placeholder="Optional"></textarea>`)}
        <p class="small muted">${t.interval_months ? 'Next one will be scheduled ' + everyLabel(t).toLowerCase().replace(/^every (year|month)$/, 'in a $1').replace('every', 'in') + ' from this date.' : 'This one-time job will be marked complete.'}</p>
      </section>`, null);
  }

  function logSheet(sh) {
    const isNew = sh.type === 'new-log';
    const rd = isNew ? S.receiptDraft : null;
    const l = isNew ? Object.assign({ unit_id: wholeId(), done_on: isoDate(today()) }, rd ? { title: rd.title, done_on: rd.done_on, cost: rd.cost, vendor: rd.vendor } : {}) : S.logs.find((x) => x.id === sh.id);
    if (!l) return '';
    return sheetShell(isNew ? (rd ? 'From your receipt' : 'Log a repair') : l.title, 'log', `${rd ? `<p class="notice info">Read from your photo${rd.confidence && rd.confidence !== 'high' ? ' (' + esc(rd.confidence) + ' confidence)' : ''}. Check it before saving; the photo will be attached.</p>` : ''}<section class="card">
        ${f('l-title', 'What was done', inp('l-title', 'title', l.title, 'required placeholder="e.g. Fixed leaking kitchen faucet"'))}
        <div class="grid2">${f('l-date', 'Date', inp('l-date', 'done_on', l.done_on, 'type="date" required'))}${f('l-unit', 'Where', `<select class="input" id="l-unit" name="unit_id">${unitOptions(l.unit_id)}</select>`)}</div>
        <div class="grid2">${f('l-cost', 'Cost ($)', moneyInp('l-cost', 'cost', l.cost))}${f('l-vendor', 'Who did it', inp('l-vendor', 'vendor', l.vendor, 'list="pros-list"'))}</div>${vendorList()}
        ${f('l-notes', 'Notes', `<textarea class="input" id="l-notes" name="notes">${esc(l.notes)}</textarea>`)}
        ${l.receipt_path ? `<button type="button" class="btn" data-act="file-open" data-path="${esc(l.receipt_path)}">View receipt</button>` : ''}
      </section>`, isNew ? null : 'Delete entry');
  }

  // ---------- actions ----------
  function findBill(id) { return S.bills.find((b) => b.id === id); }
  function openSheet(type, id) { S.sheet = { type, id }; S.sheetErr = ''; S.deleteArm = false; FX.sheetEnter = true; render(); }

  async function onAct(el) {
    const act = el.dataset.act;
    const id = el.dataset.id;
    switch (act) {
      case 'tab': S.tab = el.dataset.tab; window.scrollTo(0, 0); render(); break;
      case 'textsize': try { localStorage.setItem('ds-text', el.dataset.v); } catch (_) {} applyTextSize(el.dataset.v); render(); toast(el.dataset.v === '1' ? 'Normal text' : (el.dataset.v === '1.12' ? 'Large' : 'Larger') + ' text on'); break;
      case 'cat-filter': {
        S.catFilter = el.dataset.v || null; S.billsView = 'list'; render();
        if (S.catFilter) { const a = document.getElementById('bill-list'); if (a) a.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }
        break;
      }
      case 'theme': try { localStorage.setItem('ds-theme', el.dataset.v); } catch (_) {} applyTheme(el.dataset.v); render(); toast(el.dataset.v === 'auto' ? 'Following your phone' : (el.dataset.v === 'dark' ? 'Dark' : 'Light') + ' mode on'); break;
      case 'jump': { const c = document.getElementById('bill-' + id); if (c) { c.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1200); } else { S.filter = 'all'; S.unit = 'all'; render(); const d = document.getElementById('bill-' + id); if (d) d.scrollIntoView({ block: 'center' }); } break; }
      case 'go': {
        S.tab = el.dataset.tab; S.sheet = null; window.scrollTo(0, 0); render();
        const a = el.dataset.anchor && document.getElementById(el.dataset.anchor); if (a) a.scrollIntoView({ block: 'start' });
        break;
      }
      case 'month': S.month = addMonths(S.month, Number(el.dataset.delta)); S.editing = null; render(); break;
      case 'month-today': S.month = monthKey(new Date()); render(); break;
      case 'unit': S.unit = el.dataset.unit; render(); break;
      case 'filter': S.filter = el.dataset.filter; render(); break;
      case 'upkeep-view': S.upkeepView = el.dataset.v; render(); break;
      case 'edit': { S.editing = id; render(); const n = document.getElementById('a-' + id); if (n) n.focus(); break; }
      case 'done': S.editing = null; render(); break;
      case 'bd-month': {
        S.month = el.dataset.k; S.bdSel = null; S.editing = null; render();
        const m = document.getElementById('bill-month'), sh = document.querySelector('.sheet');
        if (m && sh && el.dataset.k !== monthKey(new Date())) m.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
        else if (sh) sh.scrollTo({ top: 0 });
        break;
      }
      case 'hint-ok': try { localStorage.setItem('ds-hint-swipe', '1'); } catch (_) {} render(); break;
      case 'toggle': {
        try { localStorage.setItem('ds-hint-swipe', '1'); } catch (_) {}
        const b = findBill(id); const pay = getPay(b, S.month); const k = S.month;
        const prev = { paid_at: pay ? pay.paid_at || null : null, amount: pay ? (pay.amount != null ? pay.amount : null) : null, method: pay ? pay.method || null : null };
        const undo = () => savePayment(b, k, prev);
        if (pay && pay.paid_at) { savePayment(b, S.month, { paid_at: null }); toast(billTitle(b) + ' marked unpaid', undo); }
        else {
          savePayment(b, S.month, { paid_at: new Date().toISOString(), amount: amountFor(b, pay), method: (pay && pay.method) || (b.autopay ? 'Autopay' : null) });
          FX.stamp = b.id; FX.stampUntil = Date.now() + 900;
          const all = billMonth(S.month, true).rows.filter((x) => !x.b.escrow);
          if (all.length && all.every((x) => x.pay && x.pay.paid_at)) { toast('All ' + monthLabel(S.month).split(' ')[0] + ' bills paid!', undo); setTimeout(confetti, 350); } else toast(billTitle(b) + ' marked paid', undo);
          feedback();
        }
        render(); break;
      }
      case 'rent-toggle': {
        const r = S.rentals.find((x) => x.id === id); const rp = getRentPay(r, S.month); const due = rentDue(r, rp);
        if (due == null) break;
        const full = rp && Number(rp.amount_received || 0) >= due;
        const k = S.month; const prevR = { amount_received: rp ? rp.amount_received : null, received_at: rp ? rp.received_at : null, method: rp ? rp.method || null : null };
        const undo = () => saveRentPay(r, k, prevR);
        if (full) { saveRentPay(r, S.month, { amount_received: null, received_at: null }); toast('Rent marked not received', undo); }
        else {
          saveRentPay(r, S.month, { amount_due: due, amount_received: due, received_at: new Date().toISOString(), method: (rp && rp.method) || lastRentMethod(r) });
          FX.stamp = r.id; FX.stampUntil = Date.now() + 900;
          const rm = rentMonth(S.month);
          if (rm.rows.length && rm.rows.every((x) => x.st.k === 'paid')) { toast('All rent in for ' + monthLabel(S.month).split(' ')[0] + '!', undo); setTimeout(confetti, 350); } else toast('Got ' + money(due) + ' from ' + rentalTitle(r), undo);
          feedback();
        }
        render(); break;
      }
      case 'partial': S.partial = id; render(); setTimeout(() => { const n = document.getElementById('pt-' + id); if (n) n.focus(); }, 50); break;
      case 'partial-cancel': S.partial = null; render(); break;
      case 'toast-undo': runUndo(); break;
      case 'hero-slide': { S.heroSlide = +el.dataset.i; const c = document.querySelector('.herocar'); if (c) c.scrollTo({ left: c.clientWidth * S.heroSlide, behavior: reduceMotion() ? 'auto' : 'smooth' }); document.querySelectorAll('.hc-dots button').forEach((d, k) => d.setAttribute('aria-pressed', k === S.heroSlide)); break; }
      case 'snooze': {
        const t = S.tasks.find((x) => x.id === id); if (!t) break; const before = Object.assign({}, t);
        const base = t.next_due && fromIso(t.next_due) > today() ? fromIso(t.next_due) : today();
        saveTask(Object.assign({}, t, { next_due: isoDate(new Date(base.getTime() + 7 * 86400000)) }));
        render(); toast(t.title + ' snoozed a week', () => saveTask(before)); break;
      }
      case 'copy':
        try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied ' + el.dataset.text); } catch (_) { toast(el.dataset.text); }
        break;
      case 'bill': openSheet('bill', id); break;
      case 'rental': openSheet('rental', id); break;
      case 'task': openSheet('task', id); break;
      case 'task-done': S.doneReceipt = null; openSheet('task-done', id); break;
      case 'log': openSheet('log', id); break;
      case 'new-bill': case 'new-rental': case 'new-task': case 'new-log': case 'new-appliance': case 'new-contractor': case 'new-doc': openSheet(act); break;
      case 'appliance': openSheet('appliance', id); break;
      case 'contractor': openSheet('contractor', id); break;
      case 'doc': openSheet('doc', id); break;
      case 'receipt': { const r = S.rentals.find((x) => x.id === id); if (r) makeReceipt(r, S.month); break; }
      case 'quick-cancel': S.quick = null; render(); break;
      case 'quick-apply': {
        const acts = (S.quick && S.quick.actions || []).filter((a) => describeAction(a).ok);
        acts.forEach(applyAction); S.quick = null; render();
        toast(acts.length === 1 ? 'Saved' : 'Saved ' + acts.length + ' items'); break;
      }
      case 'mic': {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) break;
        if (S.listening && window.__rec) { window.__rec.stop(); break; }
        const tgt = el.dataset.target || 'qa-text'; const rec = new SR(); window.__rec = rec; rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
        S.listening = true; render();
        rec.onresult = (ev) => { const t = Array.from(ev.results).map((r) => r[0].transcript).join(' '); const n = document.getElementById(tgt); if (n) n.value = t; if (tgt === 'qa-text') S.quick = Object.assign({}, S.quick, { text: t }); };
        rec.onend = () => { S.listening = false; render(); const n = document.getElementById(tgt); if (n && n.value.trim()) n.form.requestSubmit(); };
        rec.onerror = () => { S.listening = false; render(); toast('Couldn’t hear that. Try typing.'); };
        rec.start(); break;
      }
      case 'explain': { if (!S.sheet || S.sheet.id !== id) openSheet('bill', id); explainBill(id); break; }
      case 'recap': makeRecap(); break;
      case 'ask-open': S.sheet = { type: 'ask' }; FX.sheetEnter = true; render(); setTimeout(() => { const n = document.getElementById('ask-q'); if (n) n.focus(); }, 300); break;
      case 'ask-suggest': askQuestion(el.dataset.q); break;
      case 'ask-apply': { const m = (S.askLog || [])[+el.dataset.i]; if (!m || m.applied) break; const acts = m.actions.filter((a) => describeAction(a).ok); acts.forEach(applyAction); m.applied = 'yes'; render(); feedback(); toast(acts.length === 1 ? 'Saved' : 'Saved ' + acts.length + ' items'); break; }
      case 'ask-retry': { const i = +el.dataset.i; const m = (S.askLog || [])[i]; if (!m || !m.retry) break; S.askLog = S.askLog.slice(0, i - 1); askQuestion(m.retry); break; }
      case 'personal-add': {
        const pu = personalUnit(); if (!pu) { toast('Personal list isn’t ready yet. Pull down to refresh.'); break; }
        S.sheet = { type: 'new-bill', preset: { name: el.dataset.name || '', category: el.dataset.cat || 'Other', unit_id: pu.id, amount_type: 'fixed', autopay: true, due_day: null } };
        S.sheetErr = ''; S.deleteArm = false; FX.sheetEnter = true; render();
        setTimeout(() => { const n = document.getElementById(el.dataset.name ? 'b-def' : 'b-name'); if (n) n.focus(); }, 300);
        break;
      }
      case 'cz-move': { const c = getCustom(); const kind = el.dataset.kind; const defs = kind === 'tabs' ? TAB_DEFS : HOME_DEFS; c[kind].order = moveIn(ordered(defs, c[kind]).map((d) => d[0]), el.dataset.id, +el.dataset.dir); setCustom(c); render(); break; }
      case 'cz-reset': setCustom({}); toast('Back to the default layout'); render(); break;
      case 'bill-archive': { const b = findBill(S.sheet.id); if (!b) break; saveBill(Object.assign({}, b, { active: false })); S.sheet = null; render(); toast(billTitle(b) + ' removed', () => saveBill(Object.assign({}, b, { active: true }))); break; }
      case 'bill-restore': { const b = findBill(id); if (!b) break; saveBill(Object.assign({}, b, { active: true })); render(); toast(billTitle(b) + ' is back'); break; }
      case 'bill-forget': { if (S.forgetArm !== id) { S.forgetArm = id; render(); setTimeout(() => { if (S.forgetArm === id) { S.forgetArm = null; renderSoon(); } }, 4000); break; } S.forgetArm = null; deleteBill(id); render(); toast('Deleted for good'); break; }
      case 'app-reload': window.location.reload(); break;
      case 'demo-login': {
        S.busy = true; S.authErr = ''; render();
        const r = await sb.auth.signInWithPassword({ email: CFG.DEMO_EMAIL, password: CFG.DEMO_PASSWORD });
        S.busy = false; if (r.error) S.authErr = 'The demo is being refreshed. Try again in a minute.'; render(); break;
      }
      case 'auth-mode': S.authMode = el.dataset.v; S.authErr = ''; S.authMsg = ''; render(); if (el.dataset.jump) { const f = document.getElementById('signin'); if (f) f.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); setTimeout(() => { const n = document.getElementById('a-email'); if (n) n.focus({ preventScroll: true }); }, 350); } break;
      case 'demo-signup': S.authMode = 'signup'; await sb.auth.signOut(); break;
      case 'houses-open': S.sheet = { type: 'houses' }; S.sheetErr = ''; FX.sheetEnter = true; render(); break;
      case 'house-switch': {
        if (S.household && id === S.household.id) { S.sheet = null; render(); break; }
        try { localStorage.setItem('ds-house', id); } catch (_) {}
        S.sheet = null; S.month = monthKey(new Date()); S.unit = 'all'; S.tab = 'summary'; S.view = 'loading'; render();
        await loadAll(); toast('Switched to ' + (S.household ? S.household.name : 'property')); break;
      }
      case 'notice-ok': case 'notice-no': {
        const n = (S.notices || []).find((x) => x.id === id); if (!n) break;
        const ok = act === 'notice-ok';
        if (ok) {
          const r = S.rentals.find((x) => x.id === n.rental_id);
          if (r) { const k = n.period.slice(0, 7) + '-01'; const rp = getRentPay(r, k); saveRentPay(r, k, { amount_due: rentDue(r, rp), amount_received: Math.round((Number((rp && rp.amount_received) || 0) + Number(n.amount)) * 100) / 100, received_at: n.created_at, method: n.method || (rp && rp.method) || null }); }
        }
        n.status = ok ? 'confirmed' : 'dismissed';
        queue({ kind: 'update', table: 'rent_notices', row: { status: n.status }, match: { id: n.id } });
        S.notices = S.notices.filter((x) => x.id !== n.id); saveCache(); render();
        if (ok) { feedback(); toast('Rent marked received'); } else toast('Left as not received');
        break;
      }
      case 'export-data': {
        const pick = ['household', 'units', 'bills', 'payments', 'rentals', 'rentPays', 'tasks', 'logs', 'appliances', 'contractors', 'documents', 'leases', 'inspections', 'requests', 'notices'];
        const out = { app: 'Doorstep', exported_at: new Date().toISOString(), user: S.user ? S.user.email : null };
        pick.forEach((k) => { out[k] = S[k]; });
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'doorstep-' + String(S.household ? S.household.name : 'data').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + isoDate(today()) + '.json';
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast('Downloaded'); break;
      }
      case 'delete-account': {
        if (isDemo()) break;
        if (!S.delArm) { S.delArm = true; render(); setTimeout(() => { S.delArm = false; renderSoon(); }, 6000); break; }
        S.delArm = false; toast('Deleting…');
        try {
          // remove the files of properties only you are in, then the account
          for (const h of (S.houses || [])) {
            const mem = await sb.from('household_members').select('user_id').eq('household_id', h.id);
            if (mem.error || (mem.data || []).some((x) => x.user_id !== S.user.id)) continue;
            const top = await sb.storage.from('receipts').list(h.id, { limit: 100 });
            for (const f of (top.data || [])) {
              const inner = await sb.storage.from('receipts').list(h.id + '/' + f.name, { limit: 1000 });
              const paths = (inner.data || []).map((x) => h.id + '/' + f.name + '/' + x.name).concat(f.id ? [h.id + '/' + f.name] : []);
              if (paths.length) await sb.storage.from('receipts').remove(paths);
            }
          }
          const r = await sb.rpc('delete_my_account');
          if (r.error) throw r.error;
          try { Object.keys(localStorage).filter((k) => /^ds-/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
          await sb.auth.signOut();
          S.user = null; S.household = null; S.view = 'auth'; render(); toast('Your account was deleted.');
        } catch (e) { toast(friendlyErr(e, 'delete the account')); }
        break;
      }
      case 'forgot': {
        const n = document.getElementById('a-email'); const email = n ? n.value.trim() : '';
        S.authErr = ''; S.authMsg = '';
        if (!/^\S+@\S+\.\S+$/.test(email)) { S.authErr = 'Type your email above, then tap “Forgot password?” again.'; render(); break; }
        S.busy = true; render();
        const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: CFG.APP_URL });
        S.busy = false;
        if (r.error && !/rate|limit|seconds/i.test(r.error.message)) S.authErr = friendlyErr(r.error, 'send the email');
        else if (r.error) S.authErr = 'Too many reset emails right now. Please try again in an hour.';
        else S.authMsg = 'If that email has an account, a reset link is on its way. Check your inbox and spam.';
        render(); const f = document.getElementById('a-email'); if (f) f.value = email; break;
      }
      case 'density': try { localStorage.setItem('ds-density', el.dataset.v); } catch (_) {} S.open = null; render(); toast(el.dataset.v === 'simple' ? 'Simple layout' : 'Detailed layout'); break;
      case 'expand': S.open = S.open === id ? null : id; render(); { const n = document.getElementById('bill-' + id) || document.getElementById('rent-' + id) || document.getElementById('task-' + id); if (n && S.open) n.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }); } break;
      case 'needs-all': S.needsAll = !S.needsAll; render(); break;
      case 'banner-x': bx(el.dataset.k, el.dataset.v); if (el.dataset.k === 'story') { try { localStorage.setItem('ds-story', weekStart()); } catch (_) {} } render(); break;
      case 'add-menu': S.sheet = { type: 'addmenu' }; FX.sheetEnter = true; render(); break;
      case 'tour-next': if (S.tour < TOUR.length - 1) { S.tour++; render(); } else endTour(); break;
      case 'tour-skip': endTour(); break;
      case 'tour-again': S.tour = 0; window.scrollTo(0, 0); render(); break;
      case 'ask-skip': { const m = (S.askLog || [])[+el.dataset.i]; if (m) { m.applied = 'no'; render(); } break; }
      case 'bills-view': S.billsView = el.dataset.v; try { localStorage.setItem('ds-bview', S.billsView); } catch (_) {} render(); break;
      case 'cal-day': S.calDay = { k: S.month, d: +el.dataset.d }; render(); break;
      case 'cal-open': { const kd = el.dataset.kind; if (kd === 'bill') openSheet('bill', id); else if (kd === 'rent') openSheet('rental', id); else openSheet('task', id); break; }
      case 'story-open': openStory(); break;
      case 'story-close': S.story = null; render(); break;
      case 'story-next': storyGo(S.story ? S.story.i + 1 : 0); break;
      case 'story-prev': storyGo(S.story ? S.story.i - 1 : 0); break;
      case 'story-cta': {
        const g = el.dataset.go; S.story = null;
        if (g === 'go-bills') { S.tab = 'bills'; S.billsView = 'list'; S.month = monthKey(new Date()); }
        else if (g === 'go-rent') { S.tab = 'rent'; S.month = monthKey(new Date()); }
        else if (g === 'go-cal') { S.tab = 'bills'; S.billsView = 'cal'; S.month = monthKey(new Date()); }
        else if (g.startsWith('explain:')) { const bid = g.slice(8); S.month = monthKey(new Date()); render(); openSheet('bill', bid); explainBill(bid); break; }
        window.scrollTo(0, 0); render(); break;
      }
      case 'flow-sel': S.flowSel = el.dataset.k; render(); break;
      case 'flow-mode': S.flowPct = el.dataset.v === '1'; render(); break;
      case 'bd-bar': S.bdSel = { id, k: S.month, i: +el.dataset.i }; render(); break;
      case 'payoff-open': S.sheet = { type: 'payoff' }; FX.sheetEnter = true; render(); break;
      case 'payoff-term': S.payoff = Object.assign({}, S.payoff, { NT: +el.dataset.t }); render(); break;
      case 'renew': openSheet('renew', id); break;
      case 'moveout': openSheet('moveout', id); break;
      case 'inspections': openSheet('inspections', id); break;
      case 'request': openSheet('request', id); break;
      case 'file-open': openFile(el.dataset.path); break;
      case 'portal-copy': { const r = S.rentals.find((x) => x.id === id); try { await navigator.clipboard.writeText(portalUrl(r)); toast('Link copied'); } catch (_) { toast(portalUrl(r)); } break; }
      case 'portal-new': {
        const r = S.rentals.find((x) => x.id === id);
        const tok = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
        saveRental(Object.assign({}, r, { portal_token: tok })); render(); toast('New link made. The old one stops working.'); break;
      }
      case 'inspect-new': S.inspDraft = { id: uuid(), rental_id: id, kind: el.dataset.kind || 'Move-in', done_on: isoDate(today()), items: ROOMS.map((room) => ({ room, condition: 'Good', note: '', photos: [] })), notes: '' }; openSheet('inspection'); break;
      case 'inspect-open': { const i = S.inspections.find((x) => x.id === id); if (i) { S.inspDraft = JSON.parse(JSON.stringify(i)); openSheet('inspection'); } break; }
      case 'insp-cond': S.inspDraft.items[+el.dataset.i].condition = el.dataset.c; render(); break;
      case 'insp-del': S.inspDraft.items.splice(+el.dataset.i, 1); render(); break;
      case 'insp-add': { const n = document.getElementById('in-room'); const v = n && n.value.trim(); if (v) { S.inspDraft.items.push({ room: v, condition: 'Good', note: '', photos: [] }); render(); } break; }
      case 'doc-open': { const d = S.documents.find((x) => x.id === id); if (d && d.file_path) openFile(d.file_path); break; }
      case 'sheet-close': case 'sheet-close-bg': S.sheet = null; S.scan = null; render(); break;
      case 'new-rental-unit': S.sheet = { type: 'new-rental', unit: el.dataset.unit }; S.sheetErr = ''; FX.sheetEnter = true; render(); break;
      case 'sheet-delete': {
        if (!S.deleteArm) { S.deleteArm = true; render(); break; }
        const t = S.sheet.type, sid = S.sheet.id;
        if (t === 'bill') deleteBill(sid); else if (t === 'rental') deleteRental(sid); else if (t === 'task') deleteTask(sid); else if (t === 'log') deleteLog(sid);
        else if (t === 'appliance') deleteRow('appliances', sid); else if (t === 'contractor') deleteRow('contractors', sid);
        else if (t === 'inspection') { deleteRow('inspections', S.inspDraft.id); S.inspDraft = null; }
        else if (t === 'request') deleteRow('requests', sid);
        else if (t === 'doc') { const d = S.documents.find((x) => x.id === sid); if (d && d.file_path) sb.storage.from('receipts').remove([d.file_path]); deleteRow('documents', sid); }
        S.sheet = null; S.deleteArm = false; render(); toast('Deleted'); break;
      }
      case 'receipt-view': await viewReceipt(); break;
      case 'receipt-remove': {
        const b = findBill(S.sheet.id); const pay = getPay(b, S.month);
        if (pay && pay.receipt_path) { sb.storage.from('receipts').remove([pay.receipt_path]); savePayment(b, S.month, { receipt_path: null }); render(); }
        break;
      }
      case 'signout':
        await sb.auth.signOut(); try { localStorage.removeItem(cacheKey()); localStorage.removeItem(OUTBOX); } catch (_) {}
        S.user = null; S.household = null; S.view = 'auth'; render(); break;
      case 'refresh': await loadAll(); toast('Up to date'); break;
      case 'push-on': await enablePush(); break;
      case 'push-off': await disablePush(); break;
      case 'push-test': await testPush(); break;
      case 'install': if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); } break;
      case 'ics': downloadICS(); break;
      case 'tax-year': S.taxYear = (S.taxYear || Number(S.month.slice(0, 4))) + Number(el.dataset.delta); render(); break;
      case 'tax-pdf': taxPDF(); break;
      case 'tax-csv': taxCSV(); break;
      case 'copy-script':
        if (!S.household.import_token) { toast('Refresh first, then try again.'); break; }
        try { await navigator.clipboard.writeText(importScript()); toast('Setup script copied'); }
        catch (_) { download('evergreen-gmail-import.gs', importScript(), 'text/plain'); }
        break;
      case 'assign-zelle': case 'dismiss-zelle': {
        const mid = el.dataset.mid;
        const imp = S.imports.find((x) => x.message_id === mid);
        if (!imp) break;
        if (act === 'assign-zelle') {
          const sel = document.getElementById('as-' + mid);
          const r = S.rentals.find((x) => x.id === (sel && sel.value));
          if (!r) break;
          const d = imp.received_at ? new Date(imp.received_at) : new Date();
          const period = monthKey(d);
          const rp = getRentPay(r, period);
          saveRentPay(r, period, { amount_due: rentDue(r, rp), amount_received: Math.round((Number((rp && rp.amount_received) || 0) + Number(imp.amount)) * 100) / 100, received_at: d.toISOString(), method: 'Zelle' });
          Object.assign(imp, { status: 'applied', rental_id: r.id, detail: money(imp.amount) + ' from ' + (imp.payer || 'unknown') + ' → ' + rentalTitle(r) + ' (assigned by you)' });
          if (imp.payer && !(r.tenant_name || '').toLowerCase().includes(imp.payer.toLowerCase()) && !(r.payer_names || '').toLowerCase().includes(imp.payer.toLowerCase())) {
            saveRental(Object.assign({}, r, { payer_names: [r.payer_names, imp.payer].filter(Boolean).join(', ') }));
          }
          toast('Added to ' + rentalTitle(r) + '’s rent');
        } else {
          Object.assign(imp, { status: 'ignored', detail: 'Marked not rent' });
          toast('Removed from the list');
        }
        queue({ kind: 'update', table: 'email_imports', row: { status: imp.status, rental_id: imp.rental_id || null, detail: imp.detail }, match: { household_id: S.household.id, message_id: mid } });
        render(); break;
      }
      case 'rotate-import': {
        const r = await sb.rpc('rotate_import_token', { h: S.household.id });
        if (r.error) toast(r.error.message); else { S.household.import_token = r.data; saveCache(); render(); toast('New key made. Copy the script again and replace the old one.'); }
        break;
      }
      case 'csv': downloadCSV(); break;
    }
  }

  async function doneReceipt(el) {
      const file = el.files && el.files[0]; el.value = ''; if (!file) return;
      const tid = el.dataset.id; S.doneReceipt = { id: tid, file, msg: 'Reading the receipt…' };
      const st = document.getElementById('dn-rc-status'); if (st) st.textContent = S.doneReceipt.msg;
      const image = await shrinkImage(file, 1600);
      let x = null;
      try { if (image) x = await assist({ mode: 'receipt', image, type: 'image/jpeg' }); } catch (e) { S.doneReceipt.msg = '📎 Photo attached. ' + e.message; }
      if (x) {
        Object.assign(S.doneReceipt, { cost: x.total, vendor: x.vendor, msg: '📎 Receipt attached' + (x.total != null || x.vendor ? ' · read ' + [x.total != null ? money(x.total) : '', x.vendor || ''].filter(Boolean).join(' from ') + '. Check it, then Save.' : '. Couldn’t read the numbers; type them in.') });
        const c = document.getElementById('dn-cost'), v = document.getElementById('dn-vendor'), d = document.getElementById('dn-date');
        if (c && !c.value && x.total != null) c.value = x.total.toFixed(2);
        if (v && x.vendor && (!v.value || v.value === (S.tasks.find((q) => q.id === tid) || {}).vendor)) v.value = x.vendor;
        if (d && x.date && x.date <= isoDate(today())) d.value = x.date;
      } else if (!S.doneReceipt.msg.startsWith('📎')) S.doneReceipt.msg = '📎 Photo attached.';
      const st2 = document.getElementById('dn-rc-status'); if (st2) st2.textContent = S.doneReceipt.msg;
  }
  function onChange(el) {
    const kind = el.dataset.change;
    if (kind === 'due' || kind === 'amount') {
      const b = findBill(el.dataset.id);
      if (kind === 'due') {
        const d = parseInt(el.value, 10);
        saveBill(Object.assign({}, b, { due_day: d >= 1 && d <= 31 ? d : null }));
      } else {
        const v = num(el.value);
        savePayment(b, S.month, { amount: v });
        if (b.amount_type === 'fixed' && b.default_amount == null && v != null) saveBill(Object.assign({}, b, { default_amount: v }));
      }
      S.editing = el.dataset.id;
      render();
      if (kind === 'due') { const n = document.getElementById('a-' + b.id); if (n && !n.value) n.focus(); }
    } else if (kind === 'remind') {
      const form = el.form;
      const fields = { remind_days: Number(form.remind_days.value), remind_hour: Number(form.remind_hour.value), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York' };
      Object.assign(S.member, fields);
      queue({ kind: 'update', table: 'household_members', row: fields, match: { household_id: S.member.household_id, user_id: S.user.id } });
      toast('Reminder time saved');
    } else if (kind === 'receipt') {
      uploadReceipt(el.files && el.files[0]);
    } else if (kind === 'insp-meta') {
      S.inspDraft[el.dataset.k] = el.value;
    } else if (kind === 'insp-note') {
      S.inspDraft.items[+el.dataset.i].note = el.value;
    } else if (kind === 'insp-photo') {
      const i = +el.dataset.i; const file = el.files && el.files[0];
      if (file) uploadTo('inspections', file).then((path) => { if (path && S.inspDraft) { S.inspDraft.items[i].photos = (S.inspDraft.items[i].photos || []).concat(path); render(); toast('Photo added'); } });
    } else if (kind === 'scan-receipt') {
      scanReceipt(el.files && el.files[0]); el.value = '';
    } else if (kind === 'payoff') {
      const v = parseFloat(String(el.value).replace(/[$,%]/g, ''));
      S.payoff = Object.assign({}, S.payoff, { [el.dataset.k]: isFinite(v) ? v : null }); render();
    } else if (kind === 'done-receipt') {
      doneReceipt(el);
    } else if (kind === 'cz-show') {
      const c = getCustom(); const k = el.dataset.kind; const h = new Set(c[k].hidden || (k === 'tabs' && simple() ? ['personal'] : []));
      if (el.checked) h.delete(el.dataset.id); else h.add(el.dataset.id);
      c[k].hidden = Array.from(h); setCustom(c); render();
    } else if (kind === 'cz-name') {
      const c = getCustom(); const v = el.value.trim().slice(0, 14); if (v) c.names[el.dataset.id] = v; else delete c.names[el.dataset.id]; setCustom(c); render(); toast('Tab renamed');
    } else if (kind === 'sound') {
      try { localStorage.setItem('ds-sound', el.checked ? '1' : '0'); } catch (_) {}
      if (el.checked) feedback(true); toast(el.checked ? 'Sound on' : 'Sound off');
    } else if (kind === 'scan-bill') {
      scanBill(el.files && el.files[0]); el.value = '';
    } else if (kind === 'turnover') {
      const u = Object.assign({}, S.units.find((x) => x.id === el.dataset.id));
      const list = (u.turnover && u.turnover.length ? u.turnover : TURNOVER.map((item) => ({ item, done: false }))).map((x) => Object.assign({}, x));
      list[+el.dataset.i].done = el.checked; u.turnover = list; saveUnit(u); render();
    } else if (kind === 'vacant-since') {
      const u = Object.assign({}, S.units.find((x) => x.id === el.dataset.id)); u.vacant_since = el.value || null; saveUnit(u); render();
    } else if (kind === 'guide-flag') {
      localFlag(el.dataset.flag, el.checked); render();
    }
  }

  async function onSubmit(form) {
    const kind = form.dataset.form;
    const fd = new FormData(form);
    const val = (k) => String(fd.get(k) || '').trim();
    const intv = (k, lo, hi) => { const n = parseInt(val(k), 10); return n >= lo && n <= hi ? n : null; };
    const fail = (m) => { S.sheetErr = m; render(); };
    if (kind === 'auth') {
      const email = String(fd.get('email') || '').trim(), password = String(fd.get('password') || '');
      const up = S.authMode === 'signup';
      S.authErr = '';
      if (!/^\S+@\S+\.\S+$/.test(email)) { S.authErr = 'Enter your email address.'; return render(); }
      if (password.length < 8) { S.authErr = 'Passwords are at least 8 characters.'; return render(); }
      S.busy = true; render();
      const r = up ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
      S.busy = false;
      if (r.error) S.authErr = /invalid/i.test(r.error.message) ? 'That email or password isn’t right.' : /registered|exists/i.test(r.error.message) ? 'That email already has an account. Sign in instead.' : friendlyErr(r.error, up ? 'create the account' : 'sign in');
      else if (up && !r.data.session) S.authErr = 'Check your email to confirm, then sign in.';
      render();
    } else if (kind === 'recovery') {
      const password = String(fd.get('password') || '');
      if (password.length < 8) { S.authErr = 'Use at least 8 characters.'; return render(); }
      const r = await sb.auth.updateUser({ password });
      if (r.error) { S.authErr = r.error.message; return render(); }
      toast('Password saved'); S.view = 'loading'; render(); loadAll();
    } else if (kind === 'add-house') {
      const units = String(val('units') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
      const r = await sb.rpc('create_household', { p_name: val('name'), p_address: val('address') || null, p_units: units });
      if (r.error) return fail(r.error.message);
      try { localStorage.setItem('ds-house', r.data); } catch (_) {}
      S.sheet = null; S.month = monthKey(new Date()); S.unit = 'all'; S.tab = 'summary'; S.view = 'loading'; render();
      await loadAll(); toast('Added ' + val('name') + '. Add its bills and tenants.');
    } else if (kind === 'feedback') {
      S.fbMsg = ''; S.fbErr = '';
      const message = String(fd.get('message') || '').trim();
      if (!message) { S.fbErr = 'Write a message first.'; return render(); }
      const r = await sb.rpc('send_feedback', { p_message: message, p_email: String(fd.get('email') || '').trim() || null, p_page: S.view === 'app' ? 'settings' : 'landing' });
      if (r.error) S.fbErr = /tomorrow|later|first/i.test(r.error.message) ? r.error.message : friendlyErr(r.error, 'send it');
      else { S.fbMsg = 'Thanks! Your message was sent.'; form.reset(); }
      render();
    } else if (kind === 'create-house') {
      S.joinErr = ''; S.busy = true; render();
      const units = String(val('units') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
      const r = await sb.rpc('create_household', { p_name: val('name'), p_address: val('address') || null, p_units: units });
      S.busy = false;
      if (!r.error) { try { localStorage.setItem('ds-house', r.data); } catch (_) {} }
      if (r.error) { S.joinErr = r.error.message; render(); return; }
      S.tab = 'summary'; await loadAll(); toast('Your property is ready. Add your first bill or tenant.');
    } else if (kind === 'join') {
      S.joinErr = ''; S.busy = true; render();
      const r = await sb.rpc('join_household', { code: val('code') });
      S.busy = false;
      if (r.error) { S.joinErr = r.error.message; render(); return; }
      await loadAll();
    } else if (kind === 'bill') {
      const isNew = S.sheet.type === 'new-bill';
      const b = isNew ? { id: uuid(), household_id: S.household.id, active: true, created_at: new Date().toISOString() } : findBill(S.sheet.id);
      const name = val('name');
      if (!name) return fail('Give the bill a name.');
      const fixed = !!fd.get('fixed');
      const nb = Object.assign({}, b, {
        name, label: val('label') || null, account_number: val('account_number') || null, category: val('category') || 'Other',
        unit_id: val('unit_id') || null, due_day: intv('due_day', 1, 31), default_amount: num(val('default_amount')),
        amount_type: fixed ? 'fixed' : 'variable', autopay: !!fd.get('autopay'), pay_url: val('pay_url') || null, notes: val('notes') || null,
        loan_balance: fd.has('loan_balance') ? num(val('loan_balance')) : (b.loan_balance ?? null), loan_rate: fd.has('loan_rate') ? (parseFloat(val('loan_rate')) || null) : (b.loan_rate ?? null), home_value: fd.has('home_value') ? num(val('home_value')) : (b.home_value ?? null),
        escrow: !!fd.get('escrow'), due_months: (() => { const ms = fd.getAll('due_m').map(Number).filter((n) => n >= 1 && n <= 12); return ms.length ? ms : null; })()
      });
      saveBill(nb);
      const scanned = S.scan; S.scan = null;
      if (isNew && scanned && num(val('p_amount')) != null) savePayment(nb, S.month, { amount: num(val('p_amount')) });
      if (scanned && scanned.file) uploadTo('bills', scanned.file).then((path) => { if (path) { savePayment(nb, S.month, { receipt_path: path }); renderSoon(); } });
      if (!isNew) {
        const paidOn = val('p_paid'); const pay = getPay(nb, S.month);
        let paidAt = null;
        if (paidOn) paidAt = pay && pay.paid_at && isoDate(new Date(pay.paid_at)) === paidOn ? pay.paid_at : new Date(paidOn + 'T12:00:00').toISOString();
        const extra = nb.category === 'Mortgage' ? { principal: num(val('p_principal')), interest: num(val('p_interest')), escrow_part: num(val('p_escrow')), balance_after: num(val('p_balance')) } : {};
        savePayment(nb, S.month, Object.assign({ amount: num(val('p_amount')), paid_at: paidAt, method: val('p_method') || null, confirmation: val('p_confirmation') || null, note: val('p_note') || null }, extra));
        if (extra.balance_after != null) { nb.loan_balance = extra.balance_after; saveBill(nb); }
      }
      S.sheet = null; if (isNew) { S.tab = isPersonal(nb.unit_id) ? 'personal' : 'bills'; } render(); toast(isNew ? (isPersonal(nb.unit_id) ? 'Added to Personal' : 'Bill added') : 'Saved');
    } else if (kind === 'rental') {
      const isNew = S.sheet.type === 'new-rental';
      const r = isNew ? { id: uuid(), household_id: S.household.id, active: true, created_at: new Date().toISOString() } : S.rentals.find((x) => x.id === S.sheet.id);
      const nr = Object.assign({}, r, {
        tenant_name: val('tenant_name') || null, unit_id: val('unit_id') || null, phone: val('phone') || null, email: val('email') || null,
        rent_amount: num(val('rent_amount')), due_day: intv('due_day', 1, 31) || 1, grace_days: intv('grace_days', 0, 31) ?? 0,
        late_fee: num(val('late_fee')), deposit: num(val('deposit')), payer_names: val('payer_names') || null, deposit_received_on: val('deposit_received_on') || null, deposit_held_at: val('deposit_held_at') || null, lease_start: val('lease_start') || null, lease_end: val('lease_end') || null, notes: val('notes') || null
      });
      saveRental(nr);
      if (!isNew) {
        const rp = getRentPay(nr, S.month);
        const got = num(val('rp_got')); const on = val('rp_date');
        let at = null;
        if (got != null && got > 0) at = on ? (rp && rp.received_at && isoDate(new Date(rp.received_at)) === on ? rp.received_at : new Date(on + 'T12:00:00').toISOString()) : ((rp && rp.received_at) || new Date().toISOString());
        saveRentPay(nr, S.month, { amount_due: num(val('rp_due')) ?? nr.rent_amount, amount_received: got, received_at: at, method: val('rp_method') || null, note: val('rp_note') || null });
      }
      S.sheet = null; render(); toast(isNew ? 'Tenant added' : 'Saved');
    } else if (kind === 'task') {
      const isNew = S.sheet.type === 'new-task';
      const t = isNew ? { id: uuid(), household_id: S.household.id, active: true, created_at: new Date().toISOString() } : S.tasks.find((x) => x.id === S.sheet.id);
      const title = val('title');
      if (!title) return fail('Name the task.');
      const iv = parseInt(val('interval_months'), 10) || null;
      saveTask(Object.assign({}, t, { title, category: val('category') || 'Other', unit_id: val('unit_id') || null, interval_months: iv, next_due: val('next_due') || null, vendor: val('vendor') || null, notes: val('notes') || null, active: true }));
      S.sheet = null; render(); toast(isNew ? 'Task added' : 'Saved');
    } else if (kind === 'task-done') {
      const t = S.tasks.find((x) => x.id === S.sheet.id);
      const on = val('done_on');
      if (!on) return fail('Pick the date it was done.');
      const logId = uuid(); const before = Object.assign({}, t);
      const logRow = { id: logId, household_id: S.household.id, task_id: t.id, unit_id: t.unit_id, title: t.title, done_on: on, cost: num(val('cost')), vendor: val('vendor') || null, notes: val('notes') || null, receipt_path: null, created_at: new Date().toISOString() };
      saveLog(logRow);
      const dr = S.doneReceipt && S.doneReceipt.id === t.id ? S.doneReceipt : null; S.doneReceipt = null;
      if (dr && dr.file) uploadTo('receipts', dr.file).then((path) => { if (path && S.logs.some((l) => l.id === logId)) { saveLog(Object.assign({}, logRow, { receipt_path: path })); renderSoon(); } });
      const nt = Object.assign({}, t, { last_done: on, vendor: val('vendor') || t.vendor });
      if (t.interval_months) nt.next_due = addMonthsIso(on, t.interval_months); else { nt.next_due = null; nt.active = false; }
      saveTask(nt);
      S.sheet = null; render(); feedback(); toast(t.interval_months ? 'Done — next one ' + fmtDate(fromIso(nt.next_due)) : 'Done', () => { deleteRow('logs', logId); saveTask(before); });
    } else if (kind === 'log') {
      const isNew = S.sheet.type === 'new-log';
      const l = isNew ? { id: uuid(), household_id: S.household.id, task_id: null, receipt_path: null, created_at: new Date().toISOString() } : S.logs.find((x) => x.id === S.sheet.id);
      const title = val('title');
      if (!title) return fail('Say what was done.');
      if (!val('done_on')) return fail('Pick a date.');
      const saved = Object.assign({}, l, { title, done_on: val('done_on'), unit_id: val('unit_id') || null, cost: num(val('cost')), vendor: val('vendor') || null, notes: val('notes') || null });
      saveLog(saved);
      const rd = isNew ? S.receiptDraft : null; S.receiptDraft = null;
      if (rd && rd.file) uploadTo('receipts', rd.file).then((path) => { if (path) { saveLog(Object.assign({}, saved, { receipt_path: path })); renderSoon(); } });
      S.sheet = null; if (isNew) S.upkeepView = 'history'; render(); toast('Saved');
    } else if (kind === 'renew') {
      const r = S.rentals.find((x) => x.id === S.sheet.id);
      if (!val('start') || !val('end')) return fail('Pick the new lease dates.');
      if (r.lease_start || r.lease_end) saveRow('leases', { id: uuid(), household_id: S.household.id, rental_id: r.id, tenant_name: r.tenant_name, lease_start: r.lease_start, lease_end: r.lease_end, rent_amount: r.rent_amount, notes: val('notes') || null, created_at: new Date().toISOString() });
      saveRental(Object.assign({}, r, { lease_start: val('start'), lease_end: val('end'), rent_amount: num(val('rent')) ?? r.rent_amount }));
      S.sheet = null; render(); toast('Lease renewed to ' + fmtDate(fromIso(val('end'))));
    } else if (kind === 'moveout') {
      const r = S.rentals.find((x) => x.id === S.sheet.id);
      saveRental(Object.assign({}, r, { move_out_on: val('move_out_on') || null, deposit_returned_amount: num(val('deposit_returned_amount')), deposit_returned_on: val('deposit_returned_on') || null, deposit_deductions: val('deposit_deductions') || null, active: fd.get('archive') ? false : r.active }));
      S.sheet = null; render(); toast('Saved');
    } else if (kind === 'inspection') {
      const d = S.inspDraft;
      saveRow('inspections', { id: d.id, household_id: S.household.id, rental_id: d.rental_id, unit_id: (S.rentals.find((x) => x.id === d.rental_id) || {}).unit_id || null, kind: d.kind, done_on: d.done_on || isoDate(today()), items: d.items, notes: d.notes || null, created_at: d.created_at || new Date().toISOString() });
      S.inspections.sort((a, b) => (b.done_on || '').localeCompare(a.done_on || ''));
      const rid = d.rental_id; S.inspDraft = null; S.sheet = { type: 'inspections', id: rid }; render(); toast('Inspection saved');
    } else if (kind === 'request') {
      const q = S.requests.find((x) => x.id === S.sheet.id);
      const status = val('status') || q.status;
      saveRow('requests', Object.assign({}, q, { status, reply: val('reply') || null, updated_at: new Date().toISOString() }));
      if (fd.get('log') && (status === 'done' || status === 'closed')) {
        S.sheet = { type: 'new-log' }; S.upkeepView = 'history'; render();
        const t = document.getElementById('l-title'); if (t) t.value = q.title; const u = document.getElementById('l-unit'); if (u && q.unit_id) u.value = q.unit_id;
        toast('Request updated. Add the cost to finish.');
      } else { S.sheet = null; render(); toast('Request updated'); }
    } else if (kind === 'rental-pct') {
      const v = parseInt(val('pct'), 10);
      if (!(v >= 0 && v <= 100)) return toast('Enter 0–100.');
      S.household.rental_pct = v;
      queue({ kind: 'update', table: 'households', row: { rental_pct: v }, match: { id: S.household.id } });
      render(); toast('Saved');
    } else if (kind === 'quick') {
      const text = val('text');
      if (!text) return;
      S.quick = { text, busy: true }; render();
      try { const j = await assist({ mode: 'parse', text, context: quickContext() }); S.quick = { text, actions: j.actions || [], note: j.note || null }; }
      catch (e) { S.quick = { text, error: e.message }; }
      render();
    } else if (kind === 'partial') {
      const r = S.rentals.find((x) => x.id === form.dataset.id); if (!r) return;
      const amt = num(val('amt')); if (!(amt > 0)) { toast('Enter the amount you got'); return; }
      const k = S.month; const rp = getRentPay(r, k); const due = rentDue(r, rp);
      const prevR = { amount_received: rp ? rp.amount_received : null, received_at: rp ? rp.received_at : null, method: rp ? rp.method || null : null };
      saveRentPay(r, k, { amount_due: due, amount_received: Math.round((Number((rp && rp.amount_received) || 0) + amt) * 100) / 100, received_at: new Date().toISOString(), method: (rp && rp.method) || lastRentMethod(r) });
      S.partial = null; render(); feedback(); toast('Got ' + money(amt) + ' from ' + rentalTitle(r), () => saveRentPay(r, k, prevR));
    } else if (kind === 'ask') {
      const q = val('q'); if (!q || S.askBusy) return;
      form.reset(); askQuestion(q);
    } else if (kind === 'appliance') {
      const isNew = S.sheet.type === 'new-appliance';
      const a = isNew ? { id: uuid(), household_id: S.household.id, created_at: new Date().toISOString() } : S.appliances.find((x) => x.id === S.sheet.id);
      const kindv = val('kind') || 'Other';
      const name = val('name') || kindv;
      saveRow('appliances', Object.assign({}, a, { kind: kindv, name, unit_id: val('unit_id') || null, brand: val('brand') || null, model: val('model') || null, serial: val('serial') || null,
        installed_on: val('installed_on') || null, warranty_until: val('warranty_until') || null, life_years: intv('life_years', 1, 100) || APPLIANCE_LIFE[kindv] || null, notes: val('notes') || null }));
      S.sheet = null; render(); toast(isNew ? 'Appliance added' : 'Saved');
    } else if (kind === 'contractor') {
      const isNew = S.sheet.type === 'new-contractor';
      const c = isNew ? { id: uuid(), household_id: S.household.id, created_at: new Date().toISOString() } : S.contractors.find((x) => x.id === S.sheet.id);
      const name = val('name');
      if (!name) return fail('Add a name.');
      saveRow('contractors', Object.assign({}, c, { name, trade: val('trade') || null, phone: val('phone') || null, email: val('email') || null, notes: val('notes') || null }));
      S.contractors.sort((a, b) => a.name.localeCompare(b.name));
      S.sheet = null; render(); toast(isNew ? 'Contractor added' : 'Saved');
    } else if (kind === 'doc') {
      const isNew = S.sheet.type === 'new-doc';
      const d = isNew ? { id: uuid(), household_id: S.household.id, created_at: new Date().toISOString() } : S.documents.find((x) => x.id === S.sheet.id);
      const title = val('title');
      if (!title) return fail('Give it a title.');
      const file = fd.get('file');
      let path = d.file_path || null, type = d.file_type || null;
      if (file && file.size) {
        const np = await uploadTo('docs', file);
        if (!np) return;
        if (path) sb.storage.from('receipts').remove([path]);
        path = np; type = file.type || null;
      } else if (isNew) return fail('Choose a photo or PDF.');
      saveRow('documents', Object.assign({}, d, { title, category: val('category') || 'Other', unit_id: val('unit_id') || null, expires_on: val('expires_on') || null, notes: val('notes') || null, file_path: path, file_type: type }));
      S.documents.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      S.sheet = null; render(); toast(isNew ? 'Document saved' : 'Saved');
    } else if (kind === 'password') {
      const p1 = String(fd.get('p1') || ''), p2 = String(fd.get('p2') || '');
      if (p1.length < 8) return toast('Use at least 8 characters.');
      if (p1 !== p2) return toast('The two passwords don’t match.');
      const r = await sb.auth.updateUser({ password: p1 });
      if (r.error) return toast('Couldn’t change it: ' + r.error.message);
      form.reset(); render(); toast('Password changed.');
    } else if (kind === 'house') {
      const fields = { name: val('name') || 'My house', address: val('address') || null, pay_zelle: val('pay_zelle') || null, pay_note: val('pay_note') || null };
      Object.assign(S.household, fields);
      queue({ kind: 'update', table: 'households', row: fields, match: { id: S.household.id } });
      render(); toast('House details saved');
    }
  }

  // ---------- receipts ----------
  async function uploadReceipt(file) {
    if (!file) return;
    if (!navigator.onLine) return toast('Connect to the internet to add a photo.');
    if (file.size > 10 * 1024 * 1024) return toast('That file is over 10 MB.');
    const b = findBill(S.sheet.id);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = S.household.id + '/' + b.id + '/' + S.month.slice(0, 7) + '-' + Date.now() + '.' + ext;
    toast('Uploading…');
    const r = await sb.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (r.error) return toast('Upload failed: ' + r.error.message);
    savePayment(b, S.month, { receipt_path: path });
    render(); toast('Photo saved');
  }
  async function viewReceipt() {
    const b = findBill(S.sheet.id); const pay = getPay(b, S.month);
    if (!pay || !pay.receipt_path) return;
    const r = await sb.storage.from('receipts').createSignedUrl(pay.receipt_path, 600);
    if (r.error) return toast(r.error.message);
    const slot = document.getElementById('receipt-slot');
    if (/\.pdf$/i.test(pay.receipt_path)) window.open(r.data.signedUrl, '_blank', 'noopener');
    else if (slot) slot.innerHTML = `<img class="receipt" src="${esc(r.data.signedUrl)}" alt="Bill photo for ${esc(billTitle(b))}">`;
  }

  // ---------- push ----------
  function b64ToBytes(s) {
    const p = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function checkPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { S.pushState = 'unsupported'; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      S.pushState = sub ? 'on' : 'off';
      if (sub) saveSub(sub);
      renderSoon();
    } catch (_) {}
  }
  async function saveSub(sub) {
    const j = sub.toJSON();
    await sb.from('push_subscriptions').upsert({ user_id: S.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  }
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications weren’t allowed'); render(); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
      await saveSub(sub);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && S.member && S.member.timezone !== tz) {
        S.member.timezone = tz;
        queue({ kind: 'update', table: 'household_members', row: { timezone: tz }, match: { household_id: S.member.household_id, user_id: S.user.id } });
      }
      S.pushState = 'on'; render(); toast('Reminders are on');
    } catch (e) { toast('Couldn’t turn on reminders: ' + e.message); }
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
    S.pushState = 'off'; render(); toast('Reminders turned off on this device');
  }
  async function testPush() {
    const { data } = await sb.auth.getSession();
    try {
      const res = await fetch(CFG.SUPABASE_URL + '/functions/v1/send-reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: CFG.SUPABASE_ANON_KEY }, body: '{}'
      });
      const j = await res.json();
      toast(j.sent ? 'Test sent — check your notifications' : 'No device got it. Try turning reminders off and on.');
    } catch (e) { toast('Couldn’t send a test: ' + e.message); }
  }

  // ---------- export ----------
  function download(name, text, type) {
    const blob = text instanceof Blob ? text : new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadICS() {
    const t = today(); const remind = (S.member && S.member.remind_days) || 0; const hour = S.member && S.member.remind_hour != null ? S.member.remind_hour : 9;
    const hrs = remind * 24 - hour; const trigger = hrs > 0 ? '-PT' + hrs + 'H' : 'PT' + (-hrs) + 'H';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const fold = (s) => s.replace(/[\\,;]/g, (c) => '\\' + c);
    const ymd = (d) => isoDate(d).replace(/-/g, '');
    const nextOn = (day) => {
      let d = new Date(t.getFullYear(), t.getMonth(), Math.min(day, daysIn(t.getFullYear(), t.getMonth() + 1)));
      if (d < t) d = new Date(t.getFullYear(), t.getMonth() + 1, Math.min(day, daysIn(t.getFullYear(), t.getMonth() + 2)));
      return d;
    };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Doorstep//House//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:House'];
    const ev = (uid, d, summary, desc, rrule) => {
      lines.push('BEGIN:VEVENT', 'UID:' + uid + '@evergreen-house', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(d), 'DTEND;VALUE=DATE:' + ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)));
      if (rrule) lines.push(rrule);
      lines.push('SUMMARY:' + fold(summary), 'DESCRIPTION:' + fold(desc), 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + fold(summary), 'TRIGGER:' + trigger, 'END:VALARM', 'END:VEVENT');
    };
    const monthly = (day) => 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (day === 31 ? '-1' : day);
    let n = 0;
    S.bills.filter((b) => b.active !== false && b.due_day && !b.escrow).forEach((b) => {
      const amt = b.amount_type === 'fixed' && b.default_amount != null ? ' (' + money(b.default_amount) + ')' : '';
      const desc = unitName(b.unit_id) + (b.account_number ? ' · Account ' + b.account_number : '') + (b.pay_url ? ' · ' + b.pay_url : '');
      if (b.due_months && b.due_months.length) {
        let d = null;
        for (let i = 0; i < 24 && !d; i++) { const k = addMonths(monthKey(t), i); if (dueInMonth(b, k)) { const c = dueOn(b.due_day, k); if (c >= t) d = c; } }
        if (d) { ev(b.id, d, 'Pay ' + billTitle(b) + amt, desc, 'RRULE:FREQ=MONTHLY;BYMONTH=' + b.due_months.join(',') + ';BYMONTHDAY=' + Math.min(b.due_day, 28)); n++; }
      } else { ev(b.id, nextOn(b.due_day), 'Pay ' + billTitle(b) + amt, desc, monthly(b.due_day)); n++; }
    });
    S.documents.filter((x) => x.expires_on).forEach((x) => { ev('doc-' + x.id, fromIso(x.expires_on), 'Expires: ' + x.title, x.category, null); n++; });
    S.rentals.filter((r) => r.active !== false && r.rent_amount).forEach((r) => {
      ev(r.id, nextOn(r.due_day), 'Rent due: ' + rentalTitle(r) + ' (' + money(r.rent_amount) + ')', unitName(r.unit_id), monthly(r.due_day)); n++;
    });
    S.tasks.filter((x) => x.active !== false && x.next_due).forEach((x) => {
      ev(x.id + '-' + x.next_due, fromIso(x.next_due), 'Upkeep: ' + x.title, unitName(x.unit_id) + (x.vendor ? ' · ' + x.vendor : ''), null); n++;
    });
    if (!n) return toast('Add due days or upkeep dates first.');
    lines.push('END:VCALENDAR');
    download('house-calendar.ics', lines.join('\r\n'), 'text/calendar');
  }
  function downloadCSV() {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Type', 'Month / date', 'Item', 'Place', 'Category', 'Account', 'Amount', 'Due', 'Paid / received on', 'Method', 'Confirmation / vendor', 'Note']];
    Object.values(S.payments).sort((a, b) => a.period.localeCompare(b.period)).forEach((p) => {
      const b = S.bills.find((x) => x.id === p.bill_id); if (!b) return;
      rows.push(['Bill', p.period.slice(0, 7), billTitle(b), unitName(b.unit_id), b.category, b.account_number, amountFor(b, p), p.due_date, p.paid_at ? isoDate(new Date(p.paid_at)) : '', p.method, p.confirmation, p.note]);
    });
    Object.values(S.rentPays).sort((a, b) => a.period.localeCompare(b.period)).forEach((p) => {
      const r = S.rentals.find((x) => x.id === p.rental_id); if (!r) return;
      rows.push(['Rent', p.period.slice(0, 7), rentalTitle(r), unitName(r.unit_id), 'Rent income', '', p.amount_received, p.amount_due, p.received_at ? isoDate(new Date(p.received_at)) : '', p.method, '', p.note]);
    });
    S.logs.slice().reverse().forEach((l) => rows.push(['Upkeep', l.done_on, l.title, unitName(l.unit_id), 'Upkeep', '', l.cost, '', l.done_on, '', l.vendor, l.notes]));
    download('house-history-' + isoDate(new Date()) + '.csv', rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'A') return;
    if (el.dataset.act === 'sheet-close-bg' && e.target !== el) return; // taps inside the sheet
    e.preventDefault(); onAct(el);
  });
  document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.change) onChange(e.target); });
  document.addEventListener('toggle', (e) => {
    const d = e.target; if (!d || !d.dataset || !d.dataset.fold) return;
    S.fold[d.dataset.fold] = d.open; try { localStorage.setItem('ds-fold', JSON.stringify(S.fold)); } catch (_) {}
  }, true);
  document.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.input === 'docq') { S.docQuery = e.target.value; render(); } });
  document.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.tour != null) { endTour(); return; }
    if (e.key === 'Escape' && S.story) { S.story = null; render(); return; }
    if (S.story && e.key === 'ArrowRight') { storyGo(S.story.i + 1); return; }
    if (S.story && e.key === 'ArrowLeft') { storyGo(S.story.i - 1); return; }
    if (e.key === 'Escape' && S.sheet) { S.sheet = null; render(); }
    if (e.key === 'Enter' && e.target.dataset && (e.target.dataset.change === 'amount' || e.target.dataset.change === 'due')) { e.preventDefault(); e.target.blur(); }
  });
  window.addEventListener('online', () => { S.online = true; flush().then(loadAll); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; renderSoon(); });
  // Summary is home: coming back after 10+ minutes away (with nothing open) lands on Summary
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (S.view === 'app' && hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 && !S.sheet && !S.story && S.tour == null && S.tab !== 'summary') {
      const busy = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (!busy) { S.tab = 'summary'; S.month = monthKey(new Date()); window.scrollTo(0, 0); render(); }
    }
    if (document.visibilityState === 'visible' && S.view === 'app' && navigator.onLine && !S.sheet && !S.story) loadAll();
  });

  // Swipe cards right (paid) / left (details); swipe the month header to change month
  let suppressClick = 0;
  document.addEventListener('scroll', (e) => {
    const c = e.target; if (!c || !c.dataset || !c.dataset.herocar) return;
    const i = Math.round(c.scrollLeft / Math.max(1, c.clientWidth)); if (i === S.heroSlide) return;
    S.heroSlide = i; document.querySelectorAll('.hc-dots button').forEach((d, k) => d.setAttribute('aria-pressed', k === i));
  }, true);
  // Weekly story: move to the next slide when its progress bar fills
  document.addEventListener('animationend', (e) => { if (S.story && e.target.matches && e.target.matches('.sbar i.on')) storyGo(S.story.i + 1); });
  // Bill detail: drag the knob across to mark paid (a tap works too)
  (function slidePay() {
    let tr = null, kn = null, x0 = 0, max = 0, dx = 0, moved = false;
    document.addEventListener('pointerdown', (e) => {
      const t = e.target.closest && e.target.closest('.slidepay'); if (!t || t.classList.contains('on')) return;
      tr = t; kn = t.querySelector('.sp-knob'); x0 = e.clientX; max = t.clientWidth - kn.offsetWidth - 12; dx = 0; moved = false; kn.style.transition = 'none';
    });
    document.addEventListener('pointermove', (e) => { if (!tr) return; dx = Math.max(0, Math.min(max, e.clientX - x0)); if (dx > 6) moved = true; kn.style.transform = 'translateX(' + dx + 'px)'; });
    const end = () => {
      if (!tr) return; const t = tr; tr = null; kn.style.transition = '';
      if (!moved) { kn.style.transform = ''; return; }
      suppressClick = Date.now() + 400; // the drag decides, not the click that follows it
      if (dx > max * 0.65) { kn.style.transform = 'translateX(' + max + 'px)'; setTimeout(() => onAct(t), 120); } else kn.style.transform = '';
    };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  })();
  (function swipes() {
    let el = null, x0 = 0, y0 = 0, dx = 0, mode = null;
    document.addEventListener('pointerdown', (e) => {
      if (S.view !== 'app' || S.sheet || e.button > 0) return;
      if (e.target.closest('input,textarea,select,a,label')) return;
      el = e.target.closest('.swipe, [data-swipe-month]'); if (!el) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; mode = null;
    });
    document.addEventListener('pointermove', (e) => {
      if (!el) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!mode) { if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.3) mode = 'h'; else if (Math.abs(my) > 10) { el = null; return; } else return; }
      dx = Math.max(-150, Math.min(150, mx));
      el.style.transition = 'none'; el.style.transform = 'translateX(' + dx + 'px)';
      if (el.classList.contains('swipe')) {
        el.classList.toggle('sw-right', dx > 20 && !!el.dataset.swipeRight); el.classList.toggle('sw-left', dx < -20);
        el.classList.toggle('sw-armed', Math.abs(dx) > 90);
      }
    });
    const end = () => {
      if (!el) return;
      const t = el; el = null;
      t.style.transition = ''; t.style.transform = '';
      t.classList.remove('sw-right', 'sw-left', 'sw-armed');
      if (mode !== 'h') return;
      suppressClick = Date.now() + 400;
      if (t.dataset.swipeMonth) { if (Math.abs(dx) > 60) { S.month = addMonths(S.month, dx < 0 ? 1 : -1); S.editing = null; render(); } return; }
      if (dx > 90 && t.dataset.swipeRight) onAct({ dataset: { act: t.dataset.swipeRight, id: t.dataset.id } });
      else if (dx < -90 && t.dataset.swipeLeft) onAct({ dataset: { act: t.dataset.swipeLeft, id: t.dataset.id } });
    };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  })();
  // Drag a sheet down by its handle/header to close it
  (function sheetDrag() {
    let y0 = null, sheet = null, dy = 0;
    document.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.grabber, .sheet-head'); if (!h || e.target.closest('button')) return;
      sheet = h.closest('.sheet'); if (!sheet) return;
      y0 = e.clientY; dy = 0; sheet.style.transition = 'none';
    });
    document.addEventListener('pointermove', (e) => { if (y0 == null || !sheet) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = 'translateY(' + dy + 'px)'; });
    const end = () => {
      if (y0 == null || !sheet) return;
      sheet.style.transition = ''; y0 = null;
      if (dy > 110) { sheet.style.transform = 'translateY(110%)'; setTimeout(() => { S.sheet = null; S.scan = null; render(); }, 180); }
      else sheet.style.transform = '';
      sheet = null;
    };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  })();
  // Pull down at the top of a tab to refresh
  (function pullToRefresh() {
    let y0 = null, pull = 0, ind = null;
    document.addEventListener('touchstart', (e) => {
      if (S.view !== 'app' || S.sheet || window.scrollY > 0 || e.target.closest('input,textarea,select,.tabbar')) return;
      y0 = e.touches[0].clientY; pull = 0;
      ind = document.getElementById('ptr');
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (y0 == null || !ind) return;
      pull = Math.max(0, Math.min(110, (e.touches[0].clientY - y0) * 0.5));
      ind.style.transform = 'translate(-50%,' + (pull - 50) + 'px)'; ind.style.opacity = Math.min(1, pull / 60);
      ind.classList.toggle('ready', pull > 64);
    }, { passive: true });
    document.addEventListener('touchend', async () => {
      if (y0 == null || !ind) return;
      y0 = null;
      if (pull > 64 && navigator.onLine) {
        ind.classList.add('spinning'); ind.style.transform = 'translate(-50%,16px)';
        await loadAll();
        toast('Up to date');
      }
      ind.classList.remove('spinning', 'ready'); ind.style.transform = 'translate(-50%,-50px)'; ind.style.opacity = 0; pull = 0;
    });
  })();

  // ---------- error reports (a few per visit, to the app_errors table) ----------
  (function errorReports() {
    let sent = 0; const seen = new Set();
    function report(message, stack, file) {
      if (sent >= 5 || !message || seen.has(message)) return;
      if (file && !String(file).startsWith(location.origin)) return; // extensions and other sites
      if (/ResizeObserver|Script error\.?$|NetworkError|Failed to fetch|Load failed/i.test(message)) return;
      seen.add(message); sent++;
      try { sb.rpc('log_client_error', { p_message: String(message), p_stack: stack ? String(stack) : null, p_url: location.pathname + location.hash + ' · ' + (S.view || '') + '/' + (S.tab || ''), p_agent: navigator.userAgent }).then(() => {}, () => {}); } catch (_) {}
    }
    window.addEventListener('error', (e) => report(e.message, e.error && e.error.stack, e.filename));
    window.addEventListener('unhandledrejection', (e) => { const r = e.reason || {}; report(r.message || String(r), r.stack, null); });
  })();

  // ---------- appearance (per device) ----------
  function getDensity() { try { return localStorage.getItem('ds-density') === 'detailed' ? 'detailed' : 'simple'; } catch (_) { return 'simple'; } }
  function simple() { return getDensity() === 'simple'; }
  function getTextSize() { try { return localStorage.getItem('ds-text') || '1'; } catch (_) { return '1'; } }
  function applyTextSize(v) { if (v === '1') document.documentElement.removeAttribute('data-text'); else document.documentElement.setAttribute('data-text', v); }
  function getTheme() { try { return localStorage.getItem('ds-theme') || 'auto'; } catch (_) { return 'auto'; } }
  function applyTheme(t) {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', dark ? '#0F1A16' : '#F6F3EC');
  }
  applyTheme(getTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getTheme()));

  // ---------- boot ----------
  // Updates: check for a new version on every open, and switch to it as soon as it's installed
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch((e) => console.warn('SW', e));
    let reloading = false;
    const reloadNow = () => { if (reloading) return; reloading = true; window.location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install, nothing old on screen
      const busy = S.sheet || S.story || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
      if (!busy) return reloadNow();
      S.updateReady = true; renderSoon();
    });
  }
  S.pending = readOutbox().length;

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { S.user = session.user; S.view = 'recovery'; render(); return; }
    if (event === 'SIGNED_IN' && session && (!S.user || S.user.id !== session.user.id)) { S.user = session.user; S.view = 'loading'; render(); loadAll(); }
    if (event === 'SIGNED_OUT') { S.user = null; S.view = 'auth'; render(); }
  });

  sb.auth.getSession().then(({ data }) => {
    if (S.view === 'recovery') return;
    if (data.session) { if (!S.user) { S.user = data.session.user; loadAll(); } }
    else { S.view = 'auth'; render(); }
  });
})();
