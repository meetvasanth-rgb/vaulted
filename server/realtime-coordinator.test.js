const test = require('node:test');
const assert = require('node:assert/strict');
const { RealtimeCoordinator, opaqueRouteId } = require('./realtime-coordinator');

test('route identifiers are deterministic hashes, not reusable bearer tokens', () => {
  const token = 'member-secret-token';
  const route = opaqueRouteId(token);
  assert.equal(route, opaqueRouteId(token));
  assert.notEqual(route, token);
  assert.doesNotMatch(route, /member-secret-token/);
});

test('events from this instance and events for another instance are ignored', () => {
  const received = [];
  const coordinator = new RealtimeCoordinator({ url:'redis://test', instanceId:'instance-a' });
  coordinator.onEvent = event => received.push(event);
  coordinator.handle(JSON.stringify({ origin:'instance-a', type:'signal' }));
  coordinator.handle(JSON.stringify({ origin:'instance-b', targetInstance:'instance-c', type:'signal' }));
  coordinator.handle(JSON.stringify({ origin:'instance-b', targetInstance:'instance-a', type:'signal' }));
  assert.equal(received.length, 1);
});

test('signal routing prefers the native owner and publishes only an opaque route', async () => {
  const published = [];
  const coordinator = new RealtimeCoordinator({ url:'redis://test', instanceId:'sender' });
  coordinator.ready = true;
  coordinator.publisher = {
    mGet: async () => ['native-instance', 'web-instance'],
    publish: async (channel, raw) => { published.push({ channel, event:JSON.parse(raw) }); return 1; },
  };
  const token = 'do-not-publish-this-token';
  assert.equal(await coordinator.routeSignal(token, { type:'offer', envelope:'ciphertext' }), true);
  assert.equal(published[0].event.targetInstance, 'native-instance');
  assert.equal(published[0].event.routeId, opaqueRouteId(token));
  assert.doesNotMatch(JSON.stringify(published[0]), /do-not-publish-this-token/);
});

test('terminal controls are routed to every distinct native and web owner', async () => {
  const targets = [];
  const coordinator = new RealtimeCoordinator({ url:'redis://test', instanceId:'sender' });
  coordinator.ready = true;
  coordinator.publisher = {
    mGet: async () => ['native-instance', 'web-instance'],
    publish: async (channel, raw) => { targets.push(JSON.parse(raw).targetInstance); return 1; },
  };
  assert.equal(await coordinator.routeSignal('member', { type:'call-terminal' }, { allOwners:true }), true);
  assert.deepEqual(targets.sort(), ['native-instance', 'web-instance']);
});

test('without Redis configured the coordinator is a no-op', async () => {
  const coordinator = new RealtimeCoordinator();
  assert.equal(coordinator.enabled, false);
  assert.equal(await coordinator.start(() => {}), false);
  assert.equal(await coordinator.publish('signal', {}), false);
});
