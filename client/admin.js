(() => {
  'use strict';
  let adminKey = '';
  let refreshTimer = null;
  let healthTimer = null, healthBusy = false;
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
    const key = adminKey;
    try {
      const response = await fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' });
      if (!response.ok) throw new Error('Access denied');
      const stats = await response.json();
      if (!adminKey || adminKey !== key) return;
      render(stats);
      if (!healthTimer) { loadHealth(); healthTimer=setInterval(loadHealth,30000); }
      loadSafetyReports();
      $('login').hidden = true;
      $('dashboard').hidden = false;
      history.replaceState({ signedOut: false }, '', '/admin');
      $('login-error').textContent = '';
      if (!refreshTimer) refreshTimer = setInterval(loadStats, 15000);
    } catch (error) {
      if (!adminKey || adminKey !== key) return;
      if (initial) {
        adminKey = '';
        $('login-error').textContent = 'Access key not recognised.';
        $('admin-key').select();
      } else {
        $('live-dot').textContent = 'Reconnecting';
      }
    }
  }

  async function loadHealth() {
    if (healthBusy || !adminKey) return;
    const key=adminKey;
    healthBusy=true;
    try {
      const response=await fetch('/api/admin/health',{headers:{Authorization:`Bearer ${key}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw Error('unavailable');
      const data=await response.json();
      if (adminKey!==key) return;
      const labels={healthy:'Healthy',warning:'Needs attention',down:'Check failed',unknown:'Unknown',configured:'Configured · not tested'};
      $('service-health-summary').textContent=labels[data.status] || 'Unknown';
      $('service-health-updated').textContent=`Last checked ${new Date(data.checkedAt).toLocaleString()}`;
      const cards=data.services.map(service=>{
        const card=document.createElement('article'); card.className='service-health-card';
        const title=document.createElement('h3');title.textContent=service.name;
        const badge=document.createElement('span');badge.className=`service-status ${Object.hasOwn(labels,service.status)?service.status:'unknown'}`;badge.textContent=labels[service.status] || 'Unknown';
        const detail=document.createElement('p');detail.textContent=service.detail;
        const time=document.createElement('small');time.textContent=service.status==='configured'?'No live probe':`Check ${service.latencyMs} ms`;
        if(service.version) time.textContent+=` · Build ${service.version} · Memory ${service.memoryMB} MB`;
        if(service.providerCheckedAt) time.textContent+=` · Provider fetched ${new Date(service.providerCheckedAt).toLocaleTimeString()}`;
        card.append(title,badge,detail,time);return card;
      });
      $('service-health-cards').replaceChildren(...cards);
      const events=data.history.map(event=>{const item=document.createElement('li');item.textContent=`${new Date(event.at).toLocaleString()} · ${event.name}: ${labels[event.from]} → ${labels[event.to]}`;return item;});
      if (!events.length) {const item=document.createElement('li');item.textContent='No status changes recorded yet.';events.push(item);}
      $('service-health-history').replaceChildren(...events);
    } catch (_) {
      if(adminKey===key) {
        $('service-health-summary').textContent='Unavailable · previous results are stale';
        $('service-health-cards').replaceChildren();
      }
    } finally {healthBusy=false;}
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
    const health = s.system.healthStatus || 'degraded';
    $('health-pill').textContent = health.charAt(0).toUpperCase() + health.slice(1);
    $('health-pill').className = `health-pill ${health === 'healthy' ? '' : health}`;
    $('health-pill').style.background = health === 'healthy' ? '#e1eee6' : health === 'degraded' ? '#f8e5d6' : '#f5dce2';
    $('health-pill').style.color = health === 'healthy' ? '#397052' : health === 'degraded' ? '#8a4d1f' : '#9d2946';
    setGauge('notification', s.live.notificationReadyIdentities, s.live.registeredIdentities);
    $('notification-detail').textContent = `${number(s.live.notificationReadyIdentities)} of ${number(s.live.registeredIdentities)} identities ready`;
    setGauge('room', s.live.activeConversations, s.system.roomCapacity);
    $('room-detail').textContent = `${number(s.live.activeConversations)} active · ${number(s.system.roomCapacity)} single-instance limit`;
    setGauge('memory', s.system.ciphertextBytes, s.system.ciphertextBudgetBytes);
    $('memory-detail').textContent = `${bytes(s.system.ciphertextBytes)} of ${bytes(s.system.ciphertextBudgetBytes)} safe buffer`;
    $('storage-status').textContent = s.system.durableStorage;
    $('identity-sessions').textContent = number(s.live.activeIdentitySessions);
    $('uptime').textContent = duration(s.system.uptimeSeconds);
    $('node-version').textContent = s.system.nodeVersion;
    $('cipher-count').textContent = number(s.live.storedCiphertextMessages);
    renderIdentities(s.identities || []);
    renderChart(s.daily || []);
  }

  async function loadSafetyReports() {
    const key = adminKey;
    try {
      const response = await fetch('/api/admin/safety',{headers:{Authorization:`Bearer ${key}`},cache:'no-store'});
      if (!response.ok) throw Error('Report queue unavailable. Refresh and follow up before the 24-hour deadline.');
      const data=await response.json();
      if (!adminKey || key !== adminKey) return;
      // Avoid replacing an operator's unsaved review note during refresh.
      if ($('safety-reports').contains(document.activeElement) || [...$('safety-reports').querySelectorAll('textarea')].some(input=>input.value.trim())) return;
      $('safety-error').textContent='';
      const open=data.reports.filter(r=>!['resolved','dismissed'].includes(r.status));
      $('safety-summary').textContent=`${open.length} open · ${open.filter(r=>r.overdue).length} overdue`;
      $('safety-reports').replaceChildren();
      if(!data.reports.length) $('safety-reports').textContent='No reports received.';
      for(const r of data.reports) {
        const details=document.createElement('details'); details.className='safety-report';
        const summary=document.createElement('summary');
        summary.textContent=`${r.overdue?'OVERDUE · ':''}${r.reason} · ${r.status} · ${formatDate(r.createdAt)} · ${r.id}`;
        const due=document.createElement('p'); due.textContent=`Review due: ${formatDate(r.dueAt)}`;
        const evidence=document.createElement('pre'); evidence.className='safety-evidence';
        evidence.textContent=`Reporter's details: ${r.details || '(none)'}\n\n`+(r.messages?.length?r.messages.map(m=>`${m.isReporter?'Reporter':'Other participant'}: ${m.content}`).join('\n'):'No message excerpts shared.');
        const history=document.createElement('p'); history.textContent=(r.history||[]).map(h=>`${formatDate(h.at)} · ${h.status}: ${h.note}`).join('\n');
        const form=document.createElement('form');
        const note=document.createElement('textarea'); note.required=true; note.maxLength=950; note.placeholder='Record your assessment, action taken, and any follow-up. Never paste passwords or keys.';note.setAttribute('aria-label','Review note');
        const select=document.createElement('select');select.setAttribute('aria-label','Report status');
        for(const [value,label] of [['reviewing','In review'],['resolved','Resolved'],['dismissed','Dismissed with explanation']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
        const close=document.createElement('input'); close.type='checkbox'; close.disabled=!r.canClose;
        const closeLabel=document.createElement('label');closeLabel.append(close,document.createTextNode(' Close the reported conversation for both participants (irreversible).'));
        const accountAction=document.createElement('select');accountAction.setAttribute('aria-label','Reported account action');accountAction.disabled=!r.canModerateAccount;
        for(const [value,label] of [['none','No account change'],['suspend','Suspend new connections and close reported conversation'],['restore','Restore reported account after appeal']]){const option=document.createElement('option');option.value=value;option.textContent=label;accountAction.append(option);}
        const save=document.createElement('button');save.type='submit';save.textContent='Save review';
        form.append(note,select,accountAction,closeLabel,save);
        form.addEventListener('submit',async event=>{
          event.preventDefault();
          if((close.checked || accountAction.value!=='none') && select.value!=='resolved'){ $('safety-error').textContent='Select Resolved when closing the reported conversation.';return; }
          if((close.checked || accountAction.value==='suspend') && !confirm('This closes conversations permanently. Suspension prevents new connections until restored. Continue?'))return;
          save.disabled=true;
          try{
            const response=await fetch('/api/admin/safety',{method:'POST',headers:{Authorization:`Bearer ${adminKey}`,'Content-Type':'application/json'},body:JSON.stringify({id:r.id,status:select.value,note:note.value,expectedUpdatedAt:r.updatedAt,closeConversation:close.checked,accountAction:accountAction.value})});
            const result=await response.json();if(!response.ok)throw Error(result.error||'Review could not be saved.');
            note.value=''; save.blur(); await loadSafetyReports();
          }catch(error){$('safety-error').textContent=error.message;}finally{save.disabled=false;}
        });
        details.append(summary,due,evidence,history,form);$('safety-reports').append(details);
      }
    }catch(error){if(adminKey===key)$('safety-error').textContent=error.message;}
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

  function clearClaimQr() {
    const canvas=$('allocate-qr');
    canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  }
  function renderClaimQr(link) {
    const qr=qrcode(0,'M');qr.addData(link);qr.make();
    const canvas=$('allocate-qr'), count=qr.getModuleCount(), cell=6, size=(count+8)*cell;
    canvas.width=canvas.height=size;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,size,size);ctx.fillStyle='#000';
    for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(qr.isDark(row,col))ctx.fillRect((col+4)*cell,(row+4)*cell,cell,cell);
  }
  $('allocate-save-qr').addEventListener('click',()=>{
    if(!adminKey || !$('allocate-link').value)return;
    const link=document.createElement('a');link.download='vaultlix-private-number-qr.png';link.href=$('allocate-qr').toDataURL('image/png');link.click();
  });
  $('allocate-number-form').addEventListener('submit',async event=>{
    event.preventDefault(); const key=adminKey;if(!key)return;
    $('allocate-submit').disabled=true;
    $('allocate-result').hidden=true;$('allocate-link').value='';clearClaimQr();
    $('allocate-status').textContent='Reserving number…';
    try {
      const response=await fetch('/api/admin/allocate-number',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({privateNumber:$('allocate-number').value.trim()}),cache:'no-store'});
      const result=await response.json();if(adminKey!==key)return;
      if(!response.ok)throw Error(result.error || 'Could not reserve number.');
      $('allocate-status').textContent=`${result.privateNumber} reserved until ${new Date(result.reservedUntil).toLocaleString()}.`;
      $('allocate-link').value=result.claimUrl;$('allocate-result').hidden=false;
      try{renderClaimQr(result.claimUrl);}catch(_){clearClaimQr();$('allocate-status').textContent+=' QR unavailable; copy the claim link below.';}
    }catch(error){if(adminKey===key)$('allocate-status').textContent=error.message || 'Reservation could not be confirmed. Do not assume it failed; retrying may report it reserved.';}
    finally{$('allocate-submit').disabled=false;}
  });
  $('allocate-copy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText($('allocate-link').value);$('allocate-status').textContent='Claim link copied. Share it privately.';}
    catch(_){$('allocate-link').focus();$('allocate-link').select();$('allocate-status').textContent='Copy the selected claim link.';}
  });
  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    adminKey = $('admin-key').value;
    $('admin-key').value = '';
    loadStats(true);
  });
  $('refresh').addEventListener('click', () => { loadStats(false); loadHealth(); });
  function signOut() {
    adminKey = '';
    clearClaimQr();$('allocate-link').value='';$('allocate-result').hidden=true;$('allocate-status').textContent='';
    clearInterval(healthTimer); healthTimer=null;
    $('service-health-cards').replaceChildren();
    $('service-health-history').replaceChildren();
    $('safety-reports').replaceChildren();
    $('safety-summary').textContent='Signed out';
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
