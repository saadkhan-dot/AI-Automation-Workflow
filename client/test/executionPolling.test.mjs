import test from 'node:test';
import assert from 'node:assert/strict';
import { startExecutionPolling } from '../src/executionPolling.mjs';

function fakeTimers() {
  const pending = [];
  return {
    pending,
    schedule: callback => { pending.push(callback); return callback; },
    cancel: callback => { const index = pending.indexOf(callback); if (index >= 0) pending.splice(index, 1); },
    async tick() { const callback = pending.shift(); assert.ok(callback, 'expected a scheduled poll'); callback(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('polls queued and running executions until succeeded, then stops', async () => {
  const timers = fakeTimers();
  const states = ['queued', 'running', 'succeeded'];
  const received = [];
  const stop = startExecutionPolling({
    executionId: 'exec-1',
    fetchStatus: async id => { assert.equal(id, 'exec-1'); return { _id: id, status: states.shift() }; },
    onUpdate: execution => received.push(execution.status),
    onError: assert.fail,
    schedule: timers.schedule,
    cancel: timers.cancel,
    intervalMs: 1000,
  });
  await new Promise(resolve => setImmediate(resolve));
  await timers.tick();
  await timers.tick();
  assert.deepEqual(received, ['queued', 'running', 'succeeded']);
  assert.equal(timers.pending.length, 0);
  stop();
});

test('polling retries transient errors and stops on failed terminal status', async () => {
  const timers = fakeTimers();
  const errors = [];
  const updates = [];
  let calls = 0;
  const stop = startExecutionPolling({
    executionId: 'exec-2',
    fetchStatus: async () => { calls += 1; if (calls === 1) throw new Error('network down'); return { _id: 'exec-2', status: 'failed' }; },
    onUpdate: execution => updates.push(execution.status),
    onError: error => errors.push(error.message),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  await new Promise(resolve => setImmediate(resolve));
  await timers.tick();
  assert.deepEqual(errors, ['network down']);
  assert.deepEqual(updates, ['failed']);
  assert.equal(timers.pending.length, 0);
  stop();
});

test('stopping polling before a request resolves suppresses callbacks', async () => {
  let resolveRequest;
  let updated = false;
  const stop = startExecutionPolling({
    executionId: 'exec-3',
    fetchStatus: () => new Promise(resolve => { resolveRequest = resolve; }),
    onUpdate: () => { updated = true; },
    onError: assert.fail,
  });
  stop();
  resolveRequest({ _id: 'exec-3', status: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updated, false);
});
