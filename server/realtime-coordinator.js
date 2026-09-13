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
    if (!this.ready) return false;
    const routeId = opaqueRouteId(token);
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

  async close() {
    this.ready = false;
    await Promise.allSettled([
      this.subscriber?.quit(),
      this.publisher?.quit(),
    ]);
  }
}

module.exports = { RealtimeCoordinator, opaqueRouteId, SOCKET_LEASE_SECONDS };
