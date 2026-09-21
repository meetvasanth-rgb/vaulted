'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardedSocketTask } = require('./socket-task');

test('a failed asynchronous socket check closes only that socket', async () => {
  const closed=[];
  const ws={close(...args){closed.push(args);}};
  const originalError=console.error;
  const logged=[];
  console.error=(...args)=>logged.push(args);
  try {
    guardedSocketTask(ws,'Signal socket authentication failed',async()=>{
      throw Error('Synthetic database timeout');
    })();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(closed,[[1011,'Temporary server error']]);
    assert.match(logged[0].join(' '),/Synthetic database timeout/);
  } finally {console.error=originalError;}
});
