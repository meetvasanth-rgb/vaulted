'use strict';

// Read-only probes, shared across admin tabs. Never return upstream error bodies
// or connection details: both can contain credentials or customer metadata.
function createHealthMonitor({ checks, now = Date.now, ttl = 30000, timeout = 4000 }) {
  let cached, inFlight;
  const history = [];
  async function probe(check) {
    const start = now();
    let timer;
    const controller = new AbortController();
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check.run(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('timeout')); }, timeout); }),
      ]);
      return { id:check.id, name:check.name, ...result, checkedAt:new Date(now()).toISOString(), latencyMs:Math.max(0, now()-start) };
    } catch (_) {
      return { id:check.id, name:check.name, status:check.external ? 'unknown' : 'down', detail:check.external ? 'Provider status unavailable; your service may still be working.' : 'Check failed or timed out. Inspect service logs.', checkedAt:new Date(now()).toISOString(), latencyMs:Math.max(0, now()-start) };
    } finally { clearTimeout(timer); }
  }
  return async function getHealth() {
    if (cached && now()-cached.at < ttl) return cached.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const services = await Promise.all(checks.map(probe));
      for (const service of services) {
        const previous = cached?.value.services.find(item=>item.id===service.id);
        if (previous && previous.status !== service.status) history.unshift({ name:service.name, from:previous.status, to:service.status, at:service.checkedAt });
      }
      history.splice(40);
      const status = services.some(s=>s.status==='down') ? 'down' : services.some(s=>['warning','unknown'].includes(s.status)) ? 'warning' : 'healthy';
      const value = { status, checkedAt:new Date(now()).toISOString(), refreshSeconds:30, services, history:[...history] };
      cached={at:now(),value};
      return value;
    })();
    try { return await inFlight; } finally { inFlight=null; }
  };
}
module.exports = { createHealthMonitor };
