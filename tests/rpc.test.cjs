const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { RpcProcess } = require('../src/codex.cjs');
const fixture = () => new RpcProcess(process.execPath, [path.join(__dirname, 'rpc-fixture.cjs')]);
test('handles fragmented JSON and notifications independently', async t => {
  const rpc = fixture(); t.after(() => rpc.close());
  const event = once(rpc, 'notification');
  assert.deepEqual(await rpc.request('echo', { text: 'Bonjour, 世界' }), { text: 'Bonjour, 世界' });
  assert.equal((await event)[0].method, 'progress');
});
test('server failure is surfaced without hanging', async t => {
  const rpc = fixture(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('fail'), /Deliberate failure/);
  assert.equal(rpc.pending.size, 0);
});
test('request deadline rejects and clears pending state', async t => {
  const rpc = fixture(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('hang', {}, 40), /timed out/);
  assert.equal(rpc.pending.size, 0);
});
test('child exit rejects all pending requests', async t => {
  const rpc = fixture(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('exit'), /stopped/);
  await assert.rejects(rpc.request('echo'), /disconnected/);
});
