const { CodexClient } = require('../src/codex.cjs');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../.build/smoke-workspace'); fs.mkdirSync(directory, { recursive: true });
const client = new CodexClient(directory);
const timer = setTimeout(() => { client.disconnect(); console.error('Smoke test timed out'); process.exit(1); }, 120000);
async function turn(text, image) {
  let response = ''; client.on('delta', append);
  function append(value) { response += value; }
  const completion = once(client, 'completed');
  try { await client.ask({ text, image, threadId: client.thread, model: model, effort: 'low' }); const [result] = await completion; assert.equal(result.status, 'completed'); console.log(JSON.stringify({ response, status: result.status })); return response; }
  finally { client.off('delta', append); }
}
let model;
(async () => {
  const result = await client.connect(); model = result.models.find(m => m.isDefault).model;
  console.log(JSON.stringify({ connection: 'ok', model }));
  const first = await turn('Read the two-digit number in this image. Reply only with that number.', path.resolve(__dirname, '../.build/test-screen.png'));
  assert.equal(first.trim(), '42');
  assert.equal((await turn('Add eight to that number. Reply with only the resulting number.')).trim(), '50');
  const completed = once(client, 'completed');
  await client.ask({ text: 'Write a very detailed 3000-word overview of sorting algorithms.', threadId: client.thread, model, effort: 'low' });
  await client.interrupt();
  const terminal = (await completed)[0].status;
  assert.ok(['interrupted', 'completed'].includes(terminal));
  assert.equal(client.busy, false);
  console.log(`PASS: image input, streamed answer, conversation continuity, stop race (${terminal})`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { clearTimeout(timer); client.disconnect(); });
