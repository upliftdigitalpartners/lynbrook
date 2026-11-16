/* Evergreen House — rent & bill tracker PWA */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const CATEGORIES = ['Rent / mortgage', 'Electric', 'Gas', 'Water', 'Internet & phone', 'Insurance', 'Taxes', 'Trash', 'Maintenance', 'Other'];
  const METHODS = ['Online', 'Autopay', 'Bank transfer', 'Zelle', 'Check', 'Card', 'Cash', 'Other'];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // ---------- state ----------
  const S = {
    view: 'loading', // loading | auth | recovery | join | app
    authMode: 'signin', authErr: '', authMsg: '', joinErr: '',
    user: null, household: null, member: null, units: [], bills: [], payments: {},
    tab: 'bills', month: monthKey(new Date()), unit: 'all', filter: 'all',
    editing: null, sheet: null, sheetErr: '', deleteArm: false, addErr: '', addOk: '',
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
  function dueDate(b, period) {
    if (!b.due_day) return null;
    const { y, m } = parseMonth(period);
    return new Date(y, m - 1, Math.min(b.due_day, daysIn(y, m)));
  }
  function fmtDay(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/[$,]/g, '')); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })); }
  function unitName(id) { const u = S.units.find((x) => x.id === id); return u ? u.name : 'Whole house'; }
  function isFloor(name) { return /floor/i.test(name); }
  function billTitle(b) { return b.label ? b.name + ' · ' + b.label : b.name; }
  function payKey(billId, period) { return billId + '|' + period; }
  function getPay(b, period) { return S.payments[payKey(b.id, period)] || null; }
  function amountFor(b, pay) {
    if (pay && pay.amount != null) return Number(pay.amount);
    if (b.amount_type === 'fixed' && b.default_amount != null) return Number(b.default_amount);
    return null;
  }
  function isNetErr(e) { return !navigator.onLine || /fetch|network|load failed|timeout/i.test((e && (e.message || e.toString())) || ''); }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const ICON = {
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    left: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    ext: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    bills: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    add: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    summary: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
    settings: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
  };

  // ---------- local cache + offline outbox ----------
  const cacheKey = () => 'eh-cache-' + (S.user ? S.user.id : 'anon');
  const OUTBOX = 'eh-outbox';
  function saveCache() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ household: S.household, member: S.member, units: S.units, bills: S.bills, payments: S.payments }));
    } catch (_) {}
  }
  function readCache() { try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (_) { return null; } }
  function readOutbox() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch (_) { return []; } }
  function writeOutbox(ob) { try { localStorage.setItem(OUTBOX, JSON.stringify(ob)); } catch (_) {} S.pending = ob.length; }

  function queue(op) { const ob = readOutbox(); ob.push(op); writeOutbox(ob); saveCache(); flush(); }
  let flushing = false;
  async function flush() {
    if (flushing || !S.user) return;
    flushing = true;
    try {
      let ob = readOutbox();
      while (ob.length) {
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
        ob.shift(); writeOutbox(ob);
      }
    } finally { flushing = false; renderSoon(); }
  }

  // ---------- data ----------
  async function loadAll() {
    const cached = readCache();
    if (cached && cached.household) { Object.assign(S, cached); S.view = 'app'; render(); }
    await flush();
    if (readOutbox().length) return; // still offline; keep local copy
    try {
      const mem = await sb.from('household_members').select('*, households(*)').eq('user_id', S.user.id).limit(1);
      if (mem.error) throw mem.error;
      if (!mem.data.length) { S.view = 'join'; render(); return; }
      const m = mem.data[0];
      const hid = m.household_id;
      const since = addMonths(monthKey(new Date()), -12);
      const [u, b, p] = await Promise.all([
        sb.from('units').select('*').eq('household_id', hid).order('sort'),
        sb.from('bills').select('*').eq('household_id', hid).order('created_at'),
        sb.from('payments').select('*').eq('household_id', hid).gte('period', since)
      ]);
      [u, b, p].forEach((r) => { if (r.error) throw r.error; });
      S.household = m.households; delete m.households; S.member = m;
      S.units = u.data; S.bills = b.data; S.payments = {};
      p.data.forEach((x) => { S.payments[payKey(x.bill_id, x.period)] = x; });
      saveCache();
      S.view = 'app';
      render();
      checkPush();
    } catch (e) {
      if (!cached) { S.view = 'app'; render(); }
      toast(isNetErr(e) ? 'Offline — showing saved copy' : 'Couldn’t load: ' + e.message);
    }
  }

  function savePayment(b, period, fields) {
    const existing = getPay(b, period);
    const d = dueDate(b, period);
    const row = Object.assign({
      id: uuid(), household_id: S.household.id, bill_id: b.id, period: period,
      amount: null, due_date: d ? isoDate(d) : null, paid_at: null, method: null, confirmation: null, note: null, receipt_path: null
    }, existing || {}, fields, { updated_at: new Date().toISOString() });
    if (d) row.due_date = isoDate(d);
    S.payments[payKey(b.id, period)] = row;
    queue({ kind: 'upsert', table: 'payments', row: row, onConflict: 'bill_id,period' });
  }
  function saveBill(b) {
    const i = S.bills.findIndex((x) => x.id === b.id);
    if (i >= 0) S.bills[i] = b; else S.bills.push(b);
    queue({ kind: 'upsert', table: 'bills', row: b });
  }
  function deleteBill(id) {
    S.bills = S.bills.filter((x) => x.id !== id);
    Object.keys(S.payments).forEach((k) => { if (k.startsWith(id + '|')) delete S.payments[k]; });
    queue({ kind: 'delete', table: 'bills', id: id });
  }

  // ---------- derived ----------
  function statusFor(b, pay, period) {
    const amt = amountFor(b, pay);
    const due = dueDate(b, period);
    if (pay && pay.paid_at) return { k: 'paid', label: 'Paid ' + fmtDay(new Date(pay.paid_at)) };
    if (!due || amt == null) return { k: 'setup', label: 'Needs details' };
    const diff = Math.round((due - today()) / 86400000);
    if (b.autopay) return { k: 'auto', label: (diff < 0 ? 'Autopay · was due ' : 'Autopay · ') + fmtDay(due) };
    if (diff < 0) return { k: 'late', label: 'Overdue · ' + fmtDay(due) };
    if (diff === 0) return { k: 'late', label: 'Due today' };
    if (diff <= 5) return { k: 'soon', label: 'Due in ' + diff + (diff === 1 ? ' day' : ' days') };
    return { k: 'up', label: 'Due ' + fmtDay(due) };
  }
  function unitMatch(b) {
    if (S.unit === 'all') return true;
    const n = unitName(b.unit_id);
    if (S.unit === 'shared') return !isFloor(n);
    return b.unit_id === S.unit;
  }
  function monthData(period) {
    const bills = S.bills.filter((b) => b.active !== false).filter(unitMatch);
    let total = 0, paid = 0, overdue = 0, overdueAmt = 0, setup = 0;
    const rows = bills.map((b) => {
      const pay = getPay(b, period);
      const st = statusFor(b, pay, period);
      const amt = amountFor(b, pay);
      total += amt || 0;
      if (pay && pay.paid_at) paid += amt || 0;
      if (st.k === 'late' && st.label.startsWith('Overdue')) { overdue++; overdueAmt += amt || 0; }
      if (st.k === 'setup') setup++;
      return { b, pay, st, amt, due: dueDate(b, period) };
    });
    rows.sort((a, c) => (a.due ? a.due.getTime() : 9e15) - (c.due ? c.due.getTime() : 9e15));
    return { rows, total, paid, overdue, overdueAmt, setup };
  }

  // ---------- render ----------
  let raf;
  function renderSoon() { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }
  function render() {
    const app = document.getElementById('app');
    const y = window.scrollY;
    const ae = document.activeElement;
    const keep = ae && ae.id && app.contains(ae) ? { id: ae.id, v: ae.value, a: ae.selectionStart, b: ae.selectionEnd, sheet: ae.closest('.sheet') ? ae.closest('.sheet').scrollTop : null } : null;
    if (S.view === 'loading') app.innerHTML = '<div class="splash"><img src="icons/icon-192.png" alt="" width="72" height="72"><p>Loading…</p></div>';
    else if (S.view === 'auth') app.innerHTML = authView();
    else if (S.view === 'recovery') app.innerHTML = recoveryView();
    else if (S.view === 'join') app.innerHTML = joinView();
    else app.innerHTML = appView();
    if (S.view === 'app') window.scrollTo(0, y);
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) {
        if (n.value !== undefined && typeof keep.v === 'string' && n.type !== 'file' && n.tagName !== 'SELECT') n.value = keep.v;
        n.focus({ preventScroll: true });
        try { if (keep.a != null) n.setSelectionRange(keep.a, keep.b); } catch (_) {}
        if (keep.sheet != null && n.closest('.sheet')) n.closest('.sheet').scrollTop = keep.sheet;
      }
    }
  }

  function authView() {
    const signup = S.authMode === 'signup';
    const forgot = S.authMode === 'forgot';
    return `<div class="auth"><form class="card" data-form="auth" novalidate>
      <img class="logo" src="icons/icon-192.png" alt="">
      <div><h1 class="display" style="margin:0;font-size:26px">Evergreen House</h1>
      <p class="muted">${forgot ? 'We’ll email you a link to set a new password.' : signup ? 'Create your account. You’ll confirm your email once.' : 'Sign in to your house bills.'}</p></div>
      <div class="field"><label for="a-email">Email</label><input class="input" id="a-email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
      ${forgot ? '' : `<div class="field"><label for="a-pass">Password</label><input class="input" id="a-pass" name="password" type="password" minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}" required>${signup ? '<span class="small muted">At least 8 characters.</span>' : ''}</div>`}
      ${S.authErr ? `<p class="err" role="alert">${esc(S.authErr)}</p>` : ''}
      ${S.authMsg ? `<p class="ok" role="status">${esc(S.authMsg)}</p>` : ''}
      <button class="btn primary block" type="submit" ${S.busy ? 'disabled' : ''}>${forgot ? 'Send reset link' : signup ? 'Create account' : 'Sign in'}</button>
      <div class="row between wrap">
        <button type="button" class="linkbtn" data-act="auth-mode" data-mode="${signup ? 'signin' : 'signup'}">${signup ? 'I have an account' : 'Create an account'}</button>
        ${forgot ? '<button type="button" class="linkbtn" data-act="auth-mode" data-mode="signin">Back to sign in</button>' : signup ? '' : '<button type="button" class="linkbtn" data-act="auth-mode" data-mode="forgot">Forgot password?</button>'}
      </div>
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
      <button type="button" class="linkbtn" data-act="signout">Sign out (${esc(S.user && S.user.email)})</button>
    </form></div>`;
  }

  function appView() {
    const titles = { bills: S.household ? S.household.name : 'House bills', add: 'Add a bill', summary: 'Summary', settings: 'Settings' };
    const addr = S.household && S.household.address ? S.household.address.split(',')[0] : '';
    const offline = !S.online || S.pending
      ? `<span class="status-dot">${!S.online ? 'Offline' : 'Syncing'}${S.pending ? ' · ' + S.pending + ' unsaved' : ''}</span>` : '';
    const body = S.tab === 'bills' ? billsTab() : S.tab === 'add' ? addTab() : S.tab === 'summary' ? summaryTab() : settingsTab();
    const tabs = [['bills', 'Bills'], ['add', 'Add'], ['summary', 'Summary'], ['settings', 'Settings']]
      .map(([id, l]) => `<button class="tab" data-act="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${ICON[id]}<span>${l}</span></button>`).join('');
    return `<div class="shell">
      <header class="topbar">
        <div class="topbar-row"><span class="eyebrow">${esc(addr)}${addr ? ' · ' : ''}Lynbrook</span>${offline}</div>
        <h1 class="display">${esc(titles[S.tab])}</h1>
      </header>
      <main class="main">${body}</main>
      <nav class="tabbar" aria-label="App sections"><div class="tabbar-inner">${tabs}</div></nav>
      ${S.sheet ? sheetView() : ''}
    </div>`;
  }

  function billsTab() {
    const md = monthData(S.month);
    const pct = md.total > 0 ? Math.round((md.paid / md.total) * 100) : 0;
    const isCur = S.month === monthKey(new Date());
    const unpaid = md.rows.filter((r) => !(r.pay && r.pay.paid_at)).length;
    const visible = md.rows.filter((r) => S.filter === 'all' ? true : S.filter === 'paid' ? (r.pay && r.pay.paid_at) : !(r.pay && r.pay.paid_at));
    const floors = S.units.filter((u) => isFloor(u.name));
    const unitChips = [['all', 'Everything'], ['shared', 'Shared']].concat(floors.map((u) => [u.id, u.name]))
      .map(([id, l]) => `<button class="chip" data-act="unit" data-unit="${esc(id)}" aria-pressed="${S.unit === id}">${esc(l)}</button>`).join('');
    const filt = [['all', 'All ' + md.rows.length], ['unpaid', 'Unpaid ' + unpaid], ['paid', 'Paid ' + (md.rows.length - unpaid)]]
      .map(([id, l]) => `<button data-act="filter" data-filter="${id}" aria-pressed="${S.filter === id}">${l}</button>`).join('');

    return `
      <div class="row between">
        <div class="monthnav">
          <button class="iconbtn" data-act="month" data-delta="-1" aria-label="Previous month">${ICON.left}</button>
          <strong style="font-size:16px;min-width:140px;text-align:center">${monthLabel(S.month)}</strong>
          <button class="iconbtn" data-act="month" data-delta="1" aria-label="Next month">${ICON.right}</button>
        </div>
        ${isCur ? '' : '<button class="btn" data-act="month-today">This month</button>'}
      </div>
      <section class="hero" aria-label="This month">
        <div class="row between" style="align-items:flex-end">
          <div class="stack" style="gap:2px"><span class="label">Still to pay</span><span class="big display num">${money(md.total - md.paid)}</span></div>
          <span class="pct display">${pct}%</span>
        </div>
        <div class="track" role="progressbar" aria-label="Share of bills paid" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
        <div class="foot"><span>${money(md.paid)} of ${money(md.total)} paid</span><span class="${md.overdue ? 'late' : ''}">${md.overdue ? md.overdue + ' overdue · ' + money(md.overdueAmt) : 'None overdue'}</span></div>
      </section>
      ${md.setup ? `<p class="notice">${md.setup} ${md.setup === 1 ? 'bill needs' : 'bills need'} an amount or due day for ${monthLabel(S.month, true)}. Fill them in on the card.</p>` : ''}
      <div class="chips" role="group" aria-label="Show floor">${unitChips}</div>
      <div class="seg" role="group" aria-label="Filter bills">${filt}</div>
      ${visible.length ? `<ul class="bills">${visible.map(billCard).join('')}</ul>` :
        `<p class="muted" style="text-align:center;padding:28px 0">${S.filter === 'paid' ? 'Nothing paid yet this month.' : S.filter === 'unpaid' ? 'All caught up — every bill is paid.' : 'No bills here yet. Tap Add below.'}</p>`}
    `;
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
            <button class="btn" data-act="details" data-id="${b.id}" style="flex:1">Details</button>
          </div>
        </div>` : `<div class="bill-sum">
          <div class="stack" style="gap:0"><span class="amt display num">${money(r.amt)}</span><span class="small muted">${r.due ? 'Due ' + fmtDay(r.due) : ''}${b.autopay ? ' · Autopay' : ''}</span></div>
          <div class="btns">
            ${b.pay_url && !paid ? `<a class="btn" href="${esc(b.pay_url)}" target="_blank" rel="noopener">Pay ${ICON.ext}</a>` : ''}
            <button class="btn" data-act="edit" data-id="${b.id}" aria-label="Edit ${esc(billTitle(b))}">Edit</button>
            <button class="btn" data-act="details" data-id="${b.id}" aria-label="Details for ${esc(billTitle(b))}">More</button>
          </div>
        </div>`}
    </li>`;
  }

  function unitOptions(sel) {
    return S.units.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  }
  function catOptions(sel) { return CATEGORIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join(''); }

  function addTab() {
    const whole = (S.units.find((u) => !isFloor(u.name)) || {}).id;
    return `<form class="card" data-form="add" novalidate>
      <div class="field"><label for="n-name">Provider / name</label><input class="input" id="n-name" name="name" placeholder="e.g. Optimum internet" required></div>
      <div class="field"><label for="n-label">Label <span class="muted">(optional)</span></label><input class="input" id="n-label" name="label" placeholder="e.g. Basement meter"></div>
      <div class="field"><label for="n-acct">Account #</label><input class="input num" id="n-acct" name="account_number" inputmode="numeric" placeholder="Optional"></div>
      <div class="grid2">
        <div class="field"><label for="n-cat">Category</label><select class="input" id="n-cat" name="category">${catOptions('Other')}</select></div>
        <div class="field"><label for="n-unit">Floor</label><select class="input" id="n-unit" name="unit_id">${unitOptions(whole)}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="n-day">Due day</label><input class="input num" id="n-day" name="due_day" type="number" inputmode="numeric" min="1" max="31" placeholder="1–31"></div>
        <div class="field"><label for="n-amt">Amount ($)</label><input class="input num" id="n-amt" name="amount" inputmode="decimal" placeholder="0.00"></div>
      </div>
      <label class="checkrow"><input type="checkbox" name="fixed"> Same amount every month (like rent)</label>
      <label class="checkrow"><input type="checkbox" name="autopay"> Paid automatically (autopay)</label>
      <div class="field"><label for="n-url">Payment website <span class="muted">(optional)</span></label><input class="input" id="n-url" name="pay_url" type="url" inputmode="url" placeholder="https://"></div>
      ${S.addErr ? `<p class="err" role="alert">${esc(S.addErr)}</p>` : ''}
      ${S.addOk ? `<p class="ok" role="status">${esc(S.addOk)}</p>` : ''}
      <button class="btn primary block" type="submit">Add bill</button>
    </form>`;
  }

  function summaryTab() {
    const md = monthData(S.month);
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
    const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(S.month, -i));
    const hist = months.map((k) => {
      let t = 0; all.forEach((b) => { const p = getPay(b, k); if (p && p.paid_at) t += amountFor(b, p) || 0; });
      return { k, t };
    });
    const hMax = Math.max(1, ...hist.map((h) => h.t));
    const yearTotal = Object.values(S.payments).filter((p) => p.paid_at && p.period.slice(0, 4) === S.month.slice(0, 4))
      .reduce((t, p) => { const b = S.bills.find((x) => x.id === p.bill_id); return t + (b ? amountFor(b, p) || 0 : Number(p.amount) || 0); }, 0);
    const next = md.rows.find((r) => !(r.pay && r.pay.paid_at) && r.due && r.due >= today());
    return `
      <div class="grid2">
        <div class="stat"><span class="small muted">${monthLabel(S.month, true)} total</span><span class="v display num">${money(md.total)}</span></div>
        <div class="stat"><span class="small muted">Paid in ${S.month.slice(0, 4)}</span><span class="v display num">${money(yearTotal)}</span></div>
      </div>
      <div class="stat"><span class="small muted">Next due</span><span class="v display">${next ? esc(billTitle(next.b)) : 'Nothing scheduled'}</span><span class="small muted">${next ? esc(unitName(next.b.unit_id)) + ' · ' + fmtDay(next.due) + (next.amt != null ? ' · ' + money(next.amt) : '') : 'Add due days to see what’s next'}</span></div>
      <section class="card" aria-label="Paid per month">
        <h2>Paid per month</h2>
        <div class="hist">${hist.map((h) => `<div class="col ${h.k === S.month ? 'cur' : ''}"><span class="num">${h.t ? '$' + Math.round(h.t) : ''}</span><div class="b" style="height:${Math.round((h.t / hMax) * 100)}%"></div><span>${monthLabel(h.k, true)}</span></div>`).join('')}</div>
      </section>
      <section class="card" aria-label="By floor">
        <h2>By floor · ${monthLabel(S.month, true)}</h2>
        ${byFloor.map((g) => `<div class="stack" style="gap:6px"><div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n} ${g.n === 1 ? 'bill' : 'bills'}</span></span><strong class="num">${money(g.total)}</strong></div><div class="meter"><div style="width:${Math.max(2, Math.round((g.total / fMax) * 100))}%"></div></div></div>`).join('')}
      </section>
      <section class="card" aria-label="By category">
        <h2>By category · ${monthLabel(S.month, true)}</h2>
        ${byCat.map((g) => `<div class="row between small"><span>${esc(g.name)} <span class="muted">· ${g.n}</span></span><strong class="num">${money(g.total)}</strong></div>`).join('')}
      </section>`;
  }

  function settingsTab() {
    const m = S.member || {};
    const owner = m.role === 'owner';
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
        <h2>Bill reminders</h2>
        ${push}
        <form class="grid2" data-form="remind">
          <div class="field"><label for="s-days">Remind me</label><select class="input" id="s-days" name="remind_days" data-change="remind">${days}</select></div>
          <div class="field"><label for="s-hour">At</label><select class="input" id="s-hour" name="remind_hour" data-change="remind">${hours}</select></div>
        </form>
        <p class="small muted">You’ll also get a reminder on the due day and the day after if it’s still unpaid. Bills marked autopay are skipped.</p>
      </section>
      <section class="card" aria-label="Install">
        <h2>Install on your phone</h2>
        ${install}
      </section>
      <section class="card" aria-label="Calendar and export">
        <h2>Calendar &amp; export</h2>
        <p class="small muted">Add every due date to your phone’s calendar as a monthly repeating event with an alert.</p>
        <button class="btn block" data-act="ics">Add due dates to calendar</button>
        <button class="btn block" data-act="csv">Download payment history (CSV)</button>
      </section>
      <section class="card" aria-label="House">
        <h2>House</h2>
        <form class="stack" data-form="house">
          <div class="field"><label for="h-name">Name</label><input class="input" id="h-name" name="name" value="${esc(S.household && S.household.name)}"></div>
          <div class="field"><label for="h-addr">Address</label><input class="input" id="h-addr" name="address" value="${esc(S.household && S.household.address)}"></div>
          <button class="btn" type="submit">Save house details</button>
        </form>
        ${owner ? `<div class="stack" style="gap:6px"><span class="lab small muted" style="font-weight:600">House code — share it to let someone else join</span>
          <div class="row between wrap"><span class="code">${esc(S.household && S.household.claim_code)}</span>
          <div class="btns"><button class="btn" data-act="copy" data-text="${esc(S.household && S.household.claim_code)}">Copy</button><button class="btn" data-act="rotate">New code</button></div></div></div>` : ''}
      </section>
      <section class="card" aria-label="Account">
        <h2>Account</h2>
        <p class="small muted">Signed in as ${esc(S.user && S.user.email)}</p>
        <button class="btn block" data-act="refresh">Refresh data</button>
        <button class="btn block danger" data-act="signout">Sign out</button>
      </section>
      <p class="small muted" style="text-align:center">Evergreen House · v1.0</p>`;
  }

  function sheetView() {
    const b = S.bills.find((x) => x.id === S.sheet);
    if (!b) return '';
    const pay = getPay(b, S.month) || {};
    const amt = amountFor(b, pay);
    const paidDate = pay.paid_at ? isoDate(new Date(pay.paid_at)) : '';
    return `<div class="sheet-bg" data-act="sheet-close-bg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="grabber" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="sheet-title" class="display">${esc(billTitle(b))}</h2><button class="iconbtn" data-act="sheet-close" aria-label="Close">${ICON.close}</button></div>
      <form class="stack" data-form="sheet" novalidate>
        <section class="card">
          <h2>${monthLabel(S.month)}</h2>
          <div class="grid2">
            <div class="field"><label for="p-amt">Amount ($)</label><input class="input num" id="p-amt" name="p_amount" inputmode="decimal" value="${amt != null ? amt.toFixed(2) : ''}" placeholder="0.00"></div>
            <div class="field"><label for="p-date">Paid on</label><input class="input" id="p-date" name="p_paid" type="date" value="${paidDate}"></div>
          </div>
          <div class="grid2">
            <div class="field"><label for="p-method">Paid with</label><select class="input" id="p-method" name="p_method"><option value="">—</option>${METHODS.map((x) => `<option ${x === pay.method ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div class="field"><label for="p-conf">Confirmation #</label><input class="input" id="p-conf" name="p_confirmation" value="${esc(pay.confirmation)}"></div>
          </div>
          <div class="field"><label for="p-note">Note</label><input class="input" id="p-note" name="p_note" value="${esc(pay.note)}"></div>
          <div class="field"><span class="lab">Bill photo or receipt</span>
            ${pay.receipt_path ? `<div class="btns"><button type="button" class="btn" data-act="receipt-view">View</button><button type="button" class="btn danger" data-act="receipt-remove">Remove</button></div><div id="receipt-slot"></div>` :
              `<label class="btn" style="width:100%"><input type="file" accept="image/*,application/pdf" class="sr" data-change="receipt"> Add photo or PDF</label>`}
          </div>
        </section>
        <section class="card">
          <h2>Bill details</h2>
          <div class="field"><label for="b-name">Provider / name</label><input class="input" id="b-name" name="name" value="${esc(b.name)}" required></div>
          <div class="grid2">
            <div class="field"><label for="b-label">Label</label><input class="input" id="b-label" name="label" value="${esc(b.label)}"></div>
            <div class="field"><label for="b-acct">Account #</label><input class="input num" id="b-acct" name="account_number" value="${esc(b.account_number)}"></div>
          </div>
          <div class="grid2">
            <div class="field"><label for="b-cat">Category</label><select class="input" id="b-cat" name="category">${catOptions(b.category)}</select></div>
            <div class="field"><label for="b-unit">Floor</label><select class="input" id="b-unit" name="unit_id">${unitOptions(b.unit_id)}</select></div>
          </div>
          <div class="grid2">
            <div class="field"><label for="b-day">Due day</label><input class="input num" id="b-day" name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${b.due_day || ''}"></div>
            <div class="field"><label for="b-def">Usual amount ($)</label><input class="input num" id="b-def" name="default_amount" inputmode="decimal" value="${b.default_amount != null ? Number(b.default_amount).toFixed(2) : ''}"></div>
          </div>
          <label class="checkrow"><input type="checkbox" name="fixed" ${b.amount_type === 'fixed' ? 'checked' : ''}> Same amount every month</label>
          <label class="checkrow"><input type="checkbox" name="autopay" ${b.autopay ? 'checked' : ''}> Paid automatically (autopay)</label>
          <div class="field"><label for="b-url">Payment website</label><input class="input" id="b-url" name="pay_url" type="url" inputmode="url" value="${esc(b.pay_url)}" placeholder="https://"></div>
          <div class="field"><label for="b-notes">Notes</label><textarea class="input" id="b-notes" name="notes">${esc(b.notes)}</textarea></div>
        </section>
        ${S.sheetErr ? `<p class="err" role="alert">${esc(S.sheetErr)}</p>` : ''}
        <button class="btn primary block" type="submit">Save</button>
        <button type="button" class="btn block danger" data-act="delete-bill">${S.deleteArm ? 'Tap again to delete this bill and its history' : 'Delete bill'}</button>
      </form>
    </div></div>`;
  }

  // ---------- actions ----------
  function findBill(id) { return S.bills.find((b) => b.id === id); }

  async function onAct(el) {
    const act = el.dataset.act;
    const id = el.dataset.id;
    switch (act) {
      case 'tab': S.tab = el.dataset.tab; S.addErr = ''; S.addOk = ''; window.scrollTo(0, 0); render(); break;
      case 'month': S.month = addMonths(S.month, Number(el.dataset.delta)); S.editing = null; render(); break;
      case 'month-today': S.month = monthKey(new Date()); render(); break;
      case 'unit': S.unit = el.dataset.unit; render(); break;
      case 'filter': S.filter = el.dataset.filter; render(); break;
      case 'edit': { S.editing = id; render(); const f = document.getElementById('a-' + id); if (f) f.focus(); break; }
      case 'done': S.editing = null; render(); break;
      case 'toggle': {
        const b = findBill(id); const pay = getPay(b, S.month);
        if (pay && pay.paid_at) savePayment(b, S.month, { paid_at: null });
        else savePayment(b, S.month, { paid_at: new Date().toISOString(), amount: amountFor(b, pay), method: (pay && pay.method) || (b.autopay ? 'Autopay' : null) });
        render();
        if (!(pay && pay.paid_at)) toast('Marked paid');
        break;
      }
      case 'copy':
        try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied ' + el.dataset.text); } catch (_) { toast(el.dataset.text); }
        break;
      case 'details': S.sheet = id; S.sheetErr = ''; S.deleteArm = false; render(); break;
      case 'sheet-close': S.sheet = null; render(); break;
      case 'sheet-close-bg': S.sheet = null; render(); break;
      case 'delete-bill':
        if (!S.deleteArm) { S.deleteArm = true; render(); break; }
        deleteBill(S.sheet); S.sheet = null; S.deleteArm = false; render(); toast('Bill deleted'); break;
      case 'receipt-view': await viewReceipt(); break;
      case 'receipt-remove': {
        const b = findBill(S.sheet); const pay = getPay(b, S.month);
        if (pay && pay.receipt_path) { sb.storage.from('receipts').remove([pay.receipt_path]); savePayment(b, S.month, { receipt_path: null }); render(); }
        break;
      }
      case 'auth-mode': S.authMode = el.dataset.mode; S.authErr = ''; S.authMsg = ''; render(); break;
      case 'signout':
        await sb.auth.signOut(); try { localStorage.removeItem(cacheKey()); localStorage.removeItem(OUTBOX); } catch (_) {}
        S.user = null; S.household = null; S.view = 'auth'; S.authMode = 'signin'; render(); break;
      case 'refresh': await loadAll(); toast('Up to date'); break;
      case 'push-on': await enablePush(); break;
      case 'push-off': await disablePush(); break;
      case 'push-test': await testPush(); break;
      case 'install': if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); } break;
      case 'ics': downloadICS(); break;
      case 'csv': downloadCSV(); break;
      case 'rotate': {
        const r = await sb.rpc('rotate_house_code', { h: S.household.id });
        if (r.error) toast(r.error.message); else { S.household.claim_code = r.data; saveCache(); render(); toast('New house code made'); }
        break;
      }
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
      const nextId = kind === 'due' ? 'a-' + b.id : null;
      render();
      if (nextId) { const n = document.getElementById(nextId); if (n && !n.value) n.focus(); }
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
    if (kind === 'auth') {
      const email = val('email'), password = String(fd.get('password') || '');
      S.authErr = ''; S.authMsg = '';
      if (!email) { S.authErr = 'Enter your email.'; return render(); }
      S.busy = true; render();
      let r;
      if (S.authMode === 'forgot') {
        r = await sb.auth.resetPasswordForEmail(email, { redirectTo: CFG.APP_URL });
        S.busy = false;
        if (r.error) S.authErr = r.error.message; else S.authMsg = 'Check your email for a reset link.';
      } else if (S.authMode === 'signup') {
        if (password.length < 8) { S.busy = false; S.authErr = 'Use at least 8 characters.'; return render(); }
        r = await sb.auth.signUp({ email, password, options: { emailRedirectTo: CFG.APP_URL } });
        S.busy = false;
        if (r.error) S.authErr = r.error.message;
        else if (!r.data.session) { S.authMode = 'signin'; S.authMsg = 'Almost done: open the email we sent and tap the confirm link, then sign in here.'; }
      } else {
        r = await sb.auth.signInWithPassword({ email, password });
        S.busy = false;
        if (r.error) S.authErr = /confirm/i.test(r.error.message) ? 'Confirm your email first — check your inbox for the link.' : r.error.message;
      }
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
    } else if (kind === 'add') {
      S.addErr = ''; S.addOk = '';
      const name = val('name');
      if (!name) { S.addErr = 'Give the bill a name.'; return render(); }
      const day = parseInt(val('due_day'), 10);
      if (val('due_day') && !(day >= 1 && day <= 31)) { S.addErr = 'Due day must be 1–31.'; return render(); }
      const amount = num(val('amount'));
      const fixed = !!fd.get('fixed');
      const b = {
        id: uuid(), household_id: S.household.id, unit_id: val('unit_id') || null, name, label: val('label') || null,
        category: val('category') || 'Other', account_number: val('account_number') || null, due_day: day || null,
        amount_type: fixed ? 'fixed' : 'variable', default_amount: fixed ? amount : null, autopay: !!fd.get('autopay'),
        pay_url: val('pay_url') || null, notes: null, active: true, created_at: new Date().toISOString()
      };
      saveBill(b);
      if (amount != null && !fixed) savePayment(b, S.month, { amount });
      S.addOk = 'Added ' + name + '. It’s on the Bills tab.';
      render();
    } else if (kind === 'sheet') {
      const b = findBill(S.sheet);
      const name = val('name');
      if (!name) { S.sheetErr = 'Name can’t be empty.'; return render(); }
      const day = parseInt(val('due_day'), 10);
      const fixed = !!fd.get('fixed');
      const nb = Object.assign({}, b, {
        name, label: val('label') || null, account_number: val('account_number') || null, category: val('category'),
        unit_id: val('unit_id') || null, due_day: day >= 1 && day <= 31 ? day : null, default_amount: num(val('default_amount')),
        amount_type: fixed ? 'fixed' : 'variable', autopay: !!fd.get('autopay'), pay_url: val('pay_url') || null, notes: val('notes') || null
      });
      saveBill(nb);
      const paidOn = val('p_paid');
      const pay = getPay(nb, S.month);
      let paidAt = null;
      if (paidOn) {
        const keep = pay && pay.paid_at && isoDate(new Date(pay.paid_at)) === paidOn;
        paidAt = keep ? pay.paid_at : new Date(paidOn + 'T12:00:00').toISOString();
      }
      savePayment(nb, S.month, { amount: num(val('p_amount')), paid_at: paidAt, method: val('p_method') || null, confirmation: val('p_confirmation') || null, note: val('p_note') || null });
      S.sheet = null; render(); toast('Saved');
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
    const b = findBill(S.sheet);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = S.household.id + '/' + b.id + '/' + S.month.slice(0, 7) + '-' + Date.now() + '.' + ext;
    toast('Uploading…');
    const r = await sb.storage.from('receipts').upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (r.error) return toast('Upload failed: ' + r.error.message);
    savePayment(b, S.month, { receipt_path: path });
    render(); toast('Photo saved');
  }
  async function viewReceipt() {
    const b = findBill(S.sheet); const pay = getPay(b, S.month);
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
    const bills = S.bills.filter((b) => b.active !== false && b.due_day);
    if (!bills.length) return toast('Add due days to your bills first.');
    const t = today(); const remind = (S.member && S.member.remind_days) || 0; const hour = S.member && S.member.remind_hour != null ? S.member.remind_hour : 9;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const fold = (s) => s.replace(/[\\,;]/g, (c) => '\\' + c);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Evergreen House//Bills//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:House bills'];
    bills.forEach((b) => {
      let d = new Date(t.getFullYear(), t.getMonth(), Math.min(b.due_day, daysIn(t.getFullYear(), t.getMonth() + 1)));
      if (d < t) d = new Date(t.getFullYear(), t.getMonth() + 1, Math.min(b.due_day, daysIn(t.getFullYear(), t.getMonth() + 2)));
      const ds = isoDate(d).replace(/-/g, '');
      const de = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)).replace(/-/g, '');
      const rule = 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (b.due_day === 31 ? '-1' : b.due_day);
      const hrs = remind * 24 - hour;
      const trigger = hrs > 0 ? '-PT' + hrs + 'H' : 'PT' + (-hrs) + 'H';
      const amt = b.amount_type === 'fixed' && b.default_amount != null ? ' (' + money(b.default_amount) + ')' : '';
      lines.push('BEGIN:VEVENT', 'UID:' + b.id + '@evergreen-house', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ds, 'DTEND;VALUE=DATE:' + de,
        rule,
        'SUMMARY:' + fold('Pay ' + billTitle(b) + amt),
        'DESCRIPTION:' + fold(unitName(b.unit_id) + (b.account_number ? ' · Account ' + b.account_number : '') + (b.pay_url ? ' · ' + b.pay_url : '')),
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + fold(billTitle(b) + ' is due'), 'TRIGGER:' + trigger, 'END:VALARM', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    download('house-bills.ics', lines.join('\r\n'), 'text/calendar');
  }
  function downloadCSV() {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Month', 'Bill', 'Floor', 'Category', 'Account', 'Amount', 'Due date', 'Paid on', 'Method', 'Confirmation', 'Note']];
    Object.values(S.payments).sort((a, b) => a.period.localeCompare(b.period)).forEach((p) => {
      const b = S.bills.find((x) => x.id === p.bill_id); if (!b) return;
      rows.push([p.period.slice(0, 7), billTitle(b), unitName(b.unit_id), b.category, b.account_number, amountFor(b, p), p.due_date, p.paid_at ? isoDate(new Date(p.paid_at)) : '', p.method, p.confirmation, p.note]);
    });
    download('house-bills-' + isoDate(new Date()) + '.csv', rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.view === 'app' && navigator.onLine) loadAll(); });

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
