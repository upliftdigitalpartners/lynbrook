/* Evergreen House — rent, bills & upkeep PWA */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const CATEGORIES = ['Mortgage', 'Electric', 'Gas', 'Water', 'Internet & phone', 'Insurance', 'Property tax', 'Trash', 'Other'];
  const UPKEEP_CATS = ['Heating & cooling', 'Plumbing', 'Electrical', 'Safety', 'Exterior', 'Appliances', 'Yard', 'Cleaning', 'Pest control', 'Other'];
  const METHODS = ['Online', 'Autopay', 'Bank transfer', 'Zelle', 'Check', 'Card', 'Cash', 'Other'];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // ---------- state ----------
  const S = {
    view: 'loading', // loading | auth | recovery | join | app
    authErr: '', joinErr: '',
    user: null, household: null, member: null, units: [], bills: [], payments: {},
    rentals: [], rentPays: {}, tasks: [], logs: [], imports: [],
    tab: 'bills', month: monthKey(new Date()), unit: 'all', filter: 'all', upkeepView: 'upcoming',
    editing: null, sheet: null, sheetErr: '', deleteArm: false,
    online: navigator.onLine, pending: 0, pushState: 'unknown', installEvt: null, busy: false
  };

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
  function isFloor(name) { return /floor/i.test(name); }
  function wholeId() { return (S.units.find((u) => !isFloor(u.name)) || {}).id || null; }
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

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const sv = (d, w) => `<svg width="${w || 22}" height="${w || 22}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    left: sv('<path d="M15 6l-6 6 6 6"/>'),
    right: sv('<path d="M9 6l6 6-6 6"/>'),
    close: sv('<path d="M6 6l12 12M18 6L6 18"/>'),
    plus: sv('<path d="M12 5v14M5 12h14"/>', 24),
    copy: sv('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 14),
    ext: sv('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', 16),
    bills: sv('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    rent: sv('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
    upkeep: sv('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
    summary: sv('<path d="M5 20V11M12 20V5M19 20v-6"/>'),
    settings: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')
  };

  // ---------- local cache + offline outbox ----------
  const cacheKey = () => 'eh-cache-' + (S.user ? S.user.id : 'anon');
  const OUTBOX = 'eh-outbox';
  const CACHED = ['household', 'member', 'units', 'bills', 'payments', 'rentals', 'rentPays', 'tasks', 'logs', 'imports'];
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
    if (cached && cached.household) { Object.assign(S, cached); S.rentals = S.rentals || []; S.rentPays = S.rentPays || {}; S.tasks = S.tasks || []; S.logs = S.logs || []; S.view = 'app'; render(); }
    await flush();
    if (readOutbox().length) return; // still offline; keep local copy
    try {
      const mem = await sb.from('household_members').select('*, households(*)').eq('user_id', S.user.id).limit(1);
      if (mem.error) throw mem.error;
      if (!mem.data.length) { S.view = 'join'; render(); return; }
      const m = mem.data[0];
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
        sb.from('email_imports').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(40)
      ]);
      res.forEach((r) => { if (r.error) throw r.error; });
      const [u, b, p, r, rp, t, l, im] = res.map((x) => x.data);
      S.household = m.households; delete m.households; S.member = m;
      S.units = u; S.bills = b; S.rentals = r; S.tasks = t; S.logs = l; S.imports = im;
      S.payments = {}; p.forEach((x) => { S.payments[payKey(x.bill_id, x.period)] = x; });
      S.rentPays = {}; rp.forEach((x) => { S.rentPays[payKey(x.rental_id, x.period)] = x; });
      saveCache();
      S.view = 'app';
      render();
      checkPush();
    } catch (e) {
      if (!cached) { S.view = 'app'; render(); }
      toast(isNetErr(e) ? 'Offline — showing saved copy' : 'Couldn’t load: ' + e.message);
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
  function saveTask(t) { upsertLocal(S.tasks, t); queue({ kind: 'upsert', table: 'maintenance_tasks', row: t }); }
  function deleteTask(id) { S.tasks = S.tasks.filter((x) => x.id !== id); queue({ kind: 'delete', table: 'maintenance_tasks', id: id }); }
  function saveLog(l) { upsertLocal(S.logs, l); S.logs.sort((a, b) => (b.done_on || '').localeCompare(a.done_on || '')); queue({ kind: 'upsert', table: 'maintenance_log', row: l }); }
  function deleteLog(id) { S.logs = S.logs.filter((x) => x.id !== id); queue({ kind: 'delete', table: 'maintenance_log', id: id }); }

  // ---------- derived ----------
  function statusFor(b, pay, period) {
    const amt = amountFor(b, pay);
    const due = dueOn(b.due_day, period);
    if (pay && pay.paid_at) return { k: 'paid', label: 'Paid ' + fmtDay(new Date(pay.paid_at)) };
    if (!due || amt == null) return { k: 'setup', label: 'Needs details' };
    const diff = dayDiff(due);
    if (b.autopay) return { k: 'auto', label: (diff < 0 ? 'Autopay · was due ' : 'Autopay · ') + fmtDay(due) };
    if (diff < 0) return { k: 'late', label: 'Overdue · ' + fmtDay(due) };
    if (diff === 0) return { k: 'late', label: 'Due today' };
    if (diff <= 5) return { k: 'soon', label: 'Due in ' + diff + (diff === 1 ? ' day' : ' days') };
    return { k: 'up', label: 'Due ' + fmtDay(due) };
  }
  function unitMatch(unitId) {
    if (S.unit === 'all') return true;
    const n = unitName(unitId);
    if (S.unit === 'shared') return !isFloor(n);
    return unitId === S.unit;
  }
  function billMonth(period, all) {
    const bills = S.bills.filter((b) => b.active !== false).filter((b) => all || unitMatch(b.unit_id));
    let total = 0, paid = 0, overdue = 0, overdueAmt = 0, setup = 0;
    const rows = bills.map((b) => {
      const pay = getPay(b, period);
      const st = statusFor(b, pay, period);
      const amt = amountFor(b, pay);
      total += amt || 0;
      if (pay && pay.paid_at) paid += amt || 0;
      if (st.label.startsWith('Overdue')) { overdue++; overdueAmt += amt || 0; }
      if (st.k === 'setup') setup++;
      return { b, pay, st, amt, due: dueOn(b.due_day, period) };
    });
    rows.sort((a, c) => (a.due ? a.due.getTime() : 9e15) - (c.due ? c.due.getTime() : 9e15));
    return { rows, total, paid, overdue, overdueAmt, setup };
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
  function render() {
    const app = document.getElementById('app');
    const y = window.scrollY;
    const ae = document.activeElement;
    const keep = ae && ae.id && app.contains(ae) ? { id: ae.id, v: ae.value, a: ae.selectionStart, b: ae.selectionEnd } : null;
    const sheetEl = app.querySelector('.sheet'); const sheetScroll = sheetEl ? sheetEl.scrollTop : null;
    if (S.view === 'loading') app.innerHTML = '<div class="splash"><img src="icons/icon-192.png" alt="" width="72" height="72"><p>Loading…</p></div>';
    else if (S.view === 'auth') app.innerHTML = authView();
    else if (S.view === 'recovery') app.innerHTML = recoveryView();
    else if (S.view === 'join') app.innerHTML = joinView();
    else app.innerHTML = appView();
    if (S.view === 'app') window.scrollTo(0, y);
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

  function authView() {
    return `<div class="auth"><form class="card" data-form="auth" novalidate>
      <img class="logo" src="icons/icon-192.png" alt="">
      <div><h1 class="display" style="margin:0;font-size:26px">Evergreen House</h1>
      <p class="muted">Enter the house password to open your bills.</p></div>
      <input type="text" name="username" value="${esc(CFG.HOUSE_EMAIL)}" autocomplete="username" class="sr" tabindex="-1" aria-hidden="true" readonly>
      <div class="field"><label for="a-pass">House password</label><input class="input" id="a-pass" name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required></div>
      ${S.authErr ? `<p class="err" role="alert">${esc(S.authErr)}</p>` : ''}
      <button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>Open</button>
      <p class="small muted">You stay signed in on this device. Ask a family member for the password if you don’t have it.</p>
    </form></div>`;
  }
  function recoveryView() {
    return `<div class="auth"><form class="card" data-form="recovery">
      <h1 class="display" style="margin:0;font-size:24px">Set a new password</h1>
      <div class="field"><label for="r-pass">New password</label><input class="input" id="r-pass" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      ${S.authErr ? `<p class="err" role="alert">${esc(S.authErr)}</p>` : ''}
      <button class="btn primary block" type="submit">Save password</button>
    </form></div>`;
  }
  function joinView() {
    return `<div class="auth"><form class="card" data-form="join">
      <img class="logo" src="icons/icon-192.png" alt="">
      <div><h1 class="display" style="margin:0;font-size:24px">Join your house</h1>
      <p class="muted">Enter the house code you were given. You only do this once.</p></div>
      <div class="field"><label for="j-code">House code</label><input class="input code" id="j-code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
      ${S.joinErr ? `<p class="err" role="alert">${esc(S.joinErr)}</p>` : ''}
      <button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>Join</button>
      <button type="button" class="linkbtn" data-act="signout">Sign out</button>
    </form></div>`;
  }

  function appView() {
    const titles = { bills: 'Bills', rent: 'Rent', upkeep: 'Upkeep', summary: 'Summary', settings: 'Settings' };
    const adds = { bills: ['new-bill', 'Add bill'], rent: ['new-rental', 'Add tenant'], upkeep: ['new-task', 'Add upkeep task'] };
    const addr = S.household && S.household.address ? S.household.address.split(',')[0] : (S.household ? S.household.name : '');
    const offline = !S.online || S.pending
      ? `<span class="status-dot">${!S.online ? 'Offline' : 'Syncing'}${S.pending ? ' · ' + S.pending + ' unsaved' : ''}</span>` : '';
    const body = { bills: billsTab, rent: rentTab, upkeep: upkeepTab, summary: summaryTab, settings: settingsTab }[S.tab]();
    const tabs = [['bills', 'Bills'], ['rent', 'Rent'], ['upkeep', 'Upkeep'], ['summary', 'Summary'], ['settings', 'Settings']]
      .map(([id, l]) => `<button class="tab" data-act="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${ICON[id]}<span>${l}</span></button>`).join('');
    const add = adds[S.tab];
    return `<div class="shell">
      <header class="topbar">
        <div class="topbar-row"><span class="eyebrow">${esc(addr)}</span>${offline}</div>
        <div class="topbar-row"><h1 class="display">${esc(titles[S.tab])}</h1>${add ? `<button class="iconbtn addbtn" data-act="${add[0]}" aria-label="${add[1]}">${ICON.plus}</button>` : ''}</div>
      </header>
      <main class="main">${body}</main>
      <nav class="tabbar" aria-label="App sections"><div class="tabbar-inner">${tabs}</div></nav>
      ${S.sheet ? sheetView() : ''}
    </div>`;
  }

  function monthNav() {
    const isCur = S.month === monthKey(new Date());
    return `<div class="row between">
      <div class="monthnav">
        <button class="iconbtn" data-act="month" data-delta="-1" aria-label="Previous month">${ICON.left}</button>
        <strong style="font-size:16px;min-width:140px;text-align:center">${monthLabel(S.month)}</strong>
        <button class="iconbtn" data-act="month" data-delta="1" aria-label="Next month">${ICON.right}</button>
      </div>
      ${isCur ? '' : '<button class="btn" data-act="month-today">This month</button>'}
    </div>`;
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
  function billsTab() {
    const md = billMonth(S.month);
    const pct = md.total > 0 ? Math.round((md.paid / md.total) * 100) : 0;
    const unpaid = md.rows.filter((r) => !(r.pay && r.pay.paid_at)).length;
    const visible = md.rows.filter((r) => S.filter === 'all' ? true : S.filter === 'paid' ? (r.pay && r.pay.paid_at) : !(r.pay && r.pay.paid_at));
    const floors = S.units.filter((u) => isFloor(u.name));
    const unitChips = [['all', 'Everything'], ['shared', 'Shared']].concat(floors.map((u) => [u.id, u.name]))
      .map(([id, l]) => `<button class="chip" data-act="unit" data-unit="${esc(id)}" aria-pressed="${S.unit === id}">${esc(l)}</button>`).join('');
    const filt = [['all', 'All ' + md.rows.length], ['unpaid', 'Unpaid ' + unpaid], ['paid', 'Paid ' + (md.rows.length - unpaid)]]
      .map(([id, l]) => `<button data-act="filter" data-filter="${id}" aria-pressed="${S.filter === id}">${l}</button>`).join('');
    return `${monthNav()}
      ${hero('Bills still to pay', money(md.total - md.paid), pct, money(md.paid) + ' of ' + money(md.total) + ' paid', md.overdue ? md.overdue + ' overdue · ' + money(md.overdueAmt) : 'None overdue', md.overdue)}
      ${md.setup ? `<p class="notice">${md.setup} ${md.setup === 1 ? 'bill needs' : 'bills need'} an amount or due day for ${monthLabel(S.month, true)}. Fill them in on the card.</p>` : ''}
      <div class="chips" role="group" aria-label="Show floor">${unitChips}</div>
      <div class="seg" role="group" aria-label="Filter bills">${filt}</div>
      ${visible.length ? `<ul class="bills">${visible.map(billCard).join('')}</ul>` :
        `<p class="muted" style="text-align:center;padding:28px 0">${S.filter === 'paid' ? 'Nothing paid yet this month.' : S.filter === 'unpaid' ? 'All caught up — every bill is paid.' : 'No bills here yet. Tap + to add one.'}</p>`}`;
  }

  function billCard(r) {
    const b = r.b, paid = !!(r.pay && r.pay.paid_at);
    const complete = r.amt != null && r.due;
    const editing = S.editing === b.id || !complete;
    const unit = unitName(b.unit_id);
    return `<li class="bill ${paid ? 'paid' : ''}">
      <div class="bill-top">
        <button class="check" data-act="toggle" data-id="${b.id}" aria-pressed="${paid}" aria-label="${paid ? 'Mark unpaid' : 'Mark paid'}: ${esc(billTitle(b))}, ${esc(unit)}">${ICON.check}</button>
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(billTitle(b))}</span><span class="tag">${esc(unit)}</span></div>
          ${b.account_number ? `<button class="acct" data-act="copy" data-text="${esc(b.account_number)}" aria-label="Copy account number ${esc(b.account_number)}">${esc(b.category)} · #<span class="num">${esc(b.account_number)}</span> ${ICON.copy}</button>` : `<span class="small muted">${esc(b.category)}</span>`}
          <span class="pill ${r.st.k}">${esc(r.st.label)}</span>
        </div>
      </div>
      ${editing ? `<div class="stack">
          <div class="grid2">
            <div class="field"><label for="d-${b.id}">Due day</label><input class="input num" id="d-${b.id}" type="number" inputmode="numeric" min="1" max="31" placeholder="—" value="${b.due_day || ''}" data-change="due" data-id="${b.id}"></div>
            <div class="field"><label for="a-${b.id}">Amount ($)</label><input class="input num" id="a-${b.id}" type="text" inputmode="decimal" placeholder="0.00" value="${r.amt != null ? r.amt.toFixed(2) : ''}" data-change="amount" data-id="${b.id}"></div>
          </div>
          <div class="btns">
            ${complete ? `<button class="btn" data-act="done" style="flex:1">Done</button>` : ''}
            <button class="btn" data-act="bill" data-id="${b.id}" style="flex:1">Details</button>
          </div>
        </div>` : `<div class="bill-sum">
          <div class="stack" style="gap:0"><span class="amt display num">${money(r.amt)}</span><span class="small muted">${r.due ? 'Due ' + fmtDay(r.due) : ''}${b.autopay ? ' · Autopay' : ''}${r.pay && r.pay.source === 'email' ? ' · from email' : ''}</span></div>
          <div class="btns">
            ${b.pay_url && !paid ? `<a class="btn" href="${esc(b.pay_url)}" target="_blank" rel="noopener">Pay ${ICON.ext}</a>` : ''}
            <button class="btn" data-act="edit" data-id="${b.id}" aria-label="Edit ${esc(billTitle(b))}">Edit</button>
            <button class="btn" data-act="bill" data-id="${b.id}" aria-label="Details for ${esc(billTitle(b))}">More</button>
          </div>
        </div>`}
    </li>`;
  }

  // ----- Rent tab -----
  function rentTab() {
    const md = rentMonth(S.month);
    const pct = md.expected > 0 ? Math.min(100, Math.round((md.received / md.expected) * 100)) : 0;
    const soon = S.rentals.filter((r) => r.active !== false && r.lease_end && dayDiff(fromIso(r.lease_end)) <= 60 && dayDiff(fromIso(r.lease_end)) >= -30);
    const needs = md.rows.filter((x) => x.st.k === 'setup').length;
    return `${monthNav()}
      ${hero('Rent collected', money(md.received), pct, 'of ' + money(md.expected) + ' expected', md.late ? md.late + ' late' : 'None late', md.late)}
      ${needs ? `<p class="notice">Add each tenant’s rent amount so the app can track it. Tap <strong>Details</strong> on the card.</p>` : ''}
      ${soon.map((r) => { const d = dayDiff(fromIso(r.lease_end)); return `<p class="notice info">${esc(rentalTitle(r))}’s lease ${d < 0 ? 'ended' : 'ends'} ${fmtDate(fromIso(r.lease_end))}${d >= 0 ? ' (' + d + ' days)' : ''}.</p>`; }).join('')}
      ${unmatchedCard()}
      ${md.rows.length ? `<ul class="bills">${md.rows.map(rentCard).join('')}</ul>` : '<p class="muted" style="text-align:center;padding:28px 0">No tenants yet. Tap + to add one.</p>'}
      ${mortgageCard()}`;
  }
  function rentCard(x) {
    const r = x.r, done = x.st.k === 'paid';
    const unit = unitName(r.unit_id);
    const d = dueOn(r.due_day, S.month);
    const msg = encodeURIComponent('Hi' + (r.tenant_name ? ' ' + r.tenant_name.split(' ')[0] : '') + ', a reminder that ' + monthLabel(S.month).split(' ')[0] + ' rent of ' + money(x.due - x.got) + ' was due ' + (d ? fmtDay(d) : '') + '. Thank you!');
    return `<li class="bill ${done ? 'paid' : ''}">
      <div class="bill-top">
        <button class="check" data-act="rent-toggle" data-id="${r.id}" aria-pressed="${done}" aria-label="${done ? 'Mark not received' : 'Mark received'}: rent from ${esc(rentalTitle(r))}" ${x.due == null ? 'disabled' : ''}>${ICON.check}</button>
        <div class="bill-info">
          <div class="row wrap" style="gap:6px"><span class="bill-name">${esc(r.tenant_name || 'Tenant')}</span><span class="tag">${esc(unit)}</span></div>
          <span class="small muted">${x.due != null ? 'Rent ' + money(x.due) + ' · due the ' + ordinal(r.due_day) : 'Rent amount not set'}${r.late_fee ? ' · late fee ' + money(r.late_fee) : ''}</span>
          <span class="pill ${x.st.k}">${esc(x.st.label)}</span>
          ${x.rp && x.rp.source === 'email' ? '<span class="small muted">Recorded from Zelle email</span>' : ''}
        </div>
      </div>
      <div class="btns">
        ${!done && x.due != null && r.phone ? `<a class="btn" href="sms:${esc(r.phone.replace(/[^\d+]/g, ''))}${isIOS ? '&' : '?'}body=${msg}">Text reminder</a>` : ''}
        ${r.phone ? `<a class="btn" href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        <button class="btn" data-act="rental" data-id="${r.id}" style="flex:1">Details</button>
      </div>
    </li>`;
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
      <p class="small muted">Mark it paid on the Bills tab. Set the amount once as “Same amount every month”.</p>
    </section>`;
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
    const seg = [['upcoming', 'To do'], ['history', 'History']]
      .map(([id, l]) => `<button data-act="upkeep-view" data-v="${id}" aria-pressed="${S.upkeepView === id}">${l}</button>`).join('');
    let body;
    if (S.upkeepView === 'history') {
      body = S.logs.length ? `<ul class="bills">${S.logs.map(logCard).join('')}</ul>` : '<p class="muted" style="text-align:center;padding:28px 0">Nothing logged yet. Tap <strong>Done</strong> on a task, or log a repair.</p>';
    } else {
      const sched = tasks.filter((x) => x.st.k !== 'setup');
      const un = tasks.filter((x) => x.st.k === 'setup');
      body = (sched.length ? `<ul class="bills">${sched.map(taskCard).join('')}</ul>` : '') +
        (un.length ? `<h2 class="section-h">Not scheduled yet</h2><p class="small muted" style="margin:-8px 0 0">Tap <strong>Done</strong> and enter when it was last done; the app works out the next date.</p><ul class="bills">${un.map(taskCard).join('')}</ul>` : '') +
        (!tasks.length ? '<p class="muted" style="text-align:center;padding:28px 0">No upkeep tasks. Tap + to add one.</p>' : '');
    }
    return `<section class="hero" aria-label="Upkeep overview">
        <div class="row between" style="align-items:flex-end">
          <div class="stack" style="gap:2px"><span class="label">Needs attention</span><span class="big display">${overdue + soon} ${overdue + soon === 1 ? 'task' : 'tasks'}</span></div>
        </div>
        <div class="foot"><span class="${overdue ? 'late' : ''}">${overdue} overdue · ${soon} due in 30 days${unsched ? ' · ' + unsched + ' not scheduled' : ''}</span></div>
        <div class="foot"><span>Spent on upkeep in ${yr}</span><span class="num">${money(spent)}</span></div>
      </section>
      <div class="btns"><button class="btn" data-act="new-log" style="flex:1">Log a repair</button><button class="btn" data-act="new-task" style="flex:1">Add a task</button></div>
      <div class="seg" role="group" aria-label="Upkeep view">${seg}</div>
      ${body}`;
  }
  function taskCard(x) {
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
        <button class="btn primary-soft" data-act="task-done" data-id="${t.id}" style="flex:1">Done</button>
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
  function summaryTab() {
    const md = billMonth(S.month, true);
    const rm = rentMonth(S.month);
    const up = upkeepSpend(S.month);
    const net = rm.received - md.paid - up;
    const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(S.month, -i));
    const rows = months.map((k) => {
      const inc = rentMonth(k).received;
      const out = billMonth(k, true).paid + upkeepSpend(k);
      return { k, inc, out, net: inc - out };
    });
    const max = Math.max(1, ...rows.map((r) => Math.max(r.inc, r.out)));
    const all = S.bills.filter((b) => b.active !== false);
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
    return `${monthNav()}
      <div class="grid2">
        <div class="stat"><span class="small muted">Rent collected</span><span class="v display num">${money(rm.received)}</span></div>
        <div class="stat"><span class="small muted">Bills paid</span><span class="v display num">${money(md.paid)}</span></div>
        <div class="stat"><span class="small muted">Upkeep spent</span><span class="v display num">${money(up)}</span></div>
        <div class="stat"><span class="small muted">Net for ${monthLabel(S.month, true)}</span><span class="v display num" style="color:${net < 0 ? 'var(--late-fg)' : 'var(--paid-fg)'}">${net < 0 ? '−' : ''}${money(Math.abs(net))}</span></div>
      </div>
      <section class="card" aria-label="Money in and out, last 6 months">
        <h2>In vs. out · 6 months</h2>
        <div class="legend small"><span><i class="sw in"></i>Rent in</span><span><i class="sw out"></i>Bills + upkeep out</span></div>
        <div class="hist2">${rows.map((r) => `<div class="col ${r.k === S.month ? 'cur' : ''}">
          <div class="pair"><div class="b in" style="height:${Math.round((r.inc / max) * 100)}%" title="In ${money0(r.inc)}"></div><div class="b out" style="height:${Math.round((r.out / max) * 100)}%" title="Out ${money0(r.out)}"></div></div>
          <span>${monthLabel(r.k, true)}</span></div>`).join('')}</div>
        <table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Net</th></tr></thead><tbody>
          ${rows.slice().reverse().map((r) => `<tr><th scope="row">${monthLabel(r.k, true)}</th><td class="num">${money0(r.inc)}</td><td class="num">${money0(r.out)}</td><td class="num" style="color:${r.net < 0 ? 'var(--late-fg)' : 'inherit'}">${r.net < 0 ? '−' : ''}${money0(Math.abs(r.net))}</td></tr>`).join('')}
        </tbody></table>
      </section>
      <section class="card" aria-label="Bills by floor">
        <h2>Bills by floor · ${monthLabel(S.month, true)}</h2>
        ${byFloor.map((g) => `<div class="stack" style="gap:6px"><div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n} ${g.n === 1 ? 'bill' : 'bills'}</span></span><strong class="num">${money(g.total)}</strong></div><div class="meter"><div style="width:${Math.max(2, Math.round((g.total / fMax) * 100))}%"></div></div></div>`).join('')}
      </section>
      <section class="card" aria-label="Bills by category">
        <h2>Bills by category · ${monthLabel(S.month, true)}</h2>
        ${byCat.map((g) => `<div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n}</span></span><strong class="num">${money(g.total)}</strong></div>`).join('')}
      </section>`;
  }

  // ----- Settings -----
  function settingsTab() {
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
      ? '<ol class="steps"><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li><li>Open Evergreen from your Home Screen.</li></ol>'
      : S.installEvt ? '<button class="btn primary block" data-act="install">Install app</button>'
      : '<p class="small muted">In Chrome, open the ⋮ menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>';
    return `
      <section class="card" aria-label="Reminders">
        <h2>Reminders</h2>
        ${push}
        <form class="grid2" data-form="remind">
          <div class="field"><label for="s-days">Remind me</label><select class="input" id="s-days" name="remind_days" data-change="remind">${days}</select></div>
          <div class="field"><label for="s-hour">At</label><select class="input" id="s-hour" name="remind_hour" data-change="remind">${hours}</select></div>
        </form>
        <p class="small muted">Bills: before the due date, on the day, and the day after if unpaid (autopay bills are skipped). Rent: on the due day and when the grace period ends. Upkeep: before and on the due date.</p>
      </section>
      ${importCard()}
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
          <button class="btn" type="submit">Save house details</button>
        </form>
      </section>
      <section class="card" aria-label="Family password">
        <h2>Family password</h2>
        <p class="small muted">Everyone in the family uses the same password. If you change it, phones that are already signed in stay signed in.</p>
        <form class="stack" data-form="password">
          <input type="text" name="username" value="${esc(CFG.HOUSE_EMAIL)}" autocomplete="username" class="sr" tabindex="-1" aria-hidden="true" readonly>
          <div class="field"><label for="pw1">New password</label><input class="input" id="pw1" name="p1" type="password" minlength="8" autocomplete="new-password" autocapitalize="off"></div>
          <div class="field"><label for="pw2">Type it again</label><input class="input" id="pw2" name="p2" type="password" minlength="8" autocomplete="new-password" autocapitalize="off"></div>
          <button class="btn" type="submit">Change password</button>
        </form>
      </section>
      <section class="card" aria-label="This device">
        <h2>This device</h2>
        <button class="btn block" data-act="refresh">Refresh data</button>
        <button class="btn block danger" data-act="signout">Sign out</button>
      </section>
      <p class="small muted" style="text-align:center">Evergreen House · v1.4</p>`;
  }

  function importCard() {
    const last = S.imports[0];
    const label = { applied: 'Added', kept_manual: 'Kept yours', already_paid: 'Already paid', unmatched: 'Needs a look', ignored: 'Skipped' };
    const nameOf = (x) => { if (x.kind === 'zelle') { const r = S.rentals.find((y) => y.id === x.rental_id); return 'Zelle' + (r ? ' · ' + rentalTitle(r) : ''); } const b = S.bills.find((y) => y.id === x.bill_id); return b ? billTitle(b) : (x.provider || 'Email'); };
    const cls = { applied: 'paid', kept_manual: 'up', already_paid: 'up', unmatched: 'setup', ignored: 'up' };
    const rows = S.imports.filter((x) => x.status !== 'ignored').slice(0, 8);
    return `<section class="card" aria-label="Email bill import">
      <h2>Import bills &amp; Zelle rent from Gmail</h2>
      ${last ? `<p class="ok">Working · last email ${fmtDay(new Date(last.created_at))}</p>` : '<p class="small muted">Not set up yet. Takes about 2 minutes, in the Gmail account that gets your PSEG, National Grid, Liberty, Rocket Mortgage and Chase Zelle emails.</p>'}
      <ol class="steps small">
        <li>On a computer, signed in to <strong>that</strong> Gmail, open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com → New project</a>.</li>
        <li>Delete what’s there, then paste the setup script: <button class="btn" data-act="copy-script" style="height:36px;margin-top:6px">Copy setup script</button></li>
        <li>Click <strong>Save</strong> (the disk icon), choose <strong>setup</strong> in the function menu, click <strong>Run</strong>, and allow access.</li>
      </ol>
      <p class="small muted">It checks for new utility emails every 4 hours. It never changes amounts you typed or bills already marked paid. Only you can see the script. It only reads emails from those companies and Zelle alerts. In the Chase app, turn on email alerts for Zelle payments received.</p>
      ${rows.length ? `<div class="stack" style="gap:8px">${rows.map((x) => `<div class="row between small" style="align-items:flex-start;gap:8px"><div class="stack" style="gap:0;min-width:0"><span>${esc(nameOf(x))}</span><span class="muted">${esc(x.detail || x.subject || '')}</span></div><span class="pill ${cls[x.status] || 'up'}" style="margin:0;flex:none">${label[x.status] || esc(x.status)}</span></div>`).join('')}</div>` : ''}
      <button class="btn" data-act="rotate-import">Make a new key (stops the old script)</button>
    </section>`;
  }
  function importScript() {
    const url = CFG.SUPABASE_URL + '/functions/v1/import-bill';
    return `// Evergreen House — Gmail bill import
// Sends new PSEG, National Grid, Liberty, Rocket Mortgage and Zelle emails to your Evergreen House app.
// Run "setup" once. After that it runs by itself every 4 hours.

const ENDPOINT = '${url}';
const KEY = '${S.household.import_token}';
const QUERY = '(from:(pseg OR psegliny OR nationalgrid OR "national grid" OR libertyutilities OR libertyenergyandwater OR "liberty utilities" OR rocketmortgage OR "rocket mortgage") OR zelle OR (from:chase.com "sent you money")) newer_than:45d';

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

  // ---------- sheets ----------
  function unitOptions(sel) { return S.units.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join(''); }
  function opts(list, sel) { return list.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join(''); }
  function methodOpts(sel) { return '<option value="">—</option>' + opts(METHODS, sel); }
  function f(id, label, input) { return `<div class="field"><label for="${id}">${label}</label>${input}</div>`; }
  function inp(id, name, value, extra) { return `<input class="input" id="${id}" name="${name}" value="${esc(value == null ? '' : value)}" ${extra || ''}>`; }
  function moneyInp(id, name, v) { return inp(id, name, v != null ? Number(v).toFixed(2) : '', 'inputmode="decimal" placeholder="0.00"'); }
  function sheetShell(title, form, inner, del) {
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">${esc(title)}</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <form class="stack" data-form="${form}" novalidate>
        ${inner}
        ${S.sheetErr ? `<p class="err" role="alert">${esc(S.sheetErr)}</p>` : ''}
        <button class="btn primary block" type="submit">Save</button>
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
    return '';
  }

  function billSheet(sh) {
    const isNew = sh.type === 'new-bill';
    const b = isNew ? { unit_id: wholeId(), category: 'Other', amount_type: 'variable' } : S.bills.find((x) => x.id === sh.id);
    if (!b) return '';
    const pay = isNew ? {} : (getPay(b, S.month) || {});
    const amt = isNew ? null : amountFor(b, pay);
    const paidDate = pay.paid_at ? isoDate(new Date(pay.paid_at)) : '';
    const month = isNew ? '' : `<section class="card">
        <h2>${monthLabel(S.month)}</h2>
        <div class="grid2">${f('p-amt', 'Amount ($)', moneyInp('p-amt', 'p_amount', amt))}${f('p-date', 'Paid on', inp('p-date', 'p_paid', paidDate, 'type="date"'))}</div>
        <div class="grid2">${f('p-method', 'Paid with', `<select class="input" id="p-method" name="p_method">${methodOpts(pay.method)}</select>`)}${f('p-conf', 'Confirmation #', inp('p-conf', 'p_confirmation', pay.confirmation))}</div>
        ${f('p-note', 'Note', inp('p-note', 'p_note', pay.note))}
        <div class="field"><span class="lab">Bill photo or receipt</span>
          ${pay.receipt_path ? `<div class="btns"><button type="button" class="btn" data-act="receipt-view">View</button><button type="button" class="btn danger" data-act="receipt-remove">Remove</button></div><div id="receipt-slot"></div>` :
            `<label class="btn" style="width:100%"><input type="file" accept="image/*,application/pdf" class="sr" data-change="receipt"> Add photo or PDF</label>`}
        </div>
      </section>`;
    const details = `<section class="card">
        <h2>${isNew ? 'New bill' : 'Bill details'}</h2>
        ${f('b-name', 'Provider / name', inp('b-name', 'name', b.name, 'required placeholder="e.g. Optimum internet"'))}
        <div class="grid2">${f('b-label', 'Label', inp('b-label', 'label', b.label, 'placeholder="Optional"'))}${f('b-acct', 'Account #', inp('b-acct', 'account_number', b.account_number, 'inputmode="numeric"'))}</div>
        <div class="grid2">${f('b-cat', 'Category', `<select class="input" id="b-cat" name="category">${opts(CATEGORIES, b.category)}</select>`)}${f('b-unit', 'Floor', `<select class="input" id="b-unit" name="unit_id">${unitOptions(b.unit_id)}</select>`)}</div>
        <div class="grid2">${f('b-day', 'Due day', inp('b-day', 'due_day', b.due_day, 'type="number" inputmode="numeric" min="1" max="31"'))}${f('b-def', 'Usual amount ($)', moneyInp('b-def', 'default_amount', b.default_amount))}</div>
        <label class="checkrow"><input type="checkbox" name="fixed" ${b.amount_type === 'fixed' ? 'checked' : ''}> Same amount every month</label>
        <label class="checkrow"><input type="checkbox" name="autopay" ${b.autopay ? 'checked' : ''}> Paid automatically (autopay)</label>
        ${f('b-url', 'Payment website', inp('b-url', 'pay_url', b.pay_url, 'type="url" inputmode="url" placeholder="https://"'))}
        ${f('b-notes', 'Notes', `<textarea class="input" id="b-notes" name="notes">${esc(b.notes)}</textarea>`)}
      </section>`;
    return sheetShell(isNew ? 'Add bill' : billTitle(b), 'bill', month + details, isNew ? null : 'Delete bill and its history');
  }

  function rentalSheet(sh) {
    const isNew = sh.type === 'new-rental';
    const r = isNew ? { due_day: 1, grace_days: 5, unit_id: (S.units.find((u) => isFloor(u.name)) || {}).id } : S.rentals.find((x) => x.id === sh.id);
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
        <div class="grid2">${f('r-name', 'Tenant name', inp('r-name', 'tenant_name', r.tenant_name, 'autocomplete="off"'))}${f('r-unit', 'Floor', `<select class="input" id="r-unit" name="unit_id">${unitOptions(r.unit_id)}</select>`)}</div>
        <div class="grid2">${f('r-phone', 'Phone', inp('r-phone', 'phone', r.phone, 'type="tel" inputmode="tel" autocomplete="off"'))}${f('r-email', 'Email', inp('r-email', 'email', r.email, 'type="email" inputmode="email" autocomplete="off"'))}</div>
        <div class="grid2">${f('r-rent', 'Monthly rent ($)', moneyInp('r-rent', 'rent_amount', r.rent_amount))}${f('r-day', 'Due day', inp('r-day', 'due_day', r.due_day, 'type="number" inputmode="numeric" min="1" max="31"'))}</div>
        <div class="grid2">${f('r-grace', 'Grace days', inp('r-grace', 'grace_days', r.grace_days, 'type="number" inputmode="numeric" min="0" max="31"'))}${f('r-fee', 'Late fee ($)', moneyInp('r-fee', 'late_fee', r.late_fee))}</div>
        <div class="grid2">${f('r-start', 'Lease start', inp('r-start', 'lease_start', r.lease_start, 'type="date"'))}${f('r-end', 'Lease end', inp('r-end', 'lease_end', r.lease_end, 'type="date"'))}</div>
        ${f('r-payer', 'Also pays as <span class="muted">(other names on Zelle, comma-separated)</span>', inp('r-payer', 'payer_names', r.payer_names, 'autocomplete="off" placeholder="e.g. spouse’s name"'))}
        ${f('r-dep', 'Security deposit ($)', moneyInp('r-dep', 'deposit', r.deposit))}
        ${f('r-notes', 'Notes', `<textarea class="input" id="r-notes" name="notes">${esc(r.notes)}</textarea>`)}
      </section>`;
    return sheetShell(isNew ? 'Add tenant' : rentalTitle(r), 'rental', month + details, isNew ? null : 'Remove tenant and rent history');
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
        <div class="grid2">${f('dn-cost', 'Cost ($)', moneyInp('dn-cost', 'cost', null))}${f('dn-vendor', 'Who did it', inp('dn-vendor', 'vendor', t.vendor, 'placeholder="Me / contractor"'))}</div>
        ${f('dn-notes', 'Notes', `<textarea class="input" id="dn-notes" name="notes" placeholder="Optional"></textarea>`)}
        <p class="small muted">${t.interval_months ? 'Next one will be scheduled ' + everyLabel(t).toLowerCase().replace('every', 'in') + ' from this date.' : 'This one-time job will be marked complete.'}</p>
      </section>`, null);
  }

  function logSheet(sh) {
    const isNew = sh.type === 'new-log';
    const l = isNew ? { unit_id: wholeId(), done_on: isoDate(today()) } : S.logs.find((x) => x.id === sh.id);
    if (!l) return '';
    return sheetShell(isNew ? 'Log a repair' : l.title, 'log', `<section class="card">
        ${f('l-title', 'What was done', inp('l-title', 'title', l.title, 'required placeholder="e.g. Fixed leaking kitchen faucet"'))}
        <div class="grid2">${f('l-date', 'Date', inp('l-date', 'done_on', l.done_on, 'type="date" required'))}${f('l-unit', 'Where', `<select class="input" id="l-unit" name="unit_id">${unitOptions(l.unit_id)}</select>`)}</div>
        <div class="grid2">${f('l-cost', 'Cost ($)', moneyInp('l-cost', 'cost', l.cost))}${f('l-vendor', 'Who did it', inp('l-vendor', 'vendor', l.vendor))}</div>
        ${f('l-notes', 'Notes', `<textarea class="input" id="l-notes" name="notes">${esc(l.notes)}</textarea>`)}
      </section>`, isNew ? null : 'Delete entry');
  }

  // ---------- actions ----------
  function findBill(id) { return S.bills.find((b) => b.id === id); }
  function openSheet(type, id) { S.sheet = { type, id }; S.sheetErr = ''; S.deleteArm = false; render(); }

  async function onAct(el) {
    const act = el.dataset.act;
    const id = el.dataset.id;
    switch (act) {
      case 'tab': S.tab = el.dataset.tab; window.scrollTo(0, 0); render(); break;
      case 'month': S.month = addMonths(S.month, Number(el.dataset.delta)); S.editing = null; render(); break;
      case 'month-today': S.month = monthKey(new Date()); render(); break;
      case 'unit': S.unit = el.dataset.unit; render(); break;
      case 'filter': S.filter = el.dataset.filter; render(); break;
      case 'upkeep-view': S.upkeepView = el.dataset.v; render(); break;
      case 'edit': { S.editing = id; render(); const n = document.getElementById('a-' + id); if (n) n.focus(); break; }
      case 'done': S.editing = null; render(); break;
      case 'toggle': {
        const b = findBill(id); const pay = getPay(b, S.month);
        if (pay && pay.paid_at) savePayment(b, S.month, { paid_at: null });
        else { savePayment(b, S.month, { paid_at: new Date().toISOString(), amount: amountFor(b, pay), method: (pay && pay.method) || (b.autopay ? 'Autopay' : null) }); toast('Marked paid'); }
        render(); break;
      }
      case 'rent-toggle': {
        const r = S.rentals.find((x) => x.id === id); const rp = getRentPay(r, S.month); const due = rentDue(r, rp);
        if (due == null) break;
        const full = rp && Number(rp.amount_received || 0) >= due;
        if (full) saveRentPay(r, S.month, { amount_received: null, received_at: null });
        else { saveRentPay(r, S.month, { amount_due: due, amount_received: due, received_at: new Date().toISOString() }); toast('Rent marked received'); }
        render(); break;
      }
      case 'copy':
        try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied ' + el.dataset.text); } catch (_) { toast(el.dataset.text); }
        break;
      case 'bill': openSheet('bill', id); break;
      case 'rental': openSheet('rental', id); break;
      case 'task': openSheet('task', id); break;
      case 'task-done': openSheet('task-done', id); break;
      case 'log': openSheet('log', id); break;
      case 'new-bill': case 'new-rental': case 'new-task': case 'new-log': openSheet(act); break;
      case 'sheet-close': case 'sheet-close-bg': S.sheet = null; render(); break;
      case 'sheet-delete': {
        if (!S.deleteArm) { S.deleteArm = true; render(); break; }
        const t = S.sheet.type, sid = S.sheet.id;
        if (t === 'bill') deleteBill(sid); else if (t === 'rental') deleteRental(sid); else if (t === 'task') deleteTask(sid); else if (t === 'log') deleteLog(sid);
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
    }
  }

  async function onSubmit(form) {
    const kind = form.dataset.form;
    const fd = new FormData(form);
    const val = (k) => String(fd.get(k) || '').trim();
    const intv = (k, lo, hi) => { const n = parseInt(val(k), 10); return n >= lo && n <= hi ? n : null; };
    const fail = (m) => { S.sheetErr = m; render(); };
    if (kind === 'auth') {
      const password = String(fd.get('password') || '');
      S.authErr = '';
      if (!password) { S.authErr = 'Enter the house password.'; return render(); }
      S.busy = true; render();
      const r = await sb.auth.signInWithPassword({ email: CFG.HOUSE_EMAIL, password });
      S.busy = false;
      if (r.error) S.authErr = /invalid/i.test(r.error.message) ? 'That password isn’t right.' : r.error.message;
      render();
    } else if (kind === 'recovery') {
      const password = String(fd.get('password') || '');
      if (password.length < 8) { S.authErr = 'Use at least 8 characters.'; return render(); }
      const r = await sb.auth.updateUser({ password });
      if (r.error) { S.authErr = r.error.message; return render(); }
      toast('Password saved'); S.view = 'loading'; render(); loadAll();
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
        amount_type: fixed ? 'fixed' : 'variable', autopay: !!fd.get('autopay'), pay_url: val('pay_url') || null, notes: val('notes') || null
      });
      saveBill(nb);
      if (!isNew) {
        const paidOn = val('p_paid'); const pay = getPay(nb, S.month);
        let paidAt = null;
        if (paidOn) paidAt = pay && pay.paid_at && isoDate(new Date(pay.paid_at)) === paidOn ? pay.paid_at : new Date(paidOn + 'T12:00:00').toISOString();
        savePayment(nb, S.month, { amount: num(val('p_amount')), paid_at: paidAt, method: val('p_method') || null, confirmation: val('p_confirmation') || null, note: val('p_note') || null });
      }
      S.sheet = null; if (isNew) { S.tab = 'bills'; } render(); toast(isNew ? 'Bill added' : 'Saved');
    } else if (kind === 'rental') {
      const isNew = S.sheet.type === 'new-rental';
      const r = isNew ? { id: uuid(), household_id: S.household.id, active: true, created_at: new Date().toISOString() } : S.rentals.find((x) => x.id === S.sheet.id);
      const nr = Object.assign({}, r, {
        tenant_name: val('tenant_name') || null, unit_id: val('unit_id') || null, phone: val('phone') || null, email: val('email') || null,
        rent_amount: num(val('rent_amount')), due_day: intv('due_day', 1, 31) || 1, grace_days: intv('grace_days', 0, 31) ?? 0,
        late_fee: num(val('late_fee')), deposit: num(val('deposit')), payer_names: val('payer_names') || null, lease_start: val('lease_start') || null, lease_end: val('lease_end') || null, notes: val('notes') || null
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
      saveLog({ id: uuid(), household_id: S.household.id, task_id: t.id, unit_id: t.unit_id, title: t.title, done_on: on, cost: num(val('cost')), vendor: val('vendor') || null, notes: val('notes') || null, receipt_path: null, created_at: new Date().toISOString() });
      const nt = Object.assign({}, t, { last_done: on, vendor: val('vendor') || t.vendor });
      if (t.interval_months) nt.next_due = addMonthsIso(on, t.interval_months); else { nt.next_due = null; nt.active = false; }
      saveTask(nt);
      S.sheet = null; render(); toast(t.interval_months ? 'Done — next one ' + fmtDate(fromIso(nt.next_due)) : 'Done');
    } else if (kind === 'log') {
      const isNew = S.sheet.type === 'new-log';
      const l = isNew ? { id: uuid(), household_id: S.household.id, task_id: null, receipt_path: null, created_at: new Date().toISOString() } : S.logs.find((x) => x.id === S.sheet.id);
      const title = val('title');
      if (!title) return fail('Say what was done.');
      if (!val('done_on')) return fail('Pick a date.');
      saveLog(Object.assign({}, l, { title, done_on: val('done_on'), unit_id: val('unit_id') || null, cost: num(val('cost')), vendor: val('vendor') || null, notes: val('notes') || null }));
      S.sheet = null; if (isNew) S.upkeepView = 'history'; render(); toast('Saved');
    } else if (kind === 'password') {
      const p1 = String(fd.get('p1') || ''), p2 = String(fd.get('p2') || '');
      if (p1.length < 8) return toast('Use at least 8 characters.');
      if (p1 !== p2) return toast('The two passwords don’t match.');
      const r = await sb.auth.updateUser({ password: p1 });
      if (r.error) return toast('Couldn’t change it: ' + r.error.message);
      form.reset(); toast('Password changed. Share the new one with your family.');
    } else if (kind === 'house') {
      const fields = { name: val('name') || 'My house', address: val('address') || null };
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
    const blob = new Blob([text], { type });
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
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Evergreen House//House//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:House'];
    const ev = (uid, d, summary, desc, rrule) => {
      lines.push('BEGIN:VEVENT', 'UID:' + uid + '@evergreen-house', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(d), 'DTEND;VALUE=DATE:' + ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)));
      if (rrule) lines.push(rrule);
      lines.push('SUMMARY:' + fold(summary), 'DESCRIPTION:' + fold(desc), 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + fold(summary), 'TRIGGER:' + trigger, 'END:VALARM', 'END:VEVENT');
    };
    const monthly = (day) => 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (day === 31 ? '-1' : day);
    let n = 0;
    S.bills.filter((b) => b.active !== false && b.due_day).forEach((b) => {
      const amt = b.amount_type === 'fixed' && b.default_amount != null ? ' (' + money(b.default_amount) + ')' : '';
      ev(b.id, nextOn(b.due_day), 'Pay ' + billTitle(b) + amt, unitName(b.unit_id) + (b.account_number ? ' · Account ' + b.account_number : '') + (b.pay_url ? ' · ' + b.pay_url : ''), monthly(b.due_day)); n++;
    });
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
    const rows = [['Type', 'Month / date', 'Item', 'Floor', 'Category', 'Account', 'Amount', 'Due', 'Paid / received on', 'Method', 'Confirmation / vendor', 'Note']];
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
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'A') return;
    if (el.dataset.act === 'sheet-close-bg' && e.target !== el) return; // taps inside the sheet
    e.preventDefault(); onAct(el);
  });
  document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.change) onChange(e.target); });
  document.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(e.target); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sheet) { S.sheet = null; render(); }
    if (e.key === 'Enter' && e.target.dataset && (e.target.dataset.change === 'amount' || e.target.dataset.change === 'due')) { e.preventDefault(); e.target.blur(); }
  });
  window.addEventListener('online', () => { S.online = true; flush().then(loadAll); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; renderSoon(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.view === 'app' && navigator.onLine && !S.sheet) loadAll(); });

  // ---------- boot ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
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
