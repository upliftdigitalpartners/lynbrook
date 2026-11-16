/* Tenant page: rent balance + repair requests, opened from the landlord's private link (?t=TOKEN). */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG;
  const API = CFG.SUPABASE_URL + '/functions/v1/tenant';
  const token = new URLSearchParams(location.search).get('t') || '';
  const el = document.getElementById('tp');
  let data = null, sending = false, msg = '', err = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const monthName = (p) => { const [y, m] = p.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
  const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const thisPeriod = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'; };
  const STATUS = { new: ['Sent', 'soon'], scheduled: ['Scheduled', 'up'], done: ['Fixed', 'paid'], closed: ['Closed', 'up'] };

  async function load() {
    if (!token) { el.innerHTML = '<p class="notice">This page needs the private link your landlord sent you.</p>'; return; }
    try {
      const r = await fetch(API + '?t=' + encodeURIComponent(token), { headers: { apikey: CFG.SUPABASE_ANON_KEY } });
      const j = await r.json();
      if (!r.ok) { el.innerHTML = `<p class="notice">${esc(j.error || 'This link isn’t working.')}</p>`; return; }
      data = j; render();
    } catch (_) { el.innerHTML = '<p class="notice">Can’t connect right now. Check your internet and refresh.</p>'; }
  }

  function render() {
    const d = data;
    const cur = d.payments.find((p) => p.period === thisPeriod());
    const due = Number((cur && cur.amount_due) ?? d.rent ?? 0);
    const got = Number((cur && cur.amount_received) || 0);
    const left = Math.max(0, due - got);
    let status = '';
    if (d.rent != null) {
      if (left <= 0 && due > 0) status = `<span class="pill paid">Paid${cur && cur.received_at ? ' ' + fmt(cur.received_at) : ''}</span>`;
      else if (got > 0) status = `<span class="pill soon">${money(got)} received · ${money(left)} left</span>`;
      else status = `<span class="pill up">Due the ${ord(d.due_day)}</span>`;
    }
    el.innerHTML = `
      <div class="stack" style="gap:4px">
        <span class="eyebrow small muted" style="font-weight:600;letter-spacing:.06em;text-transform:uppercase">${esc([d.address && d.address.split(',')[0], d.unit].filter(Boolean).join(' · '))}</span>
        <h1 class="display">Hi${d.tenant ? ' ' + esc(d.tenant.split(' ')[0]) : ''}</h1>
        <p class="lead muted">Your rent and repair requests.</p>
      </div>
      ${d.rent != null ? `<section class="hero" aria-label="This month">
        <div class="stack" style="gap:2px"><span class="label">${esc(monthName(thisPeriod()))} · left to pay</span><span class="big display num">${money(left)}</span></div>
        <div class="foot"><span>Rent ${money(due)} · due the ${ord(d.due_day)}${d.grace_days ? ' (' + d.grace_days + '-day grace)' : ''}</span></div>
      </section>${status}` : ''}
      ${d.pay_zelle && left > 0 ? `<section class="card" aria-label="How to pay"><h2>How to pay</h2>
        <p class="lead">Send <strong>${money(left)}</strong> with Zelle in your bank app to:</p>
        <div class="row between wrap" style="gap:8px"><strong style="font-size:18px;word-break:break-all">${esc(d.pay_zelle)}</strong><button type="button" class="btn" id="copy-zelle">Copy</button></div>
        ${d.pay_note ? `<p class="small muted">${esc(d.pay_note)}</p>` : `<p class="small muted">Memo: ${esc(monthName(thisPeriod()).split(' ')[0])} rent${d.unit ? ', ' + esc(d.unit) : ''}</p>`}
      </section>` : ''}
      ${d.payments.length ? `<section class="card" aria-label="Payment history"><h2>Payment history</h2>
        <table class="tbl"><thead><tr><th scope="col">Month</th><th scope="col">Rent</th><th scope="col">Paid</th></tr></thead><tbody>
        ${d.payments.map((p) => `<tr><th scope="row">${esc(monthName(p.period))}</th><td class="num">${money(p.amount_due)}</td><td class="num">${money(p.amount_received)}</td></tr>`).join('')}
        </tbody></table>
        <p class="small muted">Payments show up here once your landlord records them.</p></section>` : ''}
      <form class="card" id="req" novalidate>
        <h2>Report a repair</h2>
        <div class="field"><label for="t-title">What needs fixing?</label><input class="input" id="t-title" name="title" maxlength="120" required placeholder="e.g. Kitchen sink is leaking"></div>
        <div class="field"><label for="t-details">Details <span class="muted">(optional)</span></label><textarea class="input" id="t-details" name="details" maxlength="4000" placeholder="Where is it, when did it start, best time to come in…"></textarea></div>
        <div class="field"><label for="t-photo">Photo <span class="muted">(optional)</span></label><input class="input" id="t-photo" name="photo" type="file" accept="image/*" style="padding:10px"></div>
        <label class="checkrow"><input type="checkbox" name="urgent"> Urgent: no heat, no water, leak, or a safety problem</label>
        ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
        ${msg ? `<p class="ok" role="status">${esc(msg)}</p>` : ''}
        <button class="btn primary block" type="submit" ${sending ? 'disabled' : ''}>${sending ? 'Sending…' : 'Send request'}</button>
        <p class="small muted">For emergencies like gas smells, fire or flooding, call 911 or the utility first.</p>
      </form>
      ${d.requests.length ? `<section class="card" aria-label="Your requests"><h2>Your requests</h2>
        ${d.requests.map((q) => `<div class="req"><div class="stack" style="gap:2px"><strong>${esc(q.title)}</strong><span class="small muted">Sent ${fmt(q.created_at)}</span>${q.reply ? `<span class="small">Landlord: ${esc(q.reply)}</span>` : ''}</div><span class="pill ${(STATUS[q.status] || STATUS.new)[1]}" style="margin:0;flex:none">${(STATUS[q.status] || STATUS.new)[0]}</span></div>`).join('')}
      </section>` : ''}`;
  }

  function shrink(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1600, s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ name: 'photo.jpg', type: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.82).split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'copy-zelle') {
      try { await navigator.clipboard.writeText(data.pay_zelle); e.target.textContent = 'Copied'; } catch (_) { e.target.textContent = data.pay_zelle; }
    }
  });
  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    const fd = new FormData(e.target);
    const title = String(fd.get('title') || '').trim();
    err = ''; msg = '';
    if (!title) { err = 'Say what needs fixing.'; return render(); }
    sending = true; render();
    try {
      const file = fd.get('photo');
      const photo = file && file.size ? await shrink(file) : null;
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ t: token, title, details: fd.get('details'), urgency: fd.get('urgent') ? 'urgent' : 'normal', photo }) });
      const j = await r.json();
      sending = false;
      if (!r.ok) { err = j.error || 'Couldn’t send it.'; return render(); }
      msg = 'Sent. Your landlord has been notified.';
      await load();
    } catch (_) { sending = false; err = 'Couldn’t send it. Check your internet and try again.'; render(); }
  });

  load();
})();
