const crypto = require('crypto');

const DEFAULT_NAMESPACE = 'vaultlix:realtime:v1';
const SOCKET_LEASE_SECONDS = 60;

function opaqueRouteId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

class RealtimeCoordinator {
  constructor(options = {}) {
    this.url = options.url || '';
    this.namespace = options.namespace || DEFAULT_NAMESPACE;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.createClient = options.createClient || null;
    this.publisher = null;
    this.subscriber = null;
    this.ready = false;
    this.onEvent = null;
  }

  get enabled() { return Boolean(this.url); }

  channel() { return `${this.namespace}:events`; }
  socketKey(routeId, kind) { return `${this.namespace}:socket:${routeId}:${kind}`; }
  presenceKey(roomCode, token) {
    return `${this.namespace}:presence:${opaqueRouteId(roomCode)}:${opaqueRouteId(token)}`;
  }
  presenceKeyByRoute(roomCode, routeId) {
    return `${this.namespace}:presence:${opaqueRouteId(roomCode)}:${routeId}`;
  }
  rateKey(key) { return `${this.namespace}:rate:${opaqueRouteId(key)}`; }
  inboxSequenceKey(accountId) { return `${this.namespace}:inbox-seq:${opaqueRouteId(accountId)}`; }
  callKey(roomCode) { return `${this.namespace}:call:${opaqueRouteId(roomCode)}`; }
  callIndexKey(callId) { return `${this.namespace}:call-id:${callId}`; }
  lockKey(resource) { return `${this.namespace}:lock:${opaqueRouteId(resource)}`; }

  async start(onEvent) {
    this.onEvent = onEvent;
    if (!this.enabled) return false;
    const createClient = this.createClient || require('redis').createClient;
    this.publisher = createClient({ url:this.url, socket:{ reconnectStrategy:retries => Math.min(1000 * (retries + 1), 10000) } });
    this.subscriber = this.publisher.duplicate();
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', error => console.error('Redis realtime error:', error.message));
    }
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(this.channel(), raw => this.handle(raw));
    this.ready = true;
    return true;
  }

  handle(raw) {
    let event;
    try { event = JSON.parse(raw); } catch (error) { return; }
    if (!event || event.origin === this.instanceId || typeof event.type !== 'string') return;
    if (event.targetInstance && event.targetInstance !== this.instanceId) return;
    try { this.onEvent?.(event); } catch (error) { console.error('Redis realtime event failed:', error.message); }
  }

  async publish(type, data = {}, targetInstance = null) {
    if (!this.ready) return false;
    try {
      await this.publisher.publish(this.channel(), JSON.stringify({
        v:1, origin:this.instanceId, targetInstance, type, ...data,
      }));
      return true;
    } catch (error) {
      console.error('Redis realtime publish failed:', error.message);
      return false;
    }
  }

  async registerSocket(token, kind) {
    if (!this.ready) return false;
    const routeId = opaqueRouteId(token);
    try {
      await this.publisher.set(this.socketKey(routeId, kind), this.instanceId, { EX:SOCKET_LEASE_SECONDS });
      return true;
    } catch (error) { return false; }
  }

  async unregisterSocket(token, kind) {
    if (!this.ready) return false;
    const key = this.socketKey(opaqueRouteId(token), kind);
    try {
      await this.publisher.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys:[key], arguments:[this.instanceId] },
      );
      return true;
    } catch (error) { return false; }
  }

  async routeSignal(token, signal, { allOwners = false } = {}) {
    return this.routeSignalByRoute(opaqueRouteId(token), signal, { allOwners });
  }

  async routeSignalByRoute(routeId, signal, { allOwners = false } = {}) {
    if (!this.ready) return false;
    try {
      const [nativeOwner, webOwner] = await this.publisher.mGet([
        this.socketKey(routeId, 'native'), this.socketKey(routeId, 'web'),
      ]);
      const owners = allOwners ? [...new Set([nativeOwner, webOwner].filter(Boolean))] : [nativeOwner || webOwner].filter(Boolean);
      const remoteOwners = owners.filter(owner => owner !== this.instanceId);
      if (remoteOwners.length === 0) return false;
      const results = await Promise.all(remoteOwners.map(targetInstance =>
        this.publish('signal', { routeId, signal, allOwners }, targetInstance)));
      return results.some(Boolean);
    } catch (error) {
      console.error('Redis signal routing failed:', error.message);
      return false;
    }
  }

  async markPresence(roomCode, token, connectionId) {
    if (!this.ready) return false;
    const key = this.presenceKey(roomCode, token);
    const now = Date.now();
    try {
      await this.publisher.multi()
        .zRemRangeByScore(key, 0, now)
        .zAdd(key, { score:now + SOCKET_LEASE_SECONDS * 1000, value:`${this.instanceId}:${connectionId}` })
        .expire(key, SOCKET_LEASE_SECONDS * 2)
        .exec();
      return true;
    } catch (error) { return false; }
  }

  async rateLimited(key, maxCount, windowMs) {
    if (!this.ready) return null;
    try {
      const count = await this.publisher.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
        { keys:[this.rateKey(key)], arguments:[String(windowMs)] },
      );
      return Number(count) > maxCount;
    } catch (error) { return null; }
  }

  async isRateLimited(key, maxCount) {
    if (!this.ready) return null;
    try { return Number(await this.publisher.get(this.rateKey(key)) || 0) >= maxCount; }
    catch (error) { return null; }
  }

  async progressiveRateLimit(key, now, windowMs, freeAttempts) {
    if (!this.ready) return null;
    try {
      const retryMs = await this.publisher.eval(
        "local start=tonumber(redis.call('HGET',KEYS[1],'start') or '0'); local blocked=tonumber(redis.call('HGET',KEYS[1],'blocked') or '0'); local count=tonumber(redis.call('HGET',KEYS[1],'count') or '0'); local now=tonumber(ARGV[1]); local window=tonumber(ARGV[2]); if start==0 or now-start>=window then start=now; blocked=0; count=0 end; if blocked>now then return blocked-now end; count=count+1; if count>tonumber(ARGV[3]) then local exponent=math.min(count-tonumber(ARGV[3])-1,12); local delay=math.min(3600000,(2^exponent)*1000); blocked=now+delay end; redis.call('HSET',KEYS[1],'start',start,'count',count,'blocked',blocked); redis.call('PEXPIRE',KEYS[1],window); return math.max(0,blocked-now)",
        { keys:[this.rateKey(key)], arguments:[String(now), String(windowMs), String(freeAttempts)] },
      );
      return Math.ceil(Number(retryMs || 0) / 1000);
    } catch (error) { return null; }
  }

  async nextInboxSequence(accountId) {
    if (!this.ready) return null;
    try { return Number(await this.publisher.incr(this.inboxSequenceKey(accountId))); }
    catch (error) { return null; }
  }

  async currentInboxSequence(accountId) {
    if (!this.ready) return null;
    try { return Number(await this.publisher.get(this.inboxSequenceKey(accountId)) || 0); }
    catch (error) { return null; }
  }

  async setCallState(roomCode, state, ttlSeconds = 120) {
    if (!this.ready) return false;
    return this.withLock(`call:${roomCode}`, 5000, async () => {
      const key = this.callKey(roomCode);
      const previous = await this.publisher.get(key);
      if (previous) {
        try {
          const parsed = JSON.parse(previous);
          if (parsed.callId && parsed.callId !== state.callId) await this.publisher.del(this.callIndexKey(parsed.callId));
        } catch (error) {}
      }
      await this.publisher.multi()
        .set(key, JSON.stringify(state), { EX:ttlSeconds })
        .set(this.callIndexKey(state.callId), roomCode, { EX:ttlSeconds })
        .exec();
      return true;
    }).catch(() => false);
  }

  async withLock(resource, ttlMs, operation) {
    if (!this.ready) return operation();
    const key = this.lockKey(resource);
    const owner = `${this.instanceId}:${crypto.randomUUID()}`;
    let acquired = false;
    for (let attempt = 0; attempt < 8 && !acquired; attempt++) {
      acquired = (await this.publisher.set(key, owner, { NX:true, PX:ttlMs })) === 'OK';
      if (!acquired) await new Promise(resolve => setTimeout(resolve, 15 + attempt * 10));
    }
    if (!acquired) throw new Error('Redis coordination lock unavailable');
    try { return await operation(); }
    finally {
      await this.publisher.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
        { keys:[key], arguments:[owner] },
      ).catch(() => {});
    }
  }

  async getCallState(roomCode) {
    if (!this.ready) return null;
    try { const raw = await this.publisher.get(this.callKey(roomCode)); return raw ? JSON.parse(raw) : null; }
    catch (error) { return null; }
  }

  async getCallStateById(callId) {
    if (!this.ready) return null;
    try {
      const roomCode = await this.publisher.get(this.callIndexKey(callId));
      if (!roomCode) return null;
      const state = await this.getCallState(roomCode);
      return state ? { roomCode, ...state } : null;
    } catch (error) { return null; }
  }

  async clearCallState(roomCode, callId = null) {
    if (!this.ready) return false;
    try {
      const state = callId ? { callId } : await this.getCallState(roomCode);
      const keys = [this.callKey(roomCode)];
      if (state?.callId) keys.push(this.callIndexKey(state.callId));
      await this.publisher.del(keys);
      return true;
    } catch (error) { return false; }
  }

  async clearPresence(roomCode, token, connectionId) {
    if (!this.ready) return null;
    const key = this.presenceKey(roomCode, token);
    try {
      const result = await this.publisher.multi()
        .zRem(key, `${this.instanceId}:${connectionId}`)
        .zRemRangeByScore(key, 0, Date.now())
        .zCard(key)
        .exec();
      return Number(result?.[2]) > 0;
    } catch (error) { return null; }
  }

  async isPresentByRoute(roomCode, routeId) {
    if (!this.ready) return null;
    const key = this.presenceKeyByRoute(roomCode, routeId);
    try {
      const result = await this.publisher.multi()
        .zRemRangeByScore(key, 0, Date.now())
        .zCard(key)
        .exec();
      return Number(result?.[1]) > 0;
    } catch (error) { return null; }
  }

  async close() {
    this.ready = false;
    await Promise.allSettled([
      this.subscriber?.quit(),
      this.publisher?.quit(),
    ]);
  }
}

module.exports = { RealtimeCoordinator, opaqueRouteId, SOCKET_LEASE_SECONDS };
