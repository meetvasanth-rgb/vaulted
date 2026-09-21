'use strict';

function guardedSocketTask(ws, label, handler) {
  return (...args) => {
    Promise.resolve().then(() => handler(...args)).catch(error => {
      console.error(`${label}:`, error.message);
      try { ws.close(1011, 'Temporary server error'); } catch (_) {}
    });
  };
}

module.exports = { guardedSocketTask };
