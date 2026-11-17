// core/process.js — graceful shutdown and fatal-error logging (DAT-2 drain). Pure: fake exit.
import './_setup.js';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

let proc;
const listeners = {};
before(async () => {
  for (const ev of ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException']) listeners[ev] = process.listeners(ev);
  proc = await import(src('core/process.js'));
});
after(() => {
  // Remove what the tests installed; keep the runner's own handlers.
  for (const ev of Object.keys(listeners)) {
    for (const l of process.listeners(ev)) if (!listeners[ev].includes(l)) process.off(ev, l);
  }
});

describe('installProcessHandlers', () => {
  test('a signal drains once, then exits 0; a second signal exits 1 at once', async () => {
    const exits = [];
    let drains = 0;
    let release;
    const { shutdown } = proc.installProcessHandlers({
      name: 't', exit: (c) => exits.push(c),
      drain: () => { drains++; return new Promise((r) => { release = r; }); },
    });
    const first = shutdown('SIGTERM');
    await shutdown('SIGTERM');
    assert.deepEqual(exits, [1], 'second signal while draining');
    release();
    await first;
    assert.equal(drains, 1);
    assert.deepEqual(exits, [1, 0]);
  });

  test('a failing drain exits 1', async () => {
    const exits = [];
    const { shutdown } = proc.installProcessHandlers({ name: 't2', exit: (c) => exits.push(c), drain: async () => { throw new Error('pool'); } });
    await shutdown('SIGINT');
    assert.deepEqual(exits, [1]);
  });
});
