(() => {
  'use strict';
  let adminKey = '';
  let refreshTimer = null;
  const $ = id => document.getElementById(id);
  const number = value => new Intl.NumberFormat().format(value || 0);
  const bytes = value => {
    if (!value) return '0 B';
    const units = ['B','KB','MB','GB']; let n = value, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  };
  const duration = seconds => {
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };

  async function loadStats(initial = false) {
    try {
      const response = await fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${adminKey}` }, cache: 'no-store' });
      if (!response.ok) throw new Error('Access denied');
      const stats = await response.json();
      render(stats);
      $('login').hidden = true;
      $('dashboard').hidden = false;
      history.replaceState({ signedOut: false }, '', '/admin');
      $('login-error').textContent = '';
      if (!refreshTimer) refreshTimer = setInterval(loadStats, 15000);
    } catch (error) {
      if (initial) {
        adminKey = '';
        $('login-error').textContent = 'Access key not recognised.';
        $('admin-key').select();
      } else {
        $('live-dot').textContent = 'Reconnecting';
      }
    }
  }

  function render(s) {
    $('live-dot').textContent = 'Live';
    $('updated').textContent = `Updated ${new Date(s.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
    $('registered-identities').textContent = number(s.live.registeredIdentities);
    $('active-vaults').textContent = number(s.live.activeVaults);
    $('vault-mix').textContent = `${number(s.live.occupiedVaults)} connected · ${number(s.live.temporaryVaults)} temporary`;
    $('signal-sockets').textContent = number(s.live.authenticatedSignalSockets);
    $('calls-now').textContent = number(s.live.activeCalls + s.live.ringingCalls);
    $('calls-detail').textContent = `${number(s.live.activeCalls)} connected · ${number(s.live.ringingCalls)} ringing`;
    $('total-created').textContent = number(s.lifetime.totalRoomsCreated);
    $('permanent-pct').textContent = `${s.lifetime.permanentPct}%`;
    $('joins').textContent = number(s.lifetime.joins);
    $('messages').textContent = number(s.lifetime.messagesRelayed);
    $('calls-started').textContent = number(s.lifetime.callsStarted);
    const answerRate = s.lifetime.callsStarted ? Math.round(s.lifetime.callsAnswered / s.lifetime.callsStarted * 100) : 0;
    $('answer-rate').textContent = `${number(s.lifetime.callsAnswered)} (${answerRate}%)`;
    setGauge('memory', s.system.ciphertextBytes, s.system.ciphertextBudgetBytes);
    $('memory-detail').textContent = `${bytes(s.system.ciphertextBytes)} of ${bytes(s.system.ciphertextBudgetBytes)}`;
    setGauge('room', s.live.activeVaults, s.system.roomCapacity);
    $('room-detail').textContent = `${number(s.live.activeVaults)} of ${number(s.system.roomCapacity)}`;
    $('uptime').textContent = duration(s.system.uptimeSeconds);
    $('node-version').textContent = s.system.nodeVersion;
    $('cipher-count').textContent = number(s.live.storedCiphertextMessages);
    renderIdentities(s.identities || []);
    renderChart(s.daily || []);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  }

  function formatPrivateNumber(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
    return digits.length === 10 ? `${digits.slice(0,2)}-${digits.slice(2,6)}-${digits.slice(6)}` : digits || '—';
  }

  function formatDate(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString([], { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function renderIdentities(identities) {
    $('identity-count').textContent = `${number(identities.length)} total`;
    $('identity-rows').innerHTML = identities.length ? identities.map(identity => `<tr>
      <td><strong>${escapeHtml(identity.displayName || 'Unnamed')}</strong></td>
      <td><a href="/${encodeURIComponent(identity.privateNumber)}" target="_blank" rel="noopener">${escapeHtml(formatPrivateNumber(identity.privateNumber))}</a></td>
      <td>${escapeHtml(formatDate(identity.createdAt))}</td>
      <td>${escapeHtml(formatDate(identity.updatedAt))}</td>
      <td><span class="count-pill">${number(identity.activeDevices)}</span></td>
      <td><span class="status-dot ${identity.notificationDevices ? 'on' : ''}"></span>${identity.notificationDevices ? `${number(identity.notificationDevices)} ready` : 'Not enabled'}</td>
      <td>${number(identity.pendingRequests)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">No registered identities yet.</td></tr>';
  }

  function setGauge(prefix, value, max) {
    const pct = max ? Math.min(100, Math.round(value / max * 100)) : 0;
    $(`${prefix}-ring`).style.setProperty('--value', pct);
    $(`${prefix}-pct`).textContent = `${pct}%`;
  }

  function renderChart(rows) {
    const dates = []; const today = new Date();
    for (let i = 13; i >= 0; i--) { const d = new Date(today); d.setDate(today.getDate() - i); dates.push(d.toISOString().slice(0,10)); }
    const byDate = new Map(rows.map(r => [r.date, r]));
    const vaults = dates.map(d => { const r = byDate.get(d) || {}; return (r.vaultsTemporary || 0) + (r.vaultsPermanent || 0); });
    const messages = dates.map(d => (byDate.get(d) || {}).messages || 0);
    const max = Math.max(1, ...vaults, ...messages);
    const W = 800, H = 220, pad = 28;
    const points = values => values.map((v,i) => `${pad + i*(W-pad*2)/(values.length-1)},${H-pad-v*(H-pad*2)/max}`).join(' ');
    const grid = [0,.25,.5,.75,1].map(x => `<line x1="${pad}" y1="${pad+x*(H-pad*2)}" x2="${W-pad}" y2="${pad+x*(H-pad*2)}" stroke="#eadfe3"/>`).join('');
    const labels = dates.map((d,i) => i % 3 === 0 || i === 13 ? `<text x="${pad+i*(W-pad*2)/13}" y="218" text-anchor="middle" fill="#8a7a82" font-size="11">${new Date(`${d}T12:00:00`).toLocaleDateString([], {month:'short',day:'numeric'})}</text>` : '').join('');
    $('trend-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"><title>Conversations and messages over the last fourteen days</title>${grid}<polyline points="${points(messages)}" fill="none" stroke="#71947c" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><polyline points="${points(vaults)}" fill="none" stroke="#682c43" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${labels}</svg>`;
  }

  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    adminKey = $('admin-key').value;
    $('admin-key').value = '';
    loadStats(true);
  });
  $('refresh').addEventListener('click', () => loadStats(false));
  function signOut() {
    adminKey = '';
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    $('admin-key').value = '';
    $('login-error').textContent = '';
    $('dashboard').hidden = true;
    $('login').hidden = false;
    history.replaceState({ signedOut: true }, '', '/admin');
    $('admin-key').focus();
  }
  $('signout').addEventListener('click', signOut);
  window.addEventListener('pageshow', event => {
    // Safari/Chrome may restore the page from their back-forward cache.
    // Never let that resurrect a dashboard that was signed out.
    if (event.persisted && history.state && history.state.signedOut) signOut();
  });
})();
