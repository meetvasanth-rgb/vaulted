const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('iOS native mute requests use native audio and wait for acknowledgement',()=>{
  const html=fs.readFileSync('client/index.html','utf8');
  const source=html.slice(html.indexOf('function toggleMute()'),html.indexOf('// Creates/reuses the local self-view'));
  const messages=[];let rendered=0;
  const room={code:'test-room',nativeCallActive:true,callMuted:false};
  const context={rooms:new Map([['test-room',room]]),activeCallRoomCode:'test-room',window:{webkit:{messageHandlers:{vaultlixCall:{postMessage:m=>messages.push(m)}}}},renderCallOverlay:()=>rendered++,toast(){}};
  vm.runInNewContext(source,context);context.toggleMute();
  assert.equal(messages[0].action,'setMuted');assert.equal(messages[0].muted,true);assert.equal(messages[0].code,'test-room');assert.equal(room.callMuted,false);assert.equal(rendered,0);
  room.callMuted=true;context.toggleMute();assert.equal(messages[1].muted,false);
  room.nativeCallActive=false;const track={enabled:true};room.localStream={getAudioTracks:()=>[track]};room.callMuted=false;context.toggleMute();assert.equal(track.enabled,false);assert.equal(rendered,1);
});
